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
/** Kinds whose streams must carry an `exit` frame before `end` (ICD §3). */
export function requiresExit(kind) {
    return kind === 'exec' || kind === 'shell';
}
/**
 * One stream's frame sequence, replay log and terminal state.
 *
 * Not exported through the plugin's public surface: {@link StreamHub} is the
 * only owner, and it guarantees one writer per stream id.
 */
export class FrameWriter {
    streamId;
    kind;
    startedAt;
    sink;
    replayLimitBytes;
    now;
    onViolation;
    onEnd;
    entries = [];
    dataBytes = 0;
    droppedDataFrames = 0;
    oldestRetainedSeq;
    nextSeq = 0;
    opened = false;
    exitFrame;
    endFrame;
    /** Invariant breaches observed on this stream; must stay empty in tests. */
    violations = [];
    constructor(options) {
        this.streamId = options.streamId;
        this.kind = options.kind;
        this.sink = options.sink;
        this.replayLimitBytes = Math.max(0, Math.trunc(options.replayLimitBytes ?? 262_144));
        this.now = options.now ?? Date.now;
        this.onViolation = options.onViolation ?? (() => { });
        this.onEnd = options.onEnd;
        this.startedAt = this.now();
        this.open(options.meta);
    }
    // ── state ----------------------------------------------------------------
    get openedFlag() {
        return this.opened;
    }
    /** Whether a terminal `end` has been emitted. */
    get ended() {
        return this.endFrame !== undefined;
    }
    /** Whether the `exit` frame has been emitted. */
    get exited() {
        return this.exitFrame !== undefined;
    }
    /** Number of `data` frames emitted so far (not the next seq, which is equal today). */
    get dataFrames() {
        return this.nextSeq;
    }
    /** The next `seq` a `data` frame would receive. */
    get nextSeqNumber() {
        return this.nextSeq;
    }
    /** Last emitted data seq, or `undefined` before the first chunk. */
    get lastSeq() {
        return this.nextSeq === 0 ? undefined : this.nextSeq - 1;
    }
    /** Data frames evicted from the replay log because of the byte budget. */
    get replayDropped() {
        return this.droppedDataFrames;
    }
    // ── emission -------------------------------------------------------------
    /** Emit one retained chunk. Returns false when the frame was discarded. */
    data(chunk, channel, encoding, byteLength) {
        if (this.endFrame !== undefined) {
            this.violate(`data frame with channel "${channel}" after end`);
            return false;
        }
        const seq = this.nextSeq++;
        const frame = { t: 'data', streamId: this.streamId, seq, chunk, encoding, channel };
        this.append(frame, byteLength ?? byteSize(chunk, encoding));
        this.emit(frame);
        return true;
    }
    /** Emit the terminal `exit` frame exactly once. */
    exit(event) {
        if (this.exitFrame !== undefined) {
            this.violate('second exit frame');
            return false;
        }
        if (this.endFrame !== undefined) {
            this.violate('exit frame after end');
            return false;
        }
        const frame = {
            t: 'exit',
            streamId: this.streamId,
            exitCode: event.code,
            durationMs: Math.max(0, Math.trunc(event.durationMs)),
            timedOut: event.timedOut,
            ...(event.signal !== undefined && event.signal !== '' ? { signal: event.signal } : {}),
        };
        this.exitFrame = frame;
        this.append(frame, 0);
        this.emit(frame);
        return true;
    }
    /** Terminate the stream exactly once. Later calls are discarded. */
    end(reason, error) {
        if (this.endFrame !== undefined) {
            this.violate(`second end frame (${reason})`);
            return false;
        }
        if (requiresExit(this.kind) && this.exitFrame === undefined) {
            this.violate(`end(${reason}) before exit`);
        }
        const frame = {
            t: 'end',
            streamId: this.streamId,
            reason,
            ...(error !== undefined ? { error } : {}),
        };
        this.endFrame = frame;
        this.append(frame, 0);
        this.emit(frame);
        this.onEnd?.(reason, error);
        return true;
    }
    // ── replay ---------------------------------------------------------------
    /** Every frame this writer still holds, oldest first (open frame included). */
    retained() {
        return this.entries.map((entry) => entry.frame);
    }
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
    replay(sinceSeq) {
        const fresh = sinceSeq === undefined || sinceSeq <= 0;
        const frames = [];
        // Only a fresh subscriber is owed the frames that were evicted. A
        // resubscription starting after the evicted region has lost nothing, and
        // reporting a gap there would push callers to re-fetch data they already have.
        let gap = fresh && this.droppedDataFrames > 0;
        for (const entry of this.entries) {
            const frame = entry.frame;
            if (frame.t === 'open') {
                if (fresh)
                    frames.push(frame);
                continue;
            }
            if (frame.t === 'data') {
                if (fresh || frame.seq >= sinceSeq)
                    frames.push(frame);
                continue;
            }
            // exit / end: a resubscriber that missed them still needs them.
            frames.push(frame);
        }
        if (!fresh && this.oldestRetainedSeq !== undefined && sinceSeq < this.oldestRetainedSeq)
            gap = true;
        return { frames, gap };
    }
    /** The terminal frame pair, for callers that only need the outcome. */
    terminal() {
        return {
            ...(this.exitFrame !== undefined ? { exit: this.exitFrame } : {}),
            ...(this.endFrame !== undefined ? { end: this.endFrame } : {}),
        };
    }
    // ── internals ------------------------------------------------------------
    open(meta) {
        const frame = {
            t: 'open',
            streamId: this.streamId,
            kind: this.kind,
            ...(meta !== undefined ? { meta } : {}),
        };
        this.opened = true;
        this.append(frame, 0);
        this.emit(frame);
    }
    append(frame, bytes) {
        this.entries.push({ frame, bytes });
        if (frame.t === 'data') {
            this.dataBytes += bytes;
            if (this.oldestRetainedSeq === undefined)
                this.oldestRetainedSeq = frame.seq;
            this.trim();
        }
    }
    /** Evict the oldest data frames until the replay log fits its byte budget. */
    trim() {
        while (this.dataBytes > this.replayLimitBytes && this.countData() > 1) {
            const index = this.entries.findIndex((entry) => entry.frame.t === 'data');
            if (index < 0)
                return;
            const [removed] = this.entries.splice(index, 1);
            if (removed === undefined)
                return;
            this.dataBytes -= removed.bytes;
            this.droppedDataFrames += 1;
            const next = this.entries.find((entry) => entry.frame.t === 'data');
            this.oldestRetainedSeq = next !== undefined && next.frame.t === 'data' ? next.frame.seq : undefined;
        }
    }
    countData() {
        let count = 0;
        for (const entry of this.entries)
            if (entry.frame.t === 'data')
                count += 1;
        return count;
    }
    emit(frame) {
        try {
            this.sink(frame);
        }
        catch {
            // A subscriber must never be able to break the stream it observes.
        }
    }
    violate(violation) {
        const message = `${this.streamId} (${this.kind}): ${violation}`;
        this.violations.push(message);
        try {
            this.onViolation(message);
        }
        catch {
            /* diagnostics must not throw */
        }
    }
    /** Wall-clock age of the stream, used for `exit.durationMs` fallbacks. */
    elapsedMs() {
        return Math.max(0, this.now() - this.startedAt);
    }
}
function byteSize(chunk, encoding) {
    return encoding === 'base64' ? Buffer.byteLength(chunk, 'base64') : Buffer.byteLength(chunk, 'utf8');
}
/**
 * Validate any frame sequence against the ICD §3 scheduling invariants.
 *
 * Exported because it is the cheapest way for *other* agents' tests (and the
 * integration conformance suite) to check a whole stream without re-deriving
 * these rules. Returns one message per violation; an empty array means the
 * sequence is well formed.
 */
export function inspectFrameSequence(frames) {
    const violations = [];
    if (frames.length === 0)
        return ['empty frame sequence'];
    const open = frames.filter((frame) => frame.t === 'open');
    const end = frames.filter((frame) => frame.t === 'end');
    const exit = frames.filter((frame) => frame.t === 'exit');
    if (open.length !== 1)
        violations.push(`expected exactly one open frame, found ${open.length}`);
    if (end.length !== 1)
        violations.push(`expected exactly one end frame, found ${end.length}`);
    if (frames[0]?.t !== 'open')
        violations.push(`first frame is "${frames[0]?.t}" instead of "open"`);
    const last = frames[frames.length - 1];
    if (last !== undefined && last.t !== 'end')
        violations.push(`last frame is "${last.t}" instead of "end"`);
    if (exit.length > 1)
        violations.push(`expected at most one exit frame, found ${exit.length}`);
    const kind = open[0]?.t === 'open' ? open[0].kind : undefined;
    if (kind !== undefined && requiresExit(kind)) {
        if (exit.length === 0)
            violations.push(`kind "${kind}" stream has no exit frame`);
        else if (frames.indexOf(exit[0]) > frames.indexOf(end[0])) {
            violations.push('exit frame appears after end');
        }
    }
    // `state` and `audit` frames are not stream-addressed (ICD §3), so only the
    // frames that carry a `streamId` take part in the consistency check.
    const streamIds = new Set();
    for (const frame of frames) {
        if ('streamId' in frame)
            streamIds.add(frame.streamId);
    }
    if (streamIds.size > 1)
        violations.push(`frames mix stream ids: ${[...streamIds].join(', ')}`);
    let expected = 0;
    let endIndex = frames.length;
    for (let index = 0; index < frames.length; index += 1) {
        const frame = frames[index];
        if (frame === undefined)
            continue;
        if (frame.t === 'end') {
            endIndex = index;
            break;
        }
    }
    for (const frame of frames) {
        if (frame.t !== 'data')
            continue;
        if (frame.seq !== expected) {
            violations.push(`data seq ${frame.seq} at position ${expected} (expected ${expected})`);
        }
        expected += 1;
    }
    const afterEnd = frames.slice(endIndex + 1);
    if (afterEnd.length > 0)
        violations.push(`${afterEnd.length} frame(s) after end`);
    return violations;
}
//# sourceMappingURL=frames.js.map