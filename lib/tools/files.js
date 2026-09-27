/**
 * Model-facing file tools: `ssh_upload`, `ssh_download`, `ssh_list_dir`
 * (ICD §0 names, DESIGN §3 ownership `src/tools/files.ts`).
 *
 * Shape of a tool here, following the established `@local/dsh-python` pattern
 * (`src/tools/exec.ts`): a `ToolDefinition` literal with a raw JSON-Schema
 * `parameters`, a declared `output` contract, and an `execute` that returns a
 * canonical value. Two deliberate choices:
 *
 *  - **The tools do not stream.** Transfers are driven to completion by
 *    `TransferManager.run()`; the model gets the finished outcome. Progress is
 *    streamed to the *UI* by the §4.5 endpoints (`sshPlugin/upload`), not to the
 *    model, and the only thing a model could do with a progress callback is burn
 *    context on it. A long transfer is reported through `deps.log` at most every
 *    10 s instead.
 *  - **Failures are returned, not thrown.** `execute` answers `{ ok: false,
 *    code, … }` so the model reads a structured refusal (and can retry, resume,
 *    or fix the path) instead of seeing a crashed tool call. Only a bug in this
 *    file would throw.
 *
 * Every transfer is started with the caller's `exec.signal` forwarded plus a
 * cooperative deadline, because an aborted transfer ends as
 * `SSH_SFTP_TRANSFER_ABORTED` with a resumable offset: cancelling is never
 * destructive, which is exactly why it is safe to give the model this tool.
 */
import { SshError, toErrorInfo } from '../protocol.js';
import { toSftpError } from '../sftp/errors.js';
/** Tool names, in the order they are registered (ICD §0). */
export const FILES_TOOL_NAMES = ['ssh_upload', 'ssh_download', 'ssh_list_dir'];
/** Default cooperative deadline for one transfer (a 100 MiB run over a slow link fits). */
const DEFAULT_TRANSFER_TIMEOUT_MS = 15 * 60_000;
const MAX_TRANSFER_TIMEOUT_MS = 60 * 60_000;
const MIN_TRANSFER_TIMEOUT_MS = 1_000;
/** How often a long transfer says something to the host log. */
const PROGRESS_LOG_INTERVAL_MS = 10_000;
/** Cap on entries returned by `ssh_list_dir` so one huge directory cannot flood the context. */
const DEFAULT_LIST_LIMIT = 500;
function stringNode(description, extra = {}) {
    return { type: 'string', description, ...extra };
}
function integerNode(description, extra = {}) {
    return { type: 'integer', description, ...extra };
}
function booleanNode(description) {
    return { type: 'boolean', description };
}
function arrayNode(description, items) {
    return { type: 'array', description, items };
}
function objectNode(properties, options = {}) {
    return {
        type: 'object',
        properties,
        required: Object.keys(properties),
        ...(options.additionalProperties === undefined ? {} : { additionalProperties: options.additionalProperties }),
    };
}
// ---------------------------------------------------------------------------
// Argument reading
// ---------------------------------------------------------------------------
/** Collects every argument problem so the model sees all of them at once. */
class ArgErrors {
    messages = [];
    add(message) {
        this.messages.push(message);
    }
    get ok() {
        return this.messages.length === 0;
    }
}
function readObject(raw, errors) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        errors.add('the arguments object is required');
        return {};
    }
    return raw;
}
function optString(raw, key, errors) {
    const value = raw[key];
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'string') {
        errors.add(`"${key}" must be a string`);
        return undefined;
    }
    const trimmed = value.trim();
    if (trimmed === '') {
        errors.add(`"${key}" must not be empty`);
        return undefined;
    }
    return trimmed;
}
function optInteger(raw, key, errors, bounds) {
    const value = raw[key];
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.add(`"${key}" must be a number`);
        return undefined;
    }
    const truncated = Math.trunc(value);
    if (truncated < bounds.min || truncated > bounds.max) {
        errors.add(`"${key}" must be between ${bounds.min} and ${bounds.max}`);
        return undefined;
    }
    return truncated;
}
function optBoolean(raw, key, errors) {
    const value = raw[key];
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'boolean') {
        errors.add(`"${key}" must be a boolean`);
        return undefined;
    }
    return value;
}
function optEnum(raw, key, allowed, errors) {
    const value = raw[key];
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'string' || !allowed.includes(value)) {
        errors.add(`"${key}" must be one of ${allowed.join(', ')}`);
        return undefined;
    }
    return value;
}
const transferEntrySchema = objectNode({
    localPath: stringNode('Local path of the file.'),
    remotePath: stringNode('Remote path of the file.'),
    size: integerNode('File size in bytes.'),
    resumedFrom: integerNode('Bytes kept from a previous partial transfer.'),
    transferred: integerNode('Bytes this operation moved for this file.'),
    sha256: stringNode('Digest of this file; empty unless verify=sha256.'),
    skipped: booleanNode('True when the file was not transferred (symlink or conflict).'),
}, { additionalProperties: false });
const transferSchema = objectNode({
    ok: booleanNode('True when the transfer completed and verified.'),
    code: stringNode('ICD error code (§5); empty when ok.'),
    message: stringNode('User-facing message; empty when ok.'),
    retryable: booleanNode('Whether the same call may be retried; resuming needs resume=true.'),
    details: stringNode('JSON object with technical detail; empty when none.'),
    sessionId: stringNode('Session the transfer ran on.'),
    direction: stringNode('Direction, echoed back.', { enum: ['upload', 'download'] }),
    localPath: stringNode('Local path, echoed back.'),
    remotePath: stringNode('Remote path, echoed back.'),
    resumedFrom: integerNode('Bytes kept from a previous partial transfer.'),
    transferred: integerNode('Bytes moved by this operation.'),
    totalBytes: integerNode('Bytes this operation set out to move.'),
    bytesPerSec: integerNode('Average throughput over the transfer phase.'),
    durationMs: integerNode('Wall-clock duration.'),
    verify: stringNode('Verification actually performed.', { enum: ['none', 'size+mtime', 'sha256'] }),
    sha256: stringNode('Digest shared by both sides for a single-file transfer; empty otherwise.'),
    entries: arrayNode('One record per file transferred.', transferEntrySchema),
    skipped: arrayNode('Entries deliberately not transferred (symlinks, conflicts).', objectNode({ path: stringNode('Path that was skipped.'), reason: stringNode('Why it was skipped.') }, { additionalProperties: false })),
    notes: arrayNode('Extra remarks, e.g. degraded capabilities.', stringNode('Note.')),
}, { additionalProperties: false });
const listSchema = objectNode({
    ok: booleanNode('True when the listing succeeded.'),
    code: stringNode('ICD error code (§5); empty when ok.'),
    message: stringNode('User-facing message; empty when ok.'),
    retryable: booleanNode('Whether the same call may be retried.'),
    details: stringNode('JSON object with technical detail; empty when none.'),
    sessionId: stringNode('Session the listing came from.'),
    cwd: stringNode('The directory that was listed.'),
    count: integerNode('Entries returned.'),
    total: integerNode('Entries found before the limit was applied.'),
    truncated: booleanNode('True when entries were cut off by the limit.'),
    entries: arrayNode('Directory entries, directories first then natural order by name.', objectNode({
        name: stringNode('Base name.'),
        path: stringNode('Full remote path.'),
        type: stringNode('Entry type.', { enum: ['file', 'dir', 'symlink', 'other'] }),
        size: integerNode('Size in bytes.'),
        mode: stringNode('Permission bits as four octal digits, e.g. 0644.'),
        mtime: stringNode('ISO-8601 modification time; empty when unknown.'),
        isSymlink: booleanNode('True for a symbolic link.'),
        target: stringNode('Link target when known; empty otherwise.'),
    }, { additionalProperties: false })),
}, { additionalProperties: false });
function emptyTransfer(sessionId, direction, localPath, remotePath) {
    return {
        ok: false,
        code: '',
        message: '',
        retryable: false,
        details: '',
        sessionId,
        direction,
        localPath,
        remotePath,
        resumedFrom: 0,
        transferred: 0,
        totalBytes: 0,
        bytesPerSec: 0,
        durationMs: 0,
        verify: 'none',
        sha256: '',
        entries: [],
        skipped: [],
        notes: [],
    };
}
/** A structured failure the model can act on (never a thrown tool error). */
function refusedTransfer(base, error, notes = []) {
    const info = toErrorInfo(error);
    return {
        ...base,
        ok: false,
        code: String(info.code),
        message: info.message,
        retryable: info.retryable,
        details: info.details === undefined ? '' : safeJson(info.details),
        notes: [...base.notes, ...notes],
    };
}
function succeededTransfer(base, outcome, notes) {
    return {
        ...base,
        ok: true,
        code: '',
        message: '',
        retryable: false,
        details: '',
        resumedFrom: outcome.resumedFrom,
        transferred: outcome.transferred,
        totalBytes: outcome.totalBytes,
        bytesPerSec: outcome.bytesPerSec,
        durationMs: outcome.durationMs,
        verify: outcome.verify,
        sha256: outcome.sha256?.local ?? '',
        entries: outcome.entries.map((entry) => ({
            localPath: entry.localPath,
            remotePath: entry.remotePath,
            size: entry.size,
            resumedFrom: entry.resumedFrom,
            transferred: entry.transferred,
            sha256: entry.sha256 ?? '',
            skipped: entry.skipped === true,
        })),
        skipped: outcome.skipped.map((item) => ({ path: item.path, reason: item.reason })),
        notes: [...notes, ...skippedNote(outcome)],
    };
}
function skippedNote(outcome) {
    const count = outcome.entries.filter((entry) => entry.skipped === true).length;
    const notes = [];
    if (count > 0)
        notes.push(`${count} file(s) were skipped by a conflict decision`);
    if (outcome.skipped.length > 0)
        notes.push(`${outcome.skipped.length} entry/entries were not transferred (see skipped)`);
    return notes;
}
function safeJson(value) {
    try {
        const text = JSON.stringify(value);
        return text === undefined ? '' : text;
    }
    catch {
        return '';
    }
}
function textBlocks(text) {
    return [{ type: 'text', text }];
}
function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KiB`;
    if (bytes < 1024 * 1024 * 1024)
        return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}
function formatRate(bytesPerSec) {
    return bytesPerSec > 0 ? `${formatBytes(bytesPerSec)}/s` : 'n/a';
}
function renderTransfer(envelope) {
    if (!envelope.ok) {
        return [
            `ssh_${envelope.direction} FAILED`,
            `code: ${envelope.code}`,
            `message: ${envelope.message}`,
            envelope.retryable ? 'retryable: yes (resume=true continues from the reported offset)' : 'retryable: no',
            envelope.details === '' ? '' : `details: ${envelope.details}`,
        ]
            .filter((line) => line !== '')
            .join('\n');
    }
    const lines = [
        `ssh_${envelope.direction} ok · ${formatBytes(envelope.transferred)} in ${(envelope.durationMs / 1000).toFixed(1)}s (${formatRate(envelope.bytesPerSec)})`,
        `${envelope.localPath}  <->  ${envelope.remotePath}`,
        `resumed from: ${formatBytes(envelope.resumedFrom)} · verify: ${envelope.verify}${envelope.sha256 === '' ? '' : ` · sha256 ${envelope.sha256}`}`,
        `files: ${envelope.entries.length}${envelope.entries.length > 1 ? ` (${envelope.entries.filter((entry) => !entry.skipped).length} transferred)` : ''}`,
    ];
    if (envelope.skipped.length > 0) {
        lines.push(`skipped: ${envelope.skipped.length}`);
        for (const item of envelope.skipped.slice(0, 5))
            lines.push(`  - ${item.path} (${item.reason})`);
    }
    if (envelope.entries.length > 1) {
        for (const entry of envelope.entries.slice(0, 10)) {
            lines.push(`  ${entry.skipped ? 'skip' : 'ok  '} ${entry.remotePath} (${formatBytes(entry.size)})`);
        }
        if (envelope.entries.length > 10)
            lines.push(`  … ${envelope.entries.length - 10} more`);
    }
    if (envelope.notes.length > 0)
        lines.push(`notes: ${envelope.notes.join('; ')}`);
    return lines.join('\n');
}
function renderList(envelope) {
    if (!envelope.ok) {
        return [`ssh_list_dir FAILED`, `code: ${envelope.code}`, `message: ${envelope.message}`].join('\n');
    }
    const lines = [
        `${envelope.cwd} — ${envelope.count}${envelope.truncated ? ` of ${envelope.total}` : ''} entr${envelope.count === 1 ? 'y' : 'ies'}`,
    ];
    for (const entry of envelope.entries) {
        const kind = entry.type === 'dir' ? 'd' : entry.type === 'symlink' ? 'l' : entry.type === 'file' ? '-' : '?';
        const arrow = entry.target === '' ? '' : ` -> ${entry.target}`;
        lines.push(`${kind} ${entry.mode} ${String(entry.size).padStart(10)} ${entry.name}${arrow}`);
    }
    if (envelope.truncated)
        lines.push(`… truncated at ${envelope.count}; narrow the path or raise limit`);
    return lines.join('\n');
}
// ---------------------------------------------------------------------------
// Tool builders
// ---------------------------------------------------------------------------
function genericCall(title) {
    return { card: 'generic', title };
}
function describeTransferDefaults(deps) {
    const defaults = deps.defaults ?? {};
    const chunkKib = Math.round((defaults.chunkBytes ?? 262144) / 1024);
    return (`Defaults from the plugin config: chunk ${chunkKib} KiB, concurrency ${defaults.maxConcurrentChunks ?? 4}, ` +
        `resume ${defaults.resume !== false ? 'on' : 'off'}, verify ${defaults.verify ?? 'size+mtime'}.`);
}
function transferTool(deps, direction) {
    const name = direction === 'upload' ? 'ssh_upload' : 'ssh_download';
    const from = direction === 'upload' ? 'local filesystem to the remote host' : 'remote host to the local filesystem';
    const sourceKey = direction === 'upload' ? 'localPath' : 'remotePath';
    const deadline = clampTimeout(deps.transferTimeoutMs);
    return {
        name,
        description: [
            `Transfer a file or a whole directory tree over SFTP, ${from}.`,
            '',
            'Directories are transferred recursively, preserving the relative structure under the destination',
            'root; symbolic links are not followed (a symlink is reported as skipped) unless the plugin config',
            'sets `sftp.followSymlinks`.',
            '',
            `A partially transferred destination is resumed from its current size when \`resume\` is true (default),`,
            'and the result reports `resumedFrom`. Set `verify` to "sha256" when the bytes must be proven equal,',
            'not merely the right length. Without `overwrite` an existing destination is refused',
            '(SSH_SFTP_TARGET_EXISTS) instead of being replaced — retry with overwrite=true to replace it.',
            '',
            'A cancelled or timed-out transfer never leaves a corrupt file: it stops at a durable offset and the',
            'error carries `resumedFrom`, so the same call with `resume=true` continues instead of restarting.',
            '',
            describeTransferDefaults(deps),
            '',
            sourceKey === 'localPath'
                ? '`localPath` is on the DSH host (this machine), `remotePath` on the SSH server.'
                : '`remotePath` is on the SSH server, `localPath` on the DSH host (this machine).',
        ].join('\n'),
        parameters: objectNode({
            sessionId: stringNode('Session id from ssh_sessions / the SSH panel.'),
            localPath: stringNode(direction === 'upload' ? 'Local file or directory to send.' : 'Local destination path (file or directory root).'),
            remotePath: stringNode(direction === 'upload' ? 'Remote destination path (file or directory root).' : 'Remote file or directory to fetch.'),
            chunkBytes: integerNode(`Chunk size in bytes (default ${deps.defaults?.chunkBytes ?? 262144}; clamped to 16 KiB … 16 MiB).`, { default: deps.defaults?.chunkBytes ?? 262144 }),
            concurrency: integerNode(`Concurrent chunk streams (default ${deps.defaults?.maxConcurrentChunks ?? 4}; clamped to 1 … 32).`, { default: deps.defaults?.maxConcurrentChunks ?? 4 }),
            resume: booleanNode(`Continue a partial destination instead of failing or restarting (default ${deps.defaults?.resume !== false}).`),
            overwrite: booleanNode('Replace an existing destination of a different size (default false: refuse with SSH_SFTP_TARGET_EXISTS).'),
            verify: stringNode('Post-transfer check (default from the plugin config).', {
                enum: ['none', 'size+mtime', 'sha256'],
            }),
            timeoutMs: integerNode(`Cooperative deadline in milliseconds (default ${deadline}); an abort is resumable.`),
        }),
        output: {
            schema: transferSchema,
            render: (_args, value) => textBlocks(renderTransfer(value)),
        },
        timeoutMs: MAX_TRANSFER_TIMEOUT_MS + 15_000,
        // Transfers mutate remote and local state; never run them in a parallel group.
        isConcurrencySafe: () => false,
        async execute(rawArgs, exec) {
            const errors = new ArgErrors();
            const raw = readObject(rawArgs, errors);
            const sessionId = optString(raw, 'sessionId', errors);
            const localPath = optString(raw, 'localPath', errors);
            const remotePath = optString(raw, 'remotePath', errors);
            const chunkBytes = optInteger(raw, 'chunkBytes', errors, { min: 16 * 1024, max: 16 * 1024 * 1024 });
            const concurrency = optInteger(raw, 'concurrency', errors, { min: 1, max: 32 });
            const resume = optBoolean(raw, 'resume', errors);
            const overwrite = optBoolean(raw, 'overwrite', errors);
            const verify = optEnum(raw, 'verify', ['none', 'size+mtime', 'sha256'], errors);
            const timeoutMs = optInteger(raw, 'timeoutMs', errors, { min: MIN_TRANSFER_TIMEOUT_MS, max: MAX_TRANSFER_TIMEOUT_MS });
            const base = emptyTransfer(sessionId ?? '', direction, localPath ?? '', remotePath ?? '');
            if (!errors.ok) {
                return refusedTransfer(base, new SshError('SSH_CFG_INVALID', `invalid arguments: ${errors.messages.join('; ')}`));
            }
            if (sessionId === undefined || localPath === undefined || remotePath === undefined) {
                return refusedTransfer(base, new SshError('SSH_CFG_INVALID', 'sessionId, localPath and remotePath are required'));
            }
            const session = deps.getSession(sessionId);
            if (session === undefined) {
                return refusedTransfer(base, new SshError('SSH_STATE_INVALID', `no live session with id "${sessionId}"; call ssh_sessions first`));
            }
            const controller = new AbortController();
            const unlink = forwardSignal(exec.signal, controller);
            const timer = armDeadline(timeoutMs ?? deadline, controller);
            let lastLog = 0;
            try {
                const outcome = await deps.transfer({
                    sessionId,
                    direction,
                    localPath,
                    remotePath,
                    ...(chunkBytes === undefined ? {} : { chunkBytes }),
                    ...(concurrency === undefined ? {} : { concurrency }),
                    ...(resume === undefined ? {} : { resume }),
                    ...(overwrite === undefined ? {} : { overwrite }),
                    ...(verify === undefined ? {} : { verify }),
                    signal: controller.signal,
                    onProgress: (progress) => {
                        const now = Date.now();
                        if (now - lastLog < PROGRESS_LOG_INTERVAL_MS)
                            return;
                        lastLog = now;
                        const percent = progress.totalBytes === undefined || progress.totalBytes === 0
                            ? '?'
                            : `${Math.floor((progress.transferred / progress.totalBytes) * 100)}%`;
                        safeLog(deps.log, `dsh-ssh: ${name} ${percent} (${formatBytes(progress.transferred)}` +
                            `${progress.totalBytes === undefined ? '' : `/${formatBytes(progress.totalBytes)}`}, ${progress.phase}, ${formatRate(progress.bytesPerSec)})`);
                    },
                });
                return succeededTransfer(base, outcome, []);
            }
            catch (error) {
                return refusedTransfer(base, toSftpError(error, { op: name, path: direction === 'upload' ? remotePath : localPath }), [
                    controller.signal.aborted
                        ? `the transfer was aborted by ${exec.signal.aborted ? 'the caller' : 'its deadline'}`
                        : '',
                ].filter((note) => note !== ''));
            }
            finally {
                if (timer !== undefined)
                    clearTimeout(timer);
                unlink();
            }
        },
        presentCall(args) {
            const view = args;
            if (typeof view?.localPath !== 'string' || typeof view?.remotePath !== 'string')
                return undefined;
            return genericCall(`${name} · ${view.localPath} ${direction === 'upload' ? '→' : '←'} ${view.remotePath}`);
        },
    };
}
function listDirTool(deps) {
    return {
        name: 'ssh_list_dir',
        description: [
            'List a directory on the remote host over SFTP.',
            '',
            'Returns directories first, then files in natural order by name (`file2` before `file10`),',
            'with type, size, permission bits, mtime and symlink target per entry. Hidden entries are',
            'omitted unless `showHidden` is true. This is read-only and safe to call in parallel.',
            '',
            'Use `limit` when a directory may be huge: the result reports `total` and `truncated`.',
        ].join('\n'),
        parameters: objectNode({
            sessionId: stringNode('Session id from ssh_sessions / the SSH panel.'),
            path: stringNode('Remote directory to list.'),
            showHidden: booleanNode('Include dot-files and other hidden entries (default false).'),
            limit: integerNode(`Maximum entries returned (default ${DEFAULT_LIST_LIMIT}; clamped to 1 … 10000).`),
        }),
        output: {
            schema: listSchema,
            render: (_args, value) => textBlocks(renderList(value)),
        },
        // Read-only: it may share a parallel group with other calls.
        isConcurrencySafe: () => true,
        async execute(rawArgs, exec) {
            const errors = new ArgErrors();
            const raw = readObject(rawArgs, errors);
            const sessionId = optString(raw, 'sessionId', errors);
            const path = optString(raw, 'path', errors);
            const showHidden = optBoolean(raw, 'showHidden', errors);
            const limit = optInteger(raw, 'limit', errors, { min: 1, max: 10_000 }) ?? DEFAULT_LIST_LIMIT;
            const empty = {
                ok: false,
                code: '',
                message: '',
                retryable: false,
                details: '',
                sessionId: sessionId ?? '',
                cwd: path ?? '',
                count: 0,
                total: 0,
                truncated: false,
                entries: [],
            };
            if (!errors.ok) {
                const info = toErrorInfo(new SshError('SSH_CFG_INVALID', `invalid arguments: ${errors.messages.join('; ')}`));
                return { ...empty, code: String(info.code), message: info.message, retryable: info.retryable };
            }
            if (sessionId === undefined || path === undefined) {
                const info = toErrorInfo(new SshError('SSH_CFG_INVALID', 'sessionId and path are required'));
                return { ...empty, code: String(info.code), message: info.message, retryable: info.retryable };
            }
            if (deps.getSession(sessionId) === undefined) {
                const info = toErrorInfo(new SshError('SSH_STATE_INVALID', `no live session with id "${sessionId}"; call ssh_sessions first`));
                return { ...empty, code: String(info.code), message: info.message, retryable: info.retryable };
            }
            try {
                const result = await deps.listDir({
                    sessionId,
                    path,
                    showHidden: showHidden === true,
                    signal: exec.signal,
                });
                const total = result.entries.length;
                const entries = result.entries.slice(0, limit).map((entry) => ({
                    name: entry.name,
                    path: entry.path,
                    type: entry.type,
                    size: entry.size,
                    mode: entry.mode,
                    mtime: entry.mtime,
                    isSymlink: entry.isSymlink,
                    target: entry.target ?? '',
                }));
                return {
                    ...empty,
                    ok: true,
                    cwd: result.cwd,
                    count: entries.length,
                    total,
                    truncated: total > entries.length,
                    entries,
                };
            }
            catch (error) {
                const info = toErrorInfo(toSftpError(error, { op: 'listDir', path }));
                return {
                    ...empty,
                    code: String(info.code),
                    message: info.message,
                    retryable: info.retryable,
                    details: info.details === undefined ? '' : safeJson(info.details),
                };
            }
        },
        presentCall(args) {
            const view = args;
            return typeof view?.path === 'string' ? genericCall(`ssh_list_dir · ${view.path}`) : undefined;
        },
    };
}
/** Factory map keyed by tool name, so the plugin can honour `config.tools`. */
export function filesToolFactories(deps) {
    return {
        ssh_upload: () => transferTool(deps, 'upload'),
        ssh_download: () => transferTool(deps, 'download'),
        ssh_list_dir: () => listDirTool(deps),
    };
}
/** All three tools, in registration order. */
export function fileTools(deps) {
    const factories = filesToolFactories(deps);
    return FILES_TOOL_NAMES.map((name) => factories[name]());
}
function clampTimeout(value) {
    if (value === undefined || !Number.isFinite(value))
        return DEFAULT_TRANSFER_TIMEOUT_MS;
    return Math.min(MAX_TRANSFER_TIMEOUT_MS, Math.max(MIN_TRANSFER_TIMEOUT_MS, Math.trunc(value)));
}
/**
 * A log line may never be the reason a transfer fails.
 *
 * The transfer engine already protects its own sink, but this call happens inside
 * the *tool's* callback: a logger that throws (a misconfigured sink, a closed
 * stream) must cost nothing more than the log line itself.
 */
function safeLog(log, message) {
    try {
        log?.info(message);
    }
    catch {
        /* deliberately ignored: logging is best-effort */
    }
}
/** Arm a cooperative deadline; returns `undefined` when none is wanted. */
function armDeadline(ms, controller) {
    if (!Number.isFinite(ms) || ms <= 0)
        return undefined;
    const timer = setTimeout(() => controller.abort(), ms);
    timer.unref?.();
    return timer;
}
/** Forward the caller's cancellation to the transfer's own controller. */
function forwardSignal(from, to) {
    if (from.aborted) {
        to.abort();
        return () => undefined;
    }
    const onAbort = () => to.abort();
    from.addEventListener('abort', onAbort, { once: true });
    return () => from.removeEventListener('abort', onAbort);
}
//# sourceMappingURL=files.js.map