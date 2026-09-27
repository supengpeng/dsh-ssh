/**
 * Credential resolution: the only code path that turns a profile's *references*
 * into plaintext, and therefore the only place that may hold a secret in memory.
 *
 * Resolution order is frozen by ICD §6 (highest first):
 *
 *   1. `DSH_SSH_<PROFILE_SLUG>_PASSWORD` / `_PASSPHRASE` in the environment —
 *      read-only, never echoed, reported as `source: 'env'`.
 *   2. `ctx.credentials` behind the profile's `secretRefs` reference — the
 *      durable store (`~/.dsh/.credentials.yaml` for the shipped provider),
 *      reported as `source: 'keychain'`.
 *   3. session memory written by `set(..., persist: false)`.
 *   4. the one-shot `secrets` passed to `connect` — valid for that connection
 *      only and never written anywhere.
 *
 * Two rules make the security story hold:
 *
 *   - **Nothing resolved here is ever persisted.** `set(persist: true)` writes
 *     through `ctx.credentials` (which stores the value in its own file) and
 *     stores only the *reference name* in the profile; a plaintext never reaches
 *     `profilesFile`.
 *   - **Every resolved secret is registered with the redactor** before it is
 *     returned. A caller cannot forget to do it, so a later log line containing
 *     the password is masked even if the caller never thought about redaction.
 *
 * `ctx.credentials` is consumed structurally ({@link CredentialStoreFace}) rather
 * than by importing `@deepseek-ai/dsh-credentials`: the host tree provides its own
 * copy of that package, and a plugin must still load (and still work in
 * env-only deployments) when the credentials service is absent.
 */
import { SshError } from './protocol.js';
import { assertCredentialRef, createResolvedSecrets, isCredentialRef, secretsViewOf, } from './store.js';
// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------
/**
 * `PROFILE_SLUG` for `DSH_SSH_<SLUG>_PASSWORD`: the profile name, upper-cased with
 * every non-alphanumeric run collapsed to `_`.
 *
 * A name-based slug is predictable, which is the point — a user must be able to
 * guess the variable to export. Two profiles that share a name therefore share
 * the override; a profile that needs its own reference sets `secretRefs`
 * explicitly (or is addressed by its id, see {@link idSlug}).
 */
export function profileSlug(source) {
    const basis = firstNonEmpty(source.name, source.host, source.id) ?? 'default';
    const slug = basis
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 48);
    return slug === '' ? 'DEFAULT' : slug;
}
/** Fallback slug for a profile that could not be loaded: its id, minus the prefix noise. */
export function idSlug(profileId) {
    return profileSlug({ id: profileId.replace(/^p_/, 'profile_') });
}
function firstNonEmpty(...candidates) {
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim() !== '')
            return candidate.trim();
    }
    return undefined;
}
/** `DSH_SSH_PROD_PASSWORD` for `{ name: 'prod' }` and the configured prefix. */
export function envNameFor(profile, field, envPrefix) {
    return `${envPrefix}${profileSlug(profile)}_${field.toUpperCase()}`;
}
export class SshCredentialResolverImpl {
    secrets;
    credentials;
    profiles;
    redactor;
    logger;
    env;
    /** Session-memory secrets: `set(persist: false)`, keyed by profile id or inline slug. */
    memory = new Map();
    constructor(options) {
        this.secrets = options.secrets;
        this.credentials = options.credentials;
        this.profiles = options.profiles;
        this.redactor = options.redactor;
        this.logger = options.logger;
        this.env = options.env ?? process.env;
    }
    envNameFor(profile, field) {
        return envNameFor(profile, field, this.secrets.envPrefix);
    }
    /**
     * The reference that backs `field`.
     *
     * A profile's explicit `secretRefs` entry wins: it is what `set(persist: true)`
     * wrote, and it is stable even when the profile is renamed. Otherwise the
     * environment-variable-shaped name is used, which is what makes
     * `DSH_SSH_PROD_PASSWORD=… dsh` work with no configuration at all.
     */
    refFor(profile, field) {
        const explicit = profile.secretRefs?.[field];
        if (typeof explicit === 'string' && isCredentialRef(explicit))
            return explicit;
        return this.envNameFor(profile, field);
    }
    async resolve(profile, oneShot) {
        const password = await this.probe(profile, 'password', oneShot?.password);
        const passphrase = await this.probe(profile, 'passphrase', oneShot?.passphrase);
        const privateKeyPath = typeof profile.secretRefs?.privateKeyPath === 'string' && profile.secretRefs.privateKeyPath.trim() !== '' ? profile.secretRefs.privateKeyPath.trim() : undefined;
        this.track(password.value);
        this.track(passphrase.value);
        return createResolvedSecrets({
            ...(password.value === undefined ? {} : { password: password.value }),
            ...(passphrase.value === undefined ? {} : { passphrase: passphrase.value }),
            ...(privateKeyPath === undefined ? {} : { privateKeyPath }),
            source: { password: password.source, passphrase: passphrase.source },
        });
    }
    /**
     * Resolve a stored profile into the flat `{ ...profile, secrets }` triple SP1
     * consumes (matching `src/connection/types.ts`'s `ResolvedProfile`).
     *
     * The profile must already be normalised (`ProfileStore.save()` or `.get()`);
     * an inline request body should go through `ProfileStore.save()` first, which is
     * what mints the id and fills the server-owned fields.
     */
    async resolveProfile(profile, oneShot) {
        const secrets = await this.resolve(profile, oneShot);
        return { ...profile, secrets };
    }
    async describe(profile) {
        const password = await this.probe(profile, 'password', undefined);
        const passphrase = await this.probe(profile, 'passphrase', undefined);
        // Resolving to answer "is it set?" means the values pass through memory here
        // too; register them so a diagnostic that quotes the probe result is masked.
        this.track(password.value);
        this.track(passphrase.value);
        const privateKeyPath = typeof profile.secretRefs?.privateKeyPath === 'string' && profile.secretRefs.privateKeyPath.trim() !== '' ? profile.secretRefs.privateKeyPath.trim() : undefined;
        return secretsViewOf({
            password: { present: password.value !== undefined, source: password.source },
            passphrase: { present: passphrase.value !== undefined, source: passphrase.source },
            ...(privateKeyPath === undefined ? {} : { privateKeyPath }),
        });
    }
    async set(profileId, field, value, persist) {
        if (typeof value !== 'string' || value === '') {
            throw new SshError('SSH_CFG_INVALID', 'a secret value must be a non-empty string (clear it instead of storing an empty value)');
        }
        const profile = this.profiles?.get(profileId);
        const ref = profile !== undefined ? this.refFor(profile, field) : `${this.secrets.envPrefix}${idSlug(profileId)}_${field.toUpperCase()}`;
        assertCredentialRef(ref, field);
        const key = this.memoryKey(profileId, profileSlug(profile ?? { id: profileId }), field);
        if (!persist) {
            this.memory.set(key, value);
            return { ref, persisted: false, reason: 'session-memory only (persist: false)' };
        }
        if (this.secrets.provider === 'env') {
            throw new SshError('SSH_CFG_INVALID', 'secrets.provider is "env": this deployment reads credentials from the environment only, so a value cannot be stored here');
        }
        if (this.credentials?.set === undefined) {
            this.memory.set(key, value);
            this.warn('credentials service unavailable; keeping the secret in session memory only', { ref, field });
            return { ref, persisted: false, reason: 'no credentials service in this composition' };
        }
        try {
            await this.credentials.set(ref, value);
        }
        catch (error) {
            // The documented failure is a reference the launching environment already
            // supplies: that value is read-only for this run. Keeping the new value in
            // session memory still honours the user's click, and `persisted: false`
            // tells the UI to say so instead of silently pretending it was stored.
            const reason = error instanceof Error ? error.message : String(error);
            this.memory.set(key, value);
            this.warn('credential store refused the write; using session memory for this run', { ref, field, reason });
            return { ref, persisted: false, reason };
        }
        if (profile !== undefined && this.profiles !== undefined) {
            try {
                await this.profiles.setSecretRef(profileId, field, ref);
            }
            catch (error) {
                this.warn('could not record the credential reference on the profile', { ref, field, reason: error instanceof Error ? error.message : String(error) });
            }
        }
        this.memory.delete(key);
        return { ref, persisted: true };
    }
    async clear(profileId, field) {
        const profile = this.profiles?.get(profileId);
        const slug = profileSlug(profile ?? { id: profileId });
        const ref = profile !== undefined ? this.refFor(profile, field) : `${this.secrets.envPrefix}${idSlug(profileId)}_${field.toUpperCase()}`;
        this.memory.delete(this.memoryKey(profileId, slug, field));
        if (this.credentials?.unset === undefined)
            return;
        try {
            await this.credentials.unset(ref);
        }
        catch (error) {
            // An environment-shadowed reference cannot be removed from inside the
            // process; that is not an error the user needs to see as a failure.
            this.warn('credential store refused the removal', { ref, field, reason: error instanceof Error ? error.message : String(error) });
        }
    }
    forgetAll() {
        this.memory.clear();
        this.redactor?.forgetAll();
    }
    // ── internals ────────────────────────────────────────────────────────────
    memoryKey(profileId, slug, field) {
        return `${profileId ?? `inline:${slug}`}:${field}`;
    }
    /** The four-layer probe; the only place a plaintext enters the process. */
    async probe(profile, field, oneShot) {
        const ref = this.refFor(profile, field);
        const envName = this.envNameFor(profile, field);
        // 1. environment: the slug-derived name wins, then the ref name itself when it
        //    is a different (explicitly configured) variable.
        const fromEnvironment = this.readEnv(envName) ?? (ref !== envName ? this.readEnv(ref) : undefined);
        if (fromEnvironment !== undefined)
            return { value: fromEnvironment, source: 'env', ref };
        // 2. the credentials store behind the reference.
        if (this.secrets.provider === 'credentials' && this.credentials !== undefined) {
            const stored = await this.readStore(ref);
            if (stored !== undefined)
                return { value: stored, source: 'keychain', ref };
        }
        // 3. session memory, then 4. the one-shot value for this connection.
        const remembered = this.memory.get(this.memoryKey(profile.id, profileSlug(profile), field));
        if (remembered !== undefined)
            return { value: remembered, source: 'profile', ref };
        if (typeof oneShot === 'string' && oneShot !== '')
            return { value: oneShot, source: 'profile', ref };
        return { value: undefined, source: 'none', ref };
    }
    readEnv(name) {
        const value = this.env[name];
        return typeof value === 'string' && value !== '' ? value : undefined;
    }
    async readStore(ref) {
        const store = this.credentials;
        if (store === undefined)
            return undefined;
        try {
            const hit = await store.resolve(ref);
            if (hit === null || hit === undefined)
                return undefined;
            const value = hit.value;
            if (typeof value !== 'string' || value === '')
                return undefined;
            return value;
        }
        catch (error) {
            // A credentials outage must degrade to "not configured" (the caller then
            // reports SSH_AUTH_PASSPHRASE_REQUIRED / SSH_AUTH_FAILED) rather than
            // abort the connection with an unrelated error.
            this.warn('credential store lookup failed', { ref, reason: error instanceof Error ? error.message : String(error) });
            return undefined;
        }
    }
    track(value) {
        if (value !== undefined && this.redactor !== undefined)
            this.redactor.track(value);
    }
    warn(message, fields) {
        this.logger?.warn(message, fields);
    }
}
/** Create the credential resolver (one per plugin activation). */
export function createCredentialResolver(options) {
    return new SshCredentialResolverImpl(options);
}
//# sourceMappingURL=credentials.js.map