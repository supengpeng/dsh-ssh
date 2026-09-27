/**
 * Mapping from "whatever the SFTP layer threw" to the frozen error vocabulary
 * of `docs/ICD.md` §5.
 *
 * Two error dialects arrive here and both must land on a wire code:
 *
 *  - `ssh2`'s SFTP errors carry `err.code` as a **numeric** SFTP status code.
 *    ssh2 speaks protocol version 3, whose table stops at 8
 *    (`OK/EOF/NO_SUCH_FILE/PERMISSION_DENIED/FAILURE/BAD_MESSAGE/NO_CONNECTION/
 *    CONNECTION_LOST/OP_UNSUPPORTED`), so meaningful cases such as "file exists"
 *    arrive as a bare `FAILURE` whose text carries the detail. Detection of
 *    conflicts therefore never relies on an error code — `client.ts` decides by
 *    `stat()` — and the mapper reads the text only to choose between codes.
 *  - `node:fs` errors carry `err.code` as a **string** (`ENOENT`, `EACCES`, …).
 *
 * `local: true` in the context selects the local-side codes the ICD defines
 * (`SSH_PERM_LOCAL_DENIED`), matching the convention `src/api/**` uses for
 * `listLocalDir`/`statLocal`.
 */
import { SshError } from '../protocol.js';
import type { ErrorInfo } from '../protocol.js';
import type { TransferDirection } from './types.js';
/**
 * An `Error` carrying a raw code, for the mappers below.
 *
 * The callers that need this are places where we know the *semantics* (a missing
 * path, an invalid argument) but must funnel it through the same
 * code-detection as an error thrown by ssh2 or `node:fs` — so a plain object
 * literal would be a lie and a cast would hide the shape.
 */
export declare function codedError(code: number | string, message: string): Error & {
    code: number | string;
};
export interface SftpErrorContext {
    /** Short operation label for `details.op` (`'stat'`, `'remove'`, `'upload'`, …). */
    op?: string;
    path?: string;
    local?: boolean;
    /** Set on transfer failures: the offset a retry could resume from. */
    resumedFrom?: number;
    cause?: unknown;
}
/** `true` for the `AbortSignal` rejection shape and for our own cancel code. */
export declare function isAbortError(error: unknown): boolean;
/**
 * `true` when an error is transport-level rather than a statement about the
 * request itself.
 *
 * ssh2 answers "No response from server" — with **no code**, so it lands on
 * `SSH_UNKNOWN` — when a channel closes with requests still pending. The caller
 * needs that classified as a link loss: it decides whether a resume is offered
 * and whether a retry is worth attempting. This is the exact shape the real-host
 * 100 MiB run produced, so the test is shared by the mapper and the engine.
 */
export declare function isLinkClassCode(code: string, message: string): boolean;
/**
 * Normalize any thrown value into the ICD error vocabulary.
 *
 * Unmapped numeric codes fall back to `SSH_SFTP_PROTOCOL`, unmapped Node codes
 * to `SSH_UNKNOWN`: a wrong-but-specific guess is worse than an honest fallback,
 * and every path carries the raw code plus the original message in `details`
 * (the wire `message` stays user-facing).
 */
export declare function toSftpError(error: unknown, context?: SftpErrorContext): SshError;
export interface AbortDetails {
    opId: string;
    direction: TransferDirection;
    localPath: string;
    remotePath: string;
    resumedFrom: number;
    transferred: number;
    totalBytes?: number;
    /** The individual file in flight when a directory transfer stopped. */
    entry?: string;
    /**
     * Present only when the resume is **not** safe: set to `false` by the engine
     * when the destination could not be cut back to its known-good prefix (a
     * dropped connection), together with `resumeHint` telling the caller to restart
     * the file instead of resuming it.
     */
    resumable?: boolean;
    resumeHint?: string;
}
/**
 * A transfer that stopped mid-flight, with the offset a retry can resume from.
 *
 * `SSH_SFTP_TRANSFER_ABORTED` is `retryable` in the ICD table precisely so the
 * UI can offer "resume": the offset is the durable byte boundary of the
 * destination, so no byte has to be sent twice and none is skipped. When the
 * engine cannot guarantee that boundary it says so here (`resumable: false` +
 * `resumeHint`) rather than letting the retry skip a hole.
 */
export declare function abortedTransfer(details: AbortDetails, cause?: unknown): SshError;
/** User cancellation before any byte moved: nothing to resume. */
export declare function cancelledTransfer(details: Omit<AbortDetails, 'resumedFrom' | 'transferred'>, cause?: unknown): SshError;
/** Target exists and `overwrite: false` (ICD §4.5: the UI re-asks, then resends). */
export declare function targetExists(details: {
    path: string;
    remoteSize: number;
    localSize: number;
    direction: TransferDirection;
    resumable: boolean;
}): SshError;
/**
 * Post-transfer verification failed (ICD §4.5: `verify` did not match).
 *
 * `mode` says which check failed, and the digests are present only when they
 * were actually computed: a `size+mtime` failure that reported empty sha256
 * fields would look like a digest mismatch to whoever reads the log.
 */
export declare function verifyMismatch(details: {
    mode: 'size+mtime' | 'sha256';
    localPath: string;
    remotePath: string;
    localSize: number;
    remoteSize: number;
    localSha256?: string;
    remoteSha256?: string;
}): SshError;
/** A local path that cannot be read or written. */
export declare function localDenied(path: string, message: string, extra?: Record<string, unknown>): SshError;
/** Raised when a session id does not resolve to a live session. */
export declare function noSuchSession(sessionId: string): SshError;
/** Raised when an op id is unknown to the manager. */
export declare function noSuchTransfer(opId: string): SshError;
/** Wire projection used by the manager when a task ends in failure. */
export declare function errorInfoOf(error: unknown, context?: SftpErrorContext): ErrorInfo;
//# sourceMappingURL=errors.d.ts.map