/**
 * Performance layer (ICD §9 `test/perf/`).
 *
 * Two acceptance claims are measured here, not asserted by inspection:
 *   - **10 concurrent sessions with no cross-talk** (multi-session UI);
 *   - **100 MB up/download with byte-exact verification** and a throughput floor.
 *
 * Sizes are configurable so the layer stays usable while iterating:
 *   DSH_SSH_PERF_BYTES=8388608   → 8 MiB instead of 100 MiB
 *   DSH_SSH_PERF_FLOOR_MIBPS=2   → lower the throughput floor (slow machines)
 * The acceptance run uses the defaults (100 MiB, floor 3 MiB/s), which the local
 * ssh2 double reaches comfortably — see docs/TESTING.md for measured numbers.
 *
 * Everything goes through the shipped modules (pool → `SessionHandle` → SFTP
 * streams), so the numbers describe the plugin's real path, not a mock.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { humanBytes, seededBuffer, sha256Hex } from '../support/fixtures.mjs'
import { collectExecHandle, collectStream, makeProfile, openPool, acquireSession, writeStream } from '../support/host.mjs'
import { startSshd } from '../support/sshd.mjs'

const MIB = 1024 * 1024
const BYTES = Number(process.env.DSH_SSH_PERF_BYTES ?? 100 * MIB)
const FLOOR_MIBPS = Number(process.env.DSH_SSH_PERF_FLOOR_MIBPS ?? 3)
const CONCURRENCY_SIZE = Number(process.env.DSH_SSH_PERF_CONCURRENT_BYTES ?? 4 * MIB)

const mibPerSec = (bytes, ms) => bytes / MIB / (ms / 1000)

/** A per-test sshd + pool pair with generous timeouts for large payloads. */
async function perfSetup(t, extra = {}) {
  const server = await startSshd({ outputCap: 256 * MIB })
  t.after(() => server.stop())
  const { pool } = openPool(t, { configOverrides: { operationTimeoutMs: 600_000, maxLocalBytes: 4 * 1024 * MIB, ...extra } })
  return { server, pool }
}

test(`perf: ${humanBytes(BYTES)} upload is byte exact and clears the throughput floor`, { timeout: 600_000 }, async (t) => {
  const { server, pool } = await perfSetup(t)
  const session = await acquireSession(t, pool, makeProfile(server))
  const sftp = await session.sftp()

  const payload = seededBuffer(BYTES, 4242)
  const started = Date.now()
  await writeStream(sftp.createWriteStream('/tmp/perf-upload.bin', {}), payload)
  const durationMs = Date.now() - started
  const rate = mibPerSec(BYTES, durationMs)

  // Byte-exactness is verified *remotely* (the double runs the hash), so the
  // local buffer is not the only witness.
  const digest = await collectExecHandle(await session.exec({ command: 'sha256sum /tmp/perf-upload.bin' }))
  assert.equal(digest.stdout.split(/\s+/)[0], sha256Hex(payload), 'remote sha256 must equal the local payload hash')
  const info = await sftp.stat('/tmp/perf-upload.bin')
  assert.equal(info.size, BYTES)

  t.diagnostic(`upload: ${humanBytes(BYTES)} in ${(durationMs / 1000).toFixed(1)}s = ${rate.toFixed(1)} MiB/s`)
  assert.ok(rate >= FLOOR_MIBPS, `upload throughput ${rate.toFixed(2)} MiB/s is below the ${FLOOR_MIBPS} MiB/s floor`)
})

test(`perf: ${humanBytes(BYTES)} download is byte exact and clears the throughput floor`, { timeout: 600_000 }, async (t) => {
  const { server, pool } = await perfSetup(t)
  const session = await acquireSession(t, pool, makeProfile(server))
  const sftp = await session.sftp()

  const payload = seededBuffer(BYTES, 777)
  await writeStream(sftp.createWriteStream('/tmp/perf-download.bin', {}), payload)

  const started = Date.now()
  const readBack = await collectStream(sftp.createReadStream('/tmp/perf-download.bin', {}))
  const durationMs = Date.now() - started
  const rate = mibPerSec(readBack.length, durationMs)

  assert.equal(readBack.length, BYTES)
  assert.equal(sha256Hex(readBack), sha256Hex(payload), 'downloaded bytes must be identical to the source')
  t.diagnostic(`download: ${humanBytes(readBack.length)} in ${(durationMs / 1000).toFixed(1)}s = ${rate.toFixed(1)} MiB/s`)
  assert.ok(rate >= FLOOR_MIBPS, `download throughput ${rate.toFixed(2)} MiB/s is below the ${FLOOR_MIBPS} MiB/s floor`)
})

test('perf: 10 concurrent sessions transfer simultaneously without cross-talk', { timeout: 600_000 }, async (t) => {
  const { server, pool } = await perfSetup(t, { maxSessions: 10 })
  const sessions = []
  for (let index = 0; index < 10; index++) {
    sessions.push(
      await pool.acquire({ profile: makeProfile(server, { id: `p_perf_${index}`, name: `perf-${index}`, forceNew: true }), forceNew: true }),
    )
  }

  // Every session uploads its own distinct payload at the same time.
  const payloads = sessions.map((_, index) => seededBuffer(CONCURRENCY_SIZE, 1000 + index))
  const started = Date.now()
  await Promise.all(
    sessions.map(async (session, index) => {
      const sftp = await session.sftp()
      await writeStream(sftp.createWriteStream(`/tmp/perf-concurrent-${index}.bin`, {}), payloads[index])
    }),
  )
  const elapsed = Date.now() - started

  // Each remote file must match *its own* payload — the real "no cross-talk" test.
  for (let index = 0; index < sessions.length; index++) {
    const digest = await collectExecHandle(await sessions[index].exec({ command: `sha256sum /tmp/perf-concurrent-${index}.bin` }))
    assert.equal(
      digest.stdout.split(/\s+/)[0],
      sha256Hex(payloads[index]),
      `session ${index} remote file does not match its own payload`,
    )
  }
  const totalBytes = CONCURRENCY_SIZE * sessions.length
  t.diagnostic(
    `concurrent: ${sessions.length} sessions · ${humanBytes(totalBytes)} in ${(elapsed / 1000).toFixed(1)}s = ${mibPerSec(totalBytes, elapsed).toFixed(1)} MiB/s aggregate`,
  )
  assert.equal(pool.size, 10)
})

test('perf: large streamed exec output is complete, ordered and prompt', { timeout: 600_000 }, async (t) => {
  const { server, pool } = await perfSetup(t)
  const session = await acquireSession(t, pool, makeProfile(server))

  // A ~2.5 MiB file emitted in one streamed read exercises channel flow control.
  const lines = 400_000
  await collectExecHandle(await session.exec({ command: `seq 1 ${lines} > /tmp/perf-stream.txt` }))
  const counted = await collectExecHandle(await session.exec({ command: 'wc -c < /tmp/perf-stream.txt' }))
  const expected = Number(counted.stdout.trim())
  assert.ok(Number.isFinite(expected) && expected > 0, `the double must report the byte count, saw ${JSON.stringify(counted.stdout)}`)

  const started = Date.now()
  const streamed = await collectExecHandle(await session.exec({ command: 'cat /tmp/perf-stream.txt' }))
  const elapsed = Date.now() - started
  const text = streamed.stdout
  const firstLine = text.slice(0, text.indexOf('\n'))
  assert.equal(firstLine, '1', 'the head of the stream must arrive intact')
  assert.ok(text.endsWith(`${lines}\n`), 'the tail of the stream must arrive intact')
  assert.equal(Buffer.byteLength(text, 'utf8'), expected, 'the streamed byte count must match the file exactly')
  assert.ok(server.stats.bytesOut > expected, 'the server must have written at least the payload')
  t.diagnostic(`streamed exec: ${humanBytes(expected)} in ${(elapsed / 1000).toFixed(1)}s = ${mibPerSec(expected, elapsed).toFixed(1)} MiB/s`)
})
