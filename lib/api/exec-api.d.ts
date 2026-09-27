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
import { type ErrorInfo, type Frame } from '../protocol.js';
import { ApiGroup } from './deps.js';
/** ICD §4.4 `ExecResult` (plus the end reason, which makes a truncation diagnosable). */
export interface ExecResultWire {
    streamId: string;
    exitCode: number | null;
    signal?: string;
    stdout: string;
    stderr: string;
    truncated: {
        stdout: boolean;
        stderr: boolean;
    };
    durationMs: number;
    timedOut: boolean;
    endReason: string;
    bytes: {
        stdout: number;
        stderr: number;
    };
    error?: ErrorInfo;
}
export declare class ExecApi extends ApiGroup {
    /**
     * ICD §4.4 `exec` (stream).
     *
     * `yield*` inside a generator that already decoded the request: the parameter
     * decoding must happen *inside* the stream, because a Remote stream method
     * receives its arguments the same lossy way a unary one does.
     */
    exec(raw: unknown): AsyncGenerator<Frame, void, undefined>;
    /** ICD §4.4 `execWait` (unary). */
    execWait(raw: unknown): Promise<ExecResultWire>;
    /** ICD §4.4 `openShell` (stream). */
    openShell(raw: unknown): AsyncGenerator<Frame, void, undefined>;
    /** ICD §4.4 `shellWrite`. */
    shellWrite(raw: unknown): {
        written: number;
    };
    /** ICD §4.4 `shellResize`. */
    shellResize(raw: unknown): {
        resized: true;
    };
    /** ICD §4.4 `shellSignal`. */
    shellSignal(raw: unknown): {
        sent: true;
    };
    /** ICD §4.4 `shellClose`. */
    shellClose(raw: unknown): {
        closed: true;
    };
    /** ICD §4.4 `listStreams`. */
    listStreams(raw: unknown): {
        streams: unknown[];
    };
    /**
     * Start a channel and pump its frames, holding the session's operation slot for
     * the whole stream.
     *
     * The gate is acquired *around* the stream's lifetime rather than around the
     * start call: `SSH_LIMIT_QUEUE_FULL` must mean "this session is already running
     * the maximum number of operations", which is only true while those operations
     * are still producing output.
     */
    private runStream;
}
//# sourceMappingURL=exec-api.d.ts.map