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
import { normalizeProfile } from '../store.js';
import { SshError } from '../protocol.js';
import { SftpClient } from '../sftp/client.js';
/** Base class for one endpoint group. */
export class ApiGroup {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    get config() {
        return this.deps.config;
    }
    get log() {
        return this.deps.logger;
    }
    now() {
        return this.deps.now?.() ?? Date.now();
    }
    /** Record one audited operation; `record()` never throws and always redacts. */
    audit(entry) {
        this.deps.audit.record(entry);
    }
    /** A one-line, value-free audit for the common "call succeeded/failed" shape. */
    auditOutcome(op, outcome, fields = {}) {
        this.audit({ op, outcome, ...(Object.keys(fields).length === 0 ? {} : { detail: fields }) });
    }
}
/** The profile defaults a new profile inherits, derived from the resolved config. */
export function profileDefaultsOf(config) {
    return {
        connectTimeoutMs: config.connectTimeoutMs,
        keepaliveIntervalMs: config.keepaliveIntervalMs,
        keepaliveCountMax: config.keepaliveCountMax,
        retries: config.retries,
        hostKeyPolicy: config.hostKey.policy,
    };
}
/**
 * Build a profile that was never stored (`connect.inline`, `testProfile`).
 *
 * It goes through the same `normalizeProfile` as a persisted profile — reference
 * validation, clamping, defaulting — so an inline request cannot smuggle a
 * plaintext past the rules that protect the profile file.
 */
export function transientProfile(deps, patch) {
    return normalizeProfile(patch, {
        defaults: profileDefaultsOf(deps.config),
        redactKeys: deps.config.logging.redactKeys,
    });
}
/** Sessions already connected for one profile (used for reuse and `testProfile`). */
export function sessionsForProfile(deps, profileId) {
    return deps.registry.list().filter((info) => info.profileId === profileId);
}
/**
 * The SFTP facade for one session.
 *
 * `followSymlinks` always comes from the configuration: neither a UI request nor a
 * tool call may widen the transfer policy the operator chose.
 */
export async function sftpClientOf(deps, sessionId, signal) {
    const session = deps.pool.get(sessionId);
    if (session === undefined) {
        // `details.sessions` mirrors what the exec layer does for an unknown session:
        // "no such session" is only actionable next to what *is* connected.
        throw new SshError('SSH_STATE_INVALID', `no live session with id "${sessionId}"; connect first`, {
            details: { sessionId, sessions: deps.registry.list().map((info) => info.id) },
        });
    }
    const handle = await session.sftp(signal);
    return new SftpClient(handle, { followSymlinks: deps.config.sftp.followSymlinks, logger: deps.logger });
}
/** The live session a request names, or the structured error the UI expects. */
export function sessionOf(deps, sessionId) {
    const session = deps.pool.get(sessionId);
    if (session === undefined) {
        throw new SshError('SSH_STATE_INVALID', `no live session with id "${sessionId}"; connect first`, {
            details: { sessionId, sessions: deps.registry.list().map((info) => info.id) },
        });
    }
    return session;
}
//# sourceMappingURL=deps.js.map