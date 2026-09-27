/**
 * `SftpClient` — a thin, validating facade over one frozen `SftpHandle`.
 *
 * Three jobs, and nothing else:
 *
 *  1. **Normalize what the handle may return.** A handle built elsewhere (a test
 *     double, or a future implementation) can throw for a missing path where the
 *     ICD says `stat` answers `{ exists: false }`; a listing can arrive
 *     unsorted. Both are corrected here, once, so the transfer engine and the
 *     wire layer only ever see ICD-shaped values.
 *  2. **Provide the operations the engine needs but the wire does not** — above
 *     all `walk()`, the recursive listing that makes directory transfer preserve
 *     the tree's shape. Symlinks are *not* followed by default
 *     (`sftp.followSymlinks`), and recursion is depth-guarded so a link loop in
 *     an adversarial tree cannot hang the process.
 *  3. **Own the remote-path vocabulary** (always POSIX, always normalized) so no
 *     other module joins remote paths by hand.
 *
 * Everything is `await`-ed and abort-aware: a walk checks the signal per entry,
 * which is what lets a directory transfer stop mid-scan.
 */
import type { DirEntry, FileInfo, SftpHandle, TransferLogger } from './types.js';
/** One node of a walked tree, with the relative path that mirrors its structure. */
export interface WalkEntry {
    /** Remote path as reached from the walk root. */
    path: string;
    /** Path relative to the walk root; `''` for the root itself. */
    relPath: string;
    name: string;
    type: DirEntry['type'];
    size: number;
    mode: string;
    mtime: string;
    depth: number;
    isSymlink: boolean;
    target?: string;
}
export interface WalkOptions {
    /** Follow symlinked directories. Defaults to the client's policy (false). */
    followSymlinks?: boolean;
    /** Recursion guard, in levels. Defaults to the client's policy (64). */
    maxDepth?: number;
    signal?: AbortSignal;
    /** Called for every entry *as it is discovered* (scan-phase progress). */
    onEntry?: (entry: WalkEntry) => void;
}
export interface SftpClientOptions {
    followSymlinks?: boolean;
    maxDepth?: number;
    logger?: TransferLogger;
}
export declare class SftpClient {
    #private;
    readonly handle: SftpHandle;
    private readonly followSymlinks;
    private readonly maxDepth;
    constructor(handle: SftpHandle, options?: SftpClientOptions);
    /** `{ entries, cwd }`, the exact result shape of `sshPlugin/listDir`. */
    listDir(path: string, opts?: {
        showHidden?: boolean;
        signal?: AbortSignal;
    }): Promise<{
        entries: DirEntry[];
        cwd: string;
    }>;
    /** Entries only, for internal callers that do not need `cwd`. */
    list(path: string, opts?: {
        showHidden?: boolean;
        signal?: AbortSignal;
    }): Promise<DirEntry[]>;
    /**
     * `stat` that never throws for a missing path (ICD §4.5).
     *
     * Symlinks are reported as symlinks: the file manager must show the link, not
     * its target, or "do not follow symlinks" would be unenforceable in the UI.
     */
    stat(path: string, signal?: AbortSignal): Promise<FileInfo>;
    exists(path: string, signal?: AbortSignal): Promise<boolean>;
    /** `mkdir -p` (the ICD default): an existing directory is not an error. */
    mkdir(path: string, opts?: {
        recursive?: boolean;
    }): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    /** Remove one path; returns how many entries disappeared (the tree, counted). */
    remove(path: string, opts?: {
        recursive?: boolean;
        signal?: AbortSignal;
    }): Promise<number>;
    chmod(path: string, mode: string): Promise<void>;
    /**
     * Depth-first listing of a tree, parents before children.
     *
     * `relPath` is what makes a recursive transfer preserve structure: the caller
     * maps it onto the destination root. The root itself is included with
     * `relPath: ''` so the caller can create the destination directory even when
     * the source is empty.
     *
     * A symlinked directory is emitted as `symlink` (not `dir`) when symlinks are
     * not followed, so nothing below it is ever listed.
     */
    walk(root: string, options?: WalkOptions): Promise<WalkEntry[]>;
}
//# sourceMappingURL=client.d.ts.map