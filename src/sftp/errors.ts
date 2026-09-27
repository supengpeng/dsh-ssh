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

import { SshError } from '../protocol.js'
import type { ErrorInfo } from '../protocol.js'

import type { TransferDirection } from './types.js'

/**
 * An `Error` carrying a raw code, for the mappers below.
 *
 * The callers that need this are places where we know the *semantics* (a missing
 * path, an invalid argument) but must funnel it through the same
 * code-detection as an error thrown by ssh2 or `node:fs` — so a plain object
 * literal would be a lie and a cast would hide the shape.
 */
export function codedError(code: number | string, message: string): Error & { code: number | string } {
  const error = new Error(message) as Error & { code: number | string }
  error.code = code
  return error
}

export interface SftpErrorContext {
  /** Short operation label for `details.op` (`'stat'`, `'remove'`, `'upload'`, …). */
  op?: string
  path?: string
  local?: boolean
  /** Set on transfer failures: the offset a retry could resume from. */
  resumedFrom?: number
  cause?: unknown
}

/** Numeric SFTP status codes (ssh2 speaks protocol v3: 0-8). */
const SFTP_STATUS: Record<number, string> = {
  1: 'EOF',
  2: 'NO_SUCH_FILE',
  3: 'PERMISSION_DENIED',
  4: 'FAILURE',
  5: 'BAD_MESSAGE',
  6: 'NO_CONNECTION',
  7: 'CONNECTION_LOST',
  8: 'OP_UNSUPPORTED',
}

/** Node filesystem error codes the transfer layer can actually meet. */
const NODE_CODES: Record<string, string> = {
  ENOENT: 'SSH_SFTP_NO_SUCH_FILE',
  ENOTDIR: 'SSH_SFTP_NO_SUCH_FILE',
  EACCES: 'SSH_PERM_DENIED',
  EPERM: 'SSH_PERM_DENIED',
  EROFS: 'SSH_PERM_DENIED',
  EISDIR: 'SSH_SFTP_IS_A_DIRECTORY',
  ENOSPC: 'SSH_SFTP_DISK_FULL',
  EDQUOT: 'SSH_SFTP_DISK_FULL',
  EBUSY: 'SSH_PERM_DENIED',
  EMFILE: 'SSH_LIMIT_QUEUE_FULL',
  ENFILE: 'SSH_LIMIT_QUEUE_FULL',
  EEXIST: 'SSH_SFTP_TARGET_EXISTS',
  // `ELOOP` is what the recursion guard raises when a tree exceeds
  // `sftp.followSymlinks`'s depth budget: a configured limit, so the ICD code is
  // the configuration one rather than an invented "too deep" code.
  ELOOP: 'SSH_CFG_INVALID',
}

interface RawError {
  code?: unknown
  message?: unknown
  name?: unknown
}

function rawOf(error: unknown): RawError {
  if (error !== null && typeof error === 'object') return error as RawError
  return { message: String(error) }
}

/** `true` for the `AbortSignal` rejection shape and for our own cancel code. */
export function isAbortError(error: unknown): boolean {
  if (error instanceof SshError) return error.code === 'SSH_CANCELLED' || error.code === 'SSH_SFTP_TRANSFER_ABORTED'
  const raw = rawOf(error)
  return raw.name === 'AbortError' || raw.code === 'ABORT_ERR'
}

function withDetails(code: string, message: string, context: SftpErrorContext | undefined, extra?: Record<string, unknown>): SshError {
  const details: Record<string, unknown> = {}
  if (context?.op !== undefined) details['op'] = context.op
  if (context?.path !== undefined) details['path'] = context.path
  if (context?.local === true) details['side'] = 'local'
  if (context?.resumedFrom !== undefined) details['resumedFrom'] = context.resumedFrom
  if (extra !== undefined) Object.assign(details, extra)
  return new SshError(code, message, {
    details: Object.keys(details).length > 0 ? details : undefined,
    cause: context?.cause,
  })
}

/** Text heuristics for a bare SFTP `FAILURE (4)`, whose code carries no detail. */
function codeFromFailureText(text: string): string {
  const message = text.toLowerCase()
  if (/no space|quota|disk full|insufficient storage/.test(message)) return 'SSH_SFTP_DISK_FULL'
  if (/permission denied|read-only|write protect|not permitted/.test(message)) return 'SSH_PERM_DENIED'
  if (/file exists|already exists/.test(message)) return 'SSH_SFTP_TARGET_EXISTS'
  if (/is a directory/.test(message)) return 'SSH_SFTP_IS_A_DIRECTORY'
  if (/no such file|not found|does not exist/.test(message)) return 'SSH_SFTP_NO_SUCH_FILE'
  if (/broken pipe|connection (lost|reset|closed)|econnreset|epipe/.test(message)) return 'SSH_NET_RESET'
  if (/timed? ?out|timeout/.test(message)) return 'SSH_NET_TIMEOUT'
  if (/too many open files|resource exhausted/.test(message)) return 'SSH_LIMIT_QUEUE_FULL'
  return 'SSH_SFTP_PROTOCOL'
}

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
export function isLinkClassCode(code: string, message: string): boolean {
  if (code !== 'SSH_UNKNOWN') return false
  return /no response|connection (?:lost|closed|reset)|socket hang ?up|broken pipe|econnreset|epipe|timed? ?out/i.test(
    message,
  )
}

/**
 * Normalize any thrown value into the ICD error vocabulary.
 *
 * Unmapped numeric codes fall back to `SSH_SFTP_PROTOCOL`, unmapped Node codes
 * to `SSH_UNKNOWN`: a wrong-but-specific guess is worse than an honest fallback,
 * and every path carries the raw code plus the original message in `details`
 * (the wire `message` stays user-facing).
 */
export function toSftpError(error: unknown, context: SftpErrorContext = {}): SshError {
  if (error instanceof SshError) {
    if (context.resumedFrom === undefined) return error
    return withDetails(error.code, error.message, context, { resumedFrom: context.resumedFrom })
  }
  const raw = rawOf(error)
  const message = typeof raw.message === 'string' && raw.message.length > 0 ? raw.message : String(error)
  const code = raw.code

  if (typeof code === 'number') {
    if (code === 2) return withDetails('SSH_SFTP_NO_SUCH_FILE', message, context)
    if (code === 3) return withDetails(context.local === true ? 'SSH_PERM_LOCAL_DENIED' : 'SSH_PERM_DENIED', message, context)
    if (code === 6 || code === 7) return withDetails('SSH_NET_RESET', message, context)
    if (code === 8) return withDetails('SSH_SFTP_PROTOCOL', message, context)
    const mapped = codeFromFailureText(message)
    return withDetails(mapped, message, context, { sftpStatus: code, sftpStatusName: SFTP_STATUS[code] ?? 'UNKNOWN' })
  }

  if (typeof code === 'string') {
    const upper = code.toUpperCase()
    const mapped = NODE_CODES[upper]
    if (mapped !== undefined) {
      const localCode = context.local === true && mapped === 'SSH_PERM_DENIED' ? 'SSH_PERM_LOCAL_DENIED' : mapped
      return withDetails(localCode, message, context, { errno: code })
    }
    if (upper === 'ABORT_ERR') return withDetails('SSH_SFTP_TRANSFER_ABORTED', message, context)
    if (upper === 'ERR_STREAM_DESTROYED' || upper === 'ERR_STREAM_PREMATURE_CLOSE') {
      return withDetails('SSH_SFTP_TRANSFER_ABORTED', message, context)
    }
    return withDetails('SSH_UNKNOWN', message, context, { errno: code })
  }

  return withDetails('SSH_UNKNOWN', message, context)
}

// ---------------------------------------------------------------------------
// Constructors for the codes this module raises itself
// ---------------------------------------------------------------------------

export interface AbortDetails {
  opId: string
  direction: TransferDirection
  localPath: string
  remotePath: string
  resumedFrom: number
  transferred: number
  totalBytes?: number
  /** The individual file in flight when a directory transfer stopped. */
  entry?: string
  /**
   * Present only when the resume is **not** safe: set to `false` by the engine
   * when the destination could not be cut back to its known-good prefix (a
   * dropped connection), together with `resumeHint` telling the caller to restart
   * the file instead of resuming it.
   */
  resumable?: boolean
  resumeHint?: string
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
export function abortedTransfer(details: AbortDetails, cause?: unknown): SshError {
  return new SshError('SSH_SFTP_TRANSFER_ABORTED', 'the transfer was aborted; it can be resumed from the reported offset', {
    details: { ...details, resumable: details.resumable ?? true },
    cause,
  })
}

/** User cancellation before any byte moved: nothing to resume. */
export function cancelledTransfer(details: Omit<AbortDetails, 'resumedFrom' | 'transferred'>, cause?: unknown): SshError {
  return new SshError('SSH_CANCELLED', 'the transfer was cancelled', { details: { ...details, resumable: false }, cause })
}

/** Target exists and `overwrite: false` (ICD §4.5: the UI re-asks, then resends). */
export function targetExists(details: {
  path: string
  remoteSize: number
  localSize: number
  direction: TransferDirection
  resumable: boolean
}): SshError {
  return new SshError('SSH_SFTP_TARGET_EXISTS', `the destination already exists: ${details.path}`, {
    details: { ...details, overwrite: false },
  })
}

/**
 * Post-transfer verification failed (ICD §4.5: `verify` did not match).
 *
 * `mode` says which check failed, and the digests are present only when they
 * were actually computed: a `size+mtime` failure that reported empty sha256
 * fields would look like a digest mismatch to whoever reads the log.
 */
export function verifyMismatch(details: {
  mode: 'size+mtime' | 'sha256'
  localPath: string
  remotePath: string
  localSize: number
  remoteSize: number
  localSha256?: string
  remoteSha256?: string
}): SshError {
  const message =
    details.mode === 'sha256'
      ? 'the transferred file does not match its source (sha256)'
      : 'the transferred file does not match its source (size)'
  return new SshError('SSH_SFTP_VERIFY_MISMATCH', message, { details: { ...details } })
}

/** A local path that cannot be read or written. */
export function localDenied(path: string, message: string, extra?: Record<string, unknown>): SshError {
  return new SshError('SSH_PERM_LOCAL_DENIED', message, { details: { path, side: 'local', ...extra } })
}

/** Raised when a session id does not resolve to a live session. */
export function noSuchSession(sessionId: string): SshError {
  return new SshError('SSH_STATE_INVALID', `no live session with id "${sessionId}"`, { details: { sessionId } })
}

/** Raised when an op id is unknown to the manager. */
export function noSuchTransfer(opId: string): SshError {
  return new SshError('SSH_STATE_INVALID', `no active transfer with id "${opId}"`, { details: { opId } })
}

/** Wire projection used by the manager when a task ends in failure. */
export function errorInfoOf(error: unknown, context: SftpErrorContext = {}): ErrorInfo {
  return toSftpError(error, context).toErrorInfo()
}
