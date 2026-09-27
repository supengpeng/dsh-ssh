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

import type { AuditEntry } from './protocol.js'
import { JsonlWriter } from './logger.js'
import type { Redactor } from './redact.js'

export interface AuditQuery {
  /** Page size; defaults to 100 and is clamped to 1000. */
  limit?: number
  offset?: number
  /** Only entries produced by this session. */
  sessionId?: string
  /** ISO timestamp; entries at or after it are returned. */
  since?: string
  /** Operation names to keep (`AuditEntry.op`); an empty array means "no filter". */
  kinds?: string[]
}

export interface AuditResult {
  /** Newest first. */
  entries: AuditEntry[]
  /** Matches before pagination (bounded by what the ring retains). */
  total: number
}

/** ICD §7.3 frozen interface. */
export interface Auditor {
  record(entry: Omit<AuditEntry, 'at'>): void
  query(q: AuditQuery): Promise<AuditResult>
  subscribe(listener: (entry: AuditEntry) => void): () => void
  /** JSONL append; failures degrade to the in-memory ring plus a warning. */
  flush(): Promise<void>
}

export interface AuditOptions {
  /** `auditFile` from the effective configuration (already absolute). */
  file: string
  /** Shared redactor: every entry passes through it before it is observable. */
  redactor: Redactor
  logger?: { warn(message: string, fields?: Record<string, unknown>): void } | undefined
  /** Entries retained in memory for `query`. Default 2000. */
  maxMemoryEntries?: number
  /** Rotation threshold for the JSONL file. Default 8 MiB. */
  maxBytes?: number
}

/** The auditor plus the extras the endpoint layer needs (ICD §4.6). */
export interface SshAuditor extends Auditor {
  readonly file: string
  /** Entries currently retained in memory. */
  readonly size: number
  /** Entries evicted from memory (still on disk) since construction. */
  readonly dropped: number
  /** Records that could not be appended yet; retried by `flush()`. */
  readonly pending: number
  /** `sshPlugin/clearAudit`: empty the ring and remove the file. */
  clear(): Promise<number>
}

const DEFAULT_MEMORY_ENTRIES = 2000
const MAX_PENDING = 512
const MAX_PAGE = 1000

function cloneEntry(entry: AuditEntry): AuditEntry {
  return {
    ...entry,
    ...(entry.target === undefined ? {} : { target: { ...entry.target } }),
    ...(entry.detail === undefined ? {} : { detail: { ...entry.detail } }),
  }
}

/** A record that parsed as JSON but is not an `AuditEntry` is not returned. */
function isAuditEntry(value: unknown): value is AuditEntry {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as { at?: unknown; op?: unknown }
  return typeof candidate.at === 'string' && typeof candidate.op === 'string'
}

export class SshAuditorImpl implements SshAuditor {
  readonly file: string
  private readonly redactor: Redactor
  private readonly logger: AuditOptions['logger']
  private readonly writer: JsonlWriter
  private readonly maxMemoryEntries: number
  private entries: AuditEntry[] = []
  private listeners = new Set<(entry: AuditEntry) => void>()
  private pendingEntries: AuditEntry[] = []
  private hydrated = false
  private droppedCount = 0

  constructor(options: AuditOptions) {
    this.file = options.file
    this.redactor = options.redactor
    this.logger = options.logger
    this.maxMemoryEntries = Math.max(1, Math.trunc(options.maxMemoryEntries ?? DEFAULT_MEMORY_ENTRIES))
    this.writer = new JsonlWriter(options.file, options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes })
  }

  get size(): number {
    return this.entries.length
  }

  get dropped(): number {
    return this.droppedCount
  }

  get pending(): number {
    return this.pendingEntries.length
  }

  /**
   * Record one event. Never throws and never blocks: this is called from the
   * middle of connection, exec and transfer paths where an observability failure
   * must be invisible.
   */
  record(entry: Omit<AuditEntry, 'at'>): void {
    let safe: AuditEntry
    try {
      const stamped = { ...entry, at: new Date().toISOString() } as AuditEntry
      safe = this.redactor.scrub(stamped) as AuditEntry
    } catch {
      // A redaction failure must not lose the event; fall back to a value-free
      // record rather than writing something that was never scrubbed.
      safe = {
        at: new Date().toISOString(),
        op: typeof entry?.op === 'string' && entry.op !== '' ? entry.op : 'unknown',
        outcome: 'error',
        detail: { redactionFailed: true },
      }
    }
    this.push(safe)
    if (!this.writer.append(safe) && this.pendingEntries.length < MAX_PENDING) {
      this.pendingEntries.push(safe)
    }
    this.notify(safe)
  }

  async query(q: AuditQuery = {}): Promise<AuditResult> {
    this.ensureHydrated()
    const limit = Math.min(MAX_PAGE, Math.max(1, Math.trunc(q.limit ?? 100)))
    const offset = Math.max(0, Math.trunc(q.offset ?? 0))
    const sessionId = typeof q.sessionId === 'string' && q.sessionId !== '' ? q.sessionId : undefined
    const kinds = Array.isArray(q.kinds) && q.kinds.length > 0 ? new Set(q.kinds.filter((kind) => typeof kind === 'string')) : undefined
    const sinceMs = typeof q.since === 'string' ? Date.parse(q.since) : Number.NaN
    const hasSince = Number.isFinite(sinceMs)

    const matches: AuditEntry[] = []
    // Newest first: the UI's default view is "what just happened".
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index]
      if (entry === undefined) continue
      if (sessionId !== undefined && entry.sessionId !== sessionId) continue
      if (kinds !== undefined && !kinds.has(entry.op)) continue
      if (hasSince) {
        const at = Date.parse(entry.at)
        if (!Number.isFinite(at) || at < sinceMs) continue
      }
      matches.push(cloneEntry(entry))
    }
    return { entries: matches.slice(offset, offset + limit), total: matches.length }
  }

  subscribe(listener: (entry: AuditEntry) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async flush(): Promise<void> {
    if (this.pendingEntries.length === 0) return
    const retry = this.pendingEntries
    this.pendingEntries = []
    for (const entry of retry) {
      if (!this.writer.append(entry) && this.pendingEntries.length < MAX_PENDING) {
        this.pendingEntries.push(entry)
      }
    }
  }

  async clear(): Promise<number> {
    const removed = this.entries.length
    this.entries = []
    this.pendingEntries = []
    this.droppedCount = 0
    this.writer.truncate()
    return removed
  }

  // ── internals ────────────────────────────────────────────────────────────

  private push(entry: AuditEntry): void {
    this.entries.push(entry)
    while (this.entries.length > this.maxMemoryEntries) {
      this.entries.shift()
      this.droppedCount += 1
    }
  }

  private notify(entry: AuditEntry): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(cloneEntry(entry))
      } catch (error) {
        // A broken `followAudit` consumer must not break the SSH operation that
        // produced the entry.
        this.logger?.warn('audit subscriber failed', { reason: error instanceof Error ? error.message : String(error) })
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
  private ensureHydrated(): void {
    if (this.hydrated) return
    this.hydrated = true
    if (this.entries.length > 0) return
    const lines = this.writer.readTail({ limit: this.maxMemoryEntries })
    for (const line of lines) {
      try {
        const parsed: unknown = JSON.parse(line)
        if (!isAuditEntry(parsed)) continue
        const entry = parsed
        this.push(entry)
      } catch {
        /* a partially written line (crash, rotation) is skipped */
      }
    }
  }
}

/** Create the auditor (one per plugin activation). */
export function createAuditor(options: AuditOptions): SshAuditorImpl {
  return new SshAuditorImpl(options)
}
