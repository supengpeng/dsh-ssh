/**
 * `ExecService` — the object the wire layer (ICD §4.4) talks to.
 *
 * It is the only stateful piece of this folder: it resolves sessions, keeps the
 * {@link StreamHub}, applies the configured defaults (`operationTimeoutMs`,
 * `maxOutputBytes`, `graceKillMs`) and exposes one method per frozen endpoint:
 *
 *     exec / execWait / openShell / shellWrite / shellResize / shellSignal /
 *     shellClose / listStreams  (+ cancel for the client's abort path)
 *
 * Frame delivery is decoupled on purpose: the endpoints return a `streamId` and
 * the transport subscribes with {@link ExecService.subscribe}, which is also the
 * only supported way to resume after a break (ICD §4.4 `sinceSeq` — polling is
 * forbidden). Everything is transport-agnostic, so the same object serves the
 * Remote RPC path and the exact-route fallback.
 */
import { SshError, toErrorInfo } from '../protocol.js';
import { startExec } from './exec.js';
import { startShell, clampDimension } from './shell.js';
import { StreamHub } from './streams.js';
import { isSessionHandle } from './types.js';
export class ExecService {
    hub;
    options;
    now;
    log;
    disposed = false;
    constructor(options) {
        this.options = options;
        this.now = options.now ?? Date.now;
        this.log = options.logger;
        this.hub = new StreamHub({
            now: this.now,
            replayLimitBytes: options.replayLimitBytes ?? options.limits.maxOutputBytes,
            ...(options.replayLimitFrames === undefined ? {} : { replayLimitFrames: options.replayLimitFrames }),
            maxFinishedStreams: options.maxFinishedStreams,
            onViolation: (violation) => this.log?.warn?.(`dsh-ssh: frame invariant: ${violation}`),
        });
    }
    /** Effective limits, so the wire layer and the tool advertise the same numbers. */
    get limits() {
        return { ...this.options.limits };
    }
    get activeStreams() {
        return this.hub.liveCount;
    }
    /**
     * ICD §4.4 `exec`: start a streaming command.
     *
     * `options.signal` is the wire layer's `opts.signal`: aborting it cancels the
     * command. The wire layer needs only `streamId`; `done` is returned for
     * embedders and tests, and never rejects (failures arrive as frames and in the
     * result).
     */
    exec(params, options = {}) {
        return this.startCommand(params, options);
    }
    /** ICD §4.4 `execWait`: run a command and return its complete result. */
    async execWait(params, options = {}) {
        const started = this.startCommand(params, options);
        const result = await started.done;
        // A timeout and a truncation are *reported* outcomes, not exceptions: the
        // caller still needs stdout/stderr/exitCode to show the user (ICD §4.4).
        if (result.error !== undefined && !isReportedOutcome(result.error.code)) {
            throw new SshError(result.error.code, result.error.message, { details: result.error.details });
        }
        return result;
    }
    /** ICD §4.4 `openShell`: start an interactive PTY (`done` as for {@link exec}). */
    openShell(params) {
        const session = this.sessionOf(params.sessionId);
        return startShell({
            session,
            hub: this.hub,
            cols: clampDimension(params.cols, 80),
            rows: clampDimension(params.rows, 24),
            ...(params.term !== undefined ? { term: params.term } : {}),
            ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
            ...(params.env !== undefined ? { env: params.env } : {}),
            maxOutputBytes: this.options.limits.maxOutputBytes,
            graceKillMs: this.options.limits.graceKillMs,
            ...(this.options.settleMs !== undefined ? { settleMs: this.options.settleMs } : {}),
            ...(this.options.timers !== undefined ? { timers: this.options.timers } : {}),
            now: this.now,
            logger: this.log,
        });
    }
    /** ICD §4.4 `shellWrite`. */
    shellWrite(params) {
        const encoding = params.encoding === 'base64' ? 'base64' : 'utf8';
        const written = this.hub.write(params.streamId, params.data, encoding);
        return { written };
    }
    /** ICD §4.4 `shellResize`. */
    shellResize(params) {
        this.hub.resize(params.streamId, clampDimension(params.cols, 80), clampDimension(params.rows, 24));
        return { resized: true };
    }
    /** ICD §4.4 `shellSignal`. */
    shellSignal(params) {
        this.hub.signal(params.streamId, params.signal);
        return { sent: true };
    }
    /** ICD §4.4 `shellClose`. */
    shellClose(params) {
        if (!this.hub.close(params.streamId, 'cancelled')) {
            throw new SshError('SSH_STATE_INVALID', `unknown or finished stream ${params.streamId}`);
        }
        return { closed: true };
    }
    /** ICD §4.4 `listStreams`. */
    listStreams(params) {
        return { streams: this.hub.list(params.sessionId) };
    }
    /** Client-side abort of one stream (`opts.signal` → `cancel()`). */
    cancel(streamId) {
        return this.hub.cancel(streamId, 'cancelled');
    }
    /**
     * Deliver frames for one stream, resuming after `sinceSeq` when given.
     *
     * `gap:true` means the request reaches before the retained window: the caller
     * MUST surface that as `SSH_LIMIT_OUTPUT_TRUNCATED` rather than silently
     * dropping the difference (ICD §3).
     */
    subscribe(streamId, onFrame, options = {}) {
        return this.hub.subscribe(streamId, onFrame, options);
    }
    /** Session summaries, for the tool's "which session?" hint. */
    sessions() {
        try {
            return this.options.listSessions?.() ?? [];
        }
        catch {
            return [];
        }
    }
    /** Terminate every stream (plugin unload). Frames an `end` for each. */
    dispose(reason = 'peer-closed') {
        if (this.disposed)
            return;
        this.disposed = true;
        this.hub.dispose(reason);
    }
    // ── internals ────────────────────────────────────────────────────────────
    startCommand(params, options = {}) {
        if (this.disposed)
            throw new SshError('SSH_STATE_INVALID', 'the exec service has been disposed');
        const session = this.sessionOf(params.sessionId);
        const command = typeof params.command === 'string' ? params.command : '';
        if (command.trim() === '') {
            throw new SshError('SSH_CFG_INVALID', 'exec requires a non-empty command');
        }
        const timeoutMs = resolveTimeout(params.timeoutMs, this.options.limits.operationTimeoutMs);
        const started = startExec({
            session,
            hub: this.hub,
            command,
            ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
            ...(params.env !== undefined ? { env: params.env } : {}),
            ...(timeoutMs > 0 ? { timeoutMs } : {}),
            maxOutputBytes: resolveMaxOutput(params.maxOutputBytes, this.options.limits.maxOutputBytes),
            graceKillMs: this.options.limits.graceKillMs,
            ...(this.options.settleMs !== undefined ? { settleMs: this.options.settleMs } : {}),
            ...(this.options.timers !== undefined ? { timers: this.options.timers } : {}),
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
            ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
            ...(options.pty === true
                ? {
                    pty: true,
                    ...(options.cols !== undefined ? { cols: clampDimension(options.cols, 80) } : {}),
                    ...(options.rows !== undefined ? { rows: clampDimension(options.rows, 24) } : {}),
                    ...(options.term !== undefined ? { term: options.term } : {}),
                }
                : {}),
            now: this.now,
            logger: this.log,
        });
        // The activity mirror (ICD §4.7) observes a command that is still running, so
        // its subscription lives exactly as long as the command does: released when
        // `done` settles, never left attached to a finished stream. A throwing observer
        // is contained here — the mirror reports on the command, and a report must not
        // be able to fail what it reports on.
        const onFrame = options.onFrame;
        if (onFrame !== undefined) {
            const subscription = this.hub.subscribe(started.streamId, (frame) => {
                try {
                    onFrame(frame);
                }
                catch (error) {
                    this.log?.warn?.(`dsh-ssh: exec frame observer threw: ${error instanceof Error ? error.message : String(error)}`);
                }
            });
            const release = () => subscription.unsubscribe();
            void started.done.then(release, release);
        }
        return started;
    }
    /**
     * Which session a call actually targets.
     *
     * The wire always names one; the agent tool may omit it and fall back to the
     * deployment's active session. A call that cannot be resolved fails with the
     * list of available sessions in `details`, because "unknown session" with no
     * alternative is the least actionable error a tool can return.
     */
    resolveTargetSession(requested) {
        if (typeof requested === 'string' && requested !== '')
            return requested;
        const fallback = this.options.defaultSessionId?.();
        if (typeof fallback === 'string' && fallback !== '')
            return fallback;
        const sessions = this.sessions();
        throw new SshError('SSH_CFG_INVALID', sessions.length === 0
            ? 'no SSH session is available; connect to a host first'
            : 'sessionId is required: more than one session may be connected', { details: { sessions } });
    }
    sessionOf(sessionId) {
        if (typeof sessionId !== 'string' || sessionId === '') {
            throw new SshError('SSH_CFG_INVALID', 'sessionId is required');
        }
        const session = this.options.resolveSession(sessionId);
        if (session === undefined || session === null) {
            throw new SshError('SSH_STATE_INVALID', `unknown session ${sessionId}; connect first`);
        }
        if (!isSessionHandle(session)) {
            throw new SshError('SSH_STATE_INVALID', `session ${sessionId} is not an exec-capable handle`);
        }
        return session;
    }
}
/** `undefined` = configured default; `0` = no deadline; negatives are clamped out. */
function resolveTimeout(requested, configured) {
    if (requested === undefined)
        return Math.max(0, Math.trunc(configured));
    if (!Number.isFinite(requested))
        return Math.max(0, Math.trunc(configured));
    return Math.max(0, Math.trunc(requested));
}
function resolveMaxOutput(requested, configured) {
    const value = requested === undefined || !Number.isFinite(requested) ? configured : requested;
    return Math.max(1, Math.trunc(value));
}
/**
 * Outcomes a caller must see as data rather than as a thrown error.
 *
 * `SSH_LIMIT_OUTPUT_TRUNCATED` is explicitly "reported, not a failure" (ICD
 * §4.4), and `SSH_TIMEOUT_OPERATION` accompanies a result that still carries the
 * output the user asked for (`timedOut:true`, DESIGN §4 `ExecResult`).
 */
export function isReportedOutcome(code) {
    return code === 'SSH_LIMIT_OUTPUT_TRUNCATED' || code === 'SSH_TIMEOUT_OPERATION';
}
//# sourceMappingURL=service.js.map