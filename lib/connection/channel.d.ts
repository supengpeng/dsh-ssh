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
import type { ClientChannelPort, ExecExit, ExecHandle, LoggerPort, ShellHandle, StreamId } from './types.js';
export interface ChannelHandleOptions {
    streamId: StreamId;
    channel: ClientChannelPort;
    logger: LoggerPort;
    now: () => number;
    /** `kind` only affects log wording. */
    kind: 'exec' | 'shell';
    /** Command/term label for logs; never contains secrets. */
    label: string;
    /** Cooperative deadline; `undefined` = no deadline. */
    timeoutMs?: number | undefined;
    /** `config.graceKillMs`: SIGTERM → SIGKILL delay. */
    graceKillMs: number;
    /** Output accounting hook (session `metrics.bytesIn`). */
    onBytesIn?: ((bytes: number) => void) | undefined;
    /** Stdin accounting hook (session `metrics.bytesOut`). */
    onBytesOut?: ((bytes: number) => void) | undefined;
    /** Called exactly once when the channel finished. */
    onFinished?: (() => void) | undefined;
}
type DataListener = (channel: 'stdout' | 'stderr', chunk: Buffer) => void;
type ExitListener = (event: ExecExit) => void;
export declare class ChannelHandle implements ShellHandle {
    readonly streamId: StreamId;
    private readonly channel;
    private readonly logger;
    private readonly now;
    private readonly kind;
    private readonly label;
    private readonly onBytesIn;
    private readonly onBytesOut;
    private readonly onFinished;
    private readonly startedAt;
    private readonly dataListeners;
    private readonly exitListeners;
    private readonly pending;
    private pendingBytes;
    private droppedBytes;
    private finished;
    private stdinEnded;
    private cancelled;
    private timedOut;
    private exitEvent;
    private exitStatus;
    private termTimer;
    private killTimer;
    private cancelTimer;
    constructor(options: ChannelHandleOptions);
    onData(cb: DataListener): () => void;
    onExit(cb: ExitListener): () => void;
    write(stdin: string | Buffer): void;
    endInput(): void;
    signal(sig: 'INT' | 'TERM' | 'KILL' | 'QUIT' | 'HUP'): void;
    cancel(): void;
    resize(cols: number, rows: number): void;
    private emitData;
    private finish;
    /** Deadline / cancel path: close the channel and settle the terminal event. */
    private forceFinish;
    private schedule;
    private clearTimers;
}
/** True when a handle satisfies the frozen `ExecHandle` surface (used by tests). */
export declare function isExecHandle(value: unknown): value is ExecHandle;
export {};
//# sourceMappingURL=channel.d.ts.map