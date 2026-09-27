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
 * Two rules widen what "changed" means, and both are deliberate departures from a
 * naively per-algorithm reading of `known_hosts` — recorded here because the file
 * format no longer explains the policy on its own:
 *
 *   - **A new key type for a host we already know is a change, not a new host.**
 *     Entries are pinned per algorithm, so without this rule a server — or anyone
 *     able to present a second algorithm — would obtain trust-on-first-use for a
 *     host whose key is already pinned, and that wrong key would be written to the
 *     file. Only a host with no entry at all is `unknown`.
 *   - **`@revoked` is a statement about the host, not about one algorithm.** Any
 *     `@revoked` line naming this host refuses every key type for it, whichever
 *     algorithm the server presents. Revocation is therefore checked *before* the
 *     key-type filter: a revoked host cannot be reached by switching algorithms.
 *
 * A changed key is refused by every policy: `accept-new` is precisely "trust on
 * first use", not "trust on every use". Verification never throws — the caller
 * turns a negative answer into `SSH_HOSTKEY_UNKNOWN` / `SSH_HOSTKEY_MISMATCH` and,
 * for a mismatch, into the ICD §4.3 `pendingHostKey` prompt.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
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
];
/**
 * `SHA256:` fingerprint of an SSH public-key blob.
 *
 * `keyType` does not enter the hash — the type is already inside the blob — but
 * it stays in the signature because ICD §7.3 freezes it, and because a caller
 * that has a type and a blob should hand both over rather than guess which is
 * which.
 */
export function fingerprint(keyType, key) {
    void keyType; // frozen signature: the type is already inside the blob
    const bytes = Buffer.isBuffer(key) ? key : Buffer.from(key);
    return `SHA256:${createHash('sha256').update(bytes).digest('base64').replace(/=+$/, '')}`;
}
/** MD5 fingerprint (`aa:bb:…`), the other string a user may recognise. */
export function fingerprintMd5(keyType, key) {
    void keyType;
    const bytes = Buffer.isBuffer(key) ? key : Buffer.from(key);
    return `MD5:${createHash('md5').update(bytes).digest('hex').replace(/(..)(?=.)/g, '$1:')}`;
}
/** Whether `keyType` is one of the host-key algorithms OpenSSH writes today. */
export function isKnownKeyType(keyType) {
    return KNOWN_KEY_TYPES.includes(keyType);
}
/**
 * The name a host is stored under: `host` for port 22, `[host]:port` otherwise.
 * Host names are canonicalised to lower case, which is also what OpenSSH's
 * matching does.
 */
export function hostKeyLookupName(host, port) {
    const name = host.trim().replace(/^\[|\]$/g, '').toLowerCase();
    return port === 22 ? name : `[${name}]:${port}`;
}
/** Every name that could legitimately describe this endpoint. */
function lookupCandidates(host, port) {
    const canonical = hostKeyLookupName(host, port);
    if (port !== 22)
        return [canonical];
    const name = canonical;
    return [`${name}`, `[${name}]:22`];
}
/**
 * The key type encoded at the head of an SSH public-key blob (a `string` field:
 * 4-byte big-endian length followed by the bytes). Used when only the blob is
 * available, and by tests that build blobs by hand.
 */
export function keyTypeOfBlob(blob) {
    if (blob.length < 4)
        return undefined;
    const length = blob.readUInt32BE(0);
    if (length <= 0 || length > 128 || blob.length < 4 + length)
        return undefined;
    return blob.subarray(4, 4 + length).toString('utf8');
}
/** Build the wire blob for a key type + raw key material (tests and `remember` callers). */
export function blobOf(keyType, material) {
    const typeBytes = Buffer.from(keyType, 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(typeBytes.length, 0);
    return Buffer.concat([header, typeBytes, material]);
}
// ---------------------------------------------------------------------------
// known_hosts parsing and matching
// ---------------------------------------------------------------------------
const MARKER_PATTERN = /^@[a-z-]+$/;
/**
 * The base64 field must be genuinely base64. `Buffer.from(x, 'base64')` silently
 * ignores invalid characters, so without this check a garbage line would decode to
 * a few bytes and become a phantom entry that can never match a real key.
 */
const BASE64_FIELD = /^[A-Za-z0-9+/]+={0,2}$/;
/** Parse a `known_hosts` document. Malformed lines are skipped, not fatal. */
export function parseKnownHosts(text) {
    const entries = [];
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
        const raw = lines[index] ?? '';
        const trimmed = raw.trim();
        if (trimmed === '' || trimmed.startsWith('#'))
            continue;
        const fields = trimmed.split(/\s+/);
        const markers = [];
        while (fields.length > 0 && MARKER_PATTERN.test(fields[0] ?? '')) {
            const marker = fields.shift();
            if (marker !== undefined)
                markers.push(marker);
        }
        const names = fields.shift();
        const keyType = fields.shift();
        const encoded = fields.shift();
        if (names === undefined || keyType === undefined || encoded === undefined)
            continue;
        if (!BASE64_FIELD.test(encoded))
            continue;
        const key = Buffer.from(encoded, 'base64');
        if (key.length === 0)
            continue;
        if (names.startsWith('|1|')) {
            // `|1|<salt>|<hmac>` — split on '|' yields ['', '1', salt, digest], so the
            // version marker is index 1 and the salt is index 2. Destructuring
            // positionally from index 0 would silently take the marker as the salt,
            // which then base64-decodes to zero bytes and drops the entry.
            const parts = names.split('|');
            const saltText = parts[2];
            const digest = parts[3];
            if (saltText === undefined || digest === undefined || digest === '')
                continue;
            const salt = Buffer.from(saltText, 'base64');
            if (salt.length === 0)
                continue;
            entries.push({ markers, patterns: [], hashed: { salt, digest }, keyType, key, line: index + 1 });
            continue;
        }
        entries.push({ markers, patterns: names.split(',').filter((pattern) => pattern !== ''), keyType, key, line: index + 1 });
    }
    return entries;
}
function globToRegExp(pattern) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`, 'i');
}
/** OpenSSH's `HashKnownHosts` hash of one lookup name. */
export function hashHostName(name, salt = randomBytes(20)) {
    const digest = createHmac('sha1', salt).update(name, 'utf8').digest('base64');
    return `|1|${salt.toString('base64')}|${digest}`;
}
function matchesHashed(entry, candidates) {
    const hashed = entry.hashed;
    if (hashed === undefined)
        return false;
    for (const candidate of candidates) {
        const digestText = createHmac('sha1', hashed.salt).update(candidate, 'utf8').digest('base64');
        if (digestText === hashed.digest)
            return true;
        // Tolerate padding differences between writers.
        if (digestText.replace(/=+$/, '') === hashed.digest.replace(/=+$/, ''))
            return true;
    }
    return false;
}
/** Whether an entry names one of the candidate host names. */
export function entryMatchesHost(entry, candidates) {
    if (entry.hashed !== undefined)
        return matchesHashed(entry, candidates);
    let positive = false;
    for (const pattern of entry.patterns) {
        const negated = pattern.startsWith('!');
        const matcher = globToRegExp(negated ? pattern.slice(1) : pattern);
        const hit = candidates.some((candidate) => matcher.test(candidate));
        if (!hit)
            continue;
        // A negated pattern excludes the entry outright, whatever the others say.
        if (negated)
            return false;
        positive = true;
    }
    return positive;
}
/** A `known_hosts` line for this key, unhashed. */
export function knownHostsLine(host, port, keyType, key) {
    return `${hostKeyLookupName(host, port)} ${keyType} ${key.toString('base64')}`;
}
function buffersEqual(left, right) {
    return left.length === right.length && left.equals(right);
}
// ---------------------------------------------------------------------------
// Verifier
// ---------------------------------------------------------------------------
export class KnownHostsVerifierImpl {
    file;
    defaultPolicy;
    hashNewEntries;
    logger;
    entries;
    stamp;
    constructor(options) {
        this.file = options.file;
        this.defaultPolicy = options.policy ?? 'accept-new';
        this.hashNewEntries = options.hashKnownHosts === true;
        this.logger = options.logger;
    }
    fingerprint(keyType, key) {
        return fingerprint(keyType, key);
    }
    async verify(q) {
        const policy = q.policy ?? this.defaultPolicy;
        const presented = this.fingerprint(q.keyType, q.key);
        // `insecure` is a deliberate "do not check": reading the file would only
        // create a false impression of verification, and the marker is what the UI
        // reports as "host key not verified".
        if (policy === 'insecure') {
            return { ok: true, knownHostsMatch: 'unknown', fingerprint: presented, policy };
        }
        const candidates = lookupCandidates(q.host, q.port);
        const entries = this.load();
        // ── 1. Revocation, across every key type, before anything else ────────────
        // `@revoked` names a host, not an algorithm: a server that can present a
        // second key type must not be able to walk past a revoked entry, and the
        // revoked key itself must stay refused. Testing the marker first keeps this
        // pass O(1) per entry for the common file that carries no markers at all.
        for (const entry of entries) {
            if (!entry.markers.includes('@revoked'))
                continue;
            if (!entryMatchesHost(entry, candidates))
                continue;
            return {
                ok: false,
                code: 'SSH_HOSTKEY_MISMATCH',
                fingerprint: presented,
                knownHostsMatch: 'changed',
                detail: 'this host is marked @revoked in known_hosts: every key type for it is refused',
                revoked: true,
            };
        }
        // ── 2. Entries of the presented key type (the original fast path) ─────────
        let changed = false;
        for (const entry of entries) {
            if (entry.keyType !== q.keyType)
                continue;
            if (!entryMatchesHost(entry, candidates))
                continue;
            if (!buffersEqual(entry.key, q.key)) {
                changed = true;
                continue;
            }
            return { ok: true, knownHostsMatch: 'exact', fingerprint: presented, policy };
        }
        if (changed) {
            return {
                ok: false,
                code: 'SSH_HOSTKEY_MISMATCH',
                fingerprint: presented,
                knownHostsMatch: 'changed',
                detail: 'known_hosts already holds a different key of this type for the host',
            };
        }
        // ── 3. Another key type for a host we already know is a change ────────────
        // Only reached when no entry of the presented type names this host — exactly
        // the case this guard exists for — so the cross-type host match (an HMAC per
        // hashed entry) is not paid on the exact-match or same-type-mismatch paths.
        // Every entry that reaches the body here is of a different key type, because
        // step 2 already rejected the matching ones.
        for (const entry of entries) {
            if (!entryMatchesHost(entry, candidates))
                continue;
            return {
                ok: false,
                code: 'SSH_HOSTKEY_MISMATCH',
                fingerprint: presented,
                knownHostsMatch: 'changed',
                detail: 'known_hosts holds a key for this host under another key type: a new key type is a change, not a new host',
            };
        }
        if (policy === 'accept-new') {
            const remembered = await this.rememberNew(q);
            return { ok: true, knownHostsMatch: 'unknown', fingerprint: presented, remembered, policy };
        }
        return {
            ok: false,
            code: 'SSH_HOSTKEY_UNKNOWN',
            fingerprint: presented,
            knownHostsMatch: 'unknown',
            detail: 'no known_hosts entry for this host and key type',
        };
    }
    async remember(q) {
        await this.rememberNew(q);
    }
    /** `remember`, reporting whether a new line was actually appended. */
    async rememberNew(q) {
        const candidates = lookupCandidates(q.host, q.port);
        for (const entry of this.load()) {
            if (entry.keyType !== q.keyType)
                continue;
            if (!buffersEqual(entry.key, q.key))
                continue;
            if (entryMatchesHost(entry, candidates))
                return false;
        }
        const line = this.hashNewEntries ? `${hashHostName(hostKeyLookupName(q.host, q.port))} ${q.keyType} ${q.key.toString('base64')}` : knownHostsLine(q.host, q.port, q.keyType, q.key);
        let written = false;
        try {
            mkdirSync(dirname(this.file), { recursive: true });
            appendFileSync(this.file, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
            written = true;
        }
        catch (error) {
            // An unwritable known_hosts file must not fail a login the user asked for:
            // the pool still knows the key for this process, and the warning says so.
            this.logger?.warn('could not add the host key to known_hosts', {
                file: this.file,
                host: q.host,
                port: q.port,
                keyType: q.keyType,
                reason: error instanceof Error ? error.message : String(error),
            });
        }
        this.invalidate();
        return written;
    }
    /** Whether this exact key is already stored for the endpoint. */
    async knows(q) {
        const candidates = lookupCandidates(q.host, q.port);
        return this.load().some((entry) => entry.keyType === q.keyType && buffersEqual(entry.key, q.key) && entryMatchesHost(entry, candidates));
    }
    /** Number of parsed entries (diagnostics/tests). */
    get size() {
        return this.load().length;
    }
    /** Drop the cache so the next call re-reads the file. */
    invalidate() {
        this.entries = undefined;
        this.stamp = undefined;
    }
    /**
     * Cached read keyed on mtime+size: a long-lived session must notice a key the
     * user added with `ssh-keyscan` in another terminal, but must not re-parse the
     * file on every handshake. A file that becomes unreadable re-reads as empty,
     * which fails closed under `strict`.
     */
    load() {
        let stamp = 'missing';
        try {
            const info = statSync(this.file);
            stamp = `${info.mtimeMs}:${info.size}`;
        }
        catch {
            /* absent or unreadable: treat as an empty file, i.e. every host is new */
        }
        if (this.entries !== undefined && stamp === this.stamp)
            return this.entries;
        let text = '';
        if (stamp !== 'missing') {
            try {
                text = readFileSync(this.file, 'utf8');
            }
            catch {
                text = '';
            }
        }
        const parsed = parseKnownHosts(text);
        this.entries = parsed;
        this.stamp = stamp;
        return parsed;
    }
}
/** Create the host-key verifier (one per plugin activation). */
export function createKnownHostsVerifier(options) {
    return new KnownHostsVerifierImpl(options);
}
export { KNOWN_KEY_TYPES };
//# sourceMappingURL=known-hosts.js.map