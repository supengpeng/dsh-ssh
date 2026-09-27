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
import type { Frame } from '../protocol.js';
export declare class FrameQueue implements AsyncIterable<Frame> {
    private readonly buffer;
    private readonly waiters;
    private closed;
    private failure;
    private failed;
    /** Frames handed to a consumer, for diagnostics in tests. */
    private delivered;
    get size(): number;
    get deliveredCount(): number;
    /** Enqueue one frame; ignored after the queue closed. */
    push(frame: Frame): void;
    /** End the stream cleanly: the consumer's loop finishes after the buffered frames. */
    close(): void;
    /** Fail the stream: the consumer's loop throws this value at its current `yield`. */
    fail(error: unknown): void;
    [Symbol.asyncIterator](): AsyncIterator<Frame>;
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
export declare function framesUntilTerminal(queue: FrameQueue, isTerminal: (frame: Frame) => boolean): AsyncGenerator<Frame, void, undefined>;
/** `true` for the one frame that ends every stream (`end`, ICD §3). */
export declare function isEndFrame(frame: Frame): boolean;
//# sourceMappingURL=frames.d.ts.map