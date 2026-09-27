/**
 * Retry with exponential backoff + jitter (ICD §5 "默认重试").
 *
 * Policy: `max` retries, delay `backoffBaseMs * 2^n` capped at `backoffMaxMs`,
 * ±25% jitter when `jitter` is enabled. Only codes the ICD marks retryable are
 * retried, and the caller can narrow that further (`shouldRetry`) — a connection
 * attempt must not retry `SSH_LIMIT_POOL_EXHAUSTED`, for instance.
 *
 * `task` is expected to throw `SshError` (the pool classifies inside the task);
 * anything else is treated as non-retryable unless `shouldRetry` says otherwise.
 */
import type { RetryConfig } from '../config.js';
import type { SshErrorCode } from '../protocol.js';
export interface RetryAttemptInfo {
    /** 1-based number of the attempt that just failed. */
    attempt: number;
    code: SshErrorCode;
    delayMs: number;
    error: unknown;
}
export interface RetryOptions {
    policy: RetryConfig;
    /** Narrow the retryable-code set (return `false` to stop immediately). */
    shouldRetry?: (code: SshErrorCode, attempt: number) => boolean;
    /** Observability hook; called before each sleep. */
    onRetry?: (info: RetryAttemptInfo) => void;
    signal?: AbortSignal;
    /** Injectable sleep so tests do not wait in real time. */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    /** Jitter source in [0,1); defaults to `Math.random`. */
    random?: () => number;
}
/** Abortable `setTimeout`. */
export declare function defaultSleep(ms: number, signal?: AbortSignal): Promise<void>;
/**
 * Delay before attempt `attempt + 1` (0-based `attempt`).
 *
 * The cap is applied to the exponential value and the jitter on top of it, so a
 * jittered delay may exceed `backoffMaxMs` by at most 25%; that is what "±25%
 * 抖动" means and it keeps the cap meaningful.
 */
export declare function backoffDelay(attempt: number, policy: RetryConfig, random?: () => number): number;
/**
 * Run `task` until it succeeds or the policy stops retrying.
 *
 * `task` receives the 1-based attempt number so callers can label their logs.
 * The original error of the final attempt is rethrown unchanged.
 */
export declare function withRetry<T>(task: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T>;
//# sourceMappingURL=retry.d.ts.map