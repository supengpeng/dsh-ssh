/**
 * Per-session concurrency limiter.
 *
 * The ICD is explicit: exceeding `maxConcurrentOpsPerSession` is answered with
 * `SSH_LIMIT_QUEUE_FULL` rather than queueing, so the limiter offers a
 * non-blocking `tryAcquire` and no waiting list. Callers (the session registry)
 * translate `undefined` into the frozen error code.
 */

export type ReleaseSlot = () => void

export class OperationLimiter {
  readonly limit: number
  private active = 0

  constructor(limit: number) {
    this.limit = Math.max(1, Math.trunc(limit))
  }

  /** Number of operations currently holding a slot. */
  get inFlight(): number {
    return this.active
  }

  get available(): number {
    return Math.max(0, this.limit - this.active)
  }

  /** Take a slot, or `undefined` when the limit is reached. */
  tryAcquire(): ReleaseSlot | undefined {
    if (this.active >= this.limit) return undefined
    this.active += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.active = Math.max(0, this.active - 1)
    }
  }
}
