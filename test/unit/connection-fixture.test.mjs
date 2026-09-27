/**
 * Shared fixtures for the connection-layer unit tests.
 *
 * This file contains **no tests** — it is a helper module that happens to match
 * the `connection*.test.mjs` write scope. It provides:
 *   - `startSshServer()`: a real protocol-level sshd built on `ssh2.Server`;
 *   - `createFakeClient()`: a programmable `ssh2` client double, for asserting
 *     connect options and driving failure modes that a real server cannot
 *     produce deterministically (ENOTFOUND, keepalive timeout, ...);
 *   - profile/config/logger/redactor factories.
 */

import ssh2 from 'ssh2'

// `ssh2` is CommonJS: only some names are visible as ESM named exports
// (`Server`/`utils` are not), so the default import is mandatory.
const { Server, utils } = ssh2

export const HOST_KEY = utils.generateKeyPairSync('ed25519', { comment: 'dsh-ssh-test-host' })
export const CLIENT_KEY = utils.generateKeyPairSync('ed25519', { comment: 'dsh-ssh-test-client' })
export const CLIENT_KEY_ENCRYPTED = utils.generateKeyPairSync('ed25519', {
  passphrase: 'key-pass',
  cipher: 'aes256-cbc',
  comment: 'dsh-ssh-test-client-encrypted',
})

/** Minimal SFTP server: answers INIT with VERSION(3) so the channel opens. */
function handleSftp(sftp, state) {
  state.sftpOpened = true
  sftp.on('data', (chunk) => {
    if (chunk.length >= 1 && chunk[0] === 1) {
      // SSH_FXP_INIT -> SSH_FXP_VERSION (type 2, u32 version 3)
      const reply = Buffer.alloc(5)
      reply.writeUInt8(2, 0)
      reply.writeUInt32BE(3, 1)
      sftp.write(reply)
    }
  })
}

/**
 * Start a real SSH server on an ephemeral port.
 *
 * `options.auth`:
 *   - `password`: expected password (default `'secret'`); `null` rejects all.
 *   - `publicKey`: `'accept'` (default) | `'reject'`.
 */
export async function startSshServer(options = {}) {
  const state = {
    connections: 0,
    closes: 0,
    authAttempts: [],
    execCommands: [],
    execStdin: [],
    shellInput: [],
    signals: [],
    windowChanges: [],
    ptyInfo: undefined,
    sftpOpened: false,
    shellOpened: false,
    banner: undefined,
  }
  const password = options.password === undefined ? 'secret' : options.password
  // `ssh2`'s Server wraps an internal net.Server whose own `connection` event
  // carries its protocol client rather than the socket — so this fixture owns the
  // TCP listener and injects sockets (the supported way to keep raw socket
  // handles, which is what makes teardown deterministic).
  const sockets = new Set()
  const server = new Server(
    {
      hostKeys: [HOST_KEY.private],
      ...(options.banner === undefined ? {} : { banner: options.banner }),
    },
    (client) => {
      state.connections += 1
      client.on('authentication', (ctx) => {
        state.authAttempts.push({ method: ctx.method, username: ctx.username })
        if (options.authRejectAll === true) return ctx.reject(['password', 'publickey'])
        if (ctx.method === 'password') {
          if (password !== null && ctx.password === password) return ctx.accept()
          return ctx.reject(['password', 'publickey'])
        }
        if (ctx.method === 'publickey') {
          if (options.publicKey === 'reject') return ctx.reject(['publickey'])
          return ctx.accept()
        }
        if (ctx.method === 'none') return ctx.reject(['password', 'publickey'])
        return ctx.reject(['password', 'publickey'])
      })
      client.on('ready', () => {
        client.on('session', (accept) => {
          const session = accept()
          session.on('pty', (accept2, _reject2, info) => {
            state.ptyInfo = info
            accept2?.()
          })
          session.on('window-change', (accept2, _reject2, info) => {
            state.windowChanges.push({ cols: info.cols, rows: info.rows })
            accept2?.()
          })
          session.on('env', (accept2) => accept2?.())
          // ssh2's server reports channel signals on the session, not the stream.
          session.on('signal', (accept2, _reject2, info) => {
            state.signals.push(info?.name)
            accept2?.()
          })
          session.on('exec', (accept2, reject2, info) => {
            state.execCommands.push(info.command)
            if (options.rejectExec === true) return reject2()
            const stream = accept2()
            stream.on('data', (data) => state.execStdin.push(data.toString()))
            if (options.execStdout !== undefined) stream.write(options.execStdout)
            else stream.write('hello\n')
            if (options.execStderr !== undefined) stream.stderr.write(options.execStderr)
            if (options.holdExecOpen !== true) {
              stream.exit(options.execExitCode ?? 0)
              stream.end()
            }
          })
          session.on('shell', (accept2) => {
            const stream = accept2()
            state.shellOpened = true
            stream.write('shell-ready\r\n')
            stream.on('data', (data) => {
              state.shellInput.push(data.toString())
              if (options.echoShell !== false) stream.write(data)
            })
          })
          session.on('sftp', (accept2, reject2) => {
            if (options.rejectSftp === true) return reject2()
            handleSftp(accept2(), state)
          })
        })
      })
      client.on('error', () => {})
      client.on('close', () => {
        state.closes += 1
      })
    },
  )
  const { createServer } = await import('node:net')
  const tcp = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {
      /* a client dropped by a test is normal */
    })
    server.injectSocket(socket)
  })
  await new Promise((resolve, reject) => {
    tcp.once('error', reject)
    tcp.listen(0, '127.0.0.1', resolve)
  })
  const address = tcp.address()
  return {
    server,
    host: '127.0.0.1',
    port: address.port,
    hostKey: HOST_KEY,
    state,
    hasConnection: () => state.connections > 0,
    openSockets: () => sockets.size,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      await new Promise((resolve) => tcp.close(() => resolve()))
    },
  }
}

/** TCP listener that accepts connections and then stays silent (handshake timeout). */
export async function startSilentTcpServer() {
  const { createServer } = await import('node:net')
  const sockets = new Set()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    host: '127.0.0.1',
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

// ---------------------------------------------------------------------------
// Profile / config factories
// ---------------------------------------------------------------------------

export function makeConfig(overrides = {}) {
  return {
    profilesFile: 'C:/tmp/profiles.json',
    auditFile: 'C:/tmp/audit.jsonl',
    maxSessions: 10,
    maxConcurrentOpsPerSession: 4,
    maxOutputBytes: 262144,
    connectTimeoutMs: 15000,
    operationTimeoutMs: 120000,
    graceKillMs: 3000,
    keepaliveIntervalMs: 20000,
    keepaliveCountMax: 3,
    retries: { max: 2, backoffBaseMs: 500, backoffMaxMs: 5000, jitter: true },
    hostKey: { policy: 'accept-new', knownHostsFile: 'C:/tmp/known_hosts' },
    sftp: {
      chunkBytes: 262144,
      maxConcurrentChunks: 4,
      resume: true,
      verify: 'size+mtime',
      followSymlinks: false,
      progressIntervalMs: 200,
    },
    secrets: { provider: 'credentials', envPrefix: 'DSH_SSH_' },
    logging: { level: 'info', redact: true, redactKeys: ['password', 'passphrase', 'privateKey', 'secret', 'token', 'key'] },
    confirmDangerous: true,
    allowAgentTools: true,
    tools: ['ssh_exec'],
    ui: { defaultWidthPx: 420, locale: 'auto', terminalFontSize: 13, reconnectAttempts: 5 },
    dshHome: 'C:/Users/test/.dsh',
    knownHostsFile: 'C:/tmp/known_hosts',
    ...overrides,
  }
}

export function makeProfile(overrides = {}) {
  const base = {
    id: 'p_test',
    name: 'test-profile',
    host: '127.0.0.1',
    port: 22,
    user: 'tester',
    auth: 'password',
    secretRefs: {},
    connectTimeoutMs: 0,
    keepaliveIntervalMs: 0,
    keepaliveCountMax: -1,
    retries: {},
    hostKeyPolicy: 'accept-new',
    tags: [],
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    secrets: {},
  }
  return { ...base, ...overrides, secrets: { ...base.secrets, ...(overrides.secrets ?? {}) } }
}

export function makeTarget(server, overrides = {}) {
  return makeProfile({
    host: server.host,
    port: server.port,
    auth: 'password',
    secretRefs: {},
    secrets: { password: 'secret' },
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// Observability doubles
// ---------------------------------------------------------------------------

export function memoryLogger() {
  const lines = []
  const push = (level) => (message) => {
    lines.push({ level, message: String(message) })
  }
  return {
    lines,
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    text: () => lines.map((line) => line.message).join('\n'),
  }
}

/** Redactor double mirroring ICD §7.3 `Redactor` semantics. */
export function trackingRedactor() {
  const tracked = new Set()
  const scrubValue = (value) => {
    if (typeof value === 'string') {
      let out = value
      for (const secret of tracked) out = out.split(secret).join('••••••••')
      return out
    }
    if (Array.isArray(value)) return value.map(scrubValue)
    if (value !== null && typeof value === 'object') {
      const out = {}
      for (const [key, nested] of Object.entries(value)) out[key] = scrubValue(nested)
      return out
    }
    return value
  }
  return {
    track(secret) {
      if (typeof secret === 'string' && secret !== '') tracked.add(secret)
    },
    scrub(value) {
      return scrubValue(value)
    },
    forgetAll() {
      tracked.clear()
    },
    trackedCount: () => tracked.size,
  }
}

/** Host-key verifier double with a scriptable verdict. */
export function fakeKnownHosts(verdict = { ok: true }, options = {}) {
  const calls = { verify: [], remember: [] }
  return {
    calls,
    fingerprint(keyType, key) {
      return `${keyType}:${key.length}`
    },
    async verify(question) {
      calls.verify.push(question)
      return typeof verdict === 'function' ? verdict(question) : verdict
    },
    async remember(question) {
      calls.remember.push(question)
      if (options.rememberFails === true) throw new Error('disk full')
    },
  }
}

// ---------------------------------------------------------------------------
// Fake ssh2 client
// ---------------------------------------------------------------------------

function emitter() {
  const listeners = new Map()
  return {
    on(event, listener) {
      const list = listeners.get(event)
      if (list === undefined) listeners.set(event, [listener])
      else list.push(listener)
      return this
    },
    emit(event, ...args) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args)
    },
    listenerCount(event) {
      return (listeners.get(event) ?? []).length
    },
  }
}

/** A stand-in for `ssh2`'s `ClientChannel`. */
export function createFakeChannel() {
  const base = emitter()
  const channel = {
    ...base,
    writes: [],
    signals: [],
    windows: [],
    ended: false,
    closed: false,
    stderr: {
      ...emitter(),
      writes: [],
    },
    write(data) {
      channel.writes.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)))
      return true
    },
    signal(signal) {
      channel.signals.push(signal)
    },
    setWindow(rows, cols) {
      channel.windows.push({ rows, cols })
    },
    end() {
      channel.ended = true
    },
    close() {
      channel.closed = true
      channel.emit('close', null, undefined)
    },
    // test drivers
    pushStdout(text) {
      channel.emit('data', Buffer.from(text))
    },
    pushStderr(text) {
      channel.stderr.emit('data', Buffer.from(text))
    },
    finish(code, signal) {
      channel.emit('exit', code, signal, '', '')
      channel.emit('close', code, signal)
    },
  }
  return channel
}

export function createFakeWrapper() {
  return { kind: 'fake-sftp-wrapper', createWriteStream: () => ({}) }
}

/**
 * Programmable `ssh2` client double.
 *
 * `script.onConnect(client, config)` decides what happens on `connect()`; the
 * default performs a successful handshake (handshake → ready).
 */
export function createFakeClient(script = {}) {
  const base = emitter()
  const created = { channels: [], config: undefined, ended: false, destroyed: false }
  const client = {
    ...base,
    created,
    connect(config) {
      created.config = config
      if (script.onConnect !== undefined) script.onConnect(client, config)
      else {
        queueMicrotask(() => {
          client.emit('handshake', { kex: 'curve25519-sha256', serverHostKey: 'ssh-ed25519' })
          client.emit('ready')
        })
      }
    },
    exec(command, options, callback) {
      created.channels.push({ kind: 'exec', command, options })
      if (script.onExec !== undefined) script.onExec(client, command, options, callback)
      else {
        const channel = createFakeChannel()
        queueMicrotask(() => callback(undefined, channel))
      }
      return client
    },
    shell(window, options, callback) {
      created.channels.push({ kind: 'shell', window, options })
      if (script.onShell !== undefined) script.onShell(client, window, options, callback)
      else {
        const channel = createFakeChannel()
        queueMicrotask(() => callback(undefined, channel))
      }
      return client
    },
    sftp(callback) {
      created.channels.push({ kind: 'sftp' })
      if (script.onSftp !== undefined) script.onSftp(client, callback)
      else queueMicrotask(() => callback(undefined, createFakeWrapper()))
      return client
    },
    end() {
      created.ended = true
      queueMicrotask(() => client.emit('close'))
    },
    destroy() {
      created.destroyed = true
      queueMicrotask(() => client.emit('close'))
    },
  }
  return client
}

/** Collect the stream of `state` notifications an AcquireInput listener sees. */
export function stateRecorder() {
  const states = []
  const errors = []
  return {
    states,
    errors,
    next(state, error) {
      states.push(state)
      errors.push(error)
    },
  }
}
