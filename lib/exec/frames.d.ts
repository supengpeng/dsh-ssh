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
    private readonly now;
    private readonly onViolation;
    private readonly onEnd;
    private readonly entries;
    private dataBytes;
    private droppedDataFrames;
    private oldestRetainedSeq;
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
    /** Evict the oldest data frames until the replay log fits its byte budget. */
    private trim;
    private countData;
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