/**
 * Cross-module wiring: the connection pool driven by **SP4's real**
 * `CredentialResolver` and `KnownHostsVerifier`, against a **real** ssh2 server.
 *
 * My own unit tests use doubles so they can drive impossible states; this file
 * is the opposite: it proves that the structural ports I consume are actually
 * satisfied by SP4's shipped implementations, end to end, including the
 * known_hosts file on disk. It is the earliest possible integration signal for
 * the Lead's `src/api/**` seam.
 *
 * Each test owns one ssh2 `Server` plus one pool, and tears both down in a
 * single hook (pool first, then the listener) so no test can leave a socket open.
 */

import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import ssh2 from 'ssh2'

import { createConnectionPool } from '../../lib/connection/index.js'
import { createCredentialResolver } from '../../lib/credentials.js'
import { createKnownHostsVerifier, knownHostsLine } from '../../lib/known-hosts.js'
import { SshError } from '../../lib/protocol.js'
import { makeConfig, makeTarget, memoryLogger, startSshServer, trackingRedactor } from './connection-fixture.test.mjs'

const PASSWORD = 'integration-secret-pw'
const PROFILE_NAME = 'integration-host'

/** Start a server + pool pair and register one ordered teardown for both. */
async function wire(t, options = {}) {
  const server = await startSshServer(options.serverOptions ?? {})
  const redactor = options.redactor ?? trackingRedactor()
  const pool = createConnectionPool({
    config: makeConfig(),
    logger: memoryLogger(),
    redactor,
    ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
    ...(options.knownHosts === undefined ? {} : { knownHosts: options.knownHosts }),
    env: {},
    platform: 'linux',
  })
  t.after(async () => {
    await pool.disposeAll('integration teardown')
    await server.close()
  })
  return { server, pool, redactor }
}

async function tempKnownHosts(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ssh-t1-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return join(dir, 'known_hosts')
}

/** A stored entry for this host/port pointing at a *different* key. */
function seedForeignKey(file, port) {
  const otherKey = ssh2.utils.generateKeyPairSync('ed25519', { comment: 'foreign' })
  const parsed = ssh2.utils.parseKey(otherKey.public)
  assert.ok(!(parsed instanceof Error), 'the fixture key must parse')
  return writeFile(file, `${knownHostsLine('127.0.0.1', port, 'ssh-ed25519', parsed.getPublicSSH())}\n`, 'utf8')
}

test('SP4 credentials resolve from the environment and drive a real login', async (t) => {
  const redactor = trackingRedactor()
  const resolver = createCredentialResolver({
    secrets: { provider: 'env', envPrefix: 'DSH_SSH_' },
    env: { DSH_SSH_INTEGRATION_HOST_PASSWORD: PASSWORD },
    redactor,
  })
  const { server, pool } = await wire(t, { serverOptions: { password: PASSWORD }, credentials: resolver, redactor })

  // The resolver agrees with the ICD §6 precedence: env beats a one-shot value.
  const profile = makeTarget(server, { name: PROFILE_NAME, secrets: {} })
  const resolvedSecrets = await resolver.resolve(profile, { password: 'one-shot-loses' })
  assert.equal(resolvedSecrets.password, PASSWORD)

  // And the pool consumes SP4's object directly through the port it declares.
  const session = await pool.acquire({ profile })
  assert.equal(session.state, 'connected')
  assert.match(session.hostKeyFingerprint, /^SHA256:/)
  assert.equal(redactor.trackedCount() >= 1, true, 'the resolved plaintext is registered for scrubbing')
  assert.equal(server.state.authAttempts.some((attempt) => attempt.method === 'password'), true)
})

test('SP4 known-hosts verifier remembers a new key, then accepts it strictly', async (t) => {
  const file = await tempKnownHosts(t)
  const { server, pool } = await wire(t, {
    serverOptions: { password: PASSWORD },
    knownHosts: createKnownHostsVerifier({ file, policy: 'accept-new' }),
  })
  const profile = makeTarget(server, { name: PROFILE_NAME, secrets: { password: PASSWORD } })

  const session = await pool.acquire({ profile })
  assert.equal(session.state, 'connected')
  const written = await readFile(file, 'utf8')
  assert.ok(written.includes('ssh-ed25519'), `expected a host key line, got: ${JSON.stringify(written)}`)
  assert.ok(written.includes('127.0.0.1'), 'the entry is addressable by host')

  // The same file, now under `strict`, verifies the key without any prompt.
  const strict = createConnectionPool({
    config: makeConfig(),
    logger: memoryLogger(),
    redactor: trackingRedactor(),
    knownHosts: createKnownHostsVerifier({ file, policy: 'strict' }),
    env: {},
    platform: 'linux',
  })
  t.after(() => strict.disposeAll('strict teardown'))
  const second = await strict.acquire({ profile: { ...profile, hostKeyPolicy: 'strict' }, forceNew: true })
  assert.equal(second.state, 'connected')
  assert.equal(second.hostKeyFingerprint, session.hostKeyFingerprint, 'same key, same fingerprint')
})

test('SP4 known-hosts reports a changed key and the pool fails closed', async (t) => {
  const file = await tempKnownHosts(t)
  const { server, pool } = await wire(t, {
    serverOptions: { password: PASSWORD },
    knownHosts: createKnownHostsVerifier({ file, policy: 'strict' }),
  })
  await seedForeignKey(file, server.port)

  await assert.rejects(
    () => pool.acquire({ profile: makeTarget(server, { name: PROFILE_NAME, secrets: { password: PASSWORD } }) }),
    (error) => {
      assert.ok(error instanceof SshError)
      assert.equal(error.code, 'SSH_HOSTKEY_MISMATCH')
      assert.equal(error.details.knownHostsMatch, 'changed')
      assert.match(String(error.details.fingerprint), /^SHA256:/)
      return true
    },
  )
})

test('an unknown host under strict policy is refused before authentication', async (t) => {
  const file = await tempKnownHosts(t)
  const { server, pool } = await wire(t, {
    serverOptions: { password: PASSWORD },
    knownHosts: createKnownHostsVerifier({ file, policy: 'strict' }),
  })
  await assert.rejects(
    () =>
      pool.acquire({
        profile: makeTarget(server, { name: PROFILE_NAME, secrets: { password: PASSWORD }, hostKeyPolicy: 'strict' }),
      }),
    (error) => error instanceof SshError && error.code === 'SSH_HOSTKEY_UNKNOWN',
  )
  assert.equal(server.state.authAttempts.length, 0, 'no credential was offered to an untrusted host')
})

test('a changed key can be accepted for this session through the prompt', async (t) => {
  const file = await tempKnownHosts(t)
  const { server, pool } = await wire(t, {
    serverOptions: { password: PASSWORD },
    knownHosts: createKnownHostsVerifier({ file, policy: 'accept-new' }),
  })
  await seedForeignKey(file, server.port)

  const prompts = []
  const session = await pool.acquire({
    profile: makeTarget(server, { name: PROFILE_NAME, secrets: { password: PASSWORD } }),
    onHostKeyPrompt: async (question) => {
      prompts.push(question)
      return 'accept'
    },
  })
  assert.equal(session.state, 'connected')
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].knownHostsMatch, 'changed')
  assert.equal(prompts[0].fingerprint.startsWith('SHA256:'), true)
  // A mismatch is never silently written back to known_hosts: the acceptance is
  // session-scoped, so the file still holds the old key.
  const after = await readFile(file, 'utf8')
  assert.equal(after.includes(session.hostKeyFingerprint), false)
})
