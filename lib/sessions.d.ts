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
import type { LoggerPort, RedactorPort, SessionHandle, SessionId } from './connection/types.js';
import type { SessionInfo } from './protocol.js';
export interface SessionRegistry {
    create(handle: SessionHandle): SessionInfo;
    update(sessionId: SessionId, patch: Partial<SessionInfo>): void;
    remove(sessionId: SessionId): void;
    list(): SessionInfo[];
    get(sessionId: SessionId): SessionInfo | undefined;
    subscribe(listener: (info: SessionInfo, event: 'added' | 'updated' | 'removed') => void): () => void;
    /** Concurrency gate: over `maxConcurrentOpsPerSession` → `SSH_LIMIT_QUEUE_FULL`. */
    run<T>(sessionId: SessionId, op: string, task: (signal: AbortSignal) => Promise<T>): Promise<T>;
}
export interface SessionRegistryOptions {
    /** Effective `config.maxConcurrentOpsPerSession`. */
    maxConcurrentOpsPerSession: number;
    logger?: LoggerPort;
    /** SP4 redactor; applied to every projection before it is stored or returned. */
    redactor?: RedactorPort;
    /** Clock injection, used for op durations in logs. */
    now?: () => number;
}
export declare class SessionRegistryImpl implements SessionRegistry {
    private readonly infos;
    private readonly listeners;
    private readonly limiters;
    private readonly aborts;
    private readonly options;
    private readonly now;
    constructor(options: SessionRegistryOptions);
    private project;
    create(handle: SessionHandle): SessionInfo;
    update(sessionId: SessionId, patch: Partial<SessionInfo>): void;
    remove(sessionId: SessionId): void;
    list(): SessionInfo[];
    get(sessionId: SessionId): SessionInfo | undefined;
    subscribe(listener: (info: SessionInfo, event: 'added' | 'updated' | 'removed') => void): () => void;
    /** Diagnostics: operations currently holding a slot for one session. */
    activeOps(sessionId: SessionId): number;
    run<T>(sessionId: SessionId, op: string, task: (signal: AbortSignal) => Promise<T>): Promise<T>;
    private emit;
    private track;
    private untrack;
    private abortInFlight;
}
export declare function createSessionRegistry(options: SessionRegistryOptions): SessionRegistry;
//# sourceMappingURL=sessions.d.ts.map