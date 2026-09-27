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
import { isRetryable, SshError } from '../protocol.js';
/** Abortable `setTimeout`. */
export function defaultSleep(ms, signal) {
    if (ms <= 0)
        return Promise.resolve();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            resolve();
        }, ms);
        const onAbort = () => {
            cleanup();
            reject(new SshError('SSH_CANCELLED', 'retry cancelled', { cause: signal?.reason }));
        };
        const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        };
        if (signal?.aborted === true) {
            onAbort();
            return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
/**
 * Delay before attempt `attempt + 1` (0-based `attempt`).
 *
 * The cap is applied to the exponential value and the jitter on top of it, so a
 * jittered delay may exceed `backoffMaxMs` by at most 25%; that is what "±25%
 * 抖动" means and it keeps the cap meaningful.
 */
export function backoffDelay(attempt, policy, random = Math.random) {
    const base = Math.max(0, policy.backoffBaseMs);
    const max = policy.backoffMaxMs > 0 ? policy.backoffMaxMs : Number.POSITIVE_INFINITY;
    const exponent = Math.max(0, Math.trunc(attempt));
    // 2 ** n overflows to Infinity for large n, which `Math.min` then caps.
    const raw = Math.min(max, base * 2 ** exponent);
    if (!policy.jitter)
        return Math.round(raw);
    const factor = 0.75 + 0.5 * Math.min(1, Math.max(0, random()));
    return Math.round(raw * factor);
}
/**
 * Run `task` until it succeeds or the policy stops retrying.
 *
 * `task` receives the 1-based attempt number so callers can label their logs.
 * The original error of the final attempt is rethrown unchanged.
 */
export async function withRetry(task, options) {
    const maxAttempts = Math.max(1, Math.trunc(options.policy.max) + 1);
    const sleep = options.sleep ?? defaultSleep;
    const random = options.random ?? Math.random;
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (options.signal?.aborted === true) {
            throw new SshError('SSH_CANCELLED', 'operation cancelled before attempt', { cause: options.signal.reason });
        }
        try {
            return await task(attempt);
        }
        catch (error) {
            lastError = error;
            const code = error instanceof SshError ? error.code : 'SSH_UNKNOWN';
            const allowed = options.shouldRetry === undefined ? isRetryable(code) : options.shouldRetry(code, attempt);
            if (!allowed || attempt >= maxAttempts)
                throw error;
            const delayMs = backoffDelay(attempt - 1, options.policy, random);
            options.onRetry?.({ attempt, code, delayMs, error });
            await sleep(delayMs, options.signal);
        }
    }
    // Unreachable: the loop either returns or throws on its last iteration.
    throw lastError instanceof Error ? lastError : new SshError('SSH_UNKNOWN', 'retry loop exhausted');
}
//# sourceMappingURL=retry.js.map