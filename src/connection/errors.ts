/**
 * Failure classification: every error the connection layer can observe (a raw
 * `ssh2` error, a socket errno, an aborted signal, an unexpected throw) is turned
 * into a *code from the ICD §5 table* plus wire-safe details.
 *
 * Two rules the rest of the module relies on:
 *   1. never invent a code — `CONNECTION_ERROR_CODES` is asserted against
 *      `protocol.ERROR_CODES` by `test/unit/connection-errors.test.mjs`;
 *   2. never put a credential in a message or in `details`.
 *
 * `classifyError` returns a plain descriptor rather than an `SshError` so the
 * caller can run one redaction pass over the details before constructing the
 * error object that crosses the wire.
 */

import type { AuthKind, SshErrorCode } from '../protocol.js'
import { SshError } from '../protocol.js'

/** Every code this module is able to raise. */
export const CONNECTION_ERROR_CODES: readonly SshErrorCode[] = [
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
  'SSH_SFTP_PROTOCOL',
  'SSH_LIMIT_POOL_EXHAUSTED',
  'SSH_CFG_INVALID',
  'SSH_STATE_INVALID',
  'SSH_CANCELLED',
  'SSH_UNKNOWN',
]

export interface ClassifiedError {
  code: SshErrorCode
  message: string
  details?: Record<string, unknown>
  /** Original cause, kept off the wire (it may hold host objects). */
  cause?: unknown
}

export interface ClassifyContext {
  /** `connect` = dialling/handshake/auth; `runtime` = an established connection. */
  phase: 'connect' | 'runtime'
  /** Selected authentication method, used to sharpen auth failures. */
  auth?: AuthKind
  /** Set when our host-key verifier already rejected the key. */
  hostKeyError?: SshError | undefined
  host?: string
  port?: number
}

interface ErrorLike {
  message?: unknown
  code?: unknown
  level?: unknown
  errno?: unknown
  syscall?: unknown
}

function errorLike(error: unknown): ErrorLike {
  if (error !== null && typeof error === 'object') return error as ErrorLike
  return { message: String(error) }
}

/** Message of any thrown value, without assuming it is an `Error`. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error !== null && typeof error === 'object') {
    const message = (error as ErrorLike).message
    if (typeof message === 'string') return message
  }
  return String(error)
}

/** True for the `AbortError` shape `AbortSignal` produces (Node and DOM alike). */
export function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return true
  const like = errorLike(error)
  return like.code === 'ABORT_ERR' || like.errno === 'ABORT_ERR'
}

/** Socket errno → ICD code. Only errnos with an unambiguous mapping appear here. */
const ERRNO_CODES: Readonly<Record<string, SshErrorCode>> = {
  ECONNREFUSED: 'SSH_NET_REFUSED',
  EHOSTUNREACH: 'SSH_NET_UNREACHABLE',
  ENETUNREACH: 'SSH_NET_UNREACHABLE',
  ENETDOWN: 'SSH_NET_UNREACHABLE',
  EHOSTDOWN: 'SSH_NET_UNREACHABLE',
  EADDRNOTAVAIL: 'SSH_NET_UNREACHABLE',
  ENOTFOUND: 'SSH_NET_DNS',
  EAI_AGAIN: 'SSH_NET_DNS',
  EAI_FAIL: 'SSH_NET_DNS',
  EAI_NODATA: 'SSH_NET_DNS',
  ECONNRESET: 'SSH_NET_RESET',
  ECONNABORTED: 'SSH_NET_RESET',
  ENETRESET: 'SSH_NET_RESET',
  EPIPE: 'SSH_NET_RESET',
  ETIMEDOUT: 'SSH_NET_TIMEOUT',
}

function authFailure(code: SshErrorCode | undefined, auth: AuthKind | undefined, message: string): SshErrorCode {
  // A rejected/missing passphrase is reported by ssh2 inside a generic auth error.
  if (/passphrase/i.test(message) || /encrypted private key|encrypted private openssh key/i.test(message)) {
    return 'SSH_AUTH_PASSPHRASE_REQUIRED'
  }
  if (
    /cannot parse privatekey|private key.*(invalid|malformed|unreadable)|unsupported key (format|type)|invalid key|no such file|enoent/i.test(
      message,
    )
  ) {
    return 'SSH_AUTH_KEY_UNREADABLE'
  }
  if (code !== undefined) return code
  if (/no matching authentication method|no auth method|authentication method not allowed/i.test(message)) {
    return 'SSH_AUTH_METHOD_UNSUPPORTED'
  }
  if (auth === 'agent') return 'SSH_AUTH_AGENT_UNAVAILABLE'
  return 'SSH_AUTH_FAILED'
}

/**
 * Classify a transport-level failure.
 *
 * Precedence: an error we raised ourselves → a stashed host-key rejection →
 * the socket errno → the `ssh2` `error.level` → the message text → a documented
 * fallback. The order matters: errno is the most specific fact available, while
 * `level` is ssh2's coarse phase marker.
 */
export function classifyError(error: unknown, context: ClassifyContext): ClassifiedError {
  if (error instanceof SshError) {
    return { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: asDetails(error.details) }), cause: error }
  }
  if (isAbortError(error)) return { code: 'SSH_CANCELLED', message: 'operation cancelled', cause: error }

  const like = errorLike(error)
  const message = errorMessage(error)
  const level = typeof like.level === 'string' ? like.level : undefined
  const errno = typeof like.code === 'string' ? like.code : undefined
  const details: Record<string, unknown> = { phase: context.phase }
  if (context.host !== undefined) details.host = context.host
  if (context.port !== undefined) details.port = context.port
  if (level !== undefined) details.level = level
  if (errno !== undefined) details.errno = errno

  const withDetails = (code: SshErrorCode, text: string): ClassifiedError => ({ code, message: text, details, cause: error })

  // A host key we already judged: ssh2 only reports `Host denied (verification failed)`.
  if (context.hostKeyError !== undefined && /host denied|host verification|host key/i.test(message)) {
    return {
      code: context.hostKeyError.code,
      message: context.hostKeyError.message,
      details: {
        ...details,
        ...(context.hostKeyError.details !== undefined ? asDetails(context.hostKeyError.details) : {}),
      },
      cause: error,
    }
  }

  if (errno !== undefined) {
    const mapped = ERRNO_CODES[errno]
    if (mapped !== undefined) return withDetails(mapped, message === '' ? errno : `${message}`)
  }

  switch (level) {
    case 'client-dns':
      return withDetails('SSH_NET_DNS', 'host name could not be resolved')
    case 'agent':
      return withDetails('SSH_AUTH_AGENT_UNAVAILABLE', 'ssh-agent could not provide a usable key')
    case 'client-authentication':
      return withDetails(authFailure(undefined, context.auth, message), message)
    case 'client-timeout':
      if (/keepalive/i.test(message)) return withDetails('SSH_TIMEOUT_IDLE', 'connection declared dead after unanswered keepalives')
      return withDetails('SSH_TIMEOUT_CONNECT', 'timed out while establishing the SSH connection')
    case 'sftp-protocol':
      return withDetails('SSH_SFTP_PROTOCOL', message)
    default:
      break
  }

  if (/keepalive timeout/i.test(message)) {
    return withDetails('SSH_TIMEOUT_IDLE', 'connection declared dead after unanswered keepalives')
  }
  if (/timed out while waiting for (client )?handshake/i.test(message)) {
    return withDetails('SSH_TIMEOUT_CONNECT', 'timed out while establishing the SSH connection')
  }
  if (/all configured authentication methods failed/i.test(message)) {
    return withDetails(authFailure(undefined, context.auth, message), 'authentication failed')
  }
  if (/host denied \(verification failed\)|host verification failed/i.test(message)) {
    // Our verifier rejected the key but lost the reason (it threw instead of
    // returning a verdict): fail closed rather than trusting the host.
    return withDetails('SSH_HOSTKEY_MISMATCH', 'host key verification failed')
  }
  if (/agent/i.test(message) && context.auth === 'agent') {
    return withDetails('SSH_AUTH_AGENT_UNAVAILABLE', message)
  }
  if (/encrypted private key detected/i.test(message)) {
    return withDetails('SSH_AUTH_PASSPHRASE_REQUIRED', 'the private key is encrypted and no passphrase was supplied')
  }
  if (/no passphrase given|bad passphrase|integrity check failed/i.test(message)) {
    return withDetails('SSH_AUTH_PASSPHRASE_REQUIRED', 'the private key passphrase is missing or was rejected')
  }
  if (/unsupported key (format|type)/i.test(message)) {
    return withDetails('SSH_AUTH_KEY_UNREADABLE', 'the private key format is not supported')
  }
  if (/cannot parse privatekey|private key/i.test(message)) {
    return withDetails('SSH_AUTH_KEY_UNREADABLE', message)
  }
  if (/no matching (host key format|key exchange|kex|cipher|mac|compression)|handshake failed/i.test(message)) {
    return withDetails('SSH_UNKNOWN', 'no common SSH algorithm with the server')
  }
  if (/connection lost|socket closed|connection closed|eof/i.test(message)) {
    return withDetails('SSH_NET_RESET', 'the SSH connection was closed by the peer')
  }
  if (/channel open failure/i.test(message)) {
    // A channel that cannot be opened on a live transport is a protocol/state
    // problem the user can act on (unsupported subsystem, session limit, ...).
    return withDetails(context.phase === 'runtime' ? 'SSH_STATE_INVALID' : 'SSH_NET_RESET', message)
  }
  if (level === 'handshake' || level === 'protocol') {
    return withDetails(context.phase === 'connect' ? 'SSH_NET_RESET' : 'SSH_NET_RESET', message)
  }
  return withDetails('SSH_UNKNOWN', message === '' ? 'unknown SSH transport failure' : message)
}

function asDetails(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  return { value }
}

/**
 * SSH host key blob → algorithm name.
 *
 * The blob is `string key-type || key material` (RFC 4253 §6.6); `hostVerifier`
 * receives it without the algorithm name, and both `known_hosts` matching and the
 * `SHA256:` fingerprint need it.
 */
export function readHostKeyType(blob: Buffer): string {
  if (blob.length < 4) return 'unknown'
  const length = blob.readUInt32BE(0)
  if (length <= 0 || length > 64 || 4 + length > blob.length) return 'unknown'
  const name = blob.subarray(4, 4 + length).toString('ascii')
  return /^[\x20-\x7e]+$/.test(name) ? name : 'unknown'
}
