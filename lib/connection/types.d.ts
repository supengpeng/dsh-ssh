/**
 * Frozen connection-layer surface — mirrors `docs/ICD.md` §7.1 verbatim.
 *
 * SP2 (`src/exec`) and SP3 (`src/sftp`) code against exactly these signatures.
 * A change here is an ICD change: message the Lead before touching it.
 *
 * The file also declares the *injection ports* the pool consumes for services
 * owned by other agents (SP4 credentials / known-hosts / redaction, SP3 SFTP).
 * They are structural mirrors of the ICD interfaces, which keeps TypeScript's
 * structural typing happy across module boundaries and lets this module be
 * unit-tested with hand-written doubles long before the other agents land.
 */
import type { ConnectConfig, ExecOptions, PseudoTtyOptions, SFTPWrapper, ShellOptions } from 'ssh2';
import type { ResolvedConfig, RetryConfig } from '../config.js';
import type { AuthKind, ErrorInfo, HostKeyPolicy, SessionInfo, SessionState } from '../protocol.js';
import type { SessionRegistry } from '../sessions.js';
export type SessionId = string;
export type StreamId = string;
export type ProfileId = string;
export type OpId = string;
export type { AuthKind, ErrorInfo, HostKeyPolicy, SessionInfo, SessionState } from '../protocol.js';
export type { SshErrorCode } from '../protocol.js';
/** One-shot request for a non-PTY command channel. */
export interface ExecRequest {
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    maxOutputBytes?: number;
    pty?: boolean;
    cols?: number;
    rows?: number;
    term?: string;
}
/** One-shot request for a PTY interactive channel (no command to run). */
export interface ShellRequest extends Omit<ExecRequest, 'command' | 'pty'> {
    cols: number;
    rows: number;
    term?: string;
    cwd?: string;
    env?: Record<string, string>;
}
/** Terminal event of an exec/shell channel; `timedOut` is set by the deadline owner. */
export interface ExecExit {
    code: number | null;
    signal?: string;
    durationMs: number;
    timedOut: boolean;
}
export interface ExecHandle {
    readonly streamId: StreamId;
    /** Subscribe to output. Returns an unsubscribe function. */
    onData(cb: (channel: 'stdout' | 'stderr', chunk: Buffer) => void): () => void;
    /** Subscribe to the terminal event. Returns an unsubscribe function. */
    onExit(cb: (e: ExecExit) => void): () => void;
    /**
     * Write to the channel's stdin.
     *
     * ICD v1.0.4: throws `SSH_STATE_INVALID` once `endInput()` was called or the
     * channel is closed — never silently drops the bytes.
     */
    write(stdin: string | Buffer): void;
    /** Close the stdin direction (send EOF). Direct pass-through of `channel.end()`. */
    endInput(): void;
    /** Send a POSIX signal request to the remote process (best effort). */
    signal(sig: 'INT' | 'TERM' | 'KILL' | 'QUIT' | 'HUP'): void;
    /** Cancel the channel: TERM, then a forced close after a short grace period. */
    cancel(): void;
}
export interface ShellHandle extends ExecHandle {
    /** Resize the remote PTY. */
    resize(cols: number, rows: number): void;
}
/**
 * SFTP session handle — mirrors ICD §7.3 (`src/sftp/types.ts`, owned by SP3).
 * The real interface is declared there; structural typing keeps both usable.
 *
 * ICD v1.0.3: `createWriteStream` takes an optional `start` (offset write) and
 * the adapter may advertise `supportsOffsetWrite()`.
 */
export interface SftpHandle {
    listDir(path: string, opts?: {
        showHidden?: boolean;
        signal?: AbortSignal;
    }): Promise<DirEntry[]>;
    stat(path: string, signal?: AbortSignal): Promise<FileInfo>;
    mkdir(path: string, opts?: {
        recursive?: boolean;
    }): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    remove(path: string, opts?: {
        recursive?: boolean;
    }, signal?: AbortSignal): Promise<number>;
    chmod(path: string, mode: string): Promise<void>;
    createReadStream(path: string, opts: {
        start?: number;
        end?: number;
    }): NodeJS.ReadableStream;
    createWriteStream(path: string, opts: {
        flags?: string;
        mode?: number;
        start?: number;
    }): NodeJS.WritableStream;
    supportsOffsetWrite?(): boolean | undefined;
}
/** Directory entry — mirrors ICD §4.5, referenced by `SftpHandle`. */
export interface DirEntry {
    name: string;
    path: string;
    type: 'file' | 'dir' | 'symlink' | 'other';
    size: number;
    mode: string;
    mtime: string;
    isSymlink: boolean;
    target?: string;
}
export interface FileInfo extends DirEntry {
    exists: boolean;
    uid?: number;
    gid?: number;
}
/**
 * What the connection layer hands to SP3's SFTP adapter.
 *
 * SP3 needs the raw `ssh2` SFTP subsystem of *this* connection (the ICD requires
 * lazy creation on the same underlying transport), so the adapter receives this
 * source instead of the frozen `SessionHandle` alone.
 */
export interface SftpChannelSource {
    /** The public session handle, for `id`/`info` and capability updates. */
    readonly handle: SessionHandle;
    /** Open (or reuse) the SFTP subsystem channel of this connection. */
    openSftpChannel(signal?: AbortSignal): Promise<SFTPWrapper>;
}
/** SP3's adapter factory, injected into the pool. */
export type SftpProvider = (source: SftpChannelSource, signal?: AbortSignal) => Promise<SftpHandle>;
/** Host key question asked during `acquire` when the policy needs a human. */
export interface HostKeyQuestion {
    host: string;
    port: number;
    keyType: string;
    fingerprint: string;
    /** `unknown` = never seen; `changed` = present but different (mismatch). */
    knownHostsMatch: 'unknown' | 'changed';
}
export interface SessionHandle {
    readonly id: SessionId;
    /**
     * Live session projection. The object identity is stable for the lifetime of
     * the session and its fields are kept current (`state`, `metrics`), so a
     * status bar can hold the reference; consumers must treat it as read-only.
     * It never contains credentials.
     */
    readonly info: SessionInfo;
    readonly state: SessionState;
    /** Non-PTY command channel. */
    exec(req: ExecRequest): Promise<ExecHandle>;
    /** PTY interactive channel. */
    shell(req: ShellRequest): Promise<ShellHandle>;
    /** SFTP session (lazily created, reusing the same underlying connection). */
    sftp(signal?: AbortSignal): Promise<SftpHandle>;
    /** Heartbeat round-trip time (ms); `undefined` until a sample exists. */
    rttMs(): number | undefined;
    close(options?: {
        force?: boolean;
        reason?: string;
    }): Promise<void>;
}
export interface AcquireInput {
    /** Profile resolved by SP4 (contains in-memory plaintext credentials only). */
    profile: ResolvedProfile;
    label?: string;
    forceNew?: boolean;
    signal?: AbortSignal;
    onStateChange?: (state: SessionState, error?: ErrorInfo) => void;
    onHostKeyPrompt?: (q: HostKeyQuestion) => Promise<'accept' | 'reject'>;
}
export interface ConnectionPool {
    /** Connect (auth, host key verification, retry/backoff). Idempotent per (profileId, forceNew). */
    acquire(input: AcquireInput): Promise<SessionHandle>;
    get(sessionId: SessionId): SessionHandle | undefined;
    list(): SessionHandle[];
    /** Close everything (called from `ctx.effect` on plugin unload). */
    disposeAll(reason: string): Promise<void>;
    readonly size: number;
    readonly pending: number;
}
/**
 * Connection profile as persisted by SP4 (`src/store.ts`).
 *
 * Declared here because the connection layer must be able to type-check its own
 * input before SP4 lands; `ConnProfile` in `src/store.ts` is the owner. The two
 * must stay structurally identical — the Lead reconciles them at integration.
 */
export interface ConnProfile {
    id: ProfileId;
    name: string;
    host: string;
    port: number;
    user: string;
    auth: AuthKind;
    secretRefs: {
        password?: string;
        passphrase?: string;
        privateKeyPath?: string;
    };
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
 * Effective credentials for one connection attempt. Plaintext lives in memory
 * only: it is never persisted, never copied into `SessionInfo`, never logged.
 */
export interface ResolvedSecrets {
    password?: string;
    passphrase?: string;
    /** Path to the private key file (read at connect time). */
    privateKeyPath?: string;
    /** Inline PEM/OpenSSH private key material, when the key is not on disk. */
    privateKey?: string;
    /** ssh-agent socket path; defaults to `$SSH_AUTH_SOCK` (or Pageant on Windows). */
    agentSocket?: string;
}
/** A profile plus its resolved credentials. */
export interface ResolvedProfile extends ConnProfile {
    secrets: ResolvedSecrets;
}
export interface LoggerPort {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}
/** Mirrors ICD §7.3 `Redactor`. */
export interface RedactorPort {
    scrub<T>(value: T, extra?: Record<string, string>): T;
    track(secret: string | undefined): void;
    forgetAll(): void;
}
/** The subset of ICD §7.3 `CredentialResolver` the connection layer consumes. */
export interface CredentialSourcePort {
    /** Resolve the effective credentials for a profile (`env` > stored > one-shot). */
    resolve(profile: ConnProfile, oneShot?: {
        password?: string;
        passphrase?: string;
    }): Promise<ResolvedSecrets>;
}
/** Mirrors ICD §7.3 `KnownHostsVerifier`. */
export interface KnownHostsVerifierPort {
    verify(q: {
        host: string;
        port: number;
        keyType: string;
        key: Buffer;
        policy: HostKeyPolicy;
    }): Promise<{
        ok: true;
    } | {
        ok: false;
        code: 'SSH_HOSTKEY_UNKNOWN' | 'SSH_HOSTKEY_MISMATCH';
        fingerprint: string;
        knownHostsMatch: 'unknown' | 'exact' | 'changed';
    }>;
    remember(q: {
        host: string;
        port: number;
        keyType: string;
        key: Buffer;
    }): Promise<void>;
    fingerprint(keyType: string, key: Buffer): string;
}
/** The subset of the `ssh2` `Client` the connection layer drives. */
export interface SshClientPort {
    on(event: string, listener: (...args: any[]) => void): unknown;
    connect(config: ConnectConfig): void;
    exec(command: string, options: ExecOptions, callback: (err: Error | undefined, channel: ClientChannelPort) => void): unknown;
    shell(window: PseudoTtyOptions | false, options: ShellOptions, callback: (err: Error | undefined, channel: ClientChannelPort) => void): unknown;
    sftp(callback: (err: Error | undefined, sftp: SFTPWrapper) => void): unknown;
    end(): unknown;
    destroy(): unknown;
}
/** The subset of the `ssh2` `ClientChannel` a channel handle drives. */
export interface ClientChannelPort {
    on(event: 'data', listener: (chunk: Buffer) => void): unknown;
    on(event: 'exit', listener: (code: number | null, signal: string | undefined, dump: string, desc: string) => void): unknown;
    on(event: 'close', listener: (code: number | null, signal: string | undefined) => void): unknown;
    on(event: string, listener: (...args: any[]) => void): unknown;
    stderr: {
        on(event: 'data', listener: (chunk: Buffer) => void): unknown;
    } | null;
    write(data: string | Buffer, callback?: (err?: Error | null) => void): boolean;
    signal(signal: string): unknown;
    setWindow(rows: number, cols: number, height: number, width: number): unknown;
    close(): unknown;
    end(): unknown;
}
export interface PoolOptions {
    /** Effective plugin configuration (timeouts, limits, retry policy, policies). */
    config: ResolvedConfig;
    /** Structured logger; credential values never reach it. */
    logger?: LoggerPort;
    /** SP4 redactor; every log line and error detail passes through it. */
    redactor?: RedactorPort;
    /** SP4 credential resolver, used when a profile arrives without `secrets`. */
    credentials?: CredentialSourcePort;
    /** SP4 known-hosts verifier; absent = degraded (documented in README). */
    knownHosts?: KnownHostsVerifierPort;
    /** SP1 session registry; when present the pool keeps it in sync. */
    registry?: SessionRegistry;
    /** SP3 SFTP adapter factory. */
    sftp?: SftpProvider;
    /** ssh2 client factory (injectable for tests). */
    createClient?: () => SshClientPort;
    /** Reads a private key file (injectable for tests). */
    readFile?: (path: string) => Promise<Buffer>;
    /** Jitter source in [0,1); defaults to `Math.random`. */
    random?: () => number;
    /** Monotonic-ish clock in ms; defaults to `Date.now`. */
    now?: () => number;
    /** Sleeper used by the retry loop; injectable so tests run instantly. */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    /** Environment used for agent lookup / key paths; defaults to `process.env`. */
    env?: NodeJS.ProcessEnv;
    /** Platform used for agent lookup; defaults to `process.platform`. */
    platform?: NodeJS.Platform;
}
//# sourceMappingURL=types.d.ts.map