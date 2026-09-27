/**
 * `ssh_exec` — run one command on a connected remote host.
 *
 * Follows the pattern established by `@local/dsh-python`'s `python_exec`: one
 * canonical result envelope for every outcome (including refusals), an
 * `output.schema` the Host validates the value against, a `render` that puts
 * "did it work / what did it print / what went wrong" on the first lines, and a
 * terminal card for the Web UI.
 *
 * Differences that follow from running on a remote host:
 *
 *   - the call names a `sessionId` (or uses the active session), so the model can
 *     keep several hosts apart;
 *   - a non-zero exit code is a **result**, not a tool error: the model asked to
 *     run a command and the command ran. `ok` reports whether the channel worked;
 *   - a timeout or an output truncation is reported in the envelope (and in the
 *     `truncated` flags) instead of being thrown, because the caller still needs
 *     the captured output.
 */
import type { JsonSchemaNode, ToolDefinition } from '@deepseek-ai/dsh-tools';
import { type JsonValue, type TextBlock } from '../exec/schema.js';
import type { ExecService } from '../exec/service.js';
export declare const SSH_EXEC_TOOL_NAME = "ssh_exec";
/** The only surface the tool needs from the plugin. */
export interface SshExecToolDeps {
    exec: ExecService;
    /** Called once per finished call, for the audit log (SP4 owns the auditor). */
    onResult?: (event: {
        sessionId: string | null;
        command: string;
        outcome: string;
        exitCode: number | null;
        durationMs: number;
        streamId: string | null;
        truncated: boolean;
    }) => void;
    /** Extra milliseconds the cooperative tool budget allows beyond the command deadline. */
    budgetSlackMs?: number;
}
/** Terminal classification of one call. */
export type ExecOutcome = 'success' | 'timeout' | 'cancelled' | 'output-limit' | 'error' | 'refused';
/** The canonical value every `ssh_exec` call returns. */
export interface SshExecEnvelope {
    ok: boolean;
    outcome: ExecOutcome;
    /** Stable machine-readable code when `ok` is false. */
    code: string | null;
    message: string | null;
    sessionId: string | null;
    streamId: string | null;
    command: string;
    cwd: string | null;
    exitCode: number | null;
    signal: string | null;
    durationMs: number;
    timedOut: boolean;
    stdout: string;
    stderr: string;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
    bytes: {
        stdout: number;
        stderr: number;
    };
    /** True when the captured output contained bytes that are not valid UTF-8. */
    binary: {
        stdout: boolean;
        stderr: boolean;
    };
    notes: string[];
    [extra: string]: unknown;
}
export declare function sshExecTool(deps: SshExecToolDeps): ToolDefinition;
/** The canonical value shape, declared for the Host's own validation. */
export declare function envelopeSchema(): JsonSchemaNode;
/**
 * The model-facing rendering: the answer to "did it work, what did it print,
 * what went wrong" is on the first lines, not at the end of a wall of output.
 */
export declare function renderEnvelope(args: unknown, value: unknown): TextBlock[];
/** Compact view model for the Web UI terminal card, carried in `meta`. */
export declare function envelopePresentation(args: unknown, value: unknown): Record<string, JsonValue>;
//# sourceMappingURL=exec.d.ts.map