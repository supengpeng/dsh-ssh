/**
 * Frozen wire contract of the SSH plugin.
 *
 * This module is the single source of truth shared by the host half and the
 * client half, and it mirrors `docs/ICD.md` §2/§3/§4/§5. Nothing here may be
 * changed without a Lead-approved ICD revision: the client bundle is built
 * independently of the host, so a drift in these literals breaks the wire
 * silently at runtime rather than at compile time.
 */
/** Wire protocol revision reported by `sshPlugin/ping`. */
export declare const PROTOCOL_VERSION = "1.0.0";
/** Cordis service key and Remote namespace of this plugin. */
export declare const SERVICE_KEY = "sshPlugin";
export declare const REMOTE_NAMESPACE = "sshPlugin";
export declare const ERROR_CODES: readonly ["SSH_NET_UNREACHABLE", "SSH_NET_REFUSED", "SSH_NET_DNS", "SSH_NET_RESET", "SSH_NET_TIMEOUT", "SSH_AUTH_FAILED", "SSH_AUTH_METHOD_UNSUPPORTED", "SSH_AUTH_KEY_UNREADABLE", "SSH_AUTH_PASSPHRASE_REQUIRED", "SSH_AUTH_AGENT_UNAVAILABLE", "SSH_HOSTKEY_UNKNOWN", "SSH_HOSTKEY_MISMATCH", "SSH_TIMEOUT_CONNECT", "SSH_TIMEOUT_OPERATION", "SSH_TIMEOUT_IDLE", "SSH_CMD_EXIT_NONZERO", "SSH_SFTP_PROTOCOL", "SSH_SFTP_NO_SUCH_FILE", "SSH_SFTP_TARGET_EXISTS", "SSH_SFTP_IS_A_DIRECTORY", "SSH_SFTP_DISK_FULL", "SSH_SFTP_VERIFY_MISMATCH", "SSH_SFTP_TRANSFER_ABORTED", "SSH_PERM_DENIED", "SSH_PERM_LOCAL_DENIED", "SSH_LIMIT_POOL_EXHAUSTED", "SSH_LIMIT_QUEUE_FULL", "SSH_LIMIT_OUTPUT_TRUNCATED", "SSH_CFG_INVALID", "SSH_STATE_INVALID", "SSH_CANCELLED", "SSH_UNKNOWN"];
export type SshErrorCode = (typeof ERROR_CODES)[number] | (string & {});
/** Category of a code, used by the UI for grouping and by retry policy. */
export type SshErrorCategory = 'network' | 'auth' | 'timeout' | 'command' | 'sftp' | 'permission' | 'limit' | 'config' | 'state' | 'unknown';
/** Classify a code; unknown codes fall back to `unknown` rather than throwing. */
export declare function errorCategory(code: SshErrorCode): SshErrorCategory;
export declare function isRetryable(code: SshErrorCode): boolean;
/** Serialisable failure shape carried by every rejected call and `end` frame. */
export interface ErrorInfo {
    code: SshErrorCode;
    message: string;
    details?: unknown;
    retryable: boolean;
    retryAfterMs?: number;
}
/**
 * The one error type thrown inside the host half. `toErrorInfo()` is the only
 * supported way to cross the wire: it guarantees `retryable` is derived from
 * the code table and that no host object leaks into the response.
 */
export declare class SshError extends Error {
    readonly code: SshErrorCode;
    readonly details: unknown;
    readonly retryAfterMs: number | undefined;
    constructor(code: SshErrorCode, message: string, options?: {
        details?: unknown;
        retryAfterMs?: number;
        cause?: unknown;
    });
    get retryable(): boolean;
    toErrorInfo(): ErrorInfo;
}
/** Normalise any thrown value into a wire-safe `ErrorInfo`. */
export declare function toErrorInfo(error: unknown): ErrorInfo;
export type StreamKind = 'shell' | 'exec' | 'upload' | 'download' | 'audit';
export type SessionState = 'idle' | 'connecting' | 'authenticating' | 'connected' | 'closing' | 'closed' | 'error';
export type TransferPhase = 'scan' | 'transfer' | 'finalize' | 'verify';
export type EndReason = 'completed' | 'cancelled' | 'timeout' | 'error' | 'peer-closed';
export type Frame = {
    t: 'open';
    streamId: string;
    kind: StreamKind;
    meta?: unknown;
} | {
    t: 'data';
    streamId: string;
    seq: number;
    chunk: string;
    encoding: 'utf8' | 'base64';
    channel: 'stdout' | 'stderr' | 'term';
} | {
    t: 'progress';
    streamId: string;
    transferred: number;
    totalBytes?: number;
    bytesPerSec: number;
    etaMs?: number;
    phase: TransferPhase;
} | {
    t: 'exit';
    streamId: string;
    exitCode: number | null;
    signal?: string;
    durationMs: number;
    timedOut: boolean;
} | {
    t: 'state';
    sessionId: string;
    state: SessionState;
    error?: ErrorInfo;
} | {
    t: 'audit';
    entry: AuditEntry;
} | {
    t: 'end';
    streamId: string;
    reason: EndReason;
    error?: ErrorInfo;
} | {
    t: 'activity-snapshot';
    activities: ActivityView[];
} | {
    t: 'activity';
    phase: 'begin' | 'end';
    activity: ActivityView;
} | {
    t: 'activity';
    phase: 'chunk';
    id: string;
    chunk: ActivityChunk;
} | {
    t: 'activity-reset';
};
export type AuthKind = 'password' | 'privateKey' | 'agent';
export type HostKeyPolicy = 'strict' | 'accept-new' | 'insecure';
/**
 * What an agent-driven operation was (ICD §4.7).
 *
 * The activity mirror exists because every `ssh_*` tool call is invisible in the
 * session workspace: the client only ever sees the operations *it* started, so a
 * user watching the 终端 tab sees nothing while the model works. These kinds are
 * the operations the agent tools can perform, not the wire endpoints.
 */
export type ActivityKind = 'exec' | 'upload' | 'download' | 'listDir' | 'stat' | 'connect' | 'disconnect' | 'sessions';
/** Terminal classification of one activity, mirroring the tool's own outcome. */
export type ActivityStatus = 'running' | 'ok' | 'error' | 'timeout' | 'cancelled' | 'refused';
/** Which stream a chunk belongs to; `info` is the plugin's own narration. */
export type ActivityChannel = 'stdout' | 'stderr' | 'info';
export interface ActivityChunk {
    channel: ActivityChannel;
    text: string;
}
/**
 * One activity as the UI renders it.
 *
 * `segments` is the transcript in arrival order and is capped by the feed:
 * `truncated` says whether bytes were dropped, so a short transcript is never
 * mistaken for a command that produced little output. Segments rather than one
 * string because the channel is presentational — a `stderr` run is drawn
 * differently from `stdout`, and `info` is the plugin's own narration.
 */
export interface ActivityView {
    id: string;
    kind: ActivityKind;
    sessionId: string | null;
    /** `user@host` when the session was known, else null. */
    target: string | null;
    /** One line naming what ran: the shell command, `local → remote`, the host… */
    subject: string;
    cwd: string | null;
    label: string | null;
    startedAt: number;
    endedAt: number | null;
    durationMs: number | null;
    status: ActivityStatus;
    exitCode: number | null;
    signal: string | null;
    /** Machine-readable failure code (`SSH_*`) when the call failed or was refused. */
    code: string | null;
    note: string | null;
    segments: ActivityChunk[];
    truncated: boolean;
}
export interface AuditEntry {
    at: string;
    op: string;
    sessionId?: string;
    profileId?: string;
    outcome: 'ok' | 'denied' | 'error';
    durationMs?: number;
    target?: {
        host: string;
        port: number;
        user: string;
    };
    detail?: Record<string, unknown>;
}
export interface ProfileSecretsView {
    password: {
        present: boolean;
        source: 'profile' | 'env' | 'keychain' | 'none';
        masked: string;
    };
    passphrase: {
        present: boolean;
        source: 'profile' | 'env' | 'keychain' | 'none';
        masked: string;
    };
    privateKeyPath?: string;
}
export interface SessionInfo {
    id: string;
    profileId?: string;
    label: string;
    host: string;
    port: number;
    user: string;
    state: SessionState;
    since: string;
    metrics: {
        connectMs?: number;
        rttMs?: number;
        bytesIn: number;
        bytesOut: number;
    };
    capabilities: {
        shell: boolean;
        sftp: boolean;
    };
    error?: ErrorInfo;
}
export interface PingParams {
    echo?: string;
}
/**
 * Result of the transport spike. `binding` records which client→host call path
 * the browser half resolved; `endpoints` records what the Host Gateway was
 * willing to answer, so a partial registration is visible instead of silent.
 */
export interface PingResult {
    pong: true;
    echo?: string;
    version: string;
    namespace: string;
    /** Host runtime facts, useful when debugging a deployed plugin. */
    node: string;
    pluginVersion: string;
    /** ISO timestamp the answer was produced. */
    at: string;
    /** How long the round trip took, measured on the host side of the call. */
    handlerMs: number;
}
export interface ProbeStreamParams {
    /** Frames to emit before ending; clamped to a safe range by the host. */
    count?: number;
    intervalMs?: number;
    /** When true the stream ends with an error frame instead of a clean end. */
    fail?: boolean;
}
/**
 * What the browser learned about its own client→host carrier.
 *
 * The binding is resolved inside the page, so the host cannot observe it
 * directly; the client reports it once per run so the fact outlives the tab.
 */
export interface SpikeReport {
    carrier: string | null;
    ok: boolean;
    transport?: {
        kind?: string;
        status?: string;
        generation?: number;
    };
    attempts?: unknown[];
    serviceShapes?: Record<string, string>;
    userAgent?: string;
}
export interface SpikeReportReceipt {
    recorded: boolean;
    file: string;
}
//# sourceMappingURL=protocol.d.ts.map