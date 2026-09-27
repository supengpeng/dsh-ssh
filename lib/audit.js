/**
 * Audit log: what happened to which host, when, and how it ended — durable,
 * queryable, and always redacted.
 *
 * The properties that matter, and how each is obtained:
 *
 *   - **Best effort by construction.** "A full disk must never fail an SSH
 *     operation" is a hard requirement, so `record()` is synchronous, returns
 *     `void`, and swallows every failure. A record that could not be written is
 *     kept in a bounded pending buffer and retried by `flush()`, which is the one
 *     place a caller may ask "is it on disk yet?".
 *   - **Redacted before anything else sees it.** The entry is scrubbed on the way
 *     in, so the in-memory ring, the subscribers (the UI's `followAudit` stream)
 *     and the file all hold the same redacted object. There is no code path that
 *     can observe a pre-redaction entry.
 *   - **Queryable after a restart.** The ring answers queries, and the first query
 *     on an empty ring hydrates it from the tail of the file, so the audit tab is
 *     not empty merely because the plugin reloaded.
 *   - **Bounded.** The ring holds the most recent `maxMemoryEntries`; the file
 *     rotates at `maxBytes` to `<name>.1.jsonl` (same rule as the plugin log).
 */
import { JsonlWriter } from './logger.js';
const DEFAULT_MEMORY_ENTRIES = 2000;
const MAX_PENDING = 512;
const MAX_PAGE = 1000;
function cloneEntry(entry) {
    return {
        ...entry,
        ...(entry.target === undefined ? {} : { target: { ...entry.target } }),
        ...(entry.detail === undefined ? {} : { detail: { ...entry.detail } }),
    };
}
/** A record that parsed as JSON but is not an `AuditEntry` is not returned. */
function isAuditEntry(value) {
    if (value === null || typeof value !== 'object')
        return false;
    const candidate = value;
    return typeof candidate.at === 'string' && typeof candidate.op === 'string';
}
export class SshAuditorImpl {
    file;
    redactor;
    logger;
    writer;
    maxMemoryEntries;
    entries = [];
    listeners = new Set();
    pendingEntries = [];
    hydrated = false;
    droppedCount = 0;
    constructor(options) {
        this.file = options.file;
        this.redactor = options.redactor;
        this.logger = options.logger;
        this.maxMemoryEntries = Math.max(1, Math.trunc(options.maxMemoryEntries ?? DEFAULT_MEMORY_ENTRIES));
        this.writer = new JsonlWriter(options.file, options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes });
    }
    get size() {
        return this.entries.length;
    }
    get dropped() {
        return this.droppedCount;
    }
    get pending() {
        return this.pendingEntries.length;
    }
    /**
     * Record one event. Never throws and never blocks: this is called from the
     * middle of connection, exec and transfer paths where an observability failure
     * must be invisible.
     */
    record(entry) {
        let safe;
        try {
            const stamped = { ...entry, at: new Date().toISOString() };
            safe = this.redactor.scrub(stamped);
        }
        catch {
            // A redaction failure must not lose the event; fall back to a value-free
            // record rather than writing something that was never scrubbed.
            safe = {
                at: new Date().toISOString(),
                op: typeof entry?.op === 'string' && entry.op !== '' ? entry.op : 'unknown',
                outcome: 'error',
                detail: { redactionFailed: true },
            };
        }
        this.push(safe);
        if (!this.writer.append(safe) && this.pendingEntries.length < MAX_PENDING) {
            this.pendingEntries.push(safe);
        }
        this.notify(safe);
    }
    async query(q = {}) {
        this.ensureHydrated();
        const limit = Math.min(MAX_PAGE, Math.max(1, Math.trunc(q.limit ?? 100)));
        const offset = Math.max(0, Math.trunc(q.offset ?? 0));
        const sessionId = typeof q.sessionId === 'string' && q.sessionId !== '' ? q.sessionId : undefined;
        const kinds = Array.isArray(q.kinds) && q.kinds.length > 0 ? new Set(q.kinds.filter((kind) => typeof kind === 'string')) : undefined;
        const sinceMs = typeof q.since === 'string' ? Date.parse(q.since) : Number.NaN;
        const hasSince = Number.isFinite(sinceMs);
        const matches = [];
        // Newest first: the UI's default view is "what just happened".
        for (let index = this.entries.length - 1; index >= 0; index -= 1) {
            const entry = this.entries[index];
            if (entry === undefined)
                continue;
            if (sessionId !== undefined && entry.sessionId !== sessionId)
                continue;
            if (kinds !== undefined && !kinds.has(entry.op))
                continue;
            if (hasSince) {
                const at = Date.parse(entry.at);
                if (!Number.isFinite(at) || at < sinceMs)
                    continue;
            }
            matches.push(cloneEntry(entry));
        }
        return { entries: matches.slice(offset, offset + limit), total: matches.length };
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    async flush() {
        if (this.pendingEntries.length === 0)
            return;
        const retry = this.pendingEntries;
        this.pendingEntries = [];
        for (const entry of retry) {
            if (!this.writer.append(entry) && this.pendingEntries.length < MAX_PENDING) {
                this.pendingEntries.push(entry);
            }
        }
    }
    async clear() {
        const removed = this.entries.length;
        this.entries = [];
        this.pendingEntries = [];
        this.droppedCount = 0;
        this.writer.truncate();
        return removed;
    }
    // ── internals ────────────────────────────────────────────────────────────
    push(entry) {
        this.entries.push(entry);
        while (this.entries.length > this.maxMemoryEntries) {
            this.entries.shift();
            this.droppedCount += 1;
        }
    }
    notify(entry) {
        for (const listener of [...this.listeners]) {
            try {
                listener(cloneEntry(entry));
            }
            catch (error) {
                // A broken `followAudit` consumer must not break the SSH operation that
                // produced the entry.
                this.logger?.warn('audit subscriber failed', { reason: error instanceof Error ? error.message : String(error) });
            }
        }
    }
    /**
     * Read the tail of the file into the ring, once, when the ring is empty.
     *
     * A plugin reload (or a fresh process) loses the in-memory history but not the
     * file; hydrating on the first query is what keeps the audit tab useful after a
     * restart without paying a file read on every query.
     */
    ensureHydrated() {
        if (this.hydrated)
            return;
        this.hydrated = true;
        if (this.entries.length > 0)
            return;
        const lines = this.writer.readTail({ limit: this.maxMemoryEntries });
        for (const line of lines) {
            try {
                const parsed = JSON.parse(line);
                if (!isAuditEntry(parsed))
                    continue;
                const entry = parsed;
                this.push(entry);
            }
            catch {
                /* a partially written line (crash, rotation) is skipped */
            }
        }
    }
}
/** Create the auditor (one per plugin activation). */
export function createAuditor(options) {
    return new SshAuditorImpl(options);
}
//# sourceMappingURL=audit.js.map