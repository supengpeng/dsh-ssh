/**
 * Compile-time proof that the exec layer and the connection layer agree.
 *
 * `src/exec/**` declares structural mirrors of ICD §7.1 (see `types.ts`) so it
 * can be developed and tested against fakes without importing SP1's module. That
 * freedom has one failure mode: the two declarations could drift apart and only
 * fail at runtime, inside a running SSH session.
 *
 * This module closes that hole. Every check is a type alias that resolves to
 * `never` — and therefore fails `tsc -p .` — the moment a signature stops being
 * mutually assignable. The checks are **per member**, not whole-interface, so the
 * failing alias names the exact property that drifted (a whole-interface check
 * only says "false").
 *
 * This has already paid for itself: it caught ICD v1.0.4's `ExecHandle.endInput()`
 * being added to SP1's interface while this mirror still lacked it.
 *
 * There is no runtime body; the values are exported only so the module is not
 * elided from the program.
 */
import type { ExecExit, ExecHandle, ExecRequest, SessionHandle, ShellHandle, ShellRequest } from '../connection/types.js';
import type { ExecHandleLike, ExecExitEvent, ExecRequestLike, SessionHandleLike, ShellHandleLike, ShellRequestLike } from './types.js';
/** Resolves to `never` (a compile error here) unless the condition holds. */
type Expect<T extends true> = T;
/** True only when `A` and `B` are assignable in both directions. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** True when `From` may be used wherever `To` is expected (one-way, for subsets). */
type Assignable<From, To> = [From] extends [To] ? true : false;
/** The type of `T`'s member `K`, or `never` when the member does not exist. */
type Member<T, K extends PropertyKey> = K extends keyof T ? T[K] : never;
export type ExecHandleStreamId = Expect<Same<Member<ExecHandleLike, 'streamId'>, Member<ExecHandle, 'streamId'>>>;
export type ExecHandleOnData = Expect<Same<Member<ExecHandleLike, 'onData'>, Member<ExecHandle, 'onData'>>>;
export type ExecHandleOnExit = Expect<Same<Member<ExecHandleLike, 'onExit'>, Member<ExecHandle, 'onExit'>>>;
export type ExecHandleWrite = Expect<Same<Member<ExecHandleLike, 'write'>, Member<ExecHandle, 'write'>>>;
export type ExecHandleEndInput = Expect<Same<Member<ExecHandleLike, 'endInput'>, Member<ExecHandle, 'endInput'>>>;
export type ExecHandleSignal = Expect<Same<Member<ExecHandleLike, 'signal'>, Member<ExecHandle, 'signal'>>>;
export type ExecHandleCancel = Expect<Same<Member<ExecHandleLike, 'cancel'>, Member<ExecHandle, 'cancel'>>>;
export type ShellHandleResize = Expect<Same<Member<ShellHandleLike, 'resize'>, Member<ShellHandle, 'resize'>>>;
export type ExecRequestCommand = Expect<Same<Member<ExecRequestLike, 'command'>, Member<ExecRequest, 'command'>>>;
export type ExecRequestCwd = Expect<Same<Member<ExecRequestLike, 'cwd'>, Member<ExecRequest, 'cwd'>>>;
export type ExecRequestEnv = Expect<Same<Member<ExecRequestLike, 'env'>, Member<ExecRequest, 'env'>>>;
export type ExecRequestTimeout = Expect<Same<Member<ExecRequestLike, 'timeoutMs'>, Member<ExecRequest, 'timeoutMs'>>>;
export type ExecRequestMaxOutput = Expect<Same<Member<ExecRequestLike, 'maxOutputBytes'>, Member<ExecRequest, 'maxOutputBytes'>>>;
export type ExecRequestPty = Expect<Same<Member<ExecRequestLike, 'pty'>, Member<ExecRequest, 'pty'>>>;
export type ExecRequestCols = Expect<Same<Member<ExecRequestLike, 'cols'>, Member<ExecRequest, 'cols'>>>;
export type ExecRequestRows = Expect<Same<Member<ExecRequestLike, 'rows'>, Member<ExecRequest, 'rows'>>>;
export type ExecRequestTerm = Expect<Same<Member<ExecRequestLike, 'term'>, Member<ExecRequest, 'term'>>>;
export type ShellRequestCols = Expect<Same<Member<ShellRequestLike, 'cols'>, Member<ShellRequest, 'cols'>>>;
export type ShellRequestRows = Expect<Same<Member<ShellRequestLike, 'rows'>, Member<ShellRequest, 'rows'>>>;
export type ShellRequestTerm = Expect<Same<Member<ShellRequestLike, 'term'>, Member<ShellRequest, 'term'>>>;
export type ShellRequestCwd = Expect<Same<Member<ShellRequestLike, 'cwd'>, Member<ShellRequest, 'cwd'>>>;
export type ShellRequestEnv = Expect<Same<Member<ShellRequestLike, 'env'>, Member<ShellRequest, 'env'>>>;
export type ShellRequestHasNoCommand = Expect<Same<Member<ShellRequest, 'command'>, never>>;
export type ShellRequestHasNoPty = Expect<Same<Member<ShellRequest, 'pty'>, never>>;
export type SessionId = Expect<Same<Member<SessionHandleLike, 'id'>, Member<SessionHandle, 'id'>>>;
/**
 * `info` and `state` are asserted **one way only**, and that is the honest
 * relation: `SessionInfoLike` is deliberately a readable subset (every field
 * optional) so the exec layer does not pin the whole session projection. What
 * must hold is that the real session satisfies the subset — requiring equality
 * here would forbid SP1 from ever adding a field, which is not the contract.
 */
export type SessionInfoIsReadable = Expect<Assignable<NonNullable<Member<SessionHandle, 'info'>>, NonNullable<Member<SessionHandleLike, 'info'>>>>;
export type SessionStateIsReadable = Expect<Assignable<NonNullable<Member<SessionHandle, 'state'>>, NonNullable<Member<SessionHandleLike, 'state'>>>>;
export type SessionExec = Expect<Same<Member<SessionHandleLike, 'exec'>, Member<SessionHandle, 'exec'>>>;
export type SessionShell = Expect<Same<Member<SessionHandleLike, 'shell'>, Member<SessionHandle, 'shell'>>>;
export type ExecExitMatches = Expect<Same<ExecExitEvent, ExecExit>>;
export type ExecExitCode = Expect<Same<Member<ExecExitEvent, 'code'>, Member<ExecExit, 'code'>>>;
export type ExecExitSignal = Expect<Same<Member<ExecExitEvent, 'signal'>, Member<ExecExit, 'signal'>>>;
export type ExecExitDuration = Expect<Same<Member<ExecExitEvent, 'durationMs'>, Member<ExecExit, 'durationMs'>>>;
export type ExecExitTimedOut = Expect<Same<Member<ExecExitEvent, 'timedOut'>, Member<ExecExit, 'timedOut'>>>;
/** Exported so the module is not elided; the value never runs. */
export declare const COMPAT_CHECKS = true;
export {};
//# sourceMappingURL=compat.d.ts.map