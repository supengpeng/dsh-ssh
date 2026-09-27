/**
 * §4.6 audit endpoints.
 *
 * The auditor is the only component that may *read* audit history, and it answers
 * from a bounded in-memory ring that it hydrates from the tail of the JSONL file
 * on first use — so the audit tab is useful immediately after a plugin reload,
 * without re-reading an 8 MiB file on every query.
 *
 * `queryAudit` therefore documents one honest limit: `total` counts matches inside
 * what the ring retains, not every line ever written. The file keeps the full
 * history (and rotates at 8 MiB), which is what the "export" button in the UI
 * reads.
 */
import type { AuditEntry, Frame } from '../protocol.js';
import { ApiGroup } from './deps.js';
export declare class AuditApi extends ApiGroup {
    /** ICD §4.6 `queryAudit`. */
    query(raw: unknown): Promise<{
        entries: AuditEntry[];
        total: number;
    }>;
    /**
     * ICD §4.6 `followAudit` (stream `audit` frames).
     *
     * No snapshot is replayed: the client calls `queryAudit` first and then
     * subscribes, and a subscriber that received history would double-render it.
     * A subscriber that attaches between the two calls is the very race the ICD's
     * `since` parameter on `queryAudit` exists for.
     */
    follow(raw: unknown): AsyncGenerator<Frame, void, undefined>;
    /** ICD §4.6 `clearAudit`. */
    clear(): Promise<{
        cleared: number;
    }>;
}
//# sourceMappingURL=audit-api.d.ts.map