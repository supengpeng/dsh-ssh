/**
 * The one place that talks to `ssh2`'s `Client`.
 *
 * Responsibilities: dial with the effective timeouts/keepalive settings, run the
 * host-key policy, classify every failure into an ICD §5 code, open exec/shell/
 * SFTP channels on the live connection, and close it gracefully.
 *
 * Deliberate omission: `ssh2`'s `debug` hook is **not** wired to the plugin
 * logger. Its packet dumps can contain authentication data in binary form, which
 * neither key-name nor literal-value redaction can catch; a logger that leaks a
 * password is worse than a quiet handshake.
 */

import { createHash } from 'node:crypto'

import type { ConnectConfig, NegotiatedAlgorithms, PseudoTtyOptions, SFTPWrapper } from 'ssh2'

import type { ResolvedConfig } from '../config.js'
import { SshError } from '../protocol.js'
import type { HostKeyPolicy } from '../protocol.js'
import type { AuthPlan } from './auth.js'
import { classifyError, readHostKeyType } from './errors.js'
import type {
  ClientChannelPort,
  HostKeyQuestion,
  KnownHostsVerifierPort,
  LoggerPort,
  ResolvedProfile,
  SshClientPort,
} from './types.js'

/** Default PTY geometry, matching the ICD's `openShell` defaults. */
export const DEFAULT_TERM = 'xterm-256color'
export const DEFAULT_COLS = 80
export const DEFAULT_ROWS = 24

/** How long a graceful `close()` waits for the peer before tearing the socket down. */
const GRACEFUL_CLOSE_MS = 3000

export interface TransportOpenOptions {
  profile: ResolvedProfile
  config: ResolvedConfig
  auth: AuthPlan
  logger: LoggerPort
  createClient: () => SshClientPort
  knownHosts?: KnownHostsVerifierPort | undefined
  onHostKeyPrompt?: ((q: HostKeyQuestion) => Promise<'accept' | 'reject'>) | undefined
  /** Called once the key exchange finished and authentication begins. */
  onHandshake?: (() => void) | undefined
  /** Called when the connection is established. */
  onReady?: (() => void) | undefined
  /** Host key facts observed during verification (for `testProfile`). */
  onHostKeyDecision?: ((info: HostKeyDecision) => void) | undefined
  /** Round-trip samples observed while opening channels. */
  onRttSample?: ((ms: number) => void) | undefined
  /** Called when the connection dies after `openTransport` resolved. */
  onClosed?: ((error: SshError | undefined) => void) | undefined
  signal?: AbortSignal | undefined
  now?: (() => number) | undefined
}

export interface ExecChannelOptions {
  env?: Record<string, string> | undefined
  pty?: PseudoTtyOptions | undefined
}

export interface ShellChannelOptions {
  term?: string | undefined
  cols?: number | undefined
  rows?: number | undefined
  env?: Record<string, string> | undefined
}

export interface Transport {
  readonly client: SshClientPort
  /** TCP + handshake + authentication duration, measured locally. */
  readonly connectMs: number
  readonly banner: string | undefined
  readonly negotiated: NegotiatedAlgorithms | undefined
  /** `SHA256:` fingerprint of the accepted host key (ICD §7.3). */
  readonly hostKeyFingerprint: string | undefined
  readonly closed: boolean
  exec(command: string, options?: ExecChannelOptions): Promise<ClientChannelPort>
  shell(options?: ShellChannelOptions): Promise<ClientChannelPort>
  sftp(): Promise<SFTPWrapper>
  close(options?: { force?: boolean; reason?: string }): Promise<void>
}

/** Host key facts recorded during verification. */
export interface HostKeyDecision {
  keyType: string
  fingerprint: string
  knownHostsMatch: 'unknown' | 'exact' | 'changed'
  accepted: boolean
}

/**
 * `SHA256:` + base64(sha256(blob)) without padding — byte-identical to
 * `ssh-keygen -lf` (ICD §7.3). Used when no verifier is injected.
 */
export function sshFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

/** Effective per-profile value with a config fallback. */
function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback
}

export function effectiveTimeouts(
  profile: ResolvedProfile,
  config: ResolvedConfig,
): { connectTimeoutMs: number; keepaliveIntervalMs: number; keepaliveCountMax: number } {
  return {
    connectTimeoutMs: positive(profile.connectTimeoutMs, config.connectTimeoutMs),
    keepaliveIntervalMs: positive(profile.keepaliveIntervalMs, config.keepaliveIntervalMs),
    keepaliveCountMax:
      typeof profile.keepaliveCountMax === 'number' && Number.isFinite(profile.keepaliveCountMax) && profile.keepaliveCountMax >= 0
        ? Math.trunc(profile.keepaliveCountMax)
        : config.keepaliveCountMax,
  }
}

/**
 * Host-key policy decision (ICD §6 `hostKey.policy`).
 *
 * `insecure` accepts anything; `strict` refuses an unknown key; `accept-new`
 * trusts on first use *and* still asks about a changed key — a mismatch is never
 * silently accepted, because that is the whole point of the check.
 */
export async function decideHostKey(
  key: Buffer,
  context: {
    host: string
    port: number
    policy: HostKeyPolicy
    knownHosts?: KnownHostsVerifierPort | undefined
    onHostKeyPrompt?: ((q: HostKeyQuestion) => Promise<'accept' | 'reject'>) | undefined
    onDecision?: ((info: HostKeyDecision) => void) | undefined
    logger: LoggerPort
  },
): Promise<boolean> {
  const { host, port, policy, knownHosts, onHostKeyPrompt, logger } = context
  const keyType = readHostKeyType(key)
  const fingerprint = fingerprintOf(knownHosts, keyType, key)

  const report = (info: HostKeyDecision): void => {
    try {
      context.onDecision?.(info)
    } catch {
      /* a diagnostic hook must never break the handshake */
    }
  }

  if (policy === 'insecure') {
    report({ keyType, fingerprint, knownHostsMatch: 'unknown', accepted: true })
    return true
  }

  if (knownHosts === undefined) {
    if (policy === 'strict') {
      throw new SshError('SSH_HOSTKEY_UNKNOWN', `no known_hosts verifier is configured; refusing to trust ${host}:${port}`, {
        details: { host, port, keyType, policy, fingerprint },
      })
    }
    // Degraded but documented: without a verifier there is nothing to compare
    // against, and `accept-new` is trust-on-first-use by definition.
    logger.warn(`host key verification is degraded (no known_hosts verifier): accepting ${host}:${port} [${keyType}]`)
    report({ keyType, fingerprint, knownHostsMatch: 'unknown', accepted: true })
    return true
  }

  const verdict = await knownHosts.verify({ host, port, keyType, key, policy })
  if (verdict.ok) {
    // SP4's verifier already persists a first-seen key under `accept-new`.
    report({ keyType, fingerprint, knownHostsMatch: 'exact', accepted: true })
    return true
  }

  // `@revoked` is the operator's explicit "never trust this key", so it is a hard
  // failure like OpenSSH's — never the ICD §4.3 question. Offering the prompt
  // would let a user accept a revoked key for the session (and the accept path
  // below would then remember it), which is exactly what revocation forbids.
  //
  // The flag is declared (optionally) on the port's negative branch in
  // ./types.ts, so no narrowing view is needed here; it stays optional there
  // because the shared test doubles have no `@revoked` notion at all.
  if (verdict.revoked === true) {
    const revoked: HostKeyQuestion = {
      host,
      port,
      keyType,
      fingerprint: verdict.fingerprint === '' ? fingerprint : verdict.fingerprint,
      knownHostsMatch: verdict.knownHostsMatch === 'changed' ? 'changed' : 'unknown',
    }
    report({ keyType, fingerprint: revoked.fingerprint, knownHostsMatch: revoked.knownHostsMatch, accepted: false })
    logger.error(`host key for ${host}:${port} is @revoked in known_hosts; refusing without prompting`)
    throw hostKeyRejection(
      verdict.code,
      verdict.knownHostsMatch,
      revoked,
      '@revoked',
      undefined,
      `the host key of ${host}:${port} is marked @revoked in known_hosts`,
    )
  }

  const question: HostKeyQuestion = {
    host,
    port,
    keyType,
    fingerprint: verdict.fingerprint === '' ? fingerprint : verdict.fingerprint,
    knownHostsMatch: verdict.knownHostsMatch === 'changed' ? 'changed' : 'unknown',
  }

  if (onHostKeyPrompt === undefined) {
    report({ keyType, fingerprint: question.fingerprint, knownHostsMatch: question.knownHostsMatch, accepted: false })
    throw hostKeyRejection(verdict.code, verdict.knownHostsMatch, question, 'no prompt handler')
  }

  let answer: 'accept' | 'reject'
  try {
    answer = await onHostKeyPrompt(question)
  } catch (error) {
    report({ keyType, fingerprint: question.fingerprint, knownHostsMatch: question.knownHostsMatch, accepted: false })
    throw hostKeyRejection(verdict.code, verdict.knownHostsMatch, question, 'prompt failed', error)
  }
  if (answer !== 'accept') {
    report({ keyType, fingerprint: question.fingerprint, knownHostsMatch: question.knownHostsMatch, accepted: false })
    throw hostKeyRejection(verdict.code, verdict.knownHostsMatch, question, 'rejected by user')
  }

  if (verdict.knownHostsMatch === 'unknown' && policy === 'accept-new') {
    try {
      await knownHosts.remember({ host, port, keyType, key })
    } catch (error) {
      // The connection is already trusted for this session; a failed write must
      // not abort it, but it must be visible.
      logger.warn(`could not update known_hosts for ${host}:${port}: ${errorMessage(error)}`)
    }
  } else {
    logger.info(`host key for ${host}:${port} accepted for this session only (${verdict.knownHostsMatch}, policy ${policy})`)
  }
  report({ keyType, fingerprint: question.fingerprint, knownHostsMatch: question.knownHostsMatch, accepted: true })
  return true
}

/** Best-effort fingerprint: the verifier's own helper, else the ICD formula. */
function fingerprintOf(knownHosts: KnownHostsVerifierPort | undefined, keyType: string, key: Buffer): string {
  if (knownHosts !== undefined) {
    try {
      const value = knownHosts.fingerprint(keyType, key)
      if (typeof value === 'string' && value !== '') return value
    } catch {
      /* fall through to the local implementation */
    }
  }
  return sshFingerprint(key)
}

function hostKeyRejection(
  code: 'SSH_HOSTKEY_UNKNOWN' | 'SSH_HOSTKEY_MISMATCH',
  match: 'unknown' | 'exact' | 'changed',
  question: HostKeyQuestion,
  reason: string,
  cause?: unknown,
  /**
   * Overrides the generic message. Used by the `@revoked` refusal so the audit
   * line (which records `code` and `message`, not `details`) says *why* the key
   * was refused; every other caller keeps the shared wording, and no caller
   * passes anything but host, port and prose here.
   */
  message?: string,
): SshError {
  const text =
    message ??
    (code === 'SSH_HOSTKEY_MISMATCH'
      ? `the host key of ${question.host}:${question.port} does not match known_hosts`
      : `the host key of ${question.host}:${question.port} is not in known_hosts`)
  return new SshError(code, text, {
    details: {
      host: question.host,
      port: question.port,
      keyType: question.keyType,
      fingerprint: question.fingerprint,
      knownHostsMatch: match,
      reason,
    },
    ...(cause === undefined ? {} : { cause }),
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Open a connection and resolve once it is authenticated and ready. */
export async function openTransport(options: TransportOpenOptions): Promise<Transport> {
  const { profile, config, auth, logger, createClient } = options
  const now = options.now ?? (() => Date.now())
  const policy: HostKeyPolicy = profile.hostKeyPolicy ?? config.hostKey.policy
  const timeouts = effectiveTimeouts(profile, config)
  const client = createClient()

  let hostKeyFailure: SshError | undefined
  let hostKeyFingerprint: string | undefined
  let banner: string | undefined
  let negotiated: NegotiatedAlgorithms | undefined
  let closed = false
  let closing = false
  let connectError: SshError | undefined
  const startedAt = now()

  const abortSignal = options.signal

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: SshError): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error === undefined) resolve()
      else reject(error)
    }
    const onAbort = (): void => {
      const reason = abortSignal?.reason
      finish(new SshError('SSH_CANCELLED', 'connection attempt cancelled', { cause: reason }))
      try {
        client.destroy()
      } catch {
        /* the socket may already be gone */
      }
    }
    const onReadyEvent = (): void => finish()
    const onErrorEvent = (error: unknown): void => {
      const classified = classifyError(error, {
        phase: 'connect',
        auth: auth.kind,
        hostKeyError: hostKeyFailure,
        host: profile.host,
        port: profile.port,
      })
      const sshError = new SshError(classified.code, classified.message, {
        ...(classified.details === undefined ? {} : { details: classified.details }),
        cause: classified.cause,
      })
      connectError = sshError
      finish(sshError)
    }
    const onCloseBeforeReady = (): void => {
      finish(
        connectError ??
          new SshError('SSH_NET_RESET', 'the connection closed before it became ready', {
            details: { host: profile.host, port: profile.port },
          }),
      )
    }
    const cleanup = (): void => {
      abortSignal?.removeEventListener('abort', onAbort)
    }

    client.on('banner', (message: unknown) => {
      // ssh2 hands the banner over verbatim, including its trailing CRLF.
      if (typeof message === 'string' && message.trim() !== '') banner = message.replace(/[\r\n]+$/, '')
    })
    client.on('handshake', (algorithms: unknown) => {
      if (algorithms !== null && typeof algorithms === 'object') negotiated = algorithms as NegotiatedAlgorithms
      options.onHandshake?.()
    })
    client.on('ready', onReadyEvent)
    client.on('error', onErrorEvent)
    client.on('close', onCloseBeforeReady)
    abortSignal?.addEventListener('abort', onAbort, { once: true })

    const connectConfig: ConnectConfig = {
      host: profile.host,
      port: profile.port,
      ...auth.config,
      readyTimeout: timeouts.connectTimeoutMs,
      keepaliveInterval: timeouts.keepaliveIntervalMs,
      keepaliveCountMax: timeouts.keepaliveCountMax,
      // `hostHash` is intentionally not set: the verifier needs the raw key blob
      // to derive the algorithm name and the SHA256 fingerprint (ICD §7.3).
      hostVerifier: (key: Buffer, verify: (ok: boolean) => void): void => {
        void decideHostKey(key, {
          host: profile.host,
          port: profile.port,
          policy,
          knownHosts: options.knownHosts,
          onHostKeyPrompt: options.onHostKeyPrompt,
          logger,
          onDecision: (info) => {
            if (info.accepted) hostKeyFingerprint = info.fingerprint
            options.onHostKeyDecision?.(info)
          },
        })
          .then((ok) => verify(ok))
          .catch((error: unknown) => {
            hostKeyFailure =
              error instanceof SshError
                ? error
                : new SshError('SSH_HOSTKEY_MISMATCH', 'host key verification failed', { cause: error })
            verify(false)
          })
      },
    }

    try {
      client.connect(connectConfig)
    } catch (error) {
      onErrorEvent(error)
    }

    if (abortSignal?.aborted === true) onAbort()
  })

  const connectMs = Math.max(0, now() - startedAt)
  options.onReady?.()
  logger.info(
    `connected to ${profile.user}@${profile.host}:${profile.port} in ${connectMs}ms ` +
      `(auth=${auth.describe()}, hostKey=${policy})`,
  )

  // After `ready`, the pre-ready listeners are replaced by link-death reporting.
  client.on('error', (error: unknown) => {
    if (closing || closed) return
    const classified = classifyError(error, {
      phase: 'runtime',
      auth: auth.kind,
      host: profile.host,
      port: profile.port,
    })
    options.onClosed?.(new SshError(classified.code, classified.message, { cause: classified.cause }))
  })
  client.on('close', () => {
    if (closed) return
    closed = true
    if (closing) return
    options.onClosed?.(
      new SshError('SSH_NET_RESET', `the connection to ${profile.host}:${profile.port} was closed by the peer`, {
        details: { host: profile.host, port: profile.port },
      }),
    )
  })

  const rttSample = (started: number): void => {
    const elapsed = now() - started
    if (elapsed >= 0) options.onRttSample?.(elapsed)
    logger.debug(`channel opened on ${profile.host}:${profile.port} in ${elapsed}ms`)
  }

  return {
    client,
    connectMs,
    get banner() {
      return banner
    },
    get negotiated() {
      return negotiated
    },
    get hostKeyFingerprint() {
      return hostKeyFingerprint
    },
    get closed() {
      return closed
    },

    exec(command, execOptions = {}) {
      return new Promise<ClientChannelPort>((resolve, reject) => {
        const started = now()
        const execConfig = {
          ...(execOptions.env === undefined ? {} : { env: execOptions.env }),
          ...(execOptions.pty === undefined ? {} : { pty: execOptions.pty }),
        }
        let timer: NodeJS.Timeout | undefined
        try {
          client.exec(command, execConfig, (error, channel) => {
            if (timer !== undefined) clearTimeout(timer)
            if (error !== undefined) {
              reject(toChannelError(error, 'exec', profile))
              return
            }
            rttSample(started)
            resolve(channel)
          })
          timer = channelTimeout(config, () => reject(channelTimeoutError('exec', profile)))
        } catch (error) {
          if (timer !== undefined) clearTimeout(timer)
          reject(toChannelError(error, 'exec', profile))
        }
      })
    },

    shell(shellOptions = {}) {
      return new Promise<ClientChannelPort>((resolve, reject) => {
        const started = now()
        const pty: PseudoTtyOptions = {
          term: shellOptions.term ?? DEFAULT_TERM,
          cols: positive(shellOptions.cols, DEFAULT_COLS),
          rows: positive(shellOptions.rows, DEFAULT_ROWS),
          width: 0,
          height: 0,
        }
        let timer: NodeJS.Timeout | undefined
        try {
          client.shell(pty, { ...(shellOptions.env === undefined ? {} : { env: shellOptions.env }) }, (error, channel) => {
            if (timer !== undefined) clearTimeout(timer)
            if (error !== undefined) {
              reject(toChannelError(error, 'shell', profile))
              return
            }
            rttSample(started)
            resolve(channel)
          })
          timer = channelTimeout(config, () => reject(channelTimeoutError('shell', profile)))
        } catch (error) {
          if (timer !== undefined) clearTimeout(timer)
          reject(toChannelError(error, 'shell', profile))
        }
      })
    },

    sftp() {
      return new Promise<SFTPWrapper>((resolve, reject) => {
        const started = now()
        let timer: NodeJS.Timeout | undefined
        try {
          client.sftp((error, sftp) => {
            if (timer !== undefined) clearTimeout(timer)
            if (error !== undefined) {
              reject(
                toChannelError(error, 'sftp', profile, 'SSH_SFTP_PROTOCOL'),
              )
              return
            }
            rttSample(started)
            resolve(sftp)
          })
          timer = channelTimeout(config, () =>
            reject(
              new SshError('SSH_TIMEOUT_OPERATION', 'timed out while opening the SFTP subsystem', {
                details: { host: profile.host, port: profile.port, op: 'sftp' },
              }),
            ),
          )
        } catch (error) {
          if (timer !== undefined) clearTimeout(timer)
          reject(toChannelError(error, 'sftp', profile, 'SSH_SFTP_PROTOCOL'))
        }
      })
    },

    async close(closeOptions = {}) {
      if (closed) return
      closing = true
      if (closeOptions.force === true) {
        try {
          client.destroy()
        } catch {
          /* ignore */
        }
        closed = true
        return
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          logger.warn(`graceful close timed out for ${profile.host}:${profile.port}; destroying the socket`)
          try {
            client.destroy()
          } catch {
            /* ignore */
          }
          resolve()
        }, GRACEFUL_CLOSE_MS)
        timer.unref?.()
        client.on('close', () => {
          clearTimeout(timer)
          resolve()
        })
        try {
          client.end()
        } catch {
          clearTimeout(timer)
          resolve()
        }
      })
      closed = true
    },
  }
}

/** Channel-open failure: never let a raw ssh2 error escape unclassified. */
function toChannelError(
  error: unknown,
  op: 'exec' | 'shell' | 'sftp',
  profile: ResolvedProfile,
  fallbackCode?: 'SSH_SFTP_PROTOCOL',
): SshError {
  const classified = classifyError(error, { phase: 'runtime', host: profile.host, port: profile.port })
  // An sftp channel that will not open is an SFTP-subsystem problem (the ICD has
  // a dedicated code for it) unless the classifier already produced a specific
  // SFTP code of its own.
  const code =
    fallbackCode !== undefined && !String(classified.code).startsWith('SSH_SFTP_') ? fallbackCode : classified.code
  const message =
    code === fallbackCode || classified.code === 'SSH_UNKNOWN'
      ? `could not open a ${op} channel on ${profile.host}:${profile.port}: ${classified.message}`
      : classified.message
  return new SshError(code, message, {
    ...(classified.details === undefined ? {} : { details: { ...classified.details, op } }),
    cause: classified.cause,
  })
}

function channelTimeout(config: ResolvedConfig, onTimeout: () => void): NodeJS.Timeout {
  const timer = setTimeout(onTimeout, Math.max(1000, config.operationTimeoutMs))
  timer.unref?.()
  return timer
}

function channelTimeoutError(op: string, profile: ResolvedProfile): SshError {
  return new SshError('SSH_TIMEOUT_OPERATION', `timed out while opening a ${op} channel`, {
    details: { host: profile.host, port: profile.port, op },
  })
}

/** Compose `cwd`/`env` into a single remote command (ICD §4.4). */
export function composeRemoteCommand(
  command: string,
  cwd: string | undefined,
  env: Record<string, string> | undefined,
): { command: string; env: Record<string, string> | undefined } {
  const assignments =
    env === undefined || Object.keys(env).length === 0
      ? ''
      : Object.entries(env)
          .map(([key, value]) => `${key}=${shellQuote(value)} `)
          .join('')
  const body = `${assignments}${command}`
  if (cwd === undefined || cwd === '') return { command: body, env }
  // ssh2 does not implement `cwd` for exec channels; prefixing `cd --` keeps the
  // behaviour identical for every server and is what the shell offers anyway.
  return { command: `cd -- ${shellQuote(cwd)} && ${body}`, env }
}

/** POSIX single-quote escaping: `'` → `'\''`. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** Message used by `SessionHandle.close({reason})` logging; exported for tests. */
export function closeReason(options: { force?: boolean; reason?: string } | undefined): string {
  if (options?.reason !== undefined && options.reason !== '') return options.reason
  return options?.force === true ? 'forced close' : 'close requested'
}
