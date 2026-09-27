/**
 * The tool surface, driven the way the model drives it.
 *
 * This file exists because of a specific escape: every endpoint test injected
 * `LocalApi` directly, so the **tool → endpoint** seam had no coverage at all and
 * shipped with `ssh_connect` sending its inline body under `profileJson` while
 * `connect` reads `inline`/`inlineJson`. Every unit test passed; the first real
 * `ssh_connect` call from the agent loop failed with "connect needs a profileId or
 * an inline profile", and the whole "operate SSH from the model" story was dead on
 * arrival.
 *
 * So these tests start from the registry the plugin actually populates and call the
 * registered `execute`, with arguments shaped like a model's — not from the endpoint
 * facade, and not from a hand-built `Params` object.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { createAuditor } from '../../lib/audit.js'
import { Config, resolveConfig } from '../../lib/config.js'
import { LocalApi } from '../../lib/api/local-api.js'
import { registerAgentTools } from '../../lib/api/tools.js'
import { createRedactor } from '../../lib/redact.js'
import { createProfileStore } from '../../lib/store.js'
import { createSessionRegistry } from '../../lib/sessions.js'
import { SshError } from '../../lib/protocol.js'

const root = mkdtempSync(join(tmpdir(), 'dsh-ssh-api-tools-'))
after(() => rmSync(root, { recursive: true, force: true }))

let counter = 0
/** A harness whose tool registry is real enough to capture what the plugin registers. */
function harness(options = {}) {
  counter += 1
  const home = join(root, `case-${counter}`)
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

  const sessions = new Map()
  const acquired = []
  const pool = {
    async acquire(input) {
      acquired.push(input)
      const id = `s_${acquired.length}`
      const handle = {
        id,
        info: {
          id,
          label: input.label ?? input.profile.name,
          host: input.profile.host,
          port: input.profile.port,
          user: input.profile.user,
          state: 'connected',
          since: new Date().toISOString(),
          metrics: { bytesIn: 0, bytesOut: 0 },
          capabilities: { shell: true, sftp: true },
        },
        state: 'connected',
        async exec() { throw new Error('not used') },
        async shell() { throw new Error('not used') },
        async sftp() { throw new Error('not used') },
        rttMs: () => undefined,
        // Faithful to SP1: closing a session removes it from the registry (the pool
        // keeps the registry in sync), which is what makes `ssh_sessions` answer
        // "nothing is connected" afterwards.
        async close() {
          closed.push(id)
          sessions.delete(id)
          registry.remove(id)
        },
      }
      sessions.set(id, handle)
      registry.create(handle)
      return handle
    },
    get: (id) => sessions.get(id),
    list: () => [...sessions.values()],
    async disposeAll() {},
    size: sessions.size,
    pending: 0,
  }
  const closed = []

  const deps = {
    config, logger, redactor, store, audit, pool, registry,
    exec: {
      limits: { maxOutputBytes: 1024, operationTimeoutMs: 1000, graceKillMs: 100 },
      exec: () => ({ streamId: 'st', done: Promise.resolve({}) }),
      openShell: () => ({ streamId: 'st', done: Promise.resolve({}) }),
      async execWait() {
        return { streamId: 'st', exitCode: 0, stdout: 'ok\n', stderr: '', truncated: { stdout: false, stderr: false }, durationMs: 1, timedOut: false, endReason: 'completed', bytes: { stdout: 3, stderr: 0 } }
      },
      subscribe: () => ({ unsubscribe() {}, replayed: 0, gap: false, finished: true }),
      shellWrite: () => ({ written: 0 }),
      shellResize: () => ({ resized: true }),
      shellSignal: () => ({ sent: true }),
      shellClose: () => ({ closed: true }),
      listStreams: () => ({ streams: [] }),
      dispose() {},
    },
    transfers: {
      active: 0,
      async start() { return { streamId: 'st', opId: 'op', resumedFrom: 0 } },
      async run() { throw new Error('not used') },
      cancel: () => false,
      list: () => [],
      dispose() {},
    },
    credentials: {
      async describe() { return { password: { present: false, source: 'none', masked: '' }, passphrase: { present: false, source: 'none', masked: '' } } },
      async resolveProfile(profile) { return { ...profile, secrets: { source: { password: 'none', passphrase: 'none' }, toJSON: () => ({}) } } },
    },
    knownHosts: {
      async verify() { return { ok: true, knownHostsMatch: 'exact', fingerprint: 'SHA256:x', policy: 'accept-new' } },
      async remember() {},
      fingerprint: () => 'SHA256:x',
    },
  }
  const api = new LocalApi(deps)

  // The registry the plugin registers into, captured so a test can invoke exactly
  // what the agent loop would see.
  const registered = new Map()
  const ctx = {
    tools: {
      register(tool) {
        registered.set(tool.name, tool)
        return () => registered.delete(tool.name)
      },
    },
  }
  const registration = options.skipRegistration === true ? undefined : registerAgentTools({ ctx, config, exec: deps.exec, pool, registry, transfers: deps.transfers, audit, log: logger, api })
  return { config, store, audit, registry, pool, api, ctx, registered, registration, acquired, closed, deps }
}

/** Run a registered tool the way the registry does: `execute(args, runContext)`. */
async function callTool(h, name, args) {
  const tool = h.registered.get(name)
  assert.ok(tool, `${name} was not registered`)
  return tool.execute(args, { signal: new AbortController().signal, deferContext() {}, concludeTurn() {} })
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test('all seven configured tools register, and nothing else is claimed', () => {
  const h = harness()
  assert.deepEqual(h.registration.registered, [
    'ssh_connect',
    'ssh_disconnect',
    'ssh_sessions',
    'ssh_exec',
    'ssh_upload',
    'ssh_download',
    'ssh_list_dir',
  ])
  assert.deepEqual(h.registration.skipped, [], 'the configuration names exactly what the plugin implements')
  assert.equal(h.registered.size, 7)
  for (const name of h.registration.registered) {
    const tool = h.registered.get(name)
    assert.equal(typeof tool.execute, 'function', `${name} exposes execute`)
    assert.ok(tool.description.length > 20, `${name} has a description for the model`)
    assert.ok(tool.output?.schema !== undefined, `${name} declares its output contract`)
  }
})

test('a composition without a tools registry skips everything without throwing', () => {
  const h = harness({ skipRegistration: true })
  const registration = registerAgentTools({
    ctx: {},
    config: h.config,
    exec: h.deps.exec,
    pool: h.pool,
    registry: h.registry,
    transfers: h.deps.transfers,
    audit: h.audit,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    api: h.api,
  })
  assert.deepEqual(registration.registered, [])
  assert.equal(registration.skipped.length, 7)
  assert.match(registration.skipped[0].reason, /no tools registry/)
})

test('allowAgentTools: false registers nothing and says why', () => {
  const h = harness({ skipRegistration: true })
  const config = { ...h.config, allowAgentTools: false }
  const registration = registerAgentTools({
    ctx: h.ctx,
    config,
    exec: h.deps.exec,
    pool: h.pool,
    registry: h.registry,
    transfers: h.deps.transfers,
    audit: h.audit,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    api: h.api,
  })
  assert.deepEqual(registration.registered, [])
  assert.match(registration.skipped[0].reason, /allowAgentTools is false/)
})

// ---------------------------------------------------------------------------
// The seam that was broken
// ---------------------------------------------------------------------------

test('ssh_connect with an inline host actually connects (regression)', async () => {
  const h = harness()
  const result = await callTool(h, 'ssh_connect', {
    host: 'prod.example.com',
    port: 2222,
    user: 'deploy',
    auth: 'password',
    password: 'tool-supplied-secret',
    name: 'from the tool',
  })
  assert.equal(result.ok, true, `ssh_connect refused the call: ${result.code} ${result.message}`)
  assert.equal(result.host, 'prod.example.com')
  assert.equal(result.port, 2222)
  assert.equal(result.user, 'deploy')
  assert.equal(result.state, 'connected')
  assert.ok(result.sessionId)
  assert.deepEqual(result.capabilities, { shell: true, sftp: true })
  // The inline body and the one-shot secret reached the pool as a resolved profile.
  assert.equal(h.acquired.length, 1)
  assert.equal(h.acquired[0].profile.host, 'prod.example.com')
  assert.equal(h.acquired[0].profile.port, 2222)
  assert.equal(h.acquired[0].label, 'from the tool')
  assert.equal(JSON.stringify(result).includes('tool-supplied-secret'), false, 'the tool result never carries the secret')
})

test('ssh_connect by profileId keeps the secret out of the call', async () => {
  const h = harness()
  const profile = await h.store.save({ name: 'prod', host: 'saved.example', user: 'root' })
  const result = await callTool(h, 'ssh_connect', { profileId: profile.id, viaEnv: true })
  assert.equal(result.ok, true)
  assert.equal(result.host, 'saved.example')
  assert.match(result.notes.join(' '), /profile:/)
})

test('ssh_connect with neither profileId nor host refuses with a usable message', async () => {
  const h = harness()
  const result = await callTool(h, 'ssh_connect', { user: 'root' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'SSH_CFG_INVALID')
  assert.match(result.message, /profileId|inline/)
  assert.ok(result.notes.length > 0, 'the refusal tells the model what it could do instead')
})

test('a connection failure is returned as a structured refusal, not thrown', async () => {
  const h = harness()
  h.pool.acquire = async () => {
    throw new SshError('SSH_AUTH_FAILED', 'authentication failed')
  }
  const result = await callTool(h, 'ssh_connect', { host: 'h.example', user: 'root', auth: 'password', password: 'wrong' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'SSH_AUTH_FAILED')
  assert.match(result.notes.join(' '), /credential was rejected|setSecret|inline/, 'a refusal explains the next step')
  assert.equal(JSON.stringify(result).includes('wrong'), false)
})

test('a host-key refusal explains both remedies', async () => {
  const h = harness()
  h.pool.acquire = async () => {
    throw new SshError('SSH_HOSTKEY_UNKNOWN', 'the host key is not known')
  }
  const result = await callTool(h, 'ssh_connect', { host: 'new.example', user: 'root' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'SSH_HOSTKEY_UNKNOWN')
  const notes = result.notes.join(' ')
  assert.match(notes, /trust|known_hosts|strict/)
})

test('ssh_sessions lists what ssh_connect created, and ssh_disconnect closes it', async () => {
  const h = harness()
  const connected = await callTool(h, 'ssh_connect', { host: 'h.example', user: 'deploy' })
  const listed = await callTool(h, 'ssh_sessions', {})
  assert.equal(listed.ok, true)
  assert.equal(listed.sessions.length, 1)
  assert.equal(listed.sessions[0].sessionId, connected.sessionId)
  assert.equal(listed.sessions[0].host, 'h.example')
  assert.equal(listed.sessions[0].user, 'deploy')

  const closed = await callTool(h, 'ssh_disconnect', { sessionId: connected.sessionId })
  assert.equal(closed.ok, true)
  assert.equal(closed.state, 'closed')
  assert.ok(h.closed.includes(connected.sessionId))
  assert.equal((await callTool(h, 'ssh_sessions', {})).sessions.length, 0)
})

test('ssh_sessions is usable before anything is connected', async () => {
  const h = harness()
  const result = await callTool(h, 'ssh_sessions', {})
  assert.equal(result.ok, true)
  assert.deepEqual(result.sessions, [])
  assert.match(result.notes.join(' '), /ssh_connect/)
})

test('ssh_disconnect without a sessionId lists the alternatives', async () => {
  const h = harness()
  await callTool(h, 'ssh_connect', { host: 'h.example' })
  const result = await callTool(h, 'ssh_disconnect', {})
  assert.equal(result.ok, false)
  assert.equal(result.code, 'SSH_CFG_INVALID')
  assert.match(result.notes.join(' '), /s_1/, 'the hint names the connected sessions')
})

// ---------------------------------------------------------------------------
// Mix-up diagnostics
// ---------------------------------------------------------------------------

test('sending testProfile\'s field name to connect names the mistake', async () => {
  const h = harness()
  const failure = await h.api.sessions.connect({ profileJson: JSON.stringify({ host: 'h.example' }) }).then(() => undefined, (error) => error)
  assert.equal(failure.code, 'SSH_CFG_INVALID')
  assert.match(failure.message, /inlineJson/, 'the message names the field the caller should have used')
  assert.match(failure.message, /testProfile/)
})

test('the endpoint still accepts a direct object from an in-process caller', async () => {
  const h = harness()
  const result = await h.api.sessions.connect({ inline: { host: 'direct.example', user: 'root' } })
  assert.equal(result.session.host, 'direct.example', 'a tool that passes the object directly keeps working')
})
