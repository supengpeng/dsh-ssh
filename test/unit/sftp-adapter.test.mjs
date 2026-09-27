/**
 * The SFTP adapter and the transfer engine against a **real SFTP protocol
 * implementation** — sp8's `test/support/sshd.mjs`: an ssh2 `Server` on a real
 * localhost socket, chrooted to a temp root with a virtual POSIX filesystem.
 *
 * Why this file exists next to the filesystem-backed fake and the opt-in
 * real-host suite:
 *
 *  - the fake proves the engine's *logic*, but it is my own code, so it cannot
 *    vouch for the adapter's assumptions about ssh2 (`FileEntry.attrs`, `lstat`
 *    vs `stat`, `setstat({size})`, `options.start`, `readlink`);
 *  - the real-host suite proves those against OpenSSH, but it is opt-in and needs
 *    credentials, so it never runs in a normal loop;
 *  - this server speaks the same protocol over a real socket, honours real
 *    permission bits (so `chmod 0600` round-trips), and can inject failures
 *    (`dropAll()`), which is the only way to exercise a mid-transfer link death.
 *
 * It has already paid for itself twice, so the case list is deliberately blunt:
 *  - ssh2's SFTP `WriteStream` **never emits `finish`** (only `close`), which made
 *    every upload hang on a real server while the fs-backed fake stayed green;
 *  - stream failures carry the raw **numeric** status code, which must be
 *    translated before the wire sees it (ICD §5 codes are strings).
 *
 * Fixture paths come from `server.home` rather than a hardcoded `/home/user`: the
 * double chooses its own home, and a test that assumes one is a test that lies
 * about what it verified.
 */

import assert from 'node:assert/strict'
import { statSync, symlinkSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { test } from 'node:test'

import { ERROR_CODES } from '../../lib/protocol.js'
import { seededBuffer, sha256Hex } from '../support/fixtures.mjs'
import { withSftp, withSshd } from '../support/sshd.mjs'

import { createSftpHandle } from '../../lib/sftp/adapter.js'
import { SftpClient } from '../../lib/sftp/client.js'
import { TransferEngine } from '../../lib/sftp/transfer.js'

const MiB = 1024 * 1024
const KiB = 1024
const CHUNK = 256 * KiB

async function tmpDir(t, prefix = 'dsh-ssh-adapter-') {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  // Best-effort: on Windows a still-open handle would make `rm` fail, and a
  // cleanup problem must never be reported as a test failure. Handles are closed
  // by the code under test; this is only a safety net.
  t.after(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
  })
  return dir
}

/** Run `fn(handle, rawSftp, server)` over one fresh SFTP channel. */
async function withHandle(server, fn, options = {}) {
  const client = await server.connect()
  try {
    return await withSftp(client, async (sftp) => await fn(createSftpHandle(sftp, options), sftp, server))
  } finally {
    // `client.end()` is graceful but asynchronous; awaiting its 'close' keeps one
    // test from leaving a socket (and a server-side channel) behind for the next.
    client.end()
    await Promise.race([once(client, 'close').catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 1000))])
  }
}

function engineFor(overrides = {}) {
  return new TransferEngine({
    defaults: { chunkBytes: CHUNK, maxConcurrentChunks: 4, resume: true, verify: 'sha256' },
    ...overrides,
  })
}

/** Assert that a failure carries a string ICD §5 code (a rejection is required). */
async function assertIcdCode(promise, label) {
  const error = await promise.then(
    () => null,
    (caught) => caught,
  )
  assert.ok(error, `${label} must fail`)
  assert.equal(typeof error.code, 'string', `${label}: code must be a string, saw ${typeof error.code} (${String(error.code)})`)
  assert.ok(ERROR_CODES.includes(error.code), `${label}: ${error.code} must be one of the ICD §5 codes`)
  return error
}

/**
 * For operations where a server may legitimately succeed on a missing path
 * (this double is lenient about `SETSTAT`/`RENAME`), assert the *shape* of the
 * failure whenever there is one: the contract under test is "no raw numeric code
 * escapes", not "this server must refuse".
 */
async function assertIcdCodeOrSuccess(promise, label) {
  const error = await promise.then(
    () => null,
    (caught) => caught,
  )
  if (error === null) return null
  return await assertIcdCode(Promise.reject(error), label)
}

test('adapter: listing, stat, mkdir, rename, chmod and recursive remove over real SFTP', async (t) => {
  const local = await tmpDir(t)
  const source = join(local, 'probe.txt')
  await writeFile(source, 'adapter probe')

  await withSshd(async (server) => {
    const home = server.home
    await withHandle(server, async (handle) => {
      const client = new SftpClient(handle)

      // --- listing: directories first, then natural order -------------------
      const listing = await client.listDir(home)
      assert.equal(listing.cwd, home)
      assert.deepEqual(
        listing.entries.map((entry) => entry.name),
        ['docs', 'downloads', 'uploads', 'readme.txt'],
      )
      assert.equal(listing.entries.find((entry) => entry.name === 'docs').type, 'dir')
      const readme = listing.entries.find((entry) => entry.name === 'readme.txt')
      assert.equal(readme.type, 'file')
      assert.equal(readme.size, 'hello from the dsh-ssh fixture tree\n'.length)
      assert.match(readme.mode, /^0[0-7]{3}$/, 'the adapter reports a four-digit octal mode string')
      assert.match(readme.mtime, /^\d{4}-\d{2}-\d{2}T/, 'and an ISO mtime')

      const hidden = await client.listDir(home, { showHidden: true })
      assert.ok(hidden.entries.some((entry) => entry.name === '.hidden'), 'showHidden reaches readdir')

      // --- stat ------------------------------------------------------------
      const notes = await client.stat(`${home}/docs/notes.md`)
      assert.equal(notes.exists, true)
      assert.equal(notes.name, 'notes.md')
      assert.ok(notes.size > 0)
      assert.equal((await client.stat(`${home}/nope.txt`)).exists, false, 'a missing path answers exists:false')

      // --- mkdir -p --------------------------------------------------------
      await client.mkdir('/tmp/dsh-ssh-adapter/deep/tree', { recursive: true })
      assert.equal((await client.stat('/tmp/dsh-ssh-adapter/deep/tree')).type, 'dir')

      // --- upload through the engine, then rename/chmod --------------------
      await engineFor({ defaults: { chunkBytes: 64 * KiB, maxConcurrentChunks: 1, verify: 'sha256' } }).run(handle, {
        direction: 'upload',
        localPath: source,
        remotePath: '/tmp/dsh-ssh-adapter/deep/x.txt',
      })
      assert.equal((await client.stat('/tmp/dsh-ssh-adapter/deep/x.txt')).size, 'adapter probe'.length)

      await client.rename('/tmp/dsh-ssh-adapter/deep/x.txt', '/tmp/dsh-ssh-adapter/deep/y.txt')
      assert.equal((await client.stat('/tmp/dsh-ssh-adapter/deep/x.txt')).exists, false)
      assert.equal((await client.stat('/tmp/dsh-ssh-adapter/deep/y.txt')).exists, true)

      // The virtual filesystem keeps real permission bits, so the octal string
      // the ICD passes around is verifiable end to end.
      await client.chmod('/tmp/dsh-ssh-adapter/deep/y.txt', '0600')
      assert.equal((await client.stat('/tmp/dsh-ssh-adapter/deep/y.txt')).mode, '0600')
      await client.chmod('/tmp/dsh-ssh-adapter/deep/y.txt', '0755')
      assert.equal((await client.stat('/tmp/dsh-ssh-adapter/deep/y.txt')).mode, '0755')

      // --- remove (counted) ------------------------------------------------
      assert.equal(await client.remove('/tmp/dsh-ssh-adapter/deep', { recursive: true }), 3, 'y.txt + tree/ + deep/')
      assert.equal((await client.stat('/tmp/dsh-ssh-adapter/deep')).exists, false)
    })
  })
})

test('adapter: a symlink is reported as a link, with its target', async (t) => {
  await withSshd(async (server) => {
    // The link is created on the server's own filesystem on purpose: the double's
    // protocol-level `SYMLINK` handler expects the OpenSSH argument order
    // (target, link) while ssh2's client sends the spec order (link, target), and
    // the ICD handle never creates links — it only *reports* them. Creating it
    // host-side tests exactly the code under review (lstat + readlink + listing).
    const linkPath = join(server.root, 'tmp', 'link-to-readme')
    const targetPath = join(server.root, 'home', 'sshuser', 'readme.txt')
    symlinkSync(targetPath, linkPath, 'file')

    await withHandle(server, async (handle, sftp) => {
      // Does this server answer READLINK at all? The double currently answers
      // `FAILURE 4 (names is not an object or array)`: its handler passes a bare
      // string to ssh2's server-side `name()` API, which wants an object/array.
      // Reported upstream; the positive `target` path is asserted against real
      // OpenSSH in `sftp-real.test.mjs` instead of being silently assumed here.
      const readlinkWorks = await new Promise((resolve) => {
        sftp.readlink('/tmp/link-to-readme', (error, target) => resolve(!error && typeof target === 'string' && target.length > 0))
      })

      const info = await handle.stat('/tmp/link-to-readme')
      assert.equal(info.type, 'symlink', 'lstat semantics: the link itself is described')
      assert.equal(info.isSymlink, true)
      if (readlinkWorks) {
        assert.ok(typeof info.target === 'string' && info.target.length > 0, 'readlink fills the target')
      } else {
        assert.equal(info.target, undefined, 'a server that cannot readlink must degrade to "no target", not to an error')
      }

      const listing = await new SftpClient(handle).listDir('/tmp')
      const link = listing.entries.find((entry) => entry.name === 'link-to-readme')
      assert.equal(link.type, 'symlink')
      assert.equal(link.isSymlink, true)
      // Following links through the walk is covered by the fake-based client
      // suite, where the link target is expressed in the remote namespace.
    })
  })
})

test('adapter: every failure path carries a string ICD §5 code, never a raw status number', async (t) => {
  await withSshd(async (server) => {
    await withHandle(server, async (handle) => {
      // Promise-returning surface.
      await assertIcdCode(handle.listDir('/no/such/dir'), 'listDir')
      await assertIcdCode(handle.remove('/no/such/dir', { recursive: true }), 'remove')
      await assertIcdCodeOrSuccess(handle.chmod('/no/such/file', '0644'), 'chmod')
      await assertIcdCodeOrSuccess(handle.rename('/no/such/file', '/tmp/x'), 'rename')
      const missing = await handle.stat('/no/such/file')
      assert.equal(missing.exists, false, 'stat answers exists:false instead of failing')

      // Stream surface: ssh2 emits the numeric status on 'error', so the adapter
      // must translate it before a caller can read `error.code`.
      const readError = await new Promise((resolve) => {
        const stream = handle.createReadStream('/no/such/file', {})
        stream.on('data', () => undefined)
        stream.on('error', resolve)
      })
      assert.equal(typeof readError.code, 'string', `createReadStream: string code, saw ${String(readError.code)}`)
      assert.ok(ERROR_CODES.includes(readError.code))
      assert.equal(readError.code, 'SSH_SFTP_NO_SUCH_FILE')

      const writeError = await new Promise((resolve) => {
        const stream = handle.createWriteStream('/no/such/dir/file', {})
        stream.on('error', resolve)
        stream.end()
      })
      assert.equal(typeof writeError.code, 'string', `createWriteStream: string code, saw ${String(writeError.code)}`)
      assert.ok(ERROR_CODES.includes(writeError.code))

      // Every code must also be usable without an explicit `opts` object.
      const written = handle.createWriteStream('/tmp/no-opts.txt')
      await new Promise((resolve, reject) => {
        written.on('error', reject)
        written.on('close', resolve)
        written.write(Buffer.from('no opts'), (error) => (error ? reject(error) : written.end()))
      })
      assert.equal((await handle.stat('/tmp/no-opts.txt')).size, 'no opts'.length, 'a write stream without options works')

      // The read stream is consumed rather than left dangling: an abandoned
      // stream errors when its channel closes, which would fail the test for a
      // reason that has nothing to do with the signature under test.
      const read = handle.createReadStream('/tmp/no-opts.txt')
      const text = await new Promise((resolve, reject) => {
        const chunks = []
        read.on('data', (chunk) => chunks.push(chunk))
        read.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        read.on('error', reject)
      })
      assert.equal(text, 'no opts', 'a read stream without options reads the whole file')
    })
  })
})

test('engine: a zero-byte file uploads, and an upload completes without `finish` events', async (t) => {
  const local = await tmpDir(t)
  const empty = join(local, 'empty.bin')
  const payload = join(local, 'payload.bin')
  await writeFile(empty, Buffer.alloc(0))
  await writeFile(payload, seededBuffer(2 * MiB))
  const expected = sha256Hex(await readFile(payload))

  await withSshd(async (server) => {
    await withHandle(server, async (handle) => {
      // The creation of every destination file goes through the "empty write then
      // end" path, which is exactly where ssh2's missing `finish` hung: 0 bytes,
      // a real payload, and a resume with a pre-existing partial file.
      const zero = await engineFor().run(handle, {
        direction: 'upload',
        localPath: empty,
        remotePath: '/tmp/empty.bin',
        verify: 'sha256',
      })
      assert.equal(zero.transferred, 0)
      assert.equal(zero.totalBytes, 0)
      assert.equal((await handle.stat('/tmp/empty.bin')).size, 0)
      assert.deepEqual(zero.sha256, { local: sha256Hex(Buffer.alloc(0)), remote: sha256Hex(Buffer.alloc(0)) })

      const upload = await engineFor().run(handle, {
        direction: 'upload',
        localPath: payload,
        remotePath: '/tmp/payload.bin',
        verify: 'sha256',
      })
      assert.equal(upload.transferred, 2 * MiB)
      assert.equal(upload.sha256.local, expected)
      assert.equal(upload.sha256.remote, expected)
      assert.equal((await handle.stat('/tmp/payload.bin')).size, 2 * MiB)

      const download = await engineFor().run(handle, {
        direction: 'download',
        localPath: join(local, 'back.bin'),
        remotePath: '/tmp/payload.bin',
        verify: 'sha256',
      })
      assert.equal(download.sha256.local, expected)
      assert.equal(sha256Hex(await readFile(join(local, 'back.bin'))), expected)
    })
  })
})

test('engine: resume works against a real server (offset write and truncate are honoured)', async (t) => {
  const local = await tmpDir(t)
  const payload = seededBuffer(3 * MiB)
  const source = join(local, 'payload.bin')
  await writeFile(source, payload)
  const expected = sha256Hex(payload)

  await withSshd(async (server) => {
    await withHandle(server, async (handle) => {
      const client = new SftpClient(handle)
      const first = await engineFor().run(handle, {
        direction: 'upload',
        localPath: source,
        remotePath: '/tmp/resume.bin',
      })
      assert.equal(first.transferred, 3 * MiB)

      // Model an interrupted run: keep the first MiB, drop the rest.
      await handle.truncate('/tmp/resume.bin', MiB)
      assert.equal((await client.stat('/tmp/resume.bin')).size, MiB)

      const outcome = await engineFor().run(handle, {
        direction: 'upload',
        localPath: source,
        remotePath: '/tmp/resume.bin',
        verify: 'sha256',
        // The destination is this transfer's own truncated prefix, so the append
        // is authorised explicitly (F-SEC-05's `confirmDangerous` gate).
        overwrite: true,
      })
      assert.equal(outcome.resumedFrom, MiB, 'the engine resumed from the real destination size')
      assert.equal(outcome.transferred, 2 * MiB)
      assert.equal(outcome.sha256.local, expected)
      assert.equal(outcome.sha256.remote, expected)
      assert.equal((await client.stat('/tmp/resume.bin')).size, 3 * MiB)
    })
  })
})

test('engine: a cancelled transfer is resumable; a dropped connection withdraws that promise', async (t) => {
  const local = await tmpDir(t)
  const payload = seededBuffer(6 * MiB)
  const source = join(local, 'payload.bin')
  await writeFile(source, payload)

  // 1) Graceful cancellation: the link is healthy, so the engine can cut the
  //    remote file back to its durable prefix and promise a resume.
  await withSshd(async (server) => {
    await withHandle(server, async (handle) => {
      const controller = new AbortController()
      const error = await engineFor({ chunkTimeoutMs: 2000, restoreTimeoutMs: 2000 })
        .run(handle, {
          direction: 'upload',
          localPath: source,
          remotePath: '/tmp/graceful.bin',
          verify: 'none',
          signal: controller.signal,
          onProgress: (progress) => {
            // Cancel on the first *durable* byte: with progress counted by the
            // durable prefix (not per chunk), waiting for a larger threshold can
            // arrive after a fast local transfer has already finished, which would
            // make this test flaky instead of mid-flight.
            if (!controller.signal.aborted && progress.transferred > 0) controller.abort()
          },
        })
        .then(() => null, (caught) => caught)

      assert.ok(error, 'the cancelled transfer must fail')
      assert.equal(error.code, 'SSH_SFTP_TRANSFER_ABORTED')
      assert.equal(error.details.resumable, true, 'a healthy link keeps the resume promise')
      assert.ok(error.details.resumedFrom > 0)
      assert.equal(
        (await handle.stat('/tmp/graceful.bin')).size,
        error.details.resumedFrom,
        'the remote file equals its durable prefix',
      )
    })
  })

  // 2) Hard drop: the connection dies mid-write, so the truncate cannot be sent
  //    and the file may be longer than its known-good prefix. The report must
  //    withdraw the promise instead of letting a retry skip a hole — and it must
  //    do so promptly: ssh2 never invokes the pending write callbacks of a
  //    destroyed channel, so only the chunk deadline can end the wait.
  await withSshd(async (server) => {
    await withHandle(server, async (handle) => {
      const started = Date.now()
      const error = await engineFor({ chunkTimeoutMs: 1500, restoreTimeoutMs: 1500 })
        .run(handle, {
          direction: 'upload',
          localPath: source,
          remotePath: '/tmp/dropped.bin',
          verify: 'none',
          onProgress: (progress) => {
            // Kill the link on the first durable byte: this is the earliest moment
            // guaranteed to be mid-transfer, so ranges really are in flight when the
            // channel dies (a larger threshold can arrive after a fast local upload
            // has already completed, which would silently turn this into a no-op).
            if (progress.transferred > 0) server.dropAll()
          },
        })
        .then(() => null, (caught) => caught)

      assert.ok(error, 'a dropped connection must fail the transfer')
      assert.equal(error.code, 'SSH_SFTP_TRANSFER_ABORTED', 'an interrupted transfer reports the transfer code')
      assert.equal(error.details.resumable, false, 'without a proven durable prefix, resume must not be promised')
      assert.equal(error.details.resumedFrom, 0)
      assert.match(error.details.resumeHint, /overwrite: true/)
      assert.ok(typeof error.details.causeCode === 'string', 'the network cause is preserved for diagnostics')
      assert.ok(Date.now() - started < 15_000, 'a dead peer must end the transfer on the chunk deadline, not hang')
    })
  })
})

test('engine: a channel that dies during the sha256 read-back is reported as an interruption', async (t) => {
  const local = await tmpDir(t)
  const payload = seededBuffer(3 * MiB)
  const source = join(local, 'payload.bin')
  await writeFile(source, payload)

  await withSshd(async (server) => {
    await withHandle(server, async (handle) => {
      // Upload first (verify off), then kill the channel exactly when the verify
      // phase starts: that is where the real-host 100 MiB run died, and where an
      // ssh2 "No response from server" (SSH_UNKNOWN, no code) can otherwise escape
      // as an unhandled stream error or an opaque failure. The retry is left on so
      // the test also proves that retrying a dead channel terminates instead of
      // hanging on the chunk deadline forever.
      await engineFor({ defaults: { chunkBytes: CHUNK, maxConcurrentChunks: 4, verify: 'none' } }).run(handle, {
        direction: 'upload',
        localPath: source,
        remotePath: '/tmp/dies-in-verify.bin',
      })

      const started = Date.now()
      const error = await engineFor({
        defaults: { chunkBytes: CHUNK, maxConcurrentChunks: 4, verify: 'sha256' },
        chunkTimeoutMs: 1500,
        restoreTimeoutMs: 1000,
        linkRetry: { attempts: 1, concurrency: 1 },
      })
        .run(handle, {
          direction: 'download',
          localPath: join(local, 'back.bin'),
          remotePath: '/tmp/dies-in-verify.bin',
          onProgress: (progress) => {
            if (progress.phase !== 'scan') server.dropAll()
          },
        })
        .then(() => null, (caught) => caught)

      assert.ok(error, 'a dead channel must fail the operation')
      assert.equal(typeof error.code, 'string', 'the failure must carry an ICD string code')
      assert.equal(error.code, 'SSH_SFTP_TRANSFER_ABORTED', 'a transport loss is an interruption, not an opaque unknown')
      assert.ok(typeof error.details.causeCode === 'string', 'the underlying transport cause is preserved')
      assert.ok(Date.now() - started < 20_000, 'a dead channel must end the operation, not hang it')
      // The bytes on disk stay usable for a resume (or the file was never created).
      try {
        const { size } = statSync(join(local, 'back.bin'))
        assert.ok(size >= 0)
      } catch {
        /* acceptable: the drop landed before the local file existed */
      }
    })
  })
})

test('engine: sha256 catches a same-length destination on a real server', async (t) => {
  const local = await tmpDir(t)
  const source = join(local, 'report.txt')
  await withSshd(async (server) => {
    await withHandle(server, async (handle) => {
      await writeFile(source, 'the new content!!')
      await engineFor({ defaults: { chunkBytes: 64 * KiB, maxConcurrentChunks: 1, verify: 'none' } }).run(handle, {
        direction: 'upload',
        localPath: source,
        remotePath: '/tmp/report.txt',
      })
      // Same length, different bytes: the planner treats an equal-length
      // destination as "already transferred" and leaves it to `verify`.
      await writeFile(source, 'DIFFERENT length!!')

      const error = await engineFor()
        .run(handle, {
          direction: 'upload',
          localPath: source,
          remotePath: '/tmp/report.txt',
          verify: 'sha256',
          // Authorise the resume so the run reaches `verify`; without it the
          // engine now refuses earlier, before writing anything (F-SEC-05).
          overwrite: true,
        })
        .then(() => null, (caught) => caught)
      assert.ok(error)
      assert.equal(error.code, 'SSH_SFTP_VERIFY_MISMATCH')
      assert.notEqual(error.details.localSha256, error.details.remoteSha256)
      assert.equal(error.details.mode, 'sha256')
    })
  })
})

test('engine: a directory tree transfers over real SFTP preserving structure', async (t) => {
  const local = await tmpDir(t)
  await writeFile(join(local, 'one.txt'), 'one')
  await (await import('node:fs/promises')).mkdir(join(local, 'nested', 'deep'), { recursive: true })
  await writeFile(join(local, 'nested', 'two.bin'), seededBuffer(700 * KiB))
  await writeFile(join(local, 'nested', 'deep', 'three.txt'), 'three')

  await withSshd(async (server) => {
    await withHandle(server, async (handle) => {
      const outcome = await engineFor().run(handle, {
        direction: 'upload',
        localPath: local,
        remotePath: '/tmp/tree',
        verify: 'sha256',
      })
      assert.equal(outcome.entries.length, 3)
      assert.equal(outcome.entries.filter((entry) => entry.sha256 !== undefined).length, 3)
      assert.deepEqual(
        outcome.entries.map((entry) => entry.remotePath).sort(),
        ['/tmp/tree/nested/deep/three.txt', '/tmp/tree/nested/two.bin', '/tmp/tree/one.txt'],
      )
      assert.equal((await handle.stat('/tmp/tree/nested/two.bin')).size, 700 * KiB)

      // And straight back down into a fresh local directory.
      const target = await tmpDir(t, 'dsh-ssh-download-')
      const back = await engineFor().run(handle, {
        direction: 'download',
        localPath: target,
        remotePath: '/tmp/tree',
        verify: 'sha256',
      })
      assert.equal(back.entries.length, 3)
      assert.equal(await readFile(join(target, 'one.txt'), 'utf8'), 'one')
      assert.equal(await readFile(join(target, 'nested', 'deep', 'three.txt'), 'utf8'), 'three')
      assert.equal(sha256Hex(await readFile(join(target, 'nested', 'two.bin'))), sha256Hex(seededBuffer(700 * KiB)))
    })
  })
})

test('engine: a stream error mid-download is reported with a string code', async (t) => {
  const local = await tmpDir(t)
  await withSshd(async (server) => {
    await withHandle(server, async (handle) => {
      // The remote source disappears between planning and the first range read:
      // the failure must still arrive as an ICD code, not a raw status number.
      const target = join(local, 'gone.bin')
      const error = await engineFor()
        .run(handle, { direction: 'download', localPath: target, remotePath: '/tmp/never-existed.bin', verify: 'none' })
        .then(() => null, (caught) => caught)
      assert.ok(error)
      assert.equal(typeof error.code, 'string')
      assert.equal(error.code, 'SSH_SFTP_NO_SUCH_FILE')
    })
  })
})
