/**
 * §4.4 command execution and interactive shells.
 *
 * The wire layer's job here is narrow and exact:
 *
 *   1. **A stream is held for as long as the command runs.** The concurrency gate
 *      (`SessionRegistry.run`, ICD §7.1) is acquired before the channel opens and
 *      released only when the terminal `end` frame has been produced — "10
 *      concurrent operations" must mean *running* operations, not calls that
 *      happened to start close together.
 *   2. **`execWait` reports timeouts and truncation as data.** A timed-out command
 *      still has stdout the user asked for, and `SSH_LIMIT_OUTPUT_TRUNCATED` is
 *      explicitly "truncated, not failed" (ICD §4.4); both are returned, never
 *      thrown. Only real failures reject.
 *   3. **A replay gap is explicit.** Resuming after a transport break with a
 *      `sinceSeq` the hub no longer retains produces a terminal error frame with
 *      `SSH_LIMIT_OUTPUT_TRUNCATED`, exactly as the ICD's调度不变式 requires — a
 *      silently short stream would look like a command that produced less output.
 */
import { SshError } from '../protocol.js';
import { newStreamId } from '../connection/ids.js';
import { objectJson, optionalBoolean, optionalNumber, optionalString, readParams, requiredEnum, requiredString, stringMapJson } from './params.js';
import { ApiGroup, sessionOf } from './deps.js';
import { FrameQueue } from './frames.js';
const SIGNALS = ['INT', 'TERM', 'KILL', 'QUIT', 'HUP'];
export class ExecApi extends ApiGroup {
    /**
     * ICD §4.4 `exec` (stream).
     *
     * `yield*` inside a generator that already decoded the request: the parameter
     * decoding must happen *inside* the stream, because a Remote stream method
     * receives its arguments the same lossy way a unary one does.
     */
    async *exec(raw) {
        const { params } = readParams(raw);
        const sessionId = requiredString(params, 'sessionId');
        const command = requiredString(params, 'command', 'the command to run');
        const cwd = optionalString(params, 'cwd');
        const env = stringMapJson(params, 'env');
        const timeoutMs = optionalNumber(params, 'timeoutMs');
        const maxOutputBytes = optionalNumber(params, 'maxOutputBytes');
        const sinceSeq = optionalNumber(params, 'sinceSeq');
        // ICD v1.0.9: a one-shot command may run on a PTY. Note the documented
        // consequence — a PTY merges the remote's stderr into its stdout, so a
        // `pty:true` stream carries `channel:'stdout'` data frames only. That is the
        // remote's behaviour, not a frame we dropped.
        const pty = optionalBoolean(params, 'pty') === true;
        const cols = optionalNumber(params, 'cols');
        const rows = optionalNumber(params, 'rows');
        const term = optionalString(params, 'term');
        yield* this.runStream(sessionId, 'exec', sinceSeq, (signal) => this.deps.exec.exec({
            sessionId,
            command,
            ...(cwd === undefined ? {} : { cwd }),
            ...(env === undefined ? {} : { env }),
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
            ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
        }, {
            signal,
            ...(pty
                ? {
                    pty: true,
                    ...(cols === undefined ? {} : { cols }),
                    ...(rows === undefined ? {} : { rows }),
                    ...(term === undefined ? {} : { term }),
                }
                : {}),
        }));
    }
    /** ICD §4.4 `execWait` (unary). */
    async execWait(raw) {
        const { params } = readParams(raw);
        const sessionId = requiredString(params, 'sessionId');
        const command = requiredString(params, 'command', 'the command to run');
        const cwd = optionalString(params, 'cwd');
        const env = stringMapJson(params, 'env');
        const timeoutMs = optionalNumber(params, 'timeoutMs');
        const maxOutputBytes = optionalNumber(params, 'maxOutputBytes');
        const started = this.now();
        try {
            const result = await this.deps.registry.run(sessionId, 'execWait', async (signal) => this.deps.exec.execWait({
                sessionId,
                command,
                ...(cwd === undefined ? {} : { cwd }),
                ...(env === undefined ? {} : { env }),
                ...(timeoutMs === undefined ? {} : { timeoutMs }),
                ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
            }, { signal }));
            this.audit({
                op: 'exec',
                outcome: 'ok',
                sessionId,
                durationMs: Math.max(0, this.now() - started),
                detail: {
                    command,
                    exitCode: result.exitCode,
                    timedOut: result.timedOut,
                    truncated: result.truncated.stdout || result.truncated.stderr,
                    streamId: result.streamId,
                },
            });
            return {
                streamId: result.streamId,
                exitCode: result.exitCode,
                ...(result.signal === undefined ? {} : { signal: result.signal }),
                stdout: result.stdout,
                stderr: result.stderr,
                truncated: { stdout: result.truncated.stdout, stderr: result.truncated.stderr },
                durationMs: result.durationMs,
                timedOut: result.timedOut,
                endReason: result.endReason,
                bytes: { stdout: result.bytes.stdout, stderr: result.bytes.stderr },
                ...(result.error === undefined ? {} : { error: result.error }),
            };
        }
        catch (error) {
            this.audit({
                op: 'exec',
                outcome: 'error',
                sessionId,
                durationMs: Math.max(0, this.now() - started),
                detail: { command, code: error instanceof SshError ? error.code : 'SSH_UNKNOWN' },
            });
            throw error;
        }
    }
    /** ICD §4.4 `openShell` (stream). */
    async *openShell(raw) {
        const { params } = readParams(raw);
        const sessionId = requiredString(params, 'sessionId');
        const cols = optionalNumber(params, 'cols') ?? 80;
        const rows = optionalNumber(params, 'rows') ?? 24;
        const term = optionalString(params, 'term');
        const cwd = optionalString(params, 'cwd');
        const env = stringMapJson(params, 'env');
        yield* this.runStream(sessionId, 'shell', undefined, (signal) => 
        // A PTY has no deadline of its own: a terminal lives until the user closes
        // it, which is what `shellClose` and the session teardown are for. The
        // signal is still honoured, so removing the session cancels the channel.
        this.deps.exec.openShell({
            sessionId,
            cols,
            rows,
            ...(term === undefined ? {} : { term }),
            ...(cwd === undefined ? {} : { cwd }),
            ...(env === undefined ? {} : { env }),
        }));
    }
    /** ICD §4.4 `shellWrite`. */
    shellWrite(raw) {
        const { params } = readParams(raw);
        const streamId = requiredString(params, 'streamId');
        const data = typeof params['data'] === 'string' ? params['data'] : '';
        if (data === '')
            throw new SshError('SSH_CFG_INVALID', 'data is required');
        const encoding = optionalString(params, 'encoding');
        if (encoding !== undefined && encoding !== 'utf8' && encoding !== 'base64') {
            throw new SshError('SSH_CFG_INVALID', 'encoding must be utf8 or base64');
        }
        return this.deps.exec.shellWrite({
            streamId,
            data,
            ...(encoding === undefined ? {} : { encoding: encoding }),
        });
    }
    /** ICD §4.4 `shellResize`. */
    shellResize(raw) {
        const { params } = readParams(raw);
        return this.deps.exec.shellResize({
            streamId: requiredString(params, 'streamId'),
            cols: optionalNumber(params, 'cols') ?? 80,
            rows: optionalNumber(params, 'rows') ?? 24,
        });
    }
    /** ICD §4.4 `shellSignal`. */
    shellSignal(raw) {
        const { params } = readParams(raw);
        return this.deps.exec.shellSignal({
            streamId: requiredString(params, 'streamId'),
            signal: requiredEnum(params, 'signal', SIGNALS),
        });
    }
    /** ICD §4.4 `shellClose`. */
    shellClose(raw) {
        const { params } = readParams(raw);
        const streamId = requiredString(params, 'streamId');
        const result = this.deps.exec.shellClose({ streamId });
        this.auditOutcome('shellClose', 'ok', { streamId });
        return result;
    }
    /** ICD §4.4 `listStreams`. */
    listStreams(raw) {
        const { params } = readParams(raw);
        const sessionId = requiredString(params, 'sessionId');
        // Fail fast for a session that does not exist: an empty list would read as
        // "this session has no streams" rather than "this session is gone".
        sessionOf(this.deps, sessionId);
        return this.deps.exec.listStreams({ sessionId });
    }
    // ── internals ────────────────────────────────────────────────────────────
    /**
     * Start a channel and pump its frames, holding the session's operation slot for
     * the whole stream.
     *
     * The gate is acquired *around* the stream's lifetime rather than around the
     * start call: `SSH_LIMIT_QUEUE_FULL` must mean "this session is already running
     * the maximum number of operations", which is only true while those operations
     * are still producing output.
     */
    async *runStream(sessionId, op, sinceSeq, start) {
        const queue = new FrameQueue();
        let unsubscribe;
        let releaseStream;
        const finished = new Promise((resolve) => {
            releaseStream = resolve;
        });
        // A session that is gone fails before any frame is produced, so the client's
        // `stream()` rejects with SSH_STATE_INVALID instead of receiving `open` and
        // then nothing.
        sessionOf(this.deps, sessionId);
        const gate = this.deps.registry.run(sessionId, op, async (signal) => {
            const started = start(signal);
            const subscription = this.deps.exec.subscribe(started.streamId, (frame) => queue.push(frame), sinceSeq === undefined ? {} : { sinceSeq });
            unsubscribe = () => subscription.unsubscribe();
            if (subscription.gap) {
                // The retained replay window cannot satisfy the resume point (ICD §3):
                // say so explicitly instead of delivering a short stream.
                queue.push({
                    t: 'end',
                    streamId: started.streamId,
                    reason: 'error',
                    error: {
                        code: 'SSH_LIMIT_OUTPUT_TRUNCATED',
                        message: 'the requested replay window is no longer retained; resubscribe from the live stream',
                        details: { sinceSeq },
                        retryable: false,
                    },
                });
            }
            await finished;
        });
        // An immediate gate rejection (over-limit, unknown session) must reach the
        // consumer as a failure, not as an empty stream.
        gate.catch((error) => queue.fail(error));
        try {
            for await (const frame of queue) {
                yield frame;
                if (frame.t === 'end')
                    break;
            }
        }
        finally {
            unsubscribe?.();
            releaseStream?.();
            await gate.catch(() => undefined);
        }
    }
}
//# sourceMappingURL=exec-api.js.map