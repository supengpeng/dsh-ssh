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
export const SECRET_MASK = '••••••••';
/** Key names masked by default; a superset of `logging.redactKeys`' default. */
export const DEFAULT_REDACT_KEYS = [
    'password',
    'passwd',
    'passphrase',
    'privateKey',
    'secret',
    'token',
    'key',
    'authorization',
    'proxy-authorization',
    'credential',
    'apiKey',
    'accessKey',
    'cookie',
];
// ---------------------------------------------------------------------------
// Key-name matching
// ---------------------------------------------------------------------------
/** Case- and delimiter-insensitive form of a key name. */
export function normalizeKeyName(name) {
    return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}
/**
 * Split a key name into words on delimiters *and* camelCase transitions, so
 * `privateKey` and `private_key` both yield `['private', 'key']` while
 * `monkey` stays `['monkey']`.
 */
export function keyNameSegments(name) {
    return name
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[^A-Za-z0-9]+/)
        .map((part) => part.toLowerCase())
        .filter((part) => part !== '');
}
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
export function matchesRedactKey(name, patterns) {
    const normalized = normalizeKeyName(name);
    if (normalized === '')
        return false;
    const segments = keyNameSegments(name);
    for (const pattern of patterns) {
        const candidate = normalizeKeyName(pattern);
        if (candidate === '')
            continue;
        if (normalized === candidate)
            return true;
        if (segments.includes(candidate))
            return true;
        if (candidate.length >= 4 && normalized.includes(candidate))
            return true;
    }
    return false;
}
const MIN_DERIVED_LENGTH = 6;
/**
 * Spellings a secret takes on the way into a log line. The raw value is always
 * tracked; the encodings are only worth tracking for secrets long enough that a
 * chance collision is implausible.
 */
export function spellingsOf(secret) {
    const out = [secret];
    if (secret.length < MIN_DERIVED_LENGTH)
        return out;
    const add = (value) => {
        if (value !== '' && !out.includes(value))
            out.push(value);
    };
    try {
        add(encodeURIComponent(secret));
    }
    catch {
        /* lone surrogates cannot be encoded; the raw spelling still matches */
    }
    try {
        const json = JSON.stringify(secret);
        if (json.startsWith('"') && json.endsWith('"'))
            add(json.slice(1, -1));
    }
    catch {
        /* not JSON-serialisable: nothing to add */
    }
    const utf8 = Buffer.from(secret, 'utf8');
    add(utf8.toString('base64'));
    add(utf8.toString('base64').replace(/=+$/, ''));
    add(utf8.toString('base64url'));
    add(utf8.toString('hex'));
    return out;
}
// ---------------------------------------------------------------------------
// Adversarial shapes (layer 3)
// ---------------------------------------------------------------------------
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#@:]*:)([^\s/?#@]+)@/gi;
const AUTHORIZATION = /(\b(?:authorization|proxy-authorization)\b["']?\s*[:=]\s*["']?)(?:bearer|basic|token|digest)?\s*([^\s,;"']+)/gi;
const NAMED_SECRET = new RegExp(String.raw `((?:["']?\b(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|credential)\b["']?\s*[=:]\s*))` +
    String.raw `(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s,;&"']+))`, 'gi');
const SECRET_FLAG = /(\s(?:-p|-P|--password|--passphrase|--secret|--token)\s+)(?:"([^"]*)"|'([^']*)'|(\S+))/gi;
const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const BASE64_RUN = /[A-Za-z0-9+/_-]{16,}={0,2}/g;
const HEX_RUN = /[0-9a-fA-F]{16,}/g;
/** Layer 3a: patterns that catch secrets the caller never registered. */
function scrubAdversarial(text) {
    let out = text;
    if (out.includes('-----BEGIN'))
        out = out.replace(PEM_BLOCK, SECRET_MASK);
    out = out.replace(URL_USERINFO, `$1${SECRET_MASK}@`);
    out = out.replace(AUTHORIZATION, `$1${SECRET_MASK}`);
    out = out.replace(NAMED_SECRET, (_match, prefix, doubleQuoted, singleQuoted) => {
        if (doubleQuoted !== undefined)
            return `${prefix}"${SECRET_MASK}"`;
        if (singleQuoted !== undefined)
            return `${prefix}'${SECRET_MASK}'`;
        return `${prefix}${SECRET_MASK}`;
    });
    out = out.replace(SECRET_FLAG, (_match, prefix, doubleQuoted, singleQuoted) => {
        if (doubleQuoted !== undefined)
            return `${prefix}"${SECRET_MASK}"`;
        if (singleQuoted !== undefined)
            return `${prefix}'${SECRET_MASK}'`;
        return `${prefix}${SECRET_MASK}`;
    });
    return out;
}
/**
 * Layer 3b: mask base64/hex runs whose decoded bytes contain a tracked secret.
 *
 * This is the case that defeats naive literal matching: base64 of `hunter2` is
 * `aHVudGVyMg==`, which contains neither `hunter2` nor any prefix of it, so only
 * decoding reveals what is inside. Decoding every candidate run is cheap, and a
 * run is replaced *only* when the decode really contains a tracked literal, so
 * unrelated text is never touched.
 */
function scrubEncodedRuns(text, secrets) {
    if (secrets.length === 0)
        return text;
    const contains = (decoded) => secrets.some((secret) => decoded.includes(secret));
    const decode = (run, encoding) => {
        try {
            const decoded = Buffer.from(run, encoding).toString('utf8');
            return decoded.length === 0 ? undefined : decoded;
        }
        catch {
            return undefined;
        }
    };
    let out = text.replace(BASE64_RUN, (run) => {
        const decoded = decode(run, 'base64');
        return decoded !== undefined && contains(decoded) ? SECRET_MASK : run;
    });
    out = out.replace(HEX_RUN, (run) => {
        const decoded = decode(run, 'hex');
        return decoded !== undefined && contains(decoded) ? SECRET_MASK : run;
    });
    return out;
}
function scrubText(text, state) {
    let out = text;
    for (const literal of state.literals) {
        if (out.includes(literal))
            out = out.split(literal).join(SECRET_MASK);
    }
    out = scrubAdversarial(out);
    if (state.secrets.length > 0)
        out = scrubEncodedRuns(out, state.secrets);
    return out;
}
// ---------------------------------------------------------------------------
// Deep walk
// ---------------------------------------------------------------------------
const PASSTHROUGH_TYPES = new Set(['number', 'boolean', 'bigint', 'undefined']);
function scrubError(error, state, seen, pattern) {
    const clone = Object.create(Object.getPrototypeOf(error));
    seen.set(error, clone);
    clone['name'] = scrubText(error.name, state);
    clone['message'] = scrubText(error.message, state);
    if (typeof error.stack === 'string')
        clone['stack'] = scrubText(error.stack, state);
    for (const [key, value] of Object.entries(error)) {
        clone[key] = scrubValue(value, state, seen, pattern);
    }
    if (error.cause !== undefined)
        clone['cause'] = scrubValue(error.cause, state, seen, pattern);
    return clone;
}
function scrubByteView(view, state) {
    if (view instanceof DataView)
        return view;
    const bytes = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
    const text = bytes.toString('utf8');
    const scrubbed = scrubText(text, state);
    if (scrubbed === text)
        return view;
    const replacement = Buffer.from(scrubbed, 'utf8');
    const Ctor = view.constructor;
    return new Ctor(replacement);
}
/**
 * Layer 3c: mask a secret split across adjacent sibling fields
 * (`{ first: 'hun', second: 'ter2' }`). Neither field alone contains the secret,
 * so layers 1 and 2 both miss it; joining adjacent primitive siblings is the
 * shape that occurs when a form or a CLI parser slices a value. Both halves are
 * masked — fail closed, because the pair is secret-bearing as a whole.
 */
function scrubSplitFields(clone, state, pattern) {
    if (state.secrets.length === 0)
        return;
    const keys = Object.keys(clone);
    for (let index = 0; index < keys.length - 1; index += 1) {
        const leftKey = keys[index];
        const rightKey = keys[index + 1];
        if (leftKey === undefined || rightKey === undefined)
            continue;
        if (matchesRedactKey(leftKey, pattern) || matchesRedactKey(rightKey, pattern))
            continue;
        const left = clone[leftKey];
        const right = clone[rightKey];
        if (typeof left !== 'string' || typeof right !== 'string' || left === '' || right === '')
            continue;
        const joined = `${left}${right}`;
        for (const secret of state.secrets) {
            if (secret.length >= MIN_DERIVED_LENGTH && joined.includes(secret)) {
                clone[leftKey] = SECRET_MASK;
                clone[rightKey] = SECRET_MASK;
                break;
            }
        }
    }
}
function scrubValue(value, state, seen, pattern) {
    if (value === null)
        return null;
    const type = typeof value;
    if (type === 'string')
        return scrubText(value, state);
    if (PASSTHROUGH_TYPES.has(type) || type === 'function' || type === 'symbol')
        return value;
    const object = value;
    const known = seen.get(object);
    if (known !== undefined)
        return known;
    if (Buffer.isBuffer(object)) {
        const text = object.toString('utf8');
        const scrubbed = scrubText(text, state);
        return Buffer.from(scrubbed === text ? text : scrubbed, 'utf8');
    }
    if (ArrayBuffer.isView(object))
        return scrubByteView(object, state);
    if (object instanceof Date)
        return new Date(object.getTime());
    if (Array.isArray(object)) {
        const clone = [];
        seen.set(object, clone);
        for (const item of object)
            clone.push(scrubValue(item, state, seen, pattern));
        return clone;
    }
    if (object instanceof Map) {
        const clone = new Map();
        seen.set(object, clone);
        for (const [key, item] of object)
            clone.set(scrubValue(key, state, seen, pattern), scrubValue(item, state, seen, pattern));
        return clone;
    }
    if (object instanceof Set) {
        const clone = new Set();
        seen.set(object, clone);
        for (const item of object)
            clone.add(scrubValue(item, state, seen, pattern));
        return clone;
    }
    if (object instanceof Error)
        return scrubError(object, state, seen, pattern);
    // Ordinary object or class instance: keep the prototype, rebuild every own
    // enumerable property. Nothing is copied by reference that could carry a
    // secret, so the caller can serialise the result safely.
    const clone = Object.create(Object.getPrototypeOf(object));
    seen.set(object, clone);
    for (const [key, item] of Object.entries(object)) {
        if (item === null || item === undefined) {
            clone[key] = item;
            continue;
        }
        if (matchesRedactKey(key, pattern)) {
            clone[key] = item === '' ? '' : SECRET_MASK;
            continue;
        }
        clone[key] = scrubValue(item, state, seen, pattern);
    }
    scrubSplitFields(clone, state, pattern);
    return clone;
}
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
/** Create a redactor; one instance per plugin, shared by the logger and the audit log. */
export function createRedactor(options = {}) {
    const patterns = [...(options.redactKeys ?? DEFAULT_REDACT_KEYS)].filter((key) => normalizeKeyName(key) !== '');
    const enabled = options.enabled !== false;
    const maxTracked = Math.max(1, Math.trunc(options.maxTracked ?? 64));
    const state = { literals: [], secrets: [] };
    const register = (secret) => {
        if (secret === '' || secret === SECRET_MASK)
            return;
        if (state.secrets.includes(secret))
            return;
        while (state.secrets.length >= maxTracked) {
            const oldest = state.secrets.shift();
            if (oldest === undefined)
                break;
            for (const spelling of spellingsOf(oldest)) {
                const index = state.literals.indexOf(spelling);
                if (index !== -1)
                    state.literals.splice(index, 1);
            }
        }
        state.secrets.push(secret);
        state.literals.push(...spellingsOf(secret));
        state.literals.sort((left, right) => right.length - left.length);
    };
    return {
        patterns,
        get trackedCount() {
            return state.secrets.length;
        },
        track(secret) {
            if (!enabled || typeof secret !== 'string')
                return;
            register(secret);
        },
        forgetAll() {
            state.secrets.length = 0;
            state.literals.length = 0;
        },
        scrub(value, extra) {
            if (!enabled)
                return value;
            const extraKeys = extra === undefined ? [] : Object.keys(extra);
            const extraValues = extra === undefined ? [] : Object.values(extra).filter((item) => typeof item === 'string' && item !== '');
            let local = state;
            if (extraValues.length > 0) {
                local = { literals: [...state.literals], secrets: [...state.secrets] };
                for (const secret of extraValues) {
                    if (secret === '' || local.secrets.includes(secret))
                        continue;
                    local.secrets.push(secret);
                    local.literals.push(...spellingsOf(secret));
                }
                local.literals.sort((left, right) => right.length - left.length);
            }
            const localPatterns = extraKeys.length === 0 ? patterns : [...patterns, ...extraKeys];
            return scrubValue(value, local, new WeakMap(), localPatterns);
        },
    };
}
/** Convenience for code with no long-lived redactor (tests, one-shot diagnostics). */
export function scrubOnce(value, options = {}, extra) {
    const redactor = createRedactor(options);
    for (const secret of options.track ?? [])
        redactor.track(secret);
    return redactor.scrub(value, extra);
}
//# sourceMappingURL=redact.js.map