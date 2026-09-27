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

import { SshError } from '../protocol.js'

import type { DirEntry, FileInfo, SftpEntryType } from './types.js'

const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000
const S_IFREG = 0o100000

/** The stat fields both `ssh2` and `node:fs` expose, plus their type predicates. */
export interface StatLike {
  mode?: number
  size?: number
  uid?: number
  gid?: number
  /** `ssh2` reports seconds; `node:fs` reports a `Date` (and `mtimeMs`). */
  mtime?: number | string | Date
  mtimeMs?: number
  atime?: number | string | Date
  isDirectory?: () => boolean
  isFile?: () => boolean
  isSymbolicLink?: () => boolean
  isBlockDevice?: () => boolean
  isCharacterDevice?: () => boolean
  isFIFO?: () => boolean
  isSocket?: () => boolean
}

/** `'0644'` — four octal digits, permission (and setuid/setgid/sticky) bits only. */
export function formatMode(mode: number | undefined | null): string {
  const value = typeof mode === 'number' && Number.isFinite(mode) ? Math.trunc(mode) & 0o7777 : 0
  return value.toString(8).padStart(4, '0')
}

/**
 * Parse an octal mode string.
 *
 * Accepts what the ICD wire format says (`'0755'`) plus the two spellings a
 * human or another SDK produces (`'755'`, `'0o755'`), and refuses anything else
 * with `SSH_CFG_INVALID` rather than silently chmod-ing to 0.
 */
export function parseMode(mode: string): number {
  const raw = String(mode).trim()
  const body = raw.startsWith('0o') || raw.startsWith('0O') ? raw.slice(2) : raw
  if (!/^[0-7]{1,4}$/.test(body)) {
    throw new SshError('SSH_CFG_INVALID', `invalid octal file mode "${mode}"`, {
      details: { mode, expected: 'octal string such as "0755"' },
    })
  }
  return Number.parseInt(body, 8)
}

/** File-type discrimination: predicates first (they see a followed symlink's mode), then mode bits. */
export function typeOfStat(stat: StatLike | null | undefined): SftpEntryType {
  if (stat === null || stat === undefined) return 'other'
  if (typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink()) return 'symlink'
  if (typeof stat.isDirectory === 'function' && stat.isDirectory()) return 'dir'
  if (typeof stat.isFile === 'function' && stat.isFile()) return 'file'
  const kind = (typeof stat.mode === 'number' ? stat.mode : 0) & S_IFMT
  if (kind === S_IFDIR) return 'dir'
  if (kind === S_IFLNK) return 'symlink'
  if (kind === S_IFREG) return 'file'
  return 'other'
}

/**
 * Epoch milliseconds, or `undefined` when unknown.
 *
 * `ssh2` SFTP stats carry **seconds** (`mtime: 1699999999`), `node:fs` carries a
 * `Date` and `mtimeMs`. A value below 1e12 is read as seconds: that threshold is
 * year 33658 in milliseconds and year 5138 in seconds, so the two ranges cannot
 * be confused by any real file.
 */
export function mtimeMsOf(stat: StatLike | null | undefined): number | undefined {
  if (stat === null || stat === undefined) return undefined
  if (typeof stat.mtimeMs === 'number' && Number.isFinite(stat.mtimeMs)) return Math.round(stat.mtimeMs)
  const value = stat.mtime
  if (value === undefined || value === null) return undefined
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : undefined
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

/** ISO-8601 mtime for the wire, or `''` when the source did not report one. */
export function normalizeMtime(stat: StatLike | null | undefined): string {
  const ms = mtimeMsOf(stat)
  return ms === undefined ? '' : new Date(ms).toISOString()
}

/** Policy deciding whether an entry is hidden. Callers may replace it. */
export type HiddenPolicy = (name: string) => boolean

/** Default policy: a leading dot hides the entry (the POSIX convention). */
export const dotFileHidden: HiddenPolicy = (name) => name.startsWith('.') && name !== '.' && name !== '..'

/**
 * Hidden test shared by the remote and the local pane.
 *
 * `.` and `..` are always hidden and are never part of a listing. The rest is
 * the caller's policy, defaulting to {@link dotFileHidden}: a Windows target
 * pane can pass its own predicate (hidden attribute, `desktop.ini`, …) without
 * changing the default here.
 */
export function isHiddenName(name: string, policy: HiddenPolicy = dotFileHidden): boolean {
  if (name === '.' || name === '..') return true
  return policy(name)
}

/**
 * Case-insensitive natural comparison (`file2` before `file10`).
 *
 * Digits compare numerically, everything else case-insensitively; a final
 * code-unit tie-break keeps the order total and deterministic (`'A'` before
 * `'a'`), because the two panes of the file manager sort independently and must
 * still agree.
 */
export function naturalCompare(a: string, b: string): number {
  const left = a.toLowerCase()
  const right = b.toLowerCase()
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    const ca = left.charAt(i)
    const cb = right.charAt(j)
    const digitA = ca >= '0' && ca <= '9'
    const digitB = cb >= '0' && cb <= '9'
    if (digitA && digitB) {
      let na = ''
      let nb = ''
      while (i < left.length && left.charAt(i) >= '0' && left.charAt(i) <= '9') na += left.charAt(i++)
      while (j < right.length && right.charAt(j) >= '0' && right.charAt(j) <= '9') nb += right.charAt(j++)
      const va = Number.parseInt(na, 10)
      const vb = Number.parseInt(nb, 10)
      if (va !== vb) return va < vb ? -1 : 1
      continue
    }
    if (ca !== cb) return ca < cb ? -1 : 1
    i++
    j++
  }
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
 * Default listing order: directories first, then natural order by name.
 *
 * Both file-manager panes sort with this so they cannot disagree; a caller that
 * wants another order sorts its own copy.
 */
export function compareEntries(a: DirEntry, b: DirEntry): number {
  const rankA = a.type === 'dir' ? 0 : 1
  const rankB = b.type === 'dir' ? 0 : 1
  if (rankA !== rankB) return rankA - rankB
  return naturalCompare(a.name, b.name)
}

export interface EntryInput {
  name: string
  path: string
  stat?: StatLike | null
  type?: SftpEntryType
  isSymlink?: boolean
  /** Readlink target when the server reported one. */
  target?: string
}

function sizeOf(stat: StatLike | null | undefined): number {
  const size = stat?.size
  return typeof size === 'number' && Number.isFinite(size) && size >= 0 ? Math.trunc(size) : 0
}

/** Build a `DirEntry` from a stat-like object; the single construction path. */
export function entryOf(input: EntryInput): DirEntry {
  const type = input.type ?? typeOfStat(input.stat)
  const entry: DirEntry = {
    name: input.name,
    path: input.path,
    type,
    size: sizeOf(input.stat),
    mode: formatMode(input.stat?.mode),
    mtime: normalizeMtime(input.stat),
    isSymlink: input.isSymlink ?? type === 'symlink',
  }
  if (input.target !== undefined) entry.target = input.target
  return entry
}

/** Build a `FileInfo` (`DirEntry` + `exists` + optional ownership). */
export function fileInfoOf(input: EntryInput & { exists?: boolean }): FileInfo {
  const entry = entryOf(input)
  const info: FileInfo = { ...entry, exists: input.exists ?? true }
  const uid = input.stat?.uid
  const gid = input.stat?.gid
  if (typeof uid === 'number' && Number.isFinite(uid)) info.uid = Math.trunc(uid)
  if (typeof gid === 'number' && Number.isFinite(gid)) info.gid = Math.trunc(gid)
  return info
}

/**
 * The `exists: false` projection of a path.
 *
 * `stat` deliberately answers for a missing path instead of throwing (ICD §4.5
 * gives `FileInfo` an `exists` field for exactly this), and the UI needs a name
 * and a path to render the row it just failed to stat.
 */
export function missingFileInfo(path: string, name?: string): FileInfo {
  const derived = name ?? path.replace(/\/+$/, '').split('/').pop() ?? path
  return {
    name: derived,
    path,
    type: 'other',
    size: 0,
    mode: formatMode(0),
    mtime: '',
    isSymlink: false,
    exists: false,
  }
}
