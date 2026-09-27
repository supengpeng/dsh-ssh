/**
 * Agent-tool registration.
 *
 * The model-facing surface (`ssh_exec`, `ssh_upload`, `ssh_download`,
 * `ssh_list_dir`) is registered here rather than in the plugin shell, because it
 * needs the same object graph the endpoints use — the exec service, the session
 * registry, the SFTP client and the transfer manager.
 *
 * Registration is deliberately **best-effort**, for three separate reasons:
 *
 *   - a composition may not expose a tool registry at all (the plugin row must
 *     still load and still serve the UI);
 *   - `config.allowAgentTools` may be false (an operator who wants the GUI but not
 *     model access) — that is a decision, not a failure;
 *   - a factory listed in `config.tools` may not exist yet. Skipping it with a
 *     warning keeps the remaining tools available; throwing would take the whole
 *     plugin down over an unimplemented tool.
 *
 * Every skip is reported through `skipped`, so the shell can log a truthful
 * "registered 3 of 5 tools, here is why" line instead of a silent subset.
 */
import type { ResolvedConfig } from '../config.js';
import type { PluginLogger } from '../logger.js';
import type { SshAuditor } from '../audit.js';
import type { ActivityFeed } from '../activity/feed.js';
import type { ConnectionPool } from '../connection/index.js';
import type { SessionRegistry } from '../sessions.js';
import type { ExecService } from '../exec/service.js';
import type { TransferManager } from '../sftp/manager.js';
import type { LocalApi } from './local-api.js';
import type { RuntimeContext } from './runtime.js';
export interface ToolRegistration {
    /** Tool names actually registered, in configuration order. */
    registered: string[];
    /** Names that were not registered, with a human-readable reason. */
    skipped: Array<{
        name: string;
        reason: string;
    }>;
    dispose(): void;
}
export interface ToolRegistrationOptions {
    ctx: RuntimeContext;
    config: ResolvedConfig;
    exec: ExecService;
    pool: ConnectionPool;
    registry: SessionRegistry;
    transfers: TransferManager;
    audit: SshAuditor;
    /**
     * The agent-activity mirror (ICD §4.7).
     *
     * Passed to the tools rather than recorded here, because only the tool knows
     * what it is about to do (the command, the paths, the resolved session) and only
     * the tool sees the live frames while it waits. This layer's job stays what it
     * was: register the tools and audit what they finished.
     */
    activity: ActivityFeed;
    log: PluginLogger;
    /**
     * The session/profile endpoints, so `ssh_connect` takes exactly the same path as
     * `sshPlugin/connect` (audit, host-key prompt, pool reuse) instead of growing a
     * second implementation inside a tool.
     */
    api: LocalApi;
}
export declare function registerAgentTools(options: ToolRegistrationOptions): ToolRegistration;
//# sourceMappingURL=tools.d.ts.map