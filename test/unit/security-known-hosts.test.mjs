/**
 * Host-key verification: three policies, an OpenSSH-compatible file, and
 * OpenSSH-compatible fingerprints.
 *
 * The fingerprint vectors below were computed with Python's `hashlib` (not with
 * this implementation), so a padding or field-order mistake in `fingerprint()`
 * cannot make its own test pass:
 *
 *     blob = uint32be(11) + b'ssh-ed25519' + bytes([0xab]) * 32
 *     'SHA256:' + base64(sha256(blob)).rstrip('=')
 *     == 'SHA256:VIImOw9PvHstrwACuC2EC60teceLwKTMImRuoV170nY'
 *
 * Interoperability is the acceptance requirement here: the line we append must be
 * readable by a real `ssh` client, and the fingerprint we print must equal what
 * `ssh-keygen -lf` prints for the same key.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import {
  blobOf,
  createKnownHostsVerifier,
  entryMatchesHost,
  fingerprint,
  fingerprintMd5,
  hashHostName,
  hostKeyLookupName,
  isKnownKeyType,
  keyTypeOfBlob,
  knownHostsLine,
  parseKnownHosts,
} from '../../lib/known-hosts.js'

const KEY_A = blobOf('ssh-ed25519', Buffer.alloc(32, 0xab))
const KEY_B = blobOf('ssh-ed25519', Buffer.alloc(32, 0xcd))
const RSA_A = blobOf('ssh-rsa', Buffer.from(Array.from({ length: 64 }, (_, index) => index)))

const FP_A = 'SHA256:VIImOw9PvHstrwACuC2EC60teceLwKTMImRuoV170nY'
const FP_RSA_A = 'SHA256:ToD8Iej9ukLdbNT1oZTvHFwsvWZE6EtsxwBx3fC2fOw'

const root = mkdtempSync(join(tmpdir(), 'dsh-ssh-sec-kh-'))
after(() => rmSync(root, { recursive: true, force: true }))

let counter = 0
function tempFile(content) {
  counter += 1
  const file = join(root, `known_hosts_${counter}`)
  writeFileSync(file, content ?? '', 'utf8')
  return file
}

function verifierAt(file, options = {}) {
  return createKnownHostsVerifier({ file, policy: 'accept-new', ...options })
}

// ---------------------------------------------------------------------------
// Fingerprints (OpenSSH compatibility)
// ---------------------------------------------------------------------------

test('SHA256 fingerprints match an independently computed vector', () => {
  assert.equal(fingerprint('ssh-ed25519', KEY_A), FP_A)
  assert.equal(fingerprint('ssh-ed25519', RSA_A), FP_RSA_A, 'the type argument does not enter the hash')
  assert.match(FP_A, /^SHA256:[A-Za-z0-9+/]{43}$/, 'base64 without padding, as `ssh-keygen -lf` prints it')
  assert.equal(FP_A.includes('='), false)
})

test('MD5 fingerprints use the legacy colon form', () => {
  const md5 = fingerprintMd5('ssh-ed25519', KEY_A)
  assert.match(md5, /^MD5:([0-9a-f]{2}:){15}[0-9a-f]{2}$/)
})

test('a blob carries its own key type, and the guard list covers OpenSSH', () => {
  assert.equal(keyTypeOfBlob(KEY_A), 'ssh-ed25519')
  assert.equal(keyTypeOfBlob(RSA_A), 'ssh-rsa')
  assert.equal(keyTypeOfBlob(Buffer.alloc(2)), undefined)
  assert.ok(isKnownKeyType('ssh-ed25519'))
  assert.ok(isKnownKeyType('ecdsa-sha2-nistp256'))
  assert.ok(!isKnownKeyType('made-up-type'))
})

// ---------------------------------------------------------------------------
// Lookup names (OpenSSH: bare host for 22, [host]:port otherwise)
// ---------------------------------------------------------------------------

test('the lookup name follows the OpenSSH port convention', () => {
  assert.equal(hostKeyLookupName('Example.COM', 22), 'example.com')
  assert.equal(hostKeyLookupName('10.0.0.1', 2222), '[10.0.0.1]:2222')
  assert.equal(knownHostsLine('h', 22, 'ssh-ed25519', KEY_A), `h ssh-ed25519 ${KEY_A.toString('base64')}`)
  assert.equal(knownHostsLine('h', 2200, 'ssh-ed25519', KEY_A), `[h]:2200 ssh-ed25519 ${KEY_A.toString('base64')}`)
})

test('a written line re-parses and matches', () => {
  const line = knownHostsLine('h.example', 22, 'ssh-ed25519', KEY_A)
  const entries = parseKnownHosts(`${line}\n`)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].keyType, 'ssh-ed25519')
  assert.ok(entries[0].key.equals(KEY_A))
  assert.ok(entryMatchesHost(entries[0], ['h.example']))
  assert.equal(entryMatchesHost(entries[0], ['other.example']), false)
})

test('comments, blank lines and malformed lines are skipped', () => {
  const entries = parseKnownHosts(['# a comment', '', 'garbage', 'h ssh-ed25519', 'h ssh-ed25519 !!!not-base64!!!'].join('\n'))
  assert.equal(entries.length, 0)
})

// ---------------------------------------------------------------------------
// Policy: strict
// ---------------------------------------------------------------------------

test('strict refuses an unknown host with SSH_HOSTKEY_UNKNOWN', async () => {
  const file = tempFile()
  const verifier = verifierAt(file, { policy: 'strict' })
  const outcome = await verifier.verify({ host: 'new.example', port: 22, keyType: 'ssh-ed25519', key: KEY_A })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'SSH_HOSTKEY_UNKNOWN')
  assert.equal(outcome.knownHostsMatch, 'unknown')
  assert.equal(outcome.fingerprint, FP_A)
  assert.equal(readFileSync(file, 'utf8'), '', 'strict never writes')
})

test('strict accepts an exact match and reports the fingerprint', async () => {
  const file = tempFile(knownHostsLine('h.example', 22, 'ssh-ed25519', KEY_A) + '\n')
  const verifier = verifierAt(file, { policy: 'strict' })
  const outcome = await verifier.verify({ host: 'h.example', port: 22, keyType: 'ssh-ed25519', key: KEY_A })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.knownHostsMatch, 'exact')
  assert.equal(outcome.fingerprint, FP_A)
})

test('a changed key is refused by every policy', async () => {
  const file = tempFile(knownHostsLine('h.example', 22, 'ssh-ed25519', KEY_A) + '\n')
  for (const policy of ['strict', 'accept-new', 'insecure']) {
    const verifier = verifierAt(file, { policy })
    const outcome = await verifier.verify({ host: 'h.example', port: 22, keyType: 'ssh-ed25519', key: KEY_B })
    if (policy === 'insecure') {
      assert.equal(outcome.ok, true, 'insecure explicitly opts out of verification')
      continue
    }
    assert.equal(outcome.ok, false, `${policy} must refuse a changed key`)
    assert.equal(outcome.code, 'SSH_HOSTKEY_MISMATCH')
    assert.equal(outcome.knownHostsMatch, 'changed')
    assert.equal(outcome.fingerprint, fingerprint('ssh-ed25519', KEY_B), 'the presented key is reported, not the stored one')
  }
  assert.equal(readFileSync(file, 'utf8').includes(KEY_B.toString('base64')), false, 'a mismatch is never remembered')
})

test('a @revoked entry is refused even when the key matches', async () => {
  const file = tempFile(`@revoked h.example ssh-ed25519 ${KEY_A.toString('base64')}\n`)
  const verifier = verifierAt(file, { policy: 'accept-new' })
  const outcome = await verifier.verify({ host: 'h.example', port: 22, keyType: 'ssh-ed25519', key: KEY_A })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'SSH_HOSTKEY_MISMATCH')
  assert.match(String(outcome.detail), /revoked/)
  assert.equal(outcome.revoked, true, 'the flag the connection layer turns into a hard failure')
})

// SEMANTICS FLIP (F-SEC-04): before this change the assertion below was the
// opposite — a key of an unpinned *type* was reported as `unknown`, which let a
// second algorithm obtain trust-on-first-use on a host whose key was already
// pinned and write the wrong key into known_hosts. `changed` is the fix's goal,
// not a regression: see RECON-BRIEF/`_evidence/sec.md` F-SEC-04.
test('a different key type for a known host is a change, not a new host', async () => {
  const file = tempFile(knownHostsLine('h.example', 22, 'ssh-rsa', RSA_A) + '\n')
  const before = readFileSync(file, 'utf8')
  for (const policy of ['strict', 'accept-new']) {
    const verifier = verifierAt(file, { policy })
    const outcome = await verifier.verify({ host: 'h.example', port: 22, keyType: 'ssh-ed25519', key: KEY_A })
    assert.equal(outcome.ok, false, `${policy} must refuse a key of an unpinned type for a host it already knows`)
    assert.equal(outcome.code, 'SSH_HOSTKEY_MISMATCH', 'an unpinned algorithm is a replaced key, not a first sighting')
    assert.equal(outcome.knownHostsMatch, 'changed')
    assert.equal(outcome.fingerprint, FP_A, 'the presented key is reported, not the stored one')
    assert.equal(outcome.revoked, undefined, 'a type change is not a revocation: the prompt path stays available')
  }
  assert.equal(readFileSync(file, 'utf8'), before, 'a change is never remembered, not even under accept-new')
})

test('an @revoked entry for one key type blocks another key type for the same host', async () => {
  const file = tempFile(`@revoked h.example ssh-ed25519 ${KEY_A.toString('base64')}\n`)
  const before = readFileSync(file, 'utf8')
  const outcome = await verifierAt(file, { policy: 'accept-new' }).verify({ host: 'h.example', port: 22, keyType: 'ssh-rsa', key: RSA_A })
  assert.equal(outcome.ok, false, 'revocation is host-scoped, not algorithm-scoped')
  assert.equal(outcome.code, 'SSH_HOSTKEY_MISMATCH')
  assert.equal(outcome.knownHostsMatch, 'changed')
  assert.equal(outcome.fingerprint, FP_RSA_A)
  assert.match(String(outcome.detail), /revoked/)
  assert.equal(outcome.revoked, true, 'another algorithm must not be able to dodge a revocation')
  assert.equal(readFileSync(file, 'utf8'), before, 'a revoked host must never gain a second entry')
})

test('a revoked same-type key is still rejected', async () => {
  const file = tempFile(`@revoked h.example ssh-ed25519 ${KEY_A.toString('base64')}\n`)
  const before = readFileSync(file, 'utf8')
  const verifier = verifierAt(file, { policy: 'accept-new' })
  const revokedBytes = await verifier.verify({ host: 'h.example', port: 22, keyType: 'ssh-ed25519', key: KEY_A })
  assert.equal(revokedBytes.ok, false, 'the revoked key is refused even though it matches byte for byte')
  assert.equal(revokedBytes.code, 'SSH_HOSTKEY_MISMATCH')
  assert.equal(revokedBytes.knownHostsMatch, 'changed')
  assert.match(String(revokedBytes.detail), /revoked/)
  assert.equal(revokedBytes.revoked, true)
  const otherBytes = await verifier.verify({ host: 'h.example', port: 22, keyType: 'ssh-ed25519', key: KEY_B })
  assert.equal(otherBytes.ok, false, 'no key of a revoked host is accepted')
  assert.match(String(otherBytes.detail), /revoked/)
  assert.equal(otherBytes.revoked, true)
  assert.equal(readFileSync(file, 'utf8'), before)
})

test('a @revoked entry for another host does not block this one', async () => {
  const file = tempFile(`@revoked other.example ssh-ed25519 ${KEY_A.toString('base64')}\n`)
  const outcome = await verifierAt(file, { policy: 'accept-new' }).verify({ host: 'h.example', port: 22, keyType: 'ssh-ed25519', key: KEY_A })
  assert.equal(outcome.ok, true, 'revocation must not leak across hosts')
  assert.equal(outcome.knownHostsMatch, 'unknown')
  assert.equal(outcome.remembered, true)
  assert.equal(outcome.revoked, undefined)
})

// ---------------------------------------------------------------------------
// Policy: accept-new
// ---------------------------------------------------------------------------

test('accept-new accepts an unknown host and adds it to known_hosts', async () => {
  const file = tempFile()
  const verifier = verifierAt(file, { policy: 'accept-new' })
  const outcome = await verifier.verify({ host: 'New.Example', port: 22, keyType: 'ssh-ed25519', key: KEY_A })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.knownHostsMatch, 'unknown')
  assert.equal(outcome.remembered, true)
  const text = readFileSync(file, 'utf8')
  assert.equal(text, `new.example ssh-ed25519 ${KEY_A.toString('base64')}\n`, 'canonical lower-case name, one line, no extra fields')
  // The second verification is an exact match, so nothing is appended again.
  const again = await verifierAt(file, { policy: 'accept-new' }).verify({ host: 'new.example', port: 22, keyType: 'ssh-ed25519', key: KEY_A })
  assert.equal(again.ok, true)
  assert.equal(again.knownHostsMatch, 'exact')
  assert.equal(readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 1)
})

test('accept-new writes [host]:port entries for a non-default port', async () => {
  const file = tempFile()
  const verifier = verifierAt(file, { policy: 'accept-new' })
  await verifier.verify({ host: 'h.example', port: 2222, keyType: 'ssh-ed25519', key: KEY_A })
  assert.equal(readFileSync(file, 'utf8'), `[h.example]:2222 ssh-ed25519 ${KEY_A.toString('base64')}\n`)
})

test('a genuinely unknown host is still accepted under accept-new and remembered', async () => {
  // The file knows a *different* host: recognising a host is host-scoped, so this
  // one must still take the trust-on-first-use path.
  const file = tempFile(knownHostsLine('other.example', 22, 'ssh-rsa', RSA_A) + '\n')
  const outcome = await verifierAt(file, { policy: 'accept-new' }).verify({ host: 'h.example', port: 22, keyType: 'ssh-ed25519', key: KEY_A })
  assert.equal(outcome.ok, true, 'an entry for another host must not make this host "known"')
  assert.equal(outcome.knownHostsMatch, 'unknown')
  assert.equal(outcome.remembered, true)
  const text = readFileSync(file, 'utf8')
  assert.equal(text.split('\n').filter(Boolean).length, 2, 'the first-seen key is appended next to the other host')
  assert.ok(text.includes(knownHostsLine('h.example', 22, 'ssh-ed25519', KEY_A)))
  const again = await verifierAt(file, { policy: 'accept-new' }).verify({ host: 'h.example', port: 22, keyType: 'ssh-ed25519', key: KEY_A })
  assert.equal(again.knownHostsMatch, 'exact', 'the appended key is the one that is pinned')

  const strictFile = tempFile(knownHostsLine('other.example', 22, 'ssh-rsa', RSA_A) + '\n')
  const strict = await verifierAt(strictFile, { policy: 'strict' }).verify({ host: 'h.example', port: 22, keyType: 'ssh-ed25519', key: KEY_A })
  assert.equal(strict.code, 'SSH_HOSTKEY_UNKNOWN', 'strict still reports a genuinely unknown host as unknown')
})

test('a port-22 entry written as [host]:22 is still matched', async () => {
  const file = tempFile(`[h.example]:22 ssh-ed25519 ${KEY_A.toString('base64')}\n`)
  const outcome = await verifierAt(file, { policy: 'strict' }).verify({ host: 'h.example', port: 22, keyType: 'ssh-ed25519', key: KEY_A })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.knownHostsMatch, 'exact')
})

test('remember is idempotent and reports whether it wrote', async () => {
  const file = tempFile()
  const verifier = verifierAt(file)
  assert.equal(await verifier.rememberNew({ host: 'h', port: 22, keyType: 'ssh-ed25519', key: KEY_A }), true)
  assert.equal(await verifier.rememberNew({ host: 'h', port: 22, keyType: 'ssh-ed25519', key: KEY_A }), false)
  await verifier.remember({ host: 'h', port: 22, keyType: 'ssh-ed25519', key: KEY_A })
  assert.equal(readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 1)
  assert.equal(await verifier.knows({ host: 'h', port: 22, keyType: 'ssh-ed25519', key: KEY_A }), true)
  assert.equal(await verifier.knows({ host: 'h', port: 22, keyType: 'ssh-ed25519', key: KEY_B }), false)
})

// ---------------------------------------------------------------------------
// Policy: insecure
// ---------------------------------------------------------------------------

test('insecure accepts without reading or writing the file', async () => {
  const file = tempFile(knownHostsLine('h.example', 22, 'ssh-ed25519', KEY_A) + '\n')
  const verifier = verifierAt(file, { policy: 'insecure' })
  const outcome = await verifier.verify({ host: 'h.example', port: 22, keyType: 'ssh-ed25519', key: KEY_B })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.knownHostsMatch, 'unknown')
  assert.equal(outcome.policy, 'insecure')
  assert.equal(readFileSync(file, 'utf8').includes(KEY_B.toString('base64')), false)
})

// ---------------------------------------------------------------------------
// Wildcards, hashed entries, robustness
// ---------------------------------------------------------------------------

test('wildcards and negated patterns behave like OpenSSH', async () => {
  const wildcard = parseKnownHosts(`*.example.com ssh-ed25519 ${KEY_A.toString('base64')}\n`)
  assert.equal(entryMatchesHost(wildcard[0], ['a.example.com']), true)
  assert.equal(entryMatchesHost(wildcard[0], ['example.com']), false)
  const negated = parseKnownHosts(`!bad.example.com,*.example.com ssh-ed25519 ${KEY_A.toString('base64')}\n`)
  assert.equal(entryMatchesHost(negated[0], ['bad.example.com']), false)
  assert.equal(entryMatchesHost(negated[0], ['good.example.com']), true)
  const multi = parseKnownHosts(`host1,10.0.0.1 ssh-ed25519 ${KEY_A.toString('base64')}\n`)
  assert.equal(entryMatchesHost(multi[0], ['10.0.0.1']), true)
  assert.equal(entryMatchesHost(multi[0], ['host2']), false)
})

test('hashed known_hosts entries are read', async () => {
  const salt = Buffer.alloc(20, 7)
  const file = tempFile(`${hashHostName('h.example', salt)} ssh-ed25519 ${KEY_A.toString('base64')}\n`)
  const outcome = await verifierAt(file, { policy: 'strict' }).verify({ host: 'h.example', port: 22, keyType: 'ssh-ed25519', key: KEY_A })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.knownHostsMatch, 'exact')
  const miss = await verifierAt(file, { policy: 'strict' }).verify({ host: 'other.example', port: 22, keyType: 'ssh-ed25519', key: KEY_A })
  assert.equal(miss.ok, false)
})

test('HashKnownHosts-style writes stay readable by us and by OpenSSH', async () => {
  const file = tempFile()
  const verifier = verifierAt(file, { policy: 'accept-new', hashKnownHosts: true })
  await verifier.verify({ host: 'secret.example', port: 22, keyType: 'ssh-ed25519', key: KEY_A })
  const text = readFileSync(file, 'utf8')
  assert.match(text, /^\|1\|[A-Za-z0-9+/=]+\|[A-Za-z0-9+/=]+ ssh-ed25519 /)
  assert.equal(text.includes('secret.example'), false, 'a hashed file does not name the host')
  const outcome = await verifierAt(file, { policy: 'strict' }).verify({ host: 'secret.example', port: 22, keyType: 'ssh-ed25519', key: KEY_A })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.knownHostsMatch, 'exact')
})

test('an unwritable known_hosts never fails the connection', async () => {
  // A directory where the file should be: every append fails.
  const dir = join(root, 'as-directory')
  const blockers = []
  mkdirSync(dir, { recursive: true })
  const verifier = createKnownHostsVerifier({ file: dir, policy: 'accept-new', logger: { warn: (message, fields) => blockers.push([message, fields]) } })
  const outcome = await verifier.verify({ host: 'h', port: 22, keyType: 'ssh-ed25519', key: KEY_A })
  assert.equal(outcome.ok, true, 'accept-new still accepts; the key simply could not be persisted')
  assert.equal(outcome.remembered, false)
  assert.equal(blockers.length, 1)
  assert.equal(blockers[0][1].host, 'h')
})

test('an unreadable file reads as empty, which fails closed under strict', async () => {
  const dir = join(root, 'unreadable')
  mkdirSync(dir, { recursive: true })
  const outcome = await verifierAt(dir, { policy: 'strict' }).verify({ host: 'h', port: 22, keyType: 'ssh-ed25519', key: KEY_A })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'SSH_HOSTKEY_UNKNOWN')
})

test('a key appended in another process is picked up (mtime-keyed cache)', async () => {
  const file = tempFile()
  const verifier = verifierAt(file, { policy: 'strict' })
  assert.equal((await verifier.verify({ host: 'h', port: 22, keyType: 'ssh-ed25519', key: KEY_A })).ok, false)
  writeFileSync(file, `${knownHostsLine('h', 22, 'ssh-ed25519', KEY_A)}\n`, 'utf8')
  const outcome = await verifier.verify({ host: 'h', port: 22, keyType: 'ssh-ed25519', key: KEY_A })
  assert.equal(outcome.ok, true, 'the cache must not serve a stale empty file forever')
  assert.equal((await verifier.verify({ host: 'h', port: 22, keyType: 'ssh-ed25519', key: KEY_A })).knownHostsMatch, 'exact')
})

test('the schema default policy is applied when a question omits one', async () => {
  const file = tempFile(knownHostsLine('h', 22, 'ssh-ed25519', KEY_A) + '\n')
  const strict = createKnownHostsVerifier({ file, policy: 'strict' })
  assert.equal((await strict.verify({ host: 'other', port: 22, keyType: 'ssh-ed25519', key: KEY_A })).code, 'SSH_HOSTKEY_UNKNOWN')
  const insecure = createKnownHostsVerifier({ file, policy: 'insecure' })
  assert.equal((await insecure.verify({ host: 'other', port: 22, keyType: 'ssh-ed25519', key: KEY_A })).ok, true)
})
