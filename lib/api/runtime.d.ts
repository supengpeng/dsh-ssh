/**
 * `createHostRuntime` — the plugin's object graph.
 *
 * The shell (`src/index.ts`) owns the plugin envelope: `name`, `inject`, the
 * config schema, `apply`, the `ctx.effect` lifecycle and service registration.
 * This module owns everything *inside* that envelope: who is constructed with
 * what, which module a Remote endpoint delegates to, and what teardown means.
 * Keeping the graph on this side of one function is what lets the endpoint layer,
 * the connection pool and the security modules evolve without the shell turning
 * into a second composition root.
 *
 * Construction rules, in order:
 *
 *   1. **One redactor, shared by everything.** `createRedactor` comes first and is
 *      handed to the logger, the auditor, the session registry, the credential
 *      resolver and the connection pool — so a secret registered by one is masked
 *      by all of them. Creating a second redactor anywhere would silently split
 *      that guarantee.
 *   2. **The logger takes the *resolved* config**, not the raw one: its file path
 *      is derived from `dirname(config.auditFile)`, which only exists after
 *      `resolveConfig()`.
 *   3. **Nothing here blocks.** No network, no directory scan, no file read on the
 *      activation path: the profile store and audit log open lazily on first use,
 *      because a plugin that takes a second to appear looks broken.
 *   4. **Activation is non-fatal.** A missing optional service (credentials, tools)
 *      degrades with a warning and a structured error on the affected endpoint;
 *      it never prevents the runtime from being built, because a row that fails to
 *      load tells the user nothing actionable.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ResolvedConfig } from '../config.js';
import { ActivityFeed } from '../activity/feed.js';
import { type SshAuditor } from '../audit.js';
import { type ConnectionPool } from '../connection/index.js';
import { type SshCredentialResolver } from '../credentials.js';
import { ExecService } from '../exec/service.js';
import { type KnownHostsVerifierImpl } from '../known-hosts.js';
import { type PluginLogger } from '../logger.js';
import { type Redactor } from '../redact.js';
import { type SessionRegistry } from '../sessions.js';
import { TransferManager } from '../sftp/index.js';
import { type ProfileStore } from '../store.js';
import { type ToolRegistration } from './tools.js';
/** What the plugin shell receives; the contract between `index.ts` and this module. */
export interface HostRuntime {
    /** The instance registered as `ctx.sshPlugin` (a real object with `@Remote` markers). */
    service: object;
    /** The runtime's logger, so the shell does not build a second one. */
    log: PluginLogger;
    /** Everything the runtime owns, for tests and for the shell's diagnostics. */
    parts: {
        config: ResolvedConfig;
        redactor: Redactor;
        store: ProfileStore;
        credentials: SshCredentialResolver;
        knownHosts: KnownHostsVerifierImpl;
        audit: SshAuditor;
        activity: ActivityFeed;
        pool: ConnectionPool;
        registry: SessionRegistry;
        exec: ExecService;
        transfers: TransferManager;
        tools: ToolRegistration;
    };
    /** Idempotent, never-throwing teardown. */
    dispose(): Promise<void>;
}
/** The slice of `ctx` this module reads. Structural, so a test can pass a stub. */
export interface RuntimeContext {
    get?(name: string): unknown;
    [key: string]: unknown;
}
export interface CreateHostRuntimeOptions {
    ctx: Context | RuntimeContext;
    config: ResolvedConfig;
}
/** Build the object graph. Never throws for a missing optional service. */
export declare function createHostRuntime(options: CreateHostRuntimeOptions): Promise<HostRuntime>;
//# sourceMappingURL=runtime.d.ts.map