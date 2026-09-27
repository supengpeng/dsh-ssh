/**
 * `LocalApi` — the endpoint facade `src/service.ts` delegates to.
 *
 * `SshPluginService` owns the `@Remote` decorators (the Gateway's source-mode
 * discovery reads them off that class's prototype, so they cannot move); this
 * object owns the implementations, grouped by ICD section:
 *
 *     profiles  §4.2      sessions  §4.3      exec  §4.4
 *     files     §4.5      audit     §4.6      getConfig §4.1
 *
 * The split is deliberate: it keeps the wire table a thin, auditable list of
 * "decode → delegate → encode" methods, and it lets an endpoint test drive a group
 * directly (with a plain object) while the browser path still goes through
 * `src/api/params.ts`.
 */
import { type PublicConfig } from '../config.js';
import { AuditApi } from './audit-api.js';
import { ExecApi } from './exec-api.js';
import { FilesApi } from './files-api.js';
import { ProfilesApi } from './profiles.js';
import { SessionsApi } from './sessions.js';
import type { ApiDeps } from './deps.js';
export declare class LocalApi {
    readonly profiles: ProfilesApi;
    readonly sessions: SessionsApi;
    readonly exec: ExecApi;
    readonly files: FilesApi;
    readonly audit: AuditApi;
    /** Kept for diagnostics and for the tools layer; never handed to the wire. */
    readonly deps: ApiDeps;
    constructor(deps: ApiDeps);
    /** ICD §4.1 `getConfig`: the public projection (never a credential). */
    getConfig(): PublicConfig;
}
export type { ApiDeps };
//# sourceMappingURL=local-api.d.ts.map