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
import type { Redactor } from './redact.js';
import { type ConnProfile, type ConnProfileInput, type ConnProfileView, type ProfileId, type ResolvedProfile, type ResolvedSecrets } from './store.js';
/** The subset of `ctx.credentials` this plugin consumes, declared structurally. */
export interface CredentialStoreFace {
    /** Resolve a reference to its current value; `undefined` means "not set". */
    resolve(ref: string): Promise<{
        value?: unknown;
        source?: unknown;
    } | undefined | null>;
    /** Presence/provenance without the value (used by diagnostics). */
    describe?(ref: string): Promise<{
        configured?: boolean;
        source?: unknown;
        writable?: boolean;
    } | undefined | null>;
    /** Store a value for a reference; rejects when an environment source shadows it. */
    set?(ref: string, value: string): Promise<void>;
    /** Remove a stored value; a no-op when absent. */
    unset?(ref: string): Promise<void>;
}
export type SecretField = 'password' | 'passphrase';
/** ICD §7.3 frozen interface. */
export interface CredentialResolver {
    /** Resolve the effective secrets for a profile (env > credentials > one-shot). */
    resolve(profile: ConnProfileInput, oneShot?: {
        password?: string;
        passphrase?: string;
    }): Promise<ResolvedSecrets>;
    /** Persist a secret through `ctx.credentials`, or keep it in memory when `persist` is false. */
    set(profileId: ProfileId, field: SecretField, value: string, persist: boolean): Promise<{
        ref: string;
    }>;
    clear(profileId: ProfileId, field: SecretField): Promise<void>;
    /** Masked projection for the UI (ICD §4.2); never contains a value. */
    describe(profile: ConnProfileInput): Promise<ConnProfileViewSecrets>;
}
/** Exactly `ConnProfileView['secrets']` — the frozen projection the UI consumes. */
export type ConnProfileViewSecrets = ConnProfileView['secrets'];
export interface SetSecretResult {
    ref: string;
    /** False when the value could only be kept in memory (no store, or the ref is read-only). */
    persisted: boolean;
    /** Why persistence was skipped, when it was; safe to show (never a value). */
    reason?: string;
}
/** The resolver plus the helpers the connection layer needs. */
export interface SshCredentialResolver extends CredentialResolver {
    /** Resolve a stored profile into the `(profile, secrets, policy)` triple SP1 consumes. */
    resolveProfile(profile: ConnProfileInput, oneShot?: {
        password?: string;
        passphrase?: string;
    }): Promise<ResolvedProfile>;
    /** The environment-variable name that overrides `field` for this profile. */
    envNameFor(profile: ConnProfileInput, field: SecretField): string;
    /** The credential reference backing `field` (explicit `secretRefs` entry, else the env name). */
    refFor(profile: ConnProfileInput, field: SecretField): string;
    /**
     * ICD §7.3 declares `{ ref }`; the concrete answer is the documented superset
     * (`persisted:false` + `reason` means "this value is good for the current
     * process only"). Narrowing the return here lets a caller that can act on that
     * fact see it in the type instead of casting — the frozen signature is untouched.
     */
    set(profileId: ProfileId, field: SecretField, value: string, persist: boolean): Promise<SetSecretResult>;
    /** Drop every in-memory secret and unregister tracked literals. */
    forgetAll(): void;
}
export interface CredentialResolverOptions {
    /** `secrets.provider` / `secrets.envPrefix` from the effective configuration. */
    secrets: {
        provider: 'credentials' | 'env';
        envPrefix: string;
    };
    /** The credentials service, when the host composition has one. */
    credentials?: CredentialStoreFace | undefined;
    /** Profile lookup, so `set`/`clear` can find the reference a profile already uses. */
    profiles?: {
        get(id: ProfileId): ConnProfile | undefined;
        setSecretRef(id: ProfileId, field: SecretField, ref: string): Promise<ConnProfile | undefined>;
    } | undefined;
    /** Shared redactor; every resolved secret is registered with it. */
    redactor?: Redactor | undefined;
    /** Diagnostics sink; warnings never carry a value. */
    logger?: {
        warn(message: string, fields?: Record<string, unknown>): void;
    } | undefined;
    /** Environment snapshot (tests inject one). */
    env?: NodeJS.ProcessEnv;
}
/**
 * `PROFILE_SLUG` for `DSH_SSH_<SLUG>_PASSWORD`: the profile name, upper-cased with
 * every non-alphanumeric run collapsed to `_`.
 *
 * A name-based slug is predictable, which is the point — a user must be able to
 * guess the variable to export. Two profiles that share a name therefore share
 * the override; a profile that needs its own reference sets `secretRefs`
 * explicitly (or is addressed by its id, see {@link idSlug}).
 */
export declare function profileSlug(source: {
    id?: string | undefined;
    name?: string | undefined;
    host?: string | undefined;
    user?: string | undefined;
}): string;
/** Fallback slug for a profile that could not be loaded: its id, minus the prefix noise. */
export declare function idSlug(profileId: ProfileId): string;
/** `DSH_SSH_PROD_PASSWORD` for `{ name: 'prod' }` and the configured prefix. */
export declare function envNameFor(profile: ConnProfileInput, field: SecretField, envPrefix: string): string;
export declare class SshCredentialResolverImpl implements SshCredentialResolver {
    private readonly secrets;
    private readonly credentials;
    private readonly profiles;
    private readonly redactor;
    private readonly logger;
    private readonly env;
    /** Session-memory secrets: `set(persist: false)`, keyed by profile id or inline slug. */
    private readonly memory;
    constructor(options: CredentialResolverOptions);
    envNameFor(profile: ConnProfileInput, field: SecretField): string;
    /**
     * The reference that backs `field`.
     *
     * A profile's explicit `secretRefs` entry wins: it is what `set(persist: true)`
     * wrote, and it is stable even when the profile is renamed. Otherwise the
     * environment-variable-shaped name is used, which is what makes
     * `DSH_SSH_PROD_PASSWORD=… dsh` work with no configuration at all.
     */
    refFor(profile: ConnProfileInput, field: SecretField): string;
    resolve(profile: ConnProfileInput, oneShot?: {
        password?: string;
        passphrase?: string;
    }): Promise<ResolvedSecrets>;
    /**
     * Resolve a stored profile into the flat `{ ...profile, secrets }` triple SP1
     * consumes (matching `src/connection/types.ts`'s `ResolvedProfile`).
     *
     * The profile must already be normalised (`ProfileStore.save()` or `.get()`);
     * an inline request body should go through `ProfileStore.save()` first, which is
     * what mints the id and fills the server-owned fields.
     */
    resolveProfile(profile: ConnProfile, oneShot?: {
        password?: string;
        passphrase?: string;
    }): Promise<ResolvedProfile>;
    describe(profile: ConnProfileInput): Promise<ConnProfileViewSecrets>;
    set(profileId: ProfileId, field: SecretField, value: string, persist: boolean): Promise<SetSecretResult>;
    clear(profileId: ProfileId, field: SecretField): Promise<void>;
    forgetAll(): void;
    private memoryKey;
    /** The four-layer probe; the only place a plaintext enters the process. */
    private probe;
    private readEnv;
    private readStore;
    private track;
    private warn;
}
/** Create the credential resolver (one per plugin activation). */
export declare function createCredentialResolver(options: CredentialResolverOptions): SshCredentialResolverImpl;
//# sourceMappingURL=credentials.d.ts.map