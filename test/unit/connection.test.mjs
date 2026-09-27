/**
 * Connection layer against a **real protocol-level sshd** (`ssh2.Server`).
 *
 * These tests exercise the parts a fake client cannot prove: the actual
 * handshake, password/public-key authentication, PTY allocation, channel data
 * and exit status, SFTP subsystem negotiation, and graceful shutdown.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createConnectionPool, isExecHandle, profileKey, scanForSecrets, validateProfile } from '../../lib/connection/index.js'
import { SshError } from '../../lib/protocol.js'
import {
  CLIENT_KEY,
  CLIENT_KEY_ENCRYPTED,
  fakeKnownHosts,
  makeConfig,
  makeProfile,
  makeTarget,
  memoryLogger,
  startSshServer,
  startSilentTcpServer,
  stateRecorder,
  trackingRedactor,
} from './connection-fixture.test.mjs'

const PASSWORD = 'sup3r-secret-pw'
const PASSPHRASE = 'key-pass'

/** Build a pool + profile pointed at a fresh server; registers cleanup. */
async function harness(t, options = {}) {
  const server = options.server ?? (await startSshServer(options.serverOptions ?? {}))
  const ownsServer = options.server === undefined
  const logger = options.logger ?? memoryLogger()
  const redactor = options.redactor ?? trackingRedactor()
  const config = makeConfig({ ...(options.config ?? {}), ...(options.maxSessions === undefined ? {} : { maxSessions: options.maxSessions }) })
  const pool = createConnectionPool({
    config,
    logger,
    redactor,
    ...(options.knownHosts === undefined ? {} : { knownHosts: options.knownHosts }),
    ...(options.sftp === undefined ? {} : { sftp: options.sftp }),
    ...(options.createClient === undefined ? {} : { createClient: options.createClient }),
    env: {},
    platform: 'linux',
    random: () => 0.5,
    sleep: async () => {},
  })
  const profile = makeTarget(server, options.profile ?? {})
  t.after(async () => {
    await pool.disposeAll('test teardown')
    if (ownsServer) await server.close()
  })
  return { server, pool, profile, logger, redactor, config }
}

test('connects with password auth and projects a connected session', async (t) => {
  const { pool, profile, server } = await harness(t, {
    serverOptions: { password: PASSWORD },
    profile: { secrets: { password: PASSWORD } },
  })
  const recorder = stateRecorder()
  const session = await pool.acquire({ profile, label: 'prod-1', onStateChange: recorder.next })

  assert.equal(session.state, 'connected')
  assert.equal(session.id.startsWith('s_'), true)
  assert.equal(session.info.label, 'prod-1')
  assert.equal(session.info.host, server.host)
  assert.equal(session.info.port, server.port)
  assert.equal(session.info.user, 'tester')
  assert.equal(session.info.profileId, 'p_test')
  assert.equal(session.info.capabilities.shell, true)
  assert.equal(session.info.metrics.bytesIn, 0)
  assert.equal(session.info.metrics.bytesOut, 0)
  assert.equal(typeof session.info.metrics.connectMs, 'number')
  assert.ok(session.info.metrics.connectMs >= 0)
  assert.equal(session.info.metrics.rttMs, undefined)
  assert.equal(session.rttMs(), undefined)
  assert.equal(pool.size, 1)
  assert.equal(pool.pending, 0)
  assert.deepEqual(recorder.states, ['connecting', 'authenticating', 'connected'])
  // ssh2 always probes with `none` first to learn the server's method list.
  assert.deepEqual(
    server.state.authAttempts.map((attempt) => attempt.method),
    ['none', 'password'],
  )
  assert.equal(server.state.connections, 1)
})

test('reuses the live session for the same profile (one TCP connection)', async (t) => {
  const { pool, profile, server } = await harness(t, {
    serverOptions: { password: PASSWORD },
    profile: { secrets: { password: PASSWORD } },
  })
  const first = await pool.acquire({ profile })
  const second = await pool.acquire({ profile })
  assert.equal(first.id, second.id)
  assert.equal(pool.size, 1)
  assert.equal(server.state.connections, 1)
})

test('concurrent acquires for one profile share a single dial (single flight)', async (t) => {
  const { pool, profile, server } = await harness(t, {
    serverOptions: { password: PASSWORD },
    profile: { secrets: { password: PASSWORD } },
  })
  const [a, b, c] = await Promise.all([pool.acquire({ profile }), pool.acquire({ profile }), pool.acquire({ profile })])
  assert.equal(a.id, b.id)
  assert.equal(b.id, c.id)
  assert.equal(server.state.connections, 1)
  assert.equal(pool.size, 1)
})

test('forceNew opens an independent connection', async (t) => {
  const { pool, profile, server } = await harness(t, {
    serverOptions: { password: PASSWORD },
    profile: { secrets: { password: PASSWORD } },
  })
  const first = await pool.acquire({ profile })
  const second = await pool.acquire({ profile, forceNew: true })
  assert.notEqual(first.id, second.id)
  assert.equal(pool.size, 2)
  assert.equal(server.state.connections, 2)
  assert.equal(pool.get(first.id)?.id, first.id)
  assert.equal(pool.list().length, 2)
})

test('refuses to exceed maxSessions with SSH_LIMIT_POOL_EXHAUSTED', async (t) => {
  const { pool, profile } = await harness(t, {
    serverOptions: { password: PASSWORD },
    profile: { secrets: { password: PASSWORD } },
    maxSessions: 1,
  })
  await pool.acquire({ profile })
  await assert.rejects(
    () => pool.acquire({ profile, forceNew: true }),
    (error) => {
      assert.ok(error instanceof SshError)
      assert.equal(error.code, 'SSH_LIMIT_POOL_EXHAUSTED')
      assert.equal(error.retryable, true)
      assert.equal(error.details.limit, 1)
      return true
    },
  )
})

test('exec streams stdout/stderr, reports the exit code and counts bytes', async (t) => {
  const { pool, profile } = await harness(t, {
    serverOptions: { password: PASSWORD, execStdout: 'hello\n', execStderr: 'oops\n', execExitCode: 7 },
    profile: { secrets: { password: PASSWORD } },
  })
  const session = await pool.acquire({ profile })
  const handle = await session.exec({ command: 'echo hello' })
  assert.equal(handle.streamId.startsWith('st_'), true)
  // The returned object exposes the complete frozen `ExecHandle` surface.
  assert.equal(isExecHandle(handle), true)

  const chunks = []
  handle.onData((channel, chunk) => chunks.push({ channel, text: chunk.toString() }))
  const exit = await new Promise((resolve) => handle.onExit(resolve))

  assert.deepEqual(
    chunks.map((c) => [c.channel, c.text]).sort(),
    [
      ['stderr', 'oops\n'],
      ['stdout', 'hello\n'],
    ],
  )
  assert.equal(exit.code, 7)
  assert.equal(exit.timedOut, false)
  assert.equal(typeof exit.durationMs, 'number')
  assert.ok(session.info.metrics.bytesIn >= 'hello\noops\n'.length)
  assert.ok(session.info.metrics.rttMs !== undefined, 'opening a channel produces an RTT sample')
})

test('exec applies cwd and env as a POSIX command prefix', async (t) => {
  const { pool, profile, server } = await harness(t, {
    serverOptions: { password: PASSWORD },
    profile: { secrets: { password: PASSWORD }, defaultEnv: { BASE: '1' } },
  })
  const session = await pool.acquire({ profile })
  const handle = await session.exec({ command: 'echo hi', cwd: '/tmp/x y', env: { FOO: "it's" } })
  await new Promise((resolve) => handle.onExit(resolve))

  assert.equal(server.state.execCommands.length, 1)
  assert.equal(server.state.execCommands[0], `cd -- '/tmp/x y' && BASE='1' FOO='it'\\''s' echo hi`)
})

test('endInput sends EOF and later writes are rejected', async (t) => {
  const { pool, profile } = await harness(t, {
    serverOptions: { password: PASSWORD, holdExecOpen: true },
    profile: { secrets: { password: PASSWORD } },
  })
  const session = await pool.acquire({ profile })
  const handle = await session.exec({ command: 'cat' })
  handle.write('first\n')
  handle.endInput()
  assert.throws(
    () => handle.write('second\n'),
    (error) => error instanceof SshError && error.code === 'SSH_STATE_INVALID',
  )
  handle.cancel()
  const exit = await new Promise((resolve) => handle.onExit(resolve))
  assert.equal(exit.timedOut, false)
})

test('shell allocates a PTY, resizes, writes and signals', async (t) => {
  const { pool, profile, server } = await harness(t, {
    serverOptions: { password: PASSWORD },
    profile: { secrets: { password: PASSWORD } },
  })
  const session = await pool.acquire({ profile })
  const handle = await session.shell({ cols: 100, rows: 40, term: 'xterm-256color' })
  assert.equal(typeof handle.resize, 'function')
  assert.equal(isExecHandle(handle), true, 'ShellHandle extends ExecHandle')

  const output = []
  handle.onData((channel, chunk) => output.push({ channel, text: chunk.toString() }))
  handle.resize(120, 30)
  handle.write('echo ping\n')
  handle.signal('TERM')

  await waitFor(() => output.some((entry) => entry.text.includes('echo ping')) && server.state.signals.includes('TERM'))
  assert.equal(server.state.ptyInfo.cols, 100)
  assert.equal(server.state.ptyInfo.rows, 40)
  assert.equal(server.state.ptyInfo.term, 'xterm-256color')
  assert.deepEqual(server.state.windowChanges.at(-1), { cols: 120, rows: 30 })
  assert.equal(output[0].channel, 'stdout')
  assert.ok(server.state.shellInput.join('').includes('echo ping'))

  const exit = new Promise((resolve) => handle.onExit(resolve))
  handle.cancel()
  await exit
})

test('opens the SFTP subsystem lazily and hands over the raw ssh2 wrapper', async (t) => {
  const { pool, profile, server } = await harness(t, {
    serverOptions: { password: PASSWORD },
    profile: { secrets: { password: PASSWORD } },
  })
  const session = await pool.acquire({ profile })
  assert.equal(server.state.sftpOpened, false, 'the subsystem is created on first use')

  const wrapper = await session.openSftpChannel()
  assert.equal(typeof wrapper.createReadStream, 'function')
  assert.equal(typeof wrapper.createWriteStream, 'function')
  // Identity proves nothing in this plugin wrapped the subsystem: SP3's adapter
  // must be able to forward `opts` (including `start`) to createWriteStream.
  assert.equal(await session.openSftpChannel(), wrapper)
  assert.equal(server.state.sftpOpened, true)
})

test('sftp() without an injected adapter reports SSH_SFTP_PROTOCOL', async (t) => {
  const { pool, profile } = await harness(t, {
    serverOptions: { password: PASSWORD },
    profile: { secrets: { password: PASSWORD } },
  })
  const session = await pool.acquire({ profile })
  await assert.rejects(
    () => session.sftp(),
    (error) => error instanceof SshError && error.code === 'SSH_SFTP_PROTOCOL',
  )
})

test('private key auth works from an inline key and from an encrypted key file', async (t) => {
  const { pool, profile } = await harness(t, {
    serverOptions: { password: null },
    profile: { auth: 'privateKey', secrets: { privateKey: CLIENT_KEY.private } },
  })
  const session = await pool.acquire({ profile })
  assert.equal(session.state, 'connected')

  const server2 = await startSshServer({ password: null })
  t.after(() => server2.close())
  const profile2 = makeTarget(server2, {
    auth: 'privateKey',
    secrets: { privateKey: CLIENT_KEY_ENCRYPTED.private, passphrase: PASSPHRASE },
  })
  const session2 = await pool.acquire({ profile: profile2, forceNew: true })
  assert.equal(session2.state, 'connected')
})

test('password auth failure maps to SSH_AUTH_FAILED and leaks no credential', async (t) => {
  const logger = memoryLogger()
  const { pool, profile } = await harness(t, {
    serverOptions: { password: 'the-right-one' },
    profile: { secrets: { password: PASSWORD } },
    logger,
  })
  await assert.rejects(
    () => pool.acquire({ profile }),
    (error) => {
      assert.ok(error instanceof SshError)
      assert.equal(error.code, 'SSH_AUTH_FAILED')
      assert.equal(error.retryable, false)
      const serialised = JSON.stringify(error.toErrorInfo())
      assert.equal(serialised.includes(PASSWORD), false, 'error must not carry the password')
      return true
    },
  )
  assert.equal(logger.text().includes(PASSWORD), false, 'logs must not carry the password')
  assert.equal(pool.size, 0)
  assert.equal(pool.pending, 0)
})

test('a missing credential is reported before any TCP connection is made', async (t) => {
  const { pool, profile, server } = await harness(t, {
    serverOptions: { password: PASSWORD },
    profile: { secrets: {} },
  })
  await assert.rejects(
    () => pool.acquire({ profile }),
    (error) => error instanceof SshError && error.code === 'SSH_CFG_INVALID' && error.details.field === 'password',
  )
  assert.equal(server.state.connections, 0)
})

test('strict host key policy refuses an unknown host', async (t) => {
  const { pool, profile } = await harness(t, {
    serverOptions: { password: PASSWORD },
    profile: { secrets: { password: PASSWORD }, hostKeyPolicy: 'strict' },
  })
  await assert.rejects(
    () => pool.acquire({ profile }),
    (error) => error instanceof SshError && error.code === 'SSH_HOSTKEY_UNKNOWN',
  )
})

test('accept-new asks before trusting a changed key and remembers a new one', async (t) => {
  const knownHosts = fakeKnownHosts({
    ok: false,
    code: 'SSH_HOSTKEY_UNKNOWN',
    fingerprint: 'SHA256:abc',
    knownHostsMatch: 'unknown',
  })
  const prompts = []
  const { pool, profile } = await harness(t, {
    serverOptions: { password: PASSWORD },
    profile: { secrets: { password: PASSWORD }, hostKeyPolicy: 'accept-new' },
    knownHosts,
  })
  const session = await pool.acquire({
    profile,
    onHostKeyPrompt: async (question) => {
      prompts.push(question)
      return 'accept'
    },
  })
  assert.equal(session.state, 'connected')
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].fingerprint, 'SHA256:abc')
  assert.equal(prompts[0].knownHostsMatch, 'unknown')
  assert.equal(knownHosts.calls.remember.length, 1)
  assert.equal(session.hostKeyFingerprint, 'SHA256:abc')
})

test('a rejected host key aborts with SSH_HOSTKEY_MISMATCH', async (t) => {
  const knownHosts = fakeKnownHosts({
    ok: false,
    code: 'SSH_HOSTKEY_MISMATCH',
    fingerprint: 'SHA256:changed',
    knownHostsMatch: 'changed',
  })
  const { pool, profile } = await harness(t, {
    serverOptions: { password: PASSWORD },
    profile: { secrets: { password: PASSWORD }, hostKeyPolicy: 'accept-new' },
    knownHosts,
  })
  await assert.rejects(
    () =>
      pool.acquire({
        profile,
        onHostKeyPrompt: async () => 'reject',
      }),
    (error) => error instanceof SshError && error.code === 'SSH_HOSTKEY_MISMATCH',
  )
  assert.equal(knownHosts.calls.remember.length, 0)
})

test('a mismatch without a prompt handler fails closed', async (t) => {
  const knownHosts = fakeKnownHosts({
    ok: false,
    code: 'SSH_HOSTKEY_MISMATCH',
    fingerprint: 'SHA256:changed',
    knownHostsMatch: 'changed',
  })
  const { pool, profile } = await harness(t, {
    serverOptions: { password: PASSWORD },
    profile: { secrets: { password: PASSWORD } },
    knownHosts,
  })
  await assert.rejects(
    () => pool.acquire({ profile }),
    (error) => error instanceof SshError && error.code === 'SSH_HOSTKEY_MISMATCH',
  )
})

test('host key verification is skipped for the configured acceptor', async (t) => {
  const knownHosts = fakeKnownHosts({ ok: true })
  const { pool, profile } = await harness(t, {
    serverOptions: { password: PASSWORD },
    profile: { secrets: { password: PASSWORD }, hostKeyPolicy: 'insecure' },
    knownHosts,
  })
  const session = await pool.acquire({ profile })
  assert.equal(session.state, 'connected')
  assert.equal(knownHosts.calls.verify.length, 0)
})

test('connect timeout maps to SSH_TIMEOUT_CONNECT', async (t) => {
  const silent = await startSilentTcpServer()
  t.after(() => silent.close())
  const { pool, profile } = await harness(t, {
    server: { host: silent.host, port: silent.port },
    profile: { secrets: { password: PASSWORD }, connectTimeoutMs: 400, retries: { max: 0 } },
  })
  const started = Date.now()
  await assert.rejects(
    () => pool.acquire({ profile }),
    (error) => error instanceof SshError && error.code === 'SSH_TIMEOUT_CONNECT',
  )
  assert.ok(Date.now() - started < 8000, 'the timeout must come from connectTimeoutMs')
})

test('close() releases the pool slot and reports the closed state', async (t) => {
  const { pool, profile, server } = await harness(t, {
    serverOptions: { password: PASSWORD },
    profile: { secrets: { password: PASSWORD } },
  })
  const session = await pool.acquire({ profile })
  const recorder = stateRecorder()
  await session.close({ reason: 'user asked' })
  assert.equal(session.state, 'closed')
  assert.equal(pool.get(session.id), undefined)
  assert.equal(pool.size, 0)
  void recorder
  assert.equal(server.state.connections, 1)
})

test('disposeAll closes every session', async (t) => {
  const { pool, profile } = await harness(t, {
    serverOptions: { password: PASSWORD },
    profile: { secrets: { password: PASSWORD } },
  })
  const a = await pool.acquire({ profile })
  const b = await pool.acquire({ profile, forceNew: true })
  assert.equal(pool.size, 2)
  await pool.disposeAll('plugin unload')
  assert.equal(pool.size, 0)
  assert.equal(a.state, 'closed')
  assert.equal(b.state, 'closed')
  await assert.rejects(
    () => pool.acquire({ profile }),
    (error) => error instanceof SshError && error.code === 'SSH_STATE_INVALID',
  )
})

test('exec/sftp on a non-connected session raise SSH_STATE_INVALID', async (t) => {
  const { pool, profile } = await harness(t, {
    serverOptions: { password: PASSWORD },
    profile: { secrets: { password: PASSWORD } },
  })
  const session = await pool.acquire({ profile })
  await session.close()
  await assert.rejects(
    () => session.exec({ command: 'true' }),
    (error) => error instanceof SshError && error.code === 'SSH_STATE_INVALID',
  )
  await assert.rejects(
    () => session.sftp(),
    (error) => error instanceof SshError && error.code === 'SSH_STATE_INVALID',
  )
})

test('the server banner is captured on the session', async (t) => {
  const { pool, profile } = await harness(t, {
    serverOptions: { password: PASSWORD, banner: 'dsh-ssh test server' },
    profile: { secrets: { password: PASSWORD } },
  })
  const session = await pool.acquire({ profile })
  assert.equal(session.banner, 'dsh-ssh test server')
})

test('SessionInfo is free of credentials', async (t) => {
  const redactor = trackingRedactor()
  const { pool, profile } = await harness(t, {
    serverOptions: { password: PASSWORD },
    profile: { secrets: { password: PASSWORD } },
    redactor,
  })
  const session = await pool.acquire({ profile })
  const serialised = JSON.stringify(session.info)
  assert.equal(serialised.includes(PASSWORD), false)
  assert.equal(scanForSecrets(session.info, [PASSWORD]).length, 0)
  assert.equal(redactor.trackedCount(), 1, 'the plaintext must be tracked for scrubbing')
})

test('profileKey and validateProfile enforce the documented rules', () => {
  assert.equal(profileKey({ id: 'p_1', user: 'u', host: 'h', port: 22, auth: 'password' }), 'p_1')
  assert.equal(profileKey({ id: '', user: 'u', host: 'h', port: 22, auth: 'agent' }), 'u@h:22#agent')
  assert.throws(
    () => validateProfile(makeProfile({ port: 0 })),
    (error) => error instanceof SshError && error.code === 'SSH_CFG_INVALID' && error.details.fields.includes('port'),
  )
  assert.throws(
    () => validateProfile(makeProfile({ host: '  ' })),
    (error) => error instanceof SshError && error.code === 'SSH_CFG_INVALID',
  )
})

test('the SFTP provider receives the raw, unwrapped subsystem object', async (t) => {
  // The provider receives the connection source, and `openSftpChannel()` must
  // yield the unwrapped subsystem object: SP3's adapter forwards the caller's
  // `opts` (including `start`) straight to `createWriteStream` (ICD v1.0.3).
  const seen = []
  const provider = async (source) => {
    const wrapper = await source.openSftpChannel()
    seen.push(wrapper)
    return {
      handle: source.handle,
      wrapper,
      listDir: async () => [],
      stat: async () => ({}),
      mkdir: async () => {},
      rename: async () => {},
      remove: async () => 0,
      chmod: async () => {},
      createReadStream: () => null,
      createWriteStream: () => null,
    }
  }
  const { pool, profile } = await harness(t, {
    serverOptions: { password: PASSWORD },
    profile: { secrets: { password: PASSWORD } },
    sftp: provider,
  })
  const session = await pool.acquire({ profile })
  const handle = await session.sftp()
  assert.equal(seen.length, 1)
  assert.equal(typeof seen[0].createWriteStream, 'function')
  assert.equal(handle.wrapper, seen[0])
})

function waitFor(predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      if (predicate()) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error('condition was not met in time'))
      setTimeout(tick, 20)
    }
    tick()
  })
}
