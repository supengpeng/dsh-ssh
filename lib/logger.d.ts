/**
 * Structured plugin logging: one JSON object per line on disk, one compact line
 * into the host composition's logger, and every field scrubbed on the way out.
 *
 * Two constraints shape this module:
 *
 *   - **Observability must never break the operation it observes.** Every write
 *     is wrapped, a full disk or a locked file degrades to "the host logger still
 *     got the line", and nothing here ever throws into an SSH call.
 *   - **A log line is the most likely place for a secret to escape.** Records are
 *     redacted as they are built, not by the caller, so a new call site cannot
 *     forget to do it (see `src/redact.ts`).
 *
 * {@link JsonlWriter} is exported because the audit log (`src/audit.ts`) needs
 * exactly the same durability rules — append-only JSONL, best-effort, rotated in
 * place — and duplicating them would let the two drift apart.
 */
import type { ResolvedConfig } from './config.js';
import { type Redactor } from './redact.js';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
/** Ordered from least to most severe; the index is the threshold comparison. */
export declare const LOG_LEVELS: readonly LogLevel[];
/** True when a message at `level` passes a logger configured at `threshold`. */
export declare function shouldLog(level: LogLevel, threshold: LogLevel): boolean;
/**
 * The subset of the host's logger this plugin uses. Declared structurally rather
 * than imported from `service.ts` so the security modules stay independent of the
 * service face (and so they keep compiling while that face moves).
 */
export interface HostLoggerFace {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}
export declare const DEFAULT_LOG_FILE_NAME = "plugin.jsonl";
/**
 * Append-only JSONL file with in-place rotation.
 *
 * Every method is best-effort: `append` reports failure with `false` instead of
 * throwing, so callers that must not fail (the audit log) can buffer and retry,
 * and callers that simply want a log line can ignore it.
 */
export declare class JsonlWriter {
    readonly file: string;
    private readonly maxBytes;
    private bytes;
    private sized;
    private writable;
    constructor(file: string, options?: {
        maxBytes?: number;
    });
    /** Append one already-serialised line; a trailing newline is added if absent. */
    appendLine(line: string): boolean;
    /** Append one JSON record; returns false when the record could not be written. */
    append(record: unknown): boolean;
    /** Current file size in bytes (0 when the file cannot be read). */
    size(): number;
    /**
     * The last lines of the file as text, oldest first.
     *
     * Reads at most `maxBytes` from the tail rather than the whole file: audit
     * queries only need recent history to answer, and an 8 MiB log must not be
     * pulled into memory on every call.
     */
    readTail(options?: {
        maxBytes?: number;
        limit?: number;
    }): string[];
    /** Remove the file (audit "clear"); the next append recreates it. */
    truncate(): boolean;
    private rotateIfNeeded;
}
export interface LoggerOptions {
    /** Effective plugin configuration; supplies level, redaction and the log path. */
    config: ResolvedConfig;
    /** The host composition's logger, when there is one. */
    host?: HostLoggerFace;
    /** Initial scope, e.g. `ssh` or `ssh.connection`. */
    scope?: string;
    /** Shared redactor; the caller owns its lifetime (`track` on connect). */
    redactor?: Redactor;
    /** Override the log file (tests); defaults to `<DSH_HOME>/logs/dsh-ssh/plugin.jsonl`. */
    file?: string;
    maxBytes?: number;
    now?: () => Date;
}
export interface PluginLogger {
    readonly scope: string;
    readonly level: LogLevel;
    readonly redactor: Redactor;
    readonly file: string;
    /** Whether a message at `level` would be written. */
    enabled(level: LogLevel): boolean;
    debug(message: string, fields?: Record<string, unknown>): void;
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
    error(message: string, fields?: Record<string, unknown>): void;
    /** A logger with `parent.scope.child`, sharing level, redactor and file. */
    child(scope: string): PluginLogger;
    /** Durability gate: resolved once every pending line was offered to the disk. */
    flush(): Promise<void>;
    /** Structural twin of `service.ts`'s `ServiceLogger`, for `ctx.logger` handover. */
    toServiceLogger(): HostLoggerFace;
}
/** Create the plugin logger. One instance per plugin activation. */
export declare function createLogger(options: LoggerOptions): PluginLogger;
/** Default log file for a DSH home; equals `dirname(<auditFile>)/plugin.jsonl`. */
export declare function defaultLogFile(dshHome: string): string;
//# sourceMappingURL=logger.d.ts.map