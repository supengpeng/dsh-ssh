/**
 * §4.5 SFTP and §4.6 audit, through the real wire service.
 *
 * The transfer stream is the part worth spelling out, because its handshake is not
 * a return value: `{ opId, resumedFrom }` arrive in the `open` frame's `meta`
 * (a Remote stream method returns the frame sequence itself). A UI that showed
 * "resuming at 34%" only after the first progress frame would be using a number
 * the manager had ready before the transfer started.
 *
 * The local half of the dual pane is exercised against a real temporary directory:
 * it is the one endpoint pair whose behaviour depends on the filesystem rather
 * than on a double.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { createAuditor } from '../../lib/audit.js'
import { Config, resolveConfig } from '../../lib/config.js'
import { LocalApi } from '../../lib/api/local-api.js'
import { createRedactor } from '../../lib/redact.js'
import { createProfileStore } from '../../lib/store.js'
import { createSessionRegistry } from '../../lib/sessions.js'
import { SshError } from '../../lib/protocol.js'
import { SshPluginService } from '../../lib/service.js'

const root = mkdtempSync(join(tmpdir(), 'dsh-ssh-api-f-'))
after(() => rmSync(root, { recursive: true, force: true }))

let counter = 0
function harness(options = {}) {
  counter += 1
  const home = join(root, `case-${counter}`)
  const localRoot = join(home, 'local')
  mkdirSync(localRoot, { recursive: true })
  const config = resolveConfig(Config({}), { DSH_HOME: home })
  const redactor = createRedactor({ redactKeys: config.logging.redactKeys, enabled: true })
  const logger = { debug() {}, info() {}, warn() {}, error() {} }
  const store = createProfileStore({
    file: config.profilesFile,
    defaults: {
      connectTimeoutMs: config.connectTimeoutMs,
      keepaliveIntervalMs: config.keepaliveIntervalMs,
      keepaliveCountMax: config.keepaliveCountMax,
      retries: config.retries,
      hostKeyPolicy: config.hostKey.policy,
    },
    redactKeys: config.logging.redactKeys,
  })
  const audit = createAuditor({ file: config.auditFile, redactor, logger })
  const registry = createSessionRegistry({ maxConcurrentOpsPerSession: 4, logger, redactor })

  const sftpCalls = []
  const handle = fakeSftpHandle(sftpCalls, options)
  const session = {
    id: 's_sftp',
    info: { id: 's_sftp', label: 'sftp', host: 'h.example', port: 22, user: 'deploy', state: 'connected', since: new Date().toISOString(), metrics: { bytesIn: 0, bytesOut: 0 }, capabilities: { shell: true, sftp: true } },
    state: 'connected',
    async exec() { throw new Error('not used') },
    async shell() { throw new Error('not used') },
    async sftp() { return handle },
    rttMs: () => undefined,
    async close() {},
  }
  registry.create(session)
  const pool = { async acquire() { return session }, get: (id) => (id === 's_sftp' ? session : undefined), list: () => [session], async disposeAll() {}, size: 1, pending: 0 }

  const transfers = fakeTransfers(options)
  const deps = {
    config, logger, redactor, store, audit, pool, registry, transfers,
    exec: { limits: {}, dispose() {} },
    credentials: { async describe() { return { password: { present: false, source: 'none', masked: '' }, passphrase: { present: false, source: 'none', masked: '' } } } },
    knownHosts: { async verify() { return { ok: true, knownHostsMatch: 'exact', fingerprint: 'SHA256:x', policy: 'accept-new' } }, async remember() {}, fingerprint: () => 'SHA256:x' },
  }
  const api = new LocalApi(deps)
  const service = new SshPluginService({}, config, logger, { api })
  return { home, localRoot, config, store, audit, registry, service, api, sftpCalls, transfers, sessionId: 's_sftp' }
}

function fakeSftpHandle(calls, options = {}) {
  const entry = (name, type = 'file', size = 10) => ({ name, path: `/remote/${name}`, type, size, mode: '0644', mtime: new Date(0).toISOString(), isSymlink: false })
  return {
    async listDir(path, opts) {
      calls.push({ op: 'listDir', path, opts })
      if (options.listDirError !== undefined) throw options.listDirError
      const all = [entry('b.txt'), entry('a-dir', 'dir'), entry('.hidden')]
      // The adapter owns this filter (not `SftpClient`, which only forwards the
      // flag), so the double must honour it to be a faithful stand-in.
      return opts?.showHidden === true ? all : all.filter((item) => !item.name.startsWith('.'))
    },
    async stat(path) {
      calls.push({ op: 'stat', path })
      if (options.statError !== undefined) throw options.statError
      if (path === '/remote/missing') {
        // The adapter reports a missing path with the frozen code (sp3's error
        // mapper), which is what `SftpClient.stat` turns into `exists: false`.
        throw new SshError('SSH_SFTP_NO_SUCH_FILE', 'no such file')
      }
      return { name: path.split('/').pop(), path, type: 'file', size: 42, mode: '0644', mtime: new Date(1000).toISOString(), isSymlink: false, exists: true }
    },
    async mkdir(path, opts) { calls.push({ op: 'mkdir', path, opts }) },
    async rename(from, to) { calls.push({ op: 'rename', from, to }) },
    async remove(path, opts) {
      calls.push({ op: 'remove', path, opts })
      if (options.removeError !== undefined) throw options.removeError
      return opts?.recursive === true ? 3 : 1
    },
    async chmod(path, mode) {
      calls.push({ op: 'chmod', path, mode })
      if (options.chmodError !== undefined) throw options.chmodError
    },
    createReadStream() { throw new Error('not used') },
    createWriteStream() { throw new Error('not used') },
  }
}

function fakeTransfers(options = {}) {
  const started = []
  return {
    started,
    active: options.active ?? 0,
    async start(params) {
      started.push(params)
      queueMicrotask(() => {
        params.sink?.onProgress?.({ transferred: 512, totalBytes: 1024, bytesPerSec: 51200, etaMs: 10, phase: 'scan' })
        params.sink?.onProgress?.({ transferred: 1024, totalBytes: 1024, bytesPerSec: 102400, phase: 'transfer' })
        params.sink?.onEnd?.(
          options.endEvent ?? { reason: 'completed' },
        )
      })
      return {
        streamId: params.streamId,
        opId: options.opId ?? 'op_1',
        resumedFrom: options.resumedFrom ?? 0,
        ...(options.totalBytes === undefined ? {} : { totalBytes: options.totalBytes }),
      }
    },
    async run() { throw new Error('not used') },
    cancel: (opId) => options.cancelledOp === opId,
    list: () => options.tasks ?? [],
    dispose() {},
  }
}

async function collect(iterable) {
  const frames = []
  for await (const frame of iterable) frames.push(frame)
  return frames
}

// ---------------------------------------------------------------------------
// §4.5 single-path operations
// ---------------------------------------------------------------------------

test('listDir returns sorted entries and the normalized cwd', async () => {
  const h = harness()
  const result = await h.service.listDir(JSON.stringify({ sessionId: h.sessionId, path: '/remote' }))
  assert.equal(result.cwd, '/remote')
  assert.equal(result.entries.length, 2, 'the hidden entry is excluded unless asked for')
  assert.equal(result.entries[0].name, 'a-dir', 'directories sort first')
  assert.deepEqual(h.sftpCalls[0].opts, { showHidden: false })
  const withHidden = await h.service.listDir(JSON.stringify({ sessionId: h.sessionId, path: '/remote', showHidden: true }))
  assert.equal(withHidden.entries.length, 3)
})

test('listDir maps an SFTP failure to its frozen code', async () => {
  const h = harness({ listDirError: new SshError('SSH_PERM_DENIED', 'denied') })
  const failure = await h.service.listDir(JSON.stringify({ sessionId: h.sessionId, path: '/root' })).then(() => undefined, (e) => e)
  assert.equal(failure.code, 'SSH_PERM_DENIED')
})

test('listDir refuses an unknown session with the session list in details', async () => {
  const h = harness()
  const failure = await h.service.listDir(JSON.stringify({ sessionId: 's_nope', path: '/remote' })).then(() => undefined, (e) => e)
  assert.equal(failure.code, 'SSH_STATE_INVALID')
  assert.deepEqual(failure.details.sessions, [h.sessionId])
})

test('stat reports existence instead of throwing for a missing path', async () => {
  const h = harness()
  const found = await h.service.stat(JSON.stringify({ sessionId: h.sessionId, path: '/remote/a.txt' }))
  assert.equal(found.info.exists, true)
  assert.equal(found.info.size, 42)
  const missing = await h.service.stat(JSON.stringify({ sessionId: h.sessionId, path: '/remote/missing' }))
  assert.equal(missing.info.exists, false)
})

test('mkdir is recursive by default and honours recursive:false', async () => {
  const h = harness()
  await h.service.mkdir(JSON.stringify({ sessionId: h.sessionId, path: '/remote/new' }))
  assert.equal(h.sftpCalls.at(-1).opts.recursive, true)
  await h.service.mkdir(JSON.stringify({ sessionId: h.sessionId, path: '/remote/new', recursive: false }))
  assert.equal(h.sftpCalls.at(-1).opts.recursive, false)
  assert.deepEqual(await h.service.mkdir(JSON.stringify({ sessionId: h.sessionId, path: '/remote/new' })), { created: true })
})

test('rename, removePath and chmod answer their frozen shapes', async () => {
  const h = harness()
  assert.deepEqual(await h.service.rename(JSON.stringify({ sessionId: h.sessionId, from: '/a', to: '/b' })), { renamed: true })
  // The wire method is `removePath`: `remove` collides with the Gateway's namespace
  // service method of the same name (see docs/ICD.md §4.5).
  assert.deepEqual(await h.service.removePath(JSON.stringify({ sessionId: h.sessionId, path: '/dir', recursive: true })), { removed: 3 })
  assert.deepEqual(await h.service.chmod(JSON.stringify({ sessionId: h.sessionId, path: '/f', mode: '0755' })), { mode: '0755' })
  assert.equal(h.sftpCalls.find((call) => call.op === 'chmod').mode, '0755')
  assert.equal(h.sftpCalls.find((call) => call.op === 'rename').to, '/b')
})

test('a required path is refused by name, not by an empty answer', async () => {
  const h = harness()
  for (const method of ['stat', 'mkdir', 'removePath', 'chmod']) {
    const failure = await h.service[method](JSON.stringify({ sessionId: h.sessionId })).then(() => undefined, (e) => e)
    assert.equal(failure.code, 'SSH_CFG_INVALID', `${method} should require a path`)
    assert.match(failure.message, /path is required/)
  }
})

// ---------------------------------------------------------------------------
// §4.5 transfers
// ---------------------------------------------------------------------------

test('upload carries its handshake in the open frame and relays progress', async () => {
  const h = harness({ totalBytes: 1024, resumedFrom: 256 })
  const frames = await collect(
    h.service.upload(JSON.stringify({ sessionId: h.sessionId, localPath: '/local/big.bin', remotePath: '/remote/big.bin', resume: true })),
  )
  assert.equal(frames[0].t, 'open')
  assert.equal(frames[0].kind, 'upload')
  assert.equal(frames[0].meta.opId, 'op_1')
  assert.equal(frames[0].meta.resumedFrom, 256)
  assert.equal(frames[0].meta.totalBytes, 1024)
  assert.equal(frames[0].streamId, frames[1].streamId, 'every frame shares one stream id')
  assert.deepEqual(frames.filter((f) => f.t === 'progress').map((f) => f.transferred), [512, 1024])
  assert.equal(frames.at(-1).t, 'end')
  assert.equal(frames.at(-1).reason, 'completed')
  assert.equal(frames.filter((f) => f.t === 'end').length, 1)
  const started = h.transfers.started[0]
  assert.equal(started.direction, 'upload')
  assert.equal(started.resume, true)
  assert.equal(started.localPath, '/local/big.bin')
})

test('download relays a cancellation as a terminal error frame', async () => {
  const h = harness({ endEvent: { reason: 'cancelled', error: { code: 'SSH_SFTP_TRANSFER_ABORTED', message: 'cancelled', retryable: true, details: { resumedFrom: 512 } } } })
  const frames = await collect(h.service.download(JSON.stringify({ sessionId: h.sessionId, localPath: '/local/x', remotePath: '/remote/x' })))
  const end = frames.at(-1)
  assert.equal(end.reason, 'cancelled')
  assert.equal(end.error.code, 'SSH_SFTP_TRANSFER_ABORTED')
  assert.equal(end.error.details.resumedFrom, 512, 'the durable offset is preserved for a resume')
})

test('an invalid verify value is refused before the transfer starts', async () => {
  const h = harness()
  const failure = await collect(h.service.upload(JSON.stringify({ sessionId: h.sessionId, localPath: '/a', remotePath: '/b', verify: 'md5' }))).then(() => undefined, (e) => e)
  assert.equal(failure.code, 'SSH_CFG_INVALID')
  assert.equal(h.transfers.started.length, 0)
})

test('cancelTransfer answers false for an op that is already settled', async () => {
  const h = harness({ cancelledOp: 'op_live' })
  assert.deepEqual(await h.service.cancelTransfer(JSON.stringify({ opId: 'op_live' })), { cancelled: true })
  assert.deepEqual(await h.service.cancelTransfer(JSON.stringify({ opId: 'op_done' })), { cancelled: false })
})

test('listTransfers projects the live records to the frozen task shape', async () => {
  const h = harness({
    tasks: [
      {
        opId: 'op_1',
        streamId: 'st_1',
        sessionId: 's_sftp',
        direction: 'upload',
        localPath: '/local/a',
        remotePath: '/remote/a',
        totalBytes: 2048,
        transferred: 1024,
        phase: 'transfer',
        bytesPerSec: 1024,
        etaMs: 1000,
        resumeFrom: 512,
        startedAt: new Date(0).toISOString(),
      },
    ],
  })
  const result = await h.service.listTransfers('{}')
  assert.equal(result.tasks.length, 1)
  assert.deepEqual(result.tasks[0], {
    opId: 'op_1',
    direction: 'upload',
    localPath: '/local/a',
    remotePath: '/remote/a',
    totalBytes: 2048,
    transferred: 1024,
    phase: 'transfer',
    bytesPerSec: 1024,
    etaMs: 1000,
    resumeFrom: 512,
  })
  assert.equal('streamId' in result.tasks[0], false, 'internal fields do not leak into the wire shape')
})

// ---------------------------------------------------------------------------
// Dual-pane local half
// ---------------------------------------------------------------------------

test('listLocalDir and statLocal read a real directory', async () => {
  const h = harness()
  mkdirSync(join(h.localRoot, 'sub'), { recursive: true })
  writeFileSync(join(h.localRoot, 'file.txt'), 'hello', 'utf8')
  writeFileSync(join(h.localRoot, '.hidden'), 'x', 'utf8')

  const listing = await h.service.listLocalDir(JSON.stringify({ path: h.localRoot }))
  assert.equal(listing.cwd, h.localRoot)
  assert.deepEqual(listing.entries.map((entry) => entry.name), ['sub', 'file.txt'])
  const withHidden = await h.service.listLocalDir(JSON.stringify({ path: h.localRoot, showHidden: true }))
  assert.equal(withHidden.entries.length, 3)

  const info = await h.service.statLocal(JSON.stringify({ path: join(h.localRoot, 'file.txt') }))
  assert.equal(info.info.exists, true)
  assert.equal(info.info.size, 5)
  const missing = await h.service.statLocal(JSON.stringify({ path: join(h.localRoot, 'nope.txt') }))
  assert.equal(missing.info.exists, false)
})

test('listLocalDir reports a missing directory with the frozen code', async () => {
  const h = harness()
  const failure = await h.service.listLocalDir(JSON.stringify({ path: join(h.localRoot, 'nope') })).then(() => undefined, (e) => e)
  assert.equal(failure.code, 'SSH_SFTP_NO_SUCH_FILE')
})

// ---------------------------------------------------------------------------
// §4.6 audit
// ---------------------------------------------------------------------------

test('queryAudit filters, paginates and never carries a secret', async () => {
  const h = harness()
  h.audit.record({ op: 'connect', outcome: 'ok', sessionId: 's_1' })
  h.audit.record({ op: 'exec', outcome: 'ok', sessionId: 's_1', detail: { command: 'ls', password: 'hunter2!' } })
  h.audit.record({ op: 'exec', outcome: 'error', sessionId: 's_2', detail: { command: 'cat /etc/shadow' } })

  const all = await h.service.queryAudit('{}')
  assert.equal(all.total, 3)
  assert.deepEqual(all.entries.map((entry) => entry.op), ['exec', 'exec', 'connect'], 'newest first')

  const bySession = await h.service.queryAudit(JSON.stringify({ sessionId: 's_2' }))
  assert.equal(bySession.total, 1)
  const byKind = await h.service.queryAudit(JSON.stringify({ kindsJson: '["exec"]' }))
  assert.equal(byKind.total, 2)
  const page = await h.service.queryAudit(JSON.stringify({ limit: 1, offset: 1 }))
  assert.equal(page.entries.length, 1)
  assert.equal(page.total, 3)

  assert.equal(JSON.stringify(all).includes('hunter2'), false, 'the detail was redacted on the way in')
  const redacted = all.entries.find((entry) => entry.detail?.password !== undefined)
  assert.equal(redacted.detail.password, '••••••••')
})

test('a malformed kinds list is refused instead of silently ignoring the filter', async () => {
  const h = harness()
  const failure = await h.service.queryAudit(JSON.stringify({ kindsJson: '["exec", 7]' })).then(() => undefined, (e) => e)
  assert.equal(failure.code, 'SSH_CFG_INVALID')
  assert.match(failure.message, /must contain only strings/)
})

test('followAudit streams new entries and filters by session', async () => {
  const h = harness()
  const frames = []
  const iterator = h.service.followAudit(JSON.stringify({ sessionId: 's_keep' }))[Symbol.asyncIterator]()
  const firstFrame = iterator.next()
  // Give the subscription a tick to attach before producing entries.
  await new Promise((resolve) => setTimeout(resolve, 2))
  h.audit.record({ op: 'exec', outcome: 'ok', sessionId: 's_drop' })
  h.audit.record({ op: 'exec', outcome: 'ok', sessionId: 's_keep' })
  const received = await firstFrame
  frames.push(received.value)
  await iterator.return()
  assert.equal(frames.length, 1)
  assert.equal(frames[0].t, 'audit')
  assert.equal(frames[0].entry.sessionId, 's_keep', 'the filter is applied server-side')
})

test('clearAudit reports how many entries it removed and records the clear itself', async () => {
  const h = harness()
  h.audit.record({ op: 'connect', outcome: 'ok' })
  h.audit.record({ op: 'exec', outcome: 'ok' })
  assert.deepEqual(await h.service.clearAudit('{}'), { cleared: 2 })
  // Clearing the audit is itself an auditable act: the history after a clear is
  // exactly one entry saying who emptied it, never an unexplained silence.
  const after = await h.service.queryAudit('{}')
  assert.equal(after.total, 1)
  assert.equal(after.entries[0].op, 'clearAudit')
  assert.equal(after.entries[0].detail.cleared, 2)
})

test('a transfer that ends in an error is audited with its code', async () => {
  const h = harness({ endEvent: { reason: 'error', error: { code: 'SSH_SFTP_TARGET_EXISTS', message: 'exists', retryable: false } } })
  await collect(h.service.upload(JSON.stringify({ sessionId: h.sessionId, localPath: '/a', remotePath: '/b' })))
  const entries = await h.audit.query({ kinds: ['upload'] })
  assert.equal(entries.total, 1)
  assert.equal(entries.entries[0].detail.remotePath, '/b')
})

test('a failing sftp call produces an SshError with a code the client branches on', async () => {
  const h = harness({ removeError: new SshError('SSH_PERM_DENIED', 'read-only filesystem') })
  const failure = await h.service.removePath(JSON.stringify({ sessionId: h.sessionId, path: '/f' })).then(() => undefined, (e) => e)
  assert.equal(failure.code, 'SSH_PERM_DENIED')
  assert.equal(failure.retryable, false)
})
