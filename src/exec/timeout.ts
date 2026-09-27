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

import type { SshSignal } from './types.js'

/** Minimal timer surface, so tests can own the clock. */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const systemTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

export type EscalationPhase = 'idle' | 'term-sent' | 'kill-sent' | 'done'

/** Why the escalation reached its terminal state. */
export type EscalationCause = 'timeout' | 'cancelled'

export interface KillEscalatorOptions {
  /** Deadline before SIGTERM; 0/undefined disables the deadline (interactive shell). */
  timeoutMs?: number
  graceKillMs: number
  /** How long to wait for the peer's exit event after SIGKILL before forcing the stream closed. */
  settleMs?: number
  onSignal: (signal: SshSignal) => void
  /** Called instead of SIGTERM when the caller cancels explicitly. */
  onCancel?: () => void
  /** The peer never reported an exit; the owner must terminate the stream anyway. */
  onForceSettle: () => void
  onPhase?: (phase: EscalationPhase, cause: EscalationCause | undefined, signal: SshSignal | undefined) => void
  timers?: Timers
}

/** Default wait after SIGKILL for the transport to report the exit. */
export const DEFAULT_SETTLE_MS = 1000

export class KillEscalator {
  private readonly timers: Timers
  private readonly timeoutMs: number
  private readonly graceKillMs: number
  private readonly settleMs: number
  private readonly onSignal: (signal: SshSignal) => void
  private readonly onCancel: (() => void) | undefined
  private readonly onForceSettle: () => void
  private readonly onPhase: KillEscalatorOptions['onPhase']

  private deadlineHandle: unknown
  private graceHandle: unknown
  private settleHandle: unknown
  private phaseValue: EscalationPhase = 'idle'
  private causeValue: EscalationCause | undefined
  private signalValue: SshSignal | undefined
  private readonly signalErrors: string[] = []

  constructor(options: KillEscalatorOptions) {
    this.timers = options.timers ?? systemTimers
    this.timeoutMs = Math.max(0, Math.trunc(options.timeoutMs ?? 0))
    this.graceKillMs = Math.max(0, Math.trunc(options.graceKillMs))
    this.settleMs = Math.max(0, Math.trunc(options.settleMs ?? DEFAULT_SETTLE_MS))
    this.onSignal = options.onSignal
    this.onCancel = options.onCancel
    this.onForceSettle = options.onForceSettle
    this.onPhase = options.onPhase
  }

  get phase(): EscalationPhase {
    return this.phaseValue
  }

  /** Undefined until a timeout or an explicit cancel actually fired. */
  get cause(): EscalationCause | undefined {
    return this.causeValue
  }

  /** The last signal that was sent, if any. */
  get lastSignal(): SshSignal | undefined {
    return this.signalValue
  }

  /** Signals that threw; empty in normal operation. */
  get errors(): readonly string[] {
    return this.signalErrors
  }

  /** Arm the deadline. No-op when `timeoutMs` is 0 (interactive streams). */
  start(): void {
    if (this.phaseValue !== 'idle' || this.timeoutMs <= 0) return
    this.deadlineHandle = this.timers.setTimeout(() => this.onDeadline(), this.timeoutMs)
  }

  /**
   * The caller cancelled: ask the channel to stop, then keep the same SIGKILL
   * escalation so a command that ignores a polite close cannot pin the stream.
   */
  cancel(): void {
    if (this.phaseValue === 'done') return
    this.causeValue = this.causeValue ?? 'cancelled'
    this.phaseValue = 'term-sent'
    this.onPhase?.(this.phaseValue, this.causeValue, undefined)
    // Arm before signalling: `onCancel` may settle the channel synchronously, and
    // a timer armed after that would outlive the escalation it belongs to.
    this.scheduleGrace()
    try {
      this.onCancel?.()
    } catch (error) {
      this.signalErrors.push(messageOf(error))
    }
  }

  /** The command exited on its own; disarm every timer. */
  settle(): void {
    if (this.phaseValue === 'done') return
    this.clearAll()
    this.phaseValue = 'done'
    this.onPhase?.(this.phaseValue, this.causeValue, this.signalValue)
  }

  /** Whether the terminal state has been reached. */
  get settled(): boolean {
    return this.phaseValue === 'done'
  }

  private onDeadline(): void {
    if (this.phaseValue === 'done') return
    this.causeValue = this.causeValue ?? 'timeout'
    this.phaseValue = 'term-sent'
    // Arm the grace timer before SIGTERM: a channel that dies on the signal
    // settles the escalation from inside `send()`, and a timer armed afterwards
    // would then be the one thing still holding the event loop open.
    this.scheduleGrace()
    this.send('TERM')
  }

  private scheduleGrace(): void {
    this.graceHandle = this.timers.setTimeout(() => this.onGrace(), this.graceKillMs)
  }

  private onGrace(): void {
    if (this.phaseValue === 'done') return
    this.phaseValue = 'kill-sent'
    this.settleHandle = this.timers.setTimeout(() => this.onSettleDeadline(), this.settleMs)
    this.send('KILL')
  }

  private onSettleDeadline(): void {
    if (this.phaseValue === 'done') return
    this.phaseValue = 'done'
    this.clearAll()
    this.onPhase?.(this.phaseValue, this.causeValue, this.signalValue)
    try {
      this.onForceSettle()
    } catch (error) {
      this.signalErrors.push(messageOf(error))
    }
  }

  private send(signal: SshSignal): void {
    this.signalValue = signal
    try {
      this.onSignal(signal)
    } catch (error) {
      this.signalErrors.push(messageOf(error))
    }
    this.onPhase?.(this.phaseValue, this.causeValue, signal)
  }

  private clearAll(): void {
    for (const handle of [this.deadlineHandle, this.graceHandle, this.settleHandle]) {
      if (handle !== undefined) this.timers.clearTimeout(handle)
    }
    this.deadlineHandle = undefined
    this.graceHandle = undefined
    this.settleHandle = undefined
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
