/**
 * The stream registry: one place that owns every live exec/shell stream.
 *
 * The wire layer (ICD §4.4) addresses streams by `streamId` for `shellWrite`,
 * `shellResize`, `shellSignal`, `shellClose` and `cancel`, and it subscribes
 * with `sinceSeq` after a transport break. Both need a single table, so this hub
 * keeps it:
 *
 *   - `open()` creates the stream (and emits `open` immediately);
 *   - `subscribe(streamId, onFrame, {sinceSeq})` replays what the client missed
 *     and then delivers live frames;
 *   - `write/resize/signal/close` route to the channel controls the runner
 *     attached to the stream;
 *   - `dispose()` guarantees that no stream is left without its terminal `end`.
 *
 * Finished streams stay addressable for a bounded number of entries so a client
 * that reconnects after the command ended still gets the exit code and output.
 * A replay request that reaches further back than the retained window is
 * reported as `gap:true` — never silently.
 */
import type { Frame, StreamKind } from '../protocol.js';
import { FrameWriter } from './frames.js';
import type { ChunkEncoding, SshSignal } from './types.js';
/** Operations the runner exposes for a live stream. */
export interface StreamControl {
    /** Number of bytes accepted by the channel. */
    write?(data: string, encoding: ChunkEncoding): number;
    resize?(cols: number, rows: number): void;
    signal?(signal: SshSignal): void;
    /** Ask the runner to terminate the command; it ends the stream itself. */
    cancel(reason: string): void;
    /** Interactive-close path (`shellClose`); falls back to `cancel`. */
    close?(): void;
    /**
     * The hub had to terminate the stream itself (`dispose`) because the runner
     * did not. The runner must settle its own bookkeeping — otherwise the caller's
     * promise would wait forever on a stream the wire already saw end.
     */
    terminated?(reason: string): void;
}
export interface OpenStreamOptions {
    kind: StreamKind;
    sessionId?: string;
    meta?: unknown;
    controls?: StreamControl;
    /** Overrides the hub default; the exec layer passes the config value. */
    replayLimitBytes?: number;
    /** Count bound on the replay window; `undefined` keeps `FrameWriter`'s default. */
    replayLimitFrames?: number;
    /** Caller-supplied id (tests, reconnect); generated when omitted. */
    streamId?: string;
}
export interface StreamSummary {
    streamId: string;
    kind: StreamKind;
    sessionId?: string;
    startedAt: string;
    alive: boolean;
    dataFrames: number;
    bytes: number;
    durationMs: number;
}
export interface Subscription {
    unsubscribe(): void;
    /** Frames delivered from the replay log. */
    replayed: number;
    /** True when the requested `sinceSeq` predates the retained window. */
    gap: boolean;
    /** True when the stream had already finished: nothing live will follow. */
    finished: boolean;
}
export interface SubscribeOptions {
    sinceSeq?: number;
}
export interface StreamHubOptions {
    now?: () => number;
    replayLimitBytes?: number;
    /** Count bound on the replay window; `undefined` keeps `FrameWriter`'s default. */
    replayLimitFrames?: number;
    /** How many finished streams stay addressable for late subscribers. */
    maxFinishedStreams?: number;
    onViolation?: (violation: string) => void;
}
export declare class StreamHub {
    private readonly now;
    private readonly replayLimitBytes;
    /**
     * `undefined` is preserved, never collapsed to 0: `FrameWriter` reads 0 as
     * "no count bound", so defaulting here would silently *disable* the bound this
     * option exists to enforce. Unset must stay unset and let FrameWriter decide.
     */
    private readonly replayLimitFrames;
    private readonly maxFinishedStreams;
    private readonly onViolation;
    private readonly records;
    private readonly quarantined;
    constructor(options?: StreamHubOptions);
    /** Number of streams currently held (live + finished). */
    get size(): number;
    get liveCount(): number;
    /** Create a stream; `open` is emitted before this returns. */
    open(options: OpenStreamOptions): FrameWriter;
    get(streamId: string): FrameWriter | undefined;
    has(streamId: string): boolean;
    /** Set (or replace) the controls of a live stream. */
    attach(streamId: string, controls: StreamControl): void;
    /** Live and finished streams, oldest first, optionally for one session. */
    list(sessionId?: string): StreamSummary[];
    summarizeById(streamId: string): StreamSummary | undefined;
    /**
     * Deliver the frames a (re)subscriber needs.
     *
     * Frames buffered while the replay runs are flushed afterwards, so a sink that
     * re-enters the hub cannot reorder the sequence.
     */
    subscribe(streamId: string, onFrame: (frame: Frame) => void, options?: SubscribeOptions): Subscription;
    /** Route `shellWrite`; returns the number of accepted bytes. */
    write(streamId: string, data: string, encoding?: ChunkEncoding): number;
    /** Route `shellResize`. */
    resize(streamId: string, cols: number, rows: number): void;
    /** Route `shellSignal`. */
    signal(streamId: string, signal: SshSignal): void;
    /** Ask a live stream to stop; the runner emits the terminal frames. */
    cancel(streamId: string, reason?: string): boolean;
    /** `shellClose`: close the interactive channel, ending the stream as cancelled. */
    close(streamId: string, reason?: string): boolean;
    /**
     * Terminate everything (plugin unload).
     *
     * A control that ends its stream synchronously wins; anything still live is
     * closed here so no client is left holding a stream that never ends.
     */
    dispose(reason?: 'peer-closed' | 'cancelled'): void;
    private dispatch;
    private finishRecord;
    /** Keep at most `maxFinishedStreams` finished streams addressable. */
    private quarantine;
    private summarize;
    private require;
    private requireLive;
}
//# sourceMappingURL=streams.d.ts.map