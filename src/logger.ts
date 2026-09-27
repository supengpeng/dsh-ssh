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

import { appendFileSync, closeSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ResolvedConfig } from './config.js'
import { createRedactor, type Redactor } from './redact.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Ordered from least to most severe; the index is the threshold comparison. */
export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']

/** True when a message at `level` passes a logger configured at `threshold`. */
export function shouldLog(level: LogLevel, threshold: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(threshold)
}

/**
 * The subset of the host's logger this plugin uses. Declared structurally rather
 * than imported from `service.ts` so the security modules stay independent of the
 * service face (and so they keep compiling while that face moves).
 */
export interface HostLoggerFace {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export const DEFAULT_LOG_FILE_NAME = 'plugin.jsonl'

/** Bytes after which the current file is rotated to `<name>.1.jsonl`. */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024

/**
 * Append-only JSONL file with in-place rotation.
 *
 * Every method is best-effort: `append` reports failure with `false` instead of
 * throwing, so callers that must not fail (the audit log) can buffer and retry,
 * and callers that simply want a log line can ignore it.
 */
export class JsonlWriter {
  readonly file: string
  private readonly maxBytes: number
  private bytes: number
  private sized = false
  private writable = true

  constructor(file: string, options: { maxBytes?: number } = {}) {
    this.file = file
    this.maxBytes = Math.max(1024, Math.trunc(options.maxBytes ?? DEFAULT_MAX_BYTES))
    this.bytes = 0
  }

  /** Append one already-serialised line; a trailing newline is added if absent. */
  appendLine(line: string): boolean {
    if (!this.writable) return false
    try {
      const payload = line.endsWith('\n') ? line : `${line}\n`
      mkdirSync(dirname(this.file), { recursive: true })
      this.rotateIfNeeded(Buffer.byteLength(payload))
      appendFileSync(this.file, payload, 'utf8')
      this.bytes += Buffer.byteLength(payload)
      return true
    } catch {
      return false
    }
  }

  /** Append one JSON record; returns false when the record could not be written. */
  append(record: unknown): boolean {
    let line: string
    try {
      line = JSON.stringify(record)
    } catch {
      return false
    }
    if (typeof line !== 'string' || line === '') return false
    return this.appendLine(line)
  }

  /** Current file size in bytes (0 when the file cannot be read). */
  size(): number {
    if (!this.sized) {
      try {
        this.bytes = statSync(this.file).size
      } catch {
        this.bytes = 0
      }
      this.sized = true
    }
    return this.bytes
  }

  /**
   * The last lines of the file as text, oldest first.
   *
   * Reads at most `maxBytes` from the tail rather than the whole file: audit
   * queries only need recent history to answer, and an 8 MiB log must not be
   * pulled into memory on every call.
   */
  readTail(options: { maxBytes?: number; limit?: number } = {}): string[] {
    const limit = Math.max(1, Math.trunc(options.limit ?? 2000))
    const window = Math.max(4096, Math.trunc(options.maxBytes ?? 1024 * 1024))
    let fd: number | undefined
    try {
      const size = statSync(this.file).size
      const start = Math.max(0, size - window)
      const length = size - start
      if (length <= 0) return []
      const buffer = Buffer.alloc(length)
      fd = openSync(this.file, 'r')
      const read = readSync(fd, buffer, 0, length, start)
      const text = buffer.subarray(0, read).toString('utf8')
      const lines = text.split('\n')
      // A tail read can start mid-line; that partial line is not valid JSON.
      if (start > 0) lines.shift()
      return lines.filter((line) => line.trim() !== '').slice(-limit)
    } catch {
      return []
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          /* already closed by the failure path */
        }
      }
    }
  }

  /** Remove the file (audit "clear"); the next append recreates it. */
  truncate(): boolean {
    try {
      rmSync(this.file, { force: true })
      this.bytes = 0
      this.sized = true
      return true
    } catch {
      return false
    }
  }

  private rotateIfNeeded(incoming: number): void {
    this.size()
    if (this.bytes + incoming <= this.maxBytes) return
    try {
      const archived = this.file.replace(/\.jsonl$/, '.1.jsonl')
      if (archived !== this.file) {
        rmSync(archived, { force: true })
        renameSync(this.file, archived)
      }
    } catch {
      /* rotation is an optimisation: keep appending to the current file */
    }
    this.bytes = 0
  }
}

export interface LoggerOptions {
  /** Effective plugin configuration; supplies level, redaction and the log path. */
  config: ResolvedConfig
  /** The host composition's logger, when there is one. */
  host?: HostLoggerFace
  /** Initial scope, e.g. `ssh` or `ssh.connection`. */
  scope?: string
  /** Shared redactor; the caller owns its lifetime (`track` on connect). */
  redactor?: Redactor
  /** Override the log file (tests); defaults to `<DSH_HOME>/logs/dsh-ssh/plugin.jsonl`. */
  file?: string
  maxBytes?: number
  now?: () => Date
}

export interface PluginLogger {
  readonly scope: string
  readonly level: LogLevel
  readonly redactor: Redactor
  readonly file: string
  /** Whether a message at `level` would be written. */
  enabled(level: LogLevel): boolean
  debug(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
  /** A logger with `parent.scope.child`, sharing level, redactor and file. */
  child(scope: string): PluginLogger
  /** Durability gate: resolved once every pending line was offered to the disk. */
  flush(): Promise<void>
  /** Structural twin of `service.ts`'s `ServiceLogger`, for `ctx.logger` handover. */
  toServiceLogger(): HostLoggerFace
}

/** Longest human-readable field dump forwarded to the host logger. */
const HOST_LINE_LIMIT = 600

function compactFields(fields: Record<string, unknown> | undefined): string {
  if (fields === undefined) return ''
  let text: string
  try {
    text = JSON.stringify(fields)
  } catch {
    return ' [unserialisable fields]'
  }
  if (typeof text !== 'string' || text === '{}' || text === '') return ''
  return ` ${text.length > HOST_LINE_LIMIT ? `${text.slice(0, HOST_LINE_LIMIT)}…` : text}`
}

/** Create the plugin logger. One instance per plugin activation. */
export function createLogger(options: LoggerOptions): PluginLogger {
  const { config } = options
  const level = config.logging.level
  const redactor = options.redactor ?? createRedactor({ redactKeys: config.logging.redactKeys, enabled: config.logging.redact })
  // ICD §6 freezes exactly two paths: `profilesFile` and `auditFile`. The plugin's
  // own structured log therefore lives *beside* the audit log — one log directory
  // per plugin, and an operator who moves the audit file moves both. No new
  // configuration field, and no ICD revision.
  const file = options.file ?? join(dirname(config.auditFile), DEFAULT_LOG_FILE_NAME)
  const writer = new JsonlWriter(file, options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes })
  const scope = options.scope ?? 'ssh'
  const now = options.now ?? ((): Date => new Date())

  const build = (childScope: string): PluginLogger => {
    const emit = (entryLevel: LogLevel, message: string, fields?: Record<string, unknown>): void => {
      if (!shouldLog(entryLevel, level)) return
      // The *message* is scrubbed as well as the fields. Interpolation is the most
      // common way a secret reaches a log line (`logger.info(`${'$'}{password}`)`),
      // and a logger that only scrubs its structured fields would leak exactly the
      // case the acceptance run looks for.
      let safeMessage: string
      try {
        safeMessage = String(redactor.scrub(String(message)))
      } catch {
        safeMessage = '[message redaction failed]'
      }
      let scrubbedFields: Record<string, unknown> | undefined
      try {
        scrubbedFields = fields === undefined ? undefined : redactor.scrub(fields)
      } catch {
        scrubbedFields = { redactionFailed: true }
      }
      const record: Record<string, unknown> = {
        at: now().toISOString(),
        level: entryLevel,
        scope: childScope,
        msg: safeMessage,
      }
      if (scrubbedFields !== undefined) {
        for (const [key, value] of Object.entries(scrubbedFields)) {
          if (key === 'at' || key === 'level' || key === 'scope' || key === 'msg') continue
          record[key] = value
        }
      }
      writer.append(record)
      const host = options.host
      if (host !== undefined) {
        try {
          host[entryLevel](`[${childScope}] ${safeMessage}${compactFields(scrubbedFields)}`)
        } catch {
          /* the host logger is a courtesy, never a dependency */
        }
      }
    }

    return {
      scope: childScope,
      level,
      redactor,
      file,
      enabled: (candidate: LogLevel): boolean => shouldLog(candidate, level),
      debug: (message, fields) => emit('debug', message, fields),
      info: (message, fields) => emit('info', message, fields),
      warn: (message, fields) => emit('warn', message, fields),
      error: (message, fields) => emit('error', message, fields),
      child: (suffix: string): PluginLogger => build(suffix === '' ? childScope : `${childScope}.${suffix}`),
      flush: async (): Promise<void> => {
        /* JsonlWriter appends synchronously, so a resolved promise *is* durability
           for everything already emitted. The hook exists for callers that must
           wait for the disk before reporting success. */
      },
      toServiceLogger: (): HostLoggerFace => ({
        debug: (message: string): void => emit('debug', message),
        info: (message: string): void => emit('info', message),
        warn: (message: string): void => emit('warn', message),
        error: (message: string): void => emit('error', message),
      }),
    }
  }

  return build(scope)
}

/** Default log file for a DSH home; equals `dirname(<auditFile>)/plugin.jsonl`. */
export function defaultLogFile(dshHome: string): string {
  return join(dshHome, 'logs', 'dsh-ssh', DEFAULT_LOG_FILE_NAME)
}
