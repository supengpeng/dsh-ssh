/**
 * Model-facing file tools: `ssh_upload`, `ssh_download`, `ssh_list_dir`
 * (ICD §0 names, DESIGN §3 ownership `src/tools/files.ts`).
 *
 * Shape of a tool here, following the established `@local/dsh-python` pattern
 * (`src/tools/exec.ts`): a `ToolDefinition` literal with a raw JSON-Schema
 * `parameters`, a declared `output` contract, and an `execute` that returns a
 * canonical value. Two deliberate choices:
 *
 *  - **The tools do not stream.** Transfers are driven to completion by
 *    `TransferManager.run()`; the model gets the finished outcome. Progress is
 *    streamed to the *UI* by the §4.5 endpoints (`sshPlugin/upload`), not to the
 *    model, and the only thing a model could do with a progress callback is burn
 *    context on it. A long transfer is reported through `deps.log` at most every
 *    10 s instead.
 *  - **Failures are returned, not thrown.** `execute` answers `{ ok: false,
 *    code, … }` so the model reads a structured refusal (and can retry, resume,
 *    or fix the path) instead of seeing a crashed tool call. Only a bug in this
 *    file would throw.
 *
 * Every transfer is started with the caller's `exec.signal` forwarded plus a
 * cooperative deadline, because an aborted transfer ends as
 * `SSH_SFTP_TRANSFER_ABORTED` with a resumable offset: cancelling is never
 * destructive, which is exactly why it is safe to give the model this tool.
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { SessionInfo } from '../protocol.js';
import type { DirEntry, FileInfo, TransferEngineDefaults, TransferLogger, TransferOutcome, TransferProgress, TransferVerify } from '../sftp/index.js';
/** Tool names, in the order they are registered (ICD §0). */
export declare const FILES_TOOL_NAMES: readonly ["ssh_upload", "ssh_download", "ssh_list_dir"];
export type FilesToolName = (typeof FILES_TOOL_NAMES)[number];
export interface TransferToolRequest {
    sessionId: string;
    direction: 'upload' | 'download';
    localPath: string;
    remotePath: string;
    chunkBytes?: number;
    concurrency?: number;
    resume?: boolean;
    verify?: TransferVerify;
    overwrite?: boolean;
    signal?: AbortSignal;
    onProgress?: (progress: TransferProgress) => void;
}
/**
 * Everything the tools need, injected rather than imported.
 *
 * That keeps this file free of session/registry lookups (the Lead wires it in
 * `src/service.ts`) and makes the whole tool surface testable with hand-written
 * doubles — no SSH connection, no filesystem.
 */
export interface FilesToolDeps {
    /** Structured logger; progress lines land here. */
    log?: TransferLogger;
    /** `sftp.*` defaults, purely informational for the description text. */
    defaults?: TransferEngineDefaults;
    /** Session lookup, used to fail fast with `SSH_STATE_INVALID`. */
    getSession(sessionId: string): SessionInfo | undefined;
    /** Remote listing (`SftpClient.listDir`). */
    listDir(request: {
        sessionId: string;
        path: string;
        showHidden?: boolean;
        signal?: AbortSignal;
    }): Promise<{
        entries: DirEntry[];
        cwd: string;
    }>;
    /** Remote stat (`SftpClient.stat`); answers `exists: false` for a missing path. */
    stat(request: {
        sessionId: string;
        path: string;
        signal?: AbortSignal;
    }): Promise<FileInfo>;
    /** Run a transfer to completion (`TransferManager.run`). */
    transfer(request: TransferToolRequest): Promise<TransferOutcome>;
    /** Override the cooperative deadline for one tool call. */
    transferTimeoutMs?: number;
}
/** Factory map keyed by tool name, so the plugin can honour `config.tools`. */
export declare function filesToolFactories(deps: FilesToolDeps): Record<FilesToolName, () => ToolDefinition>;
/** All three tools, in registration order. */
export declare function fileTools(deps: FilesToolDeps): ToolDefinition[];
//# sourceMappingURL=files.d.ts.map