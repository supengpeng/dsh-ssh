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
import type { AuditEntry } from './protocol.js';
import type { Redactor } from './redact.js';
export interface AuditQuery {
    /** Page size; defaults to 100 and is clamped to 1000. */
    limit?: number;
    offset?: number;
    /** Only entries produced by this session. */
    sessionId?: string;
    /** ISO timestamp; entries at or after it are returned. */
    since?: string;
    /** Operation names to keep (`AuditEntry.op`); an empty array means "no filter". */
    kinds?: string[];
}
export interface AuditResult {
    /** Newest first. */
    entries: AuditEntry[];
    /** Matches before pagination (bounded by what the ring retains). */
    total: number;
}
/** ICD §7.3 frozen interface. */
export interface Auditor {
    record(entry: Omit<AuditEntry, 'at'>): void;
    query(q: AuditQuery): Promise<AuditResult>;
    subscribe(listener: (entry: AuditEntry) => void): () => void;
    /** JSONL append; failures degrade to the in-memory ring plus a warning. */
    flush(): Promise<void>;
}
export interface AuditOptions {
    /** `auditFile` from the effective configuration (already absolute). */
    file: string;
    /** Shared redactor: every entry passes through it before it is observable. */
    redactor: Redactor;
    logger?: {
        warn(message: string, fields?: Record<string, unknown>): void;
    } | undefined;
    /** Entries retained in memory for `query`. Default 2000. */
    maxMemoryEntries?: number;
    /** Rotation threshold for the JSONL file. Default 8 MiB. */
    maxBytes?: number;
}
/** The auditor plus the extras the endpoint layer needs (ICD §4.6). */
export interface SshAuditor extends Auditor {
    readonly file: string;
    /** Entries currently retained in memory. */
    readonly size: number;
    /** Entries evicted from memory (still on disk) since construction. */
    readonly dropped: number;
    /** Records that could not be appended yet; retried by `flush()`. */
    readonly pending: number;
    /** `sshPlugin/clearAudit`: empty the ring and remove the file. */
    clear(): Promise<number>;
}
export declare class SshAuditorImpl implements SshAuditor {
    readonly file: string;
    private readonly redactor;
    private readonly logger;
    private readonly writer;
    private readonly maxMemoryEntries;
    private entries;
    private listeners;
    private pendingEntries;
    private hydrated;
    private droppedCount;
    constructor(options: AuditOptions);
    get size(): number;
    get dropped(): number;
    get pending(): number;
    /**
     * Record one event. Never throws and never blocks: this is called from the
     * middle of connection, exec and transfer paths where an observability failure
     * must be invisible.
     */
    record(entry: Omit<AuditEntry, 'at'>): void;
    query(q?: AuditQuery): Promise<AuditResult>;
    subscribe(listener: (entry: AuditEntry) => void): () => void;
    flush(): Promise<void>;
    clear(): Promise<number>;
    private push;
    private notify;
    /**
     * Read the tail of the file into the ring, once, when the ring is empty.
     *
     * A plugin reload (or a fresh process) loses the in-memory history but not the
     * file; hydrating on the first query is what keeps the audit tab useful after a
     * restart without paying a file read on every query.
     */
    private ensureHydrated;
}
/** Create the auditor (one per plugin activation). */
export declare function createAuditor(options: AuditOptions): SshAuditorImpl;
//# sourceMappingURL=audit.d.ts.map