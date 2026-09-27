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
export const systemTimers = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => {
        clearTimeout(handle);
    },
};
/** Default wait after SIGKILL for the transport to report the exit. */
export const DEFAULT_SETTLE_MS = 1000;
export class KillEscalator {
    timers;
    timeoutMs;
    graceKillMs;
    settleMs;
    onSignal;
    onCancel;
    onForceSettle;
    onPhase;
    deadlineHandle;
    graceHandle;
    settleHandle;
    phaseValue = 'idle';
    causeValue;
    signalValue;
    signalErrors = [];
    constructor(options) {
        this.timers = options.timers ?? systemTimers;
        this.timeoutMs = Math.max(0, Math.trunc(options.timeoutMs ?? 0));
        this.graceKillMs = Math.max(0, Math.trunc(options.graceKillMs));
        this.settleMs = Math.max(0, Math.trunc(options.settleMs ?? DEFAULT_SETTLE_MS));
        this.onSignal = options.onSignal;
        this.onCancel = options.onCancel;
        this.onForceSettle = options.onForceSettle;
        this.onPhase = options.onPhase;
    }
    get phase() {
        return this.phaseValue;
    }
    /** Undefined until a timeout or an explicit cancel actually fired. */
    get cause() {
        return this.causeValue;
    }
    /** The last signal that was sent, if any. */
    get lastSignal() {
        return this.signalValue;
    }
    /** Signals that threw; empty in normal operation. */
    get errors() {
        return this.signalErrors;
    }
    /** Arm the deadline. No-op when `timeoutMs` is 0 (interactive streams). */
    start() {
        if (this.phaseValue !== 'idle' || this.timeoutMs <= 0)
            return;
        this.deadlineHandle = this.timers.setTimeout(() => this.onDeadline(), this.timeoutMs);
    }
    /**
     * The caller cancelled: ask the channel to stop, then keep the same SIGKILL
     * escalation so a command that ignores a polite close cannot pin the stream.
     */
    cancel() {
        if (this.phaseValue === 'done')
            return;
        this.causeValue = this.causeValue ?? 'cancelled';
        this.phaseValue = 'term-sent';
        this.onPhase?.(this.phaseValue, this.causeValue, undefined);
        // Arm before signalling: `onCancel` may settle the channel synchronously, and
        // a timer armed after that would outlive the escalation it belongs to.
        this.scheduleGrace();
        try {
            this.onCancel?.();
        }
        catch (error) {
            this.signalErrors.push(messageOf(error));
        }
    }
    /** The command exited on its own; disarm every timer. */
    settle() {
        if (this.phaseValue === 'done')
            return;
        this.clearAll();
        this.phaseValue = 'done';
        this.onPhase?.(this.phaseValue, this.causeValue, this.signalValue);
    }
    /** Whether the terminal state has been reached. */
    get settled() {
        return this.phaseValue === 'done';
    }
    onDeadline() {
        if (this.phaseValue === 'done')
            return;
        this.causeValue = this.causeValue ?? 'timeout';
        this.phaseValue = 'term-sent';
        // Arm the grace timer before SIGTERM: a channel that dies on the signal
        // settles the escalation from inside `send()`, and a timer armed afterwards
        // would then be the one thing still holding the event loop open.
        this.scheduleGrace();
        this.send('TERM');
    }
    scheduleGrace() {
        this.graceHandle = this.timers.setTimeout(() => this.onGrace(), this.graceKillMs);
    }
    onGrace() {
        if (this.phaseValue === 'done')
            return;
        this.phaseValue = 'kill-sent';
        this.settleHandle = this.timers.setTimeout(() => this.onSettleDeadline(), this.settleMs);
        this.send('KILL');
    }
    onSettleDeadline() {
        if (this.phaseValue === 'done')
            return;
        this.phaseValue = 'done';
        this.clearAll();
        this.onPhase?.(this.phaseValue, this.causeValue, this.signalValue);
        try {
            this.onForceSettle();
        }
        catch (error) {
            this.signalErrors.push(messageOf(error));
        }
    }
    send(signal) {
        this.signalValue = signal;
        try {
            this.onSignal(signal);
        }
        catch (error) {
            this.signalErrors.push(messageOf(error));
        }
        this.onPhase?.(this.phaseValue, this.causeValue, signal);
    }
    clearAll() {
        for (const handle of [this.deadlineHandle, this.graceHandle, this.settleHandle]) {
            if (handle !== undefined)
                this.timers.clearTimeout(handle);
        }
        this.deadlineHandle = undefined;
        this.graceHandle = undefined;
        this.settleHandle = undefined;
    }
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=timeout.js.map