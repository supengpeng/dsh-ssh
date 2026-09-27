/**
 * A real SSH server over a real TCP socket, built on `ssh2`'s Server API.
 *
 * Why this exists: this machine has no Docker and no WSL, so "go test against a
 * Linux box" is not available in CI. The double is a *protocol-level* sshd - * genuine key exchange, genuine ciphers, genuine channels and a genuine SFTP
 * subsystem -with an in-process command interpreter instead of `/bin/sh`
 * (`minish.mjs`). Every other layer of the project (host unit, integration, E2E,
 * perf) points at this target, so its behaviour is the contract for "a working
 * SSH server".
 *
 * What it supports:
 *   - password AND publickey auth (throwaway host key + user key generated at
 *     start, optionally written to disk so `privateKeyPath` code paths work)
 *   - `exec`            stdout/stderr/exit code, env requests, cwd via `cd`
 *   - `shell` + PTY     line editing, history, Ctrl+C/D, resize, `top`
 *   - `sftp` subsystem  full op set incl. streaming reads/writes for 100MB files
 *   - failure injection  drop connections, freeze the link, deny methods/paths
 *
 * Quick start:
 *   const server = await startSshd()
 *   const client = new Client()
 *   client.connect(server.config)               // password auth
 *   client.connect(server.keyConfig)            // publickey auth
 *   await server.stop()
 *
 * The module is deliberately dependency-light: `ssh2` only.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  renameSync,
  rmdirSync,
  statSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import net from 'node:net'

// `ssh2` is CommonJS: Node's named-export detection does not cover its
// getter-based `exports`, so the default import is the portable form.
import ssh2 from 'ssh2'

import {
  createSandbox,
  createTempRoot,
  defaultFixtureTree,
  fingerprint,
  knownHostsLine,
  removeTempRoot,
  writeTree,
} from './fixtures.mjs'
import { InteractiveShell, Interpreter, createAbort, queueInput } from './minish.mjs'

const { Client, Server, utils } = ssh2

/** Re-exported so integration tests need a single import for the double. */
export { Client, Server }

export const STATUS = utils.sftp.STATUS_CODE
export const OPEN_MODE = utils.sftp.OPEN_MODE

/** Defaults other agents can rely on; override through `startSshd(options)`. */
export const SSHD_DEFAULTS = {
  host: '127.0.0.1',
  user: 'sshuser',
  password: 'sshpass',
  userKeyType: 'ed25519',
  hostKeyType: 'ed25519',
  ident: 'SSH-2.0-dsh-sshd-test',
  banner: 'dsh-ssh protocol test double',
  hostname: 'dsh-test',
  methods: ['password', 'publickey'],
  readdirBatch: 64,
  autoFixtures: true,
}

const SIGNAL_NUMBERS = { HUP: 1, INT: 2, QUIT: 3, KILL: 9, TERM: 15 }

/** `128 + signum`, the conventional shell exit status for a killed process. */
export function signalExitCode(name) {
  const number = SIGNAL_NUMBERS[String(name).toUpperCase()]
  return number ? 128 + number : 143
}

function bufferEqual(a, b) {
  if (!a || !b) return false
  const left = Buffer.isBuffer(a) ? a : Buffer.from(a)
  const right = Buffer.isBuffer(b) ? b : Buffer.from(b)
  return left.length === right.length && left.equals(right)
}

/**
 * `utils.generateKeyPairSync()` from ssh2 1.17 occasionally emits a malformed
 * ed25519 key (a dropped leading zero byte -bad base64 length, roughly 1 in 50
 * keys). A test double that fails 2% of the time is worse than useless, so the
 * pair is validated and regenerated until both halves parse.
 */
function generateValidKeyPair(type, options = {}, attempts = 25) {
  let lastError
  for (let i = 0; i < attempts; i++) {
    const pair = utils.generateKeyPairSync(type, options)
    const privateKey = utils.parseKey(pair.private, options.passphrase)
    const publicKey = utils.parseKey(pair.public)
    if (privateKey instanceof Error) {
      lastError = privateKey
      continue
    }
    if (publicKey instanceof Error) {
      lastError = publicKey
      continue
    }
    return { ...pair, privateParsed: Array.isArray(privateKey) ? privateKey[0] : privateKey, publicParsed: publicKey }
  }
  throw new Error(`generateValidKeyPair(${type}) failed after ${attempts} attempts: ${lastError && lastError.message}`)
}

/** Write with channel-window backpressure; resolves when the chunk is queued. */
function streamWrite(stream, chunk) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
  if (!buffer.length) return Promise.resolve()
  if (stream.destroyed || stream.writable === false) return Promise.resolve()
  const ok = stream.write(buffer)
  if (ok) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      stream.removeListener('drain', done)
      stream.removeListener('close', done)
      resolve()
    }
    stream.once('drain', done)
    stream.once('close', done)
  })
}

function attrsOf(st, mode, uid = 1000, gid = 1000) {
  return {
    mode: mode ?? st.mode,
    uid,
    gid,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000),
  }
}

/** Virtual permission bits, so chmod is observable on Windows too. */
export const DEFAULT_FILE_MODE = 0o644
export const DEFAULT_DIR_MODE = 0o755

function longNameFor(name, st, mode) {
  const type = st.isDirectory() ? 'd' : st.isSymbolicLink() ? 'l' : '-'
  const bits = (mode ?? st.mode) & 0o7777
  const flags = [0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001]
  let rendered = type
  for (let i = 0; i < 9; i++) rendered += bits & flags[i] ? 'rwxrwxrwx'[i] : '-'
  const date = new Date(st.mtimeMs)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const stamp = `${months[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, ' ')} ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`
  return `${rendered} 1 ${1000} ${1000} ${String(st.size).padStart(8)} ${stamp} ${name}`
}

function errnoToStatus(error) {
  switch (error && error.code) {
    case 'ENOENT':
      return { code: STATUS.NO_SUCH_FILE, message: 'No such file' }
    case 'EACCES':
    case 'EPERM':
    case 'EISDIR':
      return { code: STATUS.PERMISSION_DENIED, message: 'Permission denied' }
    case 'ENOTDIR':
      return { code: STATUS.FAILURE, message: 'Not a directory' }
    case 'ENOTEMPTY':
      return { code: STATUS.FAILURE, message: 'Directory not empty' }
    case 'EEXIST':
      return { code: STATUS.FAILURE, message: 'File already exists' }
    case 'ENOSPC':
      return { code: STATUS.FAILURE, message: 'No space left on device' }
    default:
      return { code: STATUS.FAILURE, message: (error && error.message) || 'Failure' }
  }
}

/**
 * Start the double.
 *
 * @param {object} [options]
 * @param {string} [options.user]         username to accept (default sshuser)
 * @param {string} [options.password]     password to accept
 * @param {string[]} [options.methods]    enabled auth methods
 * @param {string} [options.hostKeyType]  ed25519 | rsa
 * @param {string} [options.hostKey]      reuse an existing private key (PEM)
 * @param {string} [options.root]         reuse an existing fixture root
 * @param {boolean} [options.keepRoot]    do not delete the root on stop()
 * @param {object} [options.tree]         extra fixture entries
 * @returns {Promise<object>} server handle (see README of this module)
 */
export async function startSshd(options = {}) {
  const settings = { ...SSHD_DEFAULTS, ...options }
  const user = settings.user
  const password = settings.password
  const home = `/home/${user}`
  const keepRoot = Boolean(options.keepRoot)

  const root = options.root ?? createTempRoot()
  const sandbox = createSandbox(root, home)

  // --- key material -------------------------------------------------------
  const hostKeyPair = settings.hostKey
    ? { private: settings.hostKey, public: null }
    : generateValidKeyPair(settings.hostKeyType, { comment: 'dsh-sshd-host' })
  const hostPrivatePem = hostKeyPair.private
  // The public half is only needed for fingerprints/known_hosts; derive it from
  // the private key when the caller supplied one.
  const derivateHostPublic = () => {
    const parsed = utils.parseKey(hostPrivatePem)
    if (parsed instanceof Error) throw parsed
    const key = Array.isArray(parsed) ? parsed[0] : parsed
    const blob = key.getPublicSSH()
    return { keyType: key.type, blob, base64: blob.toString('base64') }
  }
  const hostPublic = derivateHostPublic()

  const userKeyPair = generateValidKeyPair(settings.userKeyType, { comment: `dsh-sshd-${user}` })
  const encryptedUserKeyPair = generateValidKeyPair(settings.userKeyType, {
    passphrase: settings.keyPassphrase ?? 'keypass',
    cipher: 'aes256-cbc',
    comment: `dsh-sshd-${user}-encrypted`,
  })
  const userPublicParsed = userKeyPair.publicParsed
  const userPublicBlob = userPublicParsed.getPublicSSH()
  const userKeyType = userPublicParsed.type
  // Both generated user keys are authorized: the plain one and the encrypted one
  // (so the passphrase flow can be exercised end to end).
  const authorizedKeys = [userPublicParsed, encryptedUserKeyPair.publicParsed]

  // Keys live inside the fixture root so they are reachable through the same
  // sandbox the plugin sees (and so `privateKeyPath` tests use a real file).
  writeTree(root, defaultFixtureTree(home, { user, hostname: settings.hostname }))
  const sshDir = join(root, 'home', user, '.ssh')
  mkdirSync(sshDir, { recursive: true })
  const hostKeyDir = join(root, 'etc', 'ssh')
  mkdirSync(hostKeyDir, { recursive: true })
  const identityFile = join(sshDir, `id_${settings.userKeyType}`)
  const identityFileEncrypted = join(sshDir, `id_${settings.userKeyType}_encrypted`)
  const hostKeyFile = join(hostKeyDir, `ssh_host_${settings.hostKeyType}_key`)
  writeFileSync(identityFile, userKeyPair.private, { mode: 0o600 })
  writeFileSync(identityFileEncrypted, encryptedUserKeyPair.private, { mode: 0o600 })
  writeFileSync(`${identityFile}.pub`, `${userKeyPair.public}\n`, { mode: 0o644 })
  writeFileSync(hostKeyFile, hostPrivatePem, { mode: 0o600 })
  writeFileSync(`${hostKeyFile}.pub`, `${hostPublic.keyType} ${hostPublic.base64}\n`, { mode: 0o644 })
  writeFileSync(join(sshDir, 'authorized_keys'), `${userKeyPair.public}\n`, { mode: 0o600 })

  if (options.tree) writeTree(root, options.tree)

  // --- state --------------------------------------------------------------
  const stats = {
    connections: 0,
    disconnects: 0,
    authAttempts: 0,
    authFailures: 0,
    authSuccesses: 0,
    sessions: 0,
    execs: 0,
    shells: 0,
    ptys: 0,
    sftpSessions: 0,
    sftpRequests: 0,
    bytesIn: 0,
    bytesOut: 0,
    lastEnv: null,
    lastPty: null,
    lastExec: null,
    lastShell: null,
    commands: [],
    deniedPaths: [],
  }
  const events = []
  const sockets = new Set()
  const connections = new Set()
  const sessions = new Set()
  /** Live (unfinished) exec/shell runs; `server.waitForIdle()` drains these. */
  const runs = new Set()
  let allowedMethods = [...settings.methods]
  const denied = new Map() // virtual path -'r'|'w'|'rw'
  let stopped = false

  const log = (event, data = {}) => {
    const entry = { at: Date.now(), event, ...data }
    events.push(entry)
    if (events.length > 5000) events.splice(0, 1000)
    return entry
  }

  const denyCheck = (vpath, mode) => {
    for (const [path, flags] of denied) {
      const hit = vpath === path || vpath.startsWith(`${path}/`)
      if (hit && (mode === 'r' ? flags.includes('r') : flags.includes('w'))) return mode
    }
    return null
  }

  // Linux mode semantics are emulated so `chmod`/`stat` round-trip identically on
  // every host OS (Windows only tracks the read-only bit). The file *type* bits
  // always come from the real stat, the permission bits from the overlay.
  const virtualModes = new Map()
  const modeOfReal = (realPath, st) => {
    const stat = st ?? lstatSync(realPath)
    const type = stat.mode & 0o170000
    const overlay = virtualModes.get(realPath)
    if (overlay !== undefined) return type | (overlay & 0o7777)
    if (stat.isSymbolicLink()) return type | 0o777
    return type | (stat.isDirectory() ? DEFAULT_DIR_MODE : DEFAULT_FILE_MODE)
  }
  const setModeReal = (realPath, mode) => {
    const bits = mode & 0o7777
    virtualModes.set(realPath, bits)
    try {
      chmodSync(realPath, bits)
    } catch {
      /* Windows: best effort, the virtual overlay is the source of truth */
    }
    return bits
  }

  const baseEnv = () => ({
    HOME: home,
    PWD: home,
    USER: user,
    LOGNAME: user,
    SHELL: '/bin/bash',
    TERM: settings.term ?? 'xterm-256color',
    LANG: 'en_US.UTF-8',
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOSTNAME: settings.hostname,
    SSHD_TEST_DOUBLE: '1',
  })

  const createSshServer = (label) => {
    const sshServer = new Server({ hostKeys: [hostPrivatePem], ident: settings.ident, banner: settings.banner }, (client) => {
      stats.connections += 1
      connections.add(client)
      log('connection', { label })
      client.on('authentication', (ctx) => {
        stats.authAttempts += 1
        const methods = allowedMethods
        const reject = () => {
          stats.authFailures += 1
          log('auth-reject', { user: ctx.username, method: ctx.method })
          ctx.reject(methods)
        }
        if (ctx.username !== user) return reject()
        if (!methods.includes(ctx.method)) return reject()
        if (ctx.method === 'password') {
          if (typeof password === 'string' && password.length > 0 && ctx.password === password) {
            stats.authSuccesses += 1
            return ctx.accept()
          }
          return reject()
        }
        if (ctx.method === 'publickey') {
          const key = authorizedKeys.find(
            (candidate) => candidate.type === ctx.key.algo && bufferEqual(ctx.key.data, candidate.getPublicSSH()),
          )
          if (!key) return reject()
          if (!ctx.signature) {
            // Probe: the client asks whether this key would be acceptable.
            stats.authSuccesses += 1
            return ctx.accept()
          }
          let verified = false
          try {
            // Third argument is the *hash* algorithm (ctx.hashAlgo), which only
            // matters for RSA; ed25519 ignores it. Passing ctx.key.algo here
            // makes node:crypto throw "Invalid digest".
            verified = key.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true
          } catch (error) {
            log('auth-verify-error', { message: String(error && error.message) })
            verified = false
          }
          if (!verified) return reject()
          stats.authSuccesses += 1
          return ctx.accept()
        }
        return reject()
      })

      client.on('request', (accept, reject, name, info) => {
        // NOTE: ssh2's server only emits 'request' for the forwarding requests
        // (tcpip-forward & friends); `keepalive@openssh.com` is answered with
        // FAILURE automatically before this handler runs. A black-holed link is
        // therefore emulated with `freeze()` below, not by dropping keepalives.
        log('global-request', { name, info })
        if (name === 'no-more-sessions@openssh.com') return accept()
        return reject()
      })

      client.on('ready', () => {
        log('ready', {})
      })

      client.on('session', (accept) => {
        stats.sessions += 1
        const session = accept()
        const sessionState = { env: {}, pty: null, shell: null, abort: null }
        sessions.add(sessionState)

        session.on('env', (acceptEnv, rejectEnv, info) => {
          sessionState.env[info.key] = info.val
          stats.lastEnv = { ...sessionState.env }
          log('env', { key: info.key, val: info.val })
          if (acceptEnv) acceptEnv()
        })

        session.on('pty', (acceptPty, rejectPty, info) => {
          stats.ptys += 1
          sessionState.pty = info
          stats.lastPty = info
          log('pty', { term: info.term, cols: info.cols, rows: info.rows })
          if (acceptPty) acceptPty()
        })

        session.on('window-change', (acceptWc, rejectWc, info) => {
          log('window-change', { cols: info.cols, rows: info.rows })
          sessionState.shell?.resize(info.cols, info.rows)
          if (acceptWc) acceptWc()
        })

        session.on('signal', (acceptSignal, rejectSignal, info) => {
          log('signal', { name: info.name })
          // A running shell owns per-command abort tokens; hand the signal to it.
          if (sessionState.shell) sessionState.shell.signal(String(info.name).toUpperCase())
          else sessionState.abort?.cancel(String(info.name).toUpperCase())
          if (acceptSignal) acceptSignal()
        })

        session.on('subsystem', (acceptSubsystem, rejectSubsystem, info) => {
          log('subsystem', { name: info.name })
          if (rejectSubsystem) rejectSubsystem()
        })

        session.on('sftp', (acceptSftp) => {
          stats.sftpSessions += 1
          const sftp = acceptSftp()
          log('sftp-open', {})
          attachSftp(sftp)
        })

        session.on('exec', (acceptExec, rejectExec, info) => {
          stats.execs += 1
          stats.lastExec = info.command
          log('exec', { command: info.command })
          const stream = acceptExec()
          const env = { ...baseEnv(), ...sessionState.env }
          const abort = createAbort()
          sessionState.abort = abort
          const input = queueInput()
          stream.on('data', (chunk) => {
            stats.bytesIn += chunk.length
            input.push(chunk)
          })
          stream.on('end', () => input.end())
          stream.on('close', () => {
            input.end()
            abort.cancel('HUP')
          })
          const interpreter = new Interpreter({
            sandbox,
            cwd: env.PWD ?? home,
            env,
            user,
            host: settings.hostname,
            stdout: { kind: 'channel', write: (chunk) => streamWrite(stream, chunk) },
            stderr: { kind: 'channel', write: (chunk) => streamWrite(stream.stderr, chunk) },
            stdin: input,
            abort,
            tty: false,
            deny: denyCheck,
            modeOf: modeOfReal,
            chmod: setModeReal,
            outputCap: options.outputCap,
            log,
          })
          const run = (async () => {
            let code
            try {
              code = await interpreter.run(info.command)
            } catch (error) {
              await streamWrite(stream.stderr, `sh: ${error && error.message ? error.message : error}\n`)
              code = 1
            }
            stats.commands.push({ command: info.command, code })
            log('exec-exit', { command: info.command, code, signal: abort.cancelled ? abort.reason : undefined })
            try {
              if (abort.cancelled && SIGNAL_NUMBERS[abort.reason]) {
                // A signal-terminated process reports `exit-signal`, exactly like
                // OpenSSH: the client must see `code: null, signal: 'TERM'`
                // rather than a synthesised 143.
                stream.exit(String(abort.reason))
              } else {
                stream.exit(code)
              }
              stream.end()
            } catch {
              /* channel already gone */
            }
          })()
          runs.add(run)
          run.finally(() => runs.delete(run))
        })

        session.on('shell', (acceptShell) => {
          stats.shells += 1
          const stream = acceptShell()
          const pty = sessionState.pty ?? { term: 'xterm-256color', cols: 80, rows: 24 }
          stats.lastShell = pty
          log('shell', { term: pty.term, cols: pty.cols, rows: pty.rows })
          const abort = createAbort()
          sessionState.abort = abort
          const shell = new InteractiveShell({
            sandbox,
            user,
            host: settings.hostname,
            env: { ...baseEnv(), ...sessionState.env },
            cwd: home,
            cols: pty.cols ?? 80,
            rows: pty.rows ?? 24,
            term: pty.term ?? 'xterm-256color',
            motd: settings.motd ?? '',
            out: (chunk) => streamWrite(stream, chunk),
            deny: denyCheck,
            modeOf: modeOfReal,
            chmod: setModeReal,
            log,
          })
          sessionState.shell = shell
          stream.on('data', (chunk) => {
            stats.bytesIn += chunk.length
            shell.input(chunk)
          })
          stream.on('close', () => {
            shell.close()
            abort.cancel('HUP')
          })
          const run = (async () => {
            shell.onClose = () => {
              try {
                stream.exit(shell.exitCode ?? 0)
                stream.end()
              } catch {
                /* channel already gone */
              }
            }
            await shell.start()
          })()
          runs.add(run)
          run.finally(() => runs.delete(run))
        })
      })

      client.on('close', () => {
        stats.disconnects += 1
        connections.delete(client)
        log('disconnect', {})
      })
      client.on('error', (error) => {
        log('client-error', { message: String(error && error.message) })
      })
    })
    sshServer.on('error', (error) => log('server-error', { message: String(error && error.message) }))
    return sshServer
  }

  // `ssh2`'s Server is an EventEmitter wrapping an internal net.Server, and its
  // own `'connection'` event carries the *Client* object rather than the socket.
  // Owning the TCP server and feeding sockets through `injectSocket()` is the
  // supported way to see the raw sockets (needed for byte counters, freeze and
  // drop-all failure injection).
  const sshServer = createSshServer('main')
  const tcpServer = net.createServer((socket) => {
    sockets.add(socket)
    const originalWrite = socket.write.bind(socket)
    socket.write = (chunk, ...rest) => {
      if (chunk) stats.bytesOut += Buffer.byteLength(chunk)
      return originalWrite(chunk, ...rest)
    }
    socket.on('data', (chunk) => {
      stats.bytesIn += chunk.length
    })
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {
      /* a dropped test client is normal */
    })
    sshServer.injectSocket(socket)
  })

  const port = await new Promise((resolve, reject) => {
    tcpServer.once('error', reject)
    tcpServer.listen(settings.port ?? 0, settings.host, () => resolve(tcpServer.address().port))
  })

  // --- SFTP ---------------------------------------------------------------

  function attachSftp(sftp) {
    /** handle key -{ kind, fd?, vpath, realPath, entries?, position } */
    const handles = new Map()
    let handleSeq = 0
    const batch = settings.readdirBatch

    const mkHandle = (record) => {
      const id = Buffer.from(`h${(handleSeq += 1)}`)
      handles.set(id.toString('binary'), { id, ...record })
      return id
    }
    const getHandle = (raw) => handles.get(Buffer.isBuffer(raw) ? raw.toString('binary') : String(raw))

    const resolve = (path) => {
      const vpath = sandbox.resolve(sandbox.home, path === '' ? '.' : path)
      return { vpath, realPath: sandbox.real(vpath) }
    }
    const withDeny = (vpath, mode, action) => {
      stats.sftpRequests += 1
      if (denyCheck(vpath, mode)) {
        sftp.status(action, STATUS.PERMISSION_DENIED, 'Permission denied')
        return true
      }
      return false
    }
    const fail = (reqid, error) => {
      const { code, message } = errnoToStatus(error)
      log('sftp-error', { code, message })
      sftp.status(reqid, code, message)
    }

    sftp.on('OPEN', (reqid, filename, pflags, attrs) => {
      const { vpath, realPath } = resolve(filename)
      if (withDeny(vpath, 'w', reqid)) return
      const exists = existsSync(realPath)
      const isRead = Boolean(pflags & OPEN_MODE.READ)
      const isWrite = Boolean(pflags & OPEN_MODE.WRITE)
      const isTrunc = Boolean(pflags & OPEN_MODE.TRUNC)
      const isAppend = Boolean(pflags & OPEN_MODE.APPEND)
      const isCreat = Boolean(pflags & OPEN_MODE.CREAT)
      const isExcl = Boolean(pflags & OPEN_MODE.EXCL)
      if (isExcl && isCreat && exists) {
        return sftp.status(reqid, STATUS.FAILURE, 'SSH_FX_FILE_ALREADY_EXISTS')
      }
      let flags
      if (isRead && !isWrite) flags = 'r'
      else if (isWrite && !exists && isCreat) flags = 'w'
      else if (isWrite && isTrunc) flags = isRead ? 'w+' : 'w'
      else if (isWrite && isAppend) flags = 'a'
      else if (isWrite) flags = 'r+'
      else flags = 'r'
      try {
        const fd = openSync(realPath, flags)
        if (attrs && typeof attrs.mode === 'number') setModeReal(realPath, attrs.mode)
        const handle = mkHandle({ kind: 'file', fd, vpath, realPath, path: filename, flags })
        log('sftp-open', { path: vpath, flags, pflags })
        sftp.handle(reqid, handle)
      } catch (error) {
        fail(reqid, error)
      }
    })

    sftp.on('CLOSE', (reqid, rawHandle) => {
      const record = getHandle(rawHandle)
      if (!record) return sftp.status(reqid, STATUS.FAILURE, 'Unknown handle')
      handles.delete(record.id.toString('binary'))
      try {
        if (record.kind === 'file') closeSync(record.fd)
        sftp.status(reqid, STATUS.OK)
      } catch (error) {
        fail(reqid, error)
      }
    })

    sftp.on('READ', (reqid, rawHandle, offset, length) => {
      stats.sftpRequests += 1
      const record = getHandle(rawHandle)
      if (!record || record.kind !== 'file') return sftp.status(reqid, STATUS.FAILURE, 'Unknown handle')
      try {
        const size = fstatSync(record.fd).size
        if (offset >= size) return sftp.status(reqid, STATUS.EOF)
        const wanted = Math.min(length, size - offset)
        const buffer = Buffer.allocUnsafe(wanted)
        const bytesRead = readSync(record.fd, buffer, 0, wanted, offset)
        if (bytesRead <= 0) return sftp.status(reqid, STATUS.EOF)
        sftp.data(reqid, buffer.subarray(0, bytesRead))
      } catch (error) {
        fail(reqid, error)
      }
    })

    sftp.on('WRITE', (reqid, rawHandle, offset, data) => {
      stats.sftpRequests += 1
      const record = getHandle(rawHandle)
      if (!record || record.kind !== 'file') return sftp.status(reqid, STATUS.FAILURE, 'Unknown handle')
      try {
        let written = 0
        while (written < data.length) {
          written += writeSync(record.fd, data, written, data.length - written, offset + written)
        }
        sftp.status(reqid, STATUS.OK)
      } catch (error) {
        fail(reqid, error)
      }
    })

    sftp.on('LSTAT', (reqid, path) => {
      const { vpath, realPath } = resolve(path)
      if (withDeny(vpath, 'r', reqid)) return
      try {
        sftp.attrs(reqid, attrsOf(lstatSync(realPath), modeOfReal(realPath)))
      } catch (error) {
        fail(reqid, error)
      }
    })

    sftp.on('FSTAT', (reqid, rawHandle) => {
      const record = getHandle(rawHandle)
      if (!record) return sftp.status(reqid, STATUS.FAILURE, 'Unknown handle')
      try {
        if (record.kind === 'file') sftp.attrs(reqid, attrsOf(fstatSync(record.fd), modeOfReal(record.realPath)))
        else sftp.attrs(reqid, attrsOf(lstatSync(record.realPath), modeOfReal(record.realPath)))
      } catch (error) {
        fail(reqid, error)
      }
    })

    sftp.on('STAT', (reqid, path) => {
      const { vpath, realPath } = resolve(path)
      if (withDeny(vpath, 'r', reqid)) return
      try {
        sftp.attrs(reqid, attrsOf(statSync(realPath), modeOfReal(realPath)))
      } catch (error) {
        fail(reqid, error)
      }
    })

    sftp.on('SETSTAT', (reqid, path, attrs) => {
      const { vpath, realPath } = resolve(path)
      if (withDeny(vpath, 'w', reqid)) return
      applyAttrs(realPath, attrs, reqid)
    })

    sftp.on('FSETSTAT', (reqid, rawHandle, attrs) => {
      const record = getHandle(rawHandle)
      if (!record) return sftp.status(reqid, STATUS.FAILURE, 'Unknown handle')
      applyAttrs(record.realPath, attrs, reqid)
    })

    function applyAttrs(realPath, attrs, reqid) {
      try {
        if (!attrs) return sftp.status(reqid, STATUS.OK)
        if (typeof attrs.size === 'number') truncateSync(realPath, attrs.size)
        if (typeof attrs.mode === 'number' || typeof attrs.mode === 'string') {
          setModeReal(realPath, typeof attrs.mode === 'string' ? Number.parseInt(attrs.mode, 8) : attrs.mode)
        }
        if (typeof attrs.atime === 'number' && typeof attrs.mtime === 'number') {
          utimesSync(realPath, attrs.atime, attrs.mtime)
        }
        sftp.status(reqid, STATUS.OK)
      } catch (error) {
        fail(reqid, error)
      }
    }

    sftp.on('OPENDIR', (reqid, path) => {
      const { vpath, realPath } = resolve(path)
      if (withDeny(vpath, 'r', reqid)) return
      try {
        const names = readdirSync(realPath)
        const entries = names.map((name) => {
          const childReal = join(realPath, name)
          const st = lstatSync(childReal)
          return {
            filename: name,
            longname: longNameFor(name, st, modeOfReal(childReal, st)),
            attrs: attrsOf(st, modeOfReal(childReal, st)),
          }
        })
        const handle = mkHandle({ kind: 'dir', vpath, realPath, entries, position: 0 })
        log('sftp-opendir', { path: vpath, entries: entries.length })
        sftp.handle(reqid, handle)
      } catch (error) {
        fail(reqid, error)
      }
    })

    sftp.on('READDIR', (reqid, rawHandle) => {
      stats.sftpRequests += 1
      const record = getHandle(rawHandle)
      if (!record || record.kind !== 'dir') return sftp.status(reqid, STATUS.FAILURE, 'Unknown handle')
      const slice = record.entries.slice(record.position, record.position + batch)
      record.position += slice.length
      if (!slice.length) return sftp.status(reqid, STATUS.EOF)
      sftp.name(reqid, slice)
    })

    sftp.on('REMOVE', (reqid, path) => {
      const { vpath, realPath } = resolve(path)
      if (withDeny(vpath, 'w', reqid)) return
      try {
        if (lstatSync(realPath).isDirectory()) return sftp.status(reqid, STATUS.FAILURE, 'Is a directory')
        unlinkSync(realPath)
        log('sftp-remove', { path: vpath })
        sftp.status(reqid, STATUS.OK)
      } catch (error) {
        fail(reqid, error)
      }
    })

    sftp.on('MKDIR', (reqid, path, attrs) => {
      const { vpath, realPath } = resolve(path)
      if (withDeny(vpath, 'w', reqid)) return
      try {
        mkdirSync(realPath, { mode: attrs && typeof attrs.mode === 'number' ? attrs.mode : 0o755 })
        log('sftp-mkdir', { path: vpath })
        sftp.status(reqid, STATUS.OK)
      } catch (error) {
        fail(reqid, error)
      }
    })

    sftp.on('RMDIR', (reqid, path) => {
      const { vpath, realPath } = resolve(path)
      if (withDeny(vpath, 'w', reqid)) return
      try {
        rmdirSync(realPath)
        log('sftp-rmdir', { path: vpath })
        sftp.status(reqid, STATUS.OK)
      } catch (error) {
        fail(reqid, error)
      }
    })

    sftp.on('RENAME', (reqid, oldPath, newPath) => {
      const from = resolve(oldPath)
      const to = resolve(newPath)
      if (withDeny(from.vpath, 'w', reqid)) return
      try {
        renameSync(from.realPath, to.realPath)
        log('sftp-rename', { from: from.vpath, to: to.vpath })
        sftp.status(reqid, STATUS.OK)
      } catch (error) {
        fail(reqid, error)
      }
    })

    sftp.on('READLINK', (reqid, path) => {
      const { realPath } = resolve(path)
      try {
        sftp.name(reqid, readlinkSync(realPath))
      } catch (error) {
        fail(reqid, error)
      }
    })

    sftp.on('SYMLINK', (reqid, targetPath, linkPath) => {
      const link = resolve(linkPath)
      if (withDeny(link.vpath, 'w', reqid)) return
      try {
        symlinkSync(targetPath, link.realPath, 'file')
        sftp.status(reqid, STATUS.OK)
      } catch (error) {
        fail(reqid, error)
      }
    })

    sftp.on('REALPATH', (reqid, path) => {
      const { vpath } = resolve(path === '' ? '.' : path)
      // Chrooted servers answer with the virtual path -which is also what the
      // plugin surfaces in the UI.
      sftp.name(reqid, [{ filename: vpath, longname: vpath, attrs: {} }])
    })

    sftp.on('EXTENDED', (reqid, extName, extData) => {
      stats.sftpRequests += 1
      if (extName === 'posix-rename@openssh.com') {
        // uint32 id is consumed by ssh2; extData carries the two paths
        const text = extData.toString('utf8')
        const [oldPath, newPath] = text.split('\u0000')
        try {
          renameSync(resolve(oldPath).realPath, resolve(newPath).realPath)
          sftp.status(reqid, STATUS.OK)
        } catch (error) {
          fail(reqid, error)
        }
        return
      }
      log('sftp-extended-unsupported', { extName })
      sftp.status(reqid, STATUS.OP_UNSUPPORTED, `Unsupported extension ${extName}`)
    })

    sftp.on('close', () => {
      for (const record of handles.values()) {
        if (record.kind === 'file') {
          try {
            closeSync(record.fd)
          } catch {
            /* already closed */
          }
        }
      }
      handles.clear()
    })

    sftp.on('error', (error) => log('sftp-error-event', { message: String(error && error.message) }))
  }

  // --- handle -------------------------------------------------------------

  const baseConfig = {
    host: settings.host,
    port,
    username: user,
    readyTimeout: settings.readyTimeout ?? 20000,
  }

  const serverHandle = {
    host: settings.host,
    port,
    ident: settings.ident,
    banner: settings.banner,
    user,
    password,
    keyPassphrase: settings.keyPassphrase ?? 'keypass',
    root,
    home,
    sandbox,
    hostname: settings.hostname,
    // host identity
    hostKey: hostPrivatePem,
    hostKeyFile,
    hostKeyType: hostPublic.keyType,
    hostKeyBlob: hostPublic.blob,
    hostKeyFingerprint: fingerprint(hostPublic.keyType, hostPublic.blob),
    knownHostsLine: knownHostsLine(settings.host, port, hostPublic.keyType, hostPublic.blob),
    // user identity
    userPrivateKey: userKeyPair.private,
    userPublicKey: userKeyPair.public,
    userKeyType,
    userKeyBlob: userPublicBlob,
    userKeyFingerprint: fingerprint(userKeyType, userPublicBlob),
    userEncryptedPrivateKey: encryptedUserKeyPair.private,
    identityFile,
    identityFileEncrypted,
    // ready-to-use ssh2 client configs
    config: { ...baseConfig, password, algorithms: undefined },
    keyConfig: { ...baseConfig, privateKey: userKeyPair.private },
    /** Canonical host+port string used by known_hosts / profile forms. */
    get target() {
      return `${settings.host}:${port}`
    },
    stats,
    events,
    log,
    // ---- mutation helpers used by failure-injection tests ----
    setAllowedMethods(methods) {
      allowedMethods = [...methods]
    },
    getAllowedMethods() {
      return [...allowedMethods]
    },
    denyPath(vpath, flags = 'rw') {
      denied.set(sandbox.normalize(vpath), flags)
      stats.deniedPaths.push({ path: vpath, flags })
    },
    allowPath(vpath) {
      denied.delete(sandbox.normalize(vpath))
    },
    /** Destroy every live TCP socket -clients see ECONNRESET. */
    dropAll() {
      log('drop-all', { sockets: sockets.size })
      for (const socket of sockets) socket.destroy()
      sockets.clear()
    },
    /** Pause every socket: the link looks dead, keepalives are never answered. */
    freeze() {
      for (const socket of sockets) socket.pause()
      log('freeze', { sockets: sockets.size })
    },
    unfreeze() {
      for (const socket of sockets) socket.resume()
      log('unfreeze', { sockets: sockets.size })
    },
    /** Wait until in-flight exec/shell runs finish (used before assertions). */
    async waitForIdle(timeout = 5000) {
      const deadline = Date.now() + timeout
      while (runs.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
      return runs.size === 0
    },
    snapshotStats() {
      return JSON.parse(JSON.stringify(stats))
    },
    /** Connect a plain ssh2 client (utility for the other test layers). */
    async connect(overrides = {}) {
      const client = new Client()
      // A dropped test connection is expected in several failure-injection tests;
      // this listener only stops Node from turning it into an uncaughtException.
      // Callers that care still add their own 'error' handler.
      client.on('error', () => {})
      const config = { ...serverHandle.config, ...overrides }
      await new Promise((resolve, reject) => {
        client.once('ready', resolve)
        client.once('error', reject)
        client.connect(config)
      })
      return client
    },
    /** One-shot exec: connect, run, collect, disconnect. */
    async execOnce(command, overrides = {}) {
      const client = await serverHandle.connect(overrides)
      try {
        return await collectExec(client, command)
      } finally {
        client.end()
      }
    },
    async stop() {
      if (stopped) return
      stopped = true
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      for (const client of connections) {
        try {
          client.end()
        } catch {
          /* already gone */
        }
      }
      connections.clear()
      for (const session of sessions) session.shell?.close()
      sessions.clear()
      await new Promise((resolve) => tcpServer.close(() => resolve()))
      log('stop', {})
      const cleaned = keepRoot ? false : removeTempRoot(root)
      return { root, cleaned }
    },
  }

  log('start', { port, root, user })
  return serverHandle
}

/** Run `fn(server)` against a started double and always stop it. */
export async function withSshd(fn, options = {}) {
  const server = await startSshd(options)
  try {
    return await fn(server)
  } finally {
    await server.stop()
  }
}

/** Collect one exec into `{ stdout, stderr, code, signal }` (integration helper). */
export function collectExec(client, command, options = {}) {
  return new Promise((resolve, reject) => {
    client.exec(command, options, (error, stream) => {
      if (error) return reject(error)
      const stdout = []
      const stderr = []
      let code = null
      let signal
      stream.on('data', (chunk) => stdout.push(chunk))
      stream.stderr.on('data', (chunk) => stderr.push(chunk))
      stream.on('exit', (exitCode, exitSignal) => {
        code = exitCode
        signal = exitSignal
      })
      stream.on('close', () => {
        resolve({
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          stdoutBuffer: Buffer.concat(stdout),
          code,
          signal,
        })
      })
      stream.on('error', reject)
    })
  })
}

/** Run one SFTP operation against a live client (integration helper). */
export function withSftp(client, fn) {
  return new Promise((resolve, reject) => {
    client.sftp(async (error, sftp) => {
      if (error) return reject(error)
      try {
        resolve(await fn(sftp))
      } catch (thrown) {
        reject(thrown)
      } finally {
        try {
          sftp.end()
        } catch {
          /* already closed */
        }
      }
    })
  })
}
