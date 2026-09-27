/**
 * Per-session concurrency limiter.
 *
 * The ICD is explicit: exceeding `maxConcurrentOpsPerSession` is answered with
 * `SSH_LIMIT_QUEUE_FULL` rather than queueing, so the limiter offers a
 * non-blocking `tryAcquire` and no waiting list. Callers (the session registry)
 * translate `undefined` into the frozen error code.
 */
export type ReleaseSlot = () => void;
export declare class OperationLimiter {
    readonly limit: number;
    private active;
    constructor(limit: number);
    /** Number of operations currently holding a slot. */
    get inFlight(): number;
    get available(): number;
    /** Take a slot, or `undefined` when the limit is reached. */
    tryAcquire(): ReleaseSlot | undefined;
}
//# sourceMappingURL=semaphore.d.ts.map