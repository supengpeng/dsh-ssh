/**
 * Configuration contract: the schema's defaults are the single source of truth.
 *
 * `cordis.patch.yml` writes every default out explicitly so the composed profile
 * is self-documenting, which only holds if the schema produces the same values
 * when a line is deleted. These tests are what make that claim checkable.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Config, resolveConfig, resolveDshHome, toPublicConfig } from '../../lib/config.js'

test('an empty config object resolves every declared key', () => {
  const resolved = resolveConfig(Config({}))
  const keys = [
    'profilesFile',
    'auditFile',
    'maxSessions',
    'maxConcurrentOpsPerSession',
    'maxOutputBytes',
    'maxReplayFrames',
    'connectTimeoutMs',
    'operationTimeoutMs',
    'graceKillMs',
    'keepaliveIntervalMs',
    'keepaliveCountMax',
    'retries',
    'hostKey',
    'sftp',
    'secrets',
    'logging',
    'activity',
    'confirmDangerous',
    'allowAgentTools',
    'tools',
    'ui',
  ]
  for (const key of keys) {
    assert.ok(resolved[key] !== undefined, `${key} must have a resolved value`)
  }
})

test('nested objects fill their own defaults', () => {
  const resolved = resolveConfig(Config({}))
  // These are the values cordis.patch.yml writes out; a drift here is a bug.
  assert.equal(resolved.retries.max, 2)
  assert.equal(resolved.retries.backoffBaseMs, 500)
  assert.equal(resolved.retries.backoffMaxMs, 5000)
  assert.equal(resolved.retries.jitter, true)

  assert.equal(resolved.hostKey.policy, 'accept-new')
  assert.equal(resolved.sftp.chunkBytes, 262144)
  assert.equal(resolved.sftp.maxConcurrentChunks, 4)
  assert.equal(resolved.sftp.resume, true)
  assert.equal(resolved.sftp.verify, 'size+mtime')
  assert.equal(resolved.sftp.progressIntervalMs, 200)

  assert.equal(resolved.secrets.provider, 'credentials')
  assert.equal(resolved.secrets.envPrefix, 'DSH_SSH_')
  assert.equal(resolved.logging.level, 'info')
  assert.equal(resolved.logging.redact, true)
  assert.deepEqual(resolved.logging.redactKeys, [
    'password',
    'passphrase',
    'privateKey',
    'secret',
    'token',
    'key',
    'authorization',
  ])

  assert.equal(resolved.maxSessions, 10)
  assert.equal(resolved.maxConcurrentOpsPerSession, 4)
  assert.equal(resolved.maxOutputBytes, 262144)
  assert.equal(resolved.connectTimeoutMs, 15000)
  assert.equal(resolved.ui.defaultWidthPx, 420)
  assert.equal(resolved.ui.locale, 'auto')
  assert.equal(resolved.ui.terminalFontSize, 13)
  assert.deepEqual(resolved.tools, [
    'ssh_connect',
    'ssh_disconnect',
    'ssh_sessions',
    'ssh_exec',
    'ssh_upload',
    'ssh_download',
    'ssh_list_dir',
  ])
})

test('empty paths resolve under DSH_HOME', () => {
  const resolved = resolveConfig(Config({}), { DSH_HOME: 'C:/dsh-home' })
  assert.equal(resolved.dshHome, 'C:\\dsh-home')
  assert.equal(resolved.profilesFile, 'C:\\dsh-home\\dsh-ssh\\profiles.json')
  assert.equal(resolved.auditFile, 'C:\\dsh-home\\logs\\dsh-ssh\\audit.jsonl')
  assert.equal(resolved.knownHostsFile, 'C:\\dsh-home\\known_hosts')
})

test('explicit paths win over the DSH_HOME default', () => {
  const resolved = resolveConfig(
    Config({ profilesFile: 'C:/custom/profiles.json', auditFile: 'C:/custom/audit.jsonl', hostKey: { knownHostsFile: 'C:/custom/kh' } }),
    { DSH_HOME: 'C:/dsh-home' },
  )
  // An already-absolute path is passed through verbatim: whatever separator
  // style the operator wrote is preserved rather than silently rewritten.
  assert.equal(resolved.profilesFile, 'C:/custom/profiles.json')
  assert.equal(resolved.auditFile, 'C:/custom/audit.jsonl')
  assert.equal(resolved.knownHostsFile, 'C:/custom/kh')
})

test('a relative path is resolved against DSH_HOME', () => {
  const resolved = resolveConfig(Config({ profilesFile: 'ssh/profiles.json' }), { DSH_HOME: 'C:/dsh-home' })
  assert.equal(resolved.profilesFile, 'C:\\dsh-home\\ssh\\profiles.json')
})

test('resolveDshHome falls back to ~/.dsh and ignores a blank override', () => {
  assert.match(resolveDshHome({}), /\.dsh$/)
  assert.match(resolveDshHome({ DSH_HOME: '   ' }), /\.dsh$/)
})

test('unsafe numeric values are clamped, not trusted', () => {
  const resolved = resolveConfig(Config({ maxSessions: 0, maxConcurrentOpsPerSession: -3, connectTimeoutMs: 10, ui: { defaultWidthPx: 5 } }))
  assert.equal(resolved.maxSessions, 1)
  assert.equal(resolved.maxConcurrentOpsPerSession, 1)
  assert.equal(resolved.connectTimeoutMs, 1000)
  assert.equal(resolved.ui.defaultWidthPx, 280)
})

test('an unknown enum value is rejected by the schema', () => {
  assert.throws(() => Config({ hostKey: { policy: 'whatever' } }))
})

test('every schema default is the value the ICD freezes', () => {
  const resolved = resolveConfig(Config({}))
  // The remaining defaults not covered above; together these two tests assert the
  // whole ICD §6 table, so deleting a line from cordis.patch.yml stays harmless.
  assert.equal(resolved.profilesFile.endsWith('profiles.json'), true)
  assert.equal(resolved.auditFile.endsWith('audit.jsonl'), true)
  assert.equal(resolved.graceKillMs, 3000)
  assert.equal(resolved.operationTimeoutMs, 120000)
  assert.equal(resolved.keepaliveIntervalMs, 20000)
  assert.equal(resolved.keepaliveCountMax, 3)
  assert.equal(resolved.hostKey.knownHostsFile.endsWith('known_hosts'), true)
  assert.equal(resolved.sftp.followSymlinks, false)
  assert.equal(resolved.sftp.maxConcurrentChunks, 4)
  assert.equal(resolved.confirmDangerous, true)
  assert.equal(resolved.allowAgentTools, true)
  assert.equal(resolved.ui.reconnectAttempts, 5)
})

test('unsafe values are clamped on every numeric knob, not just the original four', () => {
  const resolved = resolveConfig(
    Config({
      maxOutputBytes: 1,
      graceKillMs: -5,
      operationTimeoutMs: 99999999,
      keepaliveIntervalMs: 0,
      keepaliveCountMax: 0,
      retries: { max: 99, backoffBaseMs: -1, backoffMaxMs: 99999999 },
      sftp: { chunkBytes: 1, maxConcurrentChunks: 0, progressIntervalMs: 1 },
      ui: { terminalFontSize: 99, reconnectAttempts: -3 },
    }),
  )
  assert.equal(resolved.maxOutputBytes, 1024)
  assert.equal(resolved.graceKillMs, 0)
  assert.equal(resolved.operationTimeoutMs, 3600000)
  assert.equal(resolved.keepaliveIntervalMs, 0)
  assert.equal(resolved.keepaliveCountMax, 1)
  assert.equal(resolved.retries.max, 10)
  assert.equal(resolved.retries.backoffBaseMs, 0)
  assert.equal(resolved.retries.backoffMaxMs, 600000)
  assert.equal(resolved.sftp.chunkBytes, 4096)
  assert.equal(resolved.sftp.maxConcurrentChunks, 1)
  assert.equal(resolved.sftp.progressIntervalMs, 50)
  assert.equal(resolved.ui.terminalFontSize, 32)
  assert.equal(resolved.ui.reconnectAttempts, 0)
})

test('the public projection drops the internal redaction list and keeps the rest', () => {
  const resolved = resolveConfig(Config({}), { DSH_HOME: 'C:/dsh-home' })
  const publicConfig = toPublicConfig(resolved)
  assert.deepEqual(Object.keys(publicConfig.logging).sort(), ['level', 'redact'])
  assert.equal(publicConfig.logging.redactKeys, undefined)
  assert.equal(publicConfig.logging.level, 'info')
  assert.deepEqual(publicConfig.secrets, { provider: 'credentials', envPrefix: 'DSH_SSH_' }, 'secrets never carries anything but the provider and prefix')
  assert.equal(publicConfig.profilesFile, resolved.profilesFile)
  assert.equal(publicConfig.auditFile, resolved.auditFile)
  assert.equal(publicConfig.knownHostsFile, resolved.knownHostsFile)
  assert.equal(publicConfig.maxSessions, resolved.maxSessions)
  assert.equal(JSON.stringify(publicConfig).includes('redactKeys'), false)
})

test('the replay frame bound accepts 0 as "no cap" and clamps everything else', () => {
  // 8192 is inert for frames >= 32 bytes (262144 / 8192 = 32), so the byte
  // budget still decides for every realistic chunk size; only tiny-frame streams
  // see the count bound. See src/config.ts's comment for the measurement behind it.
  assert.equal(resolveConfig(Config({})).maxReplayFrames, 8192)
  // 0 is a meaningful value, not "unset": it restores an unbounded count.
  assert.equal(resolveConfig(Config({ maxReplayFrames: 0 })).maxReplayFrames, 0)
  assert.equal(resolveConfig(Config({ maxReplayFrames: -1 })).maxReplayFrames, 0)
  assert.equal(resolveConfig(Config({ maxReplayFrames: 99_999_999 })).maxReplayFrames, 1_000_000)
})
