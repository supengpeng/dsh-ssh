/**
 * Non-PTY command execution (ICD §4.4 `exec` / `execWait`).
 *
 * The runner owns one command's whole lifecycle: it opens the stream, pumps
 * `stdout`/`stderr` bytes into frames through the output limiter, applies the
 * timeout escalation, and terminates the stream with exactly one `exit` and one
 * `end`.
 *
 * Design notes that matter for the wire:
 *
 *   - `done` never rejects. The streaming endpoint (`sshPlugin/exec`) returns a
 *     `streamId` immediately and has nobody to reject to, so every failure —
 *     including "the channel never opened" — is reported as frames and in the
 *     resolved result. `execWait` inspects `result.error`.
 *   - Every `exec` stream carries an `exit` frame, even when the channel failed
 *     to open (`exitCode:null`), because ICD §3 requires `exit` before `end`.
 *   - Truncation keeps head and tail halves and ends the stream with
 *     `SSH_LIMIT_OUTPUT_TRUNCATED`. The command itself is *not* reported as
 *     failed: the flag is the report.
 */
import { SshError, isRetryable, toErrorInfo } from '../protocol.js';
import { OutputLimiter } from './limits.js';
import { StreamPump } from './pump.js';
import { KillEscalator, systemTimers } from './timeout.js';
import { isClosedState, sessionStateOf, } from './types.js';
/** Start a command and return its stream id plus the settlement promise. */
export function startExec(options) {
    const session = options.session;
    const state = sessionStateOf(session);
    if (isClosedState(state)) {
        throw new SshError('SSH_STATE_INVALID', `session ${session.id} is ${state}; cannot run a command`);
    }
    const now = options.now ?? Date.now;
    const timers = options.timers ?? systemTimers;
    const logger = options.logger;
    const graceKillMs = Math.max(0, Math.trunc(options.graceKillMs));
    const timeoutMs = Math.max(0, Math.trunc(options.timeoutMs ?? 0));
    const pty = options.pty === true;
    let handle;
    let offData;
    let offExit;
    let finished = false;
    let inputClosed = false;
    let resolveDone = () => { };
    const done = new Promise((resolve) => {
        resolveDone = resolve;
    });
    const startedAt = now();
    const writer = options.hub.open({
        kind: 'exec',
        sessionId: session.id,
        streamId: options.streamId,
        replayLimitBytes: options.replayLimitBytes,
        meta: {
            command: options.command,
            ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
            pty,
            ...(pty
                ? {
                    cols: options.cols ?? 80,
                    rows: options.rows ?? 24,
                    term: options.term ?? 'xterm-256color',
                }
                : {}),
            ...(state !== undefined ? { sessionState: state } : {}),
        },
    });
    const streamId = writer.streamId;
    const limits = new OutputLimiter(options.maxOutputBytes);
    // Default bucketing puts a PTY command's `term` bytes (and stdout) in `stdout`,
    // which is the only result field a single-channel command can report into.
    const pump = new StreamPump({ writer, limits });
    const escalator = new KillEscalator({
        timeoutMs,
        graceKillMs,
        settleMs: options.settleMs,
        timers,
        onSignal: (signal) => {
            handle?.signal(signal);
            logger?.debug?.(`dsh-ssh: exec ${streamId} sent SIG${signal}`);
        },
        onCancel: () => {
            handle?.cancel();
        },
        onForceSettle: () => {
            // The peer never reported an exit. The escalation's own deadline is the
            // authority here: the stream must end either way, or the client waits
            // forever on a stream that will never terminate.
            settle({
                code: null,
                ...(escalator.lastSignal !== undefined ? { signal: escalator.lastSignal } : {}),
                durationMs: now() - startedAt,
                timedOut: escalator.cause === 'timeout',
            });
        },
    });
    const controls = {
        write: (data, encoding) => {
            if (handle === undefined)
                throw new SshError('SSH_STATE_INVALID', `stream ${streamId} has no channel yet`);
            const buffer = encoding === 'base64' ? Buffer.from(data, 'base64') : Buffer.from(data, 'utf8');
            handle.write(buffer);
            return buffer.length;
        },
        signal: (signal) => {
            handle?.signal(signal);
        },
        cancel: (reason) => {
            if (finished)
                return;
            // `dispose` is not the client cancelling: the plugin is going away, and
            // reporting that as `cancelled` would blame the wrong side.
            if (reason === 'dispose' || reason === 'peer-closed') {
                terminateNow('peer-closed');
                return;
            }
            escalator.cancel();
        },
        terminated: () => {
            finishFromWriter();
        },
    };
    options.hub.attach(streamId, controls);
    /** Map a handle channel onto the frame channel (a PTY has no stderr). */
    function frameChannel(channel) {
        return pty ? 'term' : channel;
    }
    /** Stop consuming the channel; safe to call more than once. */
    function detach() {
        escalator.settle();
        removeAbortListener();
        try {
            offData?.();
            offExit?.();
        }
        catch {
            /* unsubscribe functions are best-effort */
        }
    }
    /** Resolve the caller's promise from the stream's own terminal frames. */
    function resolveFromWriter() {
        const end = writer.terminal().end;
        const exit = writer.terminal().exit;
        resolveDone({
            streamId,
            exitCode: exit?.exitCode ?? null,
            ...(exit?.signal !== undefined ? { signal: exit.signal } : {}),
            durationMs: exit?.durationMs ?? now() - startedAt,
            timedOut: exit?.timedOut ?? false,
            endReason: end?.reason ?? 'error',
            truncated: { stdout: pump.truncated().stdout || pump.truncated().term, stderr: pump.truncated().stderr },
            stdout: pump.capture('stdout'),
            stderr: pump.capture('stderr'),
            binary: { stdout: pump.isBinary('stdout'), stderr: pump.isBinary('stderr') },
            bytes: { stdout: pump.seenBytes('stdout'), stderr: pump.seenBytes('stderr') },
            ...(end?.error !== undefined ? { error: end.error } : {}),
        });
    }
    /**
     * Terminate the stream here and now (plugin unload / peer close), instead of
     * waiting for the remote side to acknowledge anything.
     */
    function terminateNow(reason) {
        if (finished)
            return;
        // Claim the transition before touching the channel: the channel's own exit
        // notification would otherwise re-enter `settle()` and label the stream as a
        // client cancellation.
        finished = true;
        detach();
        try {
            handle?.cancel();
        }
        catch (error) {
            logger?.warn?.(`dsh-ssh: exec ${streamId} stop on dispose failed: ${messageOf(error)}`);
        }
        pump.drain();
        if (!writer.ended) {
            writer.exit({ code: null, durationMs: now() - startedAt, timedOut: false });
            writer.end(reason);
        }
        resolveFromWriter();
    }
    /**
     * The stream was terminated outside this runner (`StreamHub.dispose`).
     *
     * The wire already saw `exit`/`end`, so the result adopts them rather than
     * inventing a second terminal pair (ICD §3 forbids that).
     */
    function finishFromWriter() {
        if (finished)
            return;
        finished = true;
        detach();
        pump.drain();
        resolveFromWriter();
    }
    function settle(event) {
        if (finished)
            return;
        finished = true;
        const cause = escalator.cause;
        const lastSignal = escalator.lastSignal;
        detach();
        pump.drain();
        const timedOut = event.timedOut || cause === 'timeout';
        const durationMs = Math.max(0, Math.trunc(event.durationMs > 0 ? event.durationMs : now() - startedAt));
        const flags = pump.truncated();
        const truncatedAny = flags.stdout || flags.stderr || flags.term;
        const truncated = { stdout: flags.stdout || flags.term, stderr: flags.stderr };
        let reason = 'completed';
        let error;
        if (timedOut) {
            reason = 'timeout';
            error = timeoutError(timeoutMs > 0 ? timeoutMs : durationMs);
        }
        else if (cause === 'cancelled') {
            reason = 'cancelled';
        }
        else if (truncatedAny) {
            reason = 'error';
            error = truncationError(options.maxOutputBytes, limits.totalBytes);
        }
        const signal = event.signal ?? (timedOut ? lastSignal : undefined);
        // A stream can already be terminated from the outside (plugin unload →
        // `StreamHub.dispose`). Its terminal frames are authoritative: emitting them
        // twice would violate ICD §3, so the result adopts what the wire already saw.
        const existingEnd = writer.terminal().end;
        if (existingEnd !== undefined) {
            reason = existingEnd.reason;
            error = existingEnd.error;
        }
        else {
            writer.exit({
                code: event.code,
                ...(signal !== undefined && signal !== '' ? { signal } : {}),
                durationMs,
                timedOut,
            });
            writer.end(reason, error);
        }
        const result = {
            streamId,
            exitCode: event.code,
            ...(signal !== undefined && signal !== '' ? { signal } : {}),
            durationMs,
            timedOut,
            endReason: reason,
            truncated,
            stdout: pump.capture('stdout'),
            stderr: pump.capture('stderr'),
            binary: { stdout: pump.isBinary('stdout'), stderr: pump.isBinary('stderr') },
            bytes: { stdout: pump.seenBytes('stdout'), stderr: pump.seenBytes('stderr') },
            ...(error !== undefined ? { error } : {}),
        };
        logger?.debug?.(`dsh-ssh: exec ${streamId} ended reason=${reason} exit=${event.code ?? 'null'} ` +
            `bytes=${result.bytes.stdout + result.bytes.stderr} timedOut=${timedOut} truncated=${truncatedAny}`);
        resolveDone(result);
    }
    /** Report a failure that happened before (or instead of) a channel. */
    function failStart(error) {
        if (finished)
            return;
        finished = true;
        detach();
        pump.drain();
        if (writer.ended) {
            const existing = writer.terminal().end;
            resolveDone({
                streamId,
                exitCode: null,
                durationMs: now() - startedAt,
                timedOut: false,
                endReason: existing?.reason ?? 'error',
                truncated: { stdout: false, stderr: false },
                stdout: pump.capture('stdout'),
                stderr: pump.capture('stderr'),
                binary: { stdout: pump.isBinary('stdout'), stderr: pump.isBinary('stderr') },
                bytes: { stdout: pump.seenBytes('stdout'), stderr: pump.seenBytes('stderr') },
                ...(existing?.error !== undefined ? { error: existing.error } : {}),
            });
            return;
        }
        writer.exit({ code: null, durationMs: now() - startedAt, timedOut: false });
        writer.end('error', error);
        resolveDone({
            streamId,
            exitCode: null,
            durationMs: now() - startedAt,
            timedOut: false,
            endReason: 'error',
            truncated: { stdout: false, stderr: false },
            stdout: '',
            stderr: '',
            binary: { stdout: false, stderr: false },
            bytes: { stdout: 0, stderr: 0 },
            error,
        });
    }
    const onAbort = () => {
        if (finished)
            return;
        escalator.cancel();
    };
    const removeAbortListener = () => {
        try {
            options.signal?.removeEventListener('abort', onAbort);
        }
        catch {
            /* ignore */
        }
    };
    if (options.signal !== undefined) {
        if (options.signal.aborted)
            onAbort();
        else
            options.signal.addEventListener('abort', onAbort, { once: true });
    }
    escalator.start();
    void (async () => {
        try {
            const started = await session.exec({
                command: options.command,
                ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
                ...(options.env !== undefined ? { env: options.env } : {}),
                ...(timeoutMs > 0 ? { timeoutMs } : {}),
                maxOutputBytes: options.maxOutputBytes,
                ...(pty
                    ? {
                        pty: true,
                        cols: options.cols ?? 80,
                        rows: options.rows ?? 24,
                        term: options.term ?? 'xterm-256color',
                    }
                    : {}),
            });
            if (finished) {
                // Cancelled while the channel was opening: make sure it cannot linger.
                try {
                    started.cancel();
                }
                catch {
                    /* ignore */
                }
                return;
            }
            handle = started;
            // A cancel or a deadline may have fired while the channel was still
            // opening; the signal reached no channel then, so it is applied now. The
            // escalation's own escalation is kept: if it is already past SIGTERM, the
            // channel gets SIGKILL rather than a polite request.
            if (escalator.cause !== undefined) {
                try {
                    started.cancel();
                }
                catch (error) {
                    logger?.warn?.(`dsh-ssh: exec ${streamId} late cancel failed: ${messageOf(error)}`);
                }
                if (escalator.phase === 'kill-sent') {
                    try {
                        started.signal('KILL');
                    }
                    catch (error) {
                        logger?.warn?.(`dsh-ssh: exec ${streamId} late SIGKILL failed: ${messageOf(error)}`);
                    }
                }
            }
            offData = started.onData((channel, chunk) => {
                if (finished)
                    return;
                try {
                    pump.push(frameChannel(channel), chunk);
                }
                catch (error) {
                    logger?.warn?.(`dsh-ssh: exec ${streamId} data pump failed: ${messageOf(error)}`);
                }
            });
            offExit = started.onExit((event) => {
                settle(event);
            });
            if (options.stdin !== undefined && !inputClosed) {
                // One write and one end-of-input, ever: `endInput()` is idempotent per
                // ICD v1.0.4, but a second `write()` after it would throw.
                inputClosed = true;
                try {
                    started.write(options.stdin);
                    requestEndOfInput(started);
                }
                catch (error) {
                    logger?.warn?.(`dsh-ssh: exec ${streamId} could not write stdin: ${messageOf(error)}`);
                }
            }
        }
        catch (error) {
            failStart(toErrorInfo(error));
        }
    })();
    return { streamId, done };
}
/** The structured report a truncating stream ends with (ICD §4.4). */
export function truncationError(maxOutputBytes, totalBytes) {
    return {
        code: 'SSH_LIMIT_OUTPUT_TRUNCATED',
        message: `output exceeded maxOutputBytes (${maxOutputBytes}); kept head+tail`,
        details: { maxOutputBytes, totalBytes },
        retryable: isRetryable('SSH_LIMIT_OUTPUT_TRUNCATED'),
    };
}
/** The structured report a timed-out command carries (ICD §5 `SSH_TIMEOUT_OPERATION`). */
export function timeoutError(timeoutMs) {
    return {
        code: 'SSH_TIMEOUT_OPERATION',
        message: `command exceeded its ${timeoutMs} ms deadline and was terminated`,
        details: { timeoutMs },
        retryable: isRetryable('SSH_TIMEOUT_OPERATION'),
    };
}
/**
 * Ask the channel for end-of-input (ICD v1.0.4 §7.1 `ExecHandle.endInput()`).
 *
 * Kept tolerant of a handle that predates the ICD addition: a missing method must
 * not fail the call, because the write itself already happened.
 */
function requestEndOfInput(handle) {
    const candidate = handle;
    if (typeof handle.endInput === 'function') {
        handle.endInput();
        return;
    }
    for (const name of ['endStdin', 'end']) {
        const method = candidate[name];
        if (typeof method === 'function') {
            ;
            method.call(handle);
            return;
        }
    }
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=exec.js.map