/**
 * §4.3 sessions and §4.4 commands/shells, through the real wire service.
 *
 * The two behaviours worth the most attention here are the ones a user would
 * experience as a mystery rather than an error:
 *
 *   - **A replay gap must be visible.** When `sinceSeq` reaches past the retained
 *     window, the client receives a terminal `SSH_LIMIT_OUTPUT_TRUNCATED` frame.
 *     Silently delivering fewer frames makes a reconnected terminal show garbled
 *     output with no way to tell why (ICD §3/§4.4).
 *   - **A host-key question parks the connect call** until `decideHostKey` answers
 *     it, and a decision made through that path is the only way an unknown or
 *     changed key can be accepted. A refusal must leave no session behind.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { createAuditor } from '../../lib/audit.js'
import { Config, resolveConfig } from '../../lib/config.js'
import { LocalApi } from '../../lib/api/local-api.js'
import { createRedactor, SECRET_MASK } from '../../lib/redact.js'
import { createProfileStore } from '../../lib/store.js'
import { createSessionRegistry } from '../../lib/sessions.js'
import { SshError } from '../../lib/protocol.js'
import { SshPluginService } from '../../lib/service.js'

const PASSWORD = 'hunter2!'
const root = mkdtempSync(join(tmpdir(), 'dsh-ssh-api-s-'))
after(() => rmSync(root, { recursive: true, force: true }))

let counter = 0
function harness(options = {}) {
  counter += 1
  const config = resolveConfig(Config({}), { DSH_HOME: join(root, `case-${counter}`) })
  const redactor = createRedactor({ redactKeys: config.logging.redactKeys, enabled: true })
  const logs = []
  const logger = { debug: () => {}, info: () => {}, warn: (m, f) => logs.push(`${m} ${JSON.stringify(f ?? {})}`), error: (m) => logs.push(m) }
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
  const exec = options.exec ?? fakeExec()
  const knownHosts = options.knownHosts ?? { verify: async (q) => ({ ok: true, knownHostsMatch: 'exact', fingerprint: 'SHA256:x', policy: q.policy }), remember: async (q) => { knownHosts.remembered.push(q) }, fingerprint: () => 'SHA256:x', remembered: [] }
  knownHosts.remembered = knownHosts.remembered ?? []

  const sessions = new Map()
  const acquired = []
  const pool = {
    async acquire(input) {
      acquired.push(input)
      // Faithful to SP1's pool: the handle's `info` projection is built from the
      // *resolved profile* plus the requested label, and registering it is what
      // makes the session visible to every list endpoint.
      const handle =
        options.onAcquire === undefined
          ? fakeSession(`s_${acquired.length}`, {
              info: {
                id: `s_${acquired.length}`,
                ...(input.profile.id === undefined ? {} : { profileId: input.profile.id }),
                label: input.label ?? input.profile.name,
                host: input.profile.host,
                port: input.profile.port,
                user: input.profile.user,
                state: 'connected',
                since: new Date().toISOString(),
                metrics: { bytesIn: 0, bytesOut: 0 },
                capabilities: { shell: true, sftp: true },
              },
            })
          : await options.onAcquire(input, acquired.length)
      sessions.set(handle.id, handle)
      registry.create(handle)
      return handle
    },
    get: (id) => sessions.get(id),
    list: () => [...sessions.values()],
    async disposeAll() {},
    size: sessions.size,
    pending: 0,
  }

  const credentials = {
    async resolve() { return undefined },
    async describe() { return { password: { present: false, source: 'none', masked: '' }, passphrase: { present: false, source: 'none', masked: '' } } },
    async set(ref, value) { credentials.stored.set(ref, value) },
    async unset(ref) { credentials.stored.delete(ref) },
    stored: new Map(),
  }
  const resolver = {
    async resolve(profile, oneShot) {
      const value = oneShot?.password ?? credentials.stored.get(profile.secretRefs?.password ?? '')
      return {
        ...(value === undefined ? {} : { password: value }),
        source: { password: value === undefined ? 'none' : oneShot?.password === undefined ? 'keychain' : 'profile', passphrase: 'none' },
        toJSON() { return { password: value === undefined ? undefined : SECRET_MASK } },
      }
    },
    async resolveProfile(profile, oneShot) { return { ...profile, secrets: await this.resolve(profile, oneShot) } },
    async describe() { return { password: { present: false, source: 'none', masked: '' }, passphrase: { present: false, source: 'none', masked: '' } } },
    async set(profileId, field, value, persist) {
      const profile = store.get(profileId)
      const ref = profile?.secretRefs?.[field] ?? `DSH_SSH_${String(profile?.name ?? 'P').toUpperCase()}_${field.toUpperCase()}`
      if (persist) { await credentials.set(ref, value); if (profile) await store.setSecretRef(profileId, field, ref); return { ref, persisted: true } }
      return { ref, persisted: false, reason: 'session-memory only' }
    },
    async clear() {},
    forgetAll() {},
  }

  const deps = {
    config, logger, redactor, store, credentials: resolver, knownHosts, audit, pool, registry, exec,
    transfers: { active: 0, async start() { return { streamId: 'st', opId: 'op', resumedFrom: 0 } }, async run() {}, cancel: () => false, list: () => [], dispose() {} },
    ...(options.lastHostKey === undefined ? {} : { lastHostKey: options.lastHostKey }),
    ...(options.lastFingerprint === undefined ? {} : { lastFingerprint: options.lastFingerprint }),
  }
  const api = new LocalApi(deps)
  const service = new SshPluginService({}, config, logger, { api })
  return { config, store, audit, registry, exec, pool, service, api, logs, acquired, knownHosts, sessions, credentials }
}

function fakeSession(id = 's_1', overrides = {}) {
  return {
    id,
    info: {
      id,
      label: id,
      host: 'h.example',
      port: 22,
      user: 'deploy',
      state: 'connected',
      since: new Date().toISOString(),
      metrics: { bytesIn: 0, bytesOut: 0 },
      capabilities: { shell: true, sftp: true },
    },
    state: 'connected',
    async exec() { throw new Error('not used') },
    async shell() { throw new Error('not used') },
    async sftp() { throw new Error('not used') },
    rttMs: () => 12,
    async close() { sessions_closed.push(id) },
    ...overrides,
  }
}
const sessions_closed = []

/** A fake ExecService whose frame timing the test controls. */
function fakeExec(options = {}) {
  const subscribers = new Map()
  const calls = { exec: [], openShell: [], write: [], resize: [], signal: [], close: 0, subscribes: [] }
  const makeFrames = (streamId) =>
    options.frames ?? [
      { t: 'open', streamId, kind: 'exec' },
      { t: 'data', streamId, seq: 0, chunk: 'hello\n', encoding: 'utf8', channel: 'stdout' },
      { t: 'data', streamId, seq: 1, chunk: 'oops\n', encoding: 'utf8', channel: 'stderr' },
      { t: 'exit', streamId, exitCode: 0, durationMs: 3, timedOut: false },
      { t: 'end', streamId, reason: 'completed' },
    ]
  return {
    calls,
    limits: { maxOutputBytes: 2048, operationTimeoutMs: 120000, graceKillMs: 3000 },
    exec(params, opts) {
      calls.exec.push({ params, opts })
      const streamId = options.streamId ?? 'st_exec'
      queueMicrotask(() => {
        for (const frame of makeFrames(streamId)) {
          for (const listener of [...(subscribers.get(streamId) ?? [])]) listener(frame)
        }
      })
      return { streamId, done: Promise.resolve({}) }
    },
    openShell(params) {
      calls.openShell.push(params)
      const streamId = 'st_shell'
      queueMicrotask(() => {
        for (const frame of makeFrames(streamId)) for (const listener of [...(subscribers.get(streamId) ?? [])]) listener(frame)
      })
      return { streamId, done: Promise.resolve({}) }
    },
    subscribe(streamId, onFrame, opts) {
      calls.subscribes.push({ streamId, opts })
      const set = subscribers.get(streamId) ?? new Set()
      set.add(onFrame)
      subscribers.set(streamId, set)
      return { unsubscribe: () => set.delete(onFrame), replayed: 0, gap: options.gap === true, finished: false }
    },
    async execWait(params, opts) {
      calls.exec.push({ params, opts, wait: true })
      if (options.execWaitError !== undefined) throw options.execWaitError
      return (
        options.execWaitResult ?? {
          streamId: 'st_wait',
          exitCode: 0,
          stdout: 'ok\n',
          stderr: '',
          truncated: { stdout: false, stderr: false },
          durationMs: 7,
          timedOut: false,
          endReason: 'completed',
          bytes: { stdout: 3, stderr: 0 },
        }
      )
    },
    shellWrite(params) { calls.write.push(params); return { written: params.data.length } },
    shellResize(params) { calls.resize.push(params); return { resized: true } },
    shellSignal(params) { calls.signal.push(params); return { sent: true } },
    shellClose(params) { calls.close += 1; return { closed: true } },
    listStreams(params) { return { streams: [{ streamId: 'st_exec', kind: 'exec', startedAt: new Date().toISOString(), alive: true }] } },
    dispose() {},
  }
}

/** Collect a stream endpoint's frames. */
async function collect(iterable) {
  const frames = []
  for await (const frame of iterable) frames.push(frame)
  return frames
}

/** Read a file that may legitimately not exist yet (nothing was persisted). */
function readTextIfAny(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// §4.3 sessions
// ---------------------------------------------------------------------------

test('connect by profileId registers a session and audits it', async () => {
  const h = harness()
  const saved = await h.service.saveProfile(JSON.stringify({ profile: { name: 'prod', host: 'h.example', user: 'deploy' } }))
  const result = await h.service.connect(JSON.stringify({ profileId: saved.profile.id, name: 'prod session' }))
  assert.equal(result.session.state, 'connected')
  assert.equal(result.session.host, 'h.example')
  assert.equal(h.registry.list().length, 1)
  // The label reaches the pool, which owns the projection the registry stores.
  assert.equal(h.acquired[0].label, 'prod session')
  assert.equal(JSON.stringify(result).includes('password'), false)
  const entries = await h.audit.query({ kinds: ['connect'] })
  assert.equal(entries.total, 1)
  assert.equal(entries.entries[0].target.host, 'h.example')
})

test('an inline connection is validated like a stored one and is not persisted', async () => {
  const h = harness()
  const result = await h.service.connect(JSON.stringify({ inline: { host: 'inline.example', user: 'root', port: 2222 } }))
  assert.equal(result.session.host, 'inline.example')
  assert.equal(result.session.port, 2222)
  assert.equal(h.store.list().length, 0, 'connect must not save a profile the user did not ask to keep')
})

test('an inline plaintext password travels as a one-shot secret only', async () => {
  const h = harness()
  const result = await h.service.connect(JSON.stringify({ inline: { host: 'inline.example', user: 'root', auth: 'password' }, secrets: { password: PASSWORD } }))
  assert.equal(result.session.host, 'inline.example')
  assert.equal(h.store.list().length, 0)
  // Nothing was saved, so the profile file does not even exist — which is itself
  // the strongest form of "the plaintext was not persisted".
  assert.equal(readTextIfAny(h.config.profilesFile).includes(PASSWORD), false)
  assert.equal(readTextIfAny(h.config.auditFile).includes(PASSWORD), false, 'the audit never carries the value')
  assert.equal(JSON.stringify(result).includes(PASSWORD), false, 'the result never carries the value')
})

test('connect refuses profileId and inline together, and neither given', async () => {
  const h = harness()
  const both = await h.service.connect(JSON.stringify({ profileId: 'p_x', inline: { host: 'h' } })).then(() => undefined, (e) => e)
  assert.equal(both.code, 'SSH_CFG_INVALID')
  const neither = await h.service.connect('{}').then(() => undefined, (e) => e)
  assert.equal(neither.code, 'SSH_CFG_INVALID')
})

test('connect maps a connection failure to its structured code', async () => {
  const h = harness({ onAcquire: async () => { throw new SshError('SSH_NET_DNS', 'name resolution failed') } })
  const failure = await h.service.connect(JSON.stringify({ inline: { host: 'nope.invalid' } })).then(() => undefined, (e) => e)
  assert.equal(failure.code, 'SSH_NET_DNS')
  assert.equal(failure.retryable, false)
  const entries = await h.audit.query({})
  assert.equal(entries.entries[0].outcome, 'error')
})

test('listSessions and getSession read the registry projection', async () => {
  const h = harness()
  await h.service.connect(JSON.stringify({ inline: { host: 'h.example' } }))
  const list = await h.service.listSessions()
  assert.equal(list.sessions.length, 1)
  const id = list.sessions[0].id
  const one = await h.service.getSession(JSON.stringify({ sessionId: id }))
  assert.equal(one.session.id, id)
  const unknown = await h.service.getSession(JSON.stringify({ sessionId: 's_nope' })).then(() => undefined, (e) => e)
  assert.equal(unknown.code, 'SSH_STATE_INVALID')
})

test('disconnect closes the session and reports it closed', async () => {
  const h = harness()
  const connected = await h.service.connect(JSON.stringify({ inline: { host: 'h.example' } }))
  const closed = await h.service.disconnect(JSON.stringify({ sessionId: connected.session.id }))
  assert.equal(closed.session.state, 'closed')
  assert.ok(sessions_closed.includes(connected.session.id))
  const unknown = await h.service.disconnect(JSON.stringify({ sessionId: 's_nope' })).then(() => undefined, (e) => e)
  assert.equal(unknown.code, 'SSH_STATE_INVALID')
})

test('followSessions starts with a snapshot and then reports changes', async () => {
  const h = harness()
  await h.service.connect(JSON.stringify({ inline: { host: 'h.example' } }))
  const frames = []
  const iterator = h.service.followSessions('{}')[Symbol.asyncIterator]()
  const first = await iterator.next()
  frames.push(first.value)
  assert.equal(first.value.t, 'state')
  await iterator.return()
  assert.equal(frames[0].sessionId, h.registry.list()[0].id)
})

test('a host-key question parks the connect until decideHostKey answers', async () => {
  const h = harness({
    lastHostKey: () => ({ keyType: 'ssh-ed25519', key: Buffer.from('key-material'), fingerprint: 'SHA256:changed', knownHostsMatch: 'changed' }),
    onAcquire: async (input) => {
      const answer = await input.onHostKeyPrompt({
        host: 'h.example',
        port: 22,
        keyType: 'ssh-ed25519',
        fingerprint: 'SHA256:changed',
        knownHostsMatch: 'changed',
      })
      if (answer !== 'accept') throw new SshError('SSH_HOSTKEY_MISMATCH', 'the host key was not accepted')
      return fakeSession('s_after_prompt')
    },
  })
  const pending = h.service.connect(JSON.stringify({ inline: { host: 'h.example' } }))
  // Let the prompt register before the user answers it.
  await new Promise((resolve) => setTimeout(resolve, 5))
  const questions = await h.service.pendingHostKey('{}')
  assert.equal(questions.pending.length, 1)
  assert.equal(questions.pending[0].fingerprint, 'SHA256:changed')
  assert.equal(questions.pending[0].knownHostsMatch, 'changed')
  assert.equal(questions.pending[0].host, 'h.example')

  const decided = await h.service.decideHostKey(
    JSON.stringify({ sessionId: questions.pending[0].sessionId, accept: true, remember: true }),
  )
  assert.deepEqual(decided, { decided: true })
  const connected = await pending
  assert.equal(connected.session.id, 's_after_prompt')
  assert.equal((await h.service.pendingHostKey('{}')).pending.length, 0)
  assert.equal(h.knownHosts.remembered.length, 1, 'an accepted key with remember:true is written to known_hosts')
  assert.equal(h.knownHosts.remembered[0].key.toString(), 'key-material')
})

test('rejecting a host-key question fails the connect with the host-key code', async () => {
  const h = harness({
    onAcquire: async (input) => {
      const answer = await input.onHostKeyPrompt({ host: 'h.example', port: 22, keyType: 'ssh-ed25519', fingerprint: 'SHA256:new', knownHostsMatch: 'unknown' })
      if (answer !== 'accept') throw new SshError('SSH_HOSTKEY_UNKNOWN', 'the host key was not accepted')
      return fakeSession()
    },
  })
  const pending = h.service.connect(JSON.stringify({ inline: { host: 'h.example' } }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  const questions = await h.service.pendingHostKey('{}')
  await h.service.decideHostKey(JSON.stringify({ sessionId: questions.pending[0].sessionId, accept: false }))
  const failure = await pending.then(() => undefined, (e) => e)
  assert.equal(failure.code, 'SSH_HOSTKEY_UNKNOWN')
  assert.equal(h.registry.list().length, 0, 'a refused key leaves no session behind')
  assert.equal((await h.audit.query({ kinds: ['decideHostKey'] })).entries[0].outcome, 'denied')
})

test('deciding an unknown question is SSH_STATE_INVALID', async () => {
  const h = harness()
  const failure = await h.service.decideHostKey(JSON.stringify({ sessionId: 'connect_9#1', accept: true })).then(() => undefined, (e) => e)
  assert.equal(failure.code, 'SSH_STATE_INVALID')
})

// ---------------------------------------------------------------------------
// §4.4 exec / shell
// ---------------------------------------------------------------------------

test('exec streams open → data → exit → end in order', async () => {
  const h = harness()
  await h.service.connect(JSON.stringify({ inline: { host: 'h.example' } }))
  const sessionId = h.registry.list()[0].id
  const frames = await collect(h.service.exec(JSON.stringify({ sessionId, command: 'uname -a' })))
  assert.deepEqual(frames.map((frame) => frame.t), ['open', 'data', 'data', 'exit', 'end'])
  assert.deepEqual(frames.filter((f) => f.t === 'data').map((f) => f.seq), [0, 1])
  assert.equal(frames.filter((f) => f.t === 'end').length, 1)
  assert.equal(frames[1].channel, 'stdout')
  assert.equal(h.exec.calls.exec[0].params.command, 'uname -a')
  assert.deepEqual(h.exec.calls.subscribes[0].opts, {}, 'a fresh subscription carries no sinceSeq')
})

test('a replay gap becomes an explicit terminal error, never a silent short stream', async () => {
  const h = harness({ exec: fakeExec({ gap: true, frames: [] }) })
  await h.service.connect(JSON.stringify({ inline: { host: 'h.example' } }))
  const sessionId = h.registry.list()[0].id
  const frames = await collect(h.service.exec(JSON.stringify({ sessionId, command: 'x', sinceSeq: 999 })))
  assert.equal(frames.length, 1)
  assert.equal(frames[0].t, 'end')
  assert.equal(frames[0].reason, 'error')
  assert.equal(frames[0].error.code, 'SSH_LIMIT_OUTPUT_TRUNCATED', 'the client must be able to tell truncation from completion')
  assert.deepEqual(h.exec.calls.subscribes[0].opts, { sinceSeq: 999 })
})

test('exec passes PTY parameters through (ICD v1.0.9)', async () => {
  const h = harness()
  await h.service.connect(JSON.stringify({ inline: { host: 'h.example' } }))
  const sessionId = h.registry.list()[0].id
  await collect(h.service.exec(JSON.stringify({ sessionId, command: 'top', pty: true, cols: 120, rows: 40, term: 'xterm-256color' })))
  const call = h.exec.calls.exec[0]
  assert.equal(call.opts.pty, true)
  assert.equal(call.opts.cols, 120)
  assert.equal(call.opts.rows, 40)
  assert.equal(call.opts.term, 'xterm-256color')
})

test('exec refuses an empty command and an unknown session before opening a channel', async () => {
  const h = harness()
  const empty = await collect(h.service.exec(JSON.stringify({ sessionId: 's_1', command: '   ' }))).then(() => undefined, (e) => e)
  assert.equal(empty.code, 'SSH_CFG_INVALID')
  const unknown = await collect(h.service.exec(JSON.stringify({ sessionId: 's_nope', command: 'ls' }))).then(() => undefined, (e) => e)
  assert.equal(unknown.code, 'SSH_STATE_INVALID')
  assert.equal(h.exec.calls.exec.length, 0, 'no channel is opened for an invalid call')
})

test('execWait projects the result and reports timeout/truncation as data', async () => {
  const h = harness({
    exec: fakeExec({
      execWaitResult: {
        streamId: 'st_t',
        exitCode: null,
        stdout: 'partial',
        stderr: '',
        truncated: { stdout: true, stderr: false },
        durationMs: 120000,
        timedOut: true,
        endReason: 'timeout',
        bytes: { stdout: 900000, stderr: 0 },
      },
    }),
  })
  await h.service.connect(JSON.stringify({ inline: { host: 'h.example' } }))
  const sessionId = h.registry.list()[0].id
  const result = await h.service.execWait(JSON.stringify({ sessionId, command: 'sleep 30' }))
  assert.equal(result.timedOut, true)
  assert.equal(result.truncated.stdout, true)
  assert.equal(result.exitCode, null)
  assert.equal(result.stdout, 'partial')
  assert.equal(JSON.stringify(result).includes(PASSWORD), false)
})

test('execWait rejects a real failure with its code', async () => {
  const h = harness({ exec: fakeExec({ execWaitError: new SshError('SSH_STATE_INVALID', 'session is closed') }) })
  await h.service.connect(JSON.stringify({ inline: { host: 'h.example' } }))
  const sessionId = h.registry.list()[0].id
  const failure = await h.service.execWait(JSON.stringify({ sessionId, command: 'ls' })).then(() => undefined, (e) => e)
  assert.equal(failure.code, 'SSH_STATE_INVALID')
})

test('openShell streams a PTY and the shell controls route to the stream', async () => {
  const h = harness()
  await h.service.connect(JSON.stringify({ inline: { host: 'h.example' } }))
  const sessionId = h.registry.list()[0].id
  const frames = await collect(h.service.openShell(JSON.stringify({ sessionId, cols: 100, rows: 30 })))
  assert.equal(frames[0].t, 'open')
  assert.equal(h.exec.calls.openShell[0].cols, 100)
  assert.equal(h.exec.calls.openShell[0].rows, 30)

  assert.deepEqual(await h.service.shellWrite(JSON.stringify({ streamId: 'st_shell', data: 'ls\n' })), { written: 3 })
  assert.deepEqual(await h.service.shellResize(JSON.stringify({ streamId: 'st_shell', cols: 120, rows: 40 })), { resized: true })
  assert.deepEqual(await h.service.shellSignal(JSON.stringify({ streamId: 'st_shell', signal: 'INT' })), { sent: true })
  assert.deepEqual(await h.service.shellClose(JSON.stringify({ streamId: 'st_shell' })), { closed: true })
})

test('shellSignal accepts only the frozen signal set', async () => {
  const h = harness()
  const failure = await h.service.shellSignal(JSON.stringify({ streamId: 'st_x', signal: 'SIGKILL' })).then(() => undefined, (e) => e)
  assert.equal(failure.code, 'SSH_CFG_INVALID')
  assert.match(failure.message, /signal must be one of INT/)
})

test('listStreams answers for a live session and refuses a dead one', async () => {
  const h = harness()
  await h.service.connect(JSON.stringify({ inline: { host: 'h.example' } }))
  const sessionId = h.registry.list()[0].id
  const streams = await h.service.listStreams(JSON.stringify({ sessionId }))
  assert.equal(streams.streams.length, 1)
  assert.equal(streams.streams[0].alive, true)
  const unknown = await h.service.listStreams(JSON.stringify({ sessionId: 's_gone' })).then(() => undefined, (e) => e)
  assert.equal(unknown.code, 'SSH_STATE_INVALID')
})

test('the concurrency gate refuses an over-limit operation with SSH_LIMIT_QUEUE_FULL', async () => {
  const h = harness()
  await h.service.connect(JSON.stringify({ inline: { host: 'h.example' } }))
  const sessionId = h.registry.list()[0].id
  // Hold every slot the registry allows, then attempt one more.
  const held = []
  for (let index = 0; index < 4; index += 1) {
    held.push(h.registry.run(sessionId, 'hold', async () => new Promise((resolve) => setTimeout(resolve, 50))))
  }
  const failure = await collect(h.service.exec(JSON.stringify({ sessionId, command: 'ls' }))).then(() => undefined, (e) => e)
  assert.equal(failure.code, 'SSH_LIMIT_QUEUE_FULL')
  assert.equal(failure.retryable, true)
  await Promise.allSettled(held)
})
