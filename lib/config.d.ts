/**
 * Plugin configuration: the Schemastery schema the Loader validates this row's
 * `config` against, plus the resolution step that turns it into absolute paths
 * and effective values.
 *
 * Every default lives in the schema (not in `apply`), so `dsh --dump-config`,
 * `Config.listConfigs` and the Settings UI all show the same effective values,
 * and deleting a line from `cordis.patch.yml` cannot change behaviour.
 */
import z from '@deepseek-ai/schemastery';
import type { HostKeyPolicy } from './protocol.js';
/**
 * The Schemastery schema.
 *
 * Annotated as `z<Config>` rather than left inferred: the inferred type of
 * `z.object({...})` is not nameable from a portable path (it resolves through
 * pnpm's `.pnpm/` store), and `declaration: true` then fails with TS2742 — which
 * would block the whole package's `lib/` emit, and with it the plugin's update in
 * a running GUI. The annotation also states the contract: this schema *is* the
 * runtime validator for `Config` below.
 */
export declare const Config: z<Config>;
/**
 * Effective plugin configuration.
 *
 * Written by hand rather than inferred from the schema: the schema is the
 * runtime contract the Loader validates, this interface is the compile-time one
 * every module consumes, and `test/unit/config.test.mjs` asserts the schema
 * still produces every key declared here with the declared default.
 */
export interface Config {
    profilesFile: string;
    auditFile: string;
    maxSessions: number;
    maxConcurrentOpsPerSession: number;
    maxOutputBytes: number;
    maxReplayFrames: number;
    connectTimeoutMs: number;
    operationTimeoutMs: number;
    graceKillMs: number;
    keepaliveIntervalMs: number;
    keepaliveCountMax: number;
    retries: RetryConfig;
    hostKey: HostKeyConfig;
    sftp: SftpConfig;
    secrets: SecretsConfig;
    logging: LoggingConfig;
    activity: ActivityConfig;
    confirmDangerous: boolean;
    allowAgentTools: boolean;
    tools: string[];
    ui: UiConfig;
}
export interface RetryConfig {
    max: number;
    backoffBaseMs: number;
    backoffMaxMs: number;
    jitter: boolean;
}
export interface HostKeyConfig {
    policy: HostKeyPolicy;
    knownHostsFile: string;
}
export interface SftpConfig {
    chunkBytes: number;
    maxConcurrentChunks: number;
    resume: boolean;
    verify: 'none' | 'size+mtime' | 'sha256';
    followSymlinks: boolean;
    progressIntervalMs: number;
}
export interface SecretsConfig {
    provider: 'credentials' | 'env';
    envPrefix: string;
}
export interface LoggingConfig {
    level: 'debug' | 'info' | 'warn' | 'error';
    redact: boolean;
    redactKeys: string[];
}
/** The agent-activity mirror's limits (ICD §4.7, §6). */
export interface ActivityConfig {
    enabled: boolean;
    maxRecords: number;
    maxRecordBytes: number;
    maxTotalBytes: number;
}
export interface UiConfig {
    defaultWidthPx: number;
    locale: 'auto' | 'zh' | 'en';
    terminalFontSize: number;
    reconnectAttempts: number;
}
/** Configuration with every path resolved and every value clamped. */
export interface ResolvedConfig extends Config {
    readonly dshHome: string;
    readonly profilesFile: string;
    readonly auditFile: string;
    readonly knownHostsFile: string;
}
/**
 * The projection `sshPlugin/getConfig` returns (ICD §6 "对外投影").
 *
 * `secrets` keeps only `{ provider, envPrefix }` — it already carries nothing else
 * — and `logging.redactKeys` is dropped, because the list of key names the plugin
 * treats as secret-shaped is internal detail a client has no use for. Paths stay:
 * an operator debugging "where is my profile file?" needs them, and a path is not
 * a credential.
 */
export interface PublicConfig extends Omit<ResolvedConfig, 'logging'> {
    logging: Omit<LoggingConfig, 'redactKeys'>;
}
/** Strip the non-public configuration detail; never returns a credential. */
export declare function toPublicConfig(config: ResolvedConfig): PublicConfig;
/** DSH home resolves exactly as the host does: $DSH_HOME, else ~/.dsh. */
export declare function resolveDshHome(env?: NodeJS.ProcessEnv): string;
/**
 * Apply defaults that depend on the environment, and clamp unsafe values.
 *
 * Clamping (rather than rejecting) is deliberate: a typo such as
 * `maxSessions: 0` must not make the plugin unloadable — the plugin instead runs
 * with the nearest safe value and the operator sees the effective value in
 * `--dump-config` and in the Settings UI.
 */
export declare function resolveConfig(config: Config, env?: NodeJS.ProcessEnv): ResolvedConfig;
/** Policy value the connection layer consumes. */
export declare function hostKeyPolicyOf(config: ResolvedConfig): HostKeyPolicy;
//# sourceMappingURL=config.d.ts.map