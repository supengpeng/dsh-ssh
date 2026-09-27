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
import { type ErrorInfo } from '../protocol.js';
import { type ExecLogger, type ExecRunResult, type StartedExec } from './exec.js';
import { type ShellRunResult, type StartedShell } from './shell.js';
import { StreamHub, type StreamSummary, type SubscribeOptions, type Subscription } from './streams.js';
import type { Frame } from '../protocol.js';
import type { Timers } from './timeout.js';
import { type ChunkEncoding, type SessionHandleLike, type SshSignal } from './types.js';
/** Session facts the agent tool may show the model. */
export interface ExecSessionSummary {
    id: string;
    label?: string;
    host?: string;
    user?: string;
    state?: string;
}
/** ICD §4.4 `exec` parameters. */
export interface ExecParams {
    sessionId: string;
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    /** 0 = no deadline; omitted = the configured `operationTimeoutMs`. */
    timeoutMs?: number;
    maxOutputBytes?: number;
    /** Resume point for the *subscription*, not for the command. */
    sinceSeq?: number;
}
/** ICD §4.4 `openShell` parameters. */
export interface ShellParams {
    sessionId: string;
    cols: number;
    rows: number;
    term?: string;
    cwd?: string;
    env?: Record<string, string>;
}
export interface ExecServiceOptions {
    /** Live session lookup; `undefined` = unknown or already closed session. */
    resolveSession(sessionId: string): SessionHandleLike | undefined;
    /** Sessions visible to the agent tool and to `listStreams` diagnostics. */
    listSessions?(): ExecSessionSummary[];
    /** Session a tool call targets when the model omits `sessionId`. */
    defaultSessionId?(): string | undefined;
    limits: {
        maxOutputBytes: number;
        operationTimeoutMs: number;
        graceKillMs: number;
    };
    logger?: ExecLogger;
    now?: () => number;
    timers?: Timers;
    /** Wait after SIGKILL for the peer's exit event; defaults to 1000 ms. */
    settleMs?: number;
    /** Replay window kept per stream for `sinceSeq` resubscription. */
    replayLimitBytes?: number;
    /** How many finished streams stay addressable for late subscribers. */
    maxFinishedStreams?: number;
}
/** Extra input a caller may supply for a one-shot command (`execWait`, the tool). */
export interface ExecWaitOptions {
    /** Written to the channel's stdin once it is open. */
    stdin?: string | Buffer;
    signal?: AbortSignal;
    /**
     * Run on a PTY. Not part of the wire's `exec` parameters (ICD §4.4 chooses the
     * PTY channel through `openShell`); the agent tool exposes it for commands that
     * behave differently on a terminal.
     */
    pty?: boolean;
    cols?: number;
    rows?: number;
    term?: string;
}
export declare class ExecService {
    readonly hub: StreamHub;
    private readonly options;
    private readonly now;
    private readonly log;
    private disposed;
    constructor(options: ExecServiceOptions);
    /** Effective limits, so the wire layer and the tool advertise the same numbers. */
    get limits(): ExecServiceOptions['limits'];
    get activeStreams(): number;
    /**
     * ICD §4.4 `exec`: start a streaming command.
     *
     * `options.signal` is the wire layer's `opts.signal`: aborting it cancels the
     * command. The wire layer needs only `streamId`; `done` is returned for
     * embedders and tests, and never rejects (failures arrive as frames and in the
     * result).
     */
    exec(params: ExecParams, options?: ExecWaitOptions): StartedExec;
    /** ICD §4.4 `execWait`: run a command and return its complete result. */
    execWait(params: ExecParams, options?: ExecWaitOptions): Promise<ExecRunResult>;
    /** ICD §4.4 `openShell`: start an interactive PTY (`done` as for {@link exec}). */
    openShell(params: ShellParams): StartedShell;
    /** ICD §4.4 `shellWrite`. */
    shellWrite(params: {
        streamId: string;
        data: string;
        encoding?: ChunkEncoding;
    }): {
        written: number;
    };
    /** ICD §4.4 `shellResize`. */
    shellResize(params: {
        streamId: string;
        cols: number;
        rows: number;
    }): {
        resized: true;
    };
    /** ICD §4.4 `shellSignal`. */
    shellSignal(params: {
        streamId: string;
        signal: SshSignal;
    }): {
        sent: true;
    };
    /** ICD §4.4 `shellClose`. */
    shellClose(params: {
        streamId: string;
    }): {
        closed: true;
    };
    /** ICD §4.4 `listStreams`. */
    listStreams(params: {
        sessionId?: string;
    }): {
        streams: StreamSummary[];
    };
    /** Client-side abort of one stream (`opts.signal` → `cancel()`). */
    cancel(streamId: string): boolean;
    /**
     * Deliver frames for one stream, resuming after `sinceSeq` when given.
     *
     * `gap:true` means the request reaches before the retained window: the caller
     * MUST surface that as `SSH_LIMIT_OUTPUT_TRUNCATED` rather than silently
     * dropping the difference (ICD §3).
     */
    subscribe(streamId: string, onFrame: (frame: Frame) => void, options?: SubscribeOptions): Subscription;
    /** Session summaries, for the tool's "which session?" hint. */
    sessions(): ExecSessionSummary[];
    /** Terminate every stream (plugin unload). Frames an `end` for each. */
    dispose(reason?: 'peer-closed' | 'cancelled'): void;
    private startCommand;
    /**
     * Which session a call actually targets.
     *
     * The wire always names one; the agent tool may omit it and fall back to the
     * deployment's active session. A call that cannot be resolved fails with the
     * list of available sessions in `details`, because "unknown session" with no
     * alternative is the least actionable error a tool can return.
     */
    resolveTargetSession(requested?: string): string;
    private sessionOf;
}
/**
 * Outcomes a caller must see as data rather than as a thrown error.
 *
 * `SSH_LIMIT_OUTPUT_TRUNCATED` is explicitly "reported, not a failure" (ICD
 * §4.4), and `SSH_TIMEOUT_OPERATION` accompanies a result that still carries the
 * output the user asked for (`timedOut:true`, DESIGN §4 `ExecResult`).
 */
export declare function isReportedOutcome(code: string): boolean;
/** Re-exported so the wire layer can build `details` without importing exec.ts. */
export type { ExecRunResult, ShellRunResult, StartedExec, StartedShell, ErrorInfo };
//# sourceMappingURL=service.d.ts.map