/**
 * The agent-activity mirror (ICD §4.7): a bounded in-memory ring of what the
 * model did through the `ssh_*` tools, plus the event stream the panel renders
 * it from.
 *
 * What this module deliberately is **not**:
 *
 *   - **Not the audit log.** The durable, redacted record of what happened is
 *     `src/audit.ts` and its JSONL file. The feed is a *view* a browser tab reads
 *     while the agent works; it is never written anywhere and nothing in it is
 *     promised to survive a reload or a process restart.
 *   - **Not a redaction layer.** The audit path scrubs because it *stores* text.
 *     The feed stores what the user's own session produced — the stdout of the
 *     command they asked for — and scrubbing that would corrupt the terminal
 *     picture without protecting anything the user cannot already see. A command
 *     that prints a secret therefore shows it here; the redacted durable copy is
 *     the audit file's job.
 *   - **Not a stream engine.** There is no queue, no replay window, no
 *     back-pressure and no retry: a chunk is appended and announced synchronously,
 *     and no caller is ever asked to wait. The frame plumbing that turns these
 *     events into `Frame`s lives in `src/api/activity-api.ts`.
 *
 * Why the ring is bounded three ways (all three come from `config.activity`, §6):
 *
 *   - `maxRecords` caps how many records the ring holds at all;
 *   - `maxRecordBytes` caps the transcript of one record;
 *   - `maxTotalBytes` caps the transcript of the whole feed.
 *
 * Together they answer the only question a long agent session raises: an agent
 * that runs something chatty (`tail -f`, a build log, a 100 MiB transfer log)
 * must not be able to grow the host process without limit — while the *running*
 * record, the one the user is watching right now, is never the record that gets
 * dropped to make room.
 *
 * Two invariants hold for every operation, and both are load-bearing:
 *
 *   1. **Nothing escapes.** `begin`/`chunk`/`finish` never throw, whatever they
 *      are handed. This module observes operations it does not own; a mirror that
 *      can fail the SSH call it is watching is worse than no mirror at all.
 *   2. **A subscriber sees exactly what the ring holds.** Every event carries a
 *      fresh copy, and a `chunk` event carries only the text that was actually
 *      retained. A client that patches its own copy from the deltas therefore ends
 *      up identical to `snapshot()`, even across truncation.
 */
/** Defaults mirror `config.activity` (ICD §6); a bare `new ActivityFeed()` is usable. */
const DEFAULT_MAX_RECORDS = 200;
const DEFAULT_MAX_RECORD_BYTES = 65536;
const DEFAULT_MAX_TOTAL_BYTES = 1048576;
/**
 * The frozen vocabularies, as runtime sets.
 *
 * The TypeScript signatures already constrain these, but the feed is called by
 * instrumented tool code and by tests, and a value outside the frozen vocabulary
 * is not renderable by the pane: it would be drawn as an unknown operation rather
 * than reported. Normalising *into* the vocabulary keeps every record drawable;
 * the fallbacks are chosen so that nothing is ever claimed to have succeeded.
 */
const ACTIVITY_KINDS = ['exec', 'upload', 'download', 'listDir', 'stat', 'connect', 'disconnect', 'sessions'];
const ACTIVITY_STATUSES = ['running', 'ok', 'error', 'timeout', 'cancelled', 'refused'];
const ACTIVITY_CHANNELS = ['stdout', 'stderr', 'info'];
/** A wire string, or `null`. An empty string carries no information, so it is "unknown". */
function readText(value) {
    return typeof value === 'string' && value !== '' ? value : null;
}
function readNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function readKind(value) {
    return typeof value === 'string' && ACTIVITY_KINDS.includes(value) ? value : 'exec';
}
/**
 * An unknown status is recorded as `error`, never as `ok`: the feed must not
 * report an operation as successful when it could not understand the outcome it
 * was handed.
 */
function readStatus(value) {
    return typeof value === 'string' && ACTIVITY_STATUSES.includes(value) ? value : 'error';
}
/** A budget: a non-finite or negative one falls back to the default rather than to 0. */
function limitOf(value, fallback) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return fallback;
    return Math.max(0, Math.trunc(value));
}
/**
 * A message from a thrown value, including one whose `toString` throws.
 *
 * This runs inside a `catch`, so it must not be able to throw in turn — losing the
 * original failure to a broken error object would be the worst possible trade.
 */
function describe(error) {
    try {
        return error instanceof Error ? error.message : String(error);
    }
    catch {
        return 'unprintable error';
    }
}
/**
 * The longest prefix of `text` that fits in `room` UTF-8 bytes, cut on a character
 * boundary.
 *
 * The cut cannot simply be a byte count: a buffer that ends inside a multi-byte
 * sequence decodes to U+FFFD, which would put a replacement character in the
 * user's terminal picture that their command never printed. Backing off over
 * continuation bytes (`10xxxxxx`) lands on the start of the sequence that did not
 * fit, so every retained character is one the peer actually sent.
 */
function headBytes(text, room) {
    const encoded = Buffer.from(text, 'utf8');
    let end = Math.min(room, encoded.length);
    while (end > 0 && ((encoded[end] ?? 0) & 0xc0) === 0x80)
        end -= 1;
    return encoded.subarray(0, end).toString('utf8');
}
/**
 * A fresh copy in the frozen wire shape.
 *
 * Written out field by field rather than as a spread on purpose: `ActivityRecord`
 * carries `bytes`, and a spread would put that bookkeeping on the wire, where the
 * client's copy could then disagree with the host's. Copying the segments too is
 * what makes every snapshot and every event immutable from the caller's side.
 */
function copyView(view) {
    return {
        id: view.id,
        kind: view.kind,
        sessionId: view.sessionId,
        target: view.target,
        subject: view.subject,
        cwd: view.cwd,
        label: view.label,
        startedAt: view.startedAt,
        endedAt: view.endedAt,
        durationMs: view.durationMs,
        status: view.status,
        exitCode: view.exitCode,
        signal: view.signal,
        code: view.code,
        note: view.note,
        segments: view.segments.map((segment) => ({ channel: segment.channel, text: segment.text })),
        truncated: view.truncated,
    };
}
/**
 * The view `begin` would have retained, built without retaining it.
 *
 * Used by the two paths that record nothing (disabled, disposed) so that a caller
 * may still read `handle.view()` for logging without branching: it describes the
 * operation as requested, and because it is not in the ring, `chunk`/`finish`
 * cannot change it.
 *
 * Takes `Partial` on purpose: this is also the shape `begin` hands back when the
 * caller's own object could not be read at all.
 */
function detachedView(id, input, startedAt) {
    const kind = readKind(input.kind);
    return {
        id,
        kind,
        sessionId: readText(input.sessionId),
        target: readText(input.target),
        // The pane always draws a subject line, so an unusable one falls back to the
        // operation kind rather than to a blank row.
        subject: readText(input.subject) ?? kind,
        cwd: readText(input.cwd),
        label: readText(input.label),
        startedAt,
        endedAt: null,
        durationMs: null,
        status: 'running',
        exitCode: null,
        signal: null,
        code: null,
        note: null,
        segments: [],
        truncated: false,
    };
}
/** A handle over a ring that records nothing: every method but `view` is a no-op. */
function inertHandle(id, view) {
    return {
        id,
        view: () => copyView(view),
        chunk: () => { },
        finish: () => { },
    };
}
export class ActivityFeed {
    enabled;
    clock;
    maxRecords;
    maxRecordBytes;
    maxTotalBytes;
    logger;
    /** Oldest first, exactly the order `snapshot()` returns. */
    records = [];
    listeners = new Set();
    /** Monotonic, per instance, never reset — ids are not reused after `clear()`. */
    counter = 0;
    /** UTF-8 bytes of text retained by `records`, kept in step with every append. */
    totalBytes = 0;
    disposed = false;
    constructor(options = {}) {
        this.enabled = options.enabled !== false;
        this.clock = options.now ?? Date.now;
        this.maxRecords = limitOf(options.maxRecords, DEFAULT_MAX_RECORDS);
        this.maxRecordBytes = limitOf(options.maxRecordBytes, DEFAULT_MAX_RECORD_BYTES);
        this.maxTotalBytes = limitOf(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
        this.logger = options.logger;
    }
    begin(input) {
        const id = this.nextId();
        let record;
        try {
            // Every caller-supplied value is read inside this block. `begin` is handed
            // objects assembled by instrumented tool code, and the one way that goes
            // wrong at runtime is a getter that throws: that must come out of here as
            // "nothing was recorded", never as a throw into the SSH operation.
            const startedAt = this.readClock();
            const source = input ?? {};
            const view = detachedView(id, source, startedAt);
            // Disabled and disposed share one path: the counter still advances, but
            // nothing is stored, so `snapshot()`/`size()`/events are all structurally
            // empty.
            if (!this.enabled || this.disposed)
                return inertHandle(id, view);
            record = { ...view, bytes: 0 };
            this.records.push(record);
            // No ring budget can be exceeded by this call — it adds no text and no
            // finished record — so `enforceBounds()` is deliberately not called here.
            this.emit({ t: 'activity', phase: 'begin', activity: copyView(record) });
            return this.handle(record);
        }
        catch (error) {
            // Rolled back rather than left behind: a record nothing can finish would be
            // a running record forever, and running records are exactly what the ring
            // budgets are not allowed to reclaim.
            this.discard(record);
            this.warn('activity begin failed', { id, reason: describe(error) });
            // A literal built here, not the caller's object: the fallback must not be
            // able to fail for the reason the input did.
            return inertHandle(id, detachedView(id, {}, Date.now()));
        }
    }
    /** Chronological, oldest first. Copies, never internal objects. */
    snapshot() {
        return this.records.map((record) => copyView(record));
    }
    subscribe(listener) {
        if (typeof listener !== 'function')
            return () => { };
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    /**
     * Drop finished records; return how many were dropped. Running records stay.
     *
     * This is the one operation that *deliberately* invalidates what subscribers
     * hold, so it is also the only producer of `activity-reset`: a client that kept
     * a copy of the dropped history would otherwise render records the host no
     * longer has. The frame is sent only when something was actually dropped — a
     * `clear()` that removed nothing has nothing to correct, and telling a client to
     * throw its view away would drop the *running* records it is drawing.
     */
    clear() {
        let dropped = 0;
        for (let index = this.records.length - 1; index >= 0; index -= 1) {
            const record = this.records[index];
            if (record === undefined || record.endedAt === null)
                continue;
            this.records.splice(index, 1);
            this.totalBytes -= record.bytes;
            dropped += 1;
        }
        if (dropped === 0)
            return 0;
        this.emit({ t: 'activity-reset' });
        return dropped;
    }
    size() {
        return this.records.length;
    }
    /**
     * Stop producing and release the captured output. Idempotent, and deliberately
     * does *not* finish anything: nothing is rewritten to an outcome it never had
     * (a handle taken out earlier still reports its record as it was), the records
     * are simply let go.
     *
     * Releasing the text is the point of calling this at unload: the feed is the one
     * place that holds raw remote output in memory, so "unloading the plugin leaves
     * no captured output behind" has to be an action rather than an expectation
     * about the collector. After this, `begin` hands out inert handles, `snapshot()`
     * is empty, and events are no longer delivered.
     */
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        // Release the endpoint queues that subscribed; they can observe no difference,
        // because a disposed feed delivers nothing.
        this.listeners.clear();
        this.records.length = 0;
        this.totalBytes = 0;
    }
    // ── internals ──────────────────────────────────────────────────────────────
    nextId() {
        this.counter += 1;
        return `act-${this.counter}`;
    }
    /** Take a record back out of the ring; only `begin`'s failed path needs this. */
    discard(record) {
        if (record === undefined)
            return;
        const index = this.records.indexOf(record);
        if (index < 0)
            return;
        this.records.splice(index, 1);
        this.totalBytes -= record.bytes;
    }
    /**
     * `now()`, guarded against a clock that answers a non-finite value: such a
     * timestamp would reach the pane as an unrenderable date and would make
     * `durationMs` NaN, which is a worse failure than a slightly wrong time.
     */
    readClock() {
        const value = this.clock();
        return Number.isFinite(value) ? value : Date.now();
    }
    handle(record) {
        return {
            id: record.id,
            view: () => copyView(record),
            chunk: (channel, text) => {
                this.appendChunk(record, channel, text);
            },
            finish: (input) => {
                this.settle(record, input);
            },
        };
    }
    appendChunk(record, channel, text) {
        if (this.disposed)
            return;
        // A finished record is sealed: the `end` event already carried the whole
        // transcript, so a late chunk could never be merged into what subscribers hold.
        if (record.endedAt !== null)
            return;
        // Not a string is a caller bug; coercing it would put `[object Object]` in the
        // user's terminal picture, which is worse than a missing line.
        if (typeof text !== 'string' || text === '')
            return;
        try {
            const wireChannel = ACTIVITY_CHANNELS.includes(channel) ? channel : 'info';
            const retained = this.retain(record, wireChannel, text);
            // No room at all: only `truncated` changed, and announcing a chunk the ring
            // does not hold would desynchronise every subscriber's copy.
            if (retained === '')
                return;
            this.emit({ t: 'activity', phase: 'chunk', id: record.id, chunk: { channel: wireChannel, text: retained } });
            this.enforceBounds();
        }
        catch (error) {
            this.warn('activity chunk failed', { id: record.id, reason: describe(error) });
        }
    }
    settle(record, input) {
        if (this.disposed)
            return;
        // Idempotent by construction: the first `finish` seals the record, so a second
        // one (a tool that reports twice, a timeout racing a clean exit) changes
        // nothing and announces nothing.
        if (record.endedAt !== null)
            return;
        try {
            const source = input ?? {};
            // Every field is read before the record is touched. The order is the whole
            // guarantee: a getter that throws halfway (the input came from instrumented
            // tool code) then leaves a record that is still `running`, which subscribers
            // keep waiting on — rather than a terminal record whose `end` event was
            // never sent, which nothing would ever correct.
            const status = readStatus(source.status);
            const endedAt = this.readClock();
            const exitCode = readNumber(source.exitCode);
            const signal = readText(source.signal);
            const code = readText(source.code);
            const note = readText(source.note);
            const truncated = source.truncated === true;
            const text = readText(source.text);
            record.status = status;
            record.endedAt = endedAt;
            // Clamped: a clock that steps backwards would otherwise produce a negative
            // duration, which the pane can only render as nonsense.
            record.durationMs = Math.max(0, endedAt - record.startedAt);
            record.exitCode = exitCode;
            record.signal = signal;
            record.code = code;
            record.note = note;
            if (truncated)
                record.truncated = true;
            // Appended after the record is terminal, so this narration cannot merge into
            // an earlier `info` segment: the contract is *one final* segment.
            if (text !== null)
                this.retain(record, 'info', text);
            this.emit({ t: 'activity', phase: 'end', activity: copyView(record) });
            this.enforceBounds();
        }
        catch (error) {
            this.warn('activity finish failed', { id: record.id, reason: describe(error) });
        }
    }
    /**
     * Append as much of `text` as the per-record budget allows and return what was
     * retained (possibly nothing).
     *
     * The caller announces exactly this string, which is what keeps a subscriber's
     * patched copy identical to `snapshot()`.
     */
    retain(record, channel, text) {
        const room = this.maxRecordBytes - record.bytes;
        const size = Buffer.byteLength(text, 'utf8');
        if (size <= room) {
            this.appendSegment(record, channel, text, size);
            return text;
        }
        // The transcript keeps its head and drops the tail: the first lines of a
        // command are what identify it, and the flag is what stops a short transcript
        // from being mistaken for a command that produced little output.
        record.truncated = true;
        if (room <= 0)
            return '';
        const head = headBytes(text, room);
        this.appendSegment(record, channel, head, Buffer.byteLength(head, 'utf8'));
        return head;
    }
    /**
     * Append one segment, merging into the previous one when the channel repeats.
     *
     * Merging is what keeps a chatty command's snapshot small (one segment per
     * channel per run, not one per read). The `endedAt` guard is what makes it
     * *safe*: a record that has ended is already published, so merging into it
     * afterwards would rewrite a segment subscribers are holding.
     */
    appendSegment(record, channel, text, size) {
        if (size === 0)
            return;
        const last = record.segments[record.segments.length - 1];
        if (last !== undefined && last.channel === channel && record.endedAt === null) {
            last.text += text;
        }
        else {
            record.segments.push({ channel, text });
        }
        record.bytes += size;
        this.totalBytes += size;
    }
    /**
     * Apply the two ring budgets. Silent on purpose (no event): eviction is the
     * feed discarding history of its own accord, and every subscriber already holds
     * those records — telling them would make the panel flicker on a busy session.
     * `clear()` is the operation that says "your copy is stale".
     */
    enforceBounds() {
        let finished = 0;
        for (const record of this.records) {
            if (record.endedAt !== null)
                finished += 1;
        }
        while (finished > this.maxRecords && this.dropOldestFinished())
            finished -= 1;
        while (this.totalBytes > this.maxTotalBytes) {
            // The byte budget may not empty the ring: a single record bigger than the
            // whole budget stays (it is the only thing left to show), and a running
            // record is never a candidate at all. So this ends when the only drop
            // candidate left is the last record.
            if (this.records.length <= 1)
                break;
            if (!this.dropOldestFinished())
                break;
        }
    }
    /** Drop the oldest record that has ended; `false` when every record is still running. */
    dropOldestFinished() {
        for (let index = 0; index < this.records.length; index += 1) {
            const record = this.records[index];
            if (record === undefined || record.endedAt === null)
                continue;
            this.records.splice(index, 1);
            this.totalBytes -= record.bytes;
            return true;
        }
        return false;
    }
    emit(event) {
        if (this.disposed)
            return;
        // Iterating a copy: a listener is allowed to unsubscribe (or subscribe) while
        // it is being notified, and that must not disturb the others.
        for (const listener of [...this.listeners]) {
            try {
                listener(event);
            }
            catch (error) {
                // A broken `followActivity` consumer must not break the SSH operation that
                // produced the event — the same rule the auditor applies to its own
                // subscribers.
                this.warn('activity subscriber failed', { reason: describe(error) });
            }
        }
    }
    warn(message, fields) {
        try {
            this.logger?.warn(message, fields);
        }
        catch {
            // A logger that throws would otherwise become a second way for the mirror to
            // fail the operation it is observing.
        }
    }
}
//# sourceMappingURL=feed.js.map