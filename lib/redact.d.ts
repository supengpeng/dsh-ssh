/**
 * Secret redaction — the single place a plaintext credential could become log,
 * audit or UI text, and the place that stops it.
 *
 * One of the ten acceptance criteria is literally "凭据不在日志与 UI 明文中出现"
 * ("credentials never appear in cleartext in logs or the UI"), so this module is
 * a security control rather than a formatting helper. It is defence in depth:
 * three independent layers, each of which alone would already stop the common
 * case, and which together also stop the shapes an attacker (or an unlucky
 * `console.log`) actually produces.
 *
 *   1. **Structured keys** — a key named `password`, `passphrase`, `privateKey`,
 *      `Authorization`, `api_key`, … has its value replaced wholesale, whatever
 *      its type. Catches every object that reaches a logger without ever being
 *      told what a secret looks like.
 *   2. **Tracked literals** — `track(secret)` registers the *actual* bytes of a
 *      resolved secret (plus its URL-encoded, JSON-escaped, base64 and hex
 *      spellings), and every occurrence anywhere in a string is replaced. This is
 *      what makes a secret inside a URL, a stack trace, a JSON string or as a
 *      substring of a longer token safe.
 *   3. **Adversarial shapes** — regexes for secrets nobody told us about:
 *      `scheme://user:password@host`, `Authorization: Bearer …`,
 *      `password=…` / `--password …`, PEM private-key blocks, secrets split
 *      across adjacent fields, and base64/hex blobs whose *decoded* form
 *      contains a tracked literal.
 *
 * Invariants the tests pin down:
 *   - `scrub()` never mutates its input; it returns a detached copy.
 *   - The mask is always exactly {@link SECRET_MASK} and never varies with the
 *     secret's length (ICD §4.2: "固定 8 点，不泄漏长度").
 *   - Cycles are tolerated, class instances keep their prototype, and
 *     `Error.message`/`Error.stack` are scrubbed like any other string.
 *   - Scrubbing is idempotent: `scrub(scrub(x))` equals `scrub(x)`.
 */
/** The one mask used everywhere a secret would otherwise be shown. */
export declare const SECRET_MASK = "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";
/** Key names masked by default; a superset of `logging.redactKeys`' default. */
export declare const DEFAULT_REDACT_KEYS: readonly string[];
/** ICD §7.3 frozen interface. */
export interface Redactor {
    /** Deep-walks `value`, replacing by key name and by known secret; never mutates the input. */
    scrub<T>(value: T, extra?: Record<string, string>): T;
    /** Registers the actual bytes of a resolved secret for exact-match scrubbing. */
    track(secret: string | undefined): void;
    /** Forgets every tracked literal (called when a session ends or the plugin unloads). */
    forgetAll(): void;
}
export interface RedactorOptions {
    /** Key names whose value is replaced wholesale (case- and delimiter-insensitive). */
    redactKeys?: readonly string[];
    /** `false` turns the redactor into an identity function (`logging.redact: false`). */
    enabled?: boolean;
    /** Upper bound on tracked literals; the oldest are evicted first. */
    maxTracked?: number;
}
/** A redactor with the diagnostics the tests and the log line want to show. */
export interface MutableRedactor extends Redactor {
    /** Key-name patterns currently in force. */
    readonly patterns: readonly string[];
    /** How many literals are tracked (a count, never the literals themselves). */
    readonly trackedCount: number;
}
/** Case- and delimiter-insensitive form of a key name. */
export declare function normalizeKeyName(name: string): string;
/**
 * Split a key name into words on delimiters *and* camelCase transitions, so
 * `privateKey` and `private_key` both yield `['private', 'key']` while
 * `monkey` stays `['monkey']`.
 */
export declare function keyNameSegments(name: string): string[];
/**
 * Whether a key name denotes a secret.
 *
 * Three rules, in increasing breadth: exact normalized equality (so a configured
 * `privateKey` entry matches `private_key`), whole-word segment equality (so
 * `key` matches `privateKey` and `apiKey` but not `monkey`), and — only for
 * patterns of four characters or more — substring containment (so `password`
 * also matches `passwordHash`, and `token` matches `jsonWebToken`). Short
 * patterns deliberately stop at word boundaries: over-redacting a field named
 * `keys` would hide the profile list, while `monkey` is not a secret.
 */
export declare function matchesRedactKey(name: string, patterns: readonly string[]): boolean;
/**
 * Spellings a secret takes on the way into a log line. The raw value is always
 * tracked; the encodings are only worth tracking for secrets long enough that a
 * chance collision is implausible.
 */
export declare function spellingsOf(secret: string): string[];
/** Create a redactor; one instance per plugin, shared by the logger and the audit log. */
export declare function createRedactor(options?: RedactorOptions): MutableRedactor;
/** Convenience for code with no long-lived redactor (tests, one-shot diagnostics). */
export declare function scrubOnce<T>(value: T, options?: RedactorOptions & {
    track?: readonly string[];
}, extra?: Record<string, string>): T;
//# sourceMappingURL=redact.d.ts.map