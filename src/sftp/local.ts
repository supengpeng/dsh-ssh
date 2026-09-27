/**
 * Local filesystem helpers for the transfer engine.
 *
 * "Local" is the machine DSH runs on, so this is the only module in `src/sftp`
 * that talks to `node:fs`. Keeping it separate buys two things: the remote half
 * stays a pure adapter over `SftpHandle` (and therefore mock-testable), and every
 * local error is mapped to the local-side ICD codes in one place.
 *
 * All reads and writes are **positional** (`FileHandle.read/write` with an
 * explicit offset) and loop until the requested length is satisfied: a short
 * read from a stream would otherwise be recorded as committed bytes and corrupt
 * the resume offset.
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, readdir, stat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'

import { entryOf, naturalCompare, typeOfStat } from './format.js'
import { localBasename, localJoin } from './paths.js'

import type { DirEntry } from './types.js'

/** One node of a walked local tree; mirrors `WalkEntry` on the remote side. */
export interface LocalEntry extends DirEntry {
  /** Path relative to the walk root; `''` for the root itself. */
  relPath: string
  depth: number
}

export interface LocalWalkOptions {
  followSymlinks?: boolean
  maxDepth?: number
  signal?: AbortSignal
  onEntry?: (entry: LocalEntry) => void
}

function abortedError(): Error {
  const error = new Error('the operation was aborted')
  error.name = 'AbortError'
  return error
}

/** Entry name for the wire: the last path component, or the root path itself. */
function nameOf(path: string, relPath: string): string {
  return relPath === '' ? path : localBasename(path)
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw abortedError()
}

/** `lstat` that answers `undefined` for a missing path instead of throwing. */
export async function lstatLocal(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** `stat` (symlinks followed) that answers `undefined` for a missing path. */
export async function statLocal(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Create (or truncate) a file without writing anything — the fresh-start case. */
export async function createOrTruncateLocalFile(path: string): Promise<void> {
  const handle = await open(path, 'w')
  await handle.close()
}

/** `mkdir -p`; an existing directory is not an error. */
export async function ensureLocalDir(path: string): Promise<void> {
  if (path === '') return
  await mkdir(path, { recursive: true })
}

/**
 * Depth-first local listing, parents before children, same ordering rule as the
 * remote side (`compareEntries`).
 *
 * With `followSymlinks: false` (the default, `sftp.followSymlinks`) a symlinked
 * directory is reported as `symlink` and is never entered — which is what keeps
 * a recursive upload from duplicating a tree through a link, or from looping.
 */
export async function listLocalTree(root: string, options: LocalWalkOptions = {}): Promise<LocalEntry[]> {
  const follow = options.followSymlinks === true
  const maxDepth = Math.max(1, Math.trunc(options.maxDepth ?? 64))
  const out: LocalEntry[] = []
  const visited = new Set<string>()

  const visit = async (path: string, relPath: string, depth: number): Promise<void> => {
    throwIfAborted(options.signal)
    if (depth > maxDepth) {
      const error = new Error(`the directory tree is deeper than ${maxDepth} levels`) as NodeJS.ErrnoException
      error.code = 'ELOOP'
      throw error
    }
    const stats = await lstatLocal(path)
    if (stats === undefined) {
      const error = new Error(`no such file or directory: ${path}`) as NodeJS.ErrnoException
      error.code = 'ENOENT'
      throw error
    }
    const type = typeOfStat(stats)
    const symlinkDir = type === 'dir' && stats.isSymbolicLink()
    const entry = entryOf({
      name: nameOf(path, relPath),
      path,
      stat: stats,
      type: symlinkDir && !follow ? 'symlink' : type,
      isSymlink: stats.isSymbolicLink(),
    }) as LocalEntry
    entry.relPath = relPath
    entry.depth = depth
    out.push(entry)
    options.onEntry?.(entry)

    if (entry.type !== 'dir') return
    if (visited.has(entry.path)) return
    visited.add(entry.path)

    const dirents = await readdir(entry.path, { withFileTypes: true })
    // Hidden entries are part of the tree: a recursive transfer must be faithful
    // (`showHidden` is a UI concern, not a transfer policy). Ordering is the
    // shared display order so both directions walk a tree identically.
    const names = dirents.map((dirent) => dirent.name)
    names.sort(naturalCompare)
    for (const name of names) {
      // `lstat` per child (not `Dirent`) so the reported type matches the remote
      // side, which only ever has stat attributes.
      const childPath = localJoin(entry.path, name)
      const childRel = relPath === '' ? name : `${relPath}/${name}`
      await visit(childPath, childRel, depth + 1)
    }
  }

  await visit(root, '', 0)
  return out
}

/** Read exactly `length` bytes at `position`; a short result means the file shrank. */
export async function readExactly(
  handle: FileHandle,
  length: number,
  position: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length)
  let filled = 0
  while (filled < length) {
    throwIfAborted(signal)
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled)
    if (bytesRead === 0) break
    filled += bytesRead
  }
  return filled === length ? buffer : buffer.subarray(0, filled)
}

/** Write the whole buffer at `position`, looping over short writes. */
export async function writeExactly(
  handle: FileHandle,
  buffer: Buffer,
  position: number,
  signal?: AbortSignal,
): Promise<void> {
  let written = 0
  while (written < buffer.length) {
    throwIfAborted(signal)
    const { bytesWritten } = await handle.write(buffer, written, buffer.length - written, position + written)
    if (bytesWritten <= 0) {
      throw new Error(`short write at offset ${position + written}`)
    }
    written += bytesWritten
  }
}

export interface DigestResult {
  hex: string
  bytes: number
}

/** Streamed sha256 of a local file (never buffers the file in memory). */
export async function sha256OfFile(path: string, signal?: AbortSignal): Promise<DigestResult> {
  const stream = createReadStream(path, { highWaterMark: 1024 * 1024 })
  try {
    return await sha256OfReadable(stream, { signal })
  } finally {
    // Always released: an abandoned read stream holds a descriptor until the GC,
    // which keeps the event loop alive and shows up as a deprecation warning.
    destroyStream(stream)
  }
}

/**
 * Streamed sha256 of any readable stream (a local file or a remote SFTP read
 * stream), with byte accounting so a truncated read is visible.
 *
 * The stream is destroyed on abort, which is what keeps `verify: 'sha256'` from
 * pinning a 100 MiB read that the user already cancelled.
 */
export async function sha256OfReadable(
  readable: NodeJS.ReadableStream,
  options: { signal?: AbortSignal; expectedBytes?: number } = {},
): Promise<DigestResult> {
  const hash = createHash('sha256')
  let bytes = 0
  return await new Promise<DigestResult>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      options.signal?.removeEventListener('abort', onAbort)
      readable.removeListener('data', onData)
      readable.removeListener('end', onEnd)
      readable.removeListener('error', onError)
    }
    const settle = (error: unknown, value?: DigestResult): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error !== undefined && error !== null) reject(error)
      else resolve(value as DigestResult)
    }
    const onAbort = (): void => {
      destroyStream(readable)
      settle(abortedError())
    }
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.length
      hash.update(buffer)
    }
    const onEnd = (): void => {
      if (options.expectedBytes !== undefined && bytes !== options.expectedBytes) {
        settle(new Error(`expected ${options.expectedBytes} bytes but read ${bytes}`))
        return
      }
      settle(undefined, { hex: hash.digest('hex'), bytes })
    }
    const onError = (error: unknown): void => {
      destroyStream(readable)
      settle(error)
    }

    if (options.signal?.aborted === true) {
      destroyStream(readable)
      settle(abortedError())
      return
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    readable.on('data', onData)
    readable.on('end', onEnd)
    readable.on('error', onError)
  })
}

/** Best-effort destroy; a stream that already ended may not have `destroy`. */
export function destroyStream(stream: NodeJS.ReadableStream | NodeJS.WritableStream | undefined): void {
  if (stream === undefined || stream === null) return
  const destroy = (stream as { destroy?: () => void }).destroy
  if (typeof destroy === 'function') {
    try {
      destroy.call(stream)
    } catch {
      /* a stream that is already closed is not an error */
    }
  }
}

export { throwIfAborted }
