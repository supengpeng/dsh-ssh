/**
 * Byte-to-frame decoding.
 *
 * ICD §4.4 fixes the rule for both channels: text is shipped as `encoding:'utf8'`,
 * and bytes that are not valid UTF-8 fall back to `encoding:'base64'` — lossless
 * either way. A remote read boundary is *not* a character boundary, so a naive
 * per-chunk decode would either mangle a multi-byte character split across two
 * chunks or misreport an ordinary UTF-8 stream as binary.
 *
 * {@link ChannelDecoder} therefore holds an incomplete trailing sequence back
 * until its continuation bytes arrive, and only a genuine decoding failure
 * switches that chunk to base64.
 */
import type { ChunkEncoding } from './types.js';
export interface DecodedChunk {
    chunk: string;
    encoding: ChunkEncoding;
    /** Bytes of the original chunk this piece represents (before base64 expansion). */
    bytes: number;
}
/**
 * The length of the longest prefix of `buffer` that ends on a UTF-8 code point
 * boundary.
 *
 * Incomplete trailing sequences are excluded, so the caller can hold them until
 * more bytes arrive. Malformed data is *not* excluded: the decoder is the single
 * place that decides "this is not UTF-8", and it needs to see the offending byte.
 */
export declare function completeUtf8Length(buffer: Buffer): number;
/**
 * Per-channel incremental decoder.
 *
 * `flush()` must be called when the channel closes: it releases any held-back
 * incomplete sequence as base64, so no byte ever disappears.
 */
export declare class ChannelDecoder {
    private pending;
    /** Bytes currently held back waiting for their continuation. */
    get pendingBytes(): number;
    push(chunk: Buffer): DecodedChunk[];
    flush(): DecodedChunk[];
    private decode;
}
//# sourceMappingURL=encoding.d.ts.map