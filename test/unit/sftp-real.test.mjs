/**
 * Real-host SFTP acceptance test — **opt-in**, and skipped by default.
 *
 * The user's acceptance criterion for this module is a 100 MiB upload and
 * download over SSH with a correct progress bar and matching checksums. The
 * filesystem-backed suite proves the engine's logic; this file proves the whole
 * stack against a real OpenSSH server over a real network, which is where the
 * failure modes live that no fake reproduces (a channel that dies mid-read, a
 * server that stops answering, a latency that changes what "concurrency" costs).
 *
 * How it is enabled, and the rules it follows:
 *
 *  - `DSH_SSH_TEST_REAL_HOST` / `_PORT` / `_USER` / `_PASSWORD` (or
 *    `DSH_SSH_ROOT_PASSWORD`) must be set. Without them every test **skips with
 *    an explicit reason** — they never fall back to a live host, and never
 *    silently pass.
 *  - The password is read from the environment only: never written to a file,
 *    never logged, never embedded in a fixture.
 *  - Every write stays inside `/tmp/dsh-ssh-test/<run id>/`, which is removed in
 *    `after()` **on the failure path too** (with its own connection, so a broken
 *    transfer connection cannot leave 100 MiB behind). Stale trees from earlier
 *    runs are swept at start-up — **remote only, and only when older than 120 min**.
 *  - Local scratch directories are removed by the run that created them, and by
 *    nothing else. There is deliberately **no local prefix-glob reaping**: a
 *    still-running transfer looks exactly like a stale directory to another
 *    process, and reaping by pattern is how a real-host run was once corrupted
 *    mid-upload (the payload vanished under a 28-second upload and surfaced as a
 *    confusing local ENOENT). Each run drops a `.dsh-run-active` marker so a human
 *    or another agent can tell a live run from a leftover one first.
 *  - Each phase is timed and logged, so a failure names its stage instead of
 *    surfacing as a bare transport error somewhere in a 200-second run.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, statSync } from 'node:fs'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { Client } from 'ssh2'

import { createSftpHandle } from '../../lib/sftp/adapter.js'
import { SftpClient } from '../../lib/sftp/client.js'
import { TransferEngine } from '../../lib/sftp/transfer.js'

const MiB = 1024 * 1024
const CHUNK = 256 * 1024
const ACCEPTANCE_BYTES = 100 * MiB
/**
 * Debug knobs, for bisecting a real-host failure without editing this file:
 * `DSH_SSH_TEST_REAL_BYTES` shrinks the payload, `DSH_SSH_TEST_REAL_CONCURRENCY`
 * pins the range concurrency (e.g. 1 to test the "is 4-way safe on this link?"
 * question directly). Both default to the acceptance configuration.
 */
const TRANSFER_BYTES = Number(process.env.DSH_SSH_TEST_REAL_BYTES ?? ACCEPTANCE_BYTES)
const CONCURRENCY = Number(process.env.DSH_SSH_TEST_REAL_CONCURRENCY ?? 4)
/** The only remote tree this suite is allowed to touch. */
const REMOTE_ROOT = '/tmp/dsh-ssh-test'
/** A tree older than this cannot belong to a live run (R9 allows one suite at a time). */
const STALE_AFTER_MINUTES = 120

const HOST = process.env.DSH_SSH_TEST_REAL_HOST
const PORT = Number(process.env.DSH_SSH_TEST_REAL_PORT ?? '22')
const USER = process.env.DSH_SSH_TEST_REAL_USER
const PASSWORD = process.env.DSH_SSH_TEST_REAL_PASSWORD ?? process.env.DSH_SSH_ROOT_PASSWORD
const CONFIGURED = Boolean(HOST && USER && PASSWORD)
const SKIP_REASON = CONFIGURED
  ? false
  : 'real-host acceptance is opt-in: set DSH_SSH_TEST_REAL_HOST, DSH_SSH_TEST_REAL_PORT, ' +
    'DSH_SSH_TEST_REAL_USER and DSH_SSH_TEST_REAL_PASSWORD (or DSH_SSH_ROOT_PASSWORD) to run it. ' +
    'Debug knobs: DSH_SSH_TEST_REAL_BYTES (payload size, default 100 MiB), ' +
    'DSH_SSH_TEST_REAL_CONCURRENCY (range concurrency, default 4)'

const t0 = Date.now()
function log(message) {
  console.log(`    [${String(Date.now() - t0).padStart(6)}ms] ${message}`)
}

function formatBytes(bytes) {
  return bytes >= MiB ? `${(bytes / MiB).toFixed(1)} MiB` : `${(bytes / 1024).toFixed(0)} KiB`
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * Stage instrumentation: every phase is timed, so a failure says *where* it
 * happened and what the earlier phases cost.
 */
class StageLog {
  constructor(label) {
    this.label = label
    this.entries = []
  }

  async run(name, fn, bytes = 0) {
    const started = Date.now()
    try {
      const value = await fn()
      this.entries.push({ name, ms: Date.now() - started, bytes, ok: true })
      return value
    } catch (error) {
      this.entries.push({ name, ms: Date.now() - started, bytes, ok: false, error })
      error.stage = `${this.label}/${name}`
      throw error
    }
  }

  /** Print the table; called from `after()` so it appears on failure as well. */
  report() {
    log(`--- ${this.label} ---`)
    for (const entry of this.entries) {
      const rate = entry.bytes > 0 && entry.ms > 0 ? ` · ${(entry.bytes / MiB / (entry.ms / 1000)).toFixed(1)} MiB/s` : ''
      const bytes = entry.bytes > 0 ? ` · ${formatBytes(entry.bytes)}` : ''
      log(
        `  ${entry.ok ? 'ok  ' : 'FAIL'} ${entry.name.padEnd(26)} ${String(entry.ms).padStart(7)} ms${bytes}${rate}` +
          (entry.ok ? '' : ` — ${entry.error?.code ?? ''} ${entry.error?.message ?? ''}`),
      )
    }
    const failed = this.entries.filter((entry) => !entry.ok)
    if (failed.length > 0) log(`  first failure: ${failed[0].name} (${failed[0].error?.message ?? ''})`)
  }
}

async function runRemote(client, command) {
  return await new Promise((resolve, reject) => {
    client.exec(command, (error, channel) => {
      if (error) {
        reject(error)
        return
      }
      let stdout = ''
      let stderr = ''
      channel.on('data', (chunk) => {
        stdout += chunk.toString('utf8')
      })
      channel.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8')
      })
      channel.on('close', (code) => {
        if (code === 0) resolve(stdout)
        else reject(new Error(`remote command exited ${code}: ${stderr.trim() || stdout.trim()}`))
      })
    })
  })
}

async function connect() {
  const client = new Client()
  await new Promise((resolve, reject) => {
    client.once('ready', resolve).once('error', reject)
    client.connect({
      host: HOST,
      port: PORT,
      username: USER,
      password: PASSWORD,
      // This test only ever runs against the operator-provided test host, named by
      // environment variables; known_hosts policy is exercised elsewhere.
      hostVerifier: () => true,
      readyTimeout: 20_000,
    })
  })
  const sftp = await new Promise((resolve, reject) => {
    client.sftp((error, wrapper) => (error ? reject(error) : resolve(wrapper)))
  })
  return { client, sftp }
}

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** Position-dependent 256 KiB blocks, so a misplaced chunk cannot pass. */
async function writePattern(path, bytes, block = CHUNK) {
  const stream = createWriteStream(path)
  for (let written = 0, index = 0; written < bytes; index++, written += block) {
    const length = Math.min(block, bytes - written)
    const buffer = Buffer.alloc(length, (index * 41) & 0xff)
    buffer.writeUInt32BE(index >>> 0, 0)
    if (!stream.write(buffer)) await once(stream, 'drain')
  }
  await new Promise((resolve, reject) => {
    stream.once('error', reject)
    stream.end(resolve)
  })
}

/**
 * Mark a run's local scratch directory as in use.
 *
 * Not decoration: another process cleaning `%TEMP%` by pattern cannot tell a live
 * transfer from a leftover directory, and deleting one mid-upload is
 * indistinguishable from a transfer bug (it happened once: a 28-second upload died
 * with a local ENOENT because its scratch directory was reaped underneath it).
 */
async function markRunActive(localDir) {
  await writeFile(
    join(localDir, '.dsh-run-active'),
    `pid ${process.pid} since ${new Date().toISOString()}\n`,
  ).catch(() => undefined)
}

/** Remove this run's own scratch directory — and only that one. */
async function clearLocalScratch(localDir) {
  await rm(localDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
}

/**
 * Integrity of the upload source, sampled *during* the transfer.
 *
 * The engine reads the source lazily, one chunk per range, so a source that is
 * removed or replaced mid-upload fails as a plain `ENOENT` after tens of seconds —
 * a symptom that reads like a transfer bug. Sampling on every progress frame turns
 * it into a precise statement ("the payload vanished after N bytes"), which is the
 * difference between a five-minute diagnosis and an hour of guessing.
 */
function sourceGuard(path, expectedBytes, ino) {
  let problem = null
  return {
    check(transferred) {
      if (problem !== null) return
      try {
        const stats = statSync(path)
        if (stats.size !== expectedBytes) problem = `size changed to ${stats.size} after ${transferred} bytes`
        else if (stats.ino !== ino) problem = `replaced (inode changed) after ${transferred} bytes`
      } catch (error) {
        problem = `vanished (${error.code}) after ${transferred} bytes`
      }
    },
    get problem() {
      return problem
    },
  }
}

/**
 * Remove one remote tree and **prove** it is gone.
 *
 * Uses a fresh connection on purpose: the transfer's own connection may be the
 * thing that broke, and a cleanup that depends on it is what leaves 100 MiB
 * behind (observed: two failed runs left 201 MiB on the target).
 */
async function cleanupRemote(remoteDir, stages) {
  const started = Date.now()
  try {
    const { client } = await connect()
    try {
      await runRemote(client, `rm -rf ${shellQuote(remoteDir)}`)
      const present = await runRemote(client, `test -e ${shellQuote(remoteDir)} && echo PRESENT || echo ABSENT`)
      assert.match(present, /ABSENT/, `remote cleanup left ${remoteDir} behind`)
    } finally {
      client.end()
    }
    stages?.entries.push({ name: 'cleanup (remote)', ms: Date.now() - started, bytes: 0, ok: true })
    log(`cleanup: removed ${remoteDir}`)
  } catch (error) {
    stages?.entries.push({ name: 'cleanup (remote)', ms: Date.now() - started, bytes: 0, ok: false, error })
    log(`cleanup FAILED for ${remoteDir}: ${error.message}`)
    throw error
  }
}

/** Drop trees from interrupted runs so repeated 100 MiB attempts cannot pile up. */
async function sweepStaleTrees(client) {
  await runRemote(client, `mkdir -p ${shellQuote(REMOTE_ROOT)}`)
  const removed = await runRemote(
    client,
    `find ${shellQuote(REMOTE_ROOT)} -mindepth 1 -maxdepth 1 -type d -mmin +${STALE_AFTER_MINUTES} -print -exec rm -rf {} + | wc -l`,
  )
  const count = Number.parseInt(removed.trim(), 10)
  if (Number.isFinite(count) && count > 0) log(`swept ${count} stale tree(s) older than ${STALE_AFTER_MINUTES} min`)
  const size = await runRemote(client, `du -sh ${shellQuote(REMOTE_ROOT)} 2>/dev/null | cut -f1`).catch(() => '?')
  log(`${REMOTE_ROOT} now holds ${size.trim()}`)
}

/** Assert the progress invariants the UI depends on, and log the numbers. */
function inspectFrames(frames, totalBytes, label) {
  assert.ok(frames.length >= 3, `${label}: expected progress frames, saw ${frames.length}`)
  assert.equal(frames[0].transferred, 0, `${label}: the first frame starts at 0`)
  for (let index = 1; index < frames.length; index++) {
    assert.ok(frames[index].transferred >= frames[index - 1].transferred, `${label}: progress went backwards at ${index}`)
  }
  assert.equal(frames.at(-1).transferred, totalBytes, `${label}: the last frame must reach the total`)
  assert.equal(frames.at(-1).totalBytes, totalBytes)
  assert.ok(frames.some((frame) => frame.phase === 'transfer'), `${label}: a transfer phase must be reported`)
  assert.ok(frames.some((frame) => frame.phase === 'verify'), `${label}: a verify phase must be reported`)
  log(`${label}: ${frames.length} progress frames, phases ${[...new Set(frames.map((frame) => frame.phase))].join('/')}`)
}

test('real host: 100 MiB upload/download round trip with matching checksums', { skip: SKIP_REASON }, async (t) => {
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const remoteDir = `${REMOTE_ROOT}/${runId}`
  const stages = new StageLog('100 MiB round trip')

  const { client, sftp } = await connect()
  // The local scratch directory is created only once the connection is up: an
  // unreachable host must not leave an empty tempdir behind when the run aborts.
  // The prefix is unique to this test and is deliberately *not* a prefix of the
  // other tests' directories, so no prefix-based cleanup can ever confuse them.
  const localDir = await mkdtemp(join(tmpdir(), 'dsh-ssh-real-100mib-'))
  const source = join(localDir, 'payload.bin')
  const downloaded = join(localDir, 'downloaded.bin')
  await markRunActive(localDir)
  t.after(async () => {
    stages.report()
    await clearLocalScratch(localDir)
  })

  log(`target ${HOST}:${PORT} as ${USER} · node ${process.version} · ${formatBytes(TRANSFER_BYTES)} · ${CONCURRENCY} range(s)`)
  await sweepStaleTrees(client)
  t.after(async () => {
    // Always clean the remote tree, even when an assertion above failed: the
    // cleanup opens its own connection and asserts the tree is gone.
    await cleanupRemote(remoteDir, stages).catch(() => undefined)
    client.end()
  })

  await stages.run(
    'mkdir + payload',
    async () => {
      await runRemote(client, `mkdir -p ${shellQuote(remoteDir)}`)
      await writePattern(source, TRANSFER_BYTES)
    },
    TRANSFER_BYTES,
  )
  const localDigest = await stages.run('local sha256', () => sha256File(source), TRANSFER_BYTES)
  const sourceStats = await stat(source)
  const handle = createSftpHandle(sftp)
  assert.equal(handle.supportsOffsetWrite(), true, 'the adapter must declare the offset-write capability')

  // ---- upload -------------------------------------------------------------
  const uploadFrames = []
  // Watch the payload while it is being read: a source that disappears or changes
  // mid-transfer must be reported as such, not as a mysterious transfer failure.
  const guard = sourceGuard(source, TRANSFER_BYTES, sourceStats.ino)
  const engine = new TransferEngine({
    defaults: { chunkBytes: CHUNK, maxConcurrentChunks: CONCURRENCY, resume: true, verify: 'sha256' },
  })
  const upload = await stages.run(
    `upload ${formatBytes(TRANSFER_BYTES)}`,
    () =>
      engine
        .run(handle, {
          direction: 'upload',
          localPath: source,
          remotePath: `${remoteDir}/payload.bin`,
          verify: 'sha256',
          onProgress: (progress) => {
            uploadFrames.push({ ...progress })
            guard.check(progress.transferred)
          },
        })
        .catch((error) => {
          if (guard.problem !== null) {
            throw new Error(`the local payload could not be read for the whole upload: it ${guard.problem} — ${error.message}`)
          }
          throw error
        }),
    TRANSFER_BYTES,
  )
  assert.equal(guard.problem, null, 'the payload must stay readable for the whole upload')
  assert.equal(upload.transferred, TRANSFER_BYTES)
  assert.equal(upload.sha256.local, localDigest)
  assert.equal(upload.sha256.remote, localDigest, 'the engine read the remote file back and it matched')
  inspectFrames(uploadFrames, TRANSFER_BYTES, 'upload')
  // The source must be untouched by the transfer, and still hash the same: proves
  // the upload read what `local sha256` measured at the start.
  await stages.run(
    'source unchanged',
    async () => {
      const after = await stat(source)
      assert.equal(after.size, TRANSFER_BYTES)
      assert.equal(after.ino, sourceStats.ino, 'the payload must be the same file, not a replacement')
      assert.equal(await sha256File(source), localDigest, 'the payload must be byte-identical after the upload')
    },
    TRANSFER_BYTES,
  )

  const remoteStat = await stages.run('stat remote file', () => handle.stat(`${remoteDir}/payload.bin`))
  assert.equal(remoteStat.size, TRANSFER_BYTES)
  // Third opinion: the *remote operating system* hashes its own file.
  const remoteDigest = await stages.run(
    'remote sha256sum',
    async () => (await runRemote(client, `sha256sum -- ${shellQuote(`${remoteDir}/payload.bin`)}`)).trim().split(/\s+/)[0],
    TRANSFER_BYTES,
  )
  assert.equal(remoteDigest, localDigest, 'remote sha256sum must agree with the local digest')

  // ---- download -----------------------------------------------------------
  const downloadFrames = []
  const download = await stages.run(
    `download ${formatBytes(TRANSFER_BYTES)}`,
    () =>
      engine.run(handle, {
        direction: 'download',
        localPath: downloaded,
        remotePath: `${remoteDir}/payload.bin`,
        verify: 'sha256',
        onProgress: (progress) => downloadFrames.push({ ...progress }),
      }),
    TRANSFER_BYTES,
  )
  assert.equal(download.transferred, TRANSFER_BYTES)
  assert.equal(download.sha256.local, localDigest)
  assert.equal(download.sha256.remote, localDigest)
  inspectFrames(downloadFrames, TRANSFER_BYTES, 'download')

  await stages.run(
    'local compare',
    async () => {
      assert.equal((await stat(downloaded)).size, TRANSFER_BYTES)
      assert.equal(await sha256File(downloaded), localDigest, 'the downloaded file is byte-identical to the source')
    },
    TRANSFER_BYTES,
  )

  log(`three-way sha256 agreement: ${localDigest.slice(0, 16)}… (local, engine/SFTP, remote sha256sum)`)
})

test('real host: a symlink is reported with its target, and is not followed by default', { skip: SKIP_REASON }, async (t) => {
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const remoteDir = `${REMOTE_ROOT}/${runId}`
  const { client, sftp } = await connect()
  t.after(async () => {
    await cleanupRemote(remoteDir).catch((error) => log(`cleanup failed: ${error.message}`))
    client.end()
  })

  // `ln -s` rather than the SFTP SYMLINK request: ssh2's client and OpenSSH
  // disagree about that request's argument order (the classic spec-vs-OpenSSH
  // quirk), and the adapter never creates links — it only reports them.
  await runRemote(
    client,
    `mkdir -p ${shellQuote(remoteDir)} && printf 'link target contents' > ${shellQuote(`${remoteDir}/target.txt`)} && ` +
      `ln -sfn ${shellQuote(`${remoteDir}/target.txt`)} ${shellQuote(`${remoteDir}/link.txt`)}`,
  )

  const handle = createSftpHandle(sftp)
  const info = await handle.stat(`${remoteDir}/link.txt`)
  assert.equal(info.type, 'symlink', 'the link is described, not its target')
  assert.equal(info.isSymlink, true)
  assert.equal(info.target, `${remoteDir}/target.txt`, 'readlink reports the stored target')

  const client2 = new SftpClient(handle)
  const walked = await client2.walk(remoteDir)
  const linkEntry = walked.find((entry) => entry.name === 'link.txt')
  assert.equal(linkEntry.type, 'symlink')
  log(`symlink reported: ${linkEntry.path} -> ${linkEntry.target}`)

  const followed = await client2.walk(remoteDir, { followSymlinks: true })
  assert.equal(followed.find((entry) => entry.name === 'link.txt').type, 'file', 'followSymlinks resolves the target type')
})

test('real host: an aborted upload resumes from the durable offset', { skip: SKIP_REASON }, async (t) => {
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const remoteDir = `${REMOTE_ROOT}/${runId}`
  const remotePath = `${remoteDir}/resume.bin`
  const size = 8 * MiB
  const stages = new StageLog('abort + resume')

  const { client, sftp } = await connect()
  // As above: no local scratch directory until the host answers, and a prefix that
  // is unique to this test so no prefix-based cleanup can reach across runs.
  const localDir = await mkdtemp(join(tmpdir(), 'dsh-ssh-real-resume-'))
  const source = join(localDir, 'payload.bin')
  await markRunActive(localDir)
  t.after(async () => {
    stages.report()
    await clearLocalScratch(localDir)
  })
  t.after(async () => {
    await cleanupRemote(remoteDir, stages).catch(() => undefined)
    client.end()
  })
  await stages.run(
    'mkdir + payload',
    async () => {
      await runRemote(client, `mkdir -p ${shellQuote(remoteDir)}`)
      await writePattern(source, size)
    },
    size,
  )
  const localDigest = await stages.run('local sha256', () => sha256File(source), size)

  const handle = createSftpHandle(sftp)
  // The abort below is deliberate: a cancelled transfer must be reported as
  // cancelled, not silently retried by the link-retry policy.
  const engine = new TransferEngine({
    defaults: { chunkBytes: CHUNK, maxConcurrentChunks: 4, resume: true },
    linkRetry: { attempts: 0, concurrency: 1 },
  })
  const controller = new AbortController()
  const error = await stages.run('upload until abort', async () =>
    await engine
      .run(handle, {
        direction: 'upload',
        localPath: source,
        remotePath,
        verify: 'none',
        signal: controller.signal,
        onProgress: (progress) => {
          // Cancel as soon as the first durable byte lands: progress is counted by
          // the durable prefix, so this is the earliest moment that is guaranteed
          // to be mid-transfer on a link of any speed.
          if (!controller.signal.aborted && progress.transferred > 0) controller.abort()
        },
      })
      .then(
        () => null,
        (caught) => caught,
      ),
  )

  assert.ok(error, 'the upload must fail when aborted')
  assert.equal(error.code, 'SSH_SFTP_TRANSFER_ABORTED')
  assert.equal(error.details.resumable, true)
  assert.ok(error.details.resumedFrom > 0)
  // The invariant that makes resume-by-size safe on a real server too: the remote
  // file is exactly as long as the bytes that are known good.
  const partial = await stages.run('stat partial', () => handle.stat(remotePath))
  assert.equal(partial.size, error.details.resumedFrom, 'the remote file must equal its durable prefix')
  log(`aborted after ${error.details.transferred} bytes; durable offset ${error.details.resumedFrom}`)

  const resumed = await stages.run(
    'resume upload',
    () => engine.run(handle, { direction: 'upload', localPath: source, remotePath, verify: 'sha256' }),
    size - error.details.resumedFrom,
  )
  assert.equal(resumed.resumedFrom, error.details.resumedFrom, 'the retry must resume exactly at the durable offset')
  assert.equal(resumed.sha256.local, localDigest)
  assert.equal(resumed.sha256.remote, localDigest)
  const remoteDigest = await stages.run(
    'remote sha256sum',
    async () => (await runRemote(client, `sha256sum -- ${shellQuote(remotePath)}`)).trim().split(/\s+/)[0],
    size,
  )
  assert.equal(remoteDigest, localDigest)
  log(`resumed ${resumed.transferred} bytes and matched sha256 ${localDigest.slice(0, 16)}…`)
})
