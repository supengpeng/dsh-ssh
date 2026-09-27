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

import { lstat, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import type { DirEntry, FileInfo } from '../connection/types.js'
import { SshError } from '../protocol.js'
import { compareEntries, entryOf, fileInfoOf, isHiddenName, missingFileInfo, type StatLike } from '../sftp/format.js'

/** Minimal logger so this module stays usable outside a Cordis tree. */
export interface LocalFsLogger {
  warn(message: string): void
}

export interface LocalFsDeps {
  /** Directory used when a request carries no path; defaults to the process cwd. */
  root?: string
  /** Include dot-entries by default (a request can still override it). */
  showHidden?: boolean
  logger?: LocalFsLogger
  /**
   * Per-entry stat, injectable so the "one unreadable entry" path is testable
   * without depending on filesystem permissions (which are not portable).
   * Defaults to `lstat`, which keeps a symlink a symlink.
   */
  statEntry?: (path: string) => Promise<StatLike>
}

/** Map a Node filesystem error onto the frozen code table (ICD §5). */
function mapError(error: unknown, path: string): SshError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  switch (code) {
    case 'ENOENT':
      return new SshError('SSH_SFTP_NO_SUCH_FILE', `local path does not exist: ${path}`, { details: { path } })
    case 'EACCES':
    case 'EPERM':
      return new SshError('SSH_PERM_LOCAL_DENIED', `local path is not accessible: ${path}`, { details: { path } })
    case 'ENOTDIR':
      return new SshError('SSH_SFTP_IS_A_DIRECTORY', `not a directory: ${path}`, { details: { path } })
    case 'EISDIR':
      return new SshError('SSH_SFTP_IS_A_DIRECTORY', `is a directory: ${path}`, { details: { path } })
    default:
      return new SshError('SSH_UNKNOWN', `local filesystem error: ${path}`, {
        details: { path, code },
        cause: error,
      })
  }
}

/** Resolve a request path to an absolute one, honouring the configured root. */
export function resolveLocalPath(requestPath: string | undefined, deps: LocalFsDeps = {}): string {
  const base = deps.root && deps.root.trim() !== '' ? resolve(deps.root) : process.cwd()
  const candidate = requestPath?.trim()
  if (candidate === undefined || candidate === '') return base
  return isAbsolute(candidate) ? candidate : resolve(base, candidate)
}

/**
 * List one local directory.
 *
 * Returns an absolute `cwd` so the pane can show where it actually landed
 * (relative requests and `..` both make the resolved directory worth reporting).
 */
export async function listLocalDir(
  request: { path?: string; showHidden?: boolean } = {},
  deps: LocalFsDeps = {},
): Promise<{ entries: DirEntry[]; cwd: string }> {
  const cwd = resolveLocalPath(request.path, deps)
  const showHidden = request.showHidden ?? deps.showHidden ?? false

  let dirents
  try {
    dirents = await readdir(cwd, { withFileTypes: true })
  } catch (error) {
    throw mapError(error, cwd)
  }

  const entries: DirEntry[] = []
  const statEntry = deps.statEntry ?? ((target: string) => lstat(target))
  for (const dirent of dirents) {
    const name = dirent.name
    if (!showHidden && isHiddenName(name)) continue
    const full = join(cwd, name)
    // `lstat` (not `stat`) keeps a symlink a symlink: following it here would
    // report the target's size and hide the link, and the UI marks links.
    try {
      const info = await statEntry(full)
      entries.push(
        entryOf({
          name,
          path: full,
          stat: info,
          isSymlink: info.isSymbolicLink?.() ?? false,
        }),
      )
    } catch (error) {
      // A racing delete or an unreadable single entry must not fail the listing;
      // the row is still shown with unknown size/mode rather than vanishing.
      deps.logger?.warn(`dsh-ssh: could not stat ${full}: ${String(error)}`)
      entries.push(entryOf({ name, path: full, stat: undefined, type: dirent.isDirectory() ? 'dir' : 'other' }))
    }
  }

  entries.sort(compareEntries)
  return { entries, cwd }
}

/** Stat one local path, reporting absence as `exists:false` rather than throwing. */
export async function statLocal(request: { path: string }, deps: LocalFsDeps = {}): Promise<{ info: FileInfo }> {
  const target = resolveLocalPath(request.path, deps)
  if (request.path === undefined || request.path.trim() === '') {
    throw new SshError('SSH_CFG_INVALID', 'statLocal requires a path')
  }
  try {
    const info = await stat(target)
    const name = target.split(/[\\/]/).pop() ?? target
    return { info: fileInfoOf({ name, path: target, stat: info, exists: true, isSymlink: info.isSymbolicLink() }) }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT') {
      const name = target.split(/[\\/]/).pop() ?? target
      return { info: missingFileInfo(target, name) }
    }
    throw mapError(error, target)
  }
}
