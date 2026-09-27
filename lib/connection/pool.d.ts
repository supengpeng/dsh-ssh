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
import type { RetryConfig } from '../config.js';
import type { SshErrorCode } from '../protocol.js';
import type { AcquireInput, ConnectionPool, PoolOptions, ResolvedProfile, SessionHandle, SessionId } from './types.js';
/** Per-profile retry policy with the plugin defaults as fallback. */
export declare function effectiveRetries(profile: Partial<RetryConfig> | undefined, config: RetryConfig): RetryConfig;
/** Reuse key: the profile id when it has one, else the connection tuple. */
export declare function profileKey(profile: {
    id?: string;
    user: string;
    host: string;
    port: number;
    auth: string;
}): string;
/** Structural validation before any DNS lookup happens (ICD `SSH_CFG_INVALID`). */
export declare function validateProfile(profile: ResolvedProfile): void;
export declare class ConnectionPoolImpl implements ConnectionPool {
    private readonly options;
    private readonly config;
    private readonly logger;
    private readonly redactor;
    private readonly registry;
    private readonly now;
    private readonly random;
    private readonly sleep;
    private readonly createClient;
    private readonly readFile;
    private readonly env;
    private readonly platform;
    private readonly sessions;
    private readonly keyBySession;
    private readonly dialsByKey;
    private connecting;
    private disposed;
    constructor(options: PoolOptions);
    get size(): number;
    /** Connections currently being dialled (ICD §7.1 `pending`). */
    get pending(): number;
    /** Live connections counted against `maxSessions` (dead ones hold no slot). */
    private liveCount;
    acquire(input: AcquireInput): Promise<SessionHandle>;
    get(sessionId: SessionId): SessionHandle | undefined;
    list(): SessionHandle[];
    disposeAll(reason: string): Promise<void>;
    private findReusable;
    private openSession;
    private handleSessionState;
    private classify;
    private errorInfo;
    private error;
    private scrubText;
    private scrubDetails;
}
/** Codes worth replaying for a *connection* attempt (ICD §5 retry column). */
export declare function retryableForConnect(code: SshErrorCode): boolean;
export declare function createConnectionPool(options: PoolOptions): ConnectionPool;
//# sourceMappingURL=pool.d.ts.map