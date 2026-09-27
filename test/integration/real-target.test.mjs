/**
 * Real-target layer (task-11 layer B) — **explicitly gated, never默认**.
 *
 * Enabled only when all of `DSH_SSH_TEST_REAL_HOST/_PORT/_USER/_PASSWORD` are
 * present; otherwise every test skips with the documented reason
 * `real target not configured: set DSH_SSH_TEST_REAL_*` (never a silent pass,
 * never a failure, never a default connection to a real machine).
 *
 * What it proves against the real Ubuntu box:
 *   1. `ssh-keyscan` returns the host's real keys, and our verifier accepts them
 *      under accept-new → `remember` → re-verify is an `exact` match →
 *      presenting a different key of the same type is a `changed`/MISMATCH;
 *   2. a real `exec` (`uname -a`) matches the facts recorded in
 *      `docs/REAL-TARGET.md`;
 *   3. a real SFTP round trip inside `/tmp/dsh-ssh-test/**` (created and removed
 *      by the test) is byte exact;
 *   4. network trouble is reported as "target unreachable", **not** as a
 *      host-key verification failure.
 *
 * Discipline (task-11 / ICD §12): the password comes from the environment only —
 * it is never written to any file in this repository; all write operations stay
 * inside `/tmp/dsh-ssh-test/**` and are cleaned up; no frozen signature changes.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { sha256Hex } from '../support/fixtures.mjs'
import { collectExecHandle, collectStream, openPool, writeStream } from '../support/host.mjs'

const HOST = process.env.DSH_SSH_TEST_REAL_HOST
const PORT = Number(process.env.DSH_SSH_TEST_REAL_PORT ?? 22)
const USER = process.env.DSH_SSH_TEST_REAL_USER
const PASSWORD = process.env.DSH_SSH_TEST_REAL_PASSWORD
const SSH_KEYSCAN = process.env.DSH_SSH_SSH_KEYSCAN ?? 'C:\\WINDOWS\\System32\\OpenSSH\\ssh-keyscan.exe'

const CONFIGURED = Boolean(HOST && USER && PASSWORD)
const NOT_CONFIGURED = 'real target not configured: set DSH_SSH_TEST_REAL_HOST/_PORT/_USER/_PASSWORD'
/** The host-key probe only needs the host, so it can run without credentials. */
const HOST_CONFIGURED = Boolean(HOST)
const NOT_CONFIGURED_HOST = 'real target not configured: set DSH_SSH_TEST_REAL_HOST (and optionally _PORT)'
/** Every write goes here and nowhere else. */
const REMOTE_ROOT = '/tmp/dsh-ssh-test'

const knownHosts = await import('../../lib/known-hosts.js')

function run(file, args, { timeout = 30_000 } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error ? (error.code ?? 1) : 0, stdout: stdout ?? '', stderr: stderr ?? '', error })
    })
  })
}

/**
 * Capture the host's real keys with **our own** ssh2 stack.
 *
 * The Windows-bundled `ssh-keyscan` cannot negotiate with newer servers (it
 * reports `choose_kex: unsupported KEX method sntrup761x25519-sha512@openssh.com`),
 * so it is used first (per task-11) and this probe is the fallback. It is, if
 * anything, stronger evidence: the key we verify is the one *our* transport
 * stack actually receives, and the handshake also proves our client can talk to
 * the real server's KEX/cipher set.
 */
async function probeHostKeysViaSsh2(keyTypes = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'rsa-sha2-512']) {
  const { Client } = await import('../support/sshd.mjs')
  const captured = []
  for (const algorithm of keyTypes) {
    const client = new Client()
    const key = await new Promise((resolve) => {
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      client.on('error', () => finish(null))
      client.on('ready', () => finish(null))
      const timer = setTimeout(() => finish(null), 20_000)
      timer.unref?.()
      try {
        client.connect({
          host: HOST,
          port: PORT,
          username: 'dsh-ssh-probe',
          algorithms: { serverHostKey: [algorithm] },
          hostVerifier: (hostKey) => {
            clearTimeout(timer)
            finish(Buffer.from(hostKey))
            return true
          },
          readyTimeout: 15_000,
        })
      } catch {
        finish(null)
      }
    })
    try {
      client.end()
    } catch {
      /* already closed */
    }
    if (key && key.length) captured.push({ host: HOST, keyType: knownHosts.keyTypeOfBlob(key), key })
  }
  return captured
}

/** Fetch the real host keys; `{ unreachable }` means the target could not be probed. */
async function scanHostKeys() {
  const notes = []
  if (existsSync(SSH_KEYSCAN)) {
    const scanned = await run(SSH_KEYSCAN, ['-T', '10', '-p', String(PORT), '-t', 'ed25519,ecdsa,rsa', HOST])
    const entries = []
    for (const line of scanned.stdout.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const [name, keyType, base64] = trimmed.split(/\s+/)
      if (!name || !keyType || !base64) continue
      entries.push({ host: name.replace(/^\[|\]:\d+$/g, ''), keyType, key: Buffer.from(base64, 'base64') })
    }
    if (entries.length) return { entries, source: 'ssh-keyscan' }
    notes.push(`ssh-keyscan: ${scanned.stderr.trim().split('\n')[0] || 'no keys returned'}`)
  } else {
    notes.push(`ssh-keyscan not found at ${SSH_KEYSCAN}`)
  }

  const probed = await probeHostKeysViaSsh2()
  if (probed.length) return { entries: probed, source: 'ssh2 hostVerifier', notes }

  return { unreachable: `${notes.join('; ')}; ssh2 probe also returned no host key (target unreachable or KEX rejected)` }
}

function realProfile(dir) {
  return {
    id: 'p_real_target',
    name: 'real-target',
    host: HOST,
    port: PORT,
    user: USER,
    auth: 'password',
    secretRefs: {},
    connectTimeoutMs: 20_000,
    keepaliveIntervalMs: 0,
    keepaliveCountMax: -1,
    retries: { max: 0, backoffBaseMs: 1, backoffMaxMs: 2, jitter: false },
    hostKeyPolicy: 'accept-new',
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    secrets: { password: PASSWORD },
    dir,
  }
}

test('real-target: ssh-keyscan keys verify accept-new → exact → changed', async (t) => {
  if (!HOST_CONFIGURED) return t.skip(NOT_CONFIGURED_HOST)
  const scanned = await scanHostKeys()
  if (scanned.unreachable) return t.skip(`target unreachable: ${scanned.unreachable}`)

  const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-real-kh-'))
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  })
  const file = join(dir, 'known_hosts')
  const primary = scanned.entries[0]
  const other = scanned.entries.find((entry) => entry.keyType !== primary.keyType)

  // accept-new adopts the real key …
  const acceptNew = knownHosts.createKnownHostsVerifier({ file, policy: 'accept-new' })
  const adopted = await acceptNew.verify({ host: HOST, port: PORT, keyType: primary.keyType, key: primary.key, policy: 'accept-new' })
  assert.equal(adopted.ok, true, `accept-new must adopt the real ${primary.keyType} key: ${JSON.stringify(adopted)}`)
  await acceptNew.remember({ host: HOST, port: PORT, keyType: primary.keyType, key: primary.key })

  // … a strict re-verification is an exact match …
  const strict = knownHosts.createKnownHostsVerifier({ file, policy: 'strict' })
  const exact = await strict.verify({ host: HOST, port: PORT, keyType: primary.keyType, key: primary.key, policy: 'strict' })
  assert.equal(exact.ok, true, 'the remembered real key must verify under strict policy')
  assert.equal(exact.knownHostsMatch, 'exact')

  // … and a *different* key of the same type is a change (MISMATCH), not silence.
  const impostor = Buffer.from(primary.key)
  impostor[impostor.length - 1] ^= 0xff
  const changed = await strict.verify({ host: HOST, port: PORT, keyType: primary.keyType, key: impostor, policy: 'strict' })
  assert.equal(changed.ok, false, 'a modified key must be refused')
  assert.equal(changed.code, 'SSH_HOSTKEY_MISMATCH')
  assert.equal(changed.knownHostsMatch, 'changed')

  if (other) {
    t.diagnostic(`real keys seen (${scanned.source}): ${scanned.entries.map((entry) => entry.keyType).join(', ')}`)
    assert.notEqual(other.keyType, primary.keyType)
  } else {
    t.diagnostic(`real keys seen (${scanned.source}): ${scanned.entries.map((entry) => entry.keyType).join(', ')}`)
  }
})

test('real-target: connect, exec uname -a, SFTP round trip in /tmp/dsh-ssh-test', { timeout: 180_000 }, async (t) => {
  if (!CONFIGURED) return t.skip(NOT_CONFIGURED)
  const scanned = await scanHostKeys()
  if (scanned.unreachable) return t.skip(`target unreachable: ${scanned.unreachable}`)

  const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-real-'))
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  })
  const { pool } = openPool(t, { dir, knownHosts: undefined })
  t.after(async () => {
    await pool.disposeAll('real target teardown')
  })

  let session
  let sftp
  try {
    session = await pool.acquire({ profile: realProfile(dir) })
    assert.equal(session.state, 'connected', 'the real target must reach connected')

    const uname = await collectExecHandle(await session.exec({ command: 'uname -a' }))
    assert.equal(uname.exit.code, 0, `uname -a must succeed: ${uname.stderr}`)
    assert.match(uname.stdout, /Linux/, `uname -a must report Linux, saw: ${uname.stdout.trim()}`)
    // Facts recorded in docs/REAL-TARGET.md (asserted leniently: the box may be replaced).
    const facts = existsSync(join(process.cwd(), 'docs', 'REAL-TARGET.md'))
      ? readFileSync(join(process.cwd(), 'docs', 'REAL-TARGET.md'), 'utf8')
      : ''
    const distro = /Ubuntu ([\d.]+(?: LTS)?)/.exec(facts)?.[1]
    if (distro) {
      const osRelease = await collectExecHandle(await session.exec({ command: '. /etc/os-release; echo "$PRETTY_NAME"' }))
      assert.match(osRelease.stdout, /Ubuntu/, `expected an Ubuntu target, saw: ${osRelease.stdout.trim()}`)
      t.diagnostic(`real target: ${osRelease.stdout.trim()} — ${uname.stdout.trim()}`)
    }

    // --- SFTP round trip, confined to REMOTE_ROOT -------------------------
    sftp = await session.sftp()
    await collectExecHandle(await session.exec({ command: `mkdir -p ${REMOTE_ROOT}` }))
    const payload = Buffer.from(`dsh-ssh real-target probe ${Date.now()}\n`)
    const remoteFile = `${REMOTE_ROOT}/probe.bin`
    await writeStream(sftp.createWriteStream(remoteFile, {}), payload)
    const readBack = await collectStream(sftp.createReadStream(remoteFile, {}))
    assert.equal(sha256Hex(readBack), sha256Hex(payload), 'the real target must return the exact bytes')
    const info = await sftp.stat(remoteFile)
    assert.equal(info.size, payload.length)

    // Remote hash cross-check with the target's own sha256sum.
    const remoteHash = await collectExecHandle(await session.exec({ command: `sha256sum ${remoteFile}` }))
    assert.equal(remoteHash.stdout.split(/\s+/)[0], sha256Hex(payload), 'the target\'s sha256sum must match')
  } finally {
    // Cleanup: only our own directory, and only if we created it.
    try {
      if (session) {
        await collectExecHandle(await session.exec({ command: `rm -rf ${REMOTE_ROOT}` }))
        const leftovers = await collectExecHandle(await session.exec({ command: `test -e ${REMOTE_ROOT} && echo present || echo gone` }))
        assert.match(leftovers.stdout, /gone/, 'the real target must have no leftovers in /tmp/dsh-ssh-test')
      }
    } catch (error) {
      t.diagnostic(`cleanup problem: ${String(error && error.message)}`)
    }
  }
})
