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
import { stringArrayJson, optionalNumber, optionalString, readParams } from './params.js';
import { ApiGroup } from './deps.js';
import { FrameQueue } from './frames.js';
export class AuditApi extends ApiGroup {
    /** ICD §4.6 `queryAudit`. */
    async query(raw) {
        const { params } = readParams(raw);
        const limit = optionalNumber(params, 'limit');
        const offset = optionalNumber(params, 'offset');
        const sessionId = optionalString(params, 'sessionId');
        const since = optionalString(params, 'since');
        const kinds = stringArrayJson(params, 'kinds');
        return this.deps.audit.query({
            ...(limit === undefined ? {} : { limit }),
            ...(offset === undefined ? {} : { offset }),
            ...(sessionId === undefined ? {} : { sessionId }),
            ...(since === undefined ? {} : { since }),
            ...(kinds === undefined ? {} : { kinds }),
        });
    }
    /**
     * ICD §4.6 `followAudit` (stream `audit` frames).
     *
     * No snapshot is replayed: the client calls `queryAudit` first and then
     * subscribes, and a subscriber that received history would double-render it.
     * A subscriber that attaches between the two calls is the very race the ICD's
     * `since` parameter on `queryAudit` exists for.
     */
    async *follow(raw) {
        const { params } = readParams(raw);
        const filter = optionalString(params, 'sessionId');
        const queue = new FrameQueue();
        const unsubscribe = this.deps.audit.subscribe((entry) => {
            if (filter !== undefined && entry.sessionId !== filter)
                return;
            queue.push({ t: 'audit', entry });
        });
        try {
            for await (const frame of queue)
                yield frame;
        }
        finally {
            unsubscribe();
        }
    }
    /** ICD §4.6 `clearAudit`. */
    async clear() {
        const cleared = await this.deps.audit.clear();
        this.auditOutcome('clearAudit', 'ok', { cleared });
        return { cleared };
    }
}
//# sourceMappingURL=audit-api.js.map