/**
 * §4.5 SFTP: single-path operations, the dual-pane local half, and transfers.
 *
 * Two wire details are decided here and documented in `src/api/README.md`:
 *
 *   - **A transfer stream carries its handshake in the `open` frame's `meta`.**
 *     §4.5's return value `{ streamId, opId, resumedFrom }` describes a *stream*,
 *     and a Remote stream method's return value is the frame sequence itself, so
 *     `open.meta = { opId, resumedFrom, totalBytes? }`. The UI can label the row
 *     "resuming at 34%" from the very first frame (`resumedFrom` is answered before
 *     the transfer starts — that is the manager's whole reason for two `stat`
 *     calls on a single file).
 *   - **Cancellation answers `{ cancelled: false }` for an unknown or finished op**
 *     rather than throwing. "Nothing to cancel" is a true answer to "cancel this",
 *     and the UI has usually just settled the row itself; turning it into an error
 *     produces a spurious toast.
 */
import { type ErrorInfo, type Frame, type TransferPhase } from '../protocol.js';
import { type Params } from './params.js';
import { ApiGroup } from './deps.js';
/**
 * ICD §4.5 / DESIGN §4 `TransferTask` — the live row behind `listTransfers`.
 *
 * Declared here rather than in `src/protocol.ts` because that file does not carry
 * it yet and this module is its only producer; reported to the Lead so it can be
 * promoted to the frozen wire module (where the client half would then import it).
 */
export interface TransferTaskView {
    opId: string;
    direction: 'upload' | 'download';
    localPath: string;
    remotePath: string;
    totalBytes?: number;
    transferred: number;
    phase: TransferPhase | 'done' | 'cancelled' | 'error';
    bytesPerSec: number;
    etaMs?: number;
    resumeFrom?: number;
    error?: ErrorInfo;
}
export declare class FilesApi extends ApiGroup {
    /** ICD §4.5 `listDir`. */
    listDir(raw: unknown): Promise<{
        entries: unknown[];
        cwd: string;
    }>;
    /** ICD §4.5 `stat`. */
    stat(raw: unknown): Promise<{
        info: unknown;
    }>;
    /** ICD §4.5 `mkdir` (recursive by default, ICD §4.5). */
    mkdir(raw: unknown): Promise<{
        created: true;
    }>;
    /** ICD §4.5 `rename`. */
    rename(raw: unknown): Promise<{
        renamed: true;
    }>;
    /**
     * ICD §4.5 `removePath`; answers how many entries disappeared.
     *
     * The wire method is `removePath` because a Remote method named `remove` collides with
     * the Gateway's own `RemoteNamespaceService.remove` (see `src/service.ts`). This
     * in-process name stays `remove`, mirroring `SftpHandle.remove` from ICD §7.
     */
    remove(raw: unknown): Promise<{
        removed: number;
    }>;
    /** ICD §4.5 `chmod` (octal string, e.g. `"0755"`). */
    chmod(raw: unknown): Promise<{
        mode: string;
    }>;
    /** ICD §4.5 `upload` (stream). */
    upload(raw: unknown): AsyncGenerator<Frame, void, undefined>;
    /** ICD §4.5 `download` (stream). */
    download(raw: unknown): AsyncGenerator<Frame, void, undefined>;
    /** ICD §4.5 `cancelTransfer`. */
    cancelTransfer(raw: unknown): {
        cancelled: boolean;
    };
    /** ICD §4.5 `listTransfers`. */
    listTransfers(): {
        tasks: TransferTaskView[];
    };
    /** The local half of the dual pane (`sshPlugin/listLocalDir`). */
    listLocalDir(raw: unknown): Promise<{
        entries: unknown[];
        cwd: string;
    }>;
    /** The local half of the dual pane (`sshPlugin/statLocal`). */
    statLocal(raw: unknown): Promise<{
        info: unknown;
    }>;
    /**
     * One transfer, as a frame stream.
     *
     * `start()` returns as soon as the transfer is under way, so the generator can
     * emit `open` (with the handshake in `meta`) and then relay the manager's
     * progress frames until its `onEnd` fires. The manager owns every terminal
     * outcome — including cancellation and verification mismatch — so the wire layer
     * never has to classify a failure itself.
     */
    private transferStream;
    /** The local filesystem logger face the dual pane expects. */
    private localLogger;
}
export type { Params };
//# sourceMappingURL=files-api.d.ts.map