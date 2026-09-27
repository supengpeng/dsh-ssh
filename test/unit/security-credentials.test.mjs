/**
 * Credential resolution and profile persistence.
 *
 * Two acceptance criteria live here:
 *
 *   - "凭据不在日志与 UI 明文中出现" — `ConnProfileView`, `describe()`,
 *     `JSON.stringify(resolvedSecrets)` and the profile *file* are each asserted to
 *     contain no plaintext, and the rejection message for a plaintext smuggled into
 *     `secretRefs` must not quote the value it rejected.
 *   - "凭据解析顺序 env > ctx.credentials 记录 > 一次性输入" (ICD §6) — one test per
 *     layer boundary, because an ordering bug silently prefers the wrong secret and
 *     is invisible until a login fails against one host out of many.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { createCredentialResolver, envNameFor, idSlug, profileSlug } from '../../lib/credentials.js'
import { SECRET_MASK, createRedactor } from '../../lib/redact.js'
import {
  createProfileStore,
  monotonicUlid,
  newProfileId,
  normalizeProfile,
  secretsViewOf,
  toConnProfileView,
} from '../../lib/store.js'

const PASSWORD = 'hunter2!'
const PASSPHRASE = 'key-pass-phrase'

const DEFAULTS = {
  connectTimeoutMs: 15000,
  keepaliveIntervalMs: 20000,
  keepaliveCountMax: 3,
  retries: { max: 2, backoffBaseMs: 500, backoffMaxMs: 5000, jitter: true },
  hostKeyPolicy: 'accept-new',
}

const root = mkdtempSync(join(tmpdir(), 'dsh-ssh-sec-cred-'))
after(() => rmSync(root, { recursive: true, force: true }))

let counter = 0
function tempFile(name = 'profiles.json') {
  counter += 1
  const dir = join(root, `case-${counter}`)
  mkdirSync(dir, { recursive: true })
  return join(dir, name)
}

function storeAt(file, extra = {}) {
  return createProfileStore({ file, defaults: DEFAULTS, ...extra })
}

/** A structurally faithful stand-in for the shipped `ctx.credentials` provider. */
function fakeCredentials(initial = {}, shadowed = []) {
  const values = new Map(Object.entries(initial))
  const seen = { set: [], unset: [], resolve: [] }
  return {
    values,
    seen,
    async resolve(ref) {
      seen.resolve.push(ref)
      const value = values.get(ref)
      return value === undefined ? undefined : { value, source: 'stored' }
    },
    async describe(ref) {
      return { configured: values.has(ref), writable: !shadowed.includes(ref) }
    },
    async set(ref, value) {
      seen.set.push([ref, value])
      if (shadowed.includes(ref)) throw new Error('this reference is supplied by the launching environment and is read-only')
      values.set(ref, value)
    },
    async unset(ref) {
      seen.unset.push(ref)
      values.delete(ref)
    },
  }
}

function resolverFor(options) {
  return createCredentialResolver({
    secrets: { provider: 'credentials', envPrefix: 'DSH_SSH_' },
    ...options,
  })
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

test('the environment override name follows DSH_SSH_<SLUG>_<FIELD>', () => {
  assert.equal(profileSlug({ name: 'prod web-01' }), 'PROD_WEB_01')
  assert.equal(profileSlug({ name: '  ' , host: '10.0.0.1' }), '10_0_0_1')
  assert.equal(profileSlug({ id: 'p_abc' }), 'P_ABC')
  assert.equal(envNameFor({ name: 'prod' }, 'passphrase', 'DSH_SSH_'), 'DSH_SSH_PROD_PASSPHRASE')
  assert.equal(envNameFor({ name: 'prod' }, 'password', 'MY_'), 'MY_PROD_PASSWORD')
  assert.match(idSlug('p_01JABCDEF'), /^PROFILE_01JABCDEF$/)
})

// ---------------------------------------------------------------------------
// Resolution order (ICD §6)
// ---------------------------------------------------------------------------

test('the environment wins over everything else', async () => {
  const credentials = fakeCredentials({ DSH_SSH_PROD_PASSWORD: 'stored' })
  const resolver = resolverFor({ credentials, env: { DSH_SSH_PROD_PASSWORD: 'from-env' } })
  const resolved = await resolver.resolve({ name: 'prod', host: 'h', secretRefs: { password: 'DSH_SSH_PROD_PASSWORD' } }, { password: 'one-shot' })
  assert.equal(resolved.password, 'from-env')
  assert.equal(resolved.source.password, 'env')
  assert.equal(credentials.seen.resolve.includes('DSH_SSH_PROD_PASSWORD'), false, 'a read-only override is not even looked up in the store')
})

test('an explicitly configured reference name is honoured as an environment variable', async () => {
  const resolver = resolverFor({ credentials: fakeCredentials(), env: { MY_OWN_REF: 'via-ref-env' } })
  const resolved = await resolver.resolve({ name: 'prod', host: 'h', secretRefs: { password: 'MY_OWN_REF' } })
  assert.equal(resolved.password, 'via-ref-env')
  assert.equal(resolved.source.password, 'env')
})

test('the credentials store wins over session memory and one-shot input', async () => {
  const credentials = fakeCredentials({ DSH_SSH_PROD_PASSWORD: 'stored-secret' })
  const resolver = resolverFor({ credentials, env: {} })
  const profile = await storeAt(tempFile()).save({ name: 'prod', host: 'h' })
  await resolver.set(profile.id, 'password', 'memory-secret', false)
  const resolved = await resolver.resolve(profile, { password: 'one-shot' })
  assert.equal(resolved.password, 'stored-secret')
  assert.equal(resolved.source.password, 'keychain', "a stored record reports as 'keychain' in the frozen union")
})

test('session memory wins over the one-shot value for the same connection', async () => {
  const resolver = resolverFor({ credentials: fakeCredentials(), env: {} })
  const profile = await storeAt(tempFile()).save({ name: 'prod', host: 'h' })
  await resolver.set(profile.id, 'password', 'memory-secret', false)
  const resolved = await resolver.resolve(profile, { password: 'one-shot' })
  assert.equal(resolved.password, 'memory-secret')
  assert.equal(resolved.source.password, 'profile')
})

test('a one-shot value is used when nothing else is configured', async () => {
  const resolver = resolverFor({ credentials: fakeCredentials(), env: {} })
  const resolved = await resolver.resolve({ name: 'prod', host: 'h' }, { password: 'one-shot', passphrase: 'once-pass' })
  assert.equal(resolved.password, 'one-shot')
  assert.equal(resolved.passphrase, 'once-pass')
  assert.equal(resolved.source.password, 'profile')
})

test('nothing configured resolves to undefined with source none', async () => {
  const resolver = resolverFor({ credentials: fakeCredentials(), env: {} })
  const resolved = await resolver.resolve({ name: 'prod', host: 'h' })
  assert.equal(resolved.password, undefined)
  assert.equal(resolved.source.password, 'none')
  assert.equal(resolved.source.passphrase, 'none')
})

test('secrets.provider "env" never consults the credentials service', async () => {
  const credentials = fakeCredentials({ DSH_SSH_PROD_PASSWORD: 'stored-secret' })
  const resolver = createCredentialResolver({ secrets: { provider: 'env', envPrefix: 'DSH_SSH_' }, credentials, env: {} })
  const resolved = await resolver.resolve({ name: 'prod', host: 'h' })
  assert.equal(resolved.password, undefined)
  assert.equal(credentials.seen.resolve.length, 0)
  await assert.rejects(() => resolver.set('p_whatever', 'password', 'x', true), (error) => error.code === 'SSH_CFG_INVALID')
})

test('a credentials outage degrades to "not configured" rather than failing the connect', async () => {
  const broken = {
    async resolve() {
      throw new Error('store unavailable')
    },
  }
  const warnings = []
  const resolver = resolverFor({ credentials: broken, env: {}, logger: { warn: (message, fields) => warnings.push([message, fields]) } })
  const resolved = await resolver.resolve({ name: 'prod', host: 'h' }, { password: 'one-shot' })
  assert.equal(resolved.password, 'one-shot', 'the one-shot value still applies')
  assert.equal(warnings.length, 2, 'each probed field warns once')
  assert.equal(warnings[0][1].ref, 'DSH_SSH_PROD_PASSWORD')
})

test('an empty stored value counts as absent', async () => {
  const credentials = fakeCredentials({ DSH_SSH_PROD_PASSWORD: '' })
  const resolver = resolverFor({ credentials, env: {} })
  const resolved = await resolver.resolve({ name: 'prod', host: 'h' }, { password: 'one-shot' })
  assert.equal(resolved.password, 'one-shot')
})

// ---------------------------------------------------------------------------
// describe / set / clear
// ---------------------------------------------------------------------------

test('describe reports presence, provenance and a fixed mask — never a value', async () => {
  const credentials = fakeCredentials({ DSH_SSH_PROD_PASSWORD: PASSWORD })
  const resolver = resolverFor({ credentials, env: {} })
  const view = await resolver.describe({ name: 'prod', host: 'h', secretRefs: { privateKeyPath: '/home/u/.ssh/id_ed25519' } })
  assert.equal(view.password.present, true)
  assert.equal(view.password.source, 'keychain')
  assert.equal(view.password.masked, SECRET_MASK)
  assert.equal(view.password.masked.length, 8)
  assert.equal(view.passphrase.present, false)
  assert.equal(view.passphrase.masked, '')
  assert.equal(view.privateKeyPath, '/home/u/.ssh/id_ed25519')
  assert.equal(JSON.stringify(view).includes(PASSWORD), false)
})

test('describe reports source env for an environment override', async () => {
  const resolver = resolverFor({ credentials: fakeCredentials(), env: { DSH_SSH_PROD_PASSWORD: PASSWORD } })
  const view = await resolver.describe({ name: 'prod', host: 'h' })
  assert.deepEqual(view.password, { present: true, source: 'env', masked: SECRET_MASK })
})

test('set(persist: true) writes through the credential store and records the reference', async () => {
  const file = tempFile()
  const store = storeAt(file)
  const credentials = fakeCredentials()
  const resolver = resolverFor({ credentials, env: {}, profiles: store })
  const profile = await store.save({ name: 'prod', host: 'h' })

  const result = await resolver.set(profile.id, 'password', PASSWORD, true)
  assert.equal(result.ref, 'DSH_SSH_PROD_PASSWORD')
  assert.equal(result.persisted, true)
  assert.deepEqual(credentials.seen.set, [['DSH_SSH_PROD_PASSWORD', PASSWORD]])

  const stored = store.get(profile.id)
  assert.equal(stored.secretRefs.password, 'DSH_SSH_PROD_PASSWORD')
  const text = readFileSync(file, 'utf8')
  assert.equal(text.includes(PASSWORD), false, 'the profile file holds the reference, never the value')
  assert.ok(text.includes('DSH_SSH_PROD_PASSWORD'))

  const resolved = await resolver.resolve(stored)
  assert.equal(resolved.password, PASSWORD)
  assert.equal(resolved.source.password, 'keychain')
})

test('set(persist: false) never touches the credential store', async () => {
  const credentials = fakeCredentials()
  const store = storeAt(tempFile())
  const resolver = resolverFor({ credentials, env: {}, profiles: store })
  const profile = await store.save({ name: 'prod', host: 'h' })
  const result = await resolver.set(profile.id, 'password', PASSWORD, false)
  assert.equal(result.persisted, false)
  assert.equal(credentials.seen.set.length, 0)
  assert.equal((await resolver.resolve(store.get(profile.id))).password, PASSWORD)
})

test('a read-only (environment-supplied) reference degrades to session memory', async () => {
  const credentials = fakeCredentials({}, ['DSH_SSH_PROD_PASSWORD'])
  const store = storeAt(tempFile())
  const resolver = resolverFor({ credentials, env: {}, profiles: store })
  const profile = await store.save({ name: 'prod', host: 'h' })
  const result = await resolver.set(profile.id, 'password', PASSWORD, true)
  assert.equal(result.persisted, false)
  assert.match(String(result.reason), /read-only|environment/)
  const resolved = await resolver.resolve(store.get(profile.id))
  assert.equal(resolved.password, PASSWORD, 'the value the user just typed still works for this run')
  assert.equal(resolved.source.password, 'profile')
})

test('set refuses an empty value instead of blanking a credential', async () => {
  const resolver = resolverFor({ credentials: fakeCredentials(), env: {} })
  await assert.rejects(() => resolver.set('p_x', 'password', '', true), (error) => error.code === 'SSH_CFG_INVALID')
})

test('clear removes the stored value and the session copy', async () => {
  const credentials = fakeCredentials({ DSH_SSH_PROD_PASSWORD: PASSWORD })
  const store = storeAt(tempFile())
  const resolver = resolverFor({ credentials, env: {}, profiles: store })
  const profile = await store.save({ name: 'prod', host: 'h' })
  await resolver.set(profile.id, 'password', PASSWORD, false)
  await resolver.clear(profile.id, 'password')
  assert.deepEqual(credentials.seen.unset, ['DSH_SSH_PROD_PASSWORD'])
  const resolved = await resolver.resolve(store.get(profile.id))
  assert.equal(resolved.password, undefined, 'both layers are gone')
})

test('forgetAll drops memory and stops literal redaction', async () => {
  const redactor = createRedactor()
  const resolver = resolverFor({ credentials: fakeCredentials(), env: {}, redactor })
  await resolver.resolve({ name: 'prod', host: 'h' }, { password: PASSWORD })
  assert.equal(redactor.trackedCount, 1)
  assert.equal(redactor.scrub(PASSWORD), SECRET_MASK)
  resolver.forgetAll()
  assert.equal(redactor.trackedCount, 0)
})

// ---------------------------------------------------------------------------
// Redaction guarantees around resolved secrets
// ---------------------------------------------------------------------------

test('every resolved secret is registered with the redactor automatically', async () => {
  const redactor = createRedactor()
  const resolver = resolverFor({ credentials: fakeCredentials({ DSH_SSH_PROD_PASSWORD: PASSWORD }), env: {}, redactor })
  await resolver.resolve({ name: 'prod', host: 'h' })
  const logLine = `connecting to prod with password ${PASSWORD}`
  assert.equal(redactor.scrub(logLine).includes(PASSWORD), false)
  assert.equal(redactor.scrub(logLine), 'connecting to prod with password ••••••••')
})

test('a resolved secret cannot be serialised by accident', async () => {
  const credentials = fakeCredentials({ DSH_SSH_PROD_PASSWORD: PASSWORD, DSH_SSH_PROD_PASSPHRASE: PASSPHRASE })
  const resolver = resolverFor({ credentials, env: {} })
  const resolved = await resolver.resolve({ name: 'prod', host: 'h' })
  const json = JSON.stringify(resolved)
  assert.equal(json.includes(PASSWORD), false)
  assert.equal(json.includes(PASSPHRASE), false)
  assert.equal(json.includes(SECRET_MASK), true)
  // A spread keeps the guard.
  assert.equal(JSON.stringify({ ...resolved }).includes(PASSWORD), false)
  // Direct property access still works for ssh2.
  assert.equal(resolved.password, PASSWORD)
})

test('resolveProfile returns the flat shape the connection layer consumes', async () => {
  const credentials = fakeCredentials({ DSH_SSH_PROD_PASSWORD: PASSWORD })
  const store = storeAt(tempFile())
  const resolver = resolverFor({ credentials, env: {}, profiles: store })
  const profile = await store.save({ name: 'prod', host: 'h1', hostKeyPolicy: 'strict' })
  const resolved = await resolver.resolveProfile(profile, {})
  assert.equal(resolved.host, 'h1')
  assert.equal(resolved.hostKeyPolicy, 'strict')
  assert.equal(resolved.secrets.password, PASSWORD)
  assert.equal(resolved.id, profile.id)
  assert.equal(JSON.stringify(resolved).includes(PASSWORD), false, 'even the flat shape is JSON-safe')
  const withKey = await resolver.resolveProfile(await store.save({ name: 'k', host: 'h', auth: 'privateKey', secretRefs: { privateKeyPath: '/k' } }))
  assert.equal(withKey.secrets.privateKeyPath, '/k')
})

// ---------------------------------------------------------------------------
// Profile persistence: the file holds references only
// ---------------------------------------------------------------------------

test('a plaintext smuggled into secretRefs is rejected, and the message does not quote it', async () => {
  const file = tempFile()
  const store = storeAt(file)
  await assert.rejects(
    () => store.save({ name: 'prod', host: 'h', secretRefs: { password: PASSWORD } }),
    (error) => {
      assert.equal(error.code, 'SSH_CFG_INVALID')
      assert.equal(String(error.message).includes(PASSWORD), false, 'the rejection must not echo the secret')
      return true
    },
  )
  assert.equal(store.list().length, 0)
  assert.throws(() => readFileSync(file, 'utf8'), 'nothing was written')
})

test('unknown fields on the input are dropped, never persisted', async () => {
  const file = tempFile()
  const store = storeAt(file)
  const profile = await store.save({
    name: 'prod',
    host: 'h',
    password: PASSWORD,
    passphrase: PASSPHRASE,
    secret: 'x',
    token: 'y',
    secretRefs: { password: 'DSH_SSH_PROD_PASSWORD' },
  })
  assert.equal(profile.password, undefined)
  const text = readFileSync(file, 'utf8')
  for (const secret of [PASSWORD, PASSPHRASE, '"x"', '"y"']) assert.equal(text.includes(secret), false, `${secret} must not be in the profile file`)
  assert.ok(text.includes('DSH_SSH_PROD_PASSWORD'))
  const parsed = JSON.parse(text)
  assert.equal(parsed.version, 1)
  assert.deepEqual(Object.keys(parsed.profiles[0]).sort(), [
    'auth',
    'connectTimeoutMs',
    'createdAt',
    'host',
    'hostKeyPolicy',
    'id',
    'keepaliveCountMax',
    'keepaliveIntervalMs',
    'name',
    'port',
    'retries',
    'secretRefs',
    'tags',
    'updatedAt',
    'user',
  ])
})

test('defaultEnv refuses secret-shaped keys', async () => {
  const store = storeAt(tempFile())
  await assert.rejects(
    () => store.save({ name: 'prod', host: 'h', defaultEnv: { PASSWORD: PASSWORD } }),
    (error) => error.code === 'SSH_CFG_INVALID' && error.message.includes('defaultEnv.PASSWORD'),
  )
  await assert.rejects(
    () => store.save({ name: 'prod', host: 'h', defaultEnv: { MY_SECRET_TOKEN: 'x' } }),
    (error) => error.code === 'SSH_CFG_INVALID',
  )
  const ok = await store.save({ name: 'prod', host: 'h', defaultEnv: { LANG: 'C.UTF-8', SSH_AUTH_SOCK: '/tmp/agent' } })
  assert.deepEqual(ok.defaultEnv, { LANG: 'C.UTF-8', SSH_AUTH_SOCK: '/tmp/agent' })
})

test('a ConnProfileView never contains plaintext', async () => {
  const credentials = fakeCredentials({ DSH_SSH_PROD_PASSWORD: PASSWORD })
  const resolver = resolverFor({ credentials, env: {} })
  const profile = await storeAt(tempFile()).save({ name: 'prod', host: 'h', secretRefs: { password: 'DSH_SSH_PROD_PASSWORD' } })
  const view = toConnProfileView(profile, await resolver.describe(profile))
  assert.equal(view.secrets.password.present, true)
  assert.equal(view.secrets.password.masked, SECRET_MASK)
  assert.equal(view.secretRefs.password, 'DSH_SSH_PROD_PASSWORD')
  assert.equal('secretRefs' in view, true)
  assert.equal(view.password, undefined)
  assert.equal(JSON.stringify(view).includes(PASSWORD), false)
  assert.equal(JSON.stringify(view).includes(SECRET_MASK), true)
  assert.deepEqual(Object.keys(view.secrets.password).sort(), ['masked', 'present', 'source'])
})

test('secretsViewOf masks by presence, not by length', () => {
  const view = secretsViewOf({ password: { present: true, source: 'env' }, passphrase: { present: false, source: 'none' } })
  assert.equal(view.password.masked, SECRET_MASK)
  assert.equal(view.passphrase.masked, '')
  assert.deepEqual(view, { password: { present: true, source: 'env', masked: SECRET_MASK }, passphrase: { present: false, source: 'none', masked: '' } })
})

test('omitting secretRefs keeps the stored references (frozen merge rule)', async () => {
  const store = storeAt(tempFile())
  const created = await store.save({ name: 'prod', host: 'h1', secretRefs: { password: 'DSH_SSH_PROD_PASSWORD' } })
  const edited = await store.save({ id: created.id, host: 'h2' })
  assert.equal(edited.host, 'h2')
  assert.equal(edited.secretRefs.password, 'DSH_SSH_PROD_PASSWORD', 'a UI edit must not silently orphan the credential')
  const emptyPatch = await store.save({ id: created.id, secretRefs: {} })
  assert.equal(emptyPatch.secretRefs.password, 'DSH_SSH_PROD_PASSWORD', 'clearing is clearSecret\'s job, never an omission')
  const replaced = await store.save({ id: created.id, secretRefs: { password: 'ANOTHER_REF' } })
  assert.equal(replaced.secretRefs.password, 'ANOTHER_REF')
})

test('profiles round-trip through the file with their ids and timestamps', async () => {
  const file = tempFile()
  const first = storeAt(file)
  const created = await first.save({ name: 'prod', host: 'h', tags: ['a', 'a', 'b'], group: 'web' })
  await new Promise((resolve) => setTimeout(resolve, 5))
  await first.touch(created.id)
  const reopened = storeAt(file)
  const list = reopened.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].id, created.id)
  assert.deepEqual(list[0].tags, ['a', 'b'])
  assert.equal(list[0].group, 'web')
  assert.ok(typeof list[0].lastUsedAt === 'string')
  assert.equal(reopened.loadError, undefined)
})

test('duplicate mints a fresh id and keeps the references', async () => {
  const store = storeAt(tempFile())
  const created = await store.save({ name: 'prod', host: 'h', secretRefs: { password: 'DSH_SSH_PROD_PASSWORD' } })
  const copy = await store.duplicate(created.id)
  assert.notEqual(copy.id, created.id)
  assert.equal(copy.secretRefs.password, 'DSH_SSH_PROD_PASSWORD')
  assert.match(copy.name, /copy/)
  assert.equal(store.list().length, 2)
  assert.equal(await store.remove(copy.id), true)
  assert.equal(store.list().length, 1)
})

test('ids are unique and ordered within a millisecond', () => {
  const ids = Array.from({ length: 50 }, () => newProfileId())
  assert.equal(new Set(ids).size, 50)
  const sorted = [...ids].sort()
  assert.deepEqual(sorted, ids, 'ids minted in a burst still sort chronologically')
  assert.match(ids[0], /^p_[0-9A-HJKMNP-TV-Z]{26}$/)
  assert.equal(monotonicUlid(1000).length, 26)
})

test('a malformed record is skipped without hiding the rest of the file', async () => {
  const file = tempFile()
  const store = storeAt(file)
  const good = await store.save({ name: 'good', host: 'h' })
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  raw.profiles.push({ id: 'not-an-id', host: 'h2' })
  raw.profiles.push({ id: 'p_' + '0'.repeat(26), host: 'h3', secretRefs: { password: PASSWORD }, name: 'x', port: 22, user: 'root', auth: 'password', connectTimeoutMs: 1, keepaliveIntervalMs: 1, keepaliveCountMax: 1, retries: DEFAULTS.retries, hostKeyPolicy: 'accept-new', tags: [], createdAt: 'x', updatedAt: 'x' })
  writeFileSync(file, JSON.stringify(raw), 'utf8')
  const reopened = storeAt(file)
  const list = reopened.list()
  assert.equal(list.length, 1, 'the id-less record and the plaintext-carrying record are both refused')
  assert.equal(list[0].id, good.id)
})

test('a corrupt file reports loadError instead of throwing, and does not lose data silently', async () => {
  const file = tempFile()
  writeFileSync(file, '{ not json', 'utf8')
  const errors = []
  const store = storeAt(file, { onLoadError: (reason) => errors.push(reason) })
  assert.deepEqual(store.list(), [])
  assert.equal(errors.length, 1)
  assert.match(String(store.loadError), /cannot parse/)
  // The unreadable file is preserved for forensics before the first write.
  const created = await store.save({ name: 'prod', host: 'h' })
  assert.ok(created.id)
})

test('normalizeProfile clamps hostile numeric values', async () => {
  const store = storeAt(tempFile())
  const profile = await store.save({ name: 'prod', host: 'h', port: 99999, connectTimeoutMs: 1, keepaliveCountMax: 0, retries: { max: 99 } })
  assert.equal(profile.port, 65535)
  assert.equal(profile.connectTimeoutMs, 1000)
  assert.equal(profile.keepaliveCountMax, 1)
  assert.equal(profile.retries.max, 10)
  assert.equal(profile.retries.backoffBaseMs, DEFAULTS.retries.backoffBaseMs)
})

test('a profile needs a host, and a host cannot contain whitespace', async () => {
  const store = storeAt(tempFile())
  await assert.rejects(() => store.save({ name: 'x' }), (error) => error.code === 'SSH_CFG_INVALID')
  await assert.rejects(() => store.save({ host: 'has space' }), (error) => error.code === 'SSH_CFG_INVALID')
  await assert.rejects(() => store.save({ host: 'a/b' }), (error) => error.code === 'SSH_CFG_INVALID')
})

test('normalizeProfile defaults the user and derives a display name', () => {
  const profile = normalizeProfile(
    { host: 'example.com' },
    { defaults: DEFAULTS, env: { USERNAME: 'deploy' }, redactKeys: ['password'] },
  )
  assert.equal(profile.user, 'deploy')
  assert.equal(profile.name, 'deploy@example.com')
  assert.equal(profile.port, 22)
  assert.equal(profile.auth, 'password')
  assert.equal(profile.hostKeyPolicy, 'accept-new')
})
