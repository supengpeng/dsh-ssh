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

import { compareEntries, missingFileInfo } from './format.js'
import { codedError, toSftpError } from './errors.js'
import { isRemoteAbsolute, remoteDirname, remoteJoin, remoteNormalize } from './paths.js'

import type { SshError } from '../protocol.js'
import type { DirEntry, FileInfo, SftpHandle, TransferLogger } from './types.js'

/** One node of a walked tree, with the relative path that mirrors its structure. */
export interface WalkEntry {
  /** Remote path as reached from the walk root. */
  path: string
  /** Path relative to the walk root; `''` for the root itself. */
  relPath: string
  name: string
  type: DirEntry['type']
  size: number
  mode: string
  mtime: string
  depth: number
  isSymlink: boolean
  target?: string
}

export interface WalkOptions {
  /** Follow symlinked directories. Defaults to the client's policy (false). */
  followSymlinks?: boolean
  /** Recursion guard, in levels. Defaults to the client's policy (64). */
  maxDepth?: number
  signal?: AbortSignal
  /** Called for every entry *as it is discovered* (scan-phase progress). */
  onEntry?: (entry: WalkEntry) => void
}

export interface SftpClientOptions {
  followSymlinks?: boolean
  maxDepth?: number
  logger?: TransferLogger
}

function abortedError(): Error {
  const error = new Error('the operation was aborted')
  error.name = 'AbortError'
  return error
}

function invalidArgument(message: string, op: string, path?: string): SshError {
  return toSftpError(codedError('EINVAL', message), { op, ...(path === undefined ? {} : { path }) })
}

export class SftpClient {
  readonly handle: SftpHandle
  private readonly followSymlinks: boolean
  private readonly maxDepth: number

  constructor(handle: SftpHandle, options: SftpClientOptions = {}) {
    this.handle = handle
    this.followSymlinks = options.followSymlinks === true
    this.maxDepth = Math.max(1, Math.trunc(options.maxDepth ?? 64))
  }

  /** `{ entries, cwd }`, the exact result shape of `sshPlugin/listDir`. */
  async listDir(
    path: string,
    opts: { showHidden?: boolean; signal?: AbortSignal } = {},
  ): Promise<{ entries: DirEntry[]; cwd: string }> {
    const cwd = remoteNormalize(path)
    if (cwd === '') throw invalidArgument('a directory path is required', 'listDir')
    const entries = await this.#call('listDir', cwd, () =>
      this.handle.listDir(cwd, {
        showHidden: opts.showHidden === true,
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      }),
    )
    // A handle is free to answer in server order; both file-manager panes share
    // one ordering (`compareEntries`: directories first, natural order).
    return { entries: [...entries].sort(compareEntries), cwd }
  }

  /** Entries only, for internal callers that do not need `cwd`. */
  async list(path: string, opts: { showHidden?: boolean; signal?: AbortSignal } = {}): Promise<DirEntry[]> {
    return (await this.listDir(path, opts)).entries
  }

  /**
   * `stat` that never throws for a missing path (ICD §4.5).
   *
   * Symlinks are reported as symlinks: the file manager must show the link, not
   * its target, or "do not follow symlinks" would be unenforceable in the UI.
   */
  async stat(path: string, signal?: AbortSignal): Promise<FileInfo> {
    const target = remoteNormalize(path)
    if (target === '') throw invalidArgument('a path is required', 'stat')
    try {
      return await this.#call('stat', target, () => this.handle.stat(target, signal))
    } catch (error) {
      const mapped = toSftpError(error, { op: 'stat', path: target })
      if (mapped.code === 'SSH_SFTP_NO_SUCH_FILE') return missingFileInfo(target)
      throw mapped
    }
  }

  async exists(path: string, signal?: AbortSignal): Promise<boolean> {
    return (await this.stat(path, signal)).exists
  }

  /** `mkdir -p` (the ICD default): an existing directory is not an error. */
  async mkdir(path: string, opts: { recursive?: boolean } = {}): Promise<void> {
    const target = remoteNormalize(path)
    if (target === '') throw invalidArgument('a directory path is required', 'mkdir')
    await this.#call('mkdir', target, () => this.handle.mkdir(target, { recursive: opts.recursive !== false }))
  }

  async rename(from: string, to: string): Promise<void> {
    const source = remoteNormalize(from)
    const destination = remoteNormalize(to)
    if (source === '' || destination === '') throw invalidArgument('both paths are required', 'rename')
    await this.#call('rename', `${source} -> ${destination}`, () => this.handle.rename(source, destination))
  }

  /** Remove one path; returns how many entries disappeared (the tree, counted). */
  async remove(path: string, opts: { recursive?: boolean; signal?: AbortSignal } = {}): Promise<number> {
    const target = remoteNormalize(path)
    if (target === '') throw invalidArgument('a path is required', 'remove')
    const removed = await this.#call('remove', target, () =>
      this.handle.remove(target, { recursive: opts.recursive === true }, opts.signal),
    )
    return typeof removed === 'number' && Number.isFinite(removed) ? removed : 0
  }

  async chmod(path: string, mode: string): Promise<void> {
    const target = remoteNormalize(path)
    if (target === '') throw invalidArgument('a path is required', 'chmod')
    await this.#call('chmod', target, () => this.handle.chmod(target, mode))
  }

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
  async walk(root: string, options: WalkOptions = {}): Promise<WalkEntry[]> {
    const base = remoteNormalize(root)
    if (base === '') throw invalidArgument('a path is required', 'walk')
    const follow = options.followSymlinks ?? this.followSymlinks
    const maxDepth = Math.max(1, Math.trunc(options.maxDepth ?? this.maxDepth))
    const signal = options.signal
    const out: WalkEntry[] = []
    const visited = new Set<string>()

    const visit = async (path: string, relPath: string, depth: number): Promise<void> => {
      if (signal?.aborted === true) throw abortedError()
      if (depth > maxDepth) {
        throw toSftpError(codedError('ELOOP', `the directory tree is deeper than ${maxDepth} levels`), {
          op: 'walk',
          path,
        })
      }
      const info = await this.stat(path, signal)
      if (!info.exists) {
        throw toSftpError(codedError(2, `no such file or directory: ${path}`), { op: 'walk', path })
      }
      // `stat` is an lstat, so a link always arrives as `symlink`. When the caller
      // asked to follow links, the *target's* type decides whether there is a
      // subtree to walk (and the size/mode make the copied file faithful).
      let resolved: FileInfo | undefined
      if (info.isSymlink && follow) {
        resolved = await this.#resolveSymlink(info, signal)
      }
      const effective = resolved ?? info
      const symlinkDir = effective.type === 'dir' && effective.isSymlink
      const entry: WalkEntry = {
        path: info.path,
        relPath,
        name: info.name,
        type: symlinkDir && !follow ? 'symlink' : effective.type,
        size: effective.size,
        mode: effective.mode,
        mtime: effective.mtime,
        depth,
        isSymlink: info.isSymlink,
        ...(info.target === undefined ? {} : { target: info.target }),
      }
      out.push(entry)
      options.onEntry?.(entry)

      if (entry.type !== 'dir') return
      if (visited.has(entry.path)) return
      visited.add(entry.path)
      const children = await this.list(entry.path, { signal, showHidden: true })
      for (const child of children) {
        const childRel = relPath === '' ? child.name : `${relPath}/${child.name}`
        await visit(remoteJoin(entry.path, child.name), childRel, depth + 1)
      }
    }

    await visit(base, '', 0)
    return out
  }

  /** Map any handle failure onto the ICD vocabulary, keeping the op/path context. */
  async #call<T>(op: string, path: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      throw toSftpError(error, { op, path })
    }
  }

  /**
   * Resolve a symlink to its target's `FileInfo` (needs the handle to report
   * `target`, i.e. `readlink`); `undefined` means "cannot follow" — a dangling
   * link or a server that refuses readlink — and the caller then treats the entry
   * as an unfollowable symlink rather than silently copying the wrong thing.
   */
  async #resolveSymlink(info: FileInfo, signal?: AbortSignal): Promise<FileInfo | undefined> {
    const raw = info.target
    if (raw === undefined || raw === '') return undefined
    const targetPath = isRemoteAbsolute(raw) ? remoteNormalize(raw) : remoteJoin(remoteDirname(info.path), raw)
    const resolved = await this.stat(targetPath, signal)
    return resolved.exists ? resolved : undefined
  }
}
