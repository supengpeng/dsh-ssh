/**
 * Canonical `DirEntry` / `FileInfo` construction and octal mode formatting.
 *
 * The plugin describes files in two places with one wire shape: the remote pane
 * (this module's SFTP adapter) and the local pane (`sshPlugin/listLocalDir` /
 * `statLocal`, implemented in `src/api/**`). If the two sides built entries
 * differently the UI would show two dialects in the same column, so the
 * construction lives here and both sides call it.
 *
 * Everything is structural: an `ssh2` `Stats` object and a `node:fs` `Stats`
 * object (`Stats` from `node:fs/promises`) both satisfy `StatLike`, which lets
 * one function normalize both without a cast at either call site.
 *
 * `mode` is always the **four-octal-digit permission string** ('0644', '0755',
 * '1777'): file-type bits are dropped, because the type already has its own
 * field and the UI renders the string verbatim.
 */
import type { DirEntry, FileInfo, SftpEntryType } from './types.js';
/** The stat fields both `ssh2` and `node:fs` expose, plus their type predicates. */
export interface StatLike {
    mode?: number;
    size?: number;
    uid?: number;
    gid?: number;
    /** `ssh2` reports seconds; `node:fs` reports a `Date` (and `mtimeMs`). */
    mtime?: number | string | Date;
    mtimeMs?: number;
    atime?: number | string | Date;
    isDirectory?: () => boolean;
    isFile?: () => boolean;
    isSymbolicLink?: () => boolean;
    isBlockDevice?: () => boolean;
    isCharacterDevice?: () => boolean;
    isFIFO?: () => boolean;
    isSocket?: () => boolean;
}
/** `'0644'` — four octal digits, permission (and setuid/setgid/sticky) bits only. */
export declare function formatMode(mode: number | undefined | null): string;
/**
 * Parse an octal mode string.
 *
 * Accepts what the ICD wire format says (`'0755'`) plus the two spellings a
 * human or another SDK produces (`'755'`, `'0o755'`), and refuses anything else
 * with `SSH_CFG_INVALID` rather than silently chmod-ing to 0.
 */
export declare function parseMode(mode: string): number;
/** File-type discrimination: predicates first (they see a followed symlink's mode), then mode bits. */
export declare function typeOfStat(stat: StatLike | null | undefined): SftpEntryType;
/**
 * Epoch milliseconds, or `undefined` when unknown.
 *
 * `ssh2` SFTP stats carry **seconds** (`mtime: 1699999999`), `node:fs` carries a
 * `Date` and `mtimeMs`. A value below 1e12 is read as seconds: that threshold is
 * year 33658 in milliseconds and year 5138 in seconds, so the two ranges cannot
 * be confused by any real file.
 */
export declare function mtimeMsOf(stat: StatLike | null | undefined): number | undefined;
/** ISO-8601 mtime for the wire, or `''` when the source did not report one. */
export declare function normalizeMtime(stat: StatLike | null | undefined): string;
/** Policy deciding whether an entry is hidden. Callers may replace it. */
export type HiddenPolicy = (name: string) => boolean;
/** Default policy: a leading dot hides the entry (the POSIX convention). */
export declare const dotFileHidden: HiddenPolicy;
/**
 * Hidden test shared by the remote and the local pane.
 *
 * `.` and `..` are always hidden and are never part of a listing. The rest is
 * the caller's policy, defaulting to {@link dotFileHidden}: a Windows target
 * pane can pass its own predicate (hidden attribute, `desktop.ini`, …) without
 * changing the default here.
 */
export declare function isHiddenName(name: string, policy?: HiddenPolicy): boolean;
/**
 * Case-insensitive natural comparison (`file2` before `file10`).
 *
 * Digits compare numerically, everything else case-insensitively; a final
 * code-unit tie-break keeps the order total and deterministic (`'A'` before
 * `'a'`), because the two panes of the file manager sort independently and must
 * still agree.
 */
export declare function naturalCompare(a: string, b: string): number;
/**
 * Default listing order: directories first, then natural order by name.
 *
 * Both file-manager panes sort with this so they cannot disagree; a caller that
 * wants another order sorts its own copy.
 */
export declare function compareEntries(a: DirEntry, b: DirEntry): number;
export interface EntryInput {
    name: string;
    path: string;
    stat?: StatLike | null;
    type?: SftpEntryType;
    isSymlink?: boolean;
    /** Readlink target when the server reported one. */
    target?: string;
}
/** Build a `DirEntry` from a stat-like object; the single construction path. */
export declare function entryOf(input: EntryInput): DirEntry;
/** Build a `FileInfo` (`DirEntry` + `exists` + optional ownership). */
export declare function fileInfoOf(input: EntryInput & {
    exists?: boolean;
}): FileInfo;
/**
 * The `exists: false` projection of a path.
 *
 * `stat` deliberately answers for a missing path instead of throwing (ICD §4.5
 * gives `FileInfo` an `exists` field for exactly this), and the UI needs a name
 * and a path to render the row it just failed to stat.
 */
export declare function missingFileInfo(path: string, name?: string): FileInfo;
//# sourceMappingURL=format.d.ts.map