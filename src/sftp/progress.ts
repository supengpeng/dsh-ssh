/**
 * Progress coalescing (ICD §4.5: at most one `progress` frame per **≥200 ms or
 * ≥1 MiB**, whichever comes first) plus the rate/ETA estimate that travels with
 * it.
 *
 * Why a dedicated object instead of calling `onProgress` after every chunk: a
 * 100 MiB upload at 256 KiB per chunk produces 400 samples, and one frame each
 * would be 400 IPC round trips into the renderer for a bar that repaints every
 * ~16 ms. Coalescing is therefore part of the contract, not an optimization.
 *
 * The clock is injectable so the cadence is unit-testable without sleeping:
 * `test/unit/sftp-progress.test.mjs` drives a manual clock and asserts exactly
 * which samples were emitted. Real timers are `unref`'d, so a pending coalescing
 * timer can never keep the DSH process alive.
 */

import type { Frame } from '../protocol.js'

import type { TransferPhase, TransferProgress } from './types.js'

export type TimerHandle = { unref?: () => void }

/** Clock seam: real timers by default, a manual clock in tests. */
export interface ProgressClock {
  now(): number
  setTimer(callback: () => void, ms: number): TimerHandle
  clearTimer(handle: TimerHandle): void
}

export const systemProgressClock: ProgressClock = {
  now: () => Date.now(),
  setTimer: (callback, ms) => {
    const handle = setTimeout(callback, ms)
    // Never hold the event loop open for a progress tick.
    handle.unref?.()
    return handle
  },
  clearTimer: (handle) => clearTimeout(handle as unknown as NodeJS.Timeout),
}

export interface ProgressReporterOptions {
  /** Time-based emission interval; ICD §4.5 default 200 ms. */
  intervalMs?: number
  /** Size-based emission threshold; ICD §4.5 fixed at 1 MiB. */
  byteThreshold?: number
  clock?: ProgressClock
  /** Sink; a throwing sink can never abort a running transfer. */
  onProgress?: (progress: TransferProgress) => void
}

/**
 * Emits monotone `TransferProgress` samples.
 *
 * Invariants enforced here (asserted by the unit tests):
 *  - `transferred` never decreases;
 *  - `totalBytes` is reported at most once per operation and never changes after
 *    it is known (ICD §3 "progress 单调不减，totalBytes 确定后不再变化");
 *  - a phase change is always observable, because a phase transition is the one
 *    thing a coalesced sample must not swallow;
 *  - `stop()` emits a final sample so the last bytes are never lost.
 */
export class ProgressReporter {
  private readonly intervalMs: number
  private readonly byteThreshold: number
  private readonly clock: ProgressClock
  private readonly onProgress: ((progress: TransferProgress) => void) | undefined

  private phase: TransferPhase = 'scan'
  private transferred = 0
  private totalBytes: number | undefined
  private transferStartedAt: number | undefined
  private lastEmitAt = 0
  private lastEmitTransferred = 0
  private lastEmitPhase: TransferPhase | undefined
  private pendingTimer: TimerHandle | undefined
  private begun = false
  private stopped = false
  private sinkFailures = 0

  constructor(options: ProgressReporterOptions = {}) {
    this.intervalMs = Math.max(1, Math.trunc(options.intervalMs ?? 200))
    this.byteThreshold = Math.max(1, Math.trunc(options.byteThreshold ?? 1024 * 1024))
    this.clock = options.clock ?? systemProgressClock
    this.onProgress = options.onProgress
  }

  /** Reset for a new operation and emit the opening sample (`scan`, 0 bytes). */
  begin(totalBytes?: number, phase: TransferPhase = 'scan'): void {
    this.phase = phase
    this.transferred = 0
    this.totalBytes = undefined
    this.transferStartedAt = undefined
    this.lastEmitAt = 0
    this.lastEmitTransferred = 0
    this.lastEmitPhase = undefined
    this.begun = true
    this.stopped = false
    this.clearTimer()
    if (totalBytes !== undefined) this.setTotal(totalBytes, { silent: true })
    if (phase === 'transfer') this.transferStartedAt = this.clock.now()
    this.emit()
  }

  /**
   * Fix the total size. The first value wins: after the scan phase the ICD
   * forbids changing it, and a shrinking file must not make the bar jump back.
   */
  setTotal(totalBytes: number, options: { silent?: boolean } = {}): void {
    if (!Number.isFinite(totalBytes) || totalBytes < 0) return
    const total = Math.trunc(totalBytes)
    if (this.totalBytes !== undefined) return
    this.totalBytes = total
    if (options.silent !== true && this.begun) this.emit()
  }

  /**
   * Move to another phase; always observable, never coalesced away.
   *
   * Entering `transfer` starts the rate window, so the resumed offset (bytes a
   * previous run already moved) is excluded from `bytesPerSec`.
   */
  setPhase(phase: TransferPhase): void {
    if (this.phase === phase) return
    this.phase = phase
    if (phase === 'transfer' && this.transferStartedAt === undefined) this.transferStartedAt = this.clock.now()
    if (this.begun && !this.stopped) this.emit()
  }

  /** Account for committed bytes; emits only when a coalescing rule fires. */
  advance(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return
    this.transferred += Math.trunc(bytes)
    if (this.begun && !this.stopped) this.maybeEmit()
  }

  /**
   * "Something happened, but no bytes moved" — a directory scan entry or a slow
   * remote call. Honours the time rule only, so a 100 k-file scan still produces
   * a live bar without turning into a frame storm.
   */
  touch(): void {
    if (!this.begun || this.stopped) return
    if (this.clock.now() - this.lastEmitAt >= this.intervalMs) this.emit()
    else this.scheduleTimer()
  }

  /** Emit the current sample unconditionally (phase boundary, end of transfer). */
  flush(): void {
    if (!this.begun || this.stopped) return
    this.emit()
  }

  /** Emit the final sample, drop the timer and refuse further emissions. */
  stop(): void {
    if (!this.begun || this.stopped) return
    this.clearTimer()
    const dirty = this.transferred !== this.lastEmitTransferred || this.phase !== this.lastEmitPhase
    if (dirty) this.emit()
    this.stopped = true
  }

  /** Current sample without emitting anything. */
  snapshot(): TransferProgress {
    const sample: TransferProgress = {
      transferred: this.transferred,
      bytesPerSec: this.bytesPerSec(),
      phase: this.phase,
    }
    if (this.totalBytes !== undefined) sample.totalBytes = this.totalBytes
    const etaMs = this.etaMs(sample.bytesPerSec)
    if (etaMs !== undefined) sample.etaMs = etaMs
    return sample
  }

  /** Digests are diagnostics; a sink that throws must not fail the transfer. */
  get sinkErrorCount(): number {
    return this.sinkFailures
  }

  private bytesPerSec(): number {
    if (this.transferStartedAt === undefined) return 0
    const elapsed = this.clock.now() - this.transferStartedAt
    if (elapsed <= 0) return 0
    const rate = (this.transferred * 1000) / elapsed
    return Number.isFinite(rate) && rate > 0 ? Math.round(rate) : 0
  }

  private etaMs(bytesPerSec: number): number | undefined {
    if (this.totalBytes === undefined || bytesPerSec <= 0) return undefined
    const remaining = this.totalBytes - this.transferred
    if (remaining <= 0) return 0
    const eta = Math.round((remaining * 1000) / bytesPerSec)
    return Number.isFinite(eta) ? eta : undefined
  }

  private maybeEmit(): void {
    const now = this.clock.now()
    if (this.transferred - this.lastEmitTransferred >= this.byteThreshold) {
      this.emit()
      return
    }
    if (now - this.lastEmitAt >= this.intervalMs) {
      this.emit()
      return
    }
    this.scheduleTimer()
  }

  private scheduleTimer(): void {
    if (this.pendingTimer !== undefined || this.stopped) return
    const elapsed = this.clock.now() - this.lastEmitAt
    const delay = Math.max(1, this.intervalMs - elapsed)
    this.pendingTimer = this.clock.setTimer(() => {
      this.pendingTimer = undefined
      if (!this.begun || this.stopped) return
      this.emit()
    }, delay)
  }

  private emit(): void {
    this.clearTimer()
    const sample = this.snapshot()
    this.lastEmitAt = this.clock.now()
    this.lastEmitTransferred = sample.transferred
    this.lastEmitPhase = sample.phase
    if (this.onProgress === undefined) return
    try {
      this.onProgress(sample)
    } catch {
      // A frame sink (IPC/renderer) must never be able to abort a transfer.
      this.sinkFailures++
    }
  }

  private clearTimer(): void {
    if (this.pendingTimer === undefined) return
    this.clock.clearTimer(this.pendingTimer)
    this.pendingTimer = undefined
  }
}

/**
 * ICD §3 mapping: `TransferProgress` is already field-for-field the payload of a
 * `progress` frame, so the wire layer only adds the stream identity. Exported so
 * the mapping is exercised by a test rather than re-implemented per call site.
 */
export function toProgressFrame(streamId: string, progress: TransferProgress): Extract<Frame, { t: 'progress' }> {
  const frame: Extract<Frame, { t: 'progress' }> = {
    t: 'progress',
    streamId,
    transferred: progress.transferred,
    bytesPerSec: progress.bytesPerSec,
    phase: progress.phase,
  }
  if (progress.totalBytes !== undefined) frame.totalBytes = progress.totalBytes
  if (progress.etaMs !== undefined) frame.etaMs = progress.etaMs
  return frame
}
