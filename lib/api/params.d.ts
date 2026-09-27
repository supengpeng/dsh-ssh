/**
 * Request-parameter decoding for the Remote endpoints.
 *
 * Every endpoint reads its arguments through this module and never off the raw
 * argument directly, for one measured reason: a source-mode Remote endpoint has
 * no generated parameter codec, and the carrier's delivery of a rich payload is
 * lossy (M0 §7.2 — a six-key object arrived as two keys, dropping even the string
 * *after* the nested object). Reading `raw.sessionId` would therefore work in
 * unit tests and silently return `undefined` in the browser, which the user
 * experiences as "I clicked and nothing happened".
 *
 * The convention (ICD §12 R1.3) is:
 *
 *   - a payload is a **flat object of primitives** (`string|number|boolean|null`);
 *   - a nested structure travels as a JSON string in `<field>Json`
 *     (`envJson`, `profileJson`, `secretsJson`) and is parsed here;
 *   - anything that cannot be decoded is `SSH_CFG_INVALID` — never a silent
 *     `undefined` that surfaces three layers later as an unrelated error.
 *
 * A nested value passed *directly* as an object is still accepted, because
 * in-process callers (the agent tools, the endpoint tests) legitimately do that;
 * it is reported once per field so a browser-side regression is visible in the
 * log instead of invisible.
 */
import { type DeliveryShape } from './codec.js';
export type Params = Record<string, unknown>;
export interface DecodedRequest {
    params: Params;
    /** What the carrier actually delivered; recorded in audit details and the wire probe. */
    shape: DeliveryShape;
}
/** Normalise whatever the carrier delivered into one params object. */
export declare function readParams(raw: unknown): DecodedRequest;
export declare function requiredString(params: Params, name: string, hint?: string): string;
export declare function optionalString(params: Params, name: string): string | undefined;
export declare function optionalNumber(params: Params, name: string): number | undefined;
export declare function optionalBoolean(params: Params, name: string): boolean | undefined;
/** A required enum, validated against the frozen set; an unknown value is a config error. */
export declare function requiredEnum<T extends string>(params: Params, name: string, allowed: readonly T[]): T;
/**
 * Forget which fields were already reported.
 *
 * The dedup exists so a chatty client cannot flood the log with one warning per
 * call; tests need to observe the first occurrence, so the state is resettable
 * instead of being unreachable.
 */
export declare function resetDirectNestedWarnings(): void;
/**
 * A nested object: `<name>Json` on the wire, a plain object in process.
 *
 * Malformed JSON, a JSON value that is not an object, or a field of the wrong
 * type are all `SSH_CFG_INVALID` — the caller asked for a structure and did not
 * supply one, and guessing would hide a client bug.
 */
export declare function objectJson(params: Params, name: string, onDirect?: (name: string) => void): Record<string, unknown> | undefined;
/** A nested array, with the same convention and the same strictness. */
export declare function arrayJson(params: Params, name: string, onDirect?: (name: string) => void): unknown[] | undefined;
/**
 * A `Record<string, string>` (the `env` parameter).
 *
 * Every value must be a string: a number here would be coerced silently into the
 * remote environment, where the difference between `"1"` and `1` is invisible.
 */
export declare function stringMapJson(params: Params, name: string): Record<string, string> | undefined;
/** A `string[]` (the `kinds` parameter), rejecting non-string members. */
export declare function stringArrayJson(params: Params, name: string): string[] | undefined;
/** Result shape of every endpoint: JSON-safe by construction. */
export { encodeResult } from './codec.js';
//# sourceMappingURL=params.d.ts.map