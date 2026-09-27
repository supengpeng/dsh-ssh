/**
 * The one place that talks to `ssh2`'s `Client`.
 *
 * Responsibilities: dial with the effective timeouts/keepalive settings, run the
 * host-key policy, classify every failure into an ICD §5 code, open exec/shell/
 * SFTP channels on the live connection, and close it gracefully.
 *
 * Deliberate omission: `ssh2`'s `debug` hook is **not** wired to the plugin
 * logger. Its packet dumps can contain authentication data in binary form, which
 * neither key-name nor literal-value redaction can catch; a logger that leaks a
 * password is worse than a quiet handshake.
 */
import type { NegotiatedAlgorithms, PseudoTtyOptions, SFTPWrapper } from 'ssh2';
import type { ResolvedConfig } from '../config.js';
import { SshError } from '../protocol.js';
import type { HostKeyPolicy } from '../protocol.js';
import type { AuthPlan } from './auth.js';
import type { ClientChannelPort, HostKeyQuestion, KnownHostsVerifierPort, LoggerPort, ResolvedProfile, SshClientPort } from './types.js';
/** Default PTY geometry, matching the ICD's `openShell` defaults. */
export declare const DEFAULT_TERM = "xterm-256color";
export declare const DEFAULT_COLS = 80;
export declare const DEFAULT_ROWS = 24;
export interface TransportOpenOptions {
    profile: ResolvedProfile;
    config: ResolvedConfig;
    auth: AuthPlan;
    logger: LoggerPort;
    createClient: () => SshClientPort;
    knownHosts?: KnownHostsVerifierPort | undefined;
    onHostKeyPrompt?: ((q: HostKeyQuestion) => Promise<'accept' | 'reject'>) | undefined;
    /** Called once the key exchange finished and authentication begins. */
    onHandshake?: (() => void) | undefined;
    /** Called when the connection is established. */
    onReady?: (() => void) | undefined;
    /** Host key facts observed during verification (for `testProfile`). */
    onHostKeyDecision?: ((info: HostKeyDecision) => void) | undefined;
    /** Round-trip samples observed while opening channels. */
    onRttSample?: ((ms: number) => void) | undefined;
    /** Called when the connection dies after `openTransport` resolved. */
    onClosed?: ((error: SshError | undefined) => void) | undefined;
    signal?: AbortSignal | undefined;
    now?: (() => number) | undefined;
}
export interface ExecChannelOptions {
    env?: Record<string, string> | undefined;
    pty?: PseudoTtyOptions | undefined;
}
export interface ShellChannelOptions {
    term?: string | undefined;
    cols?: number | undefined;
    rows?: number | undefined;
    env?: Record<string, string> | undefined;
}
export interface Transport {
    readonly client: SshClientPort;
    /** TCP + handshake + authentication duration, measured locally. */
    readonly connectMs: number;
    readonly banner: string | undefined;
    readonly negotiated: NegotiatedAlgorithms | undefined;
    /** `SHA256:` fingerprint of the accepted host key (ICD §7.3). */
    readonly hostKeyFingerprint: string | undefined;
    readonly closed: boolean;
    exec(command: string, options?: ExecChannelOptions): Promise<ClientChannelPort>;
    shell(options?: ShellChannelOptions): Promise<ClientChannelPort>;
    sftp(): Promise<SFTPWrapper>;
    close(options?: {
        force?: boolean;
        reason?: string;
    }): Promise<void>;
}
/** Host key facts recorded during verification. */
export interface HostKeyDecision {
    keyType: string;
    fingerprint: string;
    knownHostsMatch: 'unknown' | 'exact' | 'changed';
    accepted: boolean;
}
/**
 * `SHA256:` + base64(sha256(blob)) without padding — byte-identical to
 * `ssh-keygen -lf` (ICD §7.3). Used when no verifier is injected.
 */
export declare function sshFingerprint(key: Buffer): string;
export declare function effectiveTimeouts(profile: ResolvedProfile, config: ResolvedConfig): {
    connectTimeoutMs: number;
    keepaliveIntervalMs: number;
    keepaliveCountMax: number;
};
/**
 * Host-key policy decision (ICD §6 `hostKey.policy`).
 *
 * `insecure` accepts anything; `strict` refuses an unknown key; `accept-new`
 * trusts on first use *and* still asks about a changed key — a mismatch is never
 * silently accepted, because that is the whole point of the check.
 */
export declare function decideHostKey(key: Buffer, context: {
    host: string;
    port: number;
    policy: HostKeyPolicy;
    knownHosts?: KnownHostsVerifierPort | undefined;
    onHostKeyPrompt?: ((q: HostKeyQuestion) => Promise<'accept' | 'reject'>) | undefined;
    onDecision?: ((info: HostKeyDecision) => void) | undefined;
    logger: LoggerPort;
}): Promise<boolean>;
/** Open a connection and resolve once it is authenticated and ready. */
export declare function openTransport(options: TransportOpenOptions): Promise<Transport>;
/** Compose `cwd`/`env` into a single remote command (ICD §4.4). */
export declare function composeRemoteCommand(command: string, cwd: string | undefined, env: Record<string, string> | undefined): {
    command: string;
    env: Record<string, string> | undefined;
};
/** POSIX single-quote escaping: `'` → `'\''`. */
export declare function shellQuote(value: string): string;
/** Message used by `SessionHandle.close({reason})` logging; exported for tests. */
export declare function closeReason(options: {
    force?: boolean;
    reason?: string;
} | undefined): string;
//# sourceMappingURL=transport.d.ts.map