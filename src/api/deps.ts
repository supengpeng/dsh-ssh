/**
 * Shared endpoint machinery: the dependency object, a base class with the audit
 * helper, and the lookups every group needs.
 *
 * The endpoints are split into groups (`profiles` / `sessions` / `exec` /
 * `files` / `audit`) that all read the same {@link ApiDeps}. Splitting by group
 * rather than by class inheritance keeps each file reviewable and lets one group
 * change without touching the others — while `LocalApi` still presents the single
 * object `src/service.ts` delegates to.
 */

import type { ResolvedConfig } from '../config.js'
import type { PluginLogger } from '../logger.js'
import type { Redactor } from '../redact.js'
import type { SshAuditor } from '../audit.js'
import type { ActivityFeed } from '../activity/feed.js'
import type { SshCredentialResolver } from '../credentials.js'
import type { KnownHostsVerifierImpl } from '../known-hosts.js'
import { normalizeProfile, type ConnProfile, type ConnProfilePatch, type ProfileStore, type ProfileDefaults } from '../store.js'
import { SshError, type AuditEntry, type SessionInfo } from '../protocol.js'
import type { ConnectionPool } from '../connection/index.js'
import type { SessionRegistry } from '../sessions.js'
import type { ExecService } from '../exec/service.js'
import type { TransferManager } from '../sftp/manager.js'
import { SftpClient } from '../sftp/client.js'

/** Everything the endpoint layer is given; built once by `createHostRuntime`. */
export interface ApiDeps {
  config: ResolvedConfig
  logger: PluginLogger
  redactor: Redactor
  store: ProfileStore
  credentials: SshCredentialResolver
  knownHosts: KnownHostsVerifierImpl
  audit: SshAuditor
  /**
   * The mirror of what the *agent* did (ICD §4.7).
   *
   * Endpoints read it to serve `followActivity`; the tools write into it. It is
   * part of `ApiDeps` rather than of the tools' own deps because the browser's
   * view of it is an endpoint, and an endpoint that had to reach into the tool
   * layer for its data would invert the dependency.
   */
  activity: ActivityFeed
  pool: ConnectionPool
  registry: SessionRegistry
  exec: ExecService
  transfers: TransferManager
  /**
   * The last host-key fingerprint observed for `host:port`.
   *
   * Recorded by the wrapper the runtime puts around the verifier, because the
   * fingerprint is produced inside the connection layer's handshake and no frozen
   * signature returns it to a caller afterwards (`testProfile` and the pending-key
   * prompt both need it).
   */
  lastFingerprint?(host: string, port: number): string | undefined
  /**
   * The key material of the last handshake for `host:port`.
   *
   * A host-key prompt carries a fingerprint, not the key, so an accepted key can
   * only be *remembered* if the handshake's own material was captured — writing a
   * made-up entry into `known_hosts` would be worse than writing none.
   */
  lastHostKey?(host: string, port: number): { keyType: string; key: Buffer; fingerprint: string; knownHostsMatch: 'unknown' | 'exact' | 'changed' } | undefined
  /** Injectable clock (tests). */
  now?(): number
}

/** Base class for one endpoint group. */
export abstract class ApiGroup {
  protected readonly deps: ApiDeps

  constructor(deps: ApiDeps) {
    this.deps = deps
  }

  protected get config(): ResolvedConfig {
    return this.deps.config
  }

  protected get log(): PluginLogger {
    return this.deps.logger
  }

  protected now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** Record one audited operation; `record()` never throws and always redacts. */
  protected audit(entry: Omit<AuditEntry, 'at'>): void {
    this.deps.audit.record(entry)
  }

  /** A one-line, value-free audit for the common "call succeeded/failed" shape. */
  protected auditOutcome(op: string, outcome: AuditEntry['outcome'], fields: Record<string, unknown> = {}): void {
    this.audit({ op, outcome, ...(Object.keys(fields).length === 0 ? {} : { detail: fields }) })
  }
}

/** The profile defaults a new profile inherits, derived from the resolved config. */
export function profileDefaultsOf(config: ResolvedConfig): ProfileDefaults {
  return {
    connectTimeoutMs: config.connectTimeoutMs,
    keepaliveIntervalMs: config.keepaliveIntervalMs,
    keepaliveCountMax: config.keepaliveCountMax,
    retries: config.retries,
    hostKeyPolicy: config.hostKey.policy,
  }
}

/**
 * Build a profile that was never stored (`connect.inline`, `testProfile`).
 *
 * It goes through the same `normalizeProfile` as a persisted profile — reference
 * validation, clamping, defaulting — so an inline request cannot smuggle a
 * plaintext past the rules that protect the profile file.
 */
export function transientProfile(deps: ApiDeps, patch: ConnProfilePatch): ConnProfile {
  return normalizeProfile(patch, {
    defaults: profileDefaultsOf(deps.config),
    redactKeys: deps.config.logging.redactKeys,
  })
}

/** Sessions already connected for one profile (used for reuse and `testProfile`). */
export function sessionsForProfile(deps: ApiDeps, profileId: string): SessionInfo[] {
  return deps.registry.list().filter((info) => info.profileId === profileId)
}

/**
 * The SFTP facade for one session.
 *
 * `followSymlinks` always comes from the configuration: neither a UI request nor a
 * tool call may widen the transfer policy the operator chose.
 */
export async function sftpClientOf(deps: ApiDeps, sessionId: string, signal?: AbortSignal): Promise<SftpClient> {
  const session = deps.pool.get(sessionId)
  if (session === undefined) {
    // `details.sessions` mirrors what the exec layer does for an unknown session:
    // "no such session" is only actionable next to what *is* connected.
    throw new SshError('SSH_STATE_INVALID', `no live session with id "${sessionId}"; connect first`, {
      details: { sessionId, sessions: deps.registry.list().map((info) => info.id) },
    })
  }
  const handle = await session.sftp(signal)
  return new SftpClient(handle, { followSymlinks: deps.config.sftp.followSymlinks, logger: deps.logger })
}

/** The live session a request names, or the structured error the UI expects. */
export function sessionOf(deps: ApiDeps, sessionId: string): ReturnType<ConnectionPool['get']> {
  const session = deps.pool.get(sessionId)
  if (session === undefined) {
    throw new SshError('SSH_STATE_INVALID', `no live session with id "${sessionId}"; connect first`, {
      details: { sessionId, sessions: deps.registry.list().map((info) => info.id) },
    })
  }
  return session
}

export type { ProfileStore, ConnProfile, ConnProfilePatch }
