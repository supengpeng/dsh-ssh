/**
 * `createHostRuntime` — the plugin's object graph.
 *
 * The shell (`src/index.ts`) owns the plugin envelope: `name`, `inject`, the
 * config schema, `apply`, the `ctx.effect` lifecycle and service registration.
 * This module owns everything *inside* that envelope: who is constructed with
 * what, which module a Remote endpoint delegates to, and what teardown means.
 * Keeping the graph on this side of one function is what lets the endpoint layer,
 * the connection pool and the security modules evolve without the shell turning
 * into a second composition root.
 *
 * Construction rules, in order:
 *
 *   1. **One redactor, shared by everything.** `createRedactor` comes first and is
 *      handed to the logger, the auditor, the session registry, the credential
 *      resolver and the connection pool — so a secret registered by one is masked
 *      by all of them. Creating a second redactor anywhere would silently split
 *      that guarantee.
 *   2. **The logger takes the *resolved* config**, not the raw one: its file path
 *      is derived from `dirname(config.auditFile)`, which only exists after
 *      `resolveConfig()`.
 *   3. **Nothing here blocks.** No network, no directory scan, no file read on the
 *      activation path: the profile store and audit log open lazily on first use,
 *      because a plugin that takes a second to appear looks broken.
 *   4. **Activation is non-fatal.** A missing optional service (credentials, tools)
 *      degrades with a warning and a structured error on the affected endpoint;
 *      it never prevents the runtime from being built, because a row that fails to
 *      load tells the user nothing actionable.
 */

import type { Context } from '@deepseek-ai/cordis'

import type { ResolvedConfig } from '../config.js'
import { ActivityFeed } from '../activity/feed.js'
import { createAuditor, type SshAuditor } from '../audit.js'
import { createConnectionPool, type ConnectionPool } from '../connection/index.js'
import { createCredentialResolver, type SshCredentialResolver } from '../credentials.js'
import { ExecService } from '../exec/service.js'
import { createKnownHostsVerifier, type KnownHostsVerifierImpl } from '../known-hosts.js'
import { createLogger, type PluginLogger } from '../logger.js'
import { createRedactor, type Redactor } from '../redact.js'
import { createSessionRegistry, type SessionRegistry } from '../sessions.js'
import { createSftpProvider, TransferManager } from '../sftp/index.js'
import { createProfileStore, type ProfileStore } from '../store.js'
import { SshPluginService } from '../service.js'
import { LocalApi } from './local-api.js'
import { registerAgentTools, type ToolRegistration } from './tools.js'

/** What the plugin shell receives; the contract between `index.ts` and this module. */
export interface HostRuntime {
  /** The instance registered as `ctx.sshPlugin` (a real object with `@Remote` markers). */
  service: object
  /** The runtime's logger, so the shell does not build a second one. */
  log: PluginLogger
  /** Everything the runtime owns, for tests and for the shell's diagnostics. */
  parts: {
    config: ResolvedConfig
    redactor: Redactor
    store: ProfileStore
    credentials: SshCredentialResolver
    knownHosts: KnownHostsVerifierImpl
    audit: SshAuditor
    activity: ActivityFeed
    pool: ConnectionPool
    registry: SessionRegistry
    exec: ExecService
    transfers: TransferManager
    tools: ToolRegistration
  }
  /** Idempotent, never-throwing teardown. */
  dispose(): Promise<void>
}

/** The slice of `ctx` this module reads. Structural, so a test can pass a stub. */
export interface RuntimeContext {
  get?(name: string): unknown
  [key: string]: unknown
}

export interface CreateHostRuntimeOptions {
  ctx: Context | RuntimeContext
  config: ResolvedConfig
}

/**
 * Read the credentials service without assuming it exists.
 *
 * `ctx.get('credentials')` is the documented accessor; older trees expose the
 * service directly on the context. Both are probed, and a failure is reported by
 * the *endpoint* ("this deployment cannot store secrets"), not here.
 *
 * The returned face is deliberately structural (see `CredentialStoreFace`): the
 * host tree runs its own copy of `@deepseek-ai/dsh-credentials`, so importing that
 * package would compare class identities across two module instances.
 */
function credentialServiceOf(ctx: RuntimeContext): unknown {
  try {
    if (typeof ctx.get === 'function') {
      const viaGet = ctx.get('credentials')
      if (viaGet !== null && viaGet !== undefined) return viaGet
    }
    const direct = ctx['credentials']
    if (direct !== null && direct !== undefined) return direct
  } catch {
    /* an opportunistic lookup must never break activation */
  }
  return undefined
}

/** Build the object graph. Never throws for a missing optional service. */
export async function createHostRuntime(options: CreateHostRuntimeOptions): Promise<HostRuntime> {
  const { config } = options
  const ctx = options.ctx as RuntimeContext

  // 1. one redactor, shared by every module below.
  const redactor = createRedactor({ redactKeys: config.logging.redactKeys, enabled: config.logging.redact })

  // 2. the logger needs the *resolved* config (its path comes from auditFile).
  const log = createLogger({ config, redactor, host: hostLoggerOf(ctx), scope: 'ssh' })

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
    onLoadError: (reason) => log.warn('the connection-profile store could not be read', { reason }),
    onWriteError: (reason) => log.warn('the connection-profile store could not be written', { reason }),
  })

  const credentials = createCredentialResolver({
    secrets: config.secrets,
    credentials: credentialServiceOf(ctx) as never,
    profiles: store,
    redactor,
    logger: log,
  })

  const knownHosts = createKnownHostsVerifier({
    file: config.knownHostsFile,
    policy: config.hostKey.policy,
    logger: log,
  })

  /**
   * Remember what the handshake learned about each host.
   *
   * `testProfile` must report `hostKeyFingerprint` and the host-key prompt must be
   * able to *remember* an accepted key, but no frozen signature hands either back
   * to a caller after the handshake. The verifier is therefore wrapped once,
   * here, and records the last `(keyType, key, fingerprint, match)` per endpoint.
   * The wrapper is a plain object implementing the same structural port the pool
   * consumes, so nothing downstream can tell the difference.
   */
  const hostKeyFacts = new Map<string, { keyType: string; key: Buffer; fingerprint: string; knownHostsMatch: 'unknown' | 'exact' | 'changed' }>()
  const knownHostsForPool = {
    verify: async (q: { host: string; port: number; keyType: string; key: Buffer; policy: 'strict' | 'accept-new' | 'insecure' }) => {
      const outcome = await knownHosts.verify(q)
      hostKeyFacts.set(`${q.host}:${q.port}`, {
        keyType: q.keyType,
        key: Buffer.from(q.key),
        fingerprint: outcome.fingerprint,
        knownHostsMatch: outcome.knownHostsMatch,
      })
      return outcome
    },
    remember: (q: { host: string; port: number; keyType: string; key: Buffer }) => knownHosts.remember(q),
    fingerprint: (keyType: string, key: Buffer) => knownHosts.fingerprint(keyType, key),
  }

  const audit = createAuditor({ file: config.auditFile, redactor, logger: log })

  /**
   * The agent-activity mirror (ICD §4.7).
   *
   * Built here, above the endpoint facade and the tools, because both need it:
   * the facade serves it to the browser and the tools record into it. It is the
   * one part of the graph that carries raw remote output in memory, which is why
   * its bounds come from the configuration rather than from a constant here.
   */
  const activity = new ActivityFeed({
    enabled: config.activity.enabled,
    maxRecords: config.activity.maxRecords,
    maxRecordBytes: config.activity.maxRecordBytes,
    maxTotalBytes: config.activity.maxTotalBytes,
    logger: log,
  })

  const registry = createSessionRegistry({
    maxConcurrentOpsPerSession: config.maxConcurrentOpsPerSession,
    logger: log,
    redactor,
  })

  const pool = createConnectionPool({
    config,
    logger: log,
    redactor,
    credentials,
    knownHosts: knownHostsForPool,
    registry,
    sftp: createSftpProvider({ logger: log }),
  })

  const exec = new ExecService({
    resolveSession: (sessionId) => pool.get(sessionId),
    listSessions: () =>
      registry.list().map((info) => ({
        id: info.id,
        label: info.label,
        host: info.host,
        user: info.user,
        state: info.state,
      })),
    defaultSessionId: () => {
      const sessions = registry.list()
      return sessions.length === 1 ? sessions[0]?.id : undefined
    },
    limits: {
      maxOutputBytes: config.maxOutputBytes,
      operationTimeoutMs: config.operationTimeoutMs,
      graceKillMs: config.graceKillMs,
    },
    // Frame count bound on the replay log. Passed through rather than defaulted
    // here: `0` legitimately means "no count bound", so an explicit value is the
    // only way to tell "unset" (use FrameWriter's default) from "disabled".
    replayLimitFrames: config.maxReplayFrames,
    logger: log,
  })

  const transfers = new TransferManager({
    sessions: pool,
    defaults: {
      chunkBytes: config.sftp.chunkBytes,
      maxConcurrentChunks: config.sftp.maxConcurrentChunks,
      resume: config.sftp.resume,
      verify: config.sftp.verify,
      // The engine's own safety net (F-SEC-05): implicit append/replace needs an
      // explicit `overwrite: true`, and the plugin's trust anchors and state
      // files are out of reach for every transfer, in both directions.
      confirmDangerous: config.confirmDangerous,
      protectedLocalPaths: [config.hostKey.knownHostsFile, config.profilesFile, config.auditFile],
      followSymlinks: config.sftp.followSymlinks,
      progressIntervalMs: config.sftp.progressIntervalMs,
    },
    logger: log,
    onSettled: (record) => {
      audit.record({
        op: record.direction === 'upload' ? 'upload' : 'download',
        outcome: record.error === undefined ? 'ok' : 'error',
        sessionId: record.sessionId,
        detail: {
          opId: record.opId,
          localPath: record.localPath,
          remotePath: record.remotePath,
          transferred: record.transferred,
          totalBytes: record.totalBytes ?? null,
          phase: record.phase,
          ...(record.error === undefined ? {} : { code: record.error.code, message: record.error.message }),
        },
      })
    },
  })

  // 3. the endpoint facade, then the tools (which delegate to it), then the wire
  //    service (which owns the `@Remote` decorators). The tools layer needs the
  //    api, so it is built after it and before the service.
  const api = new LocalApi({
    config,
    logger: log,
    redactor,
    store,
    credentials,
    knownHosts,
    audit,
    activity,
    pool,
    registry,
    exec,
    transfers,
    lastFingerprint: (host, port) => hostKeyFacts.get(`${host}:${port}`)?.fingerprint,
    lastHostKey: (host, port) => hostKeyFacts.get(`${host}:${port}`),
  })

  // 4. the tools registry is opportunistic: `inject: ['tools']` makes it the one
  //    hard dependency of the *shell*, but a tree without it must still load.
  const tools = registerAgentTools({ ctx, config, exec, pool, registry, transfers, audit, activity, log, api })

  const service = new SshPluginService(ctx, config, log.toServiceLogger(), { probeWire: true, api })

  let disposed = false
  return {
    service,
    log,
    parts: { config, redactor, store, credentials, knownHosts, audit, activity, pool, registry, exec, transfers, tools },
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      // Order matters: stop producers before their consumers, flush what is
      // durable last, and never let one failure skip the rest.
      try {
        exec.dispose('peer-closed')
      } catch (error) {
        log.warn('exec dispose failed', { reason: messageOf(error) })
      }
      try {
        transfers.dispose()
      } catch (error) {
        log.warn('transfer dispose failed', { reason: messageOf(error) })
      }
      try {
        tools.dispose()
      } catch (error) {
        log.warn('tool unregistration failed', { reason: messageOf(error) })
      }
      // The mirror holds remote output in memory and nothing durable depends on
      // it: dropping it here is what makes "unload leaves no captured output
      // behind" true, the same way `credentials.forgetAll()` does for secrets.
      try {
        activity.dispose()
      } catch (error) {
        log.warn('activity feed dispose failed', { reason: messageOf(error) })
      }
      try {
        await pool.disposeAll('plugin unload')
      } catch (error) {
        log.warn('connection pool dispose failed', { reason: messageOf(error) })
      }
      try {
        await audit.flush()
      } catch (error) {
        log.warn('audit flush failed', { reason: messageOf(error) })
      }
      // Drop every in-memory plaintext and the literals registered for matching:
      // after unload nothing should be able to match a credential any more.
      try {
        credentials.forgetAll()
      } catch (error) {
        log.warn('credential cleanup failed', { reason: messageOf(error) })
      }
      try {
        redactor.forgetAll()
      } catch {
        /* nothing left to do */
      }
    },
  }
}

/** The host composition's logger, when it exposes one. */
function hostLoggerOf(ctx: RuntimeContext): { debug(message: string): void; info(message: string): void; warn(message: string): void; error(message: string): void } | undefined {
  try {
    const candidate = ctx['logger']
    if (typeof candidate === 'function') {
      for (const scope of ['sshPlugin', 'ssh', 'dsh-ssh']) {
        const named = (candidate as (name: string) => unknown).call(ctx, scope)
        if (isLoggerFace(named)) return named
      }
    }
    if (isLoggerFace(candidate)) return candidate
    const viaGet = typeof ctx.get === 'function' ? ctx.get('logger') : undefined
    if (isLoggerFace(viaGet)) return viaGet
  } catch {
    /* a host logger is a courtesy, never a dependency */
  }
  return undefined
}

function isLoggerFace(value: unknown): value is { debug(message: string): void; info(message: string): void; warn(message: string): void; error(message: string): void } {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate['info'] === 'function' && typeof candidate['warn'] === 'function'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
