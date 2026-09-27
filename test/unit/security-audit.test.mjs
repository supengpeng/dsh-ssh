/**
 * Audit log and structured logger.
 *
 * The two hard requirements from the brief, and how each is checked:
 *
 *   - "a full disk must never fail an SSH operation" — every write path is driven
 *     with an unwritable target and asserted not to throw, to still answer queries
 *     from memory, and to report the failure only through a warning;
 *   - "always redacted" — the file, the query result *and* the live subscriber
 *     payload are each asserted to be free of the secret, because the subscriber
 *     feeds the UI's `followAudit` stream and is the easiest path to leak through.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { createAuditor } from '../../lib/audit.js'
import { JsonlWriter, createLogger, defaultLogFile, shouldLog } from '../../lib/logger.js'
import { SECRET_MASK, createRedactor } from '../../lib/redact.js'

const PASSWORD = 'hunter2!'
const root = mkdtempSync(join(tmpdir(), 'dsh-ssh-sec-audit-'))
after(() => rmSync(root, { recursive: true, force: true }))

let counter = 0
function tempPath(name = 'audit.jsonl') {
  counter += 1
  const dir = join(root, `case-${counter}`)
  mkdirSync(dir, { recursive: true })
  return join(dir, name)
}

function readLines(file) {
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '')
}

// ---------------------------------------------------------------------------
// Audit: recording and querying
// ---------------------------------------------------------------------------

test('records are appended as JSONL and queryable newest-first', async () => {
  const file = tempPath()
  const auditor = createAuditor({ file, redactor: createRedactor() })
  auditor.record({ op: 'connect', outcome: 'ok', profileId: 'p_1', target: { host: 'h', port: 22, user: 'root' }, durationMs: 12 })
  auditor.record({ op: 'exec', outcome: 'ok', sessionId: 's_1', detail: { command: 'uname -a' } })
  auditor.record({ op: 'disconnect', outcome: 'ok', sessionId: 's_1' })

  const lines = readLines(file)
  assert.equal(lines.length, 3)
  const first = JSON.parse(lines[0])
  assert.equal(first.op, 'connect')
  assert.match(first.at, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(first.target.user, 'root')

  const result = await auditor.query({})
  assert.equal(result.total, 3)
  assert.deepEqual(result.entries.map((entry) => entry.op), ['disconnect', 'exec', 'connect'])
  assert.equal(auditor.size, 3)
})

test('query filters by sessionId, op kinds, since, and paginates', async () => {
  const file = tempPath()
  const auditor = createAuditor({ file, redactor: createRedactor() })
  auditor.record({ op: 'connect', outcome: 'ok', sessionId: 's_a' })
  auditor.record({ op: 'exec', outcome: 'ok', sessionId: 's_a' })
  auditor.record({ op: 'upload', outcome: 'error', sessionId: 's_b' })
  auditor.record({ op: 'exec', outcome: 'ok', sessionId: 's_b' })

  assert.equal((await auditor.query({ sessionId: 's_b' })).total, 2)
  assert.equal((await auditor.query({ kinds: ['exec'] })).total, 2)
  assert.equal((await auditor.query({ kinds: ['exec', 'connect'] })).total, 3)
  assert.equal((await auditor.query({ kinds: [] })).total, 4, 'an empty kinds list is not a filter')
  assert.equal((await auditor.query({ limit: 2 })).entries.length, 2)
  assert.equal((await auditor.query({ limit: 2, offset: 3 })).entries.length, 1)
  assert.equal((await auditor.query({ limit: 10, offset: 10 })).total, 4, 'total counts matches, not the page')

  const future = new Date(Date.now() + 60000).toISOString()
  assert.equal((await auditor.query({ since: future })).total, 0)
  const past = new Date(Date.now() - 60000).toISOString()
  assert.equal((await auditor.query({ since: past })).total, 4)
})

test('every audit entry is redacted before it is observable anywhere', async () => {
  const file = tempPath()
  const redactor = createRedactor()
  redactor.track(PASSWORD)
  const auditor = createAuditor({ file, redactor })
  const seen = []
  auditor.subscribe((entry) => seen.push(JSON.stringify(entry)))

  auditor.record({
    op: 'connect',
    outcome: 'error',
    sessionId: 's_1',
    detail: { password: PASSWORD, url: `ssh://root:${PASSWORD}@h:22`, note: `failed with ${PASSWORD}` },
  })

  assert.equal(seen.length, 1)
  assert.equal(seen[0].includes(PASSWORD), false, 'the subscriber payload is redacted')
  const onDisk = readFileSync(file, 'utf8')
  assert.equal(onDisk.includes(PASSWORD), false, 'the file is redacted')
  const queried = await auditor.query({})
  assert.equal(JSON.stringify(queried).includes(PASSWORD), false, 'the query result is redacted')
  assert.equal(queried.entries[0].detail.password, SECRET_MASK)
})

test('subscribers can unsubscribe, and a throwing subscriber cannot break the operation', async () => {
  const file = tempPath()
  const warnings = []
  const auditor = createAuditor({ file, redactor: createRedactor(), logger: { warn: (message, fields) => warnings.push([message, fields]) } })
  const received = []
  const unsubscribe = auditor.subscribe((entry) => received.push(entry.op))
  auditor.subscribe(() => {
    throw new Error('broken consumer')
  })
  auditor.record({ op: 'connect', outcome: 'ok' })
  assert.deepEqual(received, ['connect'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0][0], /subscriber/)
  unsubscribe()
  auditor.record({ op: 'exec', outcome: 'ok' })
  assert.deepEqual(received, ['connect'], 'the unsubscribed listener is not called')
})

test('a failed write degrades to the ring and is retried by flush', async () => {
  // A directory where the file should be: every append fails.
  const blocked = join(root, 'blocked.jsonl')
  mkdirSync(blocked, { recursive: true })
  const warnings = []
  const auditor = createAuditor({ file: blocked, redactor: createRedactor(), logger: { warn: (message) => warnings.push(message) } })

  assert.doesNotThrow(() => auditor.record({ op: 'connect', outcome: 'ok', sessionId: 's_1' }))
  assert.doesNotThrow(() => auditor.record({ op: 'exec', outcome: 'ok', sessionId: 's_1' }))
  assert.equal(auditor.pending, 2, 'the records are held for a retry')
  const result = await auditor.query({})
  assert.equal(result.total, 2, 'the audit is still useful without a writable disk')
  await auditor.flush()
  assert.equal(auditor.pending, 2, 'still failing, still not throwing')
})

test('clear empties the ring and removes the file', async () => {
  const file = tempPath()
  const auditor = createAuditor({ file, redactor: createRedactor() })
  auditor.record({ op: 'connect', outcome: 'ok' })
  auditor.record({ op: 'exec', outcome: 'ok' })
  assert.equal(await auditor.clear(), 2)
  assert.equal(auditor.size, 0)
  assert.equal((await auditor.query({})).total, 0)
  assert.throws(() => statSync(file), 'the file is gone')
})

test('the memory ring is bounded and reports what it dropped', () => {
  const file = tempPath()
  const auditor = createAuditor({ file, redactor: createRedactor(), maxMemoryEntries: 3 })
  for (let index = 0; index < 5; index += 1) auditor.record({ op: `op${index}`, outcome: 'ok' })
  assert.equal(auditor.size, 3)
  assert.equal(auditor.dropped, 2)
  assert.equal(readLines(file).length, 5, 'the file keeps the full history')
})

test('a fresh auditor hydrates from the tail of an existing file', async () => {
  const file = tempPath()
  const first = createAuditor({ file, redactor: createRedactor() })
  first.record({ op: 'connect', outcome: 'ok', sessionId: 's_1', detail: { host: 'h' } })
  first.record({ op: 'exec', outcome: 'ok', sessionId: 's_1' })

  const reopened = createAuditor({ file, redactor: createRedactor() })
  const result = await reopened.query({})
  assert.equal(result.total, 2, 'the audit tab survives a plugin reload')
  assert.deepEqual(result.entries.map((entry) => entry.op), ['exec', 'connect'])
  assert.equal(result.entries[1].detail.host, 'h')
})

test('a partially written line does not break hydration', async () => {
  const file = tempPath()
  const first = createAuditor({ file, redactor: createRedactor() })
  first.record({ op: 'connect', outcome: 'ok' })
  const raw = readFileSync(file, 'utf8')
  writeFileSync(file, `${raw}{"at":"2026-01-01T00:00:00.000Z","op":"tru`, 'utf8')
  const reopened = createAuditor({ file, redactor: createRedactor() })
  const result = await reopened.query({})
  assert.equal(result.total, 1)
  assert.equal(result.entries[0].op, 'connect')
})

test('a record that cannot be redacted is replaced by a value-free entry', () => {
  const file = tempPath()
  const hostile = {
    scrub() {
      throw new Error('no')
    },
    track() {},
    forgetAll() {},
  }
  const auditor = createAuditor({ file, redactor: hostile })
  assert.doesNotThrow(() => auditor.record({ op: 'connect', outcome: 'ok', detail: { password: PASSWORD } }))
  assert.equal(readFileSync(file, 'utf8').includes(PASSWORD), false)
})

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

function resolvedConfig(overrides = {}) {
  return {
    logging: { level: 'info', redact: true, redactKeys: ['password', 'passphrase', 'privateKey', 'secret', 'token', 'key', 'authorization'] },
    auditFile: join(root, 'logs', 'dsh-ssh', 'audit.jsonl'),
    dshHome: root,
    ...overrides,
  }
}

test('log records are JSONL, level-filtered and redacted', () => {
  const file = tempPath('plugin.jsonl')
  const logger = createLogger({ config: resolvedConfig(), file, scope: 'ssh.test' })
  logger.debug('not written at info level')
  logger.info('connecting', { host: 'h', password: PASSWORD, nested: { token: 't' } })
  logger.error('failed', { reason: `auth rejected: password=${PASSWORD}` })

  const lines = readLines(file)
  assert.equal(lines.length, 2)
  const first = JSON.parse(lines[0])
  assert.equal(first.level, 'info')
  assert.equal(first.scope, 'ssh.test')
  assert.equal(first.msg, 'connecting')
  assert.equal(first.host, 'h')
  assert.equal(first.password, SECRET_MASK)
  assert.equal(first.nested.token, SECRET_MASK)
  const second = JSON.parse(lines[1])
  assert.equal(second.level, 'error')
  assert.equal(JSON.stringify(second).includes(PASSWORD), false, 'a password=… shape is masked even when nothing tracked the value')
  assert.match(second.reason, /password=•{8}/)
})

test('tracked secrets never reach the log file', () => {
  const file = tempPath('tracked.jsonl')
  const redactor = createRedactor()
  const logger = createLogger({ config: resolvedConfig(), file, redactor })
  redactor.track(PASSWORD)
  logger.warn(`login failed for ${PASSWORD}`)
  logger.warn('url refused', { url: `ssh://root:${PASSWORD}@h:22` })
  assert.equal(readFileSync(file, 'utf8').includes(PASSWORD), false)
})

test('logging.redact: false turns redaction off (operator opt-out)', () => {
  const file = tempPath('raw.jsonl')
  const config = resolvedConfig({ logging: { level: 'debug', redact: false, redactKeys: [] } })
  const logger = createLogger({ config, file })
  logger.debug('value', { password: 'visible-by-request' })
  assert.equal(readFileSync(file, 'utf8').includes('visible-by-request'), true)
})

test('the level threshold filters by severity', () => {
  const file = tempPath('level.jsonl')
  const logger = createLogger({ config: resolvedConfig({ logging: { level: 'warn', redact: true, redactKeys: [] } }), file })
  logger.debug('d')
  logger.info('i')
  logger.warn('w')
  logger.error('e')
  assert.deepEqual(readLines(file).map((line) => JSON.parse(line).level), ['warn', 'error'])
  assert.equal(logger.enabled('debug'), false)
  assert.equal(logger.enabled('error'), true)
  assert.ok(shouldLog('error', 'info'))
  assert.ok(!shouldLog('info', 'error'))
})

test('child scopes nest and share level, redactor and file', () => {
  const file = tempPath('child.jsonl')
  const logger = createLogger({ config: resolvedConfig(), file, scope: 'ssh' })
  logger.child('connection').info('opened')
  logger.child('connection').child('auth').info('authenticated')
  const lines = readLines(file).map((line) => JSON.parse(line))
  assert.deepEqual(lines.map((line) => line.scope), ['ssh.connection', 'ssh.connection.auth'])
})

test('the host logger receives compact lines and never a secret', () => {
  const file = tempPath('host.jsonl')
  const forwarded = []
  const host = { debug: (m) => forwarded.push(m), info: (m) => forwarded.push(m), warn: (m) => forwarded.push(m), error: (m) => forwarded.push(m) }
  const logger = createLogger({ config: resolvedConfig(), file, host })
  logger.info('connecting', { host: 'h', password: PASSWORD })
  assert.equal(forwarded.length, 1)
  assert.match(forwarded[0], /^\[ssh\] connecting /)
  assert.equal(forwarded[0].includes(PASSWORD), false)
  assert.equal(forwarded[0].includes(SECRET_MASK), true)
  const service = logger.toServiceLogger()
  service.warn('via service face')
  assert.equal(forwarded.length, 2)
  assert.equal(JSON.parse(readLines(file)[1]).msg, 'via service face')
})

test('a host logger that throws cannot break a log call', () => {
  const file = tempPath('throwing-host.jsonl')
  const host = {
    debug() {
      throw new Error('host logger down')
    },
    info() {
      throw new Error('host logger down')
    },
    warn() {
      throw new Error('host logger down')
    },
    error() {
      throw new Error('host logger down')
    },
  }
  const logger = createLogger({ config: resolvedConfig(), file, host })
  assert.doesNotThrow(() => logger.info('still fine'))
  assert.equal(readLines(file).length, 1)
})

test('an unwritable log file does not throw and flush still resolves', async () => {
  const blocked = join(root, 'blocked-log.jsonl')
  mkdirSync(blocked, { recursive: true })
  const logger = createLogger({ config: resolvedConfig(), file: blocked })
  assert.doesNotThrow(() => logger.info('x', { a: 1 }))
  await assert.doesNotReject(() => logger.flush())
})

test('defaultLogFile points next to the audit file', () => {
  assert.equal(defaultLogFile('C:/home/.dsh'), join('C:/home/.dsh', 'logs', 'dsh-ssh', 'plugin.jsonl'))
})

// ---------------------------------------------------------------------------
// JsonlWriter
// ---------------------------------------------------------------------------

test('JsonlWriter rotates instead of growing without bound', () => {
  const file = tempPath('rotate.jsonl')
  const writer = new JsonlWriter(file, { maxBytes: 1024 })
  for (let index = 0; index < 40; index += 1) {
    assert.equal(writer.append({ index, padding: 'x'.repeat(64) }), true)
  }
  const archived = file.replace(/\.jsonl$/, '.1.jsonl')
  assert.ok(statSync(archived).size > 0, 'the previous file was archived')
  assert.ok(statSync(file).size <= 1024 + 128)
  const lines = writer.readTail({ limit: 5 })
  assert.equal(lines.length, 5)
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line))
})

test('readTail skips the partial first line of a tail window', () => {
  const file = tempPath('tail.jsonl')
  writeFileSync(file, `${Array.from({ length: 50 }, (_, index) => JSON.stringify({ index, pad: 'y'.repeat(80) })).join('\n')}\n`, 'utf8')
  const writer = new JsonlWriter(file)
  const lines = writer.readTail({ maxBytes: 512, limit: 100 })
  assert.ok(lines.length > 0)
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line), 'a mid-line start must be dropped')
})

test('JsonlWriter.append reports failure instead of throwing', () => {
  const blocked = join(root, 'writer-blocked.jsonl')
  mkdirSync(blocked, { recursive: true })
  const writer = new JsonlWriter(blocked)
  assert.equal(writer.append({ a: 1 }), false)
  assert.equal(writer.appendLine('x'), false)
  assert.deepEqual(writer.readTail(), [])
  assert.equal(writer.truncate(), false)
})
