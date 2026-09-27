/**
 * Identifier generation (docs/DESIGN.md §4): `<prefix>_<ulid>`.
 *
 * Hand-rolled rather than pulled from a dependency: the wire contract only
 * requires an opaque, sortable, collision-free string, and the host half must
 * not grow a runtime dependency for 30 lines of Crockford base32.
 */
/**
 * 26-character ULID: 48-bit millisecond timestamp + 80 random bits.
 *
 * Two ids minted in the same millisecond are ordered by their random part, which
 * is all the sortability the plugin needs (ids are never used for security).
 */
export declare function ulid(now?: number): string;
export declare function newSessionId(): string;
export declare function newStreamId(): string;
export declare function newOpId(): string;
export declare function newProfileId(): string;
//# sourceMappingURL=ids.d.ts.map