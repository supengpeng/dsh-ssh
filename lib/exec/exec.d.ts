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
import { type EndReason, type ErrorInfo } from '../protocol.js';
import { type Timers } from './timeout.js';
import type { StreamHub } from './streams.js';
import { type SessionHandleLike } from './types.js';
/** Minimal logging surface; a logger must never be able to break a command. */
export interface ExecLogger {
    debug?(message: string): void;
    info?(message: string): void;
    warn?(message: string): void;
    error?(message: string): void;
}
export interface ExecRunOptions {
    session: SessionHandleLike;
    hub: StreamHub;
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    /** Deadline before SIGTERM; 0/undefined disables the deadline. */
    timeoutMs?: number;
    maxOutputBytes: number;
    /** Run the command on a PTY (the `exec` endpoint's `pty` option). */
    pty?: boolean;
    cols?: number;
    rows?: number;
    term?: string;
    signal?: AbortSignal;
    /**
     * Written to the channel's stdin as soon as it opens. End-of-input is
     * requested when the handle offers it; ICD §7.1 `ExecHandle` has no explicit
     * EOF method today, so a command that reads stdin until EOF may only finish
     * when its deadline fires (documented in this folder's README).
     */
    stdin?: string | Buffer;
    graceKillMs: number;
    /** Wait after SIGKILL for the peer's exit event before forcing the stream closed. */
    settleMs?: number;
    timers?: Timers;
    now?: () => number;
    logger?: ExecLogger;
    /** Caller-supplied stream id (tests, reconnect). */
    streamId?: string;
    replayLimitBytes?: number;
}
/** The outcome of one command, whether it ended on its own or was killed. */
export interface ExecRunResult {
    streamId: string;
    exitCode: number | null;
    signal?: string;
    durationMs: number;
    timedOut: boolean;
    endReason: EndReason;
    /** A channel's bytes were dropped by `maxOutputBytes` (reported, never silent). */
    truncated: {
        stdout: boolean;
        stderr: boolean;
    };
    /** Head+tail capture. Invalid UTF-8 decodes to U+FFFD here; `binary` says so. */
    stdout: string;
    stderr: string;
    /** True when a channel's capture contains bytes that are not valid UTF-8. */
    binary: {
        stdout: boolean;
        stderr: boolean;
    };
    /** Total bytes the command produced, before truncation. */
    bytes: {
        stdout: number;
        stderr: number;
    };
    /** Present when the stream ended with an error (including truncation). */
    error?: ErrorInfo;
}
export interface StartedExec {
    streamId: string;
    /** Resolves when the stream has ended. Never rejects. */
    done: Promise<ExecRunResult>;
}
/** Start a command and return its stream id plus the settlement promise. */
export declare function startExec(options: ExecRunOptions): StartedExec;
/** The structured report a truncating stream ends with (ICD §4.4). */
export declare function truncationError(maxOutputBytes: number, totalBytes: number): ErrorInfo;
/** The structured report a timed-out command carries (ICD §5 `SSH_TIMEOUT_OPERATION`). */
export declare function timeoutError(timeoutMs: number): ErrorInfo;
//# sourceMappingURL=exec.d.ts.map