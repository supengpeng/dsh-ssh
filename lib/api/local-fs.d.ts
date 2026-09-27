/**
 * Local-side filesystem access for the dual-pane file manager.
 *
 * The browser cannot read local directories, so the dual pane needs the host:
 * these two operations are the local half of `sshPlugin/listDir` /
 * `sshPlugin/stat`. They deliberately reuse `src/sftp/format.ts` so a local row
 * and a remote row are built by the same code - two panes that format sizes,
 * modes or timestamps differently is a bug the user sees immediately.
 *
 * Scope note: this reads whatever the operator's account can read. That is
 * inherent to a file manager (the shipped local file browser has the same
 * reach), and the UI only ever issues paths the operator typed or navigated to.
 * Every call is audited by the caller, not here.
 */
import type { DirEntry, FileInfo } from '../connection/types.js';
import { type StatLike } from '../sftp/format.js';
/** Minimal logger so this module stays usable outside a Cordis tree. */
export interface LocalFsLogger {
    warn(message: string): void;
}
export interface LocalFsDeps {
    /** Directory used when a request carries no path; defaults to the process cwd. */
    root?: string;
    /** Include dot-entries by default (a request can still override it). */
    showHidden?: boolean;
    logger?: LocalFsLogger;
    /**
     * Per-entry stat, injectable so the "one unreadable entry" path is testable
     * without depending on filesystem permissions (which are not portable).
     * Defaults to `lstat`, which keeps a symlink a symlink.
     */
    statEntry?: (path: string) => Promise<StatLike>;
}
/** Resolve a request path to an absolute one, honouring the configured root. */
export declare function resolveLocalPath(requestPath: string | undefined, deps?: LocalFsDeps): string;
/**
 * List one local directory.
 *
 * Returns an absolute `cwd` so the pane can show where it actually landed
 * (relative requests and `..` both make the resolved directory worth reporting).
 */
export declare function listLocalDir(request?: {
    path?: string;
    showHidden?: boolean;
}, deps?: LocalFsDeps): Promise<{
    entries: DirEntry[];
    cwd: string;
}>;
/** Stat one local path, reporting absence as `exists:false` rather than throwing. */
export declare function statLocal(request: {
    path: string;
}, deps?: LocalFsDeps): Promise<{
    info: FileInfo;
}>;
//# sourceMappingURL=local-fs.d.ts.map