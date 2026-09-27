/**
 * Interactive PTY shell (ICD §4.4 `openShell` / `shellWrite` / `shellResize` /
 * `shellSignal` / `shellClose`).
 *
 * A terminal is a *device*, not a result, and the runner is built around that
 * difference from {@link startExec}:
 *
 *   - **no output limit on the live path.** Head+tail truncation would freeze the
 *     screen of a full-screen application (`top`, `vim`, `less`) and withhold the
 *     screen the user is looking at until the shell exits. The stream is therefore
 *     unbounded; the hub still bounds the *replay* window for reconnecting
 *     clients and reports a `gap` instead of hiding it.
 *   - **no deadline by default.** An idle prompt must not be killed; a deadline is
 *     only applied when the caller explicitly passes `timeoutMs`.
 *   - **`resize` is first-class.** SIGWINCH is what makes a full-screen app
 *     redraw, and `data.channel:'term'` is the redraw traffic.
 *   - **binary safe.** Terminal output that is not valid UTF-8 is shipped base64
 *     (ICD §4.4) so an application cannot corrupt the frame stream.
 */
import { SshError, toErrorInfo } from '../protocol.js';
import { StreamPump } from './pump.js';
import { KillEscalator, systemTimers } from './timeout.js';
import { isClosedState, sessionStateOf, } from './types.js';
export const DEFAULT_TERM = 'xterm-256color';
export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;
/** Keystrokes held while a PTY is still opening before input is refused. */
export const MAX_PENDING_INPUT = 65_536;
/** Start an interactive shell and return its stream id plus the settlement promise. */
export function startShell(options) {
    const session = options.session;
    const state = sessionStateOf(session);
    if (isClosedState(state)) {
        throw new SshError('SSH_STATE_INVALID', `session ${session.id} is ${state}; cannot open a shell`);
    }
    if (session.info?.capabilities?.shell === false) {
        throw new SshError('SSH_STATE_INVALID', `session ${session.id} does not support a PTY shell`);
    }
    const now = options.now ?? Date.now;
    const timers = options.timers ?? systemTimers;
    const logger = options.logger;
    const graceKillMs = Math.max(0, Math.trunc(options.graceKillMs));
    const timeoutMs = Math.max(0, Math.trunc(options.timeoutMs ?? 0));
    const cols = clampDimension(options.cols, DEFAULT_COLS);
    const rows = clampDimension(options.rows, DEFAULT_ROWS);
    const term = options.term ?? DEFAULT_TERM;
    let handle;
    let offData;
    let offExit;
    let finished = false;
    const pendingInput = [];
    let pendingInputBytes = 0;
    let resolveDone = () => { };
    const done = new Promise((resolve) => {
        resolveDone = resolve;
    });
    const startedAt = now();
    let geometry = { cols, rows };
    const writer = options.hub.open({
        kind: 'shell',
        sessionId: session.id,
        streamId: options.streamId,
        replayLimitBytes: options.replayLimitBytes,
        meta: {
            cols,
            rows,
            term,
            ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
            ...(state !== undefined ? { sessionState: state } : {}),
            // The live terminal path is deliberately unbounded (see the module note);
            // announcing it lets the UI state that plainly instead of inferring it.
            outputLimit: 'none',
        },
    });
    const streamId = writer.streamId;
    const pump = new StreamPump({
        writer,
        bucketOf: () => 'term',
    });
    const escalator = new KillEscalator({
        timeoutMs,
        graceKillMs,
        settleMs: options.settleMs,
        timers,
        onSignal: (signal) => {
            handle?.signal(signal);
        },
        onCancel: () => {
            try {
                handle?.cancel();
            }
            catch (error) {
                logger?.warn?.(`dsh-ssh: shell ${streamId} cancel failed: ${messageOf(error)}`);
            }
        },
        onForceSettle: () => {
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
            const buffer = encoding === 'base64' ? Buffer.from(data, 'base64') : Buffer.from(data, 'utf8');
            if (handle === undefined) {
                // Opening a real PTY takes a round trip, and a user (or a UI that focuses
                // the terminal immediately) types before it is ready. The keystrokes are
                // held briefly and delivered in order instead of being refused; a stream
                // that never opens, or input past the cap, still fails loudly.
                if (finished || pendingInputBytes + buffer.length > MAX_PENDING_INPUT) {
                    throw new SshError('SSH_STATE_INVALID', `shell ${streamId} has no channel yet`);
                }
                pendingInput.push({ data, encoding });
                pendingInputBytes += buffer.length;
                return buffer.length;
            }
            handle.write(buffer);
            return buffer.length;
        },
        resize: (nextCols, nextRows) => {
            const safeCols = clampDimension(nextCols, DEFAULT_COLS);
            const safeRows = clampDimension(nextRows, DEFAULT_ROWS);
            if (handle === undefined)
                throw new SshError('SSH_STATE_INVALID', `shell ${streamId} has no channel yet`);
            handle.resize(safeCols, safeRows);
            geometry = { cols: safeCols, rows: safeRows };
            logger?.debug?.(`dsh-ssh: shell ${streamId} resized to ${safeCols}x${safeRows}`);
        },
        signal: (signal) => {
            handle?.signal(signal);
        },
        cancel: (reason) => {
            if (finished)
                return;
            // `dispose` means the plugin is going away, not that the user closed the
            // terminal: reporting it as `cancelled` would blame the wrong side.
            if (reason === 'dispose' || reason === 'peer-closed') {
                terminateNow('peer-closed');
                return;
            }
            escalator.cancel();
        },
        close: () => {
            if (finished)
                return;
            escalator.cancel();
        },
        terminated: () => {
            finishFromWriter();
        },
    };
    options.hub.attach(streamId, controls);
    /** Stop consuming the channel; safe to call more than once. */
    function detach() {
        escalator.settle();
        try {
            offData?.();
            offExit?.();
        }
        catch {
            /* best-effort */
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
            bytes: pump.seenBytes('term'),
            binary: pump.isBinary('term'),
            ...(end?.error !== undefined ? { error: end.error } : {}),
        });
    }
    /** Terminate the stream here and now (plugin unload / peer close). */
    function terminateNow(reason) {
        if (finished)
            return;
        // Claim the transition before touching the channel: the app's own exit
        // notification would otherwise re-enter `settle()` and mislabel the stream as
        // a client cancellation.
        finished = true;
        detach();
        try {
            handle?.cancel();
        }
        catch (error) {
            logger?.warn?.(`dsh-ssh: shell ${streamId} stop on dispose failed: ${messageOf(error)}`);
        }
        pump.drain();
        if (!writer.ended) {
            writer.exit({ code: null, durationMs: now() - startedAt, timedOut: false });
            writer.end(reason);
        }
        resolveFromWriter();
    }
    /** The hub terminated the stream itself (plugin unload); adopt its frames. */
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
        let reason = timedOut ? 'timeout' : cause === 'cancelled' ? 'cancelled' : 'completed';
        const signal = event.signal ?? (timedOut ? lastSignal : undefined);
        // `StreamHub.dispose` may have terminated the stream already (plugin unload);
        // its terminal frames are authoritative, so they are never emitted twice.
        const existingEnd = writer.terminal().end;
        if (existingEnd !== undefined) {
            reason = existingEnd.reason;
        }
        else {
            writer.exit({
                code: event.code,
                ...(signal !== undefined && signal !== '' ? { signal } : {}),
                durationMs,
                timedOut,
            });
            writer.end(reason);
        }
        const result = {
            streamId,
            exitCode: event.code,
            ...(signal !== undefined && signal !== '' ? { signal } : {}),
            durationMs,
            timedOut,
            endReason: reason,
            bytes: pump.seenBytes('term'),
            binary: pump.isBinary('term'),
        };
        logger?.debug?.(`dsh-ssh: shell ${streamId} ended reason=${reason} exit=${event.code ?? 'null'} ` +
            `bytes=${result.bytes} geometry=${geometry.cols}x${geometry.rows}`);
        resolveDone(result);
    }
    function failStart(error) {
        if (finished)
            return;
        finished = true;
        escalator.settle();
        pump.drain();
        const existing = writer.terminal().end;
        if (existing === undefined) {
            writer.exit({ code: null, durationMs: now() - startedAt, timedOut: false });
            writer.end('error', error);
        }
        resolveDone({
            streamId,
            exitCode: null,
            durationMs: now() - startedAt,
            timedOut: false,
            endReason: existing?.reason ?? 'error',
            bytes: pump.seenBytes('term'),
            binary: pump.isBinary('term'),
            ...(existing?.error !== undefined ? { error: existing.error } : { error }),
        });
    }
    escalator.start();
    void (async () => {
        try {
            const started = await session.shell({
                cols: geometry.cols,
                rows: geometry.rows,
                term,
                ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
                ...(options.env !== undefined ? { env: options.env } : {}),
                ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
                ...(timeoutMs > 0 ? { timeoutMs } : {}),
            });
            if (finished) {
                try {
                    started.cancel();
                }
                catch {
                    /* ignore */
                }
                return;
            }
            handle = started;
            // A close/timeout that fired before the PTY existed reached no channel.
            if (escalator.cause !== undefined) {
                try {
                    started.cancel();
                }
                catch (error) {
                    logger?.warn?.(`dsh-ssh: shell ${streamId} late cancel failed: ${messageOf(error)}`);
                }
                if (escalator.phase === 'kill-sent') {
                    try {
                        started.signal('KILL');
                    }
                    catch (error) {
                        logger?.warn?.(`dsh-ssh: shell ${streamId} late SIGKILL failed: ${messageOf(error)}`);
                    }
                }
            }
            offData = started.onData((channel, chunk) => {
                if (finished)
                    return;
                try {
                    // A PTY has one channel; whatever ssh2 reports, it is terminal output.
                    pump.push('term', chunk);
                }
                catch (error) {
                    logger?.warn?.(`dsh-ssh: shell ${streamId} data pump failed: ${messageOf(error)}`);
                }
            });
            offExit = started.onExit((event) => {
                settle(event);
            });
            // Deliver keystrokes that arrived while the PTY was still opening.
            if (pendingInput.length > 0) {
                for (const pending of pendingInput) {
                    try {
                        started.write(pending.encoding === 'base64' ? Buffer.from(pending.data, 'base64') : pending.data);
                    }
                    catch (error) {
                        logger?.warn?.(`dsh-ssh: shell ${streamId} could not deliver buffered input: ${messageOf(error)}`);
                    }
                }
                pendingInput.length = 0;
                pendingInputBytes = 0;
            }
        }
        catch (error) {
            failStart(toErrorInfo(error));
        }
    })();
    return { streamId, done };
}
/** Terminal geometry must stay positive and sane; a 0-column PTY breaks curses apps. */
export function clampDimension(value, fallback) {
    if (value === undefined || !Number.isFinite(value))
        return fallback;
    const truncated = Math.trunc(value);
    if (truncated < 1)
        return 1;
    if (truncated > 1000)
        return 1000;
    return truncated;
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=shell.js.map