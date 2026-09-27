/**
 * Adversarial redaction tests.
 *
 * The acceptance criterion "凭据不在日志与 UI 明文中出现" is only credible if it holds
 * for the shapes a secret actually reaches a log line in. A literal `split/join`
 * passes a naive test and leaks everything below, so each case here is a shape
 * that has defeated a naive implementation somewhere:
 *
 *   URL userinfo · stack trace · embedded JSON string · base64 blob ·
 *   percent-encoded · hex · substring of a longer token · split across fields ·
 *   PEM block · `Authorization:` header · `password=` in a query string
 *
 * Plus the invariants that make the mask trustworthy: it never varies with the
 * secret's length, scrubbing is idempotent, and the input is never mutated.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  SECRET_MASK,
  createRedactor,
  keyNameSegments,
  matchesRedactKey,
  normalizeKeyName,
  scrubOnce,
  spellingsOf,
} from '../../lib/redact.js'

const PASSWORD = 'hunter2!'
const LONG_PASSWORD = 'correct-horse-battery-staple-1234567890'

/** Every assertion in this file reduces to "the secret is not in the output". */
function assertNoSecret(output, secret, label) {
  const text = typeof output === 'string' ? output : JSON.stringify(output)
  assert.ok(!text.includes(secret), `${label}: leaked the secret in ${text}`)
}

// ---------------------------------------------------------------------------
// Layer 1: structured keys
// ---------------------------------------------------------------------------

test('a secret-named key is masked whatever its value type', () => {
  const redactor = createRedactor()
  const scrubbed = redactor.scrub({
    user: 'root',
    password: PASSWORD,
    passphrase: 'key-pass',
    privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----',
    API_KEY: 'sk-live-123',
    Authorization: 'Bearer abc',
    nested: { 'db.password': 'p', connectionString: 'postgres://u:p@h/db' },
  })
  assert.equal(scrubbed.user, 'root')
  assert.equal(scrubbed.password, SECRET_MASK)
  assert.equal(scrubbed.passphrase, SECRET_MASK)
  assert.equal(scrubbed.privateKey, SECRET_MASK)
  assert.equal(scrubbed.API_KEY, SECRET_MASK)
  assert.equal(scrubbed.Authorization, SECRET_MASK)
  assert.equal(scrubbed.nested['db.password'], SECRET_MASK)
  assert.equal(scrubbed.nested.connectionString, 'postgres://u:••••••••@h/db', 'a connection string is a leak vector, not an exception')
})

test('key matching respects word boundaries for short patterns', () => {
  const redactor = createRedactor()
  const scrubbed = redactor.scrub({
    monkey: 'not a secret',
    keys: ['profile-a', 'profile-b'],
    keyboardLayout: 'us',
    privateKeyPath: '/home/u/.ssh/id_ed25519',
    passwordHash: 'deadbeef',
    jsonWebToken: 'x.y.z',
  })
  assert.equal(scrubbed.monkey, 'not a secret')
  assert.deepEqual(scrubbed.keys, ['profile-a', 'profile-b'])
  assert.equal(scrubbed.keyboardLayout, 'us')
  assert.equal(scrubbed.privateKeyPath, SECRET_MASK)
  assert.equal(scrubbed.passwordHash, SECRET_MASK)
  assert.equal(scrubbed.jsonWebToken, SECRET_MASK)
})

test('null and empty values stay as they are; nothing is invented', () => {
  const scrubbed = createRedactor().scrub({ password: null, passphrase: '', other: 'x' })
  assert.equal(scrubbed.password, null)
  assert.equal(scrubbed.passphrase, '')
})

test('key names are compared delimiter- and camelCase-insensitively', () => {
  assert.equal(normalizeKeyName('Private_Key'), 'privatekey')
  assert.deepEqual(keyNameSegments('privateKey'), ['private', 'key'])
  assert.deepEqual(keyNameSegments('private_key'), ['private', 'key'])
  assert.deepEqual(keyNameSegments('monkey'), ['monkey'])
  assert.ok(matchesRedactKey('private_key', ['privateKey']))
  assert.ok(matchesRedactKey('api_key', ['apiKey']))
  assert.ok(!matchesRedactKey('monkey', ['key']))
})

// ---------------------------------------------------------------------------
// Layer 2 + 3: the adversarial shapes
// ---------------------------------------------------------------------------

test('a secret inside a URL is masked, tracked or not', () => {
  const tracked = createRedactor()
  tracked.track(PASSWORD)
  const withTrack = tracked.scrub({ url: `ssh://root:${PASSWORD}@10.0.0.1:22` })
  assertNoSecret(withTrack, PASSWORD, 'URL with a tracked secret')
  assert.match(withTrack.url, /^ssh:\/\/root:•{8}@10\.0\.0\.1:22$/)

  // Untracked: nothing told the redactor what the secret is, so only the shape
  // can save us.
  const untracked = scrubOnce('postgres://app:s3cr3t-pw@db.internal:5432/app')
  assertNoSecret(untracked, 's3cr3t-pw', 'URL without tracking')
  assert.equal(untracked, 'postgres://app:••••••••@db.internal:5432/app')
})

test('a secret inside a stack trace is masked, tracked or not', () => {
  const redactor = createRedactor()
  redactor.track(PASSWORD)
  const error = new Error(`connect failed for root@host (password ${PASSWORD})`)
  const scrubbed = redactor.scrub(error)
  assert.ok(scrubbed instanceof Error, 'an Error stays an Error')
  assertNoSecret(String(scrubbed.message), PASSWORD, 'error message')
  assertNoSecret(String(scrubbed.stack), PASSWORD, 'error stack')

  const untracked = scrubOnce('Error: auth failed\n    at connect (auth.js:1:1)\n  password=hunter2!')
  assertNoSecret(untracked, PASSWORD, 'stack string without tracking')
})

test('a secret inside an embedded JSON string is masked', () => {
  const payload = '{"user":"root","auth":{"password":"hunter2!","method":"password"}}'
  const scrubbed = scrubOnce(payload)
  assertNoSecret(scrubbed, PASSWORD, 'embedded JSON')
  assert.match(scrubbed, /"password":"•{8}"/)
  assert.match(scrubbed, /"user":"root"/, 'non-secret fields survive')
})

test('a secret inside a base64 blob is masked by decoding the blob', () => {
  const redactor = createRedactor()
  redactor.track(LONG_PASSWORD)
  const blob = Buffer.from(`session-token=${LONG_PASSWORD};expires=1h`, 'utf8').toString('base64')
  const scrubbed = redactor.scrub({ note: `payload ${blob} end` })
  assertNoSecret(scrubbed, LONG_PASSWORD, 'base64 blob')
  assert.match(scrubbed.note, /payload •{8} end/)

  // The blob alone would also survive a naive literal match when the secret is
  // embedded mid-stream (base64 of a prefix is not a prefix of the base64).
  const raw = Buffer.from(`x${LONG_PASSWORD}`, 'utf8').toString('base64')
  const viaRaw = scrubOnce(`raw=${raw}`, { track: [LONG_PASSWORD] })
  assertNoSecret(viaRaw, LONG_PASSWORD, 'raw base64 spelling')
})

test('a hex-encoded secret is masked', () => {
  const secret = 'swordfish-42'
  const hex = Buffer.from(secret, 'utf8').toString('hex')
  const viaSpelling = scrubOnce(`key=${hex}`, { track: [secret] })
  assertNoSecret(viaSpelling, secret, 'tracked hex spelling')
  const decoded = scrubOnce(`key=${Buffer.from(`prefix-${secret}-suffix`).toString('hex')}`, { track: [secret] })
  assertNoSecret(decoded, secret, 'hex blob decoded')
})

test('a secret is masked as a substring of a longer token', () => {
  const redactor = createRedactor()
  redactor.track('hunter2')
  const scrubbed = redactor.scrub('Authorization: Bearer prefix-hunter2-suffix')
  assertNoSecret(scrubbed, 'hunter2', 'substring')
  const joined = redactor.scrub({ token: 'aahunter2zz', note: 'hunter2' })
  assertNoSecret(joined, 'hunter2', 'multiple occurrences')
})

test('a secret split across adjacent fields is masked in both halves', () => {
  const redactor = createRedactor()
  redactor.track('swordfish')
  const split = redactor.scrub({ firstHalf: 'sword', secondHalf: 'fish', note: 'ok' })
  assert.equal(split.firstHalf, SECRET_MASK)
  assert.equal(split.secondHalf, SECRET_MASK)
  assert.equal(split.note, 'ok')
  // The concatenation is what matters: neither field alone contains the secret.
  assert.equal(`${split.firstHalf}${split.secondHalf}`.includes('swordfish'), false)
})

test('a percent-encoded secret is masked', () => {
  const secret = 'p@ss word!'
  const encoded = encodeURIComponent(secret)
  assert.notEqual(encoded, secret)
  const scrubbed = scrubOnce(`GET /?pw=${encoded} HTTP/1.1`, { track: [secret] })
  assertNoSecret(scrubbed, secret, 'percent-encoded value')
  assertNoSecret(scrubbed, encoded, 'percent-encoded spelling')
})

test('secret-shaped patterns nobody registered are still masked', () => {
  const bearer = scrubOnce('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def')
  assertNoSecret(bearer, 'eyJhbGciOiJIUzI1NiJ9.abc.def', 'bearer token')
  const query = scrubOnce('GET /login?user=root&password=hunter2!&next=/')
  assertNoSecret(query, PASSWORD, 'query parameter')
  const cli = scrubOnce('ssh -o StrictHostKeyChecking=no -p hunter2! root@host')
  assertNoSecret(cli, PASSWORD, 'CLI flag')
  const proxyAuth = scrubOnce('proxy-authorization=Basic dXNlcjpwYXNz')
  assertNoSecret(proxyAuth, 'dXNlcjpwYXNz', 'proxy authorization')
})

test('a PEM private key block is masked whole', () => {
  const pem = ['-----BEGIN OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmU', '-----END OPENSSH PRIVATE KEY-----'].join('\n')
  const scrubbed = scrubOnce(`key:\n${pem}\ndone`)
  assert.equal(scrubbed.includes('BEGIN OPENSSH PRIVATE KEY'), false)
  assert.match(scrubbed, /key:\n•{8}\ndone/)
})

test('the mask never reveals the secret length', () => {
  const redactor = createRedactor()
  redactor.track('abc')
  redactor.track(LONG_PASSWORD)
  const short = redactor.scrub('abc')
  const long = redactor.scrub(LONG_PASSWORD)
  assert.equal(short, SECRET_MASK)
  assert.equal(long, SECRET_MASK)
  assert.equal(short.length, 8)
  assert.equal(SECRET_MASK, '••••••••', 'the frozen 8-dot mask (ICD §4.2)')
})

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

test('scrub never mutates its input', () => {
  const redactor = createRedactor()
  redactor.track(PASSWORD)
  const input = { password: PASSWORD, nested: { url: `ssh://u:${PASSWORD}@h` }, list: [PASSWORD] }
  const before = JSON.parse(JSON.stringify(input))
  const output = redactor.scrub(input)
  assert.deepEqual(input, before, 'the input is untouched')
  assert.notEqual(output, input)
  assertNoSecret(output, PASSWORD, 'output')
})

test('scrub tolerates cycles and preserves container types', () => {
  const redactor = createRedactor()
  redactor.track(PASSWORD)
  const cyclic = { name: 'a', password: PASSWORD }
  cyclic.self = cyclic
  const scrubbed = redactor.scrub(cyclic)
  assert.equal(scrubbed.self, scrubbed, 'the cycle is preserved, not infinite')
  assert.equal(scrubbed.password, SECRET_MASK)

  const date = new Date(0)
  const buffer = Buffer.from('plain text')
  const map = new Map([['password', PASSWORD]])
  const set = new Set([PASSWORD])
  const out = redactor.scrub({ date, buffer, map, set })
  assert.ok(out.date instanceof Date)
  assert.equal(out.date.getTime(), 0)
  assert.ok(Buffer.isBuffer(out.buffer))
  assert.ok(out.map instanceof Map)
  assert.equal(out.map.get('password'), SECRET_MASK, 'a Map value is walked')
  assert.ok(out.set instanceof Set)
  assert.equal([...out.set][0], SECRET_MASK, 'a Set element is walked')
})

test('scrubbing is idempotent', () => {
  const redactor = createRedactor()
  redactor.track(PASSWORD)
  const once = redactor.scrub({ password: PASSWORD, url: `ssh://u:${PASSWORD}@h`, note: 'password=x' })
  const twice = redactor.scrub(once)
  assert.deepEqual(twice, once)
})

test('extra carries one-shot literals and one-shot key patterns', () => {
  const redactor = createRedactor()
  // `extra`'s values are treated as literals for this call only...
  assert.equal(redactor.scrub('value is abc123', { someName: 'abc123' }), 'value is ••••••••')
  assert.equal(redactor.scrub('value is abc123'), 'value is abc123', 'the literal was not remembered')
  // ...and its keys as additional secret-shaped names.
  const scrubbed = redactor.scrub({ customField: 'x', untouched: 'y' }, { customField: '' })
  assert.equal(scrubbed.customField, SECRET_MASK)
  assert.equal(scrubbed.untouched, 'y')
})

test('redaction can be disabled, and redactKeys can be replaced', () => {
  const disabled = createRedactor({ enabled: false })
  disabled.track(PASSWORD)
  const value = { password: PASSWORD }
  assert.equal(disabled.scrub(value), value, 'a disabled redactor is the identity function')

  const custom = createRedactor({ redactKeys: ['custom'] })
  const scrubbed = custom.scrub({ custom: 'a', password: 'b' })
  assert.equal(scrubbed.custom, SECRET_MASK)
  assert.equal(scrubbed.password, 'b')
})

test('forgetAll stops literal matching but keeps key-name matching', () => {
  const redactor = createRedactor()
  redactor.track(PASSWORD)
  assert.equal(redactor.trackedCount, 1)
  redactor.forgetAll()
  assert.equal(redactor.trackedCount, 0)
  assert.equal(redactor.scrub(PASSWORD), PASSWORD, 'the literal is no longer known')
  assert.equal(redactor.scrub({ password: PASSWORD }).password, SECRET_MASK, 'the key name still is')
})

test('tracked spellings cover the encodings a secret escapes through', () => {
  const spellings = spellingsOf('p@ss word42')
  assert.ok(spellings.includes('p@ss word42'))
  assert.ok(spellings.includes(encodeURIComponent('p@ss word42')))
  assert.ok(spellings.includes(Buffer.from('p@ss word42').toString('base64')))
  assert.ok(spellings.includes(Buffer.from('p@ss word42').toString('base64url')))
  assert.ok(spellings.includes(Buffer.from('p@ss word42').toString('hex')))
  assert.deepEqual(spellingsOf(''), [''])
  assert.deepEqual(spellingsOf('ab'), ['ab'], 'short secrets are not expanded into noise')
})

test('tracking ignores undefined, empty and the mask itself', () => {
  const redactor = createRedactor()
  redactor.track(undefined)
  redactor.track('')
  redactor.track(SECRET_MASK)
  assert.equal(redactor.trackedCount, 0)
  assert.equal(redactor.scrub(SECRET_MASK), SECRET_MASK)
})

test('tracking is bounded so a long session cannot grow without limit', () => {
  const redactor = createRedactor({ maxTracked: 3 })
  for (const secret of ['secret-one', 'secret-two', 'secret-three', 'secret-four']) redactor.track(secret)
  assert.equal(redactor.trackedCount, 3)
  assert.equal(redactor.scrub('secret-one'), 'secret-one', 'the oldest literal was evicted')
  assert.equal(redactor.scrub('secret-four'), SECRET_MASK, 'the newest literal is tracked')
})
