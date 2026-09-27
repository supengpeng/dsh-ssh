/**
 * Secret hygiene helpers.
 *
 * The plugin redacts in three layers (ICD §6 `logging.redact`); this module is
 * the pure-function one the connection layer applies to anything that leaves it —
 * `SessionInfo`, error `details`, log lines. It never mutates its input.
 */
/** Key names that are dropped wholesale, mirroring `logging.redactKeys`. */
export declare const DEFAULT_REDACT_KEYS: readonly string[];
/**
 * Deep-copy `value`, dropping keys named like credentials.
 *
 * Buffers are replaced by a size marker: a `Buffer` inside a projection is
 * usually key material, and no wire shape needs it.
 */
export declare function stripSecrets<T>(value: T, keys?: readonly string[]): T;
/**
 * Paths at which a known secret literal appears in `value`.
 *
 * Used by tests (and as a defence-in-depth assertion before shipping a
 * projection) to prove that no credential survived into an outbound object.
 */
export declare function scanForSecrets(value: unknown, secrets: Iterable<string>, path?: string): string[];
//# sourceMappingURL=scrub.d.ts.map