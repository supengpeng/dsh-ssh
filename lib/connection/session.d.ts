/**
 * `SessionHandle` implementation (ICD §7.1).
 *
 * One instance owns one live connection: its state machine, its `SessionInfo`
 * projection, the channels opened on it, and its SFTP subsystem. It is also the
 * `SftpChannelSource` SP3's adapter consumes, so the SFTP session is created
 * lazily on *this* transport and the raw `SFTPWrapper` is handed over untouched
 * (ICD v1.0.3: the adapter must forward `opts` verbatim to
 * `createWriteStream`, including `start`).
 */
import type { NegotiatedAlgorithms, SFTPWrapper } from 'ssh2';
import type { ResolvedConfig } from '../config.js';
import { SshError } from '../protocol.js';
import type { ErrorInfo, SessionInfo, SessionState } from '../protocol.js';
import type { SessionRegistry } from '../sessions.js';
import type { AuthPlan } from './auth.js';
import type { ExecHandle, ExecRequest, HostKeyQuestion, KnownHostsVerifierPort, LoggerPort, RedactorPort, ResolvedProfile, SftpChannelSource, SftpHandle, SftpProvider, SessionHandle, SessionId, ShellHandle, ShellRequest, SshClientPort } from './types.js';
export interface SessionDeps {
    config: ResolvedConfig;
    logger: LoggerPort;
    redactor?: RedactorPort | undefined;
    /** SP3's SFTP adapter; absent = `sftp()` reports `SSH_SFTP_PROTOCOL`. */
    sftp?: SftpProvider | undefined;
    /** SP1 registry kept in sync with this session's projection. */
    registry?: SessionRegistry | undefined;
    now: () => number;
}
export interface SessionDialOptions {
    auth: AuthPlan;
    createClient: () => SshClientPort;
    knownHosts?: KnownHostsVerifierPort | undefined;
    onHostKeyPrompt?: ((q: HostKeyQuestion) => Promise<'accept' | 'reject'>) | undefined;
    signal?: AbortSignal | undefined;
}
export interface SessionOptions {
    id: SessionId;
    profile: ResolvedProfile;
    label: string;
    deps: SessionDeps;
    /** Notified on every state transition (wire `state` frames). */
    onStateChange?: ((state: SessionState, error?: ErrorInfo) => void) | undefined;
}
export declare class SshSession implements SessionHandle, SftpChannelSource {
    readonly id: SessionId;
    private readonly profile;
    private readonly label;
    private readonly deps;
    private readonly machine;
    private readonly infoValue;
    private readonly channels;
    private readonly onStateChange;
    private transportValue;
    private sftpHandleValue;
    private sftpPending;
    private sftpWrapperValue;
    private sftpWrapperPending;
    private rttEma;
    private closing;
    private knownHostFingerprint;
    private serverBannerValue;
    private negotiatedValue;
    constructor(options: SessionOptions);
    get info(): SessionInfo;
    get state(): SessionState;
    /** Extra, non-frozen: the profile this session was created from. */
    get resolvedProfile(): ResolvedProfile;
    /** Extra, non-frozen: server identification banner, when the server sent one. */
    get banner(): string | undefined;
    /** Extra, non-frozen: negotiated algorithms (diagnostics). */
    get negotiated(): NegotiatedAlgorithms | undefined;
    /** Extra, non-frozen: `SHA256:` fingerprint of the accepted host key. */
    get hostKeyFingerprint(): string | undefined;
    exec(req: ExecRequest): Promise<ExecHandle>;
    shell(req: ShellRequest): Promise<ShellHandle>;
    sftp(signal?: AbortSignal): Promise<SftpHandle>;
    rttMs(): number | undefined;
    close(options?: {
        force?: boolean;
        reason?: string;
    }): Promise<void>;
    get handle(): SessionHandle;
    /**
     * The connection's raw SFTP subsystem.
     *
     * Returned unmodified on purpose: SP3's adapter forwards the caller's `opts`
     * object straight to `createWriteStream`, and a wrapper here would be the
     * easiest place to silently drop `start` (ICD v1.0.3).
     */
    openSftpChannel(signal?: AbortSignal): Promise<SFTPWrapper>;
    /** Dial, authenticate and become usable. Retried by the pool. */
    dial(options: SessionDialOptions): Promise<void>;
    /** The connection died outside a local `close()`. */
    handleLinkDeath(error?: SshError): void;
    /** Terminal bookkeeping after a failed dial. */
    markFailed(error: ErrorInfo): void;
    private doClose;
    private attachChannel;
    private requireConnected;
    private noteRtt;
    private setState;
    /** Mirror the projection into the registry, when one is wired. */
    private publish;
}
//# sourceMappingURL=session.d.ts.map