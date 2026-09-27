/**
 * F-SEC-05: the transfer engine must not be a general-purpose local write
 * primitive.
 *
 * Two independent guards are asserted here:
 *
 *   1. the plugin's own trust anchors and state files (`known_hosts`,
 *      `profiles.json`, the audit log) are out of reach in **both** directions 鈥? *      an upload of `known_hosts` leaks it exactly as a download onto it
 *      corrupts it;
 *   2. an **implicit** append into an existing non-empty destination is refused
 *      (`confirmDangerous`, default true): sizes alone cannot distinguish a
 *      truncated download from an unrelated smaller file, and treating the
 *      second as a partial transfer silently corrupts it.
 *
 * Both acceptances check the destination's bytes, not just the error: a refusal
 * that had already truncated the file would satisfy a code-only assertion.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { TransferEngine } from '../../lib/sftp/transfer.js'
import { canonicalLocalPath, isProtectedLocalPath } from '../../lib/sftp/paths.js'
import { createFakeHandle } from './sftp-fakes.mjs'

const CHUNK = 64 * 1024

async function tmpRoot(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ssh-guard-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function engineFor(defaults = {}) {
  return new TransferEngine({
    defaults: { chunkBytes: CHUNK, maxConcurrentChunks: 2, resume: true, verify: 'size+mtime', ...defaults },
  })
}

async function collectError(promise) {
  try {
    await promise
    return null
  } catch (error) {
    return error
  }
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

// ---------------------------------------------------------------------------
// The predicate
// ---------------------------------------------------------------------------

test('isProtectedLocalPath matches an exact path, ignores case on Windows, and never matches an empty list', () => {
  const anchor = join(tmpdir(), 'dsh-ssh-guard-anchor', 'known_hosts')
  assert.equal(isProtectedLocalPath(anchor, []), false, 'an empty policy protects nothing')
  assert.equal(isProtectedLocalPath(anchor, [anchor]), true)
  assert.equal(isProtectedLocalPath(anchor, ['', anchor]), true, 'an empty entry is ignored, not treated as a match-all')
  // A sibling with a shared prefix is a different file 鈥?the comparison is on
  // the whole path, not a `startsWith`.
  assert.equal(isProtectedLocalPath(`${anchor}.bak`, [anchor]), false)
  assert.equal(isProtectedLocalPath(join(tmpdir(), 'elsewhere', 'known_hosts'), [anchor]), false)
  if (process.platform === 'win32') {
    assert.equal(isProtectedLocalPath(anchor.toUpperCase(), [anchor]), true, 'Windows paths fold case')
  }
  // Both sides normalise the same way when the file does not exist yet.
  assert.equal(canonicalLocalPath(anchor), canonicalLocalPath(anchor))
})

// ---------------------------------------------------------------------------
// Guard 1: the trust anchors
// ---------------------------------------------------------------------------

for (const direction of ['download', 'upload']) {
  test(`${direction} refuses a protected local path and leaves it byte-identical`, async (t) => {
    const dir = await tmpRoot(t)
    const remoteRoot = join(dir, 'remote')
    await mkdir(remoteRoot, { recursive: true })

    const anchor = join(dir, 'known_hosts')
    const secret = 'the-host-key-i-trust\n'
    await writeFile(anchor, secret, 'utf8')
    const before = await readFile(anchor)

    // The remote side exists in both shapes so the guard, not a missing source,
    // is what has to stop the request.
    await writeFile(join(remoteRoot, 'known_hosts'), 'attacker-controlled\n', 'utf8')

    const engine = engineFor({ protectedLocalPaths: [anchor] })
    const handle = createFakeHandle(remoteRoot)
    const error = await collectError(
      engine.run(handle, {
        direction,
        // Remote paths are POSIX-absolute and map under the fake's root.
        remotePath: direction === 'download' ? '/known_hosts' : '/uploaded.bin',
        // Both directions name the anchor as the local path: downloading onto it
        // corrupts the trust anchor, uploading it exfiltrates the same file.
        localPath: anchor,
        overwrite: true,
        resume: true,
      }),
    )

    assert.ok(error, `${direction} must be refused`)
    assert.equal(error.code, 'SSH_CFG_INVALID')
    assert.equal(error.details?.reason, 'protected-path')
    assert.equal(sha256(await readFile(anchor)), sha256(before), 'the anchor must be untouched')
  })
}

test('a path outside the protected list still transfers (the guard is not a blanket refusal)', async (t) => {
  const dir = await tmpRoot(t)
  const remoteRoot = join(dir, 'remote')
  await mkdir(remoteRoot, { recursive: true })
  const payload = Buffer.from('ordinary download\n')
  await writeFile(join(remoteRoot, 'file.txt'), payload)

  const engine = engineFor({ protectedLocalPaths: [join(dir, 'known_hosts')] })
  const destination = join(dir, 'file.txt')
  const outcome = await engine.run(createFakeHandle(remoteRoot), {
    direction: 'download',
    remotePath: '/file.txt',
    localPath: destination,
    resume: true,
  })

  assert.equal(outcome.entries.length, 1)
  assert.equal(sha256(await readFile(destination)), sha256(payload))
})

// ---------------------------------------------------------------------------
// Guard 2: the implicit append
// ---------------------------------------------------------------------------

test('resume never grows a local file that was not created by this transfer', async (t) => {
  const dir = await tmpRoot(t)
  const remoteRoot = join(dir, 'remote')
  await mkdir(remoteRoot, { recursive: true })
  const remoteBody = Buffer.from('A'.repeat(4 * 1024))
  await writeFile(join(remoteRoot, 'report.pdf'), remoteBody)

  // An unrelated file that happens to be smaller: the pre-fix engine treated it
  // as a partial download and appended the remote bytes to it.
  const destination = join(dir, 'report.pdf')
  const existing = Buffer.from('unrelated content\n')
  await writeFile(destination, existing)
  const before = await readFile(destination)

  const engine = engineFor()
  const error = await collectError(
    engine.run(createFakeHandle(remoteRoot), {
      direction: 'download',
      remotePath: '/report.pdf',
      localPath: destination,
      resume: true,
    }),
  )

  assert.ok(error, 'an implicit append must be refused')
  assert.equal(error.code, 'SSH_SFTP_TARGET_EXISTS')
  assert.equal(sha256(await readFile(destination)), sha256(before), 'the destination must be byte-identical')
})

test('an explicit overwrite still resumes, so the confirmation path is not broken', async (t) => {
  const dir = await tmpRoot(t)
  const remoteRoot = join(dir, 'remote')
  await mkdir(remoteRoot, { recursive: true })
  const remoteBody = Buffer.from('B'.repeat(4 * 1024))
  await writeFile(join(remoteRoot, 'report.pdf'), remoteBody)

  const destination = join(dir, 'report.pdf')
  const partial = Buffer.from('partial')
  await writeFile(destination, partial)

  const engine = engineFor()
  const outcome = await engine.run(createFakeHandle(remoteRoot), {
    direction: 'download',
    remotePath: '/report.pdf',
    localPath: destination,
    resume: true,
    overwrite: true,
  })

  assert.equal(outcome.entries.length, 1)
  // Resume appends from the existing size, so the kept prefix is *not* the
  // remote's first bytes — that is exactly why an implicit resume is unsafe.
  // Assert the real contract: the file reaches the source length, and the
  // appended tail is byte-exact against the remote's tail.
  const final = await readFile(destination)
  assert.equal(final.length, remoteBody.length)
  assert.equal(sha256(final.subarray(partial.length)), sha256(remoteBody.subarray(partial.length)))
})

test('confirmDangerous:false restores the permissive resume behaviour (documented escape hatch)', async (t) => {
  const dir = await tmpRoot(t)
  const remoteRoot = join(dir, 'remote')
  await mkdir(remoteRoot, { recursive: true })
  const remoteBody = Buffer.from('C'.repeat(4 * 1024))
  await writeFile(join(remoteRoot, 'report.pdf'), remoteBody)

  const destination = join(dir, 'report.pdf')
  const partial = Buffer.from('partial')
  await writeFile(destination, partial)

  const engine = engineFor({ confirmDangerous: false })
  const outcome = await engine.run(createFakeHandle(remoteRoot), {
    direction: 'download',
    remotePath: '/report.pdf',
    localPath: destination,
    resume: true,
  })

  assert.equal(outcome.entries.length, 1)
  const final = await readFile(destination)
  assert.equal(final.length, remoteBody.length, 'the pre-0.2.1 permissive append is back')
  assert.equal(sha256(final.subarray(partial.length)), sha256(remoteBody.subarray(partial.length)))
})

test('the gate defaults to on when a caller supplies no policy at all', async (t) => {
  const dir = await tmpRoot(t)
  const remoteRoot = join(dir, 'remote')
  await mkdir(remoteRoot, { recursive: true })
  await writeFile(join(remoteRoot, 'report.pdf'), Buffer.from('D'.repeat(1024)))

  const destination = join(dir, 'report.pdf')
  await writeFile(destination, Buffer.from('x'))

  // No `confirmDangerous`, no `protectedLocalPaths`: the security default must
  // hold even for an embedder that passes nothing.
  const engine = new TransferEngine({ defaults: { chunkBytes: CHUNK } })
  const error = await collectError(
    engine.run(createFakeHandle(remoteRoot), {
      direction: 'download',
      remotePath: '/report.pdf',
      localPath: destination,
      resume: true,
    }),
  )
  assert.ok(error)
  assert.equal(error.code, 'SSH_SFTP_TARGET_EXISTS')
})
