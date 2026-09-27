/**
 * Authentication planning (ICD §4.2 `auth: password | privateKey | agent`).
 *
 * The connection layer never guesses: before any TCP connection is opened, the
 * plan is built and validated so that an unreadable key, a missing passphrase or
 * an unavailable agent is reported as a precise ICD §5 code instead of a generic
 * "authentication failed" after a 15-second timeout.
 *
 * The returned `config` object contains plaintext material. It exists only to be
 * handed to `ssh2`'s `connect()` and must never be logged, serialised or merged
 * into a `SessionInfo`.
 */
import type { ConnectConfig } from 'ssh2';
import type { AuthKind } from '../protocol.js';
import type { CredentialSourcePort, ResolvedProfile, ResolvedSecrets } from './types.js';
/** Fields the auth plan contributes to the ssh2 client config. */
export type AuthConfig = Pick<ConnectConfig, 'username' | 'password' | 'privateKey' | 'passphrase' | 'agent'>;
export interface AuthPlan {
    kind: AuthKind;
    /** Secret-bearing ssh2 client fields. Never log or persist this object. */
    config: AuthConfig;
    /** `password(8 chars)`, `privateKey(path, encrypted)`, `agent(pageant)`, ... */
    describe(): string;
}
export interface PlanAuthOptions {
    /** Reads the private key file; injectable so unit tests need no key on disk. */
    readFile?: (path: string) => Promise<Buffer>;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
}
/**
 * Effective agent source: an explicit socket path wins, then `$SSH_AUTH_SOCK`,
 * then Pageant on Windows. Returns `undefined` when no agent can be reached.
 */
export declare function resolveAgentSource(secrets: ResolvedSecrets, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string | undefined;
/** `••••••••` — fixed 8 dots, never a length hint (ICD §4.2). */
export declare function maskedSecret(value: string | undefined): string;
/**
 * Parse a private key up-front so that an encrypted key without a passphrase, a
 * wrong passphrase and a malformed key are distinguishable before connecting.
 * `ssh2.utils.parseKey` is the same parser the client will use, so this cannot
 * disagree with the handshake outcome.
 */
export declare function parsePrivateKey(pem: Buffer | string, passphrase: string | undefined, path?: string): void;
/**
 * Build the ssh2 auth fields for one profile.
 *
 * Precedence for the key material: inline `secrets.privateKey`, else the path in
 * `secrets.privateKeyPath` / `profile.secretRefs.privateKeyPath`.
 */
export declare function planAuth(profile: ResolvedProfile, options?: PlanAuthOptions): Promise<AuthPlan>;
/**
 * Resolve the credentials a profile brings, falling back to SP4's resolver when
 * the profile arrived without any (an inline profile, or a caller that only
 * holds a stored profile).
 */
export declare function resolveProfileSecrets(profile: ResolvedProfile, credentials?: CredentialSourcePort): Promise<ResolvedProfile>;
//# sourceMappingURL=auth.d.ts.map