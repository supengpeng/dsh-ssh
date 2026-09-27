/**
 * Host-half harness: drives the *real* connection/exec/SFTP modules against the
 * local sshd double (`sshd.mjs`).
 *
 * The integration, E2E and perf layers all need the same wiring, and they must
 * exercise the frozen ICD §7 face (`createConnectionPool().acquire()` →
 * `SessionHandle.exec()/shell()/sftp()`) rather than reaching into module
 * internals — that is what makes these tests evidence that the *shipped* seams
 * work, not that a private helper does.
 *
 * Everything is imported from `lib/**` (the built output): the tests therefore
 * verify what the plugin actually runs.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createConnectionPool } from '../../lib/connection/index.js'
import { createKnownHostsVerifier } from '../../lib/known-hosts.js'
import { createSftpProvider } from '../../lib/sftp/index.js'

/** Effective plugin configuration (mirrors `ResolvedConfig`, ICD §6 defaults). */
export function makeConfig(overrides = {}) {
  const dir = overrides.dir ?? mkdtempSync(join(tmpdir(), 'dsh-ssh-host-'))
  const base = {
    dir,
    profilesFile: join(dir, 'profiles.json'),
    auditFile: join(dir, 'audit.jsonl'),
    maxSessions: 10,
    maxConcurrentOpsPerSession: 4,
    maxOutputBytes: 262144,
    connectTimeoutMs: 15000,
    operationTimeoutMs: 120000,
    graceKillMs: 3000,
    keepaliveIntervalMs: 20000,
    keepaliveCountMax: 3,
    retries: { max: 0, backoffBaseMs: 1, backoffMaxMs: 2, jitter: false },
    hostKey: { policy: 'insecure', knownHostsFile: join(dir, 'known_hosts') },
    sftp: {
      chunkBytes: 262144,
      maxConcurrentChunks: 4,
      resume: true,
      verify: 'size+mtime',
      followSymlinks: false,
      progressIntervalMs: 200,
    },
    secrets: { provider: 'credentials', envPrefix: 'DSH_SSH_' },
    logging: { level: 'error', redact: true, redactKeys: ['password', 'passphrase', 'privateKey'] },
    ui: { defaultWidthPx: 420, locale: 'auto', terminalFontSize: 13, reconnectAttempts: 5 },
    maxLocalBytes: 1024 * 1024 * 1024,
  }
  return {
    ...base,
    ...overrides,
    retries: { ...base.retries, ...(overrides.retries ?? {}) },
    hostKey: { ...base.hostKey, ...(overrides.hostKey ?? {}) },
    sftp: { ...base.sftp, ...(overrides.sftp ?? {}) },
    logging: { ...base.logging, ...(overrides.logging ?? {}) },
    ui: { ...base.ui, ...(overrides.ui ?? {}) },
  }
}

/** Collects everything the plugin would log; credential leaks are assertable. */
export function memoryLogger() {
  const lines = []
  const push = (level) => (message, fields) => lines.push({ level, message: String(message), fields })
  return {
    lines,
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    text: () => lines.map((line) => `${line.level}: ${line.message}`).join('\n'),
  }
}

/** Redactor double: enough to prove nothing scrubbed is missing from logs. */
export function trackingRedactor() {
  const tracked = new Set()
  const scrubValue = (value) => {
    if (typeof value === 'string') {
      let out = value
      for (const secret of tracked) out = out.split(secret).join('••••••••')
      return out
    }
    if (Array.isArray(value)) return value.map(scrubValue)
    if (value && typeof value === 'object') {
      const out = {}
      for (const [key, nested] of Object.entries(value)) out[key] = scrubValue(nested)
      return out
    }
    return value
  }
  return {
    tracked,
    track(secret) {
      if (typeof secret === 'string' && secret) tracked.add(secret)
    },
    forgetAll: () => tracked.clear(),
    scrub: (value) => scrubValue(value),
  }
}

/**
 * A `ResolvedProfile` (ICD §7) pointing at the double.
 *
 * Defaults to password auth + `insecure` host-key policy so tests that are not
 * about host keys are not forced through known_hosts; pass `overrides` to change
 * any of it (`auth: 'privateKey'`, `secrets: { privateKeyPath }`, policies…).
 */
export function makeProfile(server, overrides = {}) {
  return {
    id: overrides.id ?? `p_${Math.random().toString(36).slice(2, 10)}`,
    name: overrides.name ?? 'sshd-double',
    host: server.host,
    port: server.port,
    user: server.user,
    auth: 'password',
    secretRefs: {},
    connectTimeoutMs: 8000,
    keepaliveIntervalMs: 0,
    keepaliveCountMax: -1,
    retries: { max: 0, backoffBaseMs: 1, backoffMaxMs: 2, jitter: false },
    hostKeyPolicy: 'insecure',
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    secrets: { password: server.password },
    ...overrides,
  }
}

/** A temporary directory that is removed when the test ends. */
export function makeTmpDir(t, prefix = 'dsh-ssh-it-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort on Windows */
    }
  })
  return dir
}

/**
 * Build a connection pool wired to the real modules (SFTP provider included) and
 * register its teardown on the test context.
 */
export function openPool(t, options = {}) {
  const dir = options.dir ?? makeTmpDir(t)
  const config = options.config ?? makeConfig({ dir, ...(options.configOverrides ?? {}) })
  const logger = options.logger ?? memoryLogger()
  const redactor = options.redactor ?? trackingRedactor()
  const knownHosts =
    options.knownHosts ??
    createKnownHostsVerifier({
      file: config.hostKey.knownHostsFile,
      policy: config.hostKey.policy,
      hashKnownHosts: false,
    })
  const pool = createConnectionPool({
    config,
    logger,
    redactor,
    knownHosts,
    sftp: createSftpProvider({ logger }),
    env: options.env ?? {},
    platform: options.platform ?? process.platform,
    random: () => 0.5,
    sleep: async () => {},
  })
  t.after(async () => {
    await pool.disposeAll('test teardown')
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  })
  return { pool, config, logger, redactor, knownHosts, dir }
}

/** Acquire a session and register its teardown. */
export async function acquireSession(t, pool, profile) {
  const session = await pool.acquire({ profile })
  t.after(async () => {
    try {
      await session.close({ reason: 'test teardown' })
    } catch {
      /* already closed */
    }
  })
  return session
}

/**
 * Await an `ExecHandle` to completion, collecting both channels.
 * @returns {Promise<{stdout: string, stderr: string, stdoutBuffer: Buffer, exit: object}>}
 */
export function collectExecHandle(handle) {
  return new Promise((resolve, reject) => {
    const out = []
    const err = []
    const timeout = setTimeout(() => reject(new Error('exec handle never exited (30s)')), 30_000)
    handle.onData((channel, chunk) => {
      if (channel === 'stderr') err.push(chunk)
      else out.push(chunk)
    })
    handle.onExit((exit) => {
      clearTimeout(timeout)
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        stdoutBuffer: Buffer.concat(out),
        stderrBuffer: Buffer.concat(err),
        exit,
      })
    })
  })
}

/** Collect a readable stream into a Buffer. */
export function collectStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = []
    stream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })
}

/** Write a Buffer through a Node writable stream, resolving on 'close'. */
export function writeStream(stream, buffer) {
  return new Promise((resolve, reject) => {
    stream.on('error', reject)
    stream.on('close', resolve)
    stream.end(buffer)
  })
}
