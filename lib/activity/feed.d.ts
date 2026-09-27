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
import type { ActivityChannel, ActivityChunk, ActivityKind, ActivityStatus, ActivityView } from '../protocol.js';
export interface ActivityBeginInput {
    kind: ActivityKind;
    sessionId?: string | null;
    subject: string;
    cwd?: string | null;
    label?: string | null;
    target?: string | null;
}
export interface ActivityFinishInput {
    status: ActivityStatus;
    exitCode?: number | null;
    signal?: string | null;
    code?: string | null;
    note?: string | null;
    truncated?: boolean;
    /** Appended verbatim as one final `info` segment (used for non-streamed calls). */
    text?: string | null;
}
export interface ActivityHandle {
    readonly id: string;
    /** Latest snapshot of this record (a copy; callers cannot mutate the feed). */
    view(): ActivityView;
    chunk(channel: ActivityChannel, text: string): void;
    finish(input: ActivityFinishInput): void;
}
export type ActivityEvent = {
    t: 'activity';
    phase: 'begin';
    activity: ActivityView;
} | {
    t: 'activity';
    phase: 'end';
    activity: ActivityView;
} | {
    t: 'activity';
    phase: 'chunk';
    id: string;
    chunk: ActivityChunk;
} | {
    t: 'activity-reset';
};
export interface ActivityFeedOptions {
    /** false = record nothing (`begin` returns an inert handle); default true. */
    enabled?: boolean;
    now?: () => number;
    /** Retained records; default 200. */
    maxRecords?: number;
    /** Text kept per record; default 65536. */
    maxRecordBytes?: number;
    /** Text kept for the whole feed; default 1048576. */
    maxTotalBytes?: number;
    logger?: {
        warn(message: string, fields?: Record<string, unknown>): void;
    };
}
export declare class ActivityFeed {
    readonly enabled: boolean;
    private readonly clock;
    private readonly maxRecords;
    private readonly maxRecordBytes;
    private readonly maxTotalBytes;
    private readonly logger;
    /** Oldest first, exactly the order `snapshot()` returns. */
    private readonly records;
    private readonly listeners;
    /** Monotonic, per instance, never reset — ids are not reused after `clear()`. */
    private counter;
    /** UTF-8 bytes of text retained by `records`, kept in step with every append. */
    private totalBytes;
    private disposed;
    constructor(options?: ActivityFeedOptions);
    begin(input: ActivityBeginInput): ActivityHandle;
    /** Chronological, oldest first. Copies, never internal objects. */
    snapshot(): ActivityView[];
    subscribe(listener: (event: ActivityEvent) => void): () => void;
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
    clear(): number;
    size(): number;
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
    dispose(): void;
    private nextId;
    /** Take a record back out of the ring; only `begin`'s failed path needs this. */
    private discard;
    /**
     * `now()`, guarded against a clock that answers a non-finite value: such a
     * timestamp would reach the pane as an unrenderable date and would make
     * `durationMs` NaN, which is a worse failure than a slightly wrong time.
     */
    private readClock;
    private handle;
    private appendChunk;
    private settle;
    /**
     * Append as much of `text` as the per-record budget allows and return what was
     * retained (possibly nothing).
     *
     * The caller announces exactly this string, which is what keeps a subscriber's
     * patched copy identical to `snapshot()`.
     */
    private retain;
    /**
     * Append one segment, merging into the previous one when the channel repeats.
     *
     * Merging is what keeps a chatty command's snapshot small (one segment per
     * channel per run, not one per read). The `endedAt` guard is what makes it
     * *safe*: a record that has ended is already published, so merging into it
     * afterwards would rewrite a segment subscribers are holding.
     */
    private appendSegment;
    /**
     * Apply the two ring budgets. Silent on purpose (no event): eviction is the
     * feed discarding history of its own accord, and every subscriber already holds
     * those records — telling them would make the panel flicker on a busy session.
     * `clear()` is the operation that says "your copy is stale".
     */
    private enforceBounds;
    /** Drop the oldest record that has ended; `false` when every record is still running. */
    private dropOldestFinished;
    private emit;
    private warn;
}
//# sourceMappingURL=feed.d.ts.map