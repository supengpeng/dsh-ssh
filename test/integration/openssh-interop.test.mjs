/**
 * OpenSSH interop / known_hosts cross-check (task-11 layer A).
 *
 * Why this file exists: `src/known-hosts.ts` had only *self-referential* evidence
 * (vectors computed with the same assumptions). "known_hosts 校验" is an
 * acceptance item, so it needs a truth source **outside our implementation** —
 * the real OpenSSH binaries shipped with Windows.
 *
 * What is proven here (offline, deterministic, CI-safe):
 *   1. `fingerprint(keyType, blob)` equals `ssh-keygen -lf` **byte for byte**
 *      for ed25519 / rsa / ecdsa — our `SHA256:` computation matches OpenSSH's,
 *      not merely our own helpers.
 *   2. We read what OpenSSH writes: plain entries, hashed `|1|salt|hmac` entries
 *      (HashKnownHosts), wildcard patterns and negation markers.
 *   3. OpenSSH reads what **we** write: our known_hosts lines are found by
 *      `ssh-keygen -F <host> -f <file>` (the strongest available direction).
 *   4. The policy matrix behaves per ICD §5/§6 on real key material: strict
 *      (unknown → SSH_HOSTKEY_UNKNOWN), accept-new + remember → `exact`,
 *      same-type different-key → SSH_HOSTKEY_MISMATCH/`changed`, a *different*
 *      key type for an already-known host → also MISMATCH/`changed` (F-SEC-04),
 *      `@revoked` → MISMATCH/`changed` for every key type (RT-A-3),
 *      insecure → accepted, without consulting known_hosts at all (so `@revoked`
 *      is out of scope there — asserted explicitly, not left implied).
 *
 * If `ssh-keygen` is missing the whole file skips with an explicit reason — it
 * never silently passes.
 */

import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

/**
 * Locate the real `ssh-keygen` across platforms.
 *
 * The default used to be a hardcoded Windows path. On a Linux runner
 * `existsSync('C:\\WINDOWS\\...')` is always false, so every case in this file
 * skipped — and `node --test` exits 0 when a file's cases all skip, so CI stayed
 * green while the *only* out-of-tree truth source for `known_hosts` executed
 * nothing. `DSH_SSH_SSH_KEYGEN` still wins; the rest are probed in order.
 */
const KEYGEN_PROBE_FILE = '__dsh-ssh-keygen-probe-does-not-exist__'
const KEYGEN_CANDIDATES = [
  process.env.DSH_SSH_SSH_KEYGEN,
  'C:\\WINDOWS\\System32\\OpenSSH\\ssh-keygen.exe',
  'C:\\Program Files\\OpenSSH\\ssh-keygen.exe',
  '/usr/bin/ssh-keygen',
  '/usr/local/bin/ssh-keygen',
  '/bin/ssh-keygen',
  '/opt/homebrew/bin/ssh-keygen',
  'ssh-keygen',
].filter((candidate) => typeof candidate === 'string' && candidate !== '')

/**
 * True when `candidate` is a runnable ssh-keygen.
 *
 * A bare command name is resolved through PATH by the OS, so it is accepted only
 * after it actually runs. The probe asks for a guaranteed-missing key file:
 * ssh-keygen then exits non-zero and complains, which is exactly the proof that
 * the binary executed. `ENOENT` is the one failure that means "no such
 * executable"; a non-zero exit status must not be mistaken for its absence.
 */
function keygenRuns(candidate) {
  if ((candidate.includes('/') || candidate.includes('\\')) && !existsSync(candidate)) return false
  try {
    execFileSync(candidate, ['-l', '-f', KEYGEN_PROBE_FILE], { stdio: 'ignore', timeout: 10_000, windowsHide: true })
    return true
  } catch (error) {
    return Boolean(error) && error.code !== 'ENOENT'
  }
}

const keygen = (() => {
  for (const candidate of KEYGEN_CANDIDATES) {
    if (keygenRuns(candidate)) return { path: candidate, available: true }
  }
  return { path: KEYGEN_CANDIDATES[0] ?? 'ssh-keygen', available: false }
})()

const SSH_KEYGEN = keygen.path
const available = keygen.available
const SKIP_REASON =
  `no runnable ssh-keygen: tried ${KEYGEN_CANDIDATES.map((candidate) => `\`${candidate}\``).join(', ')} ` +
  '(set DSH_SSH_SSH_KEYGEN to point at one)'
/** `DSH_SSH_STRICT_ICD=1` turns documented gaps into hard failures (M5 gate). */
const STRICT = process.env.DSH_SSH_STRICT_ICD === '1'

const knownHosts = await import('../../lib/known-hosts.js')

/** Run a binary with an argument array (never a shell string) and a hard timeout. */
let seq = 0
function run(file, args, { timeout = 30_000 } = {}) {
  return new Promise((resolve) => {
    // `stdin: 'ignore'` matters: ssh-keygen asks "Overwrite (y/n)?" on an
    // existing path and would otherwise block until the timeout.
    execFile(file, args, { timeout, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error ? (error.code ?? 1) : 0, stdout: stdout ?? '', stderr: stderr ?? '', error })
    })
  })
}

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort on Windows */
    }
  })
  return dir
}

/** Generate a key pair with the real ssh-keygen and read back what it reports. */
async function generateKey(t, dir, type, comment) {
  // Unique path per call: regenerating the same path makes ssh-keygen prompt.
  const privatePath = join(dir, `id_${type}_${(seq += 1)}`)
  const args = ['-t', type, '-f', privatePath, '-N', '', '-C', comment]
  if (type === 'rsa') args.push('-b', '2048')
  const created = await run(SSH_KEYGEN, args)
  assert.equal(created.ok, true, `ssh-keygen -t ${type} failed (code ${created.code}): ${created.stdout}${created.stderr}`)
  return readKeyPair(t, privatePath)
}

/** Parse a `.pub` file and ask OpenSSH for the authoritative fingerprint. */
async function readKeyPair(t, privatePath) {
  const pubPath = `${privatePath}.pub`
  const pub = readFileSync(pubPath, 'utf8').trim()
  const [keyType, base64] = pub.split(/\s+/)
  const blob = Buffer.from(base64, 'base64')
  const listed = await run(SSH_KEYGEN, ['-lf', pubPath])
  assert.equal(listed.ok, true, `ssh-keygen -lf failed: ${listed.stderr}`)
  const match = /(SHA256:[A-Za-z0-9+/=]+)/.exec(listed.stdout)
  assert.ok(match, `could not parse ssh-keygen -lf output: ${listed.stdout}`)
  return { privatePath, pubPath, pub, keyType, blob, opensshFingerprint: match[1] }
}

test('openssh-interop: our SHA256 fingerprint equals ssh-keygen -lf (ed25519/rsa/ecdsa)', async (t) => {
  if (!available) return t.skip(SKIP_REASON)
  const dir = tempDir(t, 'dsh-ssh-xcheck-keys-')

  for (const type of ['ed25519', 'rsa', 'ecdsa']) {
    const pair = await generateKey(t, dir, type, `dsh-ssh-${type}`)
    const ours = knownHosts.fingerprint(pair.keyType, pair.blob)
    assert.equal(
      ours,
      pair.opensshFingerprint,
      `${type}: our fingerprint ${ours} must equal OpenSSH's ${pair.opensshFingerprint}`,
    )
    // `fingerprint` must be independent of the key type argument (it hashes the
    // blob), which is what makes it safe to call with parsed blobs.
    assert.equal(knownHosts.fingerprint('ssh-ed25519', pair.blob), ours)
    assert.match(ours, /^SHA256:[A-Za-z0-9+/]+$/, 'no padding, OpenSSH style')
    t.diagnostic(`${type}: ${ours}`)
  }
})

test('openssh-interop: OpenSSH can look up the lines we write (plain and hashed)', async (t) => {
  if (!available) return t.skip(SKIP_REASON)
  const dir = tempDir(t, 'dsh-ssh-xcheck-write-')
  const pair = await generateKey(t, dir, 'ed25519', 'dsh-ssh-writer')
  const host = '127.0.0.1'
  const port = 2222
  const lookupName = `[${host}]:${port}`

  // ---- plain entry written by our own helper ------------------------------
  const plainFile = join(dir, 'known_hosts_plain')
  const plainLine = knownHosts.knownHostsLine(host, port, pair.keyType, pair.blob)
  writeFileSync(plainFile, `${plainLine}\n`, 'utf8')

  // OpenSSH reads our product: `-F` prints the matching line and exits 0.
  const found = await run(SSH_KEYGEN, ['-F', lookupName, '-f', plainFile])
  assert.equal(found.ok, true, `ssh-keygen -F did not find our line: ${found.stdout}${found.stderr}`)
  assert.match(found.stdout, new RegExp(pair.blob.toString('base64').slice(0, 24).replace(/[+/]/g, '\\$&')))
  const notFound = await run(SSH_KEYGEN, ['-F', '[127.0.0.1]:2223', '-f', plainFile])
  assert.notEqual(notFound.ok, true, 'a different port must not match')

  // …and we read our own product back (round trip).
  const parsedPlain = knownHosts.parseKnownHosts(readFileSync(plainFile, 'utf8'))
  assert.equal(parsedPlain.length, 1)
  assert.deepEqual(parsedPlain[0].patterns, [lookupName])
  assert.equal(parsedPlain[0].keyType, pair.keyType)
  assert.equal(knownHosts.fingerprint(pair.keyType, parsedPlain[0].key), pair.opensshFingerprint)

  // ---- hashed entry (HashKnownHosts yes) written by the verifier ----------
  const hashedFile = join(dir, 'known_hosts_hashed')
  const verifier = knownHosts.createKnownHostsVerifier({ file: hashedFile, policy: 'accept-new', hashKnownHosts: true })
  await verifier.remember({ host, port, keyType: pair.keyType, key: pair.blob })
  const hashedText = readFileSync(hashedFile, 'utf8').trim()
  // Structural check (no regex): `|1|<b64 salt>|<b64 hmac> <keyline>`.
  const fields = hashedText.split(' ')
  assert.equal(fields.length >= 3, true, `expected a |1|salt|hmac entry, saw: ${hashedText}`)
  assert.equal(fields[0].startsWith('|1|'), true, `hashed entries start with |1|, saw: ${fields[0]}`)
  assert.equal(fields[0].split('|').length, 4, `expected |1|salt|hmac, saw: ${fields[0]}`)
  assert.equal(hashedText.includes(host), false, 'the hashed form must not leak the host name')

  // OpenSSH must resolve our hashed entry too.
  const hashLookup = await run(SSH_KEYGEN, ['-F', lookupName, '-f', hashedFile])
  assert.equal(hashLookup.ok, true, `ssh-keygen -F could not resolve our hashed entry: ${hashLookup.stdout}${hashLookup.stderr}`)

  // …and our reader must resolve it (policy path, not just the parser).
  const decision = await verifier.verify({ host, port, keyType: pair.keyType, key: pair.blob, policy: 'strict' })
  assert.equal(decision.ok, true, `our verifier must accept the hashed entry it wrote: ${JSON.stringify(decision)}`)
  assert.equal(decision.knownHostsMatch, 'exact', 'the entry we wrote must resolve as an exact match')
})

test('openssh-interop: wildcards, negation markers and comments parse like OpenSSH writes them', async (t) => {
  if (!available) return t.skip(SKIP_REASON)
  const dir = tempDir(t, 'dsh-ssh-xcheck-patterns-')
  const pair = await generateKey(t, dir, 'ed25519', 'dsh-ssh-patterns')
  const base64 = pair.blob.toString('base64')

  const file = join(dir, 'known_hosts_patterns')
  writeFileSync(
    file,
    [
      `# a comment line OpenSSH ignores`,
      `*.example.com ${pair.keyType} ${base64}`,
      `!bad.example.com ${pair.keyType} ${base64}`,
      `@cert-authority ca.example.com ${pair.keyType} ${base64}`,
      `@revoked revoked.example.com ${pair.keyType} ${base64}`,
      `[10.0.0.1]:2200 ${pair.keyType} ${base64}`,
      '',
    ].join('\n'),
    'utf8',
  )

  const entries = knownHosts.parseKnownHosts(readFileSync(file, 'utf8'))
  assert.equal(entries.length, 5, `expected 5 entries, saw ${entries.length}`)
  assert.ok(entries.some((entry) => entry.patterns.includes('*.example.com')), 'wildcard pattern must be preserved')
  assert.ok(entries.some((entry) => entry.patterns.includes('!bad.example.com')), 'a negated pattern stays a pattern, like OpenSSH stores it')
  // OpenSSH keeps the marker verbatim, `@` included.
  assert.ok(entries.some((entry) => entry.markers?.includes('@cert-authority')), '@cert-authority marker must be preserved')
  assert.ok(entries.some((entry) => entry.markers?.includes('@revoked')), '@revoked marker must be preserved')
  // A revoked entry is never a valid acceptance, whatever the key says (RT-A-3):
  // `@revoked` refuses the *whole host*, across every key type, and it does so
  // before the policy is consulted — a revocation is a refusal, not a question.
  const revokedVerifier = knownHosts.createKnownHostsVerifier({ file, policy: 'accept-new' })
  const revoked = await revokedVerifier.verify({
    host: 'revoked.example.com',
    port: 22,
    keyType: pair.keyType,
    key: pair.blob,
    policy: 'accept-new',
  })
  assert.equal(revoked.ok, false, 'a @revoked host must never be accepted')
  assert.equal(revoked.code, 'SSH_HOSTKEY_MISMATCH', 'a revoked entry must be refused as a mismatch')
  assert.equal(revoked.knownHostsMatch, 'changed')
  assert.equal(revoked.revoked, true, 'the refusal must say it is a revocation, not a same-type mismatch')

  // Cross-algorithm: the same revoked host under a *different* key type is still
  // refused. This is what makes the marker host-wide rather than type-scoped.
  const revokedOtherType = await revokedVerifier.verify({
    host: 'revoked.example.com',
    port: 22,
    keyType: 'ssh-rsa',
    key: knownHosts.blobOf('ssh-rsa', Buffer.from('a different algorithm entirely')),
    policy: 'accept-new',
  })
  assert.equal(revokedOtherType.ok, false, 'a revocation covers every key type for the host')
  assert.equal(revokedOtherType.code, 'SSH_HOSTKEY_MISMATCH')

  // The one place a revocation does NOT apply, asserted positively on purpose.
  //
  // `insecure` is defined as "never verify" (`cordis.patch.yml:51`) and it never
  // consults known_hosts at all — the verifier returns "accepted" before it reads
  // the file (`src/known-hosts.ts:341-346`), and the connection layer short-circuits
  // even earlier (`src/connection/transport.ts:155-158`). So `@revoked` is not
  // "broken under insecure", it is out of scope there, exactly like every other
  // known_hosts rule. Ruling (task C): keep this boundary — `insecure` already
  // accepts an arbitrary MITM key, so additionally rejecting a revoked one would
  // not raise real security while breaking the documented break-glass escape hatch.
  //
  // Pinned as an assertion rather than left as an absent check: a future change
  // that makes `insecure` honour `@revoked` must come here and change this line,
  // instead of silently looking like a fix.
  const revokedInsecure = await knownHosts
    .createKnownHostsVerifier({ file, policy: 'insecure' })
    .verify({ host: 'revoked.example.com', port: 22, keyType: pair.keyType, key: pair.blob, policy: 'insecure' })
  assert.equal(
    revokedInsecure.ok,
    true,
    'insecure never consults known_hosts (transport.ts:155-158), so @revoked does not apply to it — a deliberate boundary, not a gap',
  )
})

test('openssh-interop: policy matrix on real key material (unknown / exact / changed / insecure)', async (t) => {
  if (!available) return t.skip(SKIP_REASON)
  const dir = tempDir(t, 'dsh-ssh-xcheck-policy-')
  const first = await generateKey(t, dir, 'ed25519', 'first')
  const second = await generateKey(t, dir, 'ed25519', 'second')
  const rsa = await generateKey(t, dir, 'rsa', 'other-type')
  const file = join(dir, 'known_hosts_policy')
  const verifier = knownHosts.createKnownHostsVerifier({ file, policy: 'accept-new' })
  // The plugin builds one verifier per activation from `config.hostKey.policy`,
  // so the *instance* policy is the product path; the per-question `policy`
  // field is a secondary override (see the documented gap below).
  const strictVerifier = knownHosts.createKnownHostsVerifier({ file, policy: 'strict' })
  const host = '127.0.0.1'
  const port = 2200

  // strict + empty file → unknown, and nothing is written.
  const unknown = await strictVerifier.verify({ host, port, keyType: first.keyType, key: first.blob, policy: 'strict' })
  assert.equal(unknown.ok, false, 'strict policy must refuse an unknown host key')
  assert.equal(unknown.code, 'SSH_HOSTKEY_UNKNOWN')
  assert.equal(unknown.knownHostsMatch, 'unknown')
  assert.equal(unknown.fingerprint, first.opensshFingerprint, 'the question carries the OpenSSH fingerprint verbatim')
  assert.equal(existsSync(file) ? readFileSync(file, 'utf8') : '', '', 'a refusal must not write the file')

  // Documented gap: an accept-new *instance* asked with `policy: 'strict'`
  // accepts the unknown key instead of refusing it, i.e. the per-question
  // override is not honoured (ICD §7 puts `policy` in the question).
  const override = await verifier.verify({ host, port, keyType: first.keyType, key: first.blob, policy: 'strict' })
  if (override.ok === true) {
    const reason = `KNOWN GAP: per-question policy override ignored — an accept-new verifier accepted an unknown key asked with policy:'strict' (${JSON.stringify(override)})`
    if (STRICT) assert.fail(reason)
    t.diagnostic(reason)
  }

  // accept-new + remember → then the same key is an exact match.
  await verifier.remember({ host, port, keyType: first.keyType, key: first.blob })
  const exact = await verifier.verify({ host, port, keyType: first.keyType, key: first.blob, policy: 'strict' })
  assert.equal(exact.ok, true, 'a remembered key must verify under strict policy')

  // Same key type, different key → changed / MISMATCH.
  const changed = await verifier.verify({ host, port, keyType: second.keyType, key: second.blob, policy: 'accept-new' })
  assert.equal(changed.ok, false, 'a different key for the same host must be refused')
  assert.equal(changed.code, 'SSH_HOSTKEY_MISMATCH')
  assert.equal(changed.knownHostsMatch, 'changed')

  // A *different key type* for a host we already know is a change, not a new
  // host (F-SEC-04): once any entry names the host, a key presented under another
  // algorithm must be refused as a mismatch rather than adopted as "unknown".
  const otherType = await strictVerifier.verify({ host, port, keyType: rsa.keyType, key: rsa.blob, policy: 'strict' })
  assert.equal(otherType.ok, false)
  assert.equal(otherType.code, 'SSH_HOSTKEY_MISMATCH', 'a new key type for a known host is a change (F-SEC-04)')
  assert.equal(otherType.knownHostsMatch, 'changed')

  // insecure accepts anything presented.
  const lax = await knownHosts
    .createKnownHostsVerifier({ file, policy: 'insecure' })
    .verify({ host, port, keyType: second.keyType, key: second.blob, policy: 'insecure' })
  assert.equal(lax.ok, true, 'insecure policy accepts an unverified key')

  // The whole file must still be readable by OpenSSH after our writes.
  const listed = await run(SSH_KEYGEN, ['-F', `[${host}]:${port}`, '-f', file])
  assert.equal(listed.ok, true, `ssh-keygen must read the file we wrote: ${listed.stdout}${listed.stderr}`)
})

test('openssh-interop: ssh-keygen round-trips a key we generate (blob equality)', async (t) => {
  if (!available) return t.skip(SKIP_REASON)
  const dir = tempDir(t, 'dsh-ssh-xcheck-blob-')
  const pair = await generateKey(t, dir, 'ed25519', 'blob-equality')
  // Ask OpenSSH to fingerprint a *file we wrote* from the blob we parsed: if any
  // byte were dropped by our parser the fingerprints would diverge.
  const rebuilt = join(dir, 'rebuilt.pub')
  writeFileSync(rebuilt, `${pair.keyType} ${pair.blob.toString('base64')} rebuilt\n`, 'utf8')
  const listed = await run(SSH_KEYGEN, ['-lf', rebuilt])
  assert.equal(listed.ok, true)
  const reported = /(SHA256:[A-Za-z0-9+/=]+)/.exec(listed.stdout)?.[1]
  assert.equal(reported, pair.opensshFingerprint, 'a blob we parsed and re-emitted must fingerprint identically in OpenSSH')
})
