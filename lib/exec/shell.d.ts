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
import { type EndReason, type ErrorInfo } from '../protocol.js';
import { type Timers } from './timeout.js';
import type { StreamHub } from './streams.js';
import { type SessionHandleLike } from './types.js';
import type { ExecLogger } from './exec.js';
export declare const DEFAULT_TERM = "xterm-256color";
export declare const DEFAULT_COLS = 80;
export declare const DEFAULT_ROWS = 24;
/** Keystrokes held while a PTY is still opening before input is refused. */
export declare const MAX_PENDING_INPUT = 65536;
export interface ShellRunOptions {
    session: SessionHandleLike;
    hub: StreamHub;
    cols?: number;
    rows?: number;
    term?: string;
    cwd?: string;
    env?: Record<string, string>;
    /** Only pass a deadline for a non-interactive, scripted shell. */
    timeoutMs?: number;
    maxOutputBytes?: number;
    graceKillMs: number;
    settleMs?: number;
    timers?: Timers;
    now?: () => number;
    logger?: ExecLogger;
    streamId?: string;
    replayLimitBytes?: number;
}
/** The outcome of one interactive shell. */
export interface ShellRunResult {
    streamId: string;
    exitCode: number | null;
    signal?: string;
    durationMs: number;
    timedOut: boolean;
    endReason: EndReason;
    /** Terminal bytes the shell produced (unbounded; see the module note). */
    bytes: number;
    /** True when the terminal produced bytes that are not valid UTF-8. */
    binary: boolean;
    error?: ErrorInfo;
}
export interface StartedShell {
    streamId: string;
    /** Resolves when the shell has ended. Never rejects. */
    done: Promise<ShellRunResult>;
}
/** Start an interactive shell and return its stream id plus the settlement promise. */
export declare function startShell(options: ShellRunOptions): StartedShell;
/** Terminal geometry must stay positive and sane; a 0-column PTY breaks curses apps. */
export declare function clampDimension(value: number | undefined, fallback: number): number;
//# sourceMappingURL=shell.d.ts.map