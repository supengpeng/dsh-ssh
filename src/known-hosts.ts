/**
 * Host-key verification: the three policies of ICD §6, an OpenSSH-compatible
 * `known_hosts` file, and OpenSSH-compatible SHA256 fingerprints.
 *
 * The file format matters as much as the policy, because the acceptance run
 * compares our output against a real `ssh` client: an entry we write must be
 * readable by OpenSSH, and a `SHA256:…` fingerprint we print must be the same
 * string `ssh-keyscan | ssh-keygen -lf -` prints. Concretely:
 *
 *   - The fingerprint is `base64(sha256(<SSH wire public-key blob>))` with the
 *     `=` padding stripped and a `SHA256:` prefix. The blob is what
 *     `ssh2`'s `ParsedKey.getPublicSSH()` returns and what the second field of a
 *     `known_hosts` line base64-decodes to.
 *   - A line is `[markers] host[,host] keytype base64blob [comment]`, with
 *     `[host]:port` for any port other than 22 — including an explicit `:22`
 *     match on read, which some tools write.
 *   - Hashed entries (`HashKnownHosts yes`) are read *and* can be written:
 *     `|1|<base64 salt>|<base64 HMAC-SHA1(salt, host)>`.
 *
 * Policy semantics (mirroring `StrictHostKeyChecking`):
 *
 *   | policy       | unknown host                                   | changed key |
 *   |--------------|------------------------------------------------|-------------|
 *   | `strict`     | refuse (`SSH_HOSTKEY_UNKNOWN`)                 | refuse      |
 *   | `accept-new` | accept **and** add to `known_hosts`            | refuse      |
 *   | `insecure`   | accept (no store access at all)                | accept      |
 *
 * A changed key is refused by every policy: `accept-new` is precisely "trust on
 * first use", not "trust on every use". A key under an `@revoked` marker is
 * always refused. Verification never throws — the caller turns a negative answer
 * into `SSH_HOSTKEY_UNKNOWN` / `SSH_HOSTKEY_MISMATCH` and, for a mismatch, into
 * the ICD §4.3 `pendingHostKey` prompt.
 */

import { createHash, createHmac, randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

import type { HostKeyPolicy } from './protocol.js'
import type { Redactor } from './redact.js'

export type KnownHostsMatch = 'unknown' | 'exact' | 'changed'

/** A negative answer; `fingerprint` is the *presented* key's, never the stored one's. */
export interface HostKeyRefusal {
  ok: false
  code: 'SSH_HOSTKEY_UNKNOWN' | 'SSH_HOSTKEY_MISMATCH'
  fingerprint: string
  knownHostsMatch: KnownHostsMatch
  /** Short, value-free explanation for logs and `details`. */
  detail?: string
}

export interface HostKeyAcceptance {
  ok: true
  knownHostsMatch: KnownHostsMatch
  fingerprint: string
  /** True when `accept-new` added the key during this verification. */
  remembered?: boolean
  policy: HostKeyPolicy
}

export type HostKeyOutcome = HostKeyAcceptance | HostKeyRefusal

/**
 * One verification question. Named `HostKeyVerifyQuestion` — not
 * `HostKeyQuestion` — because ICD §7.1 already uses that name for the *prompt*
 * handed to `AcquireInput.onHostKeyPrompt`, which carries a fingerprint and no
 * key material. Two types with one name across two modules is how a prompt gets
 * passed where a key is expected.
 */
export interface HostKeyVerifyQuestion {
  host: string
  port: number
  keyType: string
  /** The SSH wire public-key blob (`ParsedKey.getPublicSSH()`). */
  key: Buffer
  policy?: HostKeyPolicy
}

/** ICD §7.3 frozen interface. */
export interface KnownHostsVerifier {
  verify(q: HostKeyVerifyQuestion): Promise<HostKeyOutcome>
  remember(q: { host: string; port: number; keyType: string; key: Buffer }): Promise<void>
  /** `'SHA256:' + base64(sha256(key))` without padding. */
  fingerprint(keyType: string, key: Buffer): string
}

export interface KnownHostsOptions {
  /** `hostKey.knownHostsFile` from the effective configuration (already absolute). */
  file: string
  /** Policy used when a question omits one. */
  policy?: HostKeyPolicy
  /** `HashKnownHosts yes`: write new entries hashed instead of in cleartext. */
  hashKnownHosts?: boolean
  logger?: { warn(message: string, fields?: Record<string, unknown>): void } | undefined
  /** Present for symmetry with the other security modules; never used on values here. */
  redactor?: Redactor | undefined
}

interface KnownHostEntry {
  markers: string[]
  patterns: string[]
  /** Present for hashed entries: the two base64 halves of `|1|salt|hash`. */
  hashed?: { salt: Buffer; digest: string }
  keyType: string
  key: Buffer
  line: number
}

// ---------------------------------------------------------------------------
// Fingerprints and names
// ---------------------------------------------------------------------------

/** Key types OpenSSH accepts in the second field, used only for early validation. */
const KNOWN_KEY_TYPES = [
  'ssh-rsa',
  'ssh-dss',
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com',
]

/**
 * `SHA256:` fingerprint of an SSH public-key blob.
 *
 * `keyType` does not enter the hash — the type is already inside the blob — but
 * it stays in the signature because ICD §7.3 freezes it, and because a caller
 * that has a type and a blob should hand both over rather than guess which is
 * which.
 */
export function fingerprint(keyType: string, key: Buffer | Uint8Array): string {
  void keyType // frozen signature: the type is already inside the blob
  const bytes = Buffer.isBuffer(key) ? key : Buffer.from(key)
  return `SHA256:${createHash('sha256').update(bytes).digest('base64').replace(/=+$/, '')}`
}

/** MD5 fingerprint (`aa:bb:…`), the other string a user may recognise. */
export function fingerprintMd5(keyType: string, key: Buffer | Uint8Array): string {
  void keyType
  const bytes = Buffer.isBuffer(key) ? key : Buffer.from(key)
  return `MD5:${createHash('md5').update(bytes).digest('hex').replace(/(..)(?=.)/g, '$1:')}`
}

/** Whether `keyType` is one of the host-key algorithms OpenSSH writes today. */
export function isKnownKeyType(keyType: string): boolean {
  return KNOWN_KEY_TYPES.includes(keyType)
}

/**
 * The name a host is stored under: `host` for port 22, `[host]:port` otherwise.
 * Host names are canonicalised to lower case, which is also what OpenSSH's
 * matching does.
 */
export function hostKeyLookupName(host: string, port: number): string {
  const name = host.trim().replace(/^\[|\]$/g, '').toLowerCase()
  return port === 22 ? name : `[${name}]:${port}`
}

/** Every name that could legitimately describe this endpoint. */
function lookupCandidates(host: string, port: number): string[] {
  const canonical = hostKeyLookupName(host, port)
  if (port !== 22) return [canonical]
  const name = canonical
  return [`${name}`, `[${name}]:22`]
}

/**
 * The key type encoded at the head of an SSH public-key blob (a `string` field:
 * 4-byte big-endian length followed by the bytes). Used when only the blob is
 * available, and by tests that build blobs by hand.
 */
export function keyTypeOfBlob(blob: Buffer): string | undefined {
  if (blob.length < 4) return undefined
  const length = blob.readUInt32BE(0)
  if (length <= 0 || length > 128 || blob.length < 4 + length) return undefined
  return blob.subarray(4, 4 + length).toString('utf8')
}

/** Build the wire blob for a key type + raw key material (tests and `remember` callers). */
export function blobOf(keyType: string, material: Buffer): Buffer {
  const typeBytes = Buffer.from(keyType, 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(typeBytes.length, 0)
  return Buffer.concat([header, typeBytes, material])
}

// ---------------------------------------------------------------------------
// known_hosts parsing and matching
// ---------------------------------------------------------------------------

const MARKER_PATTERN = /^@[a-z-]+$/
/**
 * The base64 field must be genuinely base64. `Buffer.from(x, 'base64')` silently
 * ignores invalid characters, so without this check a garbage line would decode to
 * a few bytes and become a phantom entry that can never match a real key.
 */
const BASE64_FIELD = /^[A-Za-z0-9+/]+={0,2}$/

/** Parse a `known_hosts` document. Malformed lines are skipped, not fatal. */
export function parseKnownHosts(text: string): KnownHostEntry[] {
  const entries: KnownHostEntry[] = []
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? ''
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const fields = trimmed.split(/\s+/)
    const markers: string[] = []
    while (fields.length > 0 && MARKER_PATTERN.test(fields[0] ?? '')) {
      const marker = fields.shift()
      if (marker !== undefined) markers.push(marker)
    }
    const names = fields.shift()
    const keyType = fields.shift()
    const encoded = fields.shift()
    if (names === undefined || keyType === undefined || encoded === undefined) continue
    if (!BASE64_FIELD.test(encoded)) continue
    const key = Buffer.from(encoded, 'base64')
    if (key.length === 0) continue
    if (names.startsWith('|1|')) {
      // `|1|<salt>|<hmac>` — split on '|' yields ['', '1', salt, digest], so the
      // version marker is index 1 and the salt is index 2. Destructuring
      // positionally from index 0 would silently take the marker as the salt,
      // which then base64-decodes to zero bytes and drops the entry.
      const parts = names.split('|')
      const saltText = parts[2]
      const digest = parts[3]
      if (saltText === undefined || digest === undefined || digest === '') continue
      const salt = Buffer.from(saltText, 'base64')
      if (salt.length === 0) continue
      entries.push({ markers, patterns: [], hashed: { salt, digest }, keyType, key, line: index + 1 })
      continue
    }
    entries.push({ markers, patterns: names.split(',').filter((pattern) => pattern !== ''), keyType, key, line: index + 1 })
  }
  return entries
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

/** OpenSSH's `HashKnownHosts` hash of one lookup name. */
export function hashHostName(name: string, salt: Buffer = randomBytes(20)): string {
  const digest = createHmac('sha1', salt).update(name, 'utf8').digest('base64')
  return `|1|${salt.toString('base64')}|${digest}`
}

function matchesHashed(entry: KnownHostEntry, candidates: readonly string[]): boolean {
  const hashed = entry.hashed
  if (hashed === undefined) return false
  for (const candidate of candidates) {
    const digestText = createHmac('sha1', hashed.salt).update(candidate, 'utf8').digest('base64')
    if (digestText === hashed.digest) return true
    // Tolerate padding differences between writers.
    if (digestText.replace(/=+$/, '') === hashed.digest.replace(/=+$/, '')) return true
  }
  return false
}

/** Whether an entry names one of the candidate host names. */
export function entryMatchesHost(entry: KnownHostEntry, candidates: readonly string[]): boolean {
  if (entry.hashed !== undefined) return matchesHashed(entry, candidates)
  let positive = false
  for (const pattern of entry.patterns) {
    const negated = pattern.startsWith('!')
    const matcher = globToRegExp(negated ? pattern.slice(1) : pattern)
    const hit = candidates.some((candidate) => matcher.test(candidate))
    if (!hit) continue
    // A negated pattern excludes the entry outright, whatever the others say.
    if (negated) return false
    positive = true
  }
  return positive
}

/** A `known_hosts` line for this key, unhashed. */
export function knownHostsLine(host: string, port: number, keyType: string, key: Buffer): string {
  return `${hostKeyLookupName(host, port)} ${keyType} ${key.toString('base64')}`
}

function buffersEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && left.equals(right)
}

// ---------------------------------------------------------------------------
// Verifier
// ---------------------------------------------------------------------------

export class KnownHostsVerifierImpl implements KnownHostsVerifier {
  readonly file: string
  private readonly defaultPolicy: HostKeyPolicy
  private readonly hashNewEntries: boolean
  private readonly logger: KnownHostsOptions['logger']
  private entries: KnownHostEntry[] | undefined
  private stamp: string | undefined

  constructor(options: KnownHostsOptions) {
    this.file = options.file
    this.defaultPolicy = options.policy ?? 'accept-new'
    this.hashNewEntries = options.hashKnownHosts === true
    this.logger = options.logger
  }

  fingerprint(keyType: string, key: Buffer): string {
    return fingerprint(keyType, key)
  }

  async verify(q: HostKeyVerifyQuestion): Promise<HostKeyOutcome> {
    const policy = q.policy ?? this.defaultPolicy
    const presented = this.fingerprint(q.keyType, q.key)

    // `insecure` is a deliberate "do not check": reading the file would only
    // create a false impression of verification, and the marker is what the UI
    // reports as "host key not verified".
    if (policy === 'insecure') {
      return { ok: true, knownHostsMatch: 'unknown', fingerprint: presented, policy }
    }

    const candidates = lookupCandidates(q.host, q.port)
    const entries = this.load()
    let changed = false
    for (const entry of entries) {
      if (entry.keyType !== q.keyType) continue
      if (!entryMatchesHost(entry, candidates)) continue
      if (!buffersEqual(entry.key, q.key)) {
        changed = true
        continue
      }
      if (entry.markers.includes('@revoked')) {
        return {
          ok: false,
          code: 'SSH_HOSTKEY_MISMATCH',
          fingerprint: presented,
          knownHostsMatch: 'changed',
          detail: 'this key is marked @revoked in known_hosts',
        }
      }
      return { ok: true, knownHostsMatch: 'exact', fingerprint: presented, policy }
    }

    if (changed) {
      return {
        ok: false,
        code: 'SSH_HOSTKEY_MISMATCH',
        fingerprint: presented,
        knownHostsMatch: 'changed',
        detail: 'known_hosts already holds a different key of this type for the host',
      }
    }

    if (policy === 'accept-new') {
      const remembered = await this.rememberNew(q)
      return { ok: true, knownHostsMatch: 'unknown', fingerprint: presented, remembered, policy }
    }

    return {
      ok: false,
      code: 'SSH_HOSTKEY_UNKNOWN',
      fingerprint: presented,
      knownHostsMatch: 'unknown',
      detail: 'no known_hosts entry for this host and key type',
    }
  }

  async remember(q: { host: string; port: number; keyType: string; key: Buffer }): Promise<void> {
    await this.rememberNew(q)
  }

  /** `remember`, reporting whether a new line was actually appended. */
  async rememberNew(q: { host: string; port: number; keyType: string; key: Buffer }): Promise<boolean> {
    const candidates = lookupCandidates(q.host, q.port)
    for (const entry of this.load()) {
      if (entry.keyType !== q.keyType) continue
      if (!buffersEqual(entry.key, q.key)) continue
      if (entryMatchesHost(entry, candidates)) return false
    }
    const line = this.hashNewEntries ? `${hashHostName(hostKeyLookupName(q.host, q.port))} ${q.keyType} ${q.key.toString('base64')}` : knownHostsLine(q.host, q.port, q.keyType, q.key)
    let written = false
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      appendFileSync(this.file, `${line}\n`, { encoding: 'utf8', mode: 0o600 })
      written = true
    } catch (error) {
      // An unwritable known_hosts file must not fail a login the user asked for:
      // the pool still knows the key for this process, and the warning says so.
      this.logger?.warn('could not add the host key to known_hosts', {
        file: this.file,
        host: q.host,
        port: q.port,
        keyType: q.keyType,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
    this.invalidate()
    return written
  }

  /** Whether this exact key is already stored for the endpoint. */
  async knows(q: { host: string; port: number; keyType: string; key: Buffer }): Promise<boolean> {
    const candidates = lookupCandidates(q.host, q.port)
    return this.load().some((entry) => entry.keyType === q.keyType && buffersEqual(entry.key, q.key) && entryMatchesHost(entry, candidates))
  }

  /** Number of parsed entries (diagnostics/tests). */
  get size(): number {
    return this.load().length
  }

  /** Drop the cache so the next call re-reads the file. */
  invalidate(): void {
    this.entries = undefined
    this.stamp = undefined
  }

  /**
   * Cached read keyed on mtime+size: a long-lived session must notice a key the
   * user added with `ssh-keyscan` in another terminal, but must not re-parse the
   * file on every handshake. A file that becomes unreadable re-reads as empty,
   * which fails closed under `strict`.
   */
  private load(): KnownHostEntry[] {
    let stamp = 'missing'
    try {
      const info = statSync(this.file)
      stamp = `${info.mtimeMs}:${info.size}`
    } catch {
      /* absent or unreadable: treat as an empty file, i.e. every host is new */
    }
    if (this.entries !== undefined && stamp === this.stamp) return this.entries
    let text = ''
    if (stamp !== 'missing') {
      try {
        text = readFileSync(this.file, 'utf8')
      } catch {
        text = ''
      }
    }
    const parsed = parseKnownHosts(text)
    this.entries = parsed
    this.stamp = stamp
    return parsed
  }
}

/** Create the host-key verifier (one per plugin activation). */
export function createKnownHostsVerifier(options: KnownHostsOptions): KnownHostsVerifierImpl {
  return new KnownHostsVerifierImpl(options)
}

export { KNOWN_KEY_TYPES }
