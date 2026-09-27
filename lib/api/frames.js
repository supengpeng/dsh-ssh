/**
 * Frame plumbing: turning push-style sources (the exec stream hub, the session
 * registry, the auditor) into the `AsyncIterable<Frame>` a Remote stream method
 * must return.
 *
 * Three properties matter, and each is here for a reason:
 *
 *   - **No frame is lost between "the stream is registered" and "the consumer is
 *     ready".** `FrameQueue` buffers, so a frame emitted synchronously while the
 *     endpoint is still starting cannot be dropped — the ICD's调度不变式 requires
 *     `open → data(seq) → exit → end` with no holes.
 *   - **A failure becomes a `throw` at the consumer**, never a silently truncated
 *     stream: the caller's generator stops and the client's `stream` rejects,
 *     which is visible, whereas an early `return` looks like a normal end.
 *   - **The queue closes exactly once.** `close()` after `push()` is a no-op, so a
 *     source that both ends and disposes cannot produce two `end` frames.
 */
export class FrameQueue {
    buffer = [];
    waiters = [];
    closed = false;
    failure;
    failed = false;
    /** Frames handed to a consumer, for diagnostics in tests. */
    delivered = 0;
    get size() {
        return this.buffer.length;
    }
    get deliveredCount() {
        return this.delivered;
    }
    /** Enqueue one frame; ignored after the queue closed. */
    push(frame) {
        if (this.closed || this.failed)
            return;
        const waiter = this.waiters.shift();
        if (waiter !== undefined) {
            this.delivered += 1;
            waiter.resolve({ value: frame, done: false });
            return;
        }
        this.buffer.push(frame);
    }
    /** End the stream cleanly: the consumer's loop finishes after the buffered frames. */
    close() {
        if (this.closed || this.failed)
            return;
        this.closed = true;
        for (const waiter of this.waiters.splice(0)) {
            waiter.resolve({ value: undefined, done: true });
        }
    }
    /** Fail the stream: the consumer's loop throws this value at its current `yield`. */
    fail(error) {
        if (this.closed || this.failed)
            return;
        this.failed = true;
        this.failure = error;
        for (const waiter of this.waiters.splice(0)) {
            waiter.reject(error);
        }
    }
    [Symbol.asyncIterator]() {
        return {
            next: () => {
                const buffered = this.buffer.shift();
                if (buffered !== undefined) {
                    this.delivered += 1;
                    return Promise.resolve({ value: buffered, done: false });
                }
                if (this.failed)
                    return Promise.reject(this.failure);
                if (this.closed)
                    return Promise.resolve({ value: undefined, done: true });
                return new Promise((resolve, reject) => {
                    this.waiters.push({ resolve, reject });
                });
            },
            return: () => {
                // The consumer stopped early (client cancelled): drop the buffer so a
                // long-running producer cannot leak memory through a dead stream.
                this.buffer.length = 0;
                this.close();
                return Promise.resolve({ value: undefined, done: true });
            },
        };
    }
}
/**
 * Drive a subscription-style source into a generator.
 *
 * `start` registers the source and returns its unsubscribe function; every frame
 * it delivers is yielded in order until a frame satisfies `isTerminal` (then the
 * generator returns, having yielded that frame), or until the source closes the
 * queue. `signal`-driven cancellation is the caller's job through `start`'s own
 * arguments — this helper never invents one.
 */
export async function* framesUntilTerminal(queue, isTerminal) {
    for await (const frame of queue) {
        yield frame;
        if (isTerminal(frame))
            return;
    }
}
/** `true` for the one frame that ends every stream (`end`, ICD §3). */
export function isEndFrame(frame) {
    return frame.t === 'end';
}
//# sourceMappingURL=frames.js.map