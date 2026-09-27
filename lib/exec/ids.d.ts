/**
 * Stream identifiers.
 *
 * ICD §0 fixes the shape: `StreamId = 'st_' + ulid`. The ULID body is the
 * canonical 48-bit timestamp + 80-bit randomness form (26 Crockford base32
 * characters), so ids sort by creation time and cannot collide across sessions
 * or restarts.
 */
/** A fresh, time-sortable stream id. */
export declare function newStreamId(now?: number): string;
//# sourceMappingURL=ids.d.ts.map