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
import { ChannelDecoder } from './encoding.js';
import { FrameWriter } from './frames.js';
import { OutputLimiter } from './limits.js';
export class StreamPump {
    writer;
    limits;
    bucketOf;
    liveDecoders = new Map();
    tailDecoders = new Map();
    buckets = new Map();
    constructor(options) {
        this.writer = options.writer;
        this.limits = options.limits;
        this.bucketOf = options.bucketOf ?? ((channel) => (channel === 'stderr' ? 'stderr' : 'stdout'));
    }
    /** Feed raw bytes from a channel; emits whatever may be emitted now. */
    push(channel, bytes) {
        if (bytes.length === 0)
            return;
        this.bucket(this.bucketOf(channel)).seen += bytes.length;
        if (this.limits === undefined) {
            this.emitDecoded(channel, this.liveDecoder(channel), bytes);
            return;
        }
        for (const retained of this.limits.push(channel, bytes)) {
            this.emitDecoded(channel, this.liveDecoder(channel), retained.chunk);
        }
    }
    /**
     * Release everything still held back, in chronological order:
     * live-decoder leftovers, then the retained tail, then the tail's leftovers.
     */
    drain() {
        for (const [channel, decoder] of this.liveDecoders) {
            this.emitPieces(channel, decoder.flush());
        }
        if (this.limits !== undefined) {
            for (const retained of this.limits.flush()) {
                this.emitDecoded(retained.channel, this.tailDecoder(retained.channel), retained.chunk);
            }
            for (const [channel, decoder] of this.tailDecoders) {
                this.emitPieces(channel, decoder.flush());
            }
        }
    }
    /** Bytes observed on a bucket, whether or not they were retained. */
    seenBytes(bucket) {
        return this.buckets.get(bucket)?.seen ?? 0;
    }
    /** Head+tail capture of a bucket as text (invalid UTF-8 becomes U+FFFD). */
    capture(bucket) {
        return Buffer.concat(this.buckets.get(bucket)?.pieces ?? []).toString('utf8');
    }
    /** True when a bucket's capture contains bytes that are not valid UTF-8. */
    isBinary(bucket) {
        return this.buckets.get(bucket)?.binary ?? false;
    }
    /** Per-channel truncation flags; all false when the pump is unbounded. */
    truncated() {
        return this.limits?.flags ?? { stdout: false, stderr: false, term: false };
    }
    get unbounded() {
        return this.limits === undefined;
    }
    liveDecoder(channel) {
        let decoder = this.liveDecoders.get(channel);
        if (decoder === undefined) {
            decoder = new ChannelDecoder();
            this.liveDecoders.set(channel, decoder);
        }
        return decoder;
    }
    tailDecoder(channel) {
        let decoder = this.tailDecoders.get(channel);
        if (decoder === undefined) {
            decoder = new ChannelDecoder();
            this.tailDecoders.set(channel, decoder);
        }
        return decoder;
    }
    emitDecoded(channel, decoder, bytes) {
        this.emitPieces(channel, decoder.push(bytes));
    }
    emitPieces(channel, pieces) {
        const bucket = this.bucket(this.bucketOf(channel));
        for (const piece of pieces) {
            this.writer.data(piece.chunk, channel, piece.encoding, piece.bytes);
            if (piece.encoding === 'base64') {
                bucket.binary = true;
                bucket.pieces.push(Buffer.from(piece.chunk, 'base64'));
            }
            else {
                bucket.pieces.push(Buffer.from(piece.chunk, 'utf8'));
            }
        }
    }
    bucket(name) {
        let bucket = this.buckets.get(name);
        if (bucket === undefined) {
            bucket = { pieces: [], seen: 0, binary: false };
            this.buckets.set(name, bucket);
        }
        return bucket;
    }
}
//# sourceMappingURL=pump.js.map