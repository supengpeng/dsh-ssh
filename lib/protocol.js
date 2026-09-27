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
export const PROTOCOL_VERSION = '1.0.0';
/** Cordis service key and Remote namespace of this plugin. */
export const SERVICE_KEY = 'sshPlugin';
export const REMOTE_NAMESPACE = 'sshPlugin';
// ---------------------------------------------------------------------------
// Error codes (ICD §5)
// ---------------------------------------------------------------------------
export const ERROR_CODES = [
    'SSH_NET_UNREACHABLE',
    'SSH_NET_REFUSED',
    'SSH_NET_DNS',
    'SSH_NET_RESET',
    'SSH_NET_TIMEOUT',
    'SSH_AUTH_FAILED',
    'SSH_AUTH_METHOD_UNSUPPORTED',
    'SSH_AUTH_KEY_UNREADABLE',
    'SSH_AUTH_PASSPHRASE_REQUIRED',
    'SSH_AUTH_AGENT_UNAVAILABLE',
    'SSH_HOSTKEY_UNKNOWN',
    'SSH_HOSTKEY_MISMATCH',
    'SSH_TIMEOUT_CONNECT',
    'SSH_TIMEOUT_OPERATION',
    'SSH_TIMEOUT_IDLE',
    'SSH_CMD_EXIT_NONZERO',
    'SSH_SFTP_PROTOCOL',
    'SSH_SFTP_NO_SUCH_FILE',
    'SSH_SFTP_TARGET_EXISTS',
    'SSH_SFTP_IS_A_DIRECTORY',
    'SSH_SFTP_DISK_FULL',
    'SSH_SFTP_VERIFY_MISMATCH',
    'SSH_SFTP_TRANSFER_ABORTED',
    'SSH_PERM_DENIED',
    'SSH_PERM_LOCAL_DENIED',
    'SSH_LIMIT_POOL_EXHAUSTED',
    'SSH_LIMIT_QUEUE_FULL',
    'SSH_LIMIT_OUTPUT_TRUNCATED',
    'SSH_CFG_INVALID',
    'SSH_STATE_INVALID',
    'SSH_CANCELLED',
    'SSH_UNKNOWN',
];
const CATEGORY_BY_PREFIX = [
    ['SSH_NET_', 'network'],
    ['SSH_AUTH_', 'auth'],
    ['SSH_HOSTKEY_', 'auth'],
    ['SSH_TIMEOUT_', 'timeout'],
    ['SSH_CMD_', 'command'],
    ['SSH_SFTP_', 'sftp'],
    ['SSH_PERM_', 'permission'],
    ['SSH_LIMIT_', 'limit'],
    ['SSH_CFG_', 'config'],
    ['SSH_STATE_', 'state'],
    ['SSH_CANCELLED', 'state'],
];
/** Classify a code; unknown codes fall back to `unknown` rather than throwing. */
export function errorCategory(code) {
    for (const [prefix, category] of CATEGORY_BY_PREFIX) {
        if (String(code).startsWith(prefix))
            return category;
    }
    return 'unknown';
}
/**
 * Codes a caller may retry without changing the request. Kept in lockstep with
 * the ICD table: `retryable` is a property of the code, not of the attempt.
 */
const RETRYABLE = new Set([
    'SSH_NET_UNREACHABLE',
    'SSH_NET_REFUSED',
    'SSH_NET_RESET',
    'SSH_NET_TIMEOUT',
    'SSH_TIMEOUT_CONNECT',
    'SSH_TIMEOUT_OPERATION',
    'SSH_TIMEOUT_IDLE',
    'SSH_SFTP_VERIFY_MISMATCH',
    'SSH_SFTP_TRANSFER_ABORTED',
    'SSH_LIMIT_POOL_EXHAUSTED',
    'SSH_LIMIT_QUEUE_FULL',
]);
export function isRetryable(code) {
    return RETRYABLE.has(code);
}
/**
 * The one error type thrown inside the host half. `toErrorInfo()` is the only
 * supported way to cross the wire: it guarantees `retryable` is derived from
 * the code table and that no host object leaks into the response.
 */
export class SshError extends Error {
    code;
    details;
    retryAfterMs;
    constructor(code, message, options = {}) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = 'SshError';
        this.code = code;
        this.details = options.details;
        this.retryAfterMs = options.retryAfterMs;
    }
    get retryable() {
        return isRetryable(this.code);
    }
    toErrorInfo() {
        const info = {
            code: this.code,
            message: this.message,
            retryable: this.retryable,
        };
        if (this.details !== undefined)
            info.details = this.details;
        if (this.retryAfterMs !== undefined)
            info.retryAfterMs = this.retryAfterMs;
        return info;
    }
}
/** Normalise any thrown value into a wire-safe `ErrorInfo`. */
export function toErrorInfo(error) {
    if (error instanceof SshError)
        return error.toErrorInfo();
    if (error instanceof Error) {
        return { code: 'SSH_UNKNOWN', message: error.message, retryable: false };
    }
    return { code: 'SSH_UNKNOWN', message: String(error), retryable: false };
}
//# sourceMappingURL=protocol.js.map