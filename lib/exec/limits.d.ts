/**
 * Head+tail output limiting (ICD §4.4).
 *
 * `maxOutputBytes` is the whole stream's budget, so the limiter splits it into a
 * head half that is emitted as it arrives and a tail half that is held until the
 * command ends. Nothing is dropped silently:
 *
 *   - bytes that fit are emitted exactly once, in arrival order;
 *   - bytes dropped between head and tail set the per-channel `truncated` flag;
 *   - the caller turns that flag into `end{reason:'error', error.code:'SSH_LIMIT_OUTPUT_TRUNCATED'}`.
 *
 * The tail is a ring: it never grows past its half of the budget, so a command
 * that prints forever (until its timeout) still costs a bounded amount of memory.
 */
import type { TerminalChannel } from './types.js';
export interface RetainedChunk {
    channel: TerminalChannel;
    chunk: Buffer;
}
export interface TruncationFlags {
    stdout: boolean;
    stderr: boolean;
    term: boolean;
}
/**
 * Splits a channel's byte stream into "emitted now" and "retained for the end".
 */
export declare class OutputLimiter {
    readonly maxBytes: number;
    private readonly headBudget;
    private readonly tailBudget;
    private headEmitted;
    private tailBytes;
    private flushed;
    private readonly tail;
    private readonly dropped;
    private seenBytesTotal;
    constructor(maxBytes: number);
    /** Total bytes observed on all channels. */
    get totalBytes(): number;
    /** Bytes handed back for emission so far, including the tail already flushed. */
    get emittedBytes(): number;
    /** True once any byte was dropped. */
    get exceeded(): boolean;
    /** Whether bytes were dropped on a specific channel. */
    truncated(channel: TerminalChannel): boolean;
    /** The full per-channel flag set, in the wire vocabulary. */
    get flags(): TruncationFlags;
    /** Chunks to emit immediately (head phase). */
    push(channel: TerminalChannel, chunk: Buffer): RetainedChunk[];
    /** Chunks retained for the tail half, in arrival order. Clears the ring. */
    flush(): RetainedChunk[];
    private retain;
}
//# sourceMappingURL=limits.d.ts.map