/**
 * `ConnectionPool` implementation (ICD §7.1).
 *
 * Guarantees:
 *  - **reuse**: one live session per profile key unless `forceNew` is set;
 *  - **single-flight**: concurrent acquires for the same key share one dial;
 *  - **limit**: `maxSessions` counts *live* connections (a dead session keeps its
 *    registry entry so the user can see it and close it, but it does not hold a
 *    slot forever);
 *  - **retry**: every failure is classified into an ICD §5 code first, then the
 *    retry policy decides — auth/host-key failures are never replayed;
 *  - **hygiene**: credentials only ever exist inside the ssh2 connect config;
 *    every log line and error detail passes through the redactor.
 */

import type { ResolvedConfig, RetryConfig } from '../config.js'
import { isRetryable, SshError } from '../protocol.js'
import type { ErrorInfo, SessionState, SshErrorCode } from '../protocol.js'
import type { SessionRegistry } from '../sessions.js'
import { planAuth, resolveProfileSecrets } from './auth.js'
import { classifyError, type ClassifiedError } from './errors.js'
import { newSessionId } from './ids.js'
import { defaultSleep, withRetry } from './retry.js'
import { stripSecrets } from './scrub.js'
import { SshSession } from './session.js'
// Default import: `ssh2` is CommonJS and `Client` happens to be visible as a
// named export while `utils`/`Server` are not; the default is always complete.
import ssh2 from 'ssh2'
import type {
  AcquireInput,
  ConnectionPool,
  LoggerPort,
  PoolOptions,
  RedactorPort,
  ResolvedProfile,
  SessionHandle,
  SessionId,
  SshClientPort,
} from './types.js'

const FALLBACK_LOGGER: LoggerPort = {
  debug: () => {},
  info: (message) => console.info(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
}

function safeLogger(base: LoggerPort, redactor: RedactorPort | undefined): LoggerPort {
  if (redactor === undefined) return base
  const scrub = (message: string): string => {
    try {
      return String(redactor.scrub(message))
    } catch {
      return '[redaction failed]'
    }
  }
  return {
    debug: (message) => base.debug(scrub(message)),
    info: (message) => base.info(scrub(message)),
    warn: (message) => base.warn(scrub(message)),
    error: (message) => base.error(scrub(message)),
  }
}

function integerOr(value: unknown, fallback: number, min = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.trunc(value))
}

/** Per-profile retry policy with the plugin defaults as fallback. */
export function effectiveRetries(profile: Partial<RetryConfig> | undefined, config: RetryConfig): RetryConfig {
  if (profile === undefined || profile === null) return config
  return {
    max: integerOr(profile.max, config.max),
    backoffBaseMs: integerOr(profile.backoffBaseMs, config.backoffBaseMs),
    backoffMaxMs: integerOr(profile.backoffMaxMs, config.backoffMaxMs),
    jitter: typeof profile.jitter === 'boolean' ? profile.jitter : config.jitter,
  }
}

/** Reuse key: the profile id when it has one, else the connection tuple. */
export function profileKey(profile: { id?: string; user: string; host: string; port: number; auth: string }): string {
  if (typeof profile.id === 'string' && profile.id !== '') return profile.id
  return `${profile.user}@${profile.host}:${profile.port}#${profile.auth}`
}

/** Structural validation before any DNS lookup happens (ICD `SSH_CFG_INVALID`). */
export function validateProfile(profile: ResolvedProfile): void {
  const fields: string[] = []
  if (profile === null || typeof profile !== 'object') {
    throw new SshError('SSH_CFG_INVALID', 'acquire() requires a resolved connection profile', {
      details: { field: 'profile' },
    })
  }
  if (typeof profile.host !== 'string' || profile.host.trim() === '') fields.push('host')
  if (typeof profile.user !== 'string' || profile.user.trim() === '') fields.push('user')
  if (!Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535) fields.push('port')
  if (profile.auth !== 'password' && profile.auth !== 'privateKey' && profile.auth !== 'agent') fields.push('auth')
  if (fields.length > 0) {
    throw new SshError('SSH_CFG_INVALID', `the connection profile is incomplete: ${fields.join(', ')}`, {
      details: { fields },
    })
  }
}

export class ConnectionPoolImpl implements ConnectionPool {
  private readonly options: PoolOptions
  private readonly config: ResolvedConfig
  private readonly logger: LoggerPort
  private readonly redactor: RedactorPort | undefined
  private readonly registry: SessionRegistry | undefined
  private readonly now: () => number
  private readonly random: () => number
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  private readonly createClient: () => SshClientPort
  private readonly readFile: ((path: string) => Promise<Buffer>) | undefined
  private readonly env: NodeJS.ProcessEnv | undefined
  private readonly platform: NodeJS.Platform | undefined

  private readonly sessions = new Map<SessionId, SshSession>()
  private readonly keyBySession = new Map<SessionId, string>()
  private readonly dialsByKey = new Map<string, Promise<SessionHandle>>()
  private connecting = 0
  private disposed = false

  constructor(options: PoolOptions) {
    this.options = options
    this.config = options.config
    this.logger = safeLogger(options.logger ?? FALLBACK_LOGGER, options.redactor)
    this.redactor = options.redactor
    this.registry = options.registry
    this.now = options.now ?? (() => Date.now())
    this.random = options.random ?? Math.random
    this.sleep = options.sleep ?? defaultSleep
    this.createClient = options.createClient ?? defaultClientFactory
    this.readFile = options.readFile
    this.env = options.env
    this.platform = options.platform
  }

  get size(): number {
    return this.sessions.size
  }

  /** Connections currently being dialled (ICD §7.1 `pending`). */
  get pending(): number {
    return this.connecting
  }

  /** Live connections counted against `maxSessions` (dead ones hold no slot). */
  private liveCount(): number {
    let live = this.connecting
    for (const session of this.sessions.values()) {
      if (session.state !== 'error' && session.state !== 'closed') live += 1
    }
    return live
  }

  async acquire(input: AcquireInput): Promise<SessionHandle> {
    if (this.disposed) {
      throw new SshError('SSH_STATE_INVALID', 'the SSH connection pool was disposed', {
        details: { pool: 'disposed' },
      })
    }
    const profile = input.profile
    validateProfile(profile)
    if (input.signal?.aborted === true) {
      throw new SshError('SSH_CANCELLED', 'the connection request was cancelled', { cause: input.signal.reason })
    }

    const key = profileKey(profile)
    if (input.forceNew !== true) {
      const reusable = this.findReusable(key)
      if (reusable !== undefined) {
        this.logger.debug(`reusing session ${reusable.id} for profile ${key}`)
        return reusable
      }
      const inFlight = this.dialsByKey.get(key)
      if (inFlight !== undefined) {
        this.logger.debug(`joining the in-flight connection for profile ${key}`)
        return inFlight
      }
    }

    if (this.liveCount() >= this.config.maxSessions) {
      throw new SshError(
        'SSH_LIMIT_POOL_EXHAUSTED',
        `the connection pool already holds ${this.config.maxSessions} live sessions`,
        {
          details: { limit: this.config.maxSessions, size: this.sessions.size, pending: this.connecting },
          retryAfterMs: Math.max(250, this.config.retries.backoffBaseMs),
        },
      )
    }

    this.connecting += 1
    const dial = this.openSession(input, profile, key).finally(() => {
      this.connecting = Math.max(0, this.connecting - 1)
      if (this.dialsByKey.get(key) === dial) this.dialsByKey.delete(key)
    })
    if (input.forceNew !== true) this.dialsByKey.set(key, dial)
    return dial
  }

  get(sessionId: SessionId): SessionHandle | undefined {
    return this.sessions.get(sessionId)
  }

  list(): SessionHandle[] {
    return [...this.sessions.values()]
  }

  async disposeAll(reason: string): Promise<void> {
    this.disposed = true
    this.dialsByKey.clear()
    const all = [...this.sessions.values()]
    this.sessions.clear()
    this.keyBySession.clear()
    this.logger.info(`disposing ${all.length} SSH session(s): ${reason}`)
    await Promise.all(
      all.map(async (session) => {
        try {
          await session.close({ force: true, reason })
        } catch (error) {
          this.logger.warn(`could not close session ${session.id}: ${describe(error)}`)
        }
      }),
    )
    try {
      this.redactor?.forgetAll()
    } catch {
      /* a redactor must never block teardown */
    }
  }

  // -- internals -----------------------------------------------------------

  private findReusable(key: string): SshSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.state === 'connected' && this.keyBySession.get(session.id) === key) return session
    }
    return undefined
  }

  private async openSession(input: AcquireInput, profile: ResolvedProfile, key: string): Promise<SessionHandle> {
    const sessionId = newSessionId()
    let session: SshSession | undefined

    try {
      const resolved = await resolveProfileSecrets(profile, this.options.credentials)
      const label = input.label ?? (resolved.name !== '' ? resolved.name : `${resolved.user}@${resolved.host}`)
      const created = new SshSession({
        id: sessionId,
        profile: resolved,
        label,
        deps: {
          config: this.config,
          logger: this.logger,
          redactor: this.redactor,
          sftp: this.options.sftp,
          registry: this.registry,
          now: this.now,
        },
        onStateChange: (state, error) => this.handleSessionState(sessionId, state, error, input),
      })
      session = created
      this.sessions.set(sessionId, created)
      this.keyBySession.set(sessionId, key)
      this.registry?.create(created)

      const auth = await planAuth(resolved, {
        ...(this.readFile === undefined ? {} : { readFile: this.readFile }),
        ...(this.env === undefined ? {} : { env: this.env }),
        ...(this.platform === undefined ? {} : { platform: this.platform }),
      })
      // Register the plaintext literals so every later log line is scrubbed even
      // if an ssh2 message ever embeds one (ICD §7.3 `Redactor.track`).
      this.redactor?.track(resolved.secrets.password)
      this.redactor?.track(resolved.secrets.passphrase)
      this.redactor?.track(resolved.secrets.privateKey)

      const retries = effectiveRetries(resolved.retries, this.config.retries)
      await withRetry(
        async (attempt) => {
          if (attempt > 1) {
            this.logger.info(`reconnecting to ${resolved.host}:${resolved.port} (attempt ${attempt})`)
          }
          await created.dial({
            auth,
            createClient: this.createClient,
            knownHosts: this.options.knownHosts,
            onHostKeyPrompt: input.onHostKeyPrompt,
            signal: input.signal,
          })
        },
        {
          policy: retries,
          signal: input.signal,
          random: this.random,
          sleep: this.sleep,
          shouldRetry: (code) => retryableForConnect(code),
          onRetry: (info) => {
            this.logger.warn(
              `connection to ${resolved.host}:${resolved.port} failed (${info.code}); retrying in ${info.delayMs}ms`,
            )
          },
        },
      )

      if (this.disposed) {
        await created.close({ force: true, reason: 'pool disposed during connect' })
        throw new SshError('SSH_CANCELLED', 'the plugin was unloaded while connecting')
      }
      return created
    } catch (error) {
      const classified = this.classify(error, profile)
      session?.markFailed(this.errorInfo(classified))
      if (session !== undefined && this.sessions.get(sessionId) === session) {
        this.sessions.delete(sessionId)
        this.keyBySession.delete(sessionId)
      }
      this.registry?.remove(sessionId)
      throw this.error(classified)
    }
  }

  private handleSessionState(
    sessionId: SessionId,
    state: SessionState,
    error: ErrorInfo | undefined,
    input: AcquireInput,
  ): void {
    try {
      input.onStateChange?.(state, error)
    } catch (thrown) {
      this.logger.warn(`onStateChange listener for session ${sessionId} threw: ${describe(thrown)}`)
    }
    if (state === 'closed') {
      this.sessions.delete(sessionId)
      this.keyBySession.delete(sessionId)
      this.registry?.remove(sessionId)
    }
  }

  private classify(error: unknown, profile: ResolvedProfile): ClassifiedError {
    return classifyError(error, {
      phase: 'connect',
      auth: profile.auth,
      host: profile.host,
      port: profile.port,
    })
  }

  private errorInfo(classified: ClassifiedError): ErrorInfo {
    const info: ErrorInfo = { code: classified.code, message: this.scrubText(classified.message), retryable: isRetryable(classified.code) }
    const details = this.scrubDetails(classified.details)
    if (details !== undefined) info.details = details
    return info
  }

  private error(classified: ClassifiedError): SshError {
    const details = this.scrubDetails(classified.details)
    return new SshError(classified.code, this.scrubText(classified.message), {
      ...(details === undefined ? {} : { details }),
      cause: classified.cause,
    })
  }

  private scrubText(value: string): string {
    if (this.redactor === undefined) return value
    try {
      return String(this.redactor.scrub(value))
    } catch {
      return value
    }
  }

  private scrubDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (details === undefined) return undefined
    const stripped = stripSecrets(details)
    if (this.redactor === undefined) return stripped
    try {
      return this.redactor.scrub(stripped)
    } catch {
      return stripped
    }
  }
}

/** Codes worth replaying for a *connection* attempt (ICD §5 retry column). */
export function retryableForConnect(code: SshErrorCode): boolean {
  if (!isRetryable(code)) return false
  // Auth and host-key verdicts are decisions, not transient failures; and no
  // amount of retrying will free a pool slot.
  if (code === 'SSH_LIMIT_POOL_EXHAUSTED' || code === 'SSH_LIMIT_QUEUE_FULL') return false
  if (String(code).startsWith('SSH_AUTH_') || String(code).startsWith('SSH_HOSTKEY_')) return false
  if (code === 'SSH_CANCELLED' || code === 'SSH_STATE_INVALID' || code === 'SSH_CFG_INVALID') return false
  return true
}

function defaultClientFactory(): SshClientPort {
  // The single place the real ssh2 client is constructed. The cast is needed
  // because my structural port is intentionally narrower than ssh2's overloads.
  return new ssh2.Client() as unknown as SshClientPort
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createConnectionPool(options: PoolOptions): ConnectionPool {
  return new ConnectionPoolImpl(options)
}
