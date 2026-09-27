/**
 * Frame construction and the scheduling invariants of ICD §3.
 *
 * `FrameWriter` owns exactly one stream's frame sequence. Everything that makes
 * a stream well-formed is enforced here rather than at the call sites:
 *
 *   - `open` is the first frame and is emitted by the constructor;
 *   - `data.seq` starts at 0 and increases by exactly 1 per emitted frame, so
 *     the sequence has no holes and no duplicates (dropped chunks are never
 *     assigned a seq, which is why the limit layer emits only what it retains);
 *   - an `exec`/`shell` stream carries exactly one `exit`, always before `end`;
 *   - exactly one `end` terminates the stream, and nothing follows it.
 *
 * A breach does not throw — dropping the user's terminal because of an internal
 * bookkeeping slip is worse than a late frame. Breaches are recorded in
 * {@link FrameWriter.violations} (asserted to stay empty by the unit tests),
 * reported to an optional hook, and the offending frame is discarded.
 */
import type { EndReason, ErrorInfo, Frame, StreamKind } from '../protocol.js';
import type { ChunkEncoding, ExecExitEvent, TerminalChannel } from './types.js';
/** Receives every frame of one stream, in emission order. */
export type FrameSink = (frame: Frame) => void;
export interface FrameWriterOptions {
    streamId: string;
    kind: StreamKind;
    sink: FrameSink;
    /** Payload of the `open` frame; omitted entirely when `undefined`. */
    meta?: unknown;
    /**
     * Byte budget of the replay log kept for `sinceSeq` resubscription. Data
     * frames older than this are evicted; the loss is reported through
     * {@link FrameWriter.replay} rather than hidden.
     */
    replayLimitBytes?: number;
    /**
     * **Frame-count** budget of the same replay log. Both budgets apply, and the
     * first one to overflow evicts.
     *
     * A byte budget alone cannot bound this log's cost: the log holds one entry per
     * frame, so 256 KiB of payload split into 2-byte frames is ~131k entries — and
     * those entries, their frames and their strings measured ~17.8 MB of heap, i.e.
     * a 67.8× amplification over the retained payload. Bounding the *count* as well
     * is what keeps both the memory and the per-frame eviction cost flat. `0`
     * disables this budget and leaves only `replayLimitBytes` in force.
     */
    replayLimitFrames?: number;
    /** Wall clock, injectable for deterministic duration assertions. */
    now?: () => number;
    /** Called for every invariant breach (never throws into the caller). */
    onViolation?: (violation: string) => void;
    /** Called once when the stream terminates. */
    onEnd?: (reason: EndReason, error: ErrorInfo | undefined) => void;
}
/** Kinds whose streams must carry an `exit` frame before `end` (ICD §3). */
export declare function requiresExit(kind: StreamKind): boolean;
/**
 * One stream's frame sequence, replay log and terminal state.
 *
 * Not exported through the plugin's public surface: {@link StreamHub} is the
 * only owner, and it guarantees one writer per stream id.
 */
export declare class FrameWriter {
    readonly streamId: string;
    readonly kind: StreamKind;
    readonly startedAt: number;
    private readonly sink;
    private readonly replayLimitBytes;
    private readonly replayLimitFrames;
    private readonly now;
    private readonly onViolation;
    private readonly onEnd;
    private readonly entries;
    private dataBytes;
    /** Data frames still retained; evicted ones are counted in `droppedDataFrames`. */
    private liveDataFrames;
    private droppedDataFrames;
    private oldestRetainedSeq;
    /**
     * Index below which every **data** entry has been evicted.
     *
     * The array itself is only rewritten by {@link FrameWriter.compactEvictedPrefix},
     * so between compactions `entries[0..deadEnd)` still holds the evicted frames
     * (plus any control frame that was in the way). Every reader therefore asks
     * {@link FrameWriter.isEvicted} rather than trusting the index alone.
     */
    private deadEnd;
    private nextSeq;
    private opened;
    private exitFrame;
    private endFrame;
    /** Invariant breaches observed on this stream; must stay empty in tests. */
    readonly violations: string[];
    constructor(options: FrameWriterOptions);
    get openedFlag(): boolean;
    /** Whether a terminal `end` has been emitted. */
    get ended(): boolean;
    /** Whether the `exit` frame has been emitted. */
    get exited(): boolean;
    /** Number of `data` frames emitted so far (not the next seq, which is equal today). */
    get dataFrames(): number;
    /** The next `seq` a `data` frame would receive. */
    get nextSeqNumber(): number;
    /** Last emitted data seq, or `undefined` before the first chunk. */
    get lastSeq(): number | undefined;
    /** Data frames evicted from the replay log because of the byte budget. */
    get replayDropped(): number;
    /** Data frames the replay log still holds, after both budgets were applied. */
    get retainedDataFrames(): number;
    /** Emit one retained chunk. Returns false when the frame was discarded. */
    data(chunk: string, channel: TerminalChannel, encoding: ChunkEncoding, byteLength?: number): boolean;
    /** Emit the terminal `exit` frame exactly once. */
    exit(event: ExecExitEvent): boolean;
    /** Terminate the stream exactly once. Later calls are discarded. */
    end(reason: EndReason, error?: ErrorInfo): boolean;
    /** Every frame this writer still holds, oldest first (open frame included). */
    retained(): Frame[];
    /**
     * Frames a (re)subscriber needs.
     *
     * `sinceSeq === undefined` is a fresh subscription: `open` first, then every
     * retained data frame, then a terminal frame pair when the stream is over.
     * A numeric `sinceSeq` is a resubscription after a transport break and skips
     * `open` — the client already holds the stream identity.
     *
     * `gap` is true when the request reaches before the retained window: frames
     * the client will never see are being reported, not hidden. The caller (the
     * wire layer) turns that into `SSH_LIMIT_OUTPUT_TRUNCATED`.
     */
    replay(sinceSeq?: number): {
        frames: Frame[];
        gap: boolean;
    };
    /** The terminal frame pair, for callers that only need the outcome. */
    terminal(): {
        exit?: Extract<Frame, {
            t: 'exit';
        }>;
        end?: Extract<Frame, {
            t: 'end';
        }>;
    };
    private open;
    private append;
    /**
     * Evict the oldest data frames until the replay log fits both of its budgets.
     *
     * ## Why the evicted set is always a contiguous prefix
     *
     * `append()` is the only writer and it only ever pushes, so `entries` is in
     * arrival order: the `open` frame first, then data frames in `seq` order, with
     * at most one `exit` and one `end` appended after the frames they terminate.
     * Eviction always takes the **oldest** data frame, so what leaves the log is a
     * prefix of the data frames — never a hole, and never a control frame.
     *
     * That premise is what makes `deadEnd` sufficient. It only moves forward, so the
     * next victim is simply the first data entry at or after it; every entry it
     * walks past is walked past once between compactions, which is what makes
     * eviction O(1) amortised and keeps this loop free of any scan over the log.
     * The counters (`dataBytes`, `liveDataFrames`, `droppedDataFrames`) are updated
     * arithmetically, and `oldestRetainedSeq` becomes `evictedSeq + 1` because data
     * seqs are contiguous (only `data()` consumes one, and it appends immediately).
     *
     * Control frames may sit *inside* the dead prefix — the `open` frame always
     * does, once the first data frame is evicted — which is why readers skip by
     * {@link FrameWriter.isEvicted} instead of by index, and why compaction filters
     * rather than truncates.
     *
     * At least one data frame is always kept, matching the previous byte-only
     * behaviour: a frame larger than a whole budget stays (it is the only thing left
     * to show) rather than emptying the log the next subscriber reads.
     */
    private trim;
    /** True when this entry is a data frame that has been evicted from the log. */
    private isEvicted;
    /**
     * Evict the oldest retained data frame; `false` when none is left to evict.
     *
     * The loop exists only for the control frames that can stand in the way: it
     * steps over `open` (once, at the front) and over `exit`/`end`, which are never
     * evicted even when the data frames around them are. In steady state it is a
     * single comparison and a counter update.
     */
    private evictOldestDataFrame;
    /**
     * Drop the evicted entries once reclaiming them is worth the walk.
     *
     * This is the only O(entries) step, so it is deliberately amortised: it runs
     * only with at least {@link COMPACT_MIN_EVICTED} evicted entries *and* at least
     * a quarter of the retained window, which bounds the work at
     * `(live + evicted) / evicted ≤ 5` operations per evicted frame and the array at
     * `live + max(256, live / 4)` entries. Compacting on the majority instead (the
     * first rule tried) doubled the peak array for no measurable throughput gain —
     * the dead prefix has to stay proportional to the window, not equal to it.
     * Without any compaction the array (not the budgeted window) would grow for the
     * whole life of the stream.
     *
     * Control frames inside the dead prefix are kept: `open` belongs to every
     * replay, and `exit`/`end` are the frames a late subscriber needs most.
     */
    private compactEvictedPrefix;
    private emit;
    private violate;
    /** Wall-clock age of the stream, used for `exit.durationMs` fallbacks. */
    elapsedMs(): number;
}
/**
 * Validate any frame sequence against the ICD §3 scheduling invariants.
 *
 * Exported because it is the cheapest way for *other* agents' tests (and the
 * integration conformance suite) to check a whole stream without re-deriving
 * these rules. Returns one message per violation; an empty array means the
 * sequence is well formed.
 */
export declare function inspectFrameSequence(frames: readonly Frame[]): string[];
//# sourceMappingURL=frames.d.ts.map