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
import type { AuthKind, SshErrorCode } from '../protocol.js';
import { SshError } from '../protocol.js';
/** Every code this module is able to raise. */
export declare const CONNECTION_ERROR_CODES: readonly SshErrorCode[];
export interface ClassifiedError {
    code: SshErrorCode;
    message: string;
    details?: Record<string, unknown>;
    /** Original cause, kept off the wire (it may hold host objects). */
    cause?: unknown;
}
export interface ClassifyContext {
    /** `connect` = dialling/handshake/auth; `runtime` = an established connection. */
    phase: 'connect' | 'runtime';
    /** Selected authentication method, used to sharpen auth failures. */
    auth?: AuthKind;
    /** Set when our host-key verifier already rejected the key. */
    hostKeyError?: SshError | undefined;
    host?: string;
    port?: number;
}
/** Message of any thrown value, without assuming it is an `Error`. */
export declare function errorMessage(error: unknown): string;
/** True for the `AbortError` shape `AbortSignal` produces (Node and DOM alike). */
export declare function isAbortError(error: unknown): boolean;
/**
 * Classify a transport-level failure.
 *
 * Precedence: an error we raised ourselves → a stashed host-key rejection →
 * the socket errno → the `ssh2` `error.level` → the message text → a documented
 * fallback. The order matters: errno is the most specific fact available, while
 * `level` is ssh2's coarse phase marker.
 */
export declare function classifyError(error: unknown, context: ClassifyContext): ClassifiedError;
/**
 * SSH host key blob → algorithm name.
 *
 * The blob is `string key-type || key material` (RFC 4253 §6.6); `hostVerifier`
 * receives it without the algorithm name, and both `known_hosts` matching and the
 * `SHA256:` fingerprint need it.
 */
export declare function readHostKeyType(blob: Buffer): string;
//# sourceMappingURL=errors.d.ts.map