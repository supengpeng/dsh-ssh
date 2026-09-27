/**
 * §4.1 diagnostics and §4.2 connection profiles, driven through the *real* wire
 * service with hand-written module doubles.
 *
 * The tests call `SshPluginService` methods with a **JSON string payload**, which
 * is the R1.3 convention the browser uses, so they exercise the same decoding path
 * production does (a nested argument passed directly would test a shape the
 * carrier never delivers). The modules underneath are fakes: the profile store is
 * the real one (a temp file), the auditor is the real one (a temp file), and only
 * the credential seam and the connection pool are doubles.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { createAuditor } from '../../lib/audit.js'
import { Config, resolveConfig } from '../../lib/config.js'
import { LocalApi } from '../../lib/api/local-api.js'
import { resetDirectNestedWarnings } from '../../lib/api/params.js'
import { createRedactor, SECRET_MASK } from '../../lib/redact.js'
import { createProfileStore } from '../../lib/store.js'
import { createSessionRegistry } from '../../lib/sessions.js'
import { SshError } from '../../lib/protocol.js'
import { SshPluginService } from '../../lib/service.js'

const PASSWORD = 'hunter2!'
const root = mkdtempSync(join(tmpdir(), 'dsh-ssh-api-p-'))
after(() => rmSync(root, { recursive: true, force: true }))

let counter = 0
/** Fresh config + object graph for one test; `''` paths land under the temp dir. */
function harness(options = {}) {
  counter += 1
  const home = join(root, `case-${counter}`)
  const config = resolveConfig(Config({}), { DSH_HOME: home })
  const redactor = createRedactor({ redactKeys: config.logging.redactKeys, enabled: true })
  const logLines = []
  const logger = {
    debug: (m) => logLines.push(m),
    info: (m) => logLines.push(m),
    warn: (m, f) => logLines.push(`${m} ${JSON.stringify(f ?? {})}`),
    error: (m) => logLines.push(m),
  }
  const store = createProfileStore({
    file: config.profilesFile,
    defaults: {
      connectTimeoutMs: config.connectTimeoutMs,
      keepaliveIntervalMs: config.keepaliveIntervalMs,
      keepaliveCountMax: config.keepaliveCountMax,
      retries: config.retries,
      hostKeyPolicy: config.hostKey.policy,
    },
    redactKeys: config.logging.redactKeys,
  })
  const audit = createAuditor({ file: config.auditFile, redactor, logger })

  const credentialValues = new Map(Object.entries(options.credentials ?? {}))
  const credentialCalls = { set: [], unset: [], resolve: [] }
  const credentials = {
    async resolve(ref) {
      credentialCalls.resolve.push(ref)
      const value = credentialValues.get(ref)
      return value === undefined ? undefined : { value, source: 'store' }
    },
    async set(ref, value) {
      credentialCalls.set.push([ref, value])
      if (options.readOnlyRefs?.includes(ref)) throw new Error('this reference is supplied by the launching environment and is read-only')
      credentialValues.set(ref, value)
    },
    async unset(ref) {
      credentialCalls.unset.push(ref)
      credentialValues.delete(ref)
    },
    async describe(ref) {
      return { configured: credentialValues.has(ref), source: 'store', writable: !options.readOnlyRefs?.includes(ref) }
    },
  }
  const resolver = options.resolver ?? createResolver({ credentials, store, redactor, logger, config })

  const registry = createSessionRegistry({ maxConcurrentOpsPerSession: config.maxConcurrentOpsPerSession, logger, redactor })
  const acquires = []
  const session = options.session ?? fakeSession()
  const pool = {
    async acquire(input) {
      acquires.push(input)
      const handle = options.handle ?? session
      registry.create(handle)
      return handle
    },
    get: (id) => (options.handles?.[id] ?? (options.handle?.id === id ? options.handle : undefined)),
    list: () => [],
    async disposeAll() {},
    size: 0,
    pending: 0,
  }

  const deps = {
    config,
    logger,
    redactor,
    store,
    credentials: resolver,
    knownHosts: options.knownHosts ?? fakeKnownHosts(),
    audit,
    pool,
    registry,
    exec: options.exec ?? fakeExec(),
    transfers: options.transfers ?? fakeTransfers(),
    ...(options.lastFingerprint === undefined ? {} : { lastFingerprint: options.lastFingerprint }),
    ...(options.lastHostKey === undefined ? {} : { lastHostKey: options.lastHostKey }),
  }
  const api = new LocalApi(deps)
  const service = new SshPluginService({}, config, logger, { api })
  return { home, config, redactor, store, audit, resolver, registry, pool, api, service, logLines, credentialValues, credentialCalls, acquires }
}

/** The real resolver over a fake credential store (see `src/credentials.ts`). */
function createResolver({ credentials, store, redactor, logger, config }) {
  return {
    async resolve(profile, oneShot) {
      const ref = profile.secretRefs?.password ?? `DSH_SSH_${String(profile.name ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_PASSWORD`
      const fromEnv = process.env[ref]
      if (typeof fromEnv === 'string' && fromEnv !== '') return resolved({ password: fromEnv }, 'env')
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) {
        redactor?.track(hit.value)
        return resolved({ password: hit.value }, 'keychain')
      }
      if (typeof oneShot?.password === 'string' && oneShot.password !== '') return resolved({ password: oneShot.password }, 'profile')
      return resolved({}, 'none')
    },
    async resolveProfile(profile, oneShot) {
      const secrets = await this.resolve(profile, oneShot)
      return { ...profile, secrets }
    },
    async describe(profile) {
      const value = await this.resolve(profile)
      const field = (source) => ({ present: source !== 'none', source, masked: source === 'none' ? '' : SECRET_MASK })
      return { password: field(value.source.password), passphrase: field(value.source.passphrase) }
    },
    async set(profileId, field, value, persist) {
      const profile = store.get(profileId)
      const ref = profile?.secretRefs?.[field] ?? `${config.secrets.envPrefix}${String(profile?.name ?? 'PROFILE').toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_${field.toUpperCase()}`
      if (value === '') throw Object.assign(new Error('a secret value must be a non-empty string'), { code: 'SSH_CFG_INVALID' })
      if (persist) {
        try {
          await credentials.set(ref, value)
          if (profile !== undefined) await store.setSecretRef(profileId, field, ref)
          return { ref, persisted: true }
        } catch (error) {
          return { ref, persisted: false, reason: error.message }
        }
      }
      return { ref, persisted: false, reason: 'session-memory only (persist: false)' }
    },
    async clear(profileId, field) {
      const profile = store.get(profileId)
      const ref = profile?.secretRefs?.[field] ?? `${config.secrets.envPrefix}${String(profile?.name ?? 'PROFILE').toUpperCase()}_${field.toUpperCase()}`
      try {
        await credentials.unset(ref)
      } catch {
        /* shadowed references cannot be removed */
      }
    },
    forgetAll() {},
  }
}

function resolved(fields, source) {
  return {
    ...fields,
    source: { password: fields.password === undefined ? 'none' : source, passphrase: 'none' },
    toJSON() {
      return { ...fields, password: fields.password === undefined ? undefined : SECRET_MASK }
    },
  }
}

function fakeSession(overrides = {}) {
  return {
    id: 's_test',
    info: { id: 's_test', label: 'prod', host: 'h.example', port: 22, user: 'deploy', state: 'connected', since: new Date().toISOString(), metrics: { bytesIn: 0, bytesOut: 0 }, capabilities: { shell: true, sftp: true } },
    state: 'connected',
    async exec() { throw new Error('not used') },
    async shell() { throw new Error('not used') },
    async sftp() { throw new Error('not used') },
    rttMs: () => undefined,
    async close() {},
    ...overrides,
  }
}

function fakeKnownHosts() {
  return {
    async verify(q) { return { ok: true, knownHostsMatch: 'exact', fingerprint: 'SHA256:test', policy: q.policy } },
    async remember() {},
    fingerprint: () => 'SHA256:test',
  }
}

function fakeExec() {
  return {
    limits: { maxOutputBytes: 262144, operationTimeoutMs: 120000, graceKillMs: 3000 },
    exec: () => ({ streamId: 'st_x', done: Promise.resolve({}) }),
    openShell: () => ({ streamId: 'st_x', done: Promise.resolve({}) }),
    execWait: async () => ({ streamId: 'st_x', exitCode: 0, stdout: '', stderr: '', truncated: { stdout: false, stderr: false }, durationMs: 1, timedOut: false, endReason: 'completed', bytes: { stdout: 0, stderr: 0 } }),
    subscribe: () => ({ unsubscribe() {}, replayed: 0, gap: false, finished: true }),
    shellWrite: () => ({ written: 0 }),
    shellResize: () => ({ resized: true }),
    shellSignal: () => ({ sent: true }),
    shellClose: () => ({ closed: true }),
    listStreams: () => ({ streams: [] }),
    dispose() {},
  }
}

function fakeTransfers() {
  return {
    active: 0,
    async start() { return { streamId: 'st_t', opId: 'op_t', resumedFrom: 0 } },
    async run() { throw new Error('not used') },
    cancel: () => false,
    list: () => [],
    get: () => undefined,
    dispose() {},
  }
}

// ---------------------------------------------------------------------------
// §4.1 getConfig
// ---------------------------------------------------------------------------

test('getConfig answers the public projection with no credential material', async () => {
  const h = harness()
  const config = await h.service.getConfig()
  assert.deepEqual(config.secrets, { provider: 'credentials', envPrefix: 'DSH_SSH_' })
  assert.equal(config.logging.redactKeys, undefined)
  assert.equal(config.logging.redact, true)
  assert.equal(config.profilesFile, h.config.profilesFile)
  assert.equal(JSON.stringify(config).includes('redactKeys'), false)
})

test('getConfig works without a runtime (the M0-only configuration)', async () => {
  const config = resolveConfig(Config({}), { DSH_HOME: join(root, 'no-runtime') })
  const service = new SshPluginService({}, config, { debug() {}, info() {}, warn() {}, error() {} })
  const publicConfig = await service.getConfig()
  assert.equal(publicConfig.maxSessions, 10)
})

test('an endpoint without a runtime fails loudly instead of returning an empty result', async () => {
  const config = resolveConfig(Config({}), { DSH_HOME: join(root, 'no-runtime-2') })
  const service = new SshPluginService({}, config, { debug() {}, info() {}, warn() {}, error() {} })
  await assert.rejects(() => service.listProfiles('{}'), (error) => error.code === 'SSH_STATE_INVALID')
})

// ---------------------------------------------------------------------------
// R1.3 parameter delivery
// ---------------------------------------------------------------------------

test('a JSON-string payload is decoded exactly like the browser sends it', async () => {
  const h = harness()
  const saved = await h.service.saveProfile(JSON.stringify({ profile: { name: 'prod', host: 'h.example', user: 'deploy' } }))
  assert.equal(saved.profile.name, 'prod')
  assert.equal(saved.profile.host, 'h.example')
  assert.equal(saved.profile.port, 22)
  assert.equal(saved.profile.user, 'deploy')
})

test('a nested object passed directly still works, and is reported once', async () => {
  const h = harness()
  resetDirectNestedWarnings()
  const saved = await h.service.saveProfile({ profile: { name: 'inline', host: 'h2.example' } })
  assert.equal(saved.profile.host, 'h2.example')
  assert.ok(h.logLines.some((line) => line.includes('profileJson')), 'the R1.3 convention violation is logged, not silently accepted')
  // The dedup is deliberate (one warning per field per process), so a second
  // direct call is quiet — a chatty client must not be able to flood the log.
  const before = h.logLines.length
  await h.service.saveProfile({ profile: { name: 'inline2', host: 'h3.example' } })
  assert.equal(h.logLines.length, before, 'the warning is not repeated for the same field')
})

test('a malformed JSON payload is SSH_CFG_INVALID, not a silent empty call', async () => {
  const h = harness()
  await assert.rejects(
    () => h.service.saveProfile('{"profile": {'),
    (error) => error.code === 'SSH_CFG_INVALID' && /not valid JSON/.test(error.message),
  )
})

test('a field of the wrong type is refused by name', async () => {
  const h = harness()
  await assert.rejects(
    () => h.service.deleteProfile(JSON.stringify({ profileId: { nested: true } })),
    (error) => error.code === 'SSH_CFG_INVALID' && /profileId is required/.test(error.message),
  )
  await assert.rejects(
    () => h.service.saveProfile(JSON.stringify({ profileJson: '"not an object"' })),
    (error) => error.code === 'SSH_CFG_INVALID' && /must decode to an object/.test(error.message),
  )
})

test('the failure carries the frozen ErrorInfo fields as own properties', async () => {
  const h = harness()
  const error = await h.service.listSessions().then(
    () => undefined,
    (thrown) => thrown,
  )
  assert.equal(error, undefined, 'listSessions succeeds')
  const failure = await h.service.getSession(JSON.stringify({ sessionId: 'nope' })).then(
    () => undefined,
    (thrown) => thrown,
  )
  assert.ok(failure)
  assert.equal(failure.code, 'SSH_STATE_INVALID')
  assert.equal(failure.retryable, false)
  assert.ok(Object.keys(failure).includes('code'), 'code is an own enumerable property, so any serializer keeps it')
  assert.ok(Object.keys(failure).includes('retryable'))
})

// ---------------------------------------------------------------------------
// §4.2 profiles
// ---------------------------------------------------------------------------

test('save/list project profiles with a fixed mask and never a plaintext', async () => {
  const h = harness({ credentials: { DSH_SSH_PROD_PASSWORD: PASSWORD } })
  const saved = await h.service.saveProfile(JSON.stringify({ profile: { name: 'prod', host: 'h.example', user: 'deploy', secretRefs: { password: 'DSH_SSH_PROD_PASSWORD' } } }))
  const view = saved.profile
  assert.equal(view.secrets.password.present, true)
  assert.equal(view.secrets.password.masked, SECRET_MASK)
  assert.equal(view.secrets.password.masked.length, 8)
  assert.equal(view.secretRefs.password, 'DSH_SSH_PROD_PASSWORD')
  assert.equal(JSON.stringify(view).includes(PASSWORD), false)

  const listed = await h.service.listProfiles('{}')
  assert.equal(listed.profiles.length, 1)
  assert.equal(JSON.stringify(listed).includes(PASSWORD), false)
  const onDisk = readFileSync(h.config.profilesFile, 'utf8')
  assert.equal(onDisk.includes(PASSWORD), false, 'the profile file holds a reference only')
})

test('a plaintext smuggled into secretRefs is refused without echoing it', async () => {
  const h = harness()
  const failure = await h.service
    .saveProfile(JSON.stringify({ profile: { name: 'prod', host: 'h', secretRefs: { password: PASSWORD } } }))
    .then(() => undefined, (error) => error)
  assert.equal(failure.code, 'SSH_CFG_INVALID')
  assert.equal(failure.message.includes(PASSWORD), false, 'the refusal must not quote the secret')
  const listed = await h.service.listProfiles('{}')
  assert.equal(listed.profiles.length, 0)
})

test('delete reports an unknown id and succeeds once', async () => {
  const h = harness()
  const saved = await h.service.saveProfile(JSON.stringify({ profile: { name: 'prod', host: 'h' } }))
  const unknown = await h.service.deleteProfile(JSON.stringify({ profileId: 'p_missing' })).then(() => undefined, (error) => error)
  assert.equal(unknown.code, 'SSH_CFG_INVALID')
  assert.deepEqual(await h.service.deleteProfile(JSON.stringify({ profileId: saved.profile.id })), { deleted: true })
  assert.equal((await h.service.listProfiles('{}')).profiles.length, 0)
})

test('duplicate copies a profile with a fresh id and keeps its reference', async () => {
  const h = harness()
  const saved = await h.service.saveProfile(JSON.stringify({ profile: { name: 'prod', host: 'h', secretRefs: { password: 'DSH_SSH_PROD_PASSWORD' } } }))
  const copy = await h.service.duplicateProfile(JSON.stringify({ profileId: saved.profile.id, name: 'prod-copy' }))
  assert.notEqual(copy.profile.id, saved.profile.id)
  assert.equal(copy.profile.name, 'prod-copy')
  assert.equal(copy.profile.secretRefs.password, 'DSH_SSH_PROD_PASSWORD')
  assert.equal((await h.service.listProfiles('{}')).profiles.length, 2)
})

test('setSecret persists through the credential seam and records the reference', async () => {
  const h = harness()
  const saved = await h.service.saveProfile(JSON.stringify({ profile: { name: 'prod', host: 'h' } }))
  const result = await h.service.setSecret(JSON.stringify({ profileId: saved.profile.id, field: 'password', value: PASSWORD, persist: true }))
  assert.equal(result.ref, 'DSH_SSH_PROD_PASSWORD')
  assert.equal(result.persisted, true)
  assert.equal(result.masked, SECRET_MASK)
  assert.deepEqual(h.credentialCalls.set, [['DSH_SSH_PROD_PASSWORD', PASSWORD]])
  const reloaded = (await h.service.listProfiles('{}')).profiles[0]
  assert.equal(reloaded.secretRefs.password, 'DSH_SSH_PROD_PASSWORD')
  assert.equal(JSON.stringify(reloaded).includes(PASSWORD), false)
  assert.equal(readFileSync(h.config.profilesFile, 'utf8').includes(PASSWORD), false)
})

test('setSecret reports the read-only degradation as data, not as a failure', async () => {
  const h = harness({ readOnlyRefs: ['DSH_SSH_PROD_PASSWORD'] })
  const saved = await h.service.saveProfile(JSON.stringify({ profile: { name: 'prod', host: 'h' } }))
  const result = await h.service.setSecret(JSON.stringify({ profileId: saved.profile.id, field: 'password', value: PASSWORD, persist: true }))
  assert.equal(result.persisted, false)
  assert.match(String(result.reason), /read-only|environment/)
  assert.equal(result.masked, SECRET_MASK, 'the mask is still reported so the UI can render the row')
})

test('setSecret refuses an empty value and a missing field', async () => {
  const h = harness()
  const saved = await h.service.saveProfile(JSON.stringify({ profile: { name: 'prod', host: 'h' } }))
  const empty = await h.service.setSecret(JSON.stringify({ profileId: saved.profile.id, field: 'password', value: '' })).then(() => undefined, (e) => e)
  assert.equal(empty.code, 'SSH_CFG_INVALID')
  const badField = await h.service.setSecret(JSON.stringify({ profileId: saved.profile.id, field: 'secret', value: PASSWORD })).then(() => undefined, (e) => e)
  assert.equal(badField.code, 'SSH_CFG_INVALID')
  assert.match(badField.message, /field must be one of/)
})

test('clearSecret removes the stored value', async () => {
  const h = harness()
  const saved = await h.service.saveProfile(JSON.stringify({ profile: { name: 'prod', host: 'h' } }))
  await h.service.setSecret(JSON.stringify({ profileId: saved.profile.id, field: 'password', value: PASSWORD, persist: true }))
  assert.deepEqual(await h.service.clearSecret(JSON.stringify({ profileId: saved.profile.id, field: 'password' })), { cleared: true })
  assert.deepEqual(h.credentialCalls.unset, ['DSH_SSH_PROD_PASSWORD'])
  const view = (await h.service.listProfiles('{}')).profiles[0]
  assert.equal(view.secrets.password.present, false)
  assert.equal(view.secrets.password.masked, '')
})

test('testProfile reuses a live session instead of tearing it down', async () => {
  const h = harness()
  const saved = await h.service.saveProfile(JSON.stringify({ profile: { name: 'prod', host: 'h.example' } }))
  // A session for this profile is already live (the pool registers it on acquire).
  h.registry.create({
    id: 's_live',
    info: {
      id: 's_live',
      profileId: saved.profile.id,
      label: 'prod',
      host: 'h.example',
      port: 22,
      user: 'deploy',
      state: 'connected',
      since: new Date().toISOString(),
      metrics: { connectMs: 42, bytesIn: 0, bytesOut: 0 },
      capabilities: { shell: true, sftp: true },
    },
  })
  const result = await h.service.testProfile(JSON.stringify({ profileId: saved.profile.id }))
  assert.equal(result.ok, true)
  assert.equal(result.latencyMs, 42)
  assert.equal(h.acquires.length, 0, 'no second connection was opened')
  assert.equal(h.registry.get('s_live').state, 'connected', 'the live session is untouched')
})

test('testProfile connects, measures, closes and reports a structured failure', async () => {
  const h = harness()
  const saved = await h.service.saveProfile(JSON.stringify({ profile: { name: 'prod', host: 'h.example' } }))
  let closed = false
  h.pool.acquire = async (input) => {
    h.acquires.push(input)
    return fakeSession({ id: 's_test_new', async close() { closed = true } })
  }
  const ok = await h.service.testProfile(JSON.stringify({ profileId: saved.profile.id }))
  assert.equal(ok.ok, true)
  assert.equal(closed, true, 'a test connection never outlives the call')

  h.pool.acquire = async () => {
    // A real connection failure is an SshError: `toErrorInfo` maps anything else
    // to SSH_UNKNOWN on purpose, which is why the double must use the real type.
    throw new SshError('SSH_NET_REFUSED', 'connection refused')
  }
  const failed = await h.service.testProfile(JSON.stringify({ profileId: saved.profile.id }))
  assert.equal(failed.ok, false)
  assert.equal(failed.error.code, 'SSH_NET_REFUSED')
  assert.equal(failed.error.retryable, true)
})

test('testProfile rejects profileId and an inline body given together', async () => {
  const h = harness()
  const saved = await h.service.saveProfile(JSON.stringify({ profile: { name: 'prod', host: 'h' } }))
  const failure = await h.service.testProfile(JSON.stringify({ profileId: saved.profile.id, profile: { host: 'other' } })).then(() => undefined, (e) => e)
  assert.equal(failure.code, 'SSH_CFG_INVALID')
  assert.match(failure.message, /not both/)
})

test('every profile endpoint writes an audit entry that carries no secret', async () => {
  const h = harness()
  const saved = await h.service.saveProfile(JSON.stringify({ profile: { name: 'prod', host: 'h' } }))
  await h.service.setSecret(JSON.stringify({ profileId: saved.profile.id, field: 'password', value: PASSWORD, persist: true }))
  await h.service.testProfile(JSON.stringify({ profileId: saved.profile.id }))
  await h.service.clearSecret(JSON.stringify({ profileId: saved.profile.id, field: 'password' }))
  const entries = await h.audit.query({})
  const ops = entries.entries.map((entry) => entry.op)
  for (const op of ['saveProfile', 'setSecret', 'clearSecret']) assert.ok(ops.includes(op), `${op} was not audited`)
  const text = readFileSync(h.config.auditFile, 'utf8')
  assert.equal(text.includes(PASSWORD), false)
})
