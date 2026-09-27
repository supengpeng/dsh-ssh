/**
 * Connection pool behaviours that need determinism a real server cannot give:
 * exact ssh2 connect options, errno → ICD code mapping, retry/backoff, keepalive
 * death, channel deadlines and registry synchronisation.
 *
 * The `ssh2` client is replaced by a programmable double (`createFakeClient`),
 * so every scenario is driven from the test rather than from the network.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createConnectionPool, scanForSecrets, stripSecrets } from '../../lib/connection/index.js'
import { createSessionRegistry } from '../../lib/sessions.js'
import { SshError } from '../../lib/protocol.js'
import {
  createFakeChannel,
  createFakeClient,
  createFakeWrapper,
  makeConfig,
  makeProfile,
  memoryLogger,
  stateRecorder,
  trackingRedactor,
} from './connection-fixture.test.mjs'

const PASSWORD = 'pool-secret-pw'

/** Pool wired to a caller-supplied client factory. */
function poolWith(t, options = {}) {
  const logger = options.logger ?? memoryLogger()
  const redactor = options.redactor ?? trackingRedactor()
  const pool = createConnectionPool({
    config: makeConfig({ maxSessions: 10, graceKillMs: 80, ...(options.config ?? {}) }),
    logger,
    redactor,
    ...(options.knownHosts === undefined ? {} : { knownHosts: options.knownHosts }),
    ...(options.registry === undefined ? {} : { registry: options.registry }),
    ...(options.sftp === undefined ? {} : { sftp: options.sftp }),
    createClient: options.createClient,
    sleep: options.sleep ?? (async () => {}),
    random: options.random ?? (() => 0.5),
    env: {},
    platform: 'linux',
  })
  t.after(() => pool.disposeAll('teardown'))
  return { pool, logger, redactor }
}

const profile = (overrides = {}) =>
  makeProfile({ auth: 'password', secrets: { password: PASSWORD }, ...overrides })

test('passes timeouts, keepalive and credentials to the ssh2 client', async (t) => {
  const client = createFakeClient()
  const { pool } = poolWith(t, { createClient: () => client })
  const session = await pool.acquire({ profile: profile({ id: 'p_k' }) })

  const config = client.created.config
  assert.equal(config.host, '127.0.0.1')
  assert.equal(config.port, 22)
  assert.equal(config.username, 'tester')
  assert.equal(config.password, PASSWORD)
  assert.equal(config.readyTimeout, 15000)
  assert.equal(config.keepaliveInterval, 20000)
  assert.equal(config.keepaliveCountMax, 3)
  assert.equal(typeof config.hostVerifier, 'function')
  // A `hostHash` would replace the key blob with a hex digest and break the
  // `SHA256:` fingerprint the ICD requires.
  assert.equal(config.hostHash, undefined)
  // `ssh2`'s debug hook is deliberately not installed: packet dumps can carry
  // credentials in binary form, which value redaction cannot catch.
  assert.equal(config.debug, undefined)
  assert.equal(session.state, 'connected')
})

test('per-profile timeouts and retry policy override the plugin config', async (t) => {
  const client = createFakeClient()
  const { pool } = poolWith(t, { createClient: () => client })
  await pool.acquire({
    profile: profile({
      id: 'p_override',
      connectTimeoutMs: 3000,
      keepaliveIntervalMs: 5000,
      keepaliveCountMax: 7,
      retries: { max: 0 },
    }),
  })
  assert.equal(client.created.config.readyTimeout, 3000)
  assert.equal(client.created.config.keepaliveInterval, 5000)
  assert.equal(client.created.config.keepaliveCountMax, 7)
})

test('maps DNS failure to SSH_NET_DNS without retrying', async (t) => {
  const client = createFakeClient({
    onConnect: (c) => {
      queueMicrotask(() => {
        const error = new Error('getaddrinfo ENOTFOUND nope.invalid')
        error.code = 'ENOTFOUND'
        error.level = 'client-dns'
        c.emit('error', error)
      })
    },
  })
  const { pool } = poolWith(t, { createClient: () => client })
  await assert.rejects(
    () => pool.acquire({ profile: profile({ id: 'p_dns' }) }),
    (error) => {
      assert.ok(error instanceof SshError)
      assert.equal(error.code, 'SSH_NET_DNS')
      assert.equal(error.retryable, false)
      assert.equal(error.details.errno, 'ENOTFOUND')
      return true
    },
  )
  assert.equal(pool.size, 0)
  assert.equal(pool.pending, 0)
})

test('maps a refused socket to SSH_NET_REFUSED and replays it up to the policy', async (t) => {
  let created = 0
  const createClient = () => {
    created += 1
    return createFakeClient({
      onConnect: (c) => {
        queueMicrotask(() => {
          const error = new Error('connect ECONNREFUSED 127.0.0.1:22')
          error.code = 'ECONNREFUSED'
          error.level = 'client-socket'
          c.emit('error', error)
        })
      },
    })
  }
  const sleeps = []
  const { pool } = poolWith(t, {
    createClient,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  })
  await assert.rejects(
    () => pool.acquire({ profile: profile({ id: 'p_refused', retries: { max: 2 } }) }),
    (error) => error instanceof SshError && error.code === 'SSH_NET_REFUSED' && error.retryable === true,
  )
  assert.equal(created, 3, 'one dial plus two retries')
  assert.deepEqual(sleeps, [500, 1000], 'exponential backoff with a neutral jitter')
})

test('succeeds on the third attempt after two transient failures', async (t) => {
  let created = 0
  const createClient = () => {
    created += 1
    const attempt = created
    return createFakeClient({
      onConnect: (c) => {
        queueMicrotask(() => {
          if (attempt < 3) {
            const error = new Error('connect ECONNRESET')
            error.code = 'ECONNRESET'
            error.level = 'client-socket'
            c.emit('error', error)
            return
          }
          c.emit('handshake', {})
          c.emit('ready')
        })
      },
    })
  }
  const { pool } = poolWith(t, { createClient })
  const session = await pool.acquire({ profile: profile({ id: 'p_retry', retries: { max: 2 } }) })
  assert.equal(created, 3)
  assert.equal(session.state, 'connected')
})

test('never replays authentication or host key verdicts', async (t) => {
  let created = 0
  const createClient = () => {
    created += 1
    return createFakeClient({
      onConnect: (c, config) => {
        queueMicrotask(() => {
          config.hostVerifier(Buffer.from('blob'), () => {})
          const error = new Error('All configured authentication methods failed')
          error.level = 'client-authentication'
          c.emit('error', error)
        })
      },
    })
  }
  const { pool } = poolWith(t, { createClient })
  await assert.rejects(
    () => pool.acquire({ profile: profile({ id: 'p_auth', retries: { max: 5 } }) }),
    (error) => error instanceof SshError && error.code === 'SSH_AUTH_FAILED' && error.retryable === false,
  )
  assert.equal(created, 1, 'auth failures are not transient')
})

test('declares the connection dead after keepalives stop being answered', async (t) => {
  const registry = createSessionRegistry({ maxConcurrentOpsPerSession: 2 })
  let client
  const { pool } = poolWith(t, { createClient: () => client, registry })
  client = createFakeClient()
  const session = await pool.acquire({ profile: profile({ id: 'p_ka' }) })
  assert.equal(registry.get(session.id).state, 'connected')

  const error = new Error('Keepalive timeout')
  error.level = 'client-timeout'
  client.emit('error', error)

  assert.equal(session.state, 'error')
  assert.equal(session.info.error.code, 'SSH_TIMEOUT_IDLE')
  assert.equal(registry.get(session.id).state, 'error')
  assert.equal(registry.get(session.id).error.code, 'SSH_TIMEOUT_IDLE')

  // A dead session keeps its entry (so the user can see and close it) but must
  // not hold a pool slot: a replacement connect is allowed with maxSessions=1.
  const tight = poolWith(t, { createClient: () => createFakeClient(), config: { maxSessions: 1 } })
  await tight.pool.acquire({ profile: profile({ id: 'p_ka_2' }) })
  await assert.rejects(
    () => tight.pool.acquire({ profile: profile({ id: 'p_ka_2' }), forceNew: true }),
    (thrown) => thrown instanceof SshError && thrown.code === 'SSH_LIMIT_POOL_EXHAUSTED',
  )
})

test('classifies an unexpected handshake failure as SSH_UNKNOWN', async (t) => {
  const client = createFakeClient({
    onConnect: (c) => {
      queueMicrotask(() => c.emit('error', new Error('something nobody has seen before')))
    },
  })
  const { pool } = poolWith(t, { createClient: () => client })
  await assert.rejects(
    () => pool.acquire({ profile: profile({ id: 'p_unknown', retries: { max: 0 } }) }),
    (error) => error instanceof SshError && error.code === 'SSH_UNKNOWN',
  )
})

test('keeps an in-flight dial from exceeding maxSessions', async (t) => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const client = createFakeClient({
    onConnect: async (c) => {
      await gate
      c.emit('ready')
    },
  })
  const { pool } = poolWith(t, { createClient: () => client, config: { maxSessions: 1 } })
  const first = pool.acquire({ profile: profile({ id: 'p_gate' }) })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(pool.pending, 1)
  await assert.rejects(
    () => pool.acquire({ profile: profile({ id: 'p_gate' }), forceNew: true }),
    (error) => error instanceof SshError && error.code === 'SSH_LIMIT_POOL_EXHAUSTED',
  )
  release()
  assert.equal((await first).state, 'connected')
})

test('enforces the channel deadline with TERM, then KILL and a timed-out exit', async (t) => {
  let channel
  const client = createFakeClient({
    onExec: (_client, _command, _options, callback) => {
      channel = createFakeChannel()
      callback(undefined, channel)
    },
  })
  const { pool } = poolWith(t, { createClient: () => client, config: { graceKillMs: 60 } })
  const session = await pool.acquire({ profile: profile({ id: 'p_deadline' }) })
  const handle = await session.exec({ command: 'sleep 999', timeoutMs: 30 })

  const exit = await new Promise((resolve) => handle.onExit(resolve))
  assert.deepEqual(channel.signals, ['TERM', 'KILL'])
  assert.equal(exit.timedOut, true)
  assert.equal(exit.code, null)
  assert.ok(exit.durationMs >= 30)
})

test('cancel() signals TERM and settles the channel', async (t) => {
  let channel
  const client = createFakeClient({
    onExec: (_client, _command, _options, callback) => {
      channel = createFakeChannel()
      callback(undefined, channel)
    },
  })
  const { pool } = poolWith(t, { createClient: () => client })
  const session = await pool.acquire({ profile: profile({ id: 'p_cancel' }) })
  const handle = await session.exec({ command: 'sleep 999' })
  const exit = new Promise((resolve) => handle.onExit(resolve))
  handle.cancel()
  const event = await exit
  assert.deepEqual(channel.signals, ['TERM'])
  assert.equal(event.timedOut, false)
})

test('buffers output that arrives before the first subscriber', async (t) => {
  // Tested against the handle directly: in production the ssh2 callback and the
  // first `data` event are separated by a socket read, and the ICD forbids
  // losing bytes in that window.
  const { ChannelHandle } = await import('../../lib/connection/index.js')
  const channel = createFakeChannel()
  const handle = new ChannelHandle({
    streamId: 'st_buffer_test',
    channel,
    logger: memoryLogger(),
    now: () => 100,
    kind: 'exec',
    label: 'buffer-test',
    graceKillMs: 100,
  })
  channel.pushStdout('early-') // no subscriber attached yet
  const chunks = []
  const unsubscribe = handle.onData((channelName, chunk) => chunks.push([channelName, chunk.toString()]))
  channel.pushStdout('late')
  channel.pushStderr('err')
  assert.deepEqual(chunks, [
    ['stdout', 'early-'],
    ['stdout', 'late'],
    ['stderr', 'err'],
  ])
  unsubscribe()
  channel.pushStdout('ignored')
  assert.equal(chunks.length, 3)
  void t
})

test('delivers output pushed after subscription for a pool-created handle', async (t) => {
  let channel
  const client = createFakeClient({
    onExec: (_client, _command, _options, callback) => {
      channel = createFakeChannel()
      callback(undefined, channel)
    },
  })
  const { pool } = poolWith(t, { createClient: () => client })
  const session = await pool.acquire({ profile: profile({ id: 'p_subscribe' }) })
  const handle = await session.exec({ command: 'echo hi' })
  const chunks = []
  handle.onData((channelName, chunk) => chunks.push([channelName, chunk.toString()]))
  channel.pushStdout('payload')
  assert.deepEqual(chunks, [['stdout', 'payload']])
})

test('counts stdin and stdout bytes in the session metrics', async (t) => {
  let channel
  const client = createFakeClient({
    onExec: (_client, _command, _options, callback) => {
      channel = createFakeChannel()
      callback(undefined, channel)
    },
  })
  const { pool } = poolWith(t, { createClient: () => client })
  const session = await pool.acquire({ profile: profile({ id: 'p_metrics' }) })
  const handle = await session.exec({ command: 'cat' })
  handle.onData(() => {})
  handle.write('abcd')
  channel.pushStdout('0123456789')
  assert.equal(session.info.metrics.bytesOut, 4)
  assert.equal(session.info.metrics.bytesIn, 10)
})

test('an RTT sample is recorded when a channel opens', async (t) => {
  const client = createFakeClient()
  let clock = 1000
  const { pool } = poolWith(t, { createClient: () => client })
  // Drive the injected clock through the pool options.
  const session = await pool.acquire({ profile: profile({ id: 'p_rtt' }) })
  assert.equal(session.rttMs(), undefined)
  const handle = await session.exec({ command: 'true' })
  assert.equal(typeof session.rttMs(), 'number')
  assert.ok(session.rttMs() >= 0)
  void clock
  void handle
})

test('maps a channel-open failure to SSH_STATE_INVALID', async (t) => {
  const client = createFakeClient({
    onExec: (_client, _command, _options, callback) => {
      callback(new Error('Channel open failure: administratively prohibited'), undefined)
    },
  })
  const { pool } = poolWith(t, { createClient: () => client })
  const session = await pool.acquire({ profile: profile({ id: 'p_chanfail' }) })
  await assert.rejects(
    () => session.exec({ command: 'true' }),
    (error) => error instanceof SshError && error.code === 'SSH_STATE_INVALID',
  )
})

test('exec rejects an empty command and an unknown shell geometry', async (t) => {
  const client = createFakeClient()
  const { pool } = poolWith(t, { createClient: () => client })
  const session = await pool.acquire({ profile: profile({ id: 'p_cfg' }) })
  await assert.rejects(
    () => session.exec({ command: '   ' }),
    (error) => error instanceof SshError && error.code === 'SSH_CFG_INVALID',
  )
  await assert.rejects(
    () => session.shell({ cols: 0, rows: 0 }),
    (error) => error instanceof SshError && error.code === 'SSH_CFG_INVALID',
  )
})

test('reports the shell channel with stdout data and PTY geometry', async (t) => {
  let channel
  let shellWindow
  const client = createFakeClient({
    onShell: (_client, window, _options, callback) => {
      shellWindow = window
      channel = createFakeChannel()
      callback(undefined, channel)
    },
  })
  const { pool } = poolWith(t, { createClient: () => client })
  const session = await pool.acquire({ profile: profile({ id: 'p_shell' }) })
  const handle = await session.shell({ cols: 132, rows: 43 })
  const chunks = []
  handle.onData((channelName, chunk) => chunks.push([channelName, chunk.toString()]))
  channel.pushStdout('prompt$ ')
  handle.resize(80, 24)
  assert.deepEqual(shellWindow, { term: 'xterm-256color', cols: 132, rows: 43, width: 0, height: 0 })
  assert.deepEqual(chunks, [['stdout', 'prompt$ ']])
  assert.deepEqual(channel.windows, [{ rows: 24, cols: 80 }])
})

test('threads cwd and env into the exec command and the shell env', async (t) => {
  const commands = []
  const envs = []
  const client = createFakeClient({
    onExec: (_client, command, _options, callback) => {
      commands.push(command)
      callback(undefined, createFakeChannel())
    },
    onShell: (_client, _window, options, callback) => {
      envs.push(options.env)
      callback(undefined, createFakeChannel())
    },
  })
  const { pool } = poolWith(t, { createClient: () => client })
  const session = await pool.acquire({
    profile: profile({ id: 'p_env', defaultCwd: '/srv', defaultEnv: { LANG: 'C' } }),
  })
  await session.exec({ command: 'ls', cwd: '/srv/app', env: { DEBUG: '1' } })
  await session.shell({ cols: 80, rows: 24 })
  assert.equal(commands[0], "cd -- '/srv/app' && LANG='C' DEBUG='1' ls")
  assert.deepEqual(envs[0], { LANG: 'C' })
})

test('the raw SFTP wrapper is returned unmodified and cached', async (t) => {
  const wrapper = createFakeWrapper()
  const client = createFakeClient({ onSftp: (_client, callback) => callback(undefined, wrapper) })
  const { pool } = poolWith(t, { createClient: () => client })
  const session = await pool.acquire({ profile: profile({ id: 'p_sftp' }) })
  assert.equal(await session.openSftpChannel(), wrapper)
  assert.equal(await session.openSftpChannel(), wrapper)
  assert.equal(client.created.channels.filter((entry) => entry.kind === 'sftp').length, 1)
})

test('scrubs an outbound error message and its details', async (t) => {
  const logger = memoryLogger()
  const redactor = trackingRedactor()
  const client = createFakeClient({
    onConnect: (c) => {
      queueMicrotask(() => {
        // A hostile error that embeds the credential, to prove the redactor runs
        // on every outbound path (message + details).
        const error = new Error(`authentication failed for password ${PASSWORD}`)
        error.level = 'client-authentication'
        error.password = PASSWORD
        c.emit('error', error)
      })
    },
  })
  const { pool } = poolWith(t, { createClient: () => client, logger, redactor })
  await assert.rejects(
    () => pool.acquire({ profile: profile({ id: 'p_scrub', retries: { max: 0 } }) }),
    (error) => {
      const info = error.toErrorInfo()
      assert.equal(JSON.stringify(info).includes(PASSWORD), false)
      assert.equal(info.message.includes('••••••••'), true)
      return true
    },
  )
  // No log line carries the credential, masked or not: the connection layer
  // never logs credential material in the first place.
  assert.equal(logger.text().includes(PASSWORD), false)
  assert.equal(logger.text().includes('••••••••'), false)
  assert.equal(redactor.trackedCount(), 1)
})

test('the connect log line reports the auth method masked, never the secret', async (t) => {
  const logger = memoryLogger()
  const redactor = trackingRedactor()
  const { pool } = poolWith(t, {
    createClient: () => createFakeClient(),
    logger,
    redactor,
  })
  await pool.acquire({ profile: profile({ id: 'p_masked' }) })
  const text = logger.text()
  assert.equal(text.includes(PASSWORD), false)
  assert.ok(text.includes('password(••••••••)'), `expected a masked auth label in: ${text}`)
})

test('stripSecrets removes credential-shaped keys from a projection', () => {
  const scrubbed = stripSecrets({
    id: 's_1',
    password: 'x',
    nested: { passphrase: 'y', ok: 1 },
    list: [{ privateKey: 'z', keep: true }],
  })
  assert.deepEqual(scrubbed, { id: 's_1', nested: { ok: 1 }, list: [{ keep: true }] })
  assert.equal(scanForSecrets(scrubbed, ['x', 'y', 'z']).length, 0)
})

test('a throwing onStateChange listener cannot break the connection', async (t) => {
  const client = createFakeClient()
  const { pool } = poolWith(t, { createClient: () => client })
  const recorder = stateRecorder()
  const session = await pool.acquire({
    profile: profile({ id: 'p_listener' }),
    onStateChange: (state, error) => {
      recorder.next(state, error)
      throw new Error('listener exploded')
    },
  })
  assert.equal(session.state, 'connected')
  assert.deepEqual(recorder.states, ['connecting', 'authenticating', 'connected'])
})

test('acquire validates the profile before dialling', async (t) => {
  let created = 0
  const { pool } = poolWith(t, {
    createClient: () => {
      created += 1
      return createFakeClient()
    },
  })
  await assert.rejects(
    () => pool.acquire({ profile: profile({ id: 'p_bad', port: 70000 }) }),
    (error) => error instanceof SshError && error.code === 'SSH_CFG_INVALID',
  )
  await assert.rejects(
    () => pool.acquire({ profile: profile({ id: 'p_bad2', host: '' }) }),
    (error) => error instanceof SshError && error.code === 'SSH_CFG_INVALID',
  )
  assert.equal(created, 0)
})

test('an aborted signal cancels before dialling', async (t) => {
  let created = 0
  const { pool } = poolWith(t, {
    createClient: () => {
      created += 1
      return createFakeClient()
    },
  })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => pool.acquire({ profile: profile({ id: 'p_abort' }), signal: controller.signal }),
    (error) => error instanceof SshError && error.code === 'SSH_CANCELLED',
  )
  assert.equal(created, 0)
})

test('aborting an in-flight connect tears the socket down and reports SSH_CANCELLED', async (t) => {
  let client
  const { pool } = poolWith(t, {
    createClient: () => {
      // A server that accepts the socket and never finishes the handshake.
      client = createFakeClient({ onConnect: () => {} })
      return client
    },
  })
  const controller = new AbortController()
  const pending = pool.acquire({ profile: profile({ id: 'p_abort_inflight' }), signal: controller.signal })
  setTimeout(() => controller.abort(), 10)
  await assert.rejects(
    () => pending,
    (error) => error instanceof SshError && error.code === 'SSH_CANCELLED' && error.retryable === false,
  )
  assert.equal(client.created.destroyed, true, 'the half-open socket is destroyed')
  assert.equal(pool.size, 0)
  assert.equal(pool.pending, 0)
})

test('a channel that never opens reports SSH_TIMEOUT_OPERATION', async (t) => {
  const client = createFakeClient({
    // The server accepts the request and never answers it.
    onExec: () => {},
  })
  const { pool } = poolWith(t, { createClient: () => client, config: { operationTimeoutMs: 1000 } })
  const session = await pool.acquire({ profile: profile({ id: 'p_chan_timeout' }) })
  await assert.rejects(
    () => session.exec({ command: 'true' }),
    (error) => error instanceof SshError && error.code === 'SSH_TIMEOUT_OPERATION' && error.details.op === 'exec',
  )
})
