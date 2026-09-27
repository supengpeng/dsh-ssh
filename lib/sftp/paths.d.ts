/**
 * Remote (POSIX) and local (platform) path helpers.
 *
 * A remote path is always `/`-separated regardless of the host we run on: SFTP
 * servers are overwhelmingly POSIX, and the one thing a transfer engine must
 * never do is hand a Windows backslash to a remote `stat`. Local paths keep the
 * platform's own rules, so both live here side by side and no call site has to
 * remember which is which.
 */
/** Separator the local filesystem uses in error messages and joins. */
export declare const LOCAL_SEP: string;
/** Join remote path components with `/`, keeping an absolute result absolute. */
export declare function remoteJoin(...parts: Array<string | undefined>): string;
/** Parent of a remote path; `'/'` is its own parent. */
export declare function remoteDirname(path: string): string;
/** Final component of a remote path. */
export declare function remoteBasename(path: string): string;
/**
 * Collapse `.`/`..` and duplicate separators.
 *
 * Kept separate from `posix.normalize` only to give an empty input a defined
 * answer (`''`) and to never emit a trailing slash: every consumer compares
 * paths as strings. `'.'` is preserved rather than folded into `''`, so a caller
 * that listed `'.'` gets its own input back as `cwd`.
 */
export declare function remoteNormalize(path: string): string;
/** A remote path is absolute when it starts with `/`. */
export declare function isRemoteAbsolute(path: string): boolean;
/**
 * Path of `full` relative to the directory `root`, or `null` when `full` is not
 * under `root`.
 *
 * Used by the recursive walk to build the destination path of each entry while
 * preserving the tree's shape.
 */
export declare function remoteRelativeUnder(root: string, full: string): string | null;
/** Join local path components with the platform separator. */
export declare function localJoin(...parts: Array<string | undefined>): string;
/** Parent directory of a local path. */
export declare function localDirname(path: string): string;
/** Final component of a local path. */
export declare function localBasename(path: string): string;
//# sourceMappingURL=paths.d.ts.map