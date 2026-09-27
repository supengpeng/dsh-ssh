/**
 * Multi-session registry + per-session concurrency gate (ICD §7.1
 * `SessionRegistry`).
 *
 * The registry is the host's single source of truth for what the UI shows in
 * `listSessions` / `followSessions`: it stores *projections* (`SessionInfo`),
 * never handles, and every value entering or leaving it is redacted. The
 * `run()` method is the only place a per-session concurrency limit is enforced,
 * and it answers an over-limit call with `SSH_LIMIT_QUEUE_FULL` (no queueing),
 * exactly as the ICD requires.
 */
import { isAbortError } from './connection/errors.js';
import { stripSecrets } from './connection/scrub.js';
import { OperationLimiter } from './connection/semaphore.js';
import { SshError } from './protocol.js';
/** Keys of `SessionInfo` that `update()` accepts. */
const INFO_KEYS = ['profileId', 'label', 'host', 'port', 'user', 'state', 'since', 'error'];
/**
 * Reduce an arbitrary object to the frozen `SessionInfo` shape.
 *
 * The registry is a *projection store*: `create(handle)` receives whatever a
 * handle claims its `info` is, so unknown keys are dropped here rather than
 * reaching `listSessions` results. Combined with the redactor and the key-name
 * scrubber this is what makes "no credential in any result" structural instead
 * of a promise.
 */
function normalise(raw) {
    if (raw === null || typeof raw !== 'object') {
        throw new SshError('SSH_STATE_INVALID', 'the session handle does not expose an info projection');
    }
    const source = raw;
    if (typeof source.id !== 'string' || source.id === '') {
        throw new SshError('SSH_STATE_INVALID', 'the session handle has no id');
    }
    const metrics = (source.metrics ?? {});
    const capabilities = (source.capabilities ?? {});
    const info = {
        id: source.id,
        label: typeof source.label === 'string' ? source.label : source.id,
        host: typeof source.host === 'string' ? source.host : '',
        port: typeof source.port === 'number' ? source.port : 0,
        user: typeof source.user === 'string' ? source.user : '',
        state: source.state ?? 'idle',
        since: typeof source.since === 'string' && source.since !== '' ? source.since : new Date(0).toISOString(),
        metrics: {
            ...(typeof metrics.connectMs === 'number' ? { connectMs: metrics.connectMs } : {}),
            ...(typeof metrics.rttMs === 'number' ? { rttMs: metrics.rttMs } : {}),
            bytesIn: typeof metrics.bytesIn === 'number' ? metrics.bytesIn : 0,
            bytesOut: typeof metrics.bytesOut === 'number' ? metrics.bytesOut : 0,
        },
        capabilities: { shell: capabilities.shell === true, sftp: capabilities.sftp === true },
    };
    if (typeof source.profileId === 'string' && source.profileId !== '')
        info.profileId = source.profileId;
    const error = source.error;
    if (error !== null && typeof error === 'object' && typeof error.code === 'string') {
        info.error = {
            code: error.code,
            message: typeof error.message === 'string' ? error.message : '',
            retryable: error.retryable === true,
            ...(error.details === undefined ? {} : { details: error.details }),
            ...(typeof error.retryAfterMs === 'number' ? { retryAfterMs: error.retryAfterMs } : {}),
        };
    }
    return info;
}
export class SessionRegistryImpl {
    infos = new Map();
    listeners = new Set();
    limiters = new Map();
    aborts = new Map();
    options;
    now;
    constructor(options) {
        this.options = options;
        this.now = options.now ?? (() => Date.now());
    }
    // -- projections ---------------------------------------------------------
    project(info) {
        const shaped = normalise(info);
        const redacted = this.options.redactor === undefined ? shaped : this.options.redactor.scrub(shaped);
        // `stripSecrets` deep-copies, so the stored object is never aliased to a
        // caller-owned handle projection.
        return stripSecrets(redacted);
    }
    // -- lifecycle -----------------------------------------------------------
    create(handle) {
        const raw = handle === null || handle === undefined ? undefined : handle.info;
        const snapshot = this.project(raw);
        const existing = this.infos.get(snapshot.id);
        this.infos.set(snapshot.id, snapshot);
        this.emit(snapshot, existing === undefined ? 'added' : 'updated');
        return this.project(snapshot);
    }
    update(sessionId, patch) {
        const current = this.infos.get(sessionId);
        // A late update after `remove()` is normal during teardown: ignore it
        // rather than resurrecting a dead session in the UI.
        if (current === undefined)
            return;
        const merged = {
            ...current,
            metrics: { ...current.metrics, ...(patch.metrics ?? {}) },
            capabilities: { ...current.capabilities, ...(patch.capabilities ?? {}) },
        };
        for (const key of INFO_KEYS) {
            if (patch[key] !== undefined) {
                // The `id` is immutable; the remaining keys are plain scalars/objects.
                ;
                merged[key] = patch[key];
            }
        }
        const next = this.project(merged);
        this.infos.set(sessionId, next);
        this.emit(next, 'updated');
    }
    remove(sessionId) {
        const current = this.infos.get(sessionId);
        if (current === undefined)
            return;
        this.infos.delete(sessionId);
        this.limiters.delete(sessionId);
        this.abortInFlight(sessionId);
        this.emit(current, 'removed');
    }
    list() {
        return [...this.infos.values()].map((info) => this.project(info));
    }
    get(sessionId) {
        const info = this.infos.get(sessionId);
        return info === undefined ? undefined : this.project(info);
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    /** Diagnostics: operations currently holding a slot for one session. */
    activeOps(sessionId) {
        return this.limiters.get(sessionId)?.inFlight ?? 0;
    }
    // -- concurrency gate ----------------------------------------------------
    async run(sessionId, op, task) {
        const limit = Math.max(1, Math.trunc(this.options.maxConcurrentOpsPerSession));
        let limiter = this.limiters.get(sessionId);
        if (limiter === undefined) {
            limiter = new OperationLimiter(limit);
            this.limiters.set(sessionId, limiter);
        }
        const release = limiter.tryAcquire();
        if (release === undefined) {
            throw new SshError('SSH_LIMIT_QUEUE_FULL', `session ${sessionId} already runs ${limit} operations`, {
                details: { sessionId, op, limit, retryable: true },
                retryAfterMs: 250,
            });
        }
        const controller = new AbortController();
        this.track(sessionId, controller);
        const started = this.now();
        try {
            return await task(controller.signal);
        }
        catch (error) {
            if (isAbortError(error) || controller.signal.aborted) {
                throw new SshError('SSH_CANCELLED', `operation "${op}" was cancelled`, {
                    details: { sessionId, op },
                    cause: error,
                });
            }
            throw error;
        }
        finally {
            release();
            this.untrack(sessionId, controller);
            this.options.logger?.debug(`session ${sessionId} op "${op}" finished in ${Math.max(0, this.now() - started)}ms`);
        }
    }
    // -- internals -----------------------------------------------------------
    emit(info, event) {
        for (const listener of [...this.listeners]) {
            try {
                listener(this.project(info), event);
            }
            catch {
                // A subscriber must never be able to break the registry.
            }
        }
    }
    track(sessionId, controller) {
        let set = this.aborts.get(sessionId);
        if (set === undefined) {
            set = new Set();
            this.aborts.set(sessionId, set);
        }
        set.add(controller);
    }
    untrack(sessionId, controller) {
        const set = this.aborts.get(sessionId);
        if (set === undefined)
            return;
        set.delete(controller);
        if (set.size === 0)
            this.aborts.delete(sessionId);
    }
    abortInFlight(sessionId) {
        const set = this.aborts.get(sessionId);
        if (set === undefined)
            return;
        this.aborts.delete(sessionId);
        for (const controller of set) {
            try {
                controller.abort(new Error('session removed'));
            }
            catch {
                /* ignore */
            }
        }
    }
}
export function createSessionRegistry(options) {
    return new SessionRegistryImpl(options);
}
//# sourceMappingURL=sessions.js.map