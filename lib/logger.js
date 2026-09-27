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
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRedactor } from './redact.js';
/** Ordered from least to most severe; the index is the threshold comparison. */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];
/** True when a message at `level` passes a logger configured at `threshold`. */
export function shouldLog(level, threshold) {
    return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(threshold);
}
export const DEFAULT_LOG_FILE_NAME = 'plugin.jsonl';
/** Bytes after which the current file is rotated to `<name>.1.jsonl`. */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
/**
 * Append-only JSONL file with in-place rotation.
 *
 * Every method is best-effort: `append` reports failure with `false` instead of
 * throwing, so callers that must not fail (the audit log) can buffer and retry,
 * and callers that simply want a log line can ignore it.
 */
export class JsonlWriter {
    file;
    maxBytes;
    bytes;
    sized = false;
    writable = true;
    constructor(file, options = {}) {
        this.file = file;
        this.maxBytes = Math.max(1024, Math.trunc(options.maxBytes ?? DEFAULT_MAX_BYTES));
        this.bytes = 0;
    }
    /** Append one already-serialised line; a trailing newline is added if absent. */
    appendLine(line) {
        if (!this.writable)
            return false;
        try {
            const payload = line.endsWith('\n') ? line : `${line}\n`;
            mkdirSync(dirname(this.file), { recursive: true });
            this.rotateIfNeeded(Buffer.byteLength(payload));
            appendFileSync(this.file, payload, 'utf8');
            this.bytes += Buffer.byteLength(payload);
            return true;
        }
        catch {
            return false;
        }
    }
    /** Append one JSON record; returns false when the record could not be written. */
    append(record) {
        let line;
        try {
            line = JSON.stringify(record);
        }
        catch {
            return false;
        }
        if (typeof line !== 'string' || line === '')
            return false;
        return this.appendLine(line);
    }
    /** Current file size in bytes (0 when the file cannot be read). */
    size() {
        if (!this.sized) {
            try {
                this.bytes = statSync(this.file).size;
            }
            catch {
                this.bytes = 0;
            }
            this.sized = true;
        }
        return this.bytes;
    }
    /**
     * The last lines of the file as text, oldest first.
     *
     * Reads at most `maxBytes` from the tail rather than the whole file: audit
     * queries only need recent history to answer, and an 8 MiB log must not be
     * pulled into memory on every call.
     */
    readTail(options = {}) {
        const limit = Math.max(1, Math.trunc(options.limit ?? 2000));
        const window = Math.max(4096, Math.trunc(options.maxBytes ?? 1024 * 1024));
        let fd;
        try {
            const size = statSync(this.file).size;
            const start = Math.max(0, size - window);
            const length = size - start;
            if (length <= 0)
                return [];
            const buffer = Buffer.alloc(length);
            fd = openSync(this.file, 'r');
            const read = readSync(fd, buffer, 0, length, start);
            const text = buffer.subarray(0, read).toString('utf8');
            const lines = text.split('\n');
            // A tail read can start mid-line; that partial line is not valid JSON.
            if (start > 0)
                lines.shift();
            return lines.filter((line) => line.trim() !== '').slice(-limit);
        }
        catch {
            return [];
        }
        finally {
            if (fd !== undefined) {
                try {
                    closeSync(fd);
                }
                catch {
                    /* already closed by the failure path */
                }
            }
        }
    }
    /** Remove the file (audit "clear"); the next append recreates it. */
    truncate() {
        try {
            rmSync(this.file, { force: true });
            this.bytes = 0;
            this.sized = true;
            return true;
        }
        catch {
            return false;
        }
    }
    rotateIfNeeded(incoming) {
        this.size();
        if (this.bytes + incoming <= this.maxBytes)
            return;
        try {
            const archived = this.file.replace(/\.jsonl$/, '.1.jsonl');
            if (archived !== this.file) {
                rmSync(archived, { force: true });
                renameSync(this.file, archived);
            }
        }
        catch {
            /* rotation is an optimisation: keep appending to the current file */
        }
        this.bytes = 0;
    }
}
/** Longest human-readable field dump forwarded to the host logger. */
const HOST_LINE_LIMIT = 600;
function compactFields(fields) {
    if (fields === undefined)
        return '';
    let text;
    try {
        text = JSON.stringify(fields);
    }
    catch {
        return ' [unserialisable fields]';
    }
    if (typeof text !== 'string' || text === '{}' || text === '')
        return '';
    return ` ${text.length > HOST_LINE_LIMIT ? `${text.slice(0, HOST_LINE_LIMIT)}…` : text}`;
}
/** Create the plugin logger. One instance per plugin activation. */
export function createLogger(options) {
    const { config } = options;
    const level = config.logging.level;
    const redactor = options.redactor ?? createRedactor({ redactKeys: config.logging.redactKeys, enabled: config.logging.redact });
    // ICD §6 freezes exactly two paths: `profilesFile` and `auditFile`. The plugin's
    // own structured log therefore lives *beside* the audit log — one log directory
    // per plugin, and an operator who moves the audit file moves both. No new
    // configuration field, and no ICD revision.
    const file = options.file ?? join(dirname(config.auditFile), DEFAULT_LOG_FILE_NAME);
    const writer = new JsonlWriter(file, options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes });
    const scope = options.scope ?? 'ssh';
    const now = options.now ?? (() => new Date());
    const build = (childScope) => {
        const emit = (entryLevel, message, fields) => {
            if (!shouldLog(entryLevel, level))
                return;
            // The *message* is scrubbed as well as the fields. Interpolation is the most
            // common way a secret reaches a log line (`logger.info(`${'$'}{password}`)`),
            // and a logger that only scrubs its structured fields would leak exactly the
            // case the acceptance run looks for.
            let safeMessage;
            try {
                safeMessage = String(redactor.scrub(String(message)));
            }
            catch {
                safeMessage = '[message redaction failed]';
            }
            let scrubbedFields;
            try {
                scrubbedFields = fields === undefined ? undefined : redactor.scrub(fields);
            }
            catch {
                scrubbedFields = { redactionFailed: true };
            }
            const record = {
                at: now().toISOString(),
                level: entryLevel,
                scope: childScope,
                msg: safeMessage,
            };
            if (scrubbedFields !== undefined) {
                for (const [key, value] of Object.entries(scrubbedFields)) {
                    if (key === 'at' || key === 'level' || key === 'scope' || key === 'msg')
                        continue;
                    record[key] = value;
                }
            }
            writer.append(record);
            const host = options.host;
            if (host !== undefined) {
                try {
                    host[entryLevel](`[${childScope}] ${safeMessage}${compactFields(scrubbedFields)}`);
                }
                catch {
                    /* the host logger is a courtesy, never a dependency */
                }
            }
        };
        return {
            scope: childScope,
            level,
            redactor,
            file,
            enabled: (candidate) => shouldLog(candidate, level),
            debug: (message, fields) => emit('debug', message, fields),
            info: (message, fields) => emit('info', message, fields),
            warn: (message, fields) => emit('warn', message, fields),
            error: (message, fields) => emit('error', message, fields),
            child: (suffix) => build(suffix === '' ? childScope : `${childScope}.${suffix}`),
            flush: async () => {
                /* JsonlWriter appends synchronously, so a resolved promise *is* durability
                   for everything already emitted. The hook exists for callers that must
                   wait for the disk before reporting success. */
            },
            toServiceLogger: () => ({
                debug: (message) => emit('debug', message),
                info: (message) => emit('info', message),
                warn: (message) => emit('warn', message),
                error: (message) => emit('error', message),
            }),
        };
    };
    return build(scope);
}
/** Default log file for a DSH home; equals `dirname(<auditFile>)/plugin.jsonl`. */
export function defaultLogFile(dshHome) {
    return join(dshHome, 'logs', 'dsh-ssh', DEFAULT_LOG_FILE_NAME);
}
//# sourceMappingURL=logger.js.map