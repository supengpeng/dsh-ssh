/**
 * `SftpClient` (ICD-shaped normalization + the recursive walk), the shared
 * formatting helpers both file-manager panes depend on, the error mapper, and
 * `TransferManager` (op registry, cancel, `listTransfers`).
 *
 * These are the contracts that a UI or the wire layer consumes directly, so they
 * are asserted by value rather than by "it did not throw": entry ordering, the
 * octal mode string, `stat` answering `exists: false` instead of throwing, the
 * error code a missing path maps to, and the resume handshake the file manager
 * labels a row with.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { SftpClient } from '../../lib/sftp/client.js'
import {
  abortedTransfer,
  cancelledTransfer,
  codedError,
  errorInfoOf,
  isAbortError,
  targetExists,
  toSftpError,
  verifyMismatch,
} from '../../lib/sftp/errors.js'
import {
  compareEntries,
  dotFileHidden,
  entryOf,
  fileInfoOf,
  formatMode,
  isHiddenName,
  missingFileInfo,
  mtimeMsOf,
  naturalCompare,
  normalizeMtime,
  parseMode,
  typeOfStat,
} from '../../lib/sftp/format.js'
import { TransferManager } from '../../lib/sftp/manager.js'
import {
  isRemoteAbsolute,
  localBasename,
  localJoin,
  remoteBasename,
  remoteDirname,
  remoteJoin,
  remoteNormalize,
  remoteRelativeUnder,
} from '../../lib/sftp/paths.js'
import { SshError } from '../../lib/protocol.js'
import { createFakeHandle } from './sftp-fakes.mjs'

const KiB = 1024
const MiB = 1024 * 1024

async function tmpRoot(t, prefix = 'dsh-ssh-sftp-client-') {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  // Best-effort: a cleanup problem (a Windows handle still open) must never be
  // reported as a test failure.
  t.after(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
  })
  return dir
}

// ---------------------------------------------------------------------------
// format.ts — shared by the remote pane and the local pane
// ---------------------------------------------------------------------------

test('formatMode emits four octal digits and parseMode round-trips it', () => {
  assert.equal(formatMode(0o644), '0644')
  assert.equal(formatMode(0o755), '0755')
  assert.equal(formatMode(0o1777), '1777')
  assert.equal(formatMode(0o100644), '0644', 'file-type bits are dropped: type has its own field')
  assert.equal(formatMode(undefined), '0000')
  assert.equal(parseMode('0755'), 0o755)
  assert.equal(parseMode('755'), 0o755)
  assert.equal(parseMode('0o700'), 0o700)
  assert.throws(() => parseMode('rwxr-xr-x'), (error) => error instanceof SshError && error.code === 'SSH_CFG_INVALID')
  assert.throws(() => parseMode('0999'), (error) => error instanceof SshError)
})

test('typeOfStat handles ssh2-style and node-style stats alike', () => {
  assert.equal(typeOfStat({ mode: 0o100644 }), 'file')
  assert.equal(typeOfStat({ mode: 0o040755 }), 'dir')
  assert.equal(typeOfStat({ mode: 0o120777 }), 'symlink')
  assert.equal(typeOfStat({ isFile: () => true, mode: 0o100644 }), 'file')
  assert.equal(typeOfStat({ isDirectory: () => true, mode: 0 }), 'dir')
  assert.equal(typeOfStat({ isSymbolicLink: () => true, isDirectory: () => false, mode: 0 }), 'symlink')
  assert.equal(typeOfStat({ mode: 0o010644 }), 'other')
  assert.equal(typeOfStat(null), 'other')
})

test('mtime handling accepts seconds, milliseconds, Dates and ISO strings', () => {
  const seconds = 1_700_000_000
  assert.equal(mtimeMsOf({ mtime: seconds }), seconds * 1000)
  assert.equal(mtimeMsOf({ mtime: 1_700_000_000_000 }), 1_700_000_000_000)
  assert.equal(mtimeMsOf({ mtimeMs: 1234.6 }), 1235)
  assert.equal(mtimeMsOf({ mtime: new Date(5000) }), 5000)
  assert.equal(mtimeMsOf({ mtime: '1970-01-01T00:00:05.000Z' }), 5000)
  assert.equal(mtimeMsOf({}), undefined)
  assert.equal(mtimeMsOf({ mtime: 'not a date' }), undefined)
  assert.equal(normalizeMtime({ mtime: seconds }), new Date(seconds * 1000).toISOString())
  assert.equal(normalizeMtime({}), '')
})

test('isHiddenName defaults to dot-files and accepts a caller policy', () => {
  assert.equal(isHiddenName('.bashrc'), true)
  assert.equal(isHiddenName('README.md'), false)
  assert.equal(isHiddenName('.', dotFileHidden), true)
  assert.equal(isHiddenName('..', dotFileHidden), true)
  // A Windows target pane can hide its own names without changing the default.
  const windowsPolicy = (name) => name.startsWith('.') || name === 'desktop.ini' || name === '$RECYCLE.BIN'
  assert.equal(isHiddenName('desktop.ini', windowsPolicy), true)
  assert.equal(isHiddenName('notes.txt', windowsPolicy), false)
})

test('entries sort directories first, then natural order, case-insensitively', () => {
  const names = ['file10.txt', 'Beta', 'file2.txt', 'alpha', 'zeta']
  const sorted = names
    .map((name, index) => entryOf({ name, path: `/${name}`, stat: { mode: 0o100644, size: index } }))
    .sort(compareEntries)
    .map((entry) => entry.name)
  assert.deepEqual(sorted, ['alpha', 'Beta', 'file2.txt', 'file10.txt', 'zeta'])

  const mixed = [
    entryOf({ name: 'z.txt', path: '/z.txt', stat: { mode: 0o100644 } }),
    entryOf({ name: 'adir', path: '/adir', stat: { mode: 0o040755 } }),
    entryOf({ name: 'a.txt', path: '/a.txt', stat: { mode: 0o100644 } }),
  ].sort(compareEntries)
  assert.deepEqual(
    mixed.map((entry) => entry.name),
    ['adir', 'a.txt', 'z.txt'],
  )

  assert.ok(naturalCompare('a2', 'a10') < 0)
  assert.ok(naturalCompare('A', 'a') < 0, 'the tie-break keeps the order total')
  assert.equal(naturalCompare('same', 'same'), 0)
})

test('entryOf / fileInfoOf / missingFileInfo build the ICD shapes', () => {
  const entry = entryOf({ name: 'x.bin', path: '/x.bin', stat: { mode: 0o100640, size: 12, mtime: 1_700_000_000, uid: 7, gid: 9 } })
  assert.deepEqual(entry, {
    name: 'x.bin',
    path: '/x.bin',
    type: 'file',
    size: 12,
    mode: '0640',
    mtime: new Date(1_700_000_000_000).toISOString(),
    isSymlink: false,
  })
  const info = fileInfoOf({ name: 'x.bin', path: '/x.bin', stat: { mode: 0o100640, size: 12, uid: 7, gid: 9 } })
  assert.equal(info.exists, true)
  assert.equal(info.uid, 7)
  const missing = missingFileInfo('/no/such/file')
  assert.equal(missing.exists, false)
  assert.equal(missing.name, 'file')
  assert.equal(missing.mode, '0000')
})

// ---------------------------------------------------------------------------
// paths.ts
// ---------------------------------------------------------------------------

test('remote paths are coerced to POSIX form', () => {
  assert.equal(remoteJoin('/a', 'b', 'c'), '/a/b/c')
  assert.equal(remoteJoin('', 'b'), 'b')
  assert.equal(remoteDirname('/a/b/c'), '/a/b')
  assert.equal(remoteDirname('/a'), '/')
  assert.equal(remoteDirname('/'), '/')
  assert.equal(remoteBasename('/a/b/'), 'b')
  assert.equal(remoteNormalize('/a//b/./c/'), '/a/b/c')
  assert.equal(remoteNormalize('/a/b/../c'), '/a/c')
  assert.equal(remoteNormalize(''), '')
  assert.equal(remoteNormalize('/'), '/')
  assert.equal(isRemoteAbsolute('/x'), true)
  assert.equal(isRemoteAbsolute('x'), false)
  assert.equal(remoteRelativeUnder('/root', '/root/a/b'), 'a/b')
  assert.equal(remoteRelativeUnder('/root', '/root'), '')
  assert.equal(remoteRelativeUnder('/root', '/other/a'), null)
  assert.match(localJoin('a', 'b'), /^a[\\/]b$/)
  assert.equal(localBasename(localJoin('a', 'b.txt')), 'b.txt')
})

// ---------------------------------------------------------------------------
// errors.ts
// ---------------------------------------------------------------------------

test('toSftpError maps ssh2 numeric status codes and node error codes', () => {
  const numeric = (code, message = 'x') => {
    const error = new Error(message)
    error.code = code
    return error
  }
  assert.equal(toSftpError(numeric(2)).code, 'SSH_SFTP_NO_SUCH_FILE')
  assert.equal(toSftpError(numeric(3)).code, 'SSH_PERM_DENIED')
  assert.equal(toSftpError(numeric(3), { local: true }).code, 'SSH_PERM_LOCAL_DENIED')
  assert.equal(toSftpError(numeric(6)).code, 'SSH_NET_RESET')
  assert.equal(toSftpError(numeric(7)).code, 'SSH_NET_RESET')
  assert.equal(toSftpError(numeric(8)).code, 'SSH_SFTP_PROTOCOL')
  // SFTP v3 has no EEXIST status: "exists" arrives as a bare FAILURE whose text
  // carries the detail, which is exactly why conflicts are decided by stat().
  assert.equal(toSftpError(numeric(4, 'File exists')).code, 'SSH_SFTP_TARGET_EXISTS')
  assert.equal(toSftpError(numeric(4, 'No space left on device')).code, 'SSH_SFTP_DISK_FULL')
  assert.equal(toSftpError(numeric(4, 'Permission denied')).code, 'SSH_PERM_DENIED')
  assert.equal(toSftpError(numeric(4, 'unexpected')).code, 'SSH_SFTP_PROTOCOL')

  assert.equal(toSftpError(codedError('ENOENT', 'gone')).code, 'SSH_SFTP_NO_SUCH_FILE')
  assert.equal(toSftpError(codedError('EACCES', 'nope')).code, 'SSH_PERM_DENIED')
  assert.equal(toSftpError(codedError('EACCES', 'nope'), { local: true }).code, 'SSH_PERM_LOCAL_DENIED')
  assert.equal(toSftpError(codedError('EISDIR', 'a directory')).code, 'SSH_SFTP_IS_A_DIRECTORY')
  assert.equal(toSftpError(codedError('ENOSPC', 'full')).code, 'SSH_SFTP_DISK_FULL')
  assert.equal(toSftpError(codedError('EEXIST', 'there')).code, 'SSH_SFTP_TARGET_EXISTS')
  assert.equal(toSftpError(codedError('EWHATEVER', 'odd')).code, 'SSH_UNKNOWN')

  const context = toSftpError(codedError('ENOENT', 'gone'), { op: 'stat', path: '/x', local: true })
  assert.equal(context.details.op, 'stat')
  assert.equal(context.details.path, '/x')
  assert.equal(context.details.side, 'local')
  assert.equal(context.details.errno, 'ENOENT')
  assert.equal(context.message, 'gone')
})

test('isAbortError recognizes the abort shapes and nothing else', () => {
  const aborted = new Error('aborted')
  aborted.name = 'AbortError'
  assert.equal(isAbortError(aborted), true)
  assert.equal(isAbortError(codedError('ABORT_ERR', 'aborted')), true)
  assert.equal(isAbortError(new SshError('SSH_CANCELLED', 'cancelled')), true)
  assert.equal(isAbortError(new SshError('SSH_SFTP_TRANSFER_ABORTED', 'aborted')), true)
  assert.equal(isAbortError(codedError('ENOENT', 'gone')), false)
})

test('the error constructors carry the ICD codes and their retryability', () => {
  const aborted = abortedTransfer({
    opId: 'op_1',
    direction: 'upload',
    localPath: 'a',
    remotePath: '/b',
    resumedFrom: 4096,
    transferred: 8192,
    totalBytes: 1_000_000,
    entry: 'a',
  })
  assert.equal(aborted.code, 'SSH_SFTP_TRANSFER_ABORTED')
  assert.equal(aborted.retryable, true)
  assert.equal(aborted.details.resumable, true)
  assert.equal(aborted.details.resumedFrom, 4096)
  assert.equal(aborted.details.entry, 'a')

  const cancelled = cancelledTransfer({ opId: 'op_2', direction: 'download', localPath: 'a', remotePath: '/b' })
  assert.equal(cancelled.code, 'SSH_CANCELLED')
  assert.equal(cancelled.details.resumable, false)

  const exists = targetExists({ path: '/x', remoteSize: 10, localSize: 20, direction: 'upload', resumable: true })
  assert.equal(exists.code, 'SSH_SFTP_TARGET_EXISTS')
  assert.equal(exists.retryable, false)
  assert.equal(exists.details.overwrite, false)

  const mismatch = verifyMismatch({
    mode: 'size+mtime',
    localPath: 'a',
    remotePath: '/b',
    localSize: 10,
    remoteSize: 9,
  })
  assert.equal(mismatch.code, 'SSH_SFTP_VERIFY_MISMATCH')
  assert.equal(mismatch.retryable, true)
  assert.equal(mismatch.details.mode, 'size+mtime')
  assert.ok(mismatch.details.localSha256 === undefined, 'a size failure must not pretend to carry digests')

  const info = errorInfoOf(aborted)
  assert.equal(info.code, 'SSH_SFTP_TRANSFER_ABORTED')
  assert.equal(info.retryable, true)
})

// ---------------------------------------------------------------------------
// SftpClient
// ---------------------------------------------------------------------------

test('client.listDir filters hidden entries, sorts them and answers cwd', async (t) => {
  const root = await tmpRoot(t)
  await mkdir(join(root, 'dir'), { recursive: true })
  await writeFile(join(root, 'file10.txt'), 'x')
  await writeFile(join(root, 'file2.txt'), 'x')
  await writeFile(join(root, '.hidden'), 'x')

  const client = new SftpClient(createFakeHandle(root))
  const visible = await client.listDir('.')
  assert.equal(visible.cwd, '.', 'cwd echoes the path the caller asked for')
  assert.deepEqual(
    visible.entries.map((entry) => entry.name),
    ['dir', 'file2.txt', 'file10.txt'],
  )
  const all = await client.listDir('.', { showHidden: true })
  assert.equal(all.entries.length, 4)
  assert.ok(all.entries.some((entry) => entry.name === '.hidden'))
  assert.equal(all.entries[0].type, 'dir')
})

test('client.stat answers exists:false for a missing path, whatever the handle throws', async (t) => {
  const root = await tmpRoot(t)
  await writeFile(join(root, 'x'), 'x')
  const client = new SftpClient(createFakeHandle(root))
  const present = await client.stat('/x')
  assert.equal(present.exists, true)
  assert.equal(present.type, 'file')

  const absent = await client.stat('/nope')
  assert.equal(absent.exists, false)
  assert.equal(absent.name, 'nope')

  // A handle that throws instead of answering is normalized too.
  const throwing = {
    ...createFakeHandle(root),
    stat: async () => {
      throw codedError(2, 'No such file or directory')
    },
  }
  const normalized = await new SftpClient(throwing).stat('/nope')
  assert.equal(normalized.exists, false)
  const other = {
    ...createFakeHandle(root),
    stat: async () => {
      throw codedError(3, 'Permission denied')
    },
  }
  await assert.rejects(() => new SftpClient(other).stat('/x'), (error) => error.code === 'SSH_PERM_DENIED')
})

test('client mkdir/rename/chmod/remove behave as the ICD describes', async (t) => {
  const root = await tmpRoot(t)
  await writeFile(join(root, 'a.txt'), 'hello')
  const handle = createFakeHandle(root)
  const client = new SftpClient(handle)

  await client.mkdir('/one/two/three', { recursive: true })
  assert.deepEqual((await readdir(join(root, 'one', 'two'))), ['three'])
  await client.mkdir('/one/two/three', { recursive: true }) // idempotent, like mkdir -p

  await client.rename('/a.txt', '/b.txt')
  assert.deepEqual(await readdir(root), ['b.txt', 'one'])

  await client.chmod('/b.txt', '0600')
  // The contract is the request: the octal **string** must reach the handle
  // unchanged (ssh2 parses it as octal). Windows has no POSIX permission bits,
  // so the on-disk round-trip is only meaningful on a POSIX host.
  assert.deepEqual(handle.chmodCalls.at(-1), { path: '/b.txt', mode: '0600' })
  if (process.platform !== 'win32') assert.equal((await client.stat('/b.txt')).mode, '0600')

  await writeFile(join(root, 'b.txt'), 'x')
  assert.equal(await client.remove('/b.txt'), 1)
  assert.equal((await client.stat('/b.txt')).exists, false)

  await mkdir(join(root, 'tree'), { recursive: true })
  await writeFile(join(root, 'tree', 'leaf.txt'), 'x')
  // one dir + one file removed, counted
  assert.equal(await client.remove('/tree', { recursive: true }), 2)
  assert.equal((await client.stat('/tree')).exists, false)

  await mkdir(join(root, 'empty'))
  assert.equal(await client.remove('/empty'), 1, 'an empty directory is removable without recursion')

  await assert.rejects(() => client.remove('/gone'), (error) => error.code === 'SSH_SFTP_NO_SUCH_FILE')
})

test('client.walk preserves structure and does not follow symlinks by default', async (t) => {
  const root = await tmpRoot(t)
  await mkdir(join(root, 'nested', 'deep'), { recursive: true })
  await writeFile(join(root, 'top.txt'), 'top')
  await writeFile(join(root, 'nested', 'mid.txt'), 'mid')
  await writeFile(join(root, 'nested', 'deep', 'low.txt'), 'low')
  let linked = true
  try {
    await symlink(join(root, 'nested'), join(root, 'link'), 'junction')
  } catch {
    linked = false
  }

  const client = new SftpClient(createFakeHandle(root))
  const entries = await client.walk('/')
  assert.deepEqual(
    entries.map((entry) => entry.relPath).sort(),
    ['', 'nested', 'nested/deep', 'nested/deep/low.txt', 'nested/mid.txt', 'top.txt', ...(linked ? ['link'] : [])].sort(),
  )
  assert.equal(entries[0].relPath, '', 'the root is included so an empty tree still creates its destination')
  // Parents before children: every entry's parent must already have been emitted.
  const emitted = new Set()
  for (const entry of entries) {
    if (entry.relPath !== '') {
      const parent = entry.relPath.includes('/') ? entry.relPath.slice(0, entry.relPath.lastIndexOf('/')) : ''
      assert.ok(emitted.has(parent), `${entry.relPath} appeared before its parent`)
    }
    emitted.add(entry.relPath)
  }
  assert.ok(entries.some((entry) => entry.depth === 2))
  if (linked) {
    const link = entries.find((entry) => entry.name === 'link')
    assert.equal(link.type, 'symlink', 'a symlinked directory is not walked when links are off')
    assert.equal(link.isSymlink, true)
  }

  // With the option on, the same link is walked through.
  if (linked) {
    const followed = await new SftpClient(createFakeHandle(root)).walk('/', { followSymlinks: true })
    const linkChildren = followed.filter((entry) => entry.relPath === 'link/mid.txt')
    assert.equal(linkChildren.length, 1, 'followSymlinks walks through the link')
  }

  // The depth guard refuses an over-deep tree instead of hanging.
  await assert.rejects(
    () => client.walk('/', { maxDepth: 1 }),
    (error) => error.code === 'SSH_CFG_INVALID' && /deeper than/.test(error.message),
  )
})

// ---------------------------------------------------------------------------
// TransferManager
// ---------------------------------------------------------------------------

function fakeSessions(handle) {
  const sessions = new Map()
  const session = { id: 's_1', sftp: async () => handle }
  sessions.set('s_1', session)
  return { get: (id) => sessions.get(id) }
}

test('manager.start answers the §4.5 handshake with the resume offset for one file', async (t) => {
  const dir = await tmpRoot(t)
  const remoteRoot = join(dir, 'remote')
  await mkdir(remoteRoot, { recursive: true })
  const localFile = join(dir, 'payload.bin')
  await writeFile(localFile, Buffer.alloc(3 * MiB, 7))
  await writeFile(join(remoteRoot, 'payload.bin'), Buffer.alloc(MiB, 7))

  const handle = createFakeHandle(remoteRoot)
  const frames = []
  const manager = new TransferManager({
    sessions: fakeSessions(handle),
    defaults: { chunkBytes: 256 * KiB, maxConcurrentChunks: 2, resume: true, verify: 'size+mtime' },
  })

  const started = await manager.start({
    sessionId: 's_1',
    direction: 'upload',
    localPath: localFile,
    remotePath: '/payload.bin',
    // The remote file holds this upload's own 1 MiB prefix; the append needs the
    // caller's authorisation under `confirmDangerous` (F-SEC-05).
    overwrite: true,
    sink: { onProgress: (progress) => frames.push(progress) },
  })
  assert.match(started.opId, /^op_/)
  assert.match(started.streamId, /^st_/)
  assert.equal(started.resumedFrom, MiB, 'the handshake reports the offset before the stream starts')
  assert.equal(started.totalBytes, 3 * MiB)

  const record = manager.require(started.opId)
  assert.equal(record.direction, 'upload')
  assert.equal(manager.active, 1)

  await waitFor(() => manager.require(started.opId).finishedAt !== undefined)
  const settled = manager.require(started.opId)
  assert.equal(settled.phase, 'done')
  assert.equal(settled.transferred, 2 * MiB)
  assert.equal(settled.resumeFrom, MiB)
  assert.ok(frames.length > 0)
  assert.ok(frames.every((frame) => typeof frame.bytesPerSec === 'number'))
  assert.equal(manager.active, 0)
  assert.equal(manager.list().length, 1)
})

test('manager.cancel aborts the transfer with a resumable offset and an end event', async (t) => {
  const dir = await tmpRoot(t)
  const remoteRoot = join(dir, 'remote')
  await mkdir(remoteRoot, { recursive: true })
  const localFile = join(dir, 'payload.bin')
  await writeFile(localFile, Buffer.alloc(8 * MiB, 3))

  const handle = createFakeHandle(remoteRoot, { writeDelayMs: 3 })
  const events = []
  const manager = new TransferManager({
    sessions: fakeSessions(handle),
    defaults: { chunkBytes: 256 * KiB, maxConcurrentChunks: 4, resume: true, verify: 'none' },
  })

  const started = await manager.start({
    sessionId: 's_1',
    direction: 'upload',
    localPath: localFile,
    remotePath: '/payload.bin',
    sink: {
      onProgress: (progress) => {
        if (progress.transferred >= MiB && manager.active === 1) manager.cancel(started.opId)
      },
      onEnd: (event) => events.push(event),
    },
  })
  await waitFor(() => events.length > 0)
  assert.equal(events[0].reason, 'cancelled')
  assert.equal(events[0].error.code, 'SSH_SFTP_TRANSFER_ABORTED')
  const record = manager.require(started.opId)
  assert.equal(record.phase, 'cancelled')
  assert.ok(record.resumeFrom > 0, 'the record keeps the offset a retry would use')
  assert.equal(manager.cancel(started.opId), false, 'cancelling a settled transfer is a no-op')
})

test('manager.run returns the outcome and rejects with the transfer error', async (t) => {
  const dir = await tmpRoot(t)
  const remoteRoot = join(dir, 'remote')
  await mkdir(remoteRoot, { recursive: true })
  const localFile = join(dir, 'payload.bin')
  await writeFile(localFile, Buffer.alloc(64 * KiB, 1))

  const manager = new TransferManager({
    sessions: fakeSessions(createFakeHandle(remoteRoot)),
    defaults: { chunkBytes: 64 * KiB, maxConcurrentChunks: 2, resume: true, verify: 'sha256' },
  })
  const outcome = await manager.run({ sessionId: 's_1', direction: 'upload', localPath: localFile, remotePath: '/ok.bin' })
  assert.equal(outcome.transferred, 64 * KiB)
  assert.equal(outcome.verify, 'sha256')

  await assert.rejects(
    () => manager.run({ sessionId: 's_1', direction: 'upload', localPath: localFile, remotePath: '/ok.bin', overwrite: false, resume: false }),
    (error) => error.code === 'SSH_SFTP_TARGET_EXISTS',
  )
  const record = manager.list().at(-1)
  assert.equal(record.phase, 'error')
  assert.equal(record.error.code, 'SSH_SFTP_TARGET_EXISTS')
})

test('manager refuses an unknown session and lists bounded history', async (t) => {
  const dir = await tmpRoot(t)
  const manager = new TransferManager({ sessions: fakeSessions(createFakeHandle(dir)) })
  await assert.rejects(
    () => manager.start({ sessionId: 's_missing', direction: 'upload', localPath: 'a', remotePath: '/b' }),
    (error) => error.code === 'SSH_STATE_INVALID',
  )
  assert.throws(() => manager.require('op_nope'), (error) => error.code === 'SSH_STATE_INVALID')
  assert.deepEqual(manager.list(), [])
  manager.dispose()
})

/** Poll a predicate; the manager has no promise to await for a background run. */
async function waitFor(predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for the transfer to settle')
}
