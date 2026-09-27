/**
 * Host-side wire codec.
 *
 * This module is the ONE place that knows how a logical request crosses the
 * client-to-host carrier, and it is deliberately paired with exactly one
 * client-side counterpart (`client/src/bridge.js`). Everything else in the
 * plugin - every Remote method, every UI caller - speaks the logical envelope
 * frozen in `docs/ICD.md` section 2 and never inspects the wire.
 *
 * Why this exists (measured, not assumed): the M0 spike proved that calls reach
 * the host, but a rich six-key object payload arrived as a two-key object
 * (`docs/M0-SPIKE.md` section 7.2). A source-mode Remote endpoint has no
 * generated parameter codec, so the delivery shape is a property of the carrier,
 * not of our code. Rather than spread that uncertainty across dozens of call
 * sites, the decoder below accepts every shape we might receive and normalises it
 * to one, and `decodeParams` reports which shape it saw so the choice can be
 * verified in the field instead of guessed at.
 */
/** Envelope revision; bump only with a matching ICD revision. */
export declare const ENVELOPE_VERSION = 1;
/** A logical request as the UI writes it. */
export interface Envelope {
    readonly v: number;
    readonly id?: string;
    readonly method: string;
    readonly params: Record<string, unknown>;
}
/** How a delivered payload actually looked, for diagnostics. */
export type DeliveryShape = 'absent' | 'envelope-object' | 'envelope-json' | 'params-object' | 'params-json' | 'positional-array' | 'positional-single' | 'scalar' | 'unparsable';
export interface DecodedPayload {
    /** Logical parameters, always an object. */
    readonly params: Record<string, unknown>;
    /** The method named by the payload, when the payload carried one. */
    readonly method?: string;
    /** Envelope id echoed back by a caller that used one. */
    readonly id?: string;
    /** What the carrier actually delivered. */
    readonly shape: DeliveryShape;
    /** Set when the payload looked like JSON but could not be parsed. */
    readonly parseError?: string;
}
/** True for a value that survives JSON round-tripping without loss. */
export declare function isJsonSafe(value: unknown): boolean;
/**
 * Normalise whatever the carrier delivered into one logical params object.
 *
 * Accepted, because all of these were plausible and one of them is what the
 * carrier really does:
 *   - `undefined` / `null`            -> no arguments at all
 *   - `'{"..."}'`                     -> our own JSON-string convention
 *   - `{ v, method, params }`         -> a caller that sent the whole envelope
 *   - `{ ... }`                       -> a plain params object
 *   - `[{ ... }]`                     -> a positional carrier that boxed it
 *   - a bare scalar                   -> a single unnamed value
 */
export declare function decodePayload(raw: unknown): DecodedPayload;
/**
 * Read one typed field out of decoded params.
 *
 * Endpoints use this instead of casting: a source-mode call can deliver a string
 * where an object was expected, and a wrong type must become `SSH_CFG_INVALID`
 * at the call site rather than `undefined` inside business logic.
 */
export declare function field(params: Record<string, unknown>, name: string): unknown;
export declare function stringField(params: Record<string, unknown>, name: string): string | undefined;
export declare function numberField(params: Record<string, unknown>, name: string): number | undefined;
export declare function booleanField(params: Record<string, unknown>, name: string): boolean | undefined;
export declare function objectField(params: Record<string, unknown>, name: string): Record<string, unknown> | undefined;
export declare function arrayField(params: Record<string, unknown>, name: string): unknown[] | undefined;
/**
 * Make a result safe to hand back to the carrier.
 *
 * Non-JSON values are dropped rather than serialised into something the client
 * cannot interpret: a Buffer becomes `{ $bytes: base64 }` so binary really does
 * survive, and anything else unrecognised becomes `null`.
 */
export declare function encodeResult(value: unknown): unknown;
//# sourceMappingURL=codec.d.ts.map