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
import type { RetryConfig } from './config.js';
import { type AuthKind, type HostKeyPolicy, type ProfileSecretsView } from './protocol.js';
/** `'p_' + ULID`. */
export type ProfileId = string;
/** Where a resolved secret came from; the union is frozen by ICD §4.2. */
export type SecretSource = 'profile' | 'env' | 'keychain' | 'none';
/**
 * References only: never a value. `password`/`passphrase` name a credential
 * reference (an environment-variable-shaped name resolved by `ctx.credentials`);
 * `privateKeyPath` is a local file path, which is not a secret in itself.
 */
export interface SecretRefs {
    password?: string;
    passphrase?: string;
    privateKeyPath?: string;
}
/** Plaintext secrets, resolved for one operation and never persisted. */
export interface ResolvedSecrets {
    password?: string;
    passphrase?: string;
    privateKeyPath?: string;
    /** Provenance per field, for the UI badge; never the value. */
    source: {
        password: SecretSource;
        passphrase: SecretSource;
    };
    /**
     * Fail-safe serialisation: `JSON.stringify(resolved)` yields masks, so a
     * resolved secret cannot reach a log or a wire response through a code path
     * that merely forgot about it. Property access still returns the plaintext,
     * because that is what `ssh2` needs.
     */
    toJSON(): MaskedSecrets;
}
export interface MaskedSecrets {
    password?: string;
    passphrase?: string;
    privateKeyPath?: string;
    source: {
        password: SecretSource;
        passphrase: SecretSource;
    };
}
/** Build a `ResolvedSecrets` value; the only supported constructor. */
export declare function createResolvedSecrets(input: {
    password?: string;
    passphrase?: string;
    privateKeyPath?: string;
    source: {
        password: SecretSource;
        passphrase: SecretSource;
    };
}): ResolvedSecrets;
/** A stored connection profile. References only — see the file header. */
export interface ConnProfile {
    id: ProfileId;
    name: string;
    host: string;
    port: number;
    user: string;
    auth: AuthKind;
    secretRefs: SecretRefs;
    connectTimeoutMs: number;
    keepaliveIntervalMs: number;
    keepaliveCountMax: number;
    retries: RetryConfig;
    hostKeyPolicy: HostKeyPolicy;
    group?: string;
    tags: string[];
    defaultCwd?: string;
    defaultEnv?: Record<string, string>;
    createdAt: string;
    updatedAt: string;
    lastUsedAt?: string;
}
/**
 * The frozen input shape (ICD §4.2, v1.0.5): a full profile minus the fields the
 * server owns. `secretRefs` is re-added as optional because it is the one field a
 * caller may legitimately omit — see {@link ConnProfilePatch}.
 */
export type ConnProfileInput = Omit<ConnProfile, 'id' | 'createdAt' | 'updatedAt'> & {
    id?: ProfileId;
    secretRefs?: SecretRefs;
};
/**
 * What the store accepts when writing: any subset of {@link ConnProfileInput}.
 *
 * A field the caller omitted keeps its stored value, which is what makes "the UI
 * edited the host and sent the rest back unchanged" safe. The merge rule is frozen
 * (ICD §4.2 v1.0.5): **omitting `secretRefs` keeps the existing references**;
 * clearing a credential is `clearSecret`'s job and is never expressed by an
 * omission — one field must not have two opposite meanings depending on who reads
 * it.
 */
export interface ConnProfilePatch {
    id?: ProfileId;
    name?: string;
    /** Required when creating; a patch without it and without a stored profile is rejected. */
    host?: string;
    port?: number;
    user?: string;
    auth?: AuthKind;
    secretRefs?: SecretRefs;
    connectTimeoutMs?: number;
    keepaliveIntervalMs?: number;
    keepaliveCountMax?: number;
    retries?: Partial<RetryConfig>;
    hostKeyPolicy?: HostKeyPolicy;
    group?: string;
    tags?: string[];
    defaultCwd?: string;
    defaultEnv?: Record<string, string>;
    /** Per-connection only (ICD §4.3): forces a new connection instead of pool reuse. */
    forceNew?: boolean;
}
/**
 * The outward projection (ICD §4.2, v1.0.5). No plaintext: `secrets` reports
 * presence, provenance and a fixed 8-dot mask.
 *
 * `secretRefs` is carried as well, as approved in ICD v1.0.5. A reference name is
 * not a secret, and without it an edited profile could not be saved back without
 * dropping the reference to its stored credential — a silent downgrade to "the
 * derived environment name", which looks to the user like the password is still
 * there while the connect fails. Internally the field is always populated; the ICD
 * marks it optional, so any consumer may ignore it.
 */
export interface ConnProfileView extends Omit<ConnProfile, 'secretRefs'> {
    secrets: ProfileSecretsView;
    secretRefs: SecretRefs;
}
/**
 * A profile plus its resolved secrets — what `AcquireInput.profile` (ICD §7.1)
 * carries.
 *
 * Flat (`{ ...profile, secrets }`) rather than nested, matching the structural
 * mirror `src/connection/types.ts` declares, so the connection layer reads
 * `resolved.host` and `resolved.secrets.password` without an extra hop.
 */
export interface ResolvedProfile extends ConnProfile {
    /** Plaintext, in memory only: never persisted, never logged, never in SessionInfo. */
    secrets: ResolvedSecrets;
}
export interface ProfileStoreOptions {
    file: string;
    defaults: ProfileDefaults;
    /** Called once with the reason a profile file could not be read. */
    onLoadError?: (reason: string) => void;
    onWriteError?: (reason: string) => void;
    /** Key patterns refused inside `defaultEnv`; defaults to the logger's defaults. */
    redactKeys?: readonly string[];
}
export interface ProfileDefaults {
    connectTimeoutMs: number;
    keepaliveIntervalMs: number;
    keepaliveCountMax: number;
    retries: RetryConfig;
    hostKeyPolicy: HostKeyPolicy;
}
export interface ProfileStore {
    readonly file: string;
    /** Reason the file could not be read at load time, if any. */
    readonly loadError: string | undefined;
    list(): ConnProfile[];
    get(id: ProfileId): ConnProfile | undefined;
    save(input: ConnProfilePatch): Promise<ConnProfile>;
    remove(id: ProfileId): Promise<boolean>;
    duplicate(id: ProfileId, name?: string): Promise<ConnProfile>;
    /** Record that a profile was just used. Never throws: a failed write is not a failed connection. */
    touch(id: ProfileId): Promise<ConnProfile | undefined>;
    /** Point a secret field at a credential reference (used by `credentials.set`). */
    setSecretRef(id: ProfileId, field: 'password' | 'passphrase', ref: string): Promise<ConnProfile | undefined>;
}
/**
 * Monotonic ULID (48-bit time + 80-bit randomness, Crockford base32).
 *
 * Monotonic within a millisecond because ids are minted in bursts (duplicate a
 * profile, or reconnect the same host repeatedly); a plain random tail would make
 * sort order unstable, and a plain timestamp would collide.
 */
export declare function monotonicUlid(now?: number): string;
/** A fresh profile id. */
export declare function newProfileId(): ProfileId;
export declare function isCredentialRef(value: unknown): value is string;
/**
 * Reject a plaintext secret where a reference belongs.
 *
 * The message never quotes the offending value: a rejection is still a log line
 * and an error response, and quoting it would defeat the purpose of rejecting it.
 */
export declare function assertCredentialRef(value: string, field: string): string;
/** A reasonable default user, mirroring what `ssh host` would do. */
export declare function defaultUser(env?: NodeJS.ProcessEnv): string;
/**
 * Build the persisted record from an allowlisted input.
 *
 * `existing` supplies merge semantics: a field the caller omitted keeps its stored
 * value, which is what makes "the UI edited the host and re-saved the view" safe.
 * `secretRefs` follows the same rule — an explicit reference wins, an omitted one
 * is preserved, so a save can never silently orphan a stored credential.
 */
export declare function normalizeProfile(input: ConnProfilePatch, options: {
    defaults: ProfileDefaults;
    existing?: ConnProfile;
    now?: string;
    env?: NodeJS.ProcessEnv;
    redactKeys?: readonly string[];
}): ConnProfile;
/**
 * Project a profile for the wire.
 *
 * The `secrets` member is exactly ICD §4.2's shape, and `masked` is the fixed
 * 8-dot mask whenever a field is present — never a length-revealing string.
 */
export declare function toConnProfileView(profile: ConnProfile, secrets: ProfileSecretsView): ConnProfileView;
/** Build the `secrets` member from an already-resolved pair of fields. */
export declare function secretsViewOf(resolved: {
    password?: {
        present: boolean;
        source: SecretSource;
    };
    passphrase?: {
        present: boolean;
        source: SecretSource;
    };
    privateKeyPath?: string;
}): ProfileSecretsView;
/** Deep copy of a profile, so a caller cannot mutate the store's state. */
export declare function cloneProfile(profile: ConnProfile): ConnProfile;
export declare class ProfileStoreImpl implements ProfileStore {
    readonly file: string;
    private readonly defaults;
    private readonly onLoadError;
    private readonly onWriteError;
    private readonly redactKeys;
    private profiles;
    private loaded;
    private loadFailure;
    private corruptBackupDone;
    constructor(options: ProfileStoreOptions);
    get loadError(): string | undefined;
    list(): ConnProfile[];
    get(id: ProfileId): ConnProfile | undefined;
    save(input: ConnProfilePatch): Promise<ConnProfile>;
    remove(id: ProfileId): Promise<boolean>;
    duplicate(id: ProfileId, name?: string): Promise<ConnProfile>;
    touch(id: ProfileId): Promise<ConnProfile | undefined>;
    setSecretRef(id: ProfileId, field: 'password' | 'passphrase', ref: string): Promise<ConnProfile | undefined>;
    /** Force a re-read from disk (used by tests and by an external-edit watcher). */
    reload(): void;
    private ensureLoaded;
    private fail;
    private persist;
    /** The allowlist that makes "a plaintext can never be persisted" mechanical. */
    private serialize;
}
/** Create the connection-profile store (one per plugin activation). */
export declare function createProfileStore(options: ProfileStoreOptions): ProfileStoreImpl;
/** Modification time of the profile file, or 0 when it does not exist. */
export declare function profileFileMtime(file: string): number;
//# sourceMappingURL=store.d.ts.map