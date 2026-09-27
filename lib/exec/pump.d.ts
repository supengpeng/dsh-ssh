/**
 * The byte pump shared by `exec` and `shell`.
 *
 * One place decides how raw channel bytes become `data` frames, because the
 * three concerns are entangled and easy to get subtly wrong:
 *
 *   1. **UTF-8 boundaries** — remote reads split multi-byte characters, so the
 *      decoder holds an incomplete sequence until its continuation arrives
 *      ({@link ChannelDecoder});
 *   2. **the output limit** — head bytes are emitted live, tail bytes are held as
 *      raw bytes and emitted when the stream ends ({@link OutputLimiter}); the
 *      tail is decoded by its own decoder because it is a different byte window;
 *   3. **capture** — `execWait` and the agent tool want the head+tail text, not
 *      the frames, so the pump also accumulates the bytes it emitted.
 *
 * `limits` is optional: an interactive PTY passes none, because a terminal is a
 * live screen rather than a finite result and head+tail would corrupt it (the
 * hub still bounds the *replay* window for reconnecting clients).
 */
import { FrameWriter } from './frames.js';
import { OutputLimiter, type TruncationFlags } from './limits.js';
import type { TerminalChannel } from './types.js';
export interface StreamPumpOptions {
    writer: FrameWriter;
    /** Omitted for unbounded streams (interactive shells). */
    limits?: OutputLimiter;
    /** Result bucket a channel accumulates into; defaults to stderr→stderr, else stdout. */
    bucketOf?: (channel: TerminalChannel) => string;
    /** Channel reported as truncated for a `term` overflow (PTY `exec`). */
    termBucket?: string;
}
export declare class StreamPump {
    private readonly writer;
    private readonly limits;
    private readonly bucketOf;
    private readonly liveDecoders;
    private readonly tailDecoders;
    private readonly buckets;
    constructor(options: StreamPumpOptions);
    /** Feed raw bytes from a channel; emits whatever may be emitted now. */
    push(channel: TerminalChannel, bytes: Buffer): void;
    /**
     * Release everything still held back, in chronological order:
     * live-decoder leftovers, then the retained tail, then the tail's leftovers.
     */
    drain(): void;
    /** Bytes observed on a bucket, whether or not they were retained. */
    seenBytes(bucket: string): number;
    /** Head+tail capture of a bucket as text (invalid UTF-8 becomes U+FFFD). */
    capture(bucket: string): string;
    /** True when a bucket's capture contains bytes that are not valid UTF-8. */
    isBinary(bucket: string): boolean;
    /** Per-channel truncation flags; all false when the pump is unbounded. */
    truncated(): TruncationFlags;
    get unbounded(): boolean;
    private liveDecoder;
    private tailDecoder;
    private emitDecoded;
    private emitPieces;
    private bucket;
}
//# sourceMappingURL=pump.d.ts.map