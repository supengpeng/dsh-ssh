/**
 * Public barrel of the connection module.
 *
 * Consumers (the Lead's `src/api/**`, SP2, SP3, SP8) import from here so the
 * file layout inside `src/connection/**` stays an implementation detail:
 *
 *     import { createConnectionPool, type SessionHandle, SshError } from './connection/index.js'
 */
export { ConnectionPoolImpl, createConnectionPool, effectiveRetries, profileKey, retryableForConnect, validateProfile, } from './pool.js';
export { SshSession } from './session.js';
export type { SessionDeps, SessionDialOptions, SessionOptions } from './session.js';
export { ChannelHandle, isExecHandle } from './channel.js';
export { maskedSecret, parsePrivateKey, planAuth, resolveAgentSource, resolveProfileSecrets } from './auth.js';
export type { AuthConfig, AuthPlan, PlanAuthOptions } from './auth.js';
export { classifyError, CONNECTION_ERROR_CODES, errorMessage, isAbortError, readHostKeyType } from './errors.js';
export type { ClassifiedError, ClassifyContext } from './errors.js';
export { backoffDelay, defaultSleep, withRetry } from './retry.js';
export type { RetryAttemptInfo, RetryOptions } from './retry.js';
export { assertTransition, canTransition, SESSION_STATES, SessionStateMachine } from './state.js';
export type { StateChange, StateListener } from './state.js';
export { DEFAULT_REDACT_KEYS, scanForSecrets, stripSecrets } from './scrub.js';
export { OperationLimiter } from './semaphore.js';
export type { ReleaseSlot } from './semaphore.js';
export { newOpId, newProfileId, newSessionId, newStreamId, ulid } from './ids.js';
export { closeReason, composeRemoteCommand, decideHostKey, DEFAULT_COLS, DEFAULT_ROWS, DEFAULT_TERM, effectiveTimeouts, openTransport, shellQuote, sshFingerprint, } from './transport.js';
export type { ExecChannelOptions, HostKeyDecision, ShellChannelOptions, Transport, TransportOpenOptions, } from './transport.js';
export * from './types.js';
//# sourceMappingURL=index.d.ts.map