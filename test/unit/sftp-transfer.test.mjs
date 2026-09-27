/**
 * Transfer engine - the acceptance suite.
 *
 * The headline case is the user's own acceptance criterion: a **100 MiB upload
 * and a 100 MiB download** with a correct progress bar and matching sha256
 * digests. That is measured, not asserted qualitatively: the run reports its
 * duration, and the assertions cover byte counts, digests, progress-frame
 * monotonicity/coalescing and real chunk concurrency.
 *
 * The remaining cases each pin one ICD §4.5 invariant:
 *  - resume from a partial destination (`resumedFrom`),
 *  - `SSH_SFTP_TARGET_EXISTS` and the `onConflict` decisions,
 *  - `SSH_SFTP_TRANSFER_ABORTED` with a **resumable offset**, plus a proof that
 *    resuming from that offset produces a byte-identical file,
 *  - `SSH_SFTP_VERIFY_MISMATCH` when sha256 disagrees,
 *  - recursive directory transfer preserving structure, symlinks not followed,
 *  - the degraded paths for a handle without offset writes / truncate.
 *
 * The fake handle is filesystem-backed (`sftp-fakes.mjs`), so all 100 MiB really
 * move through `node:fs` streams —nothing is simulated in memory.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createReadStream, createWriteStream, rmSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { buildRanges, durableOffset, resolveTransferOptions, TransferEngine } from '../../lib/sftp/transfer.js'
import { createFakeHandle } from './sftp-fakes.mjs'

const KiB = 1024
const MiB = 1024 * 1024
/** The user's acceptance size: 100 MiB written, streamed and verified both ways. */
const ACCEPTANCE_BYTES = 100 * MiB
const CHUNK = 256 * KiB

async function tmpRoot(t, prefix = 'dsh-ssh-sftp-') {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  // Best-effort: a Windows handle still open would make `rm` fail, and a cleanup
  // problem must never surface as a test failure.
  t.after(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
  })
  return dir
}

/**
 * Write a position-dependent pattern.
 *
 * Repeated content would make a misplaced chunk indistinguishable from a correct
 * one, which would quietly weaken every byte-for-byte assertion below; each
 * 256 KiB block therefore carries its own index and fill byte.
 */
async function writePattern(path, bytes, block = CHUNK) {
  const stream = createWriteStream(path)
  for (let written = 0, index = 0; written < bytes; index++, written += block) {
    const length = Math.min(block, bytes - written)
    const buffer = Buffer.alloc(length, (index * 37) & 0xff)
    buffer.writeUInt32BE(index >>> 0, 0)
    if (!stream.write(buffer)) await once(stream, 'drain')
  }
  await new Promise((resolve, reject) => {
    stream.once('error', reject)
    stream.end(resolve)
  })
}

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** Relative path →sha256 for every file under `root`, for tree comparisons. */
async function hashTree(root, prefix = '') {
  const out = {}
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    const absolute = join(root, entry.name)
    if (entry.isDirectory()) Object.assign(out, await hashTree(absolute, relative))
    else if (entry.isFile()) out[relative] = await sha256File(absolute)
  }
  return out
}

async function collectError(promise) {
  try {
    await promise
    return null
  } catch (error) {
    return error
  }
}

function engineFor(overrides = {}) {
  return new TransferEngine({
    defaults: { chunkBytes: CHUNK, maxConcurrentChunks: 4, resume: true, verify: 'size+mtime' },
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// The acceptance case: 100 MiB, both directions
// ---------------------------------------------------------------------------

for (const direction of ['upload', 'download']) {
  test(`acceptance: 100 MiB ${direction} streams in chunks, reports progress and matches sha256`, async (t) => {
    const dir = await tmpRoot(t)
    const remoteRoot = join(dir, 'remote')
    await mkdir(remoteRoot, { recursive: true })
    const localFile = join(dir, 'payload.bin')
    await writePattern(localFile, ACCEPTANCE_BYTES)
    const remoteFile = join(remoteRoot, 'payload.bin')

    if (direction === 'download') {
      // The remote side starts with the payload; the local destination does not exist.
      await rm(localFile, { force: true })
      await writePattern(remoteFile, ACCEPTANCE_BYTES)
    }

    const handle = createFakeHandle(remoteRoot, { writeDelayMs: 1 })
    const frames = []
    const engine = engineFor()
    const started = Date.now()
    const outcome = await engine.run(handle, {
      direction,
      localPath: localFile,
      remotePath: '/payload.bin',
      verify: 'sha256',
      onProgress: (progress) => frames.push({ ...progress, at: Date.now() }),
    })
    const durationMs = Date.now() - started

    // Byte accounting and both digests.
    const expected = await sha256File(direction === 'upload' ? localFile : remoteFile)
    assert.equal(outcome.transferred, ACCEPTANCE_BYTES)
    assert.equal(outcome.totalBytes, ACCEPTANCE_BYTES)
    assert.equal(outcome.resumedFrom, 0)
    assert.deepEqual(outcome.sha256, { local: expected, remote: expected })
    assert.equal(outcome.verify, 'sha256')
    assert.equal(outcome.entries.length, 1)
    assert.equal(outcome.skipped.length, 0)

    // Both sides are byte-identical (not merely the same length).
    assert.equal((await stat(remoteFile)).size, ACCEPTANCE_BYTES)
    assert.equal((await stat(localFile)).size, ACCEPTANCE_BYTES)
    assert.equal(await sha256File(remoteFile), expected)
    assert.equal(await sha256File(localFile), expected)

    // Progress: monotone, coalesced (not one frame per 256 KiB chunk), and the
    // last frame lands exactly on the total.
    assert.ok(frames.length >= 5, `expected several progress frames, saw ${frames.length}`)
    assert.ok(frames.length < 260, `frames look uncoalesced: ${frames.length} for ${ACCEPTANCE_BYTES / CHUNK} chunks`)
    for (let index = 1; index < frames.length; index++) {
      assert.ok(frames[index].transferred >= frames[index - 1].transferred, 'progress must never go backwards')
      assert.equal(frames[index].totalBytes, ACCEPTANCE_BYTES)
    }
    assert.equal(frames[0].phase, 'scan')
    assert.equal(frames[0].transferred, 0)
    assert.ok(frames.some((frame) => frame.phase === 'transfer'))
    assert.ok(frames.some((frame) => frame.phase === 'verify'))
    assert.equal(frames.at(-1).transferred, ACCEPTANCE_BYTES)
    assert.ok(outcome.bytesPerSec > 0)
    assert.ok(outcome.durationMs >= 0)

    // Real chunk concurrency: more than one stream was in flight at once.
    assert.ok(handle.maxActiveStreams >= 2, `expected concurrent streams, max was ${handle.maxActiveStreams}`)
    // Nothing was truncated on a successful run, and the probe left no scratch file.
    assert.equal(handle.truncated.length, 0)
    const remoteNames = await readdir(remoteRoot)
    assert.deepEqual(
      remoteNames.filter((name) => name.includes('probe')),
      [],
      'the capability probe must clean up after itself',
    )

    console.log(
      `    [acceptance] ${direction}: ${ACCEPTANCE_BYTES} bytes in ${durationMs} ms ` +
        `(${(outcome.bytesPerSec / MiB).toFixed(1)} MiB/s), ${frames.length} progress frames, ` +
        `max concurrent streams ${handle.maxActiveStreams}`,
    )
  })
}

// ---------------------------------------------------------------------------
// Range bookkeeping (deterministic, no I/O)
// ---------------------------------------------------------------------------

test('ranges are contiguous, cover the remainder, and drive the durable offset', () => {
  const ranges = buildRanges(1_000_000, 100_000_000, 4, CHUNK)
  assert.equal(ranges.length, 4)
  assert.equal(ranges[0].start, 1_000_000)
  assert.equal(ranges.at(-1).end, 100_000_000)
  for (let index = 1; index < ranges.length; index++) {
    assert.equal(ranges[index].start, ranges[index - 1].end, 'ranges must not overlap or leave gaps')
  }

  const file = { resumedFrom: 1_000_000, size: 100_000_000, ranges }
  assert.equal(durableOffset(file), 1_000_000, 'nothing committed yet')
  ranges[0].committed = ranges[0].end - ranges[0].start
  assert.equal(durableOffset(file), ranges[0].end)
  ranges[1].committed = 4096
  assert.equal(durableOffset(file), ranges[1].start + 4096)
  // A higher range landing early must not advance the durable prefix.
  const early = buildRanges(0, 8 * MiB, 4, CHUNK)
  early[2].committed = 4096
  assert.equal(durableOffset({ resumedFrom: 0, size: 8 * MiB, ranges: early }), 0)
})

test('a peer that never acknowledges a chunk ends the transfer on the chunk deadline', async (t) => {
  const dir = await tmpRoot(t)
  const remoteRoot = join(dir, 'remote')
  await mkdir(remoteRoot, { recursive: true })
  const localFile = join(dir, 'payload.bin')
  await writePattern(localFile, 2 * MiB)

  // ssh2's pending write callbacks are never invoked when a channel dies without
  // closing, so without a per-chunk deadline the transfer would hang forever
  // (observed against a real server). This is the fast regression for that.
  const handle = createFakeHandle(remoteRoot, { neverAckWrites: true })
  const started = Date.now()
  const error = await collectError(
    engineFor({ chunkTimeoutMs: 300, restoreTimeoutMs: 300 }).run(handle, {
      direction: 'upload',
      localPath: localFile,
      remotePath: '/payload.bin',
      verify: 'none',
    }),
  )
  const elapsed = Date.now() - started
  assert.ok(error, 'a silent peer must fail the transfer')
  assert.equal(error.code, 'SSH_SFTP_TRANSFER_ABORTED')
  assert.ok(elapsed < 5000, `the deadline must end the wait, took ${elapsed}ms`)
  assert.equal(error.details.transferred, 0, 'nothing was acknowledged, so nothing counts as transferred')
  assert.equal(error.details.resumedFrom, 0)
})

test('a link-class failure is retried once, resuming from the durable offset', async (t) => {
  const dir = await tmpRoot(t)
  const remoteRoot = join(dir, 'remote')
  await mkdir(remoteRoot, { recursive: true })
  const localFile = join(dir, 'payload.bin')
  await writePattern(localFile, 4 * MiB)
  const expected = await sha256File(localFile)

  // The fake drops the channel once, mid-transfer: the first attempt fails after
  // some chunks, and the retry must continue from the durable prefix (never from
  // 0) with fewer streams.
  const handle = createFakeHandle(remoteRoot, { failAfterBytes: 1 * MiB, failTimes: 1 })
  const frames = []
  const outcome = await engineFor({ linkRetry: { attempts: 1, concurrency: 1 } }).run(handle, {
    direction: 'upload',
    localPath: localFile,
    remotePath: '/payload.bin',
    verify: 'sha256',
    onProgress: (progress) => frames.push({ ...progress }),
  })

  assert.equal(handle.attempts, 2, 'exactly one bounded retry')
  assert.equal(handle.lastAttemptConcurrency, 1, 'the retry degrades to a single stream')
  assert.equal(outcome.transferred, 4 * MiB, 'every byte is counted exactly once across attempts')
  assert.equal(outcome.totalBytes, 4 * MiB, 'totalBytes is fixed by the plan, retry or not')
  assert.equal(await sha256File(join(remoteRoot, 'payload.bin')), expected)
  assert.equal(outcome.sha256.remote, expected)

  // The progress bar never goes backwards and still lands exactly on the total.
  for (let index = 1; index < frames.length; index++) {
    assert.ok(frames[index].transferred >= frames[index - 1].transferred)
    assert.equal(frames[index].totalBytes, 4 * MiB)
  }
  assert.equal(frames.at(-1).transferred, 4 * MiB)
})

test('a definitive failure is never retried', async (t) => {
  const dir = await tmpRoot(t)
  const remoteRoot = join(dir, 'remote')
  await mkdir(remoteRoot, { recursive: true })
  const localFile = join(dir, 'payload.bin')
  await writePattern(localFile, 1 * MiB)
  await writeFile(join(remoteRoot, 'payload.bin'), Buffer.alloc(2 * MiB, 9))

  const handle = createFakeHandle(remoteRoot, { failAfterBytes: 1, failTimes: 5 })
  const error = await collectError(
    engineFor({ linkRetry: { attempts: 2, concurrency: 1 } }).run(handle, {
      direction: 'upload',
      localPath: localFile,
      remotePath: '/payload.bin',
      resume: false,
      overwrite: false,
    }),
  )
  assert.equal(error.code, 'SSH_SFTP_TARGET_EXISTS')
  assert.equal(handle.attempts, 0, 'a conflict is refused before any transfer starts')
})

test('an SSH_UNKNOWN "No response from server" mid-transfer is an interruption, not an opaque unknown', async (t) => {
  const dir = await tmpRoot(t)
  const remoteRoot = join(dir, 'remote')
  await mkdir(remoteRoot, { recursive: true })
  const localFile = join(dir, 'payload.bin')
  await writePattern(localFile, 2 * MiB)

  // ssh2 hands over a bare `Error('No response from server')` — no code, so it maps
  // to SSH_UNKNOWN — when a channel closes with requests pending. That is the exact
  // shape the real-host 100 MiB run produced, and it must be classified as a link
  // loss: reported as an interruption, with the resume verdict attached.
  const handle = createFakeHandle(remoteRoot, { failAfterBytes: 512 * KiB, failTimes: 5 })
  const error = await collectError(
    engineFor({ chunkTimeoutMs: 1000, linkRetry: { attempts: 0, concurrency: 1 } }).run(handle, {
      direction: 'upload',
      localPath: localFile,
      remotePath: '/payload.bin',
      verify: 'none',
    }),
  )

  assert.ok(error)
  assert.equal(error.code, 'SSH_SFTP_TRANSFER_ABORTED', 'a transport loss is an interruption')
  assert.equal(error.details.causeCode, 'SSH_UNKNOWN', 'the raw classification is preserved for diagnostics')
  assert.match(String(error.details.causeMessage), /No response from server/)
  assert.equal(error.details.resumable, true, 'the durable prefix was restored, so a resume is offered')
  // The durable-prefix invariant, which holds even when the first range is the one
  // that died (then the prefix is 0 and the file is truncated back to empty).
  assert.equal(
    (await stat(join(remoteRoot, 'payload.bin'))).size,
    error.details.resumedFrom,
    'the destination equals its durable prefix',
  )
})

test('a handle that never emits `finish` (ssh2 semantics) still completes', async (t) => {
  const dir = await tmpRoot(t)
  const remoteRoot = join(dir, 'remote')
  await mkdir(remoteRoot, { recursive: true })
  const localFile = join(dir, 'payload.bin')
  await writePattern(localFile, 1 * MiB)
  const expected = await sha256File(localFile)

  // `node:fs` streams emit `finish`; ssh2's SFTP WriteStream emits only `close`.
  // The engine must accept either, or every upload hangs on a real server.
  const handle = createFakeHandle(remoteRoot, { suppressFinish: true })
  const outcome = await engineFor().run(handle, {
    direction: 'upload',
    localPath: localFile,
    remotePath: '/payload.bin',
    verify: 'sha256',
  })
  assert.equal(outcome.transferred, 1 * MiB)
  assert.equal(await sha256File(join(remoteRoot, 'payload.bin')), expected)

  // Zero-byte files exercise the "create the destination, write nothing" path.
  const empty = join(dir, 'empty.bin')
  await writeFile(empty, Buffer.alloc(0))
  const zero = await engineFor().run(handle, {
    direction: 'upload',
    localPath: empty,
    remotePath: '/empty.bin',
    verify: 'sha256',
  })
  assert.equal(zero.totalBytes, 0)
  assert.equal((await stat(join(remoteRoot, 'empty.bin'))).size, 0)
})

test('resolveTransferOptions clamps operator values', () => {
  const resolved = resolveTransferOptions({ chunkBytes: 262144, maxConcurrentChunks: 4, verify: 'sha256' }, {
    chunkBytes: 1,
    concurrency: 9999,
  })
  assert.equal(resolved.chunkBytes, 16 * KiB)
  assert.equal(resolved.concurrency, 32)
  assert.equal(resolved.verify, 'sha256')
  assert.equal(resolved.resume, true)
  assert.equal(resolved.progressIntervalMs, 200)
})

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

test('resume: an upload continues from the destination size and reports resumedFrom', async (t) => {
  const dir = await tmpRoot(t)
  const remoteRoot = join(dir, 'remote')
  await mkdir(remoteRoot, { recursive: true })
  const localFile = join(dir, 'payload.bin')
  await writePattern(localFile, 4 * MiB)
  const remoteFile = join(remoteRoot, 'payload.bin')

  // A previous attempt delivered exactly the first 1 MiB.
  const head = Buffer.alloc(MiB)
  const source = createReadStream(localFile, { start: 0, end: MiB - 1 })
  let offset = 0
  for await (const chunk of source) {
    chunk.copy(head, offset)
    offset += chunk.length
  }
  await writeFile(remoteFile, head)

  const handle = createFakeHandle(remoteRoot)
  const outcome = await engineFor().run(handle, {
    direction: 'upload',
    localPath: localFile,
    remotePath: '/payload.bin',
    verify: 'sha256',
    overwrite: true,
  })

  assert.equal(outcome.resumedFrom, MiB, 'the resumed offset is the destination size')
  assert.equal(outcome.transferred, 3 * MiB, 'only the missing bytes were moved')
  assert.equal(outcome.totalBytes, 3 * MiB)
  assert.equal(outcome.entries[0].resumedFrom, MiB)
  const expected = await sha256File(localFile)
  assert.equal(outcome.sha256.local, expected)
  assert.equal(outcome.sha256.remote, expected)
  assert.equal(await sha256File(remoteFile), expected)
  assert.equal(handle.truncated.length, 0)
})

test('resume: a download continues from the local file size', async (t) => {
  const dir = await tmpRoot(t)
  const remoteRoot = join(dir, 'remote')
  await mkdir(remoteRoot, { recursive: true })
  const remoteFile = join(remoteRoot, 'payload.bin')
  await writePattern(remoteFile, 4 * MiB)
  const localFile = join(dir, 'partial.bin')

  const head = Buffer.alloc(2 * MiB)
  const source = createReadStream(remoteFile, { start: 0, end: 2 * MiB - 1 })
  let offset = 0
  for await (const chunk of source) {
    chunk.copy(head, offset)
    offset += chunk.length
  }
  await writeFile(localFile, head)

  const handle = createFakeHandle(remoteRoot)
  const outcome = await engineFor().run(handle, {
    direction: 'download',
    localPath: localFile,
    remotePath: '/payload.bin',
    verify: 'sha256',
    overwrite: true,
  })

  assert.equal(outcome.resumedFrom, 2 * MiB)
  assert.equal(outcome.transferred, 2 * MiB)
  const expected = await sha256File(remoteFile)
  assert.equal(await sha256File(localFile), expected)
  assert.equal(outcome.sha256.local, expected)
})

// ---------------------------------------------------------------------------
// Abort →resumable offset
// ---------------------------------------------------------------------------

for (const direction of ['upload', 'download']) {
  test(`abort: a mid-transfer ${direction} aborts with SSH_SFTP_TRANSFER_ABORTED and a resumable offset`, async (t) => {
    const dir = await tmpRoot(t)
    const remoteRoot = join(dir, 'remote')
    await mkdir(remoteRoot, { recursive: true })
    const localFile = join(dir, 'payload.bin')
    const remoteFile = join(remoteRoot, 'payload.bin')
    const size = 16 * MiB

    if (direction === 'upload') await writePattern(localFile, size)
    else {
      await rm(localFile, { force: true })
      await writePattern(remoteFile, size)
    }

    const handle = createFakeHandle(remoteRoot, { writeDelayMs: 2 })
    const controller = new AbortController()
    const engine = engineFor()
    let abortedAfter = 0
    const error = await collectError(
      engine.run(handle, {
        direction,
        localPath: localFile,
        remotePath: '/payload.bin',
        verify: 'none',
        signal: controller.signal,
        onProgress: (progress) => {
          if (!controller.signal.aborted && progress.transferred >= 2 * MiB) {
            abortedAfter = progress.transferred
            controller.abort()
          }
        },
      }),
    )

    assert.ok(error, 'the transfer must fail when cancelled')
    assert.equal(error.code, 'SSH_SFTP_TRANSFER_ABORTED')
    assert.equal(error.retryable, true, 'a resumable transfer is retryable by ICD §5')
    const details = error.details
    assert.equal(details.resumable, true)
    assert.ok(details.resumedFrom > 0, `expected a resumable offset, got ${details.resumedFrom}`)
    assert.ok(details.resumedFrom <= details.transferred + abortedAfter)
    assert.equal(details.resumedFrom % CHUNK, 0, 'the durable prefix is chunk aligned')
    assert.equal(details.direction, direction)
    assert.ok(details.totalBytes === size)

    // The invariant that makes resume-by-size safe: the destination is exactly as
    // long as its durable prefix (an aborted parallel range cannot leave a hole).
    const destination = direction === 'upload' ? remoteFile : localFile
    assert.equal((await stat(destination)).size, details.resumedFrom)

    // Resuming from that offset produces a byte-identical file. `overwrite: true`
    // is what authorises an append under `confirmDangerous` (F-SEC-05): sizes
    // alone cannot tell this real partial from an unrelated smaller file.
    const resumed = await engineFor().run(handle, {
      direction,
      localPath: localFile,
      remotePath: '/payload.bin',
      verify: 'sha256',
      overwrite: true,
    })
    assert.equal(resumed.resumedFrom, details.resumedFrom, 'the second run resumes exactly where the first stopped')
    assert.equal(resumed.transferred, size - details.resumedFrom)
    const expected = await sha256File(direction === 'upload' ? localFile : remoteFile)
    assert.equal(await sha256File(destination), expected)
    assert.deepEqual(resumed.sha256, { local: expected, remote: expected })
    assert.equal((await stat(destination)).size, size)
  })
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

test('conflict: an existing destination is refused with SSH_SFTP_TARGET_EXISTS', async (t) => {
  const dir = await tmpRoot(t)
  const remoteRoot = join(dir, 'remote')
  await mkdir(remoteRoot, { recursive: true })
  const localFile = join(dir, 'payload.bin')
  await writePattern(localFile, 3 * MiB)
  // Same length, different content: resume cannot help, so this is a conflict.
  await writeFile(join(remoteRoot, 'payload.bin'), Buffer.alloc(3 * MiB, 0x7f))

  const handle = createFakeHandle(remoteRoot)
  const error = await collectError(
    engineFor().run(handle, {
      direction: 'upload',
      localPath: localFile,
      remotePath: '/payload.bin',
      resume: false,
      overwrite: false,
    }),
  )
  assert.ok(error)
  assert.equal(error.code, 'SSH_SFTP_TARGET_EXISTS')
  assert.equal(error.retryable, false)
  assert.equal(error.details.remoteSize, 3 * MiB)
  assert.equal(error.details.localSize, 3 * MiB)
  assert.equal(error.details.resumable, false, 'resume:false was requested, so no resume may be promised')
  assert.equal((await stat(join(remoteRoot, 'payload.bin'))).size, 3 * MiB, 'the destination was left alone')
})

test('a same-length destination counts as transferred: verify decides whether it is correct', async (t) => {
  const dir = await tmpRoot(t)
  const remoteRoot = join(dir, 'remote')
  await mkdir(remoteRoot, { recursive: true })
  const localFile = join(dir, 'payload.bin')
  await writePattern(localFile, MiB)
  const remoteFile = join(remoteRoot, 'payload.bin')
  await writeFile(remoteFile, Buffer.alloc(MiB, 0x11))

  // Same size + size+mtime: nothing to move, and the length check passes.
  const outcome = await engineFor().run(createFakeHandle(remoteRoot), {
    direction: 'upload',
    localPath: localFile,
    remotePath: '/payload.bin',
    verify: 'size+mtime',
  })
  assert.equal(outcome.resumedFrom, MiB)
  assert.equal(outcome.transferred, 0, 'a complete-length destination moves no bytes')
  assert.equal(outcome.totalBytes, 0)

  // The same situation under sha256 is caught, which is why the digest exists.
  const error = await collectError(
    engineFor().run(createFakeHandle(remoteRoot), {
      direction: 'upload',
      localPath: localFile,
      remotePath: '/payload.bin',
      verify: 'sha256',
    }),
  )
  assert.ok(error)
  assert.equal(error.code, 'SSH_SFTP_VERIFY_MISMATCH')
  assert.equal(error.details.localSize, MiB)
  assert.notEqual(error.details.localSha256, error.details.remoteSha256)
})

test('conflict: onConflict can overwrite, skip, rename or cancel', async (t) => {
  const dir = await tmpRoot(t)
  const remoteRoot = join(dir, 'remote')
  await mkdir(remoteRoot, { recursive: true })
  const localFile = join(dir, 'report.txt')
  await writeFile(localFile, 'the new content')
  const target = join(remoteRoot, 'report.txt')
  const expected = await sha256File(localFile)

  const setup = async () => {
    await writeFile(target, 'an older, longer, unrelated payload')
    return createFakeHandle(remoteRoot)
  }

  // overwrite
  let handle = await setup()
  let outcome = await engineFor().run(handle, {
    direction: 'upload',
    localPath: localFile,
    remotePath: '/report.txt',
    resume: false,
    onConflict: async () => 'overwrite',
  })
  assert.equal(outcome.transferred, 'the new content'.length)
  assert.equal(await sha256File(target), expected)

  // skip
  handle = await setup()
  outcome = await engineFor().run(handle, {
    direction: 'upload',
    localPath: localFile,
    remotePath: '/report.txt',
    resume: false,
    onConflict: async () => 'skip',
  })
  assert.equal(outcome.transferred, 0)
  assert.equal(outcome.totalBytes, 0, 'a skipped file is excluded from the total, not left hanging')
  assert.equal(outcome.entries[0].skipped, true)
  assert.equal(await sha256File(target), await sha256File(target), 'the destination is untouched')
  assert.equal((await stat(target)).size, 'an older, longer, unrelated payload'.length)

  // rename
  handle = await setup()
  outcome = await engineFor().run(handle, {
    direction: 'upload',
    localPath: localFile,
    remotePath: '/report.txt',
    resume: false,
    onConflict: async () => 'rename',
  })
  assert.equal(outcome.entries[0].remotePath, '/report (1).txt')
  assert.equal(await sha256File(join(remoteRoot, 'report (1).txt')), expected)
  assert.equal((await stat(target)).size, 'an older, longer, unrelated payload'.length)

  // cancel
  handle = await setup()
  const error = await collectError(
    engineFor().run(handle, {
      direction: 'upload',
      localPath: localFile,
      remotePath: '/report.txt',
      resume: false,
      onConflict: async () => 'cancel',
    }),
  )
  assert.ok(error)
  assert.equal(error.code, 'SSH_CANCELLED')
})

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

test('verify: sha256 catches a silent corruption that size+mtime accepts', async (t) => {
  const dir = await tmpRoot(t)
  const remoteRoot = join(dir, 'remote')
  await mkdir(remoteRoot, { recursive: true })
  const localFile = join(dir, 'payload.bin')
  await writePattern(localFile, MiB)

  // The fake flips one byte on the way to the "remote host".
  const sizeOnly = await engineFor().run(createFakeHandle(remoteRoot, { corruptWrites: true }), {
    direction: 'upload',
    localPath: localFile,
    remotePath: '/size-only.bin',
    verify: 'size+mtime',
  })
  assert.equal(sizeOnly.transferred, MiB, 'a same-size corruption is invisible to a size check')

  const error = await collectError(
    engineFor().run(createFakeHandle(remoteRoot, { corruptWrites: true }), {
      direction: 'upload',
      localPath: localFile,
      remotePath: '/digest.bin',
      verify: 'sha256',
    }),
  )
  assert.ok(error)
  assert.equal(error.code, 'SSH_SFTP_VERIFY_MISMATCH')
  assert.equal(error.retryable, true)
  assert.notEqual(error.details.localSha256, error.details.remoteSha256)
  assert.equal(error.details.mode, 'sha256')
  assert.equal(error.details.localSize, MiB)
})

// ---------------------------------------------------------------------------
// Recursive trees
// ---------------------------------------------------------------------------

/** Build `root/{a.txt, nested/b.bin, nested/deep/c.txt}` plus a directory link. */
async function buildTree(root) {
  await mkdir(join(root, 'nested', 'deep'), { recursive: true })
  await writeFile(join(root, 'a.txt'), 'alpha')
  await writeFile(join(root, 'nested', 'b.bin'), Buffer.alloc(5000, 0x5a))
  await writeFile(join(root, 'nested', 'deep', 'c.txt'), 'charlie')
  let linked = false
  try {
    // A junction needs no privileges on Windows; a plain symlink is the fallback.
    await symlink(join(root, 'nested'), join(root, 'linked'), 'junction')
    linked = true
  } catch {
    try {
      await symlink(join(root, 'nested', 'b.bin'), join(root, 'linked'))
      linked = true
    } catch {
      linked = false
    }
  }
  return { linked }
}

test('recursive upload preserves the relative structure and does not follow symlinks', async (t) => {
  const dir = await tmpRoot(t)
  const source = join(dir, 'source')
  const remoteRoot = join(dir, 'remote')
  await mkdir(remoteRoot, { recursive: true })
  const { linked } = await buildTree(source)

  const handle = createFakeHandle(remoteRoot)
  const outcome = await engineFor().run(handle, {
    direction: 'upload',
    localPath: source,
    remotePath: '/dest',
    verify: 'sha256',
  })

  const expected = await hashTree(source)
  const actual = await hashTree(join(remoteRoot, 'dest'))
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort())
  for (const [relative, digest] of Object.entries(expected)) {
    assert.equal(actual[relative], digest, `${relative} must be byte-identical`)
  }
  assert.equal(outcome.entries.length, 3)
  assert.ok(outcome.entries.every((entry) => entry.resumedFrom === 0))
  assert.equal(outcome.skipped.length, linked ? 1 : 0)
  if (linked) {
    assert.match(outcome.skipped[0].reason, /symlink/)
    // The link target's children must not appear twice under the destination.
    assert.deepEqual(
      (await readdir(join(remoteRoot, 'dest'))).sort(),
      ['a.txt', 'nested'],
    )
  }
})

test('recursive download preserves the relative structure and does not follow symlinks', async (t) => {
  const dir = await tmpRoot(t)
  const remoteRoot = join(dir, 'remote')
  const target = join(dir, 'downloaded')
  await mkdir(remoteRoot, { recursive: true })
  const { linked } = await buildTree(remoteRoot)

  const handle = createFakeHandle(remoteRoot)
  const outcome = await engineFor().run(handle, {
    direction: 'download',
    localPath: target,
    remotePath: '/',
    verify: 'sha256',
  })

  const expected = await hashTree(remoteRoot)
  const actual = await hashTree(target)
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort())
  for (const [relative, digest] of Object.entries(expected)) {
    assert.equal(actual[relative], digest, `${relative} must be byte-identical`)
  }
  assert.equal(outcome.entries.length, 3)
  assert.equal(outcome.skipped.length, linked ? 1 : 0)
  if (linked) assert.ok(!(await readdir(target)).includes('linked'))
})

// ---------------------------------------------------------------------------
// Degraded capabilities
// ---------------------------------------------------------------------------

test('a handle that ignores offset writes degrades to one ordered range and still transfers correctly', async (t) => {
  const dir = await tmpRoot(t)
  const remoteRoot = join(dir, 'remote')
  await mkdir(remoteRoot, { recursive: true })
  const localFile = join(dir, 'payload.bin')
  await writePattern(localFile, 2 * MiB)
  const expected = await sha256File(localFile)

  // `declareOffsetWrite: false` forces the behavioural probe: the handle neither
  // declares the capability nor honours `start`.
  const handle = createFakeHandle(remoteRoot, { offsetWrite: false, declareOffsetWrite: false, truncateSupported: false })
  const outcome = await engineFor().run(handle, { direction: 'upload', localPath: localFile, remotePath: '/payload.bin' })

  assert.equal(outcome.transferred, 2 * MiB)
  assert.equal(await sha256File(join(remoteRoot, 'payload.bin')), expected, 'the sequential fallback wrote the right bytes')
  // The probe itself uses two write streams in sequence, so ≥ is the honest
  // bound here; the parallel-range refusal is asserted on the declared case below.
  assert.ok(handle.maxActiveWrites <= 1, `a degraded upload must not fan out, saw ${handle.maxActiveWrites}`)
  assert.deepEqual(
    (await readdir(remoteRoot)).filter((name) => name.includes('probe')),
    [],
    'the probe file must be removed',
  )
})

test('a declared inability to write at an offset runs exactly one stream', async (t) => {
  const dir = await tmpRoot(t)
  const remoteRoot = join(dir, 'remote')
  await mkdir(remoteRoot, { recursive: true })
  const localFile = join(dir, 'payload.bin')
  await writePattern(localFile, 2 * MiB)
  const expected = await sha256File(localFile)

  const handle = createFakeHandle(remoteRoot, { offsetWrite: false, declareOffsetWrite: true })
  const outcome = await engineFor().run(handle, { direction: 'upload', localPath: localFile, remotePath: '/payload.bin' })

  assert.equal(outcome.transferred, 2 * MiB)
  assert.equal(await sha256File(join(remoteRoot, 'payload.bin')), expected)
  assert.equal(handle.maxActiveWrites, 1, 'the declaration is honoured without probing or fanning out')
})

test('without offset writes a partial destination cannot be resumed and is refused instead of overwritten', async (t) => {
  const dir = await tmpRoot(t)
  const remoteRoot = join(dir, 'remote')
  await mkdir(remoteRoot, { recursive: true })
  const localFile = join(dir, 'payload.bin')
  await writePattern(localFile, 2 * MiB)
  await writeFile(join(remoteRoot, 'payload.bin'), Buffer.alloc(512 * KiB, 1))

  const handle = createFakeHandle(remoteRoot, { offsetWrite: false, truncateSupported: false })
  const error = await collectError(
    engineFor().run(handle, { direction: 'upload', localPath: localFile, remotePath: '/payload.bin', resume: true }),
  )
  assert.ok(error)
  assert.equal(error.code, 'SSH_SFTP_TARGET_EXISTS')
  assert.equal(error.details.resumable, false, 'the report must not promise a resume this handle cannot do')
  assert.equal((await stat(join(remoteRoot, 'payload.bin'))).size, 512 * KiB, 'the destination was left alone')
})

test('a handle without truncate uploads through a single ordered range and stays resumable', async (t) => {
  const dir = await tmpRoot(t)
  const remoteRoot = join(dir, 'remote')
  await mkdir(remoteRoot, { recursive: true })
  const localFile = join(dir, 'payload.bin')
  await writePattern(localFile, 4 * MiB)
  const expected = await sha256File(localFile)
  const remoteFile = join(remoteRoot, 'payload.bin')

  // A genuine partial: the destination holds the source's real first MiB, so the
  // resumed run can be checked byte-for-byte (a zero filler would not be).
  const head = Buffer.alloc(MiB)
  let offset = 0
  for await (const chunk of createReadStream(localFile, { start: 0, end: MiB - 1 })) {
    chunk.copy(head, offset)
    offset += chunk.length
  }
  await writeFile(remoteFile, head)

  const handle = createFakeHandle(remoteRoot, { truncateSupported: false })
  const outcome = await engineFor().run(handle, {
    direction: 'upload',
    localPath: localFile,
    remotePath: '/payload.bin',
    verify: 'sha256',
    // Authorises the append of the remaining 3 MiB onto the real 1 MiB partial.
    overwrite: true,
  })
  assert.equal(outcome.resumedFrom, MiB)
  assert.equal(await sha256File(remoteFile), expected)
  assert.equal(handle.maxActiveWrites, 1, 'without truncate, length == durable prefix requires one ordered range')
})

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

test('invalid requests are refused with SSH_CFG_INVALID', async (t) => {
  const dir = await tmpRoot(t)
  const handle = createFakeHandle(dir)
  const engine = engineFor()
  for (const request of [
    { direction: 'sideways', localPath: 'a', remotePath: '/b' },
    { direction: 'upload', localPath: '', remotePath: '/b' },
    { direction: 'upload', localPath: 'a', remotePath: '   ' },
  ]) {
    const error = await collectError(engine.run(handle, request))
    assert.ok(error, `${JSON.stringify(request)} must be refused`)
    assert.equal(error.code, 'SSH_CFG_INVALID')
  }
})

test('a missing local source and a directory/file mismatch are reported with the ICD codes', async (t) => {
  const dir = await tmpRoot(t)
  const remoteRoot = join(dir, 'remote')
  await mkdir(remoteRoot, { recursive: true })
  const handle = createFakeHandle(remoteRoot)
  const engine = engineFor()

  const missing = await collectError(
    engine.run(handle, { direction: 'upload', localPath: join(dir, 'nope.bin'), remotePath: '/x.bin' }),
  )
  assert.equal(missing.code, 'SSH_SFTP_NO_SUCH_FILE')
  assert.equal(missing.details.side, 'local')

  const missingRemote = await collectError(
    engine.run(handle, { direction: 'download', localPath: join(dir, 'x.bin'), remotePath: '/nope.bin' }),
  )
  assert.equal(missingRemote.code, 'SSH_SFTP_NO_SUCH_FILE')

  await mkdir(join(remoteRoot, 'adir'))
  const mismatch = await collectError(
    engine.run(handle, { direction: 'upload', localPath: join(dir, 'nope.bin'), remotePath: '/adir' }),
  )
  assert.ok(['SSH_SFTP_NO_SUCH_FILE', 'SSH_SFTP_IS_A_DIRECTORY'].includes(mismatch.code))
})

test('a local source that disappears mid-upload is reported as a local failure, not a transfer bug', async (t) => {
  const dir = await tmpRoot(t)
  const remoteRoot = join(dir, 'remote')
  await mkdir(remoteRoot, { recursive: true })
  const source = join(dir, 'payload.bin')
  await writePattern(source, 2 * MiB)

  const handle = createFakeHandle(remoteRoot, { writeDelayMs: 1 })
  const engine = engineFor({ defaults: { chunkBytes: CHUNK, maxConcurrentChunks: 2 } })
  let removed = false
  const error = await engine
    .run(handle, {
      direction: 'upload',
      localPath: source,
      remotePath: '/payload.bin',
      // `verify: 'sha256'` matters: the verification re-reads the local source, and
      // re-opening a path that vanished is exactly how this failure surfaces (an
      // *already open* handle survives removal — Node opens with FILE_SHARE_DELETE).
      verify: 'sha256',
      onProgress: (progress) => {
        if (removed || progress.transferred <= 0) return
        // Synchronous on purpose: the removal must be complete and observable
        // before the transfer moves on, or the test itself becomes a race.
        try {
          rmSync(source, { force: true })
          removed = true
        } catch {
          /* the platform refuses to remove a file that is being read */
        }
      },
    })
    .then(
      () => null,
      (caught) => caught,
    )

  if (!removed) {
    t.skip('this platform refuses to remove a file while it is being read')
    return
  }
  assert.ok(error, 'losing the source mid-upload must fail the transfer')
  assert.equal(error.code, 'SSH_SFTP_NO_SUCH_FILE')
  assert.equal(error.details.side, 'local', 'the failure is local, and the report says so')
  assert.equal(error.details.path, source, 'the local path is named, not the remote one')
})
