/**
 * Connection profiles: the data model every other module speaks, plus the
 * durable store behind it.
 *
 * The security property this file exists to guarantee is narrow and testable:
 * **`profilesFile` never contains a secret value.** A profile carries *references*
 * (`secretRefs.password = 'DSH_SSH_PROD_PASSWORD'`), the value lives in
 * `ctx.credentials` or the environment (see `src/credentials.ts`), and the
 * outward projection carries neither — only `present`/`source`/a fixed mask.
 *
 * Three mechanisms enforce it, so that no single caller mistake can undo it:
 *
 *   1. `save()` builds the persisted record from an allowlist of fields; anything
 *      unknown (a stray `password: 'hunter2'` from a form post) is dropped.
 *   2. Reference names are validated against the credentials grammar
 *      `^[A-Za-z_][A-Za-z0-9_]*$`; a plaintext value is *rejected* rather than
 *      stored, and the error message deliberately does not quote it.
 *   3. `defaultEnv` keys are screened for secret-shaped names, because "just put
 *      it in the environment" is the most plausible way for a password to reach
 *      this file.
 *
 * `ConnProfile`/`ConnProfileInput`/`ConnProfileView`/`ProfileId` live here rather
 * than in `src/protocol.ts` (Lead-owned) because the wire contract only fixes
 * their *shape at the endpoint*; this module is where they are constructed, so it
 * is where the construction rules belong.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { SECRET_MASK, DEFAULT_REDACT_KEYS, matchesRedactKey, normalizeKeyName } from './redact.js';
import { SshError } from './protocol.js';
/** Build a `ResolvedSecrets` value; the only supported constructor. */
export function createResolvedSecrets(input) {
    return {
        ...(input.password === undefined ? {} : { password: input.password }),
        ...(input.passphrase === undefined ? {} : { passphrase: input.passphrase }),
        ...(input.privateKeyPath === undefined ? {} : { privateKeyPath: input.privateKeyPath }),
        source: { password: input.source.password, passphrase: input.source.passphrase },
        toJSON() {
            return {
                ...(this.password === undefined ? {} : { password: SECRET_MASK }),
                ...(this.passphrase === undefined ? {} : { passphrase: SECRET_MASK }),
                ...(this.privateKeyPath === undefined ? {} : { privateKeyPath: this.privateKeyPath }),
                source: { password: this.source.password, passphrase: this.source.passphrase },
            };
        },
    };
}
// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ID_PATTERN = /^p_[0-9A-Za-z_-]{4,64}$/;
let lastTime = 0;
let lastRandom = '';
/**
 * Monotonic ULID (48-bit time + 80-bit randomness, Crockford base32).
 *
 * Monotonic within a millisecond because ids are minted in bursts (duplicate a
 * profile, or reconnect the same host repeatedly); a plain random tail would make
 * sort order unstable, and a plain timestamp would collide.
 */
export function monotonicUlid(now = Date.now()) {
    const time = now > lastTime ? now : lastTime;
    if (time === lastTime && lastRandom !== '') {
        lastRandom = incrementRandom(lastRandom);
    }
    else {
        const bytes = randomBytes(16);
        let next = '';
        for (let index = 0; index < 16; index += 1)
            next += CROCKFORD[(bytes[index] ?? 0) % 32];
        lastRandom = next;
    }
    lastTime = time;
    return `${encodeTime(time)}${lastRandom}`;
}
function encodeTime(time) {
    let remaining = Math.max(0, Math.trunc(time));
    let out = '';
    for (let index = 0; index < 10; index += 1) {
        out = `${CROCKFORD[remaining % 32] ?? '0'}${out}`;
        remaining = Math.floor(remaining / 32);
    }
    return out;
}
function incrementRandom(value) {
    const chars = value.split('');
    for (let index = chars.length - 1; index >= 0; index -= 1) {
        const position = CROCKFORD.indexOf(chars[index] ?? '0');
        if (position < CROCKFORD.length - 1) {
            chars[index] = CROCKFORD[position + 1] ?? '0';
            return chars.join('');
        }
        chars[index] = '0';
    }
    // 2^80 ids in one millisecond is impossible in practice, but stay monotonic.
    return value;
}
/** A fresh profile id. */
export function newProfileId() {
    return `p_${monotonicUlid()}`;
}
// ---------------------------------------------------------------------------
// Reference grammar
// ---------------------------------------------------------------------------
/** The credentials seam's reference grammar: an environment-variable-shaped name. */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function isCredentialRef(value) {
    return typeof value === 'string' && REF_PATTERN.test(value);
}
/**
 * Reject a plaintext secret where a reference belongs.
 *
 * The message never quotes the offending value: a rejection is still a log line
 * and an error response, and quoting it would defeat the purpose of rejecting it.
 */
export function assertCredentialRef(value, field) {
    if (!isCredentialRef(value)) {
        throw new SshError('SSH_CFG_INVALID', `secretRefs.${field} must be a credential reference name (letters, digits and underscores, e.g. DSH_SSH_PROD_PASSWORD), not a secret value`);
    }
    return value;
}
// ---------------------------------------------------------------------------
// Construction and validation
// ---------------------------------------------------------------------------
const AUTH_KINDS = ['password', 'privateKey', 'agent'];
const HOST_KEY_POLICIES = ['strict', 'accept-new', 'insecure'];
const MAX_TAGS = 32;
function asRecord(value, field) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new SshError('SSH_CFG_INVALID', `${field} must be an object`);
    }
    return value;
}
function text(value, field, options = {}) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (raw === '')
        throw new SshError('SSH_CFG_INVALID', `${field} must be a non-empty string`);
    const max = options.max ?? 255;
    if (raw.length > max)
        throw new SshError('SSH_CFG_INVALID', `${field} must be at most ${max} characters`);
    return raw;
}
function positiveInt(value, field, fallback, min, max) {
    if (value === undefined || value === null)
        return fallback;
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric))
        throw new SshError('SSH_CFG_INVALID', `${field} must be a number`);
    return Math.min(max, Math.max(min, Math.trunc(numeric)));
}
function retriesOf(value, fallback) {
    if (value === undefined || value === null)
        return { ...fallback };
    const record = asRecord(value, 'retries');
    return {
        max: positiveInt(record['max'], 'retries.max', fallback.max, 0, 10),
        backoffBaseMs: positiveInt(record['backoffBaseMs'], 'retries.backoffBaseMs', fallback.backoffBaseMs, 0, 60000),
        backoffMaxMs: positiveInt(record['backoffMaxMs'], 'retries.backoffMaxMs', fallback.backoffMaxMs, 0, 600000),
        jitter: typeof record['jitter'] === 'boolean' ? record['jitter'] : fallback.jitter,
    };
}
/** A reasonable default user, mirroring what `ssh host` would do. */
export function defaultUser(env = process.env) {
    const candidate = env['USERNAME'] ?? env['USER'] ?? env['LOGNAME'];
    return typeof candidate === 'string' && candidate.trim() !== '' ? candidate.trim() : 'root';
}
/**
 * Build the persisted record from an allowlisted input.
 *
 * `existing` supplies merge semantics: a field the caller omitted keeps its stored
 * value, which is what makes "the UI edited the host and re-saved the view" safe.
 * `secretRefs` follows the same rule — an explicit reference wins, an omitted one
 * is preserved, so a save can never silently orphan a stored credential.
 */
export function normalizeProfile(input, options) {
    const { defaults, existing } = options;
    const at = options.now ?? new Date().toISOString();
    const record = asRecord(input, 'profile');
    const host = text(record['host'] ?? existing?.host, 'host', { max: 255 });
    if (/[\s/]/.test(host))
        throw new SshError('SSH_CFG_INVALID', 'host must not contain whitespace or "/"');
    const port = positiveInt(record['port'] ?? existing?.port, 'port', existing?.port ?? 22, 1, 65535);
    const user = text(record['user'] ?? existing?.user ?? defaultUser(options.env), 'user', { max: 64 });
    const name = text(record['name'] ?? existing?.name ?? `${user}@${host}`, 'name', { max: 128 });
    const secretRefs = normalizeSecretRefs(record['secretRefs'], existing?.secretRefs);
    const authRaw = record['auth'] ?? existing?.auth;
    const auth = authRaw === undefined
        ? secretRefs.privateKeyPath !== undefined
            ? 'privateKey'
            : 'password'
        : (() => {
            if (typeof authRaw !== 'string' || !AUTH_KINDS.includes(authRaw)) {
                throw new SshError('SSH_CFG_INVALID', `auth must be one of ${AUTH_KINDS.join(', ')}`);
            }
            return authRaw;
        })();
    const policyRaw = record['hostKeyPolicy'] ?? existing?.hostKeyPolicy ?? defaults.hostKeyPolicy;
    if (typeof policyRaw !== 'string' || !HOST_KEY_POLICIES.includes(policyRaw)) {
        throw new SshError('SSH_CFG_INVALID', `hostKeyPolicy must be one of ${HOST_KEY_POLICIES.join(', ')}`);
    }
    const redactKeys = options.redactKeys ?? DEFAULT_REDACT_KEYS;
    const defaultEnv = normalizeEnv(record['defaultEnv'], existing?.defaultEnv, redactKeys);
    const groupRaw = record['group'] ?? existing?.group;
    const group = typeof groupRaw === 'string' && groupRaw.trim() !== '' ? groupRaw.trim().slice(0, 64) : undefined;
    const tags = normalizeTags(record['tags'] ?? existing?.tags);
    const cwdRaw = record['defaultCwd'] ?? existing?.defaultCwd;
    const defaultCwd = typeof cwdRaw === 'string' && cwdRaw.trim() !== '' ? cwdRaw.trim().slice(0, 1024) : undefined;
    const idRaw = record['id'] ?? existing?.id;
    let id;
    if (idRaw === undefined || idRaw === null || idRaw === '')
        id = newProfileId();
    else if (typeof idRaw === 'string' && ID_PATTERN.test(idRaw))
        id = idRaw;
    else
        throw new SshError('SSH_CFG_INVALID', 'profile id must match p_<ulid>');
    return {
        id,
        name,
        host,
        port,
        user,
        auth,
        secretRefs,
        connectTimeoutMs: positiveInt(record['connectTimeoutMs'] ?? existing?.connectTimeoutMs, 'connectTimeoutMs', existing?.connectTimeoutMs ?? defaults.connectTimeoutMs, 1000, 600000),
        keepaliveIntervalMs: positiveInt(record['keepaliveIntervalMs'] ?? existing?.keepaliveIntervalMs, 'keepaliveIntervalMs', existing?.keepaliveIntervalMs ?? defaults.keepaliveIntervalMs, 1000, 600000),
        keepaliveCountMax: positiveInt(record['keepaliveCountMax'] ?? existing?.keepaliveCountMax, 'keepaliveCountMax', existing?.keepaliveCountMax ?? defaults.keepaliveCountMax, 1, 100),
        retries: retriesOf(record['retries'] ?? existing?.retries, existing?.retries ?? defaults.retries),
        hostKeyPolicy: policyRaw,
        ...(group === undefined ? {} : { group }),
        tags,
        ...(defaultCwd === undefined ? {} : { defaultCwd }),
        ...(defaultEnv === undefined ? {} : { defaultEnv }),
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
        ...(existing?.lastUsedAt === undefined ? {} : { lastUsedAt: existing.lastUsedAt }),
    };
}
/**
 * Merge a `secretRefs` patch over the stored references.
 *
 * Every defined field must be a valid reference; a plaintext-looking value is
 * rejected by {@link assertCredentialRef} (which is the whole point — this is the
 * one input a UI could plausibly fill with a real password).
 */
function normalizeSecretRefs(value, existing) {
    const out = {};
    const from = existing ?? {};
    const refs = value === undefined ? {} : asRecord(value, 'secretRefs');
    const pick = (field) => {
        const candidate = refs[field];
        if (candidate === undefined || (typeof candidate === 'string' && candidate.trim() === '')) {
            const kept = from[field];
            if (kept !== undefined)
                out[field] = kept;
            return;
        }
        if (typeof candidate !== 'string')
            throw new SshError('SSH_CFG_INVALID', `secretRefs.${field} must be a string reference name`);
        // A path may contain "/" and "." — it is a location, not a secret.
        out[field] = field === 'privateKeyPath' ? candidate.trim() : assertCredentialRef(candidate.trim(), field);
    };
    pick('password');
    pick('passphrase');
    pick('privateKeyPath');
    return out;
}
/**
 * Environment variables a profile pre-sets for every command.
 *
 * Secret-shaped keys are refused: `defaultEnv` lands in the profile file, so a
 * `{ PASSWORD: 'hunter2' }` entry is exactly the plaintext leak this module exists
 * to prevent. The check reuses the logger's key patterns, so tightening
 * `logging.redactKeys` also tightens this.
 */
function normalizeEnv(value, existing, redactKeys) {
    if (value === undefined)
        return existing === undefined ? undefined : { ...existing };
    const record = asRecord(value, 'defaultEnv');
    const out = {};
    for (const [key, item] of Object.entries(record)) {
        if (normalizeKeyName(key) === '')
            continue;
        if (matchesRedactKey(key, redactKeys)) {
            throw new SshError('SSH_CFG_INVALID', `defaultEnv.${key} looks like a secret; store it as a credential reference (secretRefs) instead — a profile file must never carry a secret value`);
        }
        if (typeof item !== 'string')
            throw new SshError('SSH_CFG_INVALID', `defaultEnv.${key} must be a string`);
        if (item.length > 4096)
            throw new SshError('SSH_CFG_INVALID', `defaultEnv.${key} is too long`);
        out[key] = item;
    }
    return Object.keys(out).length === 0 ? undefined : out;
}
function normalizeTags(value) {
    if (value === undefined || value === null)
        return [];
    if (!Array.isArray(value))
        throw new SshError('SSH_CFG_INVALID', 'tags must be an array of strings');
    const out = [];
    for (const item of value) {
        if (typeof item !== 'string')
            continue;
        const tag = item.trim().slice(0, 32);
        if (tag !== '' && !out.includes(tag) && out.length < MAX_TAGS)
            out.push(tag);
    }
    return out;
}
// ---------------------------------------------------------------------------
// Outward projection
// ---------------------------------------------------------------------------
/**
 * Project a profile for the wire.
 *
 * The `secrets` member is exactly ICD §4.2's shape, and `masked` is the fixed
 * 8-dot mask whenever a field is present — never a length-revealing string.
 */
export function toConnProfileView(profile, secrets) {
    const { secretRefs, ...rest } = profile;
    return { ...rest, secrets, secretRefs: { ...secretRefs } };
}
/** Build the `secrets` member from an already-resolved pair of fields. */
export function secretsViewOf(resolved) {
    const field = (input) => ({
        present: input?.present === true,
        source: input?.source ?? 'none',
        masked: input?.present === true ? SECRET_MASK : '',
    });
    return {
        password: field(resolved.password),
        passphrase: field(resolved.passphrase),
        ...(resolved.privateKeyPath === undefined ? {} : { privateKeyPath: resolved.privateKeyPath }),
    };
}
/** Deep copy of a profile, so a caller cannot mutate the store's state. */
export function cloneProfile(profile) {
    return {
        ...profile,
        secretRefs: { ...profile.secretRefs },
        retries: { ...profile.retries },
        tags: [...profile.tags],
        ...(profile.defaultEnv === undefined ? {} : { defaultEnv: { ...profile.defaultEnv } }),
    };
}
export class ProfileStoreImpl {
    file;
    defaults;
    onLoadError;
    onWriteError;
    redactKeys;
    profiles = new Map();
    loaded = false;
    loadFailure;
    corruptBackupDone = false;
    constructor(options) {
        this.file = options.file;
        this.defaults = options.defaults;
        this.onLoadError = options.onLoadError;
        this.onWriteError = options.onWriteError;
        this.redactKeys = options.redactKeys ?? DEFAULT_REDACT_KEYS;
    }
    get loadError() {
        return this.loadFailure;
    }
    list() {
        this.ensureLoaded();
        return [...this.profiles.values()].map(cloneProfile);
    }
    get(id) {
        this.ensureLoaded();
        const found = this.profiles.get(id);
        return found === undefined ? undefined : cloneProfile(found);
    }
    async save(input) {
        this.ensureLoaded();
        const existing = typeof input.id === 'string' ? this.profiles.get(input.id) : undefined;
        const profile = normalizeProfile(input, {
            defaults: this.defaults,
            redactKeys: this.redactKeys,
            ...(existing === undefined ? {} : { existing }),
        });
        this.profiles.set(profile.id, profile);
        this.persist();
        return cloneProfile(profile);
    }
    async remove(id) {
        this.ensureLoaded();
        const removed = this.profiles.delete(id);
        if (removed)
            this.persist();
        return removed;
    }
    async duplicate(id, name) {
        this.ensureLoaded();
        const source = this.profiles.get(id);
        if (source === undefined)
            throw new SshError('SSH_CFG_INVALID', `profile ${id} does not exist`);
        const at = new Date().toISOString();
        const copy = {
            ...cloneProfile(source),
            id: newProfileId(),
            name: name !== undefined && name.trim() !== '' ? name.trim().slice(0, 128) : `${source.name} copy`,
            createdAt: at,
            updatedAt: at,
        };
        delete copy.lastUsedAt;
        this.profiles.set(copy.id, copy);
        this.persist();
        return cloneProfile(copy);
    }
    async touch(id) {
        this.ensureLoaded();
        const found = this.profiles.get(id);
        if (found === undefined)
            return undefined;
        const updated = { ...cloneProfile(found), lastUsedAt: new Date().toISOString() };
        this.profiles.set(id, updated);
        this.persist();
        return cloneProfile(updated);
    }
    async setSecretRef(id, field, ref) {
        this.ensureLoaded();
        const found = this.profiles.get(id);
        if (found === undefined)
            return undefined;
        assertCredentialRef(ref, field);
        const updated = {
            ...cloneProfile(found),
            secretRefs: { ...found.secretRefs, [field]: ref },
            updatedAt: new Date().toISOString(),
        };
        this.profiles.set(id, updated);
        this.persist();
        return cloneProfile(updated);
    }
    /** Force a re-read from disk (used by tests and by an external-edit watcher). */
    reload() {
        this.loaded = false;
        this.loadFailure = undefined;
        this.profiles = new Map();
        this.ensureLoaded();
    }
    ensureLoaded() {
        if (this.loaded)
            return;
        this.loaded = true;
        let raw;
        try {
            raw = readFileSync(this.file, 'utf8');
        }
        catch (error) {
            const code = error.code;
            if (code !== 'ENOENT')
                this.fail(`cannot read ${this.file}: ${String(code)}`);
            return;
        }
        try {
            const parsed = JSON.parse(raw);
            const list = Array.isArray(parsed.profiles) ? parsed.profiles : [];
            for (const entry of list) {
                if (entry === null || typeof entry !== 'object')
                    continue;
                const storedId = entry.id;
                // A record without a stable id cannot be addressed again; skipping it is
                // better than minting a new identity on every load.
                if (typeof storedId !== 'string' || !ID_PATTERN.test(storedId))
                    continue;
                try {
                    const profile = normalizeProfile(entry, { defaults: this.defaults, redactKeys: this.redactKeys });
                    // A stored record keeps its own timestamps; normalization resets them.
                    const stored = entry;
                    const restored = {
                        ...profile,
                        createdAt: typeof stored.createdAt === 'string' ? stored.createdAt : profile.createdAt,
                        updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : profile.updatedAt,
                        ...(typeof stored.lastUsedAt === 'string' ? { lastUsedAt: stored.lastUsedAt } : {}),
                    };
                    this.profiles.set(restored.id, restored);
                }
                catch {
                    // A record carrying a plaintext where a reference belongs is refused
                    // rather than loaded and re-persisted: fail closed, keep the rest.
                }
            }
        }
        catch (error) {
            this.fail(`cannot parse ${this.file}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    fail(reason) {
        this.loadFailure = reason;
        this.onLoadError?.(reason);
    }
    persist() {
        const payload = {
            version: 1,
            updatedAt: new Date().toISOString(),
            profiles: [...this.profiles.values()].map((profile) => this.serialize(profile)),
        };
        const text = `${JSON.stringify(payload, null, 2)}\n`;
        const tmp = `${this.file}.tmp-${process.pid}`;
        try {
            mkdirSync(dirname(this.file), { recursive: true });
            if (this.loadFailure !== undefined && !this.corruptBackupDone) {
                // Never overwrite a file we could not read: keep it for forensics.
                this.corruptBackupDone = true;
                try {
                    renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
                }
                catch {
                    /* the original may be unreadable *and* unmovable; proceed to write */
                }
            }
            // 0o600: a profile file holds hostnames, usernames and reference names.
            writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
            renameSync(tmp, this.file);
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            this.onWriteError?.(`cannot write ${this.file}: ${reason}`);
            try {
                rmSync(tmp, { force: true });
            }
            catch {
                /* best effort */
            }
        }
    }
    /** The allowlist that makes "a plaintext can never be persisted" mechanical. */
    serialize(profile) {
        const out = {
            id: profile.id,
            name: profile.name,
            host: profile.host,
            port: profile.port,
            user: profile.user,
            auth: profile.auth,
            secretRefs: { ...profile.secretRefs },
            connectTimeoutMs: profile.connectTimeoutMs,
            keepaliveIntervalMs: profile.keepaliveIntervalMs,
            keepaliveCountMax: profile.keepaliveCountMax,
            retries: { ...profile.retries },
            hostKeyPolicy: profile.hostKeyPolicy,
            tags: [...profile.tags],
            createdAt: profile.createdAt,
            updatedAt: profile.updatedAt,
        };
        if (profile.group !== undefined)
            out['group'] = profile.group;
        if (profile.defaultCwd !== undefined)
            out['defaultCwd'] = profile.defaultCwd;
        if (profile.defaultEnv !== undefined)
            out['defaultEnv'] = { ...profile.defaultEnv };
        if (profile.lastUsedAt !== undefined)
            out['lastUsedAt'] = profile.lastUsedAt;
        return out;
    }
}
/** Create the connection-profile store (one per plugin activation). */
export function createProfileStore(options) {
    return new ProfileStoreImpl(options);
}
/** Modification time of the profile file, or 0 when it does not exist. */
export function profileFileMtime(file) {
    try {
        return statSync(file).mtimeMs;
    }
    catch {
        return 0;
    }
}
//# sourceMappingURL=store.js.map