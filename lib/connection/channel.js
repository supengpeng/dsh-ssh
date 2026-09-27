/**
 * `ExecHandle` / `ShellHandle` implementation (ICD §7.1, v1.0.4).
 *
 * One instance owns one `ssh2` channel. The handle is the *only* place that
 * knows when a channel dies, so it is also the place that guarantees the ICD's
 * terminal-event invariants: exactly one `exit` event, always after the last
 * `data` event, `timedOut` set when the deadline fired, and no silent loss of
 * output (chunks that arrive before the first subscriber are buffered, not
 * dropped).
 *
 * Deadline (ICD §4.4): at `timeoutMs` send SIGTERM, at `timeoutMs + graceKillMs`
 * send SIGKILL and force the channel closed; every exit after the TERM reports
 * `timedOut: true`. The exec layer may run the same escalation on its side — the
 * handle is idempotent, so the observable outcome is one terminal event.
 */
import { SshError } from '../protocol.js';
/** Grace between `cancel()`'s TERM and the forced channel close. */
const CANCEL_GRACE_MS = 750;
/** Buffered bytes kept for subscribers that attach after the first chunk. */
const PRE_SUBSCRIBE_BUFFER_BYTES = 4 * 1024 * 1024;
export class ChannelHandle {
    streamId;
    channel;
    logger;
    now;
    kind;
    label;
    onBytesIn;
    onBytesOut;
    onFinished;
    startedAt;
    dataListeners = new Set();
    exitListeners = new Set();
    pending = [];
    pendingBytes = 0;
    droppedBytes = 0;
    finished = false;
    stdinEnded = false;
    cancelled = false;
    timedOut = false;
    exitEvent;
    exitStatus;
    termTimer;
    killTimer;
    cancelTimer;
    constructor(options) {
        this.streamId = options.streamId;
        this.channel = options.channel;
        this.logger = options.logger;
        this.now = options.now;
        this.kind = options.kind;
        this.label = options.label;
        this.onBytesIn = options.onBytesIn;
        this.onBytesOut = options.onBytesOut;
        this.onFinished = options.onFinished;
        this.startedAt = this.now();
        this.channel.on('data', (chunk) => {
            this.onBytesIn?.(chunk.length);
            this.emitData('stdout', chunk);
        });
        const stderr = this.channel.stderr;
        stderr?.on('data', (chunk) => {
            this.onBytesIn?.(chunk.length);
            this.emitData('stderr', chunk);
        });
        this.channel.on('exit', (code, signal) => {
            this.exitStatus = { code, signal };
        });
        this.channel.on('close', (code, signal) => {
            const status = this.exitStatus;
            this.finish(status === undefined ? (code ?? null) : status.code, status === undefined ? signal : status.signal);
        });
        if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
            const grace = Math.max(0, Math.trunc(options.graceKillMs));
            this.termTimer = this.schedule(() => {
                this.timedOut = true;
                this.signal('TERM');
                this.logger.debug(`${this.kind} ${this.streamId} deadline reached; sent TERM (~${options.timeoutMs}ms)`);
            }, options.timeoutMs);
            this.killTimer = this.schedule(() => {
                this.timedOut = true;
                this.signal('KILL');
                this.logger.warn(`${this.kind} ${this.streamId} did not exit after TERM; sent KILL and closed the channel`);
                this.forceFinish();
            }, options.timeoutMs + grace);
        }
    }
    // -- observable surface --------------------------------------------------
    onData(cb) {
        this.dataListeners.add(cb);
        if (this.pending.length > 0) {
            const buffered = this.pending.splice(0, this.pending.length);
            this.pendingBytes = 0;
            for (const item of buffered)
                cb(item.channel, item.chunk);
        }
        if (this.droppedBytes > 0) {
            this.logger.error(`${this.kind} ${this.streamId}: ${this.droppedBytes} bytes arrived before any subscriber and were dropped`);
        }
        return () => {
            this.dataListeners.delete(cb);
        };
    }
    onExit(cb) {
        if (this.exitEvent !== undefined) {
            const event = this.exitEvent;
            queueMicrotask(() => cb(event));
            return () => { };
        }
        this.exitListeners.add(cb);
        return () => {
            this.exitListeners.delete(cb);
        };
    }
    write(stdin) {
        if (this.finished) {
            throw new SshError('SSH_STATE_INVALID', 'cannot write to a closed channel', {
                details: { streamId: this.streamId },
            });
        }
        if (this.stdinEnded) {
            throw new SshError('SSH_STATE_INVALID', 'cannot write after endInput(): stdin was already closed', {
                details: { streamId: this.streamId },
            });
        }
        const bytes = Buffer.byteLength(stdin);
        try {
            this.channel.write(stdin);
            this.onBytesOut?.(bytes);
        }
        catch (error) {
            throw new SshError('SSH_NET_RESET', `writing to channel ${this.streamId} failed: ${errorText(error)}`, {
                details: { streamId: this.streamId },
                cause: error,
            });
        }
    }
    endInput() {
        if (this.finished) {
            throw new SshError('SSH_STATE_INVALID', 'cannot close stdin of a closed channel', {
                details: { streamId: this.streamId },
            });
        }
        if (this.stdinEnded)
            return;
        this.stdinEnded = true;
        try {
            this.channel.end();
        }
        catch (error) {
            this.logger.debug(`${this.kind} ${this.streamId}: stdin end failed: ${errorText(error)}`);
        }
    }
    signal(sig) {
        if (this.finished)
            return;
        try {
            this.channel.signal(sig);
        }
        catch (error) {
            // Signals are best effort: a server may refuse the request, and a channel
            // may already be gone.
            this.logger.debug(`${this.kind} ${this.streamId}: signal ${sig} failed: ${errorText(error)}`);
        }
    }
    cancel() {
        if (this.finished || this.cancelled)
            return;
        this.cancelled = true;
        this.signal('TERM');
        this.cancelTimer = this.schedule(() => {
            this.forceFinish();
        }, CANCEL_GRACE_MS);
    }
    resize(cols, rows) {
        if (this.finished)
            return;
        const safeCols = Math.max(1, Math.trunc(cols));
        const safeRows = Math.max(1, Math.trunc(rows));
        try {
            this.channel.setWindow(safeRows, safeCols, 0, 0);
        }
        catch (error) {
            this.logger.debug(`${this.kind} ${this.streamId}: resize failed: ${errorText(error)}`);
        }
    }
    // -- internals -----------------------------------------------------------
    emitData(channel, chunk) {
        if (this.dataListeners.size === 0) {
            if (this.pendingBytes + chunk.length > PRE_SUBSCRIBE_BUFFER_BYTES) {
                this.droppedBytes += chunk.length;
                return;
            }
            this.pending.push({ channel, chunk });
            this.pendingBytes += chunk.length;
            return;
        }
        for (const listener of [...this.dataListeners]) {
            try {
                listener(channel, chunk);
            }
            catch (error) {
                this.logger.error(`${this.kind} ${this.streamId}: data subscriber threw: ${errorText(error)}`);
            }
        }
    }
    finish(code, signal) {
        if (this.finished)
            return;
        this.finished = true;
        this.clearTimers();
        const event = {
            code,
            ...(signal === undefined ? {} : { signal }),
            durationMs: Math.max(0, this.now() - this.startedAt),
            timedOut: this.timedOut,
        };
        this.exitEvent = event;
        if (this.pending.length > 0) {
            // Deliver whatever arrived before the first subscriber attached, so the
            // terminal event never overtakes buffered output.
            const buffered = this.pending.splice(0, this.pending.length);
            this.pendingBytes = 0;
            for (const item of buffered) {
                for (const listener of [...this.dataListeners]) {
                    try {
                        listener(item.channel, item.chunk);
                    }
                    catch {
                        /* already logged above */
                    }
                }
            }
        }
        for (const listener of [...this.exitListeners]) {
            try {
                listener(event);
            }
            catch (error) {
                this.logger.error(`${this.kind} ${this.streamId}: exit subscriber threw: ${errorText(error)}`);
            }
        }
        this.exitListeners.clear();
        try {
            this.onFinished?.();
        }
        catch {
            /* a bookkeeping hook must not break teardown */
        }
        this.logger.debug(`${this.kind} ${this.streamId} finished (code=${code ?? 'null'}${signal === undefined ? '' : `, signal=${signal}`}, ` +
            `${event.durationMs}ms${event.timedOut ? ', timed out' : ''}${this.cancelled ? ', cancelled' : ''})`);
    }
    /** Deadline / cancel path: close the channel and settle the terminal event. */
    forceFinish() {
        if (this.finished)
            return;
        try {
            this.channel.close();
        }
        catch (error) {
            this.logger.debug(`${this.kind} ${this.streamId}: channel close failed: ${errorText(error)}`);
        }
        const status = this.exitStatus;
        this.finish(status?.code ?? null, status?.signal);
    }
    schedule(task, ms) {
        const timer = setTimeout(task, Math.max(0, ms));
        timer.unref?.();
        return timer;
    }
    clearTimers() {
        for (const timer of [this.termTimer, this.killTimer, this.cancelTimer]) {
            if (timer !== undefined)
                clearTimeout(timer);
        }
        this.termTimer = undefined;
        this.killTimer = undefined;
        this.cancelTimer = undefined;
    }
}
function errorText(error) {
    return error instanceof Error ? error.message : String(error);
}
/** True when a handle satisfies the frozen `ExecHandle` surface (used by tests). */
export function isExecHandle(value) {
    if (value === null || typeof value !== 'object')
        return false;
    const handle = value;
    return (typeof handle.streamId === 'string' &&
        typeof handle.onData === 'function' &&
        typeof handle.onExit === 'function' &&
        typeof handle.write === 'function' &&
        typeof handle.endInput === 'function' &&
        typeof handle.signal === 'function' &&
        typeof handle.cancel === 'function');
}
//# sourceMappingURL=channel.js.map