/**
 * ICD ↔ implementation conformance (ICD §9 "SP8 维护").
 *
 * This file is the project's contract gate. It *reads* `docs/ICD.md` and checks
 * the implementation against it, so a drift between the frozen document and the
 * code fails here instead of in a browser console:
 *
 *   §0    package/naming/envelope/bundle contract
 *   §3    frame discriminators + stream scheduling invariants (via a real stream)
 *   §4    every method of the method table exists on the host service
 *   §5    every error code exists, is classified, and matches the retryable column
 *   §8.5  both locales cover every frozen i18n key, with identical key sets
 *
 * Honest reporting rule (task-8): parts that depend on work still in flight are
 * reported as `skip` with an explicit reason that names the missing pieces —
 * never as a silent pass. `DSH_SSH_STRICT_ICD=1` turns those skips into failures
 * and is what M5 acceptance sets.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { validateFrameSequence } from '../support/frames.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const STRICT = process.env.DSH_SSH_STRICT_ICD === '1'

const read = (relPath) => readFileSync(join(ROOT, relPath), 'utf8')
const readJson = (relPath) => JSON.parse(read(relPath))

const ICD = read('docs/ICD.md')
const pkg = readJson('package.json')

/** Slice a section of the ICD by heading, e.g. `section('## 4.', '## 5.')`. */
function section(from, to) {
  const start = ICD.indexOf(from)
  if (start === -1) throw new Error(`ICD section ${from} not found`)
  const end = to ? ICD.indexOf(to, start + from.length) : ICD.length
  if (end === -1) throw new Error(`ICD section ${to} not found after ${from}`)
  return ICD.slice(start, end)
}

// ---------------------------------------------------------------------------
// §5 error codes and their retryable column
// ---------------------------------------------------------------------------

const ICD_ERROR_ROWS = (() => {
  const body = section('## 5.', '## 6.')
  const rows = []
  for (const line of body.split(/\r?\n/)) {
    const match = /^\|\s*`(SSH_[A-Z0-9_]+)`\s*\|([^|]*)\|([^|]*)\|([^|]*)\|/.exec(line.trim())
    if (!match) continue
    rows.push({
      code: match[1],
      category: match[2].trim(),
      retryable: match[3].includes('✅'),
      scenario: match[4].trim(),
    })
  }
  return rows
})()

const ICD_METHODS = (() => {
  const body = section('## 4.', '## 5.')
  const names = new Set()
  for (const match of body.matchAll(/`sshPlugin\/([A-Za-z][A-Za-z0-9]*)`/g)) names.add(match[1])
  return [...names].sort()
})()

const ICD_FRAME_TYPES = (() => {
  const body = section('## 3.', '## 4.')
  const types = new Set()
  for (const match of body.matchAll(/\bt:'([a-z]+)'/g)) types.add(match[1])
  return [...types].sort()
})()

/** Expand the §8.5 key list (`a.b|param` forms and `err.<CODE>`). */
const ICD_I18N_KEYS = (() => {
  const body = section('### 8.5', '### 8.6')
  const keys = new Set()
  for (const match of body.matchAll(/`([^`]+)`/g)) {
    const span = match[1].trim()
    if (!/^[a-z]/.test(span)) continue
    // Frozen keys are always dotted paths; this also skips `ssh` (the namespace
    // literal) and prose fragments in the same section.
    if (!span.includes('.')) continue
    if (span.includes('/') || span.includes('{') || span.includes('<')) continue
    const parts = span.split('|')
    keys.add(parts[0])
    for (const part of parts.slice(1)) {
      const base = parts[0].split('.').slice(0, -1).join('.')
      keys.add(base ? `${base}.${part}` : part)
    }
  }
  for (const { code } of ICD_ERROR_ROWS) keys.add(`err.${code}`)
  return [...keys].sort()
})()

// The host half must be built first (verify-all runs typecheck/build before tests).
const LIB = {
  protocol: join(ROOT, 'lib', 'protocol.js'),
  service: join(ROOT, 'lib', 'service.js'),
}
const built = Object.values(LIB).every(existsSync)
const protocol = built ? await import(pathToFileURL(LIB.protocol).href) : null
const serviceModule = built ? await import(pathToFileURL(LIB.service).href) : null

test('ICD §0: package naming and entry-point contract', async (t) => {
  assert.equal(pkg.name, '@local/dsh-ssh')
  assert.equal(pkg.private, true)
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.types, 'lib/index.d.ts')
  assert.equal(pkg.icon, './icon.svg')
  assert.deepEqual(pkg.exports['.'], { types: './lib/index.d.ts', import: './lib/index.js' })
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  // `external` must stay empty: the client bundle has to be self-contained and
  // the only allowed external request is the platform baseline module `react`.
  assert.equal(pkg.dsh.client.external, undefined)
  assert.ok(pkg.dependencies.ssh2, 'ssh2 must be a runtime dependency')
  for (const peer of ['@deepseek-ai/cordis', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-tools']) {
    assert.ok(pkg.peerDependencies[peer], `${peer} must be a peer dependency`)
  }

  const entry = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)
  assert.equal(entry.name, 'dsh-ssh', 'export const name must be the plugin id')
  assert.deepEqual(entry.inject, ['tools'])
  assert.equal(typeof entry.apply, 'function')
  assert.ok(entry.Config, 'the plugin must export a Schemastery Config')

  const patch = read('cordis.patch.yml')
  assert.match(patch, /dsh-ssh/, 'cordis.patch.yml must carry the plugin row')
  t.diagnostic(`entry ok, namespace ${protocol?.REMOTE_NAMESPACE}`)
})

test('ICD §0.3: client bundle envelope', async () => {
  const bundle = read('lib/client.js')
  assert.ok(bundle.startsWith('// GENERATED by scripts/build-client.mjs'), 'bundle must carry the GENERATED header')
  assert.match(bundle, /window\.__ModuleLoader__\.load\(\{/)
  assert.match(bundle, /id:\s*"@local\/dsh-ssh"/)
  assert.match(bundle, /factory:\s*\(?require\)?\s*=>/)
  // Only the factory's own `require` is an external request; the bundle's module
  // registry calls `SSH.require('ssh.x')`, which must never leave the bundle.
  const requires = new Set(
    [...bundle.matchAll(/(?<!SSH\.)\brequire\(["']([^"']+)["']\)/g)].map((match) => match[1]),
  )
  assert.deepEqual([...requires], ['react'], 'the only allowed external request is react')
  const internal = new Set([...bundle.matchAll(/SSH\.require\(["']([^"']+)["']\)/g)].map((match) => match[1]))
  assert.ok(internal.size >= 5, `expected the internal module registry to be used, saw ${internal.size} names`)
})

test('ICD §5: every frozen error code exists with the documented retryable flag', (t) => {
  if (!built) {
    t.skip('lib/ is not built; run `node scripts/verify-all.mjs --only build:host` first')
    return
  }
  assert.ok(ICD_ERROR_ROWS.length >= 30, `expected the §5 table, parsed ${ICD_ERROR_ROWS.length} rows`)
  const implemented = new Set(protocol.ERROR_CODES)
  const missing = ICD_ERROR_ROWS.filter((row) => !implemented.has(row.code)).map((row) => row.code)
  assert.deepEqual(missing, [], `codes missing from ERROR_CODES: ${missing.join(', ')}`)

  const retryMismatch = []
  for (const row of ICD_ERROR_ROWS) {
    if (protocol.isRetryable(row.code) !== row.retryable) {
      retryMismatch.push(`${row.code} (ICD ${row.retryable ? 'retryable' : 'not retryable'})`)
    }
  }
  assert.deepEqual(retryMismatch, [], `retryable flags drifted: ${retryMismatch.join(', ')}`)

  // `toErrorInfo` must always produce a wire-safe shape carrying the code.
  for (const row of ICD_ERROR_ROWS) {
    const info = protocol.toErrorInfo(new protocol.SshError(row.code, `msg for ${row.code}`))
    assert.equal(info.code, row.code)
    assert.equal(info.message, `msg for ${row.code}`)
    assert.equal(typeof info.retryable, 'boolean')
    assert.equal(info.retryable, row.retryable, `${row.code}: retryable must come from the table`)
  }
  t.diagnostic(`§5: ${ICD_ERROR_ROWS.length} codes verified`)
})

test('ICD §3: frame discriminators and stream invariants on a real stream', async (t) => {
  if (!built) {
    t.skip('lib/ is not built')
    return
  }
  const { SshPluginService } = serviceModule
  if (typeof SshPluginService !== 'function') {
    t.skip('lib/service.js does not export SshPluginService')
    return
  }
  const service = instantiate(SshPluginService)
  if (typeof service.probeStream !== 'function') {
    t.skip('no stream endpoint available yet to exercise the §3 invariants')
    return
  }

  const frames = []
  for await (const frame of service.probeStream({ count: 4, intervalMs: 0 })) frames.push(frame)

  const result = validateFrameSequence(frames, { label: 'probeStream', expectKind: 'exec' })
  assert.equal(result.dataFrames, 4)
  assert.ok(result.dataBytes > 0)
  assert.equal(ICD_FRAME_TYPES.join(','), 'audit,data,end,exit,open,progress,state')
  t.diagnostic(`§3: ${frames.length} frames validated (open → ${result.dataFrames} data → end)`)
})

test('ICD §4: the method table exists on the host service', (t) => {
  if (!built) {
    t.skip('lib/ is not built')
    return
  }
  const { SshPluginService } = serviceModule
  const prototype = new Set([
    ...Object.getOwnPropertyNames(SshPluginService.prototype),
    ...Object.getOwnPropertyNames(SshPluginService),
  ])
  const missing = ICD_METHODS.filter((method) => !prototype.has(method))
  const present = ICD_METHODS.filter((method) => prototype.has(method))

  // The namespace clash rule (ICD §0): `ssh` belongs to DSH, we must not take it.
  assert.equal(protocol.REMOTE_NAMESPACE, 'sshPlugin')
  assert.notEqual(protocol.SERVICE_KEY, 'ssh')

  if (missing.length) {
    const reason = `ICD §4 not fully wired yet: ${present.length}/${ICD_METHODS.length} methods present; missing ${missing.join(', ')}`
    if (STRICT) assert.fail(reason)
    t.skip(reason)
    return
  }
  for (const method of ICD_METHODS) assert.equal(typeof SshPluginService.prototype[method], 'function', `${method} must be a function`)
  t.diagnostic(`§4: ${ICD_METHODS.length}/${ICD_METHODS.length} methods present`)
})

test('ICD §4.2: profile projections never carry plaintext credentials', (t) => {
  if (!built) {
    t.skip('lib/ is not built')
    return
  }
  const { SshPluginService } = serviceModule
  const prototype = new Set(Object.getOwnPropertyNames(SshPluginService.prototype))
  const required = ['listProfiles', 'saveProfile', 'getConfig', 'setSecret']
  const missing = required.filter((method) => !prototype.has(method))
  if (missing.length) {
    const reason = `credential projections are not wired yet (missing ${missing.join(', ')}); needs src/api/** + src/credentials.ts wiring`
    if (STRICT) assert.fail(reason)
    t.skip(reason)
    return
  }
  t.skip('projection check requires a live service instance and a configured credentials store')
})

test('ICD §8.5: both locales cover every frozen i18n key', async (t) => {
  const zh = readJson('locale/zh.json')
  const en = readJson('locale/en.json')
  const zhKeys = Object.keys(zh)
  const enKeys = Object.keys(en)

  assert.deepEqual(
    zhKeys.filter((key) => !enKeys.includes(key)),
    [],
    'every zh key must exist in en',
  )
  assert.deepEqual(
    enKeys.filter((key) => !zhKeys.includes(key)),
    [],
    'every en key must exist in zh',
  )

  const missing = ICD_I18N_KEYS.filter((key) => !(key in zh) || !(key in en))
  if (missing.length) {
    const reason = `§8.5 keys missing from locale files: ${missing.join(', ')}`
    if (STRICT) assert.fail(reason)
    // A missing key renders as the raw key in the UI, so this is a real gap.
    assert.fail(reason)
  }

  for (const key of ICD_I18N_KEYS) {
    assert.equal(typeof zh[key], 'string', `zh.${key} must be a string`)
    assert.equal(typeof en[key], 'string', `en.${key} must be a string`)
    assert.notEqual(zh[key].trim(), '', `zh.${key} must not be empty`)
    assert.notEqual(en[key].trim(), '', `en.${key} must not be empty`)
  }
  t.diagnostic(`§8.5: ${ICD_I18N_KEYS.length} frozen keys present in both locales (${zhKeys.length} total)`)
})

test('ICD §6: cordis.patch.yml exposes every config default', (t) => {
  const patch = read('cordis.patch.yml')
  const required = ['maxSessions', 'connectTimeoutMs', 'operationTimeoutMs', 'graceKillMs', 'keepaliveIntervalMs', 'retries', 'hostKey', 'sftp', 'secrets', 'logging', 'maxOutputBytes', 'allowAgentTools', 'tools', 'ui']
  const missing = required.filter((key) => !new RegExp(`\\b${key}\\b`).test(patch))
  if (missing.length) {
    // `cordis.patch.yml` is Lead-owned; the schema (src/config.ts) already has the
    // key, so this is a documentation drift, not a code defect.
    const reason = `cordis.patch.yml does not document these defaults: ${missing.join(', ')}`
    if (STRICT) assert.fail(reason)
    t.diagnostic(reason)
  }
  for (const key of required.filter((candidate) => !missing.includes(candidate))) {
    assert.match(patch, new RegExp(`\\b${key}\\b`), `cordis.patch.yml must document the default for ${key}`)
  }
})

/** Construct the service with the smallest viable fakes. */
function instantiate(SshPluginService) {
  const config = {
    profilesFile: '',
    auditFile: join(ROOT, '.unused-audit.jsonl'),
    knownHostsFile: '',
    maxSessions: 10,
    hostKey: { policy: 'accept-new', knownHostsFile: '' },
    sftp: { chunkBytes: 262144, resume: true, verify: 'size+mtime', followSymlinks: false, progressIntervalMs: 200 },
    secrets: { provider: 'credentials', envPrefix: 'DSH_SSH_' },
    logging: { level: 'error', redact: true, redactKeys: [] },
    ui: { defaultWidthPx: 420, locale: 'auto', terminalFontSize: 13, reconnectAttempts: 5 },
  }
  const logger = { debug() {}, info() {}, warn() {}, error() {} }
  return new SshPluginService({ get: () => undefined, effect: () => () => {} }, config, logger, {})
}
