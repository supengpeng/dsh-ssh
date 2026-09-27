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

import type { ChunkEncoding } from './types.js'

export interface DecodedChunk {
  chunk: string
  encoding: ChunkEncoding
  /** Bytes of the original chunk this piece represents (before base64 expansion). */
  bytes: number
}

/**
 * The length of the longest prefix of `buffer` that ends on a UTF-8 code point
 * boundary.
 *
 * Incomplete trailing sequences are excluded, so the caller can hold them until
 * more bytes arrive. Malformed data is *not* excluded: the decoder is the single
 * place that decides "this is not UTF-8", and it needs to see the offending byte.
 */
export function completeUtf8Length(buffer: Buffer): number {
  const length = buffer.length
  if (length === 0) return 0

  let index = length - 1
  let continuations = 0
  while (index >= 0 && continuations < 3 && (buffer[index]! & 0xc0) === 0x80) {
    index -= 1
    continuations += 1
  }
  // Only continuation bytes: nothing to anchor on, let the decoder judge it.
  if (index < 0) return length

  const lead = buffer[index]!
  let expected: number
  if (lead < 0x80) expected = 1
  else if ((lead & 0xe0) === 0xc0) expected = 2
  else if ((lead & 0xf0) === 0xe0) expected = 3
  else if ((lead & 0xf8) === 0xf0) expected = 4
  else return length // invalid lead byte: report it to the decoder now

  const available = length - index
  return available < expected ? index : length
}

/** Fatal, BOM-preserving decoder: exact bytes round-trip through `utf8`. */
function decodeUtf8(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return undefined
  }
}

/**
 * Per-channel incremental decoder.
 *
 * `flush()` must be called when the channel closes: it releases any held-back
 * incomplete sequence as base64, so no byte ever disappears.
 */
export class ChannelDecoder {
  private pending: Buffer = Buffer.alloc(0)

  /** Bytes currently held back waiting for their continuation. */
  get pendingBytes(): number {
    return this.pending.length
  }

  push(chunk: Buffer): DecodedChunk[] {
    if (chunk.length === 0 && this.pending.length === 0) return []
    const combined = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk])
    const complete = completeUtf8Length(combined)
    const head = combined.subarray(0, complete)
    this.pending = complete < combined.length ? Buffer.from(combined.subarray(complete)) : Buffer.alloc(0)
    return this.decode(head)
  }

  flush(): DecodedChunk[] {
    if (this.pending.length === 0) return []
    const pending = this.pending
    this.pending = Buffer.alloc(0)
    return [{ chunk: pending.toString('base64'), encoding: 'base64', bytes: pending.length }]
  }

  private decode(bytes: Buffer): DecodedChunk[] {
    if (bytes.length === 0) return []
    const text = decodeUtf8(bytes)
    if (text !== undefined) return [{ chunk: text, encoding: 'utf8', bytes: bytes.length }]
    // Invalid UTF-8: ship the exact bytes instead of U+FFFD replacements.
    return [{ chunk: bytes.toString('base64'), encoding: 'base64', bytes: bytes.length }]
  }
}
