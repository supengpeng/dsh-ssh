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
import type { Frame } from '../protocol.js';
import type { TransferPhase, TransferProgress } from './types.js';
export type TimerHandle = {
    unref?: () => void;
};
/** Clock seam: real timers by default, a manual clock in tests. */
export interface ProgressClock {
    now(): number;
    setTimer(callback: () => void, ms: number): TimerHandle;
    clearTimer(handle: TimerHandle): void;
}
export declare const systemProgressClock: ProgressClock;
export interface ProgressReporterOptions {
    /** Time-based emission interval; ICD §4.5 default 200 ms. */
    intervalMs?: number;
    /** Size-based emission threshold; ICD §4.5 fixed at 1 MiB. */
    byteThreshold?: number;
    clock?: ProgressClock;
    /** Sink; a throwing sink can never abort a running transfer. */
    onProgress?: (progress: TransferProgress) => void;
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
export declare class ProgressReporter {
    private readonly intervalMs;
    private readonly byteThreshold;
    private readonly clock;
    private readonly onProgress;
    private phase;
    private transferred;
    private totalBytes;
    private transferStartedAt;
    private lastEmitAt;
    private lastEmitTransferred;
    private lastEmitPhase;
    private pendingTimer;
    private begun;
    private stopped;
    private sinkFailures;
    constructor(options?: ProgressReporterOptions);
    /** Reset for a new operation and emit the opening sample (`scan`, 0 bytes). */
    begin(totalBytes?: number, phase?: TransferPhase): void;
    /**
     * Fix the total size. The first value wins: after the scan phase the ICD
     * forbids changing it, and a shrinking file must not make the bar jump back.
     */
    setTotal(totalBytes: number, options?: {
        silent?: boolean;
    }): void;
    /**
     * Move to another phase; always observable, never coalesced away.
     *
     * Entering `transfer` starts the rate window, so the resumed offset (bytes a
     * previous run already moved) is excluded from `bytesPerSec`.
     */
    setPhase(phase: TransferPhase): void;
    /** Account for committed bytes; emits only when a coalescing rule fires. */
    advance(bytes: number): void;
    /**
     * "Something happened, but no bytes moved" — a directory scan entry or a slow
     * remote call. Honours the time rule only, so a 100 k-file scan still produces
     * a live bar without turning into a frame storm.
     */
    touch(): void;
    /** Emit the current sample unconditionally (phase boundary, end of transfer). */
    flush(): void;
    /** Emit the final sample, drop the timer and refuse further emissions. */
    stop(): void;
    /** Current sample without emitting anything. */
    snapshot(): TransferProgress;
    /** Digests are diagnostics; a sink that throws must not fail the transfer. */
    get sinkErrorCount(): number;
    private bytesPerSec;
    private etaMs;
    private maybeEmit;
    private scheduleTimer;
    private emit;
    private clearTimer;
}
/**
 * ICD §3 mapping: `TransferProgress` is already field-for-field the payload of a
 * `progress` frame, so the wire layer only adds the stream identity. Exported so
 * the mapping is exercised by a test rather than re-implemented per call site.
 */
export declare function toProgressFrame(streamId: string, progress: TransferProgress): Extract<Frame, {
    t: 'progress';
}>;
//# sourceMappingURL=progress.d.ts.map