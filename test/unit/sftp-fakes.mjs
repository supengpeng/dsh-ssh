/**
 * A filesystem-backed fake `SftpHandle` for the SFTP unit tests.
 *
 * Backed by a real temporary directory rather than an in-memory `Map`, for three
 * reasons that matter to what these tests have to prove:
 *
 *  1. the 100 MiB acceptance test then streams through real `node:fs` streams:
 *     no multi-hundred-MiB buffers, and the chunk/offset plumbing is exercised
 *     against real short reads rather than an idealized Buffer slice;
 *  2. `createReadStream({ start, end })` and `createWriteStream({ start })` get
 *     the same inclusive-range and pread semantics the real adapter gets from
 *     ssh2, so a wrong offset shows up here rather than on a live host;
 *  3. cancellation races are real: a write in flight is an actual pending
 *     syscall, not a synchronous stub.
 *
 * Capabilities are switchable so the engine's degradation paths are testable:
 * `offsetWrite: false` makes `start` a lie (optionally declared, optionally not),
 * `truncateSupported: false` removes `truncate`, `corruptWrites: true` silently
 * flips a byte so the sha256 verification has something to catch,
 * `suppressFinish: true` hides the `finish` event the way ssh2's SFTP
 * `WriteStream` does (a `node:fs` stream emits it; ssh2 never does), and
 * `neverAckWrites: true` models a peer that vanished without ever calling the
 * write callback.
 */

import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, lstat, mkdir, readdir, readlink, rename, rmdir, rm, truncate } from 'node:fs/promises'
import { posix, win32 } from 'node:path'

/** Remote path to local path inside the fake host root. */
function localOf(root, remotePath) {
  const normalized = posix.normalize(String(remotePath))
  const relative = normalized.replace(/^\/+/, '')
  const local = win32.join(root, ...relative.split('/'))
  if (!win32.resolve(local).startsWith(win32.resolve(root))) {
    throw new Error(`path escapes the fake host root: ${remotePath}`)
  }
  return local
}

function modeOf(stats) {
  return (stats.mode & 0o7777).toString(8).padStart(4, '0')
}

/**
 * Translate a local link target back into the fake host's namespace.
 *
 * A real SFTP `readlink` answers with a path in the *server's* namespace; a
 * Windows junction answers with `C:\...`. Without this translation, "follow the
 * symlink" would be untestable off POSIX, and testing it is the point.
 */
function remoteTargetOf(absolute, root) {
  const resolved = win32.resolve(absolute)
  const base = win32.resolve(root)
  if (resolved === base) return '/'
  if (!resolved.startsWith(base)) return absolute
  return `/${win32.relative(base, resolved).split(win32.sep).join('/')}`
}

function typeOf(stats) {
  if (stats.isSymbolicLink()) return 'symlink'
  if (stats.isDirectory()) return 'dir'
  if (stats.isFile()) return 'file'
  return 'other'
}

/** Remove a path, counting every entry that disappears (the ICD `removed` count). */
async function removeCounted(path, recursive) {
  const stats = await lstat(path)
  if (!stats.isDirectory()) {
    await rm(path, { force: false })
    return 1
  }
  if (!recursive) {
    // `rmdir`, not `rm`: an empty directory must be removable and a non-empty one
    // must fail, which is what the ICD asks of `remove` without recursion.
    await rmdir(path)
    return 1
  }
  let removed = 0
  for (const child of await readdir(path)) {
    removed += await removeCounted(win32.join(path, child), true)
  }
  await rmdir(path)
  return removed + 1
}

/** Instrumented stream wrappers: the tests assert real concurrency from these. */
function track(handle, stream, kind = 'read') {
  handle.activeStreams += 1
  handle.maxActiveStreams = Math.max(handle.maxActiveStreams, handle.activeStreams)
  if (kind === 'write') {
    handle.activeWrites += 1
    handle.maxActiveWrites = Math.max(handle.maxActiveWrites, handle.activeWrites)
  }
  const done = () => {
    handle.activeStreams -= 1
    if (kind === 'write') handle.activeWrites -= 1
  }
  stream.once('close', done)
  stream.once('error', done)
  return stream
}

/**
 * Build a fake handle.
 *
 * @param {string} root backing directory (the "remote host")
 * @param {object} [options]
 * @param {boolean} [options.offsetWrite] honour `start` on write streams (default true)
 * @param {boolean} [options.declareOffsetWrite] expose `supportsOffsetWrite()` (default true)
 * @param {boolean} [options.truncateSupported] expose `truncate()` (default true)
 * @param {boolean} [options.corruptWrites] flip the first written byte (default false)
 * @param {boolean} [options.suppressFinish] hide the `finish` event, like ssh2 (default false)
 * @param {boolean} [options.neverAckWrites] never call a write callback, like a dead peer (default false)
 * @param {number} [options.failAfterBytes] inject a link-class failure after N acknowledged bytes
 * @param {number} [options.failTimes] how many attempts may fail that way (default 0)
 * @param {number} [options.writeDelayMs] per-chunk write delay, to hold ranges in flight
 */
export function createFakeHandle(root, options = {}) {
  const offsetWrite = options.offsetWrite !== false
  const corrupt = options.corruptWrites === true
  const suppressFinish = options.suppressFinish === true
  const neverAckWrites = options.neverAckWrites === true
  const failAfterBytes = options.failAfterBytes ?? 0
  const failTimes = options.failTimes ?? 0
  const writeDelayMs = options.writeDelayMs ?? 0
  const handle = {
    root,
    /** Concurrent read/write streams observed; the parallel-range tests read this. */
    activeStreams: 0,
    maxActiveStreams: 0,
    /** Write streams only: the honest measure of "how many ranges were in flight". */
    activeWrites: 0,
    maxActiveWrites: 0,
    bytesWritten: 0,
    bytesRead: 0,
    writes: 0,
    truncated: [],
    /** Every `chmod` request, so the octal-string pass-through is assertable. */
    chmodCalls: [],
    /** Transfer attempts started (a retry shows as 2) and their concurrency. */
    attempts: 0,
    lastAttemptConcurrency: 0,
    /** Bytes acknowledged in the current attempt, for `failAfterBytes`. */
    attemptBytes: 0,
    failuresLeft: failTimes,
    openOffsetStreams: 0,
    currentBatch: 0,
  }

  handle.listDir = async (path, opts = {}) => {
    const dir = localOf(root, path)
    const names = await readdir(dir)
    const entries = []
    for (const name of names) {
      if (name === '.' || name === '..') continue
      if (opts.showHidden !== true && name.startsWith('.')) continue
      const absolute = win32.join(dir, name)
      const stats = await lstat(absolute)
      const symlink = stats.isSymbolicLink()
      let target
      if (symlink) {
        try {
          target = remoteTargetOf(await readlink(absolute), root)
        } catch {
          target = undefined
        }
      }
      entries.push({
        name,
        path: posix.join(posix.normalize(path), name),
        type: typeOf(stats),
        size: stats.isDirectory() ? 0 : stats.size,
        mode: modeOf(stats),
        mtime: stats.mtime.toISOString(),
        isSymlink: symlink,
        ...(target === undefined ? {} : { target }),
      })
    }
    return entries
  }

  handle.stat = async (path) => {
    let stats
    try {
      stats = await lstat(localOf(root, path))
    } catch (error) {
      if (error.code === 'ENOENT') {
        return {
          name: posix.basename(posix.normalize(path)),
          path: posix.normalize(path),
          type: 'other',
          size: 0,
          mode: '0000',
          mtime: '',
          isSymlink: false,
          exists: false,
        }
      }
      throw error
    }
    const symlink = stats.isSymbolicLink()
    let target
    if (symlink) {
      try {
        target = remoteTargetOf(await readlink(localOf(root, path)), root)
      } catch {
        target = undefined
      }
    }
    return {
      name: posix.basename(posix.normalize(path)),
      path: posix.normalize(path),
      type: typeOf(stats),
      size: stats.isDirectory() ? 0 : stats.size,
      mode: modeOf(stats),
      mtime: stats.mtime.toISOString(),
      isSymlink: symlink,
      ...(target === undefined ? {} : { target }),
      uid: stats.uid,
      gid: stats.gid,
      exists: true,
    }
  }

  handle.mkdir = async (path, opts = {}) => {
    await mkdir(localOf(root, path), { recursive: opts.recursive === true })
  }

  handle.rename = async (from, to) => {
    await rename(localOf(root, from), localOf(root, to))
  }

  handle.remove = async (path, opts = {}) => {
    try {
      return await removeCounted(localOf(root, path), opts.recursive === true)
    } catch (error) {
      if (error.code === 'ENOENT') {
        const notFound = new Error('No such file or directory')
        notFound.code = 2
        throw notFound
      }
      throw error
    }
  }

  handle.chmod = async (path, mode) => {
    handle.chmodCalls.push({ path, mode })
    await chmod(localOf(root, path), Number.parseInt(String(mode).replace(/^0o/, ''), 8))
  }

  handle.createReadStream = (path, opts = {}) => {
    const streamOptions = {}
    if (opts.start !== undefined) streamOptions.start = opts.start
    if (opts.end !== undefined) streamOptions.end = opts.end
    const stream = createReadStream(localOf(root, path), streamOptions)
    stream.on('data', (chunk) => {
      handle.bytesRead += chunk.length
    })
    return track(handle, stream)
  }

  handle.createWriteStream = (path, opts = {}) => {
    const streamOptions = { flags: opts.flags ?? 'w' }
    if (opts.mode !== undefined) streamOptions.mode = opts.mode
    // The whole point of the fake: when `offsetWrite` is off, `start` is silently
    // dropped, exactly the failure mode the engine's probe exists to detect.
    if (offsetWrite && opts.start !== undefined) streamOptions.start = opts.start
    const stream = createWriteStream(localOf(root, path), streamOptions)
    // Attempt bookkeeping, for the retry tests: a batch is the set of offset
    // streams ('r+', i.e. one per range) opened while none is open. Creation
    // streams ('w') are setup, not part of an attempt.
    const isOffsetStream = (opts.flags ?? 'w') !== 'w'
    if (isOffsetStream) {
      if (handle.openOffsetStreams === 0) {
        handle.attempts += 1
        handle.currentBatch = 0
        handle.attemptBytes = 0
        handle.truncated.length = 0
      }
      handle.currentBatch += 1
      handle.lastAttemptConcurrency = handle.currentBatch
      handle.openOffsetStreams += 1
      stream.once('close', () => {
        handle.openOffsetStreams -= 1
      })
    }
    let first = true
    const originalWrite = stream.write.bind(stream)
    // The engine writes chunks directly (no pipe), so the accounting hooks the
    // public `write`; `writeDelayMs` then holds a chunk in flight long enough for
    // the abort tests to cancel a transfer that is genuinely mid-write.
    stream.write = (chunk, ...rest) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      handle.bytesWritten += buffer.length
      handle.writes += 1
      if (corrupt && first) {
        first = false
        buffer[0] = buffer[0] ^ 0xff
      }
      // Inject a link-class failure once the attempt has moved enough bytes: a
      // bare Error with no ICD code is exactly what ssh2 hands over when a channel
      // dies, and it must trigger one bounded resume-retry.
      if (failAfterBytes > 0 && handle.failuresLeft > 0 && handle.attemptBytes >= failAfterBytes) {
        handle.failuresLeft -= 1
        const error = new Error('No response from server')
        try {
          stream.destroy()
        } catch {
          /* already gone */
        }
        if (typeof rest.at(-1) === 'function') rest.at(-1)(error)
        return false
      }
      handle.attemptBytes += buffer.length
      // A peer that vanished without closing the channel: ssh2 never calls the
      // write callback in that case, so nothing may be written and the callback
      // must stay silent. Only the engine's chunk deadline can end the wait.
      if (neverAckWrites) return true
      if (writeDelayMs <= 0) return originalWrite(chunk, ...rest)
      const callback = typeof rest.at(-1) === 'function' ? rest.pop() : undefined
      setTimeout(() => {
        originalWrite(chunk, callback)
      }, writeDelayMs)
      return true
    }
    if (suppressFinish) {
      // ssh2's SFTP WriteStream emits `open`/`ready`/`close` but never `finish`
      // (`_final` destroys the stream instead). Hiding it here keeps a caller from
      // passing on a fake while hanging on a real server.
      const originalEmit = stream.emit.bind(stream)
      stream.emit = (event, ...rest) => (event === 'finish' ? false : originalEmit(event, ...rest))
    }
    return track(handle, stream, 'write')
  }

  if (options.declareOffsetWrite !== false) {
    handle.supportsOffsetWrite = () => offsetWrite
  }
  if (options.truncateSupported !== false) {
    handle.truncate = async (path, size) => {
      handle.truncated.push({ path, size })
      await truncate(localOf(root, path), size)
    }
  }
  return handle
}
