/**
 * End-to-end proof of the acceptance criterion
 * 「凭据不在日志与 UI 明文中出现」.
 *
 * The per-module suites prove each mechanism; this one wires the whole security
 * stack the way `apply()` will and then searches **every artifact the plugin can
 * produce** for the plaintext: the profile file, the audit JSONL, the plugin log,
 * the wire projection, the serialised resolved secrets, and the known_hosts
 * entry. If a future refactor drops one layer, the secret reappears here even
 * though every individual unit test still passes.
 *
 * It also pins the cross-module contracts that no single module can assert alone:
 * config-derived paths, the store → resolver → view chain, and the audit →
 * redactor wiring.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { createAuditor } from '../../lib/audit.js'
import { Config, resolveConfig, toPublicConfig } from '../../lib/config.js'
import { createCredentialResolver } from '../../lib/credentials.js'
import { blobOf, createKnownHostsVerifier, hostKeyLookupName } from '../../lib/known-hosts.js'
import { createLogger } from '../../lib/logger.js'
import { SECRET_MASK, createRedactor } from '../../lib/redact.js'
import { createProfileStore, toConnProfileView } from '../../lib/store.js'

const PASSWORD = 'Sup3r-Secret-Passw0rd!'
const PASSPHRASE = 'pass-phrase-42'
const KEY = blobOf('ssh-rsa', Buffer.from('host-key-material-for-the-capstone-test'))

const home = mkdtempSync(join(tmpdir(), 'dsh-ssh-sec-e2e-'))
after(() => rmSync(home, { recursive: true, force: true }))

/** Everything the plugin wrote or returned, in one string to search. */
function assertClean(label, text, extras = []) {
  for (const secret of [PASSWORD, PASSPHRASE, ...extras]) {
    assert.equal(String(text).includes(secret), false, `${label} leaked ${secret.length}-char secret: ${String(text).slice(0, 400)}`)
  }
}

test('one connection\'s worth of state never exposes the plaintext anywhere', async () => {
  // ── the wiring `apply()` performs ─────────────────────────────────────────
  const resolved = resolveConfig(Config({}), { DSH_HOME: home })
  const redactor = createRedactor({ redactKeys: resolved.logging.redactKeys, enabled: resolved.logging.redact })
  const logger = createLogger({ config: resolved, redactor, scope: 'ssh' })
  const auditor = createAuditor({ file: resolved.auditFile, redactor, logger })
  const store = createProfileStore({
    file: resolved.profilesFile,
    defaults: {
      connectTimeoutMs: resolved.connectTimeoutMs,
      keepaliveIntervalMs: resolved.keepaliveIntervalMs,
      keepaliveCountMax: resolved.keepaliveCountMax,
      retries: resolved.retries,
      hostKeyPolicy: resolved.hostKey.policy,
    },
    redactKeys: resolved.logging.redactKeys,
  })

  // The shipped store is file-backed; the credential store is the one service the
  // plugin consumes structurally, so it stands in for `ctx.credentials` here.
  const credentialValues = new Map()
  const credentials = {
    async resolve(ref) {
      const value = credentialValues.get(ref)
      return value === undefined ? undefined : { value, source: 'stored' }
    },
    async set(ref, value) {
      credentialValues.set(ref, value)
    },
    async unset(ref) {
      credentialValues.delete(ref)
    },
  }
  const resolver = createCredentialResolver({ secrets: resolved.secrets, credentials, profiles: store, redactor, logger, env: {} })
  const knownHosts = createKnownHostsVerifier({ file: resolved.knownHostsFile, policy: resolved.hostKey.policy, logger })

  // ── 1. the user saves a profile and a secret ──────────────────────────────
  const profile = await store.save({ name: 'prod web-01', host: 'prod.example.com', port: 22, user: 'deploy', auth: 'password' })
  const persisted = await resolver.set(profile.id, 'password', PASSWORD, true)
  assert.equal(persisted.persisted, true)
  await resolver.set(profile.id, 'passphrase', PASSPHRASE, false)

  // ── 2. the connection layer resolves it and logs/audits as it works ───────
  const stored = store.get(profile.id)
  const secrets = await resolver.resolve(stored)
  assert.equal(secrets.password, PASSWORD, 'the connection layer does get the plaintext in memory')
  assert.equal(secrets.passphrase, PASSPHRASE)

  logger.info('connecting', { host: stored.host, profileId: stored.id, password: secrets.password })
  logger.warn(`authenticating as ${stored.user} with ${secrets.password}`)
  auditor.record({ op: 'connect', outcome: 'ok', profileId: stored.id, target: { host: stored.host, port: 22, user: stored.user }, durationMs: 788 })
  auditor.record({
    op: 'exec',
    outcome: 'ok',
    profileId: stored.id,
    sessionId: 's_1',
    detail: { command: 'uname -a', password: PASSWORD, url: `ssh://deploy:${PASSWORD}@prod.example.com:22` },
  })
  auditor.record({ op: 'auth-fail', outcome: 'error', profileId: stored.id, detail: { reason: `rejected ${PASSPHRASE}`, encoded: Buffer.from(PASSPHRASE).toString('base64') } })

  // ── 3. the host key is accepted and recorded ──────────────────────────────
  const outcome = await knownHosts.verify({ host: stored.host, port: stored.port, keyType: 'ssh-rsa', key: KEY })
  assert.equal(outcome.ok, true)

  // ── 4. the UI projection ─────────────────────────────────────────────────
  const view = toConnProfileView(stored, await resolver.describe(stored))
  assert.equal(view.secrets.password.present, true)
  assert.equal(view.secrets.password.source, 'keychain')
  assert.equal(view.secrets.password.masked, SECRET_MASK)
  assert.equal(view.secrets.passphrase.present, true)
  assert.equal(view.secretRefs.password, 'DSH_SSH_PROD_WEB_01_PASSWORD')

  // ── the artifacts, searched one by one ───────────────────────────────────
  const profileFile = readFileSync(resolved.profilesFile, 'utf8')
  assertClean('profilesFile', profileFile)
  assert.ok(profileFile.includes('DSH_SSH_PROD_WEB_01_PASSWORD'), 'the reference is what is stored')

  const auditFile = readFileSync(resolved.auditFile, 'utf8')
  assertClean('auditFile', auditFile)
  assert.ok(auditFile.split('\n').filter(Boolean).length >= 3, 'the audit recorded every event')

  const logFile = readFileSync(join(home, 'logs', 'dsh-ssh', 'plugin.jsonl'), 'utf8')
  assertClean('plugin.jsonl', logFile)
  assert.ok(logFile.includes(SECRET_MASK))

  const knownHostsFile = readFileSync(resolved.knownHostsFile, 'utf8')
  assertClean('known_hosts', knownHostsFile)
  const [name, keyType, encoded] = knownHostsFile.trim().split(/\s+/)
  assert.equal(name, hostKeyLookupName('prod.example.com', 22))
  assert.equal(keyType, 'ssh-rsa')
  assert.ok(Buffer.from(encoded, 'base64').equals(KEY), 'the appended line is the SSH wire blob, so a real ssh client can read it')

  const query = await auditor.query({})
  assertClean('queryAudit result', JSON.stringify(query))
  assert.equal(query.total >= 3, true)

  const resolvedJson = JSON.stringify(secrets)
  assertClean('JSON.stringify(resolvedSecrets)', resolvedJson)
  assert.ok(resolvedJson.includes(SECRET_MASK))

  const viewJson = JSON.stringify(view)
  assertClean('ConnProfileView', viewJson)

  const publicConfig = JSON.stringify(toPublicConfig(resolved))
  assertClean('PublicConfig', publicConfig)
  assert.equal(publicConfig.includes('redactKeys'), false)
  assert.ok(publicConfig.includes(JSON.stringify(resolved.profilesFile).slice(1, -1)), 'resolved paths stay visible: an operator needs them and a path is not a credential')

  // ── 5. the audit still answers the questions the UI asks ─────────────────
  const execEntries = await auditor.query({ kinds: ['exec'] })
  assert.equal(execEntries.total, 1)
  assert.equal(execEntries.entries[0].detail.password, SECRET_MASK)
  assert.match(execEntries.entries[0].detail.url, /^ssh:\/\/deploy:•{8}@prod\.example\.com:22$/)
  const failures = await auditor.query({ kinds: ['auth-fail'] })
  assert.match(failures.entries[0].detail.reason, /rejected •{8}/)
  assert.equal(failures.entries[0].detail.encoded.includes(Buffer.from(PASSPHRASE).toString('base64')), false, 'a base64 spelling is caught too')

  // ── 6. clearing leaves no trace but the audit trail ─────────────────────
  await resolver.clear(profile.id, 'password')
  assert.equal(credentialValues.has('DSH_SSH_PROD_WEB_01_PASSWORD'), false)
  const afterClear = await resolver.describe(stored)
  assert.equal(afterClear.password.present, false)
  assert.equal(afterClear.password.masked, '')
})
