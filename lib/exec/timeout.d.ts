/**
 * Timeout escalation and cancellation (ICD §4.4).
 *
 *     at timeoutMs          → SIGTERM
 *     + graceKillMs         → SIGKILL
 *     + settleMs            → give up waiting for the peer's exit event
 *     → exit{timedOut:true} + end{reason:'timeout'}
 *
 * The escalation is timer-driven, so it takes its clock from an injectable
 * {@link Timers}. Unit tests drive it with a manual clock and assert the exact
 * TERM → KILL → settle order instead of sleeping; production uses the globals.
 *
 * A signal that throws (channel already gone) is recorded and ignored: the
 * escalation must still reach its terminal state, because that is what releases
 * the stream, the caller's promise and the frame replay buffer.
 */
import type { SshSignal } from './types.js';
/** Minimal timer surface, so tests can own the clock. */
export interface Timers {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}
export declare const systemTimers: Timers;
export type EscalationPhase = 'idle' | 'term-sent' | 'kill-sent' | 'done';
/** Why the escalation reached its terminal state. */
export type EscalationCause = 'timeout' | 'cancelled';
export interface KillEscalatorOptions {
    /** Deadline before SIGTERM; 0/undefined disables the deadline (interactive shell). */
    timeoutMs?: number;
    graceKillMs: number;
    /** How long to wait for the peer's exit event after SIGKILL before forcing the stream closed. */
    settleMs?: number;
    onSignal: (signal: SshSignal) => void;
    /** Called instead of SIGTERM when the caller cancels explicitly. */
    onCancel?: () => void;
    /** The peer never reported an exit; the owner must terminate the stream anyway. */
    onForceSettle: () => void;
    onPhase?: (phase: EscalationPhase, cause: EscalationCause | undefined, signal: SshSignal | undefined) => void;
    timers?: Timers;
}
/** Default wait after SIGKILL for the transport to report the exit. */
export declare const DEFAULT_SETTLE_MS = 1000;
export declare class KillEscalator {
    private readonly timers;
    private readonly timeoutMs;
    private readonly graceKillMs;
    private readonly settleMs;
    private readonly onSignal;
    private readonly onCancel;
    private readonly onForceSettle;
    private readonly onPhase;
    private deadlineHandle;
    private graceHandle;
    private settleHandle;
    private phaseValue;
    private causeValue;
    private signalValue;
    private readonly signalErrors;
    constructor(options: KillEscalatorOptions);
    get phase(): EscalationPhase;
    /** Undefined until a timeout or an explicit cancel actually fired. */
    get cause(): EscalationCause | undefined;
    /** The last signal that was sent, if any. */
    get lastSignal(): SshSignal | undefined;
    /** Signals that threw; empty in normal operation. */
    get errors(): readonly string[];
    /** Arm the deadline. No-op when `timeoutMs` is 0 (interactive streams). */
    start(): void;
    /**
     * The caller cancelled: ask the channel to stop, then keep the same SIGKILL
     * escalation so a command that ignores a polite close cannot pin the stream.
     */
    cancel(): void;
    /** The command exited on its own; disarm every timer. */
    settle(): void;
    /** Whether the terminal state has been reached. */
    get settled(): boolean;
    private onDeadline;
    private scheduleGrace;
    private onGrace;
    private onSettleDeadline;
    private send;
    private clearAll;
}
//# sourceMappingURL=timeout.d.ts.map