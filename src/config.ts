/**
 * Plugin configuration: the Schemastery schema the Loader validates this row's
 * `config` against, plus the resolution step that turns it into absolute paths
 * and effective values.
 *
 * Every default lives in the schema (not in `apply`), so `dsh --dump-config`,
 * `Config.listConfigs` and the Settings UI all show the same effective values,
 * and deleting a line from `cordis.patch.yml` cannot change behaviour.
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'

import type { HostKeyPolicy } from './protocol.js'

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
export const Config: z<Config> = z.object({
  // ── Storage ──────────────────────────────────────────────────────────────
  /** Connection-profile store; '' = <DSH_HOME>/dsh-ssh/profiles.json. */
  profilesFile: z.string().default(''),
  /** Audit log (JSONL); '' = <DSH_HOME>/logs/dsh-ssh/audit.jsonl. */
  auditFile: z.string().default(''),

  // ── Limits ───────────────────────────────────────────────────────────────
  /** Maximum concurrent live sessions; matches the 10-session acceptance run. */
  maxSessions: z.number().default(10),
  /** Concurrent operations allowed on one session before the queue refuses. */
  maxConcurrentOpsPerSession: z.number().default(4),
  /** Bytes of stdout/stderr kept per command before head+tail truncation. */
  maxOutputBytes: z.number().default(262144),

  // ── Time ─────────────────────────────────────────────────────────────────
  connectTimeoutMs: z.number().default(15000),
  operationTimeoutMs: z.number().default(120000),
  /** Grace period between SIGTERM and SIGKILL when a command times out. */
  graceKillMs: z.number().default(3000),
  keepaliveIntervalMs: z.number().default(20000),
  keepaliveCountMax: z.number().default(3),

  // ── Retry ────────────────────────────────────────────────────────────────
  retries: z
    .object({
      max: z.number().default(2),
      backoffBaseMs: z.number().default(500),
      backoffMaxMs: z.number().default(5000),
      jitter: z.boolean().default(true),
    })
    .default({}),

  // ── Host keys ────────────────────────────────────────────────────────────
  hostKey: z
    .object({
      policy: z.union([z.const('strict'), z.const('accept-new'), z.const('insecure')]).default('accept-new'),
      /** '' = <DSH_HOME>/known_hosts. */
      knownHostsFile: z.string().default(''),
    })
    .default({}),

  // ── SFTP ─────────────────────────────────────────────────────────────────
  sftp: z
    .object({
      chunkBytes: z.number().default(262144),
      maxConcurrentChunks: z.number().default(4),
      resume: z.boolean().default(true),
      verify: z.union([z.const('none'), z.const('size+mtime'), z.const('sha256')]).default('size+mtime'),
      followSymlinks: z.boolean().default(false),
      /** Progress frames are coalesced to this cadence (also ≥1 MiB). */
      progressIntervalMs: z.number().default(200),
    })
    .default({}),

  // ── Secrets ──────────────────────────────────────────────────────────────
  secrets: z
    .object({
      provider: z.union([z.const('credentials'), z.const('env')]).default('credentials'),
      envPrefix: z.string().default('DSH_SSH_'),
    })
    .default({}),

  // ── Logging ──────────────────────────────────────────────────────────────
  logging: z
    .object({
      level: z.union([z.const('debug'), z.const('info'), z.const('warn'), z.const('error')]).default('info'),
      redact: z.boolean().default(true),
      redactKeys: z
        .array(z.string())
        .default(['password', 'passphrase', 'privateKey', 'secret', 'token', 'key', 'authorization']),
    })
    .default({}),

  // ── Governance ───────────────────────────────────────────────────────────
  /** Destructive operations (delete/overwrite) ask for confirmation in the UI. */
  confirmDangerous: z.boolean().default(true),
  /** Register the model-facing `ssh_*` tools (ICD §0; `dsh.plugin.json` mirrors this list). */
  allowAgentTools: z.boolean().default(true),
  tools: z
    .array(z.string())
    .default([
      // Order matters: the connection tools come first because every other tool
      // needs a `sessionId`, which only `ssh_sessions`/`ssh_connect` can produce.
      'ssh_connect',
      'ssh_disconnect',
      'ssh_sessions',
      'ssh_exec',
      'ssh_upload',
      'ssh_download',
      'ssh_list_dir',
    ]),

  // ── UI ───────────────────────────────────────────────────────────────────
  ui: z
    .object({
      defaultWidthPx: z.number().default(420),
      locale: z.union([z.const('auto'), z.const('zh'), z.const('en')]).default('auto'),
      terminalFontSize: z.number().default(13),
      reconnectAttempts: z.number().default(5),
    })
    .default({}),
})

/**
 * Effective plugin configuration.
 *
 * Written by hand rather than inferred from the schema: the schema is the
 * runtime contract the Loader validates, this interface is the compile-time one
 * every module consumes, and `test/unit/config.test.mjs` asserts the schema
 * still produces every key declared here with the declared default.
 */
export interface Config {
  profilesFile: string
  auditFile: string
  maxSessions: number
  maxConcurrentOpsPerSession: number
  maxOutputBytes: number
  connectTimeoutMs: number
  operationTimeoutMs: number
  graceKillMs: number
  keepaliveIntervalMs: number
  keepaliveCountMax: number
  retries: RetryConfig
  hostKey: HostKeyConfig
  sftp: SftpConfig
  secrets: SecretsConfig
  logging: LoggingConfig
  confirmDangerous: boolean
  allowAgentTools: boolean
  tools: string[]
  ui: UiConfig
}

export interface RetryConfig {
  max: number
  backoffBaseMs: number
  backoffMaxMs: number
  jitter: boolean
}

export interface HostKeyConfig {
  policy: HostKeyPolicy
  knownHostsFile: string
}

export interface SftpConfig {
  chunkBytes: number
  maxConcurrentChunks: number
  resume: boolean
  verify: 'none' | 'size+mtime' | 'sha256'
  followSymlinks: boolean
  progressIntervalMs: number
}

export interface SecretsConfig {
  provider: 'credentials' | 'env'
  envPrefix: string
}

export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error'
  redact: boolean
  redactKeys: string[]
}

export interface UiConfig {
  defaultWidthPx: number
  locale: 'auto' | 'zh' | 'en'
  terminalFontSize: number
  reconnectAttempts: number
}

/** Configuration with every path resolved and every value clamped. */
export interface ResolvedConfig extends Config {
  readonly dshHome: string
  readonly profilesFile: string
  readonly auditFile: string
  readonly knownHostsFile: string
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
  logging: Omit<LoggingConfig, 'redactKeys'>
}

/** Strip the non-public configuration detail; never returns a credential. */
export function toPublicConfig(config: ResolvedConfig): PublicConfig {
  const { logging, ...rest } = config
  return { ...rest, logging: { level: logging.level, redact: logging.redact } }
}

/** DSH home resolves exactly as the host does: $DSH_HOME, else ~/.dsh. */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['DSH_HOME']
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured)
  return join(homedir(), '.dsh')
}

function absoluteOr(base: string, candidate: string, fallback: string): string {
  const value = candidate.trim() === '' ? fallback : candidate
  return isAbsolute(value) ? value : resolve(base, value)
}

/** Clamp an integer into a range, treating a non-number as the fallback. */
function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/**
 * Apply defaults that depend on the environment, and clamp unsafe values.
 *
 * Clamping (rather than rejecting) is deliberate: a typo such as
 * `maxSessions: 0` must not make the plugin unloadable — the plugin instead runs
 * with the nearest safe value and the operator sees the effective value in
 * `--dump-config` and in the Settings UI.
 */
export function resolveConfig(config: Config, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const dshHome = resolveDshHome(env)
  const knownHostsFile = absoluteOr(dshHome, config.hostKey.knownHostsFile, join(dshHome, 'known_hosts'))
  return {
    ...config,
    dshHome,
    profilesFile: absoluteOr(dshHome, config.profilesFile, join(dshHome, 'dsh-ssh', 'profiles.json')),
    auditFile: absoluteOr(dshHome, config.auditFile, join(dshHome, 'logs', 'dsh-ssh', 'audit.jsonl')),
    // Both spellings carry the resolved path: `knownHostsFile` is the convenience
    // alias, `hostKey.knownHostsFile` is the field the ICD documents, and a
    // consumer reading the documented one must not get '' and silently fall back
    // to a path of its own invention.
    knownHostsFile,
    hostKey: { ...config.hostKey, knownHostsFile },
    maxSessions: clampInt(config.maxSessions, 1, 1000),
    maxConcurrentOpsPerSession: clampInt(config.maxConcurrentOpsPerSession, 1, 64),
    maxOutputBytes: clampInt(config.maxOutputBytes, 1024, 64 * 1024 * 1024),
    connectTimeoutMs: clampInt(config.connectTimeoutMs, 1000, 600000),
    operationTimeoutMs: clampInt(config.operationTimeoutMs, 1000, 3600000),
    graceKillMs: clampInt(config.graceKillMs, 0, 60000),
    keepaliveIntervalMs: clampInt(config.keepaliveIntervalMs, 0, 600000),
    keepaliveCountMax: clampInt(config.keepaliveCountMax, 1, 100),
    retries: {
      max: clampInt(config.retries.max, 0, 10),
      backoffBaseMs: clampInt(config.retries.backoffBaseMs, 0, 60000),
      backoffMaxMs: clampInt(config.retries.backoffMaxMs, 0, 600000),
      jitter: config.retries.jitter === true,
    },
    sftp: {
      ...config.sftp,
      chunkBytes: clampInt(config.sftp.chunkBytes, 4096, 8 * 1024 * 1024),
      maxConcurrentChunks: clampInt(config.sftp.maxConcurrentChunks, 1, 32),
      progressIntervalMs: clampInt(config.sftp.progressIntervalMs, 50, 10000),
    },
    ui: {
      ...config.ui,
      defaultWidthPx: clampInt(config.ui.defaultWidthPx, 280, 2000),
      terminalFontSize: clampInt(config.ui.terminalFontSize, 8, 32),
      reconnectAttempts: clampInt(config.ui.reconnectAttempts, 0, 100),
    },
  }
}

/** Policy value the connection layer consumes. */
export function hostKeyPolicyOf(config: ResolvedConfig): HostKeyPolicy {
  return config.hostKey.policy
}
