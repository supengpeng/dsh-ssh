/**
 * Remote (POSIX) and local (platform) path helpers.
 *
 * A remote path is always `/`-separated regardless of the host we run on: SFTP
 * servers are overwhelmingly POSIX, and the one thing a transfer engine must
 * never do is hand a Windows backslash to a remote `stat`. Local paths keep the
 * platform's own rules, so both live here side by side and no call site has to
 * remember which is which.
 */
import { posix, win32, resolve as resolvePath } from 'node:path';
import { realpathSync } from 'node:fs';
/** Separator the local filesystem uses in error messages and joins. */
export const LOCAL_SEP = process.platform === 'win32' ? '\\' : '/';
/** Join remote path components with `/`, keeping an absolute result absolute. */
export function remoteJoin(...parts) {
    const usable = parts.filter((part) => typeof part === 'string' && part.length > 0);
    if (usable.length === 0)
        return '';
    return posix.join(...usable);
}
/** Parent of a remote path; `'/'` is its own parent. */
export function remoteDirname(path) {
    const normalized = remoteNormalize(path);
    if (normalized === '/' || normalized === '')
        return '/';
    return posix.dirname(normalized) || '/';
}
/** Final component of a remote path. */
export function remoteBasename(path) {
    return posix.basename(remoteNormalize(path));
}
/**
 * Collapse `.`/`..` and duplicate separators.
 *
 * Kept separate from `posix.normalize` only to give an empty input a defined
 * answer (`''`) and to never emit a trailing slash: every consumer compares
 * paths as strings. `'.'` is preserved rather than folded into `''`, so a caller
 * that listed `'.'` gets its own input back as `cwd`.
 */
export function remoteNormalize(path) {
    const raw = String(path ?? '').trim();
    if (raw === '')
        return '';
    const normalized = posix.normalize(raw);
    if (normalized === '')
        return '';
    if (normalized === '/')
        return '/';
    return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}
/** A remote path is absolute when it starts with `/`. */
export function isRemoteAbsolute(path) {
    return path.startsWith('/');
}
/**
 * Path of `full` relative to the directory `root`, or `null` when `full` is not
 * under `root`.
 *
 * Used by the recursive walk to build the destination path of each entry while
 * preserving the tree's shape.
 */
export function remoteRelativeUnder(root, full) {
    const base = remoteNormalize(root);
    const target = remoteNormalize(full);
    if (base === '')
        return target;
    if (base === '/')
        return target.replace(/^\/+/, '');
    if (target === base)
        return '';
    if (!target.startsWith(`${base}/`))
        return null;
    return target.slice(base.length + 1);
}
/** Join local path components with the platform separator. */
export function localJoin(...parts) {
    const usable = parts.filter((part) => typeof part === 'string' && part.length > 0);
    if (usable.length === 0)
        return '';
    return process.platform === 'win32' ? win32.join(...usable) : posix.join(...usable);
}
/** Parent directory of a local path. */
export function localDirname(path) {
    return process.platform === 'win32' ? win32.dirname(path) : posix.dirname(path);
}
/** Final component of a local path. */
export function localBasename(path) {
    return process.platform === 'win32' ? win32.basename(path) : posix.basename(path);
}
/** Absolute path with symlinks/junctions resolved when the target exists. */
export function canonicalLocalPath(path) {
    const absolute = resolvePath(path);
    try {
        // `native` also normalises the 8.3 short form on Windows, so `PROGRA~1` and
        // `Program Files` compare equal. A missing target throws and we fall back to
        // the unresolved absolute path — both sides fall back the same way, so the
        // comparison stays meaningful for a file that does not exist yet.
        return realpathSync.native(absolute);
    }
    catch {
        return absolute;
    }
}
/**
 * Whether `candidate` names one of `protectedPaths`.
 *
 * Used to keep the plugin's own trust anchors and state out of the transfer
 * engine's reach: a request that can rewrite `known_hosts` or the audit log has
 * taken over the very files that make verification and accountability mean
 * anything. Comparison is case-insensitive on Windows (its filesystem is) and
 * exact elsewhere.
 *
 * Residual, deliberately documented: a symlink or junction pointing at a
 * protected file that does **not** exist yet cannot be resolved, so the
 * comparison sees two different absolute paths. Creating such a link already
 * requires the privileges that make this moot on Windows, and the window only
 * exists until the anchor file is first written.
 */
export function isProtectedLocalPath(candidate, protectedPaths) {
    if (protectedPaths.length === 0)
        return false;
    const fold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
    const target = fold(canonicalLocalPath(candidate));
    return protectedPaths.some((entry) => entry !== '' && fold(canonicalLocalPath(entry)) === target);
}
//# sourceMappingURL=paths.js.map