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
export const ENVELOPE_VERSION = 1

/** A logical request as the UI writes it. */
export interface Envelope {
  readonly v: number
  readonly id?: string
  readonly method: string
  readonly params: Record<string, unknown>
}

/** How a delivered payload actually looked, for diagnostics. */
export type DeliveryShape =
  | 'absent'
  | 'envelope-object'
  | 'envelope-json'
  | 'params-object'
  | 'params-json'
  | 'positional-array'
  | 'positional-single'
  | 'scalar'
  | 'unparsable'

export interface DecodedPayload {
  /** Logical parameters, always an object. */
  readonly params: Record<string, unknown>
  /** The method named by the payload, when the payload carried one. */
  readonly method?: string
  /** Envelope id echoed back by a caller that used one. */
  readonly id?: string
  /** What the carrier actually delivered. */
  readonly shape: DeliveryShape
  /** Set when the payload looked like JSON but could not be parsed. */
  readonly parseError?: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** True for a value that survives JSON round-tripping without loss. */
export function isJsonSafe(value: unknown): boolean {
  if (value === null) return true
  const type = typeof value
  if (type === 'string' || type === 'boolean') return true
  if (type === 'number') return Number.isFinite(value as number)
  if (type === 'undefined' || type === 'function' || type === 'symbol' || type === 'bigint') return false
  if (Array.isArray(value)) return value.every(isJsonSafe)
  if (isPlainObject(value)) return Object.values(value).every(isJsonSafe)
  return false
}

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
export function decodePayload(raw: unknown): DecodedPayload {
  if (raw === undefined || raw === null) return { params: {}, shape: 'absent' }

  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed === '') return { params: {}, shape: 'absent' }
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const parsed = parseJson(trimmed)
      if (!parsed.ok) return { params: {}, shape: 'unparsable', parseError: parsed.error }
      const inner = decodePayload(parsed.value)
      return { ...inner, shape: inner.shape === 'envelope-object' ? 'envelope-json' : 'params-json' }
    }
    return { params: { value: raw }, shape: 'scalar' }
  }

  if (Array.isArray(raw)) {
    if (raw.length === 0) return { params: {}, shape: 'absent' }
    if (raw.length === 1) {
      const inner = decodePayload(raw[0])
      return { params: inner.params, method: inner.method, id: inner.id, shape: 'positional-single' }
    }
    // Multiple positional arguments cannot be mapped back to names, so they are
    // exposed by index: an endpoint that declares several parameters reads them
    // from here rather than silently receiving the first one only.
    return { params: { args: raw }, shape: 'positional-array' }
  }

  if (isPlainObject(raw)) {
    const version = raw['v']
    const method = raw['method']
    if (typeof method === 'string') {
      const params = isPlainObject(raw['params']) ? (raw['params'] as Record<string, unknown>) : {}
      const id = typeof raw['id'] === 'string' ? raw['id'] : undefined
      return { params, method, id, shape: typeof version === 'number' ? 'envelope-object' : 'envelope-object' }
    }
    return { params: raw, shape: 'params-object' }
  }

  return { params: { value: raw }, shape: 'scalar' }
}

/**
 * Read one typed field out of decoded params.
 *
 * Endpoints use this instead of casting: a source-mode call can deliver a string
 * where an object was expected, and a wrong type must become `SSH_CFG_INVALID`
 * at the call site rather than `undefined` inside business logic.
 */
export function field(params: Record<string, unknown>, name: string): unknown {
  return params[name]
}

export function stringField(params: Record<string, unknown>, name: string): string | undefined {
  const value = params[name]
  return typeof value === 'string' ? value : undefined
}

export function numberField(params: Record<string, unknown>, name: string): number | undefined {
  const value = params[name]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

export function booleanField(params: Record<string, unknown>, name: string): boolean | undefined {
  const value = params[name]
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

export function objectField(params: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  const value = params[name]
  return isPlainObject(value) ? value : undefined
}

export function arrayField(params: Record<string, unknown>, name: string): unknown[] | undefined {
  const value = params[name]
  return Array.isArray(value) ? value : undefined
}

/**
 * Make a result safe to hand back to the carrier.
 *
 * Non-JSON values are dropped rather than serialised into something the client
 * cannot interpret: a Buffer becomes `{ $bytes: base64 }` so binary really does
 * survive, and anything else unrecognised becomes `null`.
 */
export function encodeResult(value: unknown): unknown {
  if (value === null || value === undefined) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') return Number.isFinite(value as number) ? value : null
  if (type === 'bigint') return String(value)
  if (type === 'function' || type === 'symbol') return null
  if (Buffer.isBuffer(value)) return { $bytes: value.toString('base64') }
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString('base64') }
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(encodeResult)
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      // `undefined` is deliberately omitted: a JSON round trip would drop it
      // anyway, and hiding that here keeps client-side checks honest.
      if (item === undefined) continue
      out[key] = encodeResult(item)
    }
    return out
  }
  return null
}
