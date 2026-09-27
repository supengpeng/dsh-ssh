/**
 * Secret hygiene helpers.
 *
 * The plugin redacts in three layers (ICD §6 `logging.redact`); this module is
 * the pure-function one the connection layer applies to anything that leaves it —
 * `SessionInfo`, error `details`, log lines. It never mutates its input.
 */

/** Key names that are dropped wholesale, mirroring `logging.redactKeys`. */
export const DEFAULT_REDACT_KEYS: readonly string[] = [
  'password',
  'passphrase',
  'privateKey',
  'secret',
  'token',
  'key',
  'authorization',
]

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

function isSecretKey(key: string, keys: readonly string[]): boolean {
  const lowered = key.toLowerCase()
  return keys.some((candidate) => candidate.toLowerCase() === lowered)
}

/**
 * Deep-copy `value`, dropping keys named like credentials.
 *
 * Buffers are replaced by a size marker: a `Buffer` inside a projection is
 * usually key material, and no wire shape needs it.
 */
export function stripSecrets<T>(value: T, keys: readonly string[] = DEFAULT_REDACT_KEYS): T {
  const walk = (input: unknown): unknown => {
    if (input === null || input === undefined) return input
    if (Buffer.isBuffer(input)) return `<${input.length} bytes>`
    if (Array.isArray(input)) return input.map(walk)
    if (input instanceof Date) return input.toISOString()
    if (input instanceof Error) return { name: input.name, message: input.message }
    if (isPlainObject(input)) {
      const out: Record<string, unknown> = {}
      for (const [key, nested] of Object.entries(input)) {
        if (isSecretKey(key, keys)) continue
        out[key] = walk(nested)
      }
      return out
    }
    if (typeof input === 'object') return input
    return input
  }
  return walk(value) as T
}

/**
 * Paths at which a known secret literal appears in `value`.
 *
 * Used by tests (and as a defence-in-depth assertion before shipping a
 * projection) to prove that no credential survived into an outbound object.
 */
export function scanForSecrets(value: unknown, secrets: Iterable<string>, path = '$'): string[] {
  const wanted = [...secrets].filter((secret) => typeof secret === 'string' && secret.length > 0)
  if (wanted.length === 0) return []
  const found: string[] = []
  const walk = (input: unknown, at: string): void => {
    if (typeof input === 'string') {
      for (const secret of wanted) {
        if (input.includes(secret)) {
          found.push(at)
          break
        }
      }
      return
    }
    if (input === null || input === undefined) return
    if (Array.isArray(input)) {
      input.forEach((item, index) => walk(item, `${at}[${index}]`))
      return
    }
    if (isPlainObject(input)) {
      for (const [key, nested] of Object.entries(input)) walk(nested, `${at}.${key}`)
    }
  }
  walk(value, path)
  return found
}
