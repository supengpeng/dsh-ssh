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
import type { HostKeyPolicy } from './protocol.js';
import type { Redactor } from './redact.js';
export type KnownHostsMatch = 'unknown' | 'exact' | 'changed';
/** A negative answer; `fingerprint` is the *presented* key's, never the stored one's. */
export interface HostKeyRefusal {
    ok: false;
    code: 'SSH_HOSTKEY_UNKNOWN' | 'SSH_HOSTKEY_MISMATCH';
    fingerprint: string;
    knownHostsMatch: KnownHostsMatch;
    /** Short, value-free explanation for logs and `details`. */
    detail?: string;
    /**
     * Set only when the refusal comes from an `@revoked` line naming this host.
     *
     * Revocation is the operator's explicit "never trust this", so the caller must
     * fail the connection outright instead of offering the ICD §4.3 prompt: a
     * prompt would downgrade revocation to a suggestion the user can wave through
     * for the session. A machine-readable flag is used rather than a substring test
     * on {@link detail}, which is prose and free to change.
     */
    revoked?: true;
}
export interface HostKeyAcceptance {
    ok: true;
    knownHostsMatch: KnownHostsMatch;
    fingerprint: string;
    /** True when `accept-new` added the key during this verification. */
    remembered?: boolean;
    policy: HostKeyPolicy;
}
export type HostKeyOutcome = HostKeyAcceptance | HostKeyRefusal;
/**
 * One verification question. Named `HostKeyVerifyQuestion` — not
 * `HostKeyQuestion` — because ICD §7.1 already uses that name for the *prompt*
 * handed to `AcquireInput.onHostKeyPrompt`, which carries a fingerprint and no
 * key material. Two types with one name across two modules is how a prompt gets
 * passed where a key is expected.
 */
export interface HostKeyVerifyQuestion {
    host: string;
    port: number;
    keyType: string;
    /** The SSH wire public-key blob (`ParsedKey.getPublicSSH()`). */
    key: Buffer;
    policy?: HostKeyPolicy;
}
/** ICD §7.3 frozen interface. */
export interface KnownHostsVerifier {
    verify(q: HostKeyVerifyQuestion): Promise<HostKeyOutcome>;
    remember(q: {
        host: string;
        port: number;
        keyType: string;
        key: Buffer;
    }): Promise<void>;
    /** `'SHA256:' + base64(sha256(key))` without padding. */
    fingerprint(keyType: string, key: Buffer): string;
}
export interface KnownHostsOptions {
    /** `hostKey.knownHostsFile` from the effective configuration (already absolute). */
    file: string;
    /** Policy used when a question omits one. */
    policy?: HostKeyPolicy;
    /** `HashKnownHosts yes`: write new entries hashed instead of in cleartext. */
    hashKnownHosts?: boolean;
    logger?: {
        warn(message: string, fields?: Record<string, unknown>): void;
    } | undefined;
    /** Present for symmetry with the other security modules; never used on values here. */
    redactor?: Redactor | undefined;
}
interface KnownHostEntry {
    markers: string[];
    patterns: string[];
    /** Present for hashed entries: the two base64 halves of `|1|salt|hash`. */
    hashed?: {
        salt: Buffer;
        digest: string;
    };
    keyType: string;
    key: Buffer;
    line: number;
}
/** Key types OpenSSH accepts in the second field, used only for early validation. */
declare const KNOWN_KEY_TYPES: string[];
/**
 * `SHA256:` fingerprint of an SSH public-key blob.
 *
 * `keyType` does not enter the hash — the type is already inside the blob — but
 * it stays in the signature because ICD §7.3 freezes it, and because a caller
 * that has a type and a blob should hand both over rather than guess which is
 * which.
 */
export declare function fingerprint(keyType: string, key: Buffer | Uint8Array): string;
/** MD5 fingerprint (`aa:bb:…`), the other string a user may recognise. */
export declare function fingerprintMd5(keyType: string, key: Buffer | Uint8Array): string;
/** Whether `keyType` is one of the host-key algorithms OpenSSH writes today. */
export declare function isKnownKeyType(keyType: string): boolean;
/**
 * The name a host is stored under: `host` for port 22, `[host]:port` otherwise.
 * Host names are canonicalised to lower case, which is also what OpenSSH's
 * matching does.
 */
export declare function hostKeyLookupName(host: string, port: number): string;
/**
 * The key type encoded at the head of an SSH public-key blob (a `string` field:
 * 4-byte big-endian length followed by the bytes). Used when only the blob is
 * available, and by tests that build blobs by hand.
 */
export declare function keyTypeOfBlob(blob: Buffer): string | undefined;
/** Build the wire blob for a key type + raw key material (tests and `remember` callers). */
export declare function blobOf(keyType: string, material: Buffer): Buffer;
/** Parse a `known_hosts` document. Malformed lines are skipped, not fatal. */
export declare function parseKnownHosts(text: string): KnownHostEntry[];
/** OpenSSH's `HashKnownHosts` hash of one lookup name. */
export declare function hashHostName(name: string, salt?: Buffer): string;
/** Whether an entry names one of the candidate host names. */
export declare function entryMatchesHost(entry: KnownHostEntry, candidates: readonly string[]): boolean;
/** A `known_hosts` line for this key, unhashed. */
export declare function knownHostsLine(host: string, port: number, keyType: string, key: Buffer): string;
export declare class KnownHostsVerifierImpl implements KnownHostsVerifier {
    readonly file: string;
    private readonly defaultPolicy;
    private readonly hashNewEntries;
    private readonly logger;
    private entries;
    private stamp;
    constructor(options: KnownHostsOptions);
    fingerprint(keyType: string, key: Buffer): string;
    verify(q: HostKeyVerifyQuestion): Promise<HostKeyOutcome>;
    remember(q: {
        host: string;
        port: number;
        keyType: string;
        key: Buffer;
    }): Promise<void>;
    /** `remember`, reporting whether a new line was actually appended. */
    rememberNew(q: {
        host: string;
        port: number;
        keyType: string;
        key: Buffer;
    }): Promise<boolean>;
    /** Whether this exact key is already stored for the endpoint. */
    knows(q: {
        host: string;
        port: number;
        keyType: string;
        key: Buffer;
    }): Promise<boolean>;
    /** Number of parsed entries (diagnostics/tests). */
    get size(): number;
    /** Drop the cache so the next call re-reads the file. */
    invalidate(): void;
    /**
     * Cached read keyed on mtime+size: a long-lived session must notice a key the
     * user added with `ssh-keyscan` in another terminal, but must not re-parse the
     * file on every handshake. A file that becomes unreadable re-reads as empty,
     * which fails closed under `strict`.
     */
    private load;
}
/** Create the host-key verifier (one per plugin activation). */
export declare function createKnownHostsVerifier(options: KnownHostsOptions): KnownHostsVerifierImpl;
export { KNOWN_KEY_TYPES };
//# sourceMappingURL=known-hosts.d.ts.map