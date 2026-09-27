/**
 * Authentication planning (ICD §4.2 `auth: password | privateKey | agent`).
 *
 * The point of these tests is precision: an unreadable key, a missing
 * passphrase, a wrong passphrase and an unavailable agent must each be reported
 * with their own ICD §5 code *before* a TCP connection is attempted.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { maskedSecret, parsePrivateKey, planAuth, resolveAgentSource, resolveProfileSecrets } from '../../lib/connection/index.js'
import { SshError } from '../../lib/protocol.js'
import { CLIENT_KEY, CLIENT_KEY_ENCRYPTED, makeProfile } from './connection-fixture.test.mjs'

const ENV_NONE = {}

async function planAuthError(profile, options = {}) {
  try {
    await planAuth(profile, { env: ENV_NONE, platform: 'linux', ...options })
  } catch (error) {
    assert.ok(error instanceof SshError, `expected an SshError, got ${String(error)}`)
    return error
  }
  throw new Error('planAuth unexpectedly succeeded')
}

test('password auth carries the credential and a masked description', async () => {
  const plan = await planAuth(makeProfile({ auth: 'password', secrets: { password: 'hunter2' } }), { env: ENV_NONE })
  assert.equal(plan.kind, 'password')
  assert.equal(plan.config.username, 'tester')
  assert.equal(plan.config.password, 'hunter2')
  assert.equal(plan.describe().includes('hunter2'), false, 'describe() must never leak')
  assert.equal(plan.describe(), 'password(••••••••)')
})

test('password auth without a password is a configuration error', async () => {
  const error = await planAuthError(makeProfile({ auth: 'password', secrets: {} }))
  assert.equal(error.code, 'SSH_CFG_INVALID')
  assert.equal(error.details.field, 'password')
})

test('a missing user name is rejected before anything else', async () => {
  const error = await planAuthError(makeProfile({ user: '   ', secrets: { password: 'x' } }))
  assert.equal(error.code, 'SSH_CFG_INVALID')
  assert.equal(error.details.field, 'user')
})

test('private key auth reads the key file once and reports its path on failure', async () => {
  const reads = []
  const plan = await planAuth(
    makeProfile({ auth: 'privateKey', secretRefs: { privateKeyPath: '/keys/id_ed25519' }, secrets: {} }),
    {
      env: ENV_NONE,
      readFile: async (path) => {
        reads.push(path)
        return Buffer.from(CLIENT_KEY.private)
      },
    },
  )
  assert.deepEqual(reads, ['/keys/id_ed25519'])
  assert.equal(plan.kind, 'privateKey')
  assert.ok(Buffer.isBuffer(plan.config.privateKey))
  assert.equal(plan.describe(), 'privateKey(/keys/id_ed25519)')

  const missing = await planAuthError(makeProfile({ auth: 'privateKey', secretRefs: { privateKeyPath: '/keys/nope' }, secrets: {} }), {
    readFile: async () => {
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
    },
  })
  assert.equal(missing.code, 'SSH_AUTH_KEY_UNREADABLE')
  assert.equal(missing.details.path, '/keys/nope')
})

test('private key auth accepts inline PEM material', async () => {
  const plan = await planAuth(makeProfile({ auth: 'privateKey', secrets: { privateKey: CLIENT_KEY.private } }), { env: ENV_NONE })
  assert.equal(plan.describe(), 'privateKey(inline)')
})

test('private key auth without any key material is a configuration error', async () => {
  const error = await planAuthError(makeProfile({ auth: 'privateKey', secretRefs: {}, secrets: {} }))
  assert.equal(error.code, 'SSH_CFG_INVALID')
  assert.equal(error.details.field, 'privateKeyPath')
})

test('an encrypted key without a passphrase asks for one', async () => {
  const error = await planAuthError(
    makeProfile({ auth: 'privateKey', secrets: { privateKey: CLIENT_KEY_ENCRYPTED.private } }),
  )
  assert.equal(error.code, 'SSH_AUTH_PASSPHRASE_REQUIRED')
  assert.equal(error.message.includes('passphrase'), true)
})

test('a wrong passphrase is reported as a passphrase problem, not a broken key', async () => {
  const error = await planAuthError(
    makeProfile({ auth: 'privateKey', secrets: { privateKey: CLIENT_KEY_ENCRYPTED.private, passphrase: 'wrong-pw' } }),
  )
  assert.equal(error.code, 'SSH_AUTH_PASSPHRASE_REQUIRED')
})

test('a correct passphrase produces a usable plan', async () => {
  const plan = await planAuth(
    makeProfile({ auth: 'privateKey', secrets: { privateKey: CLIENT_KEY_ENCRYPTED.private, passphrase: 'key-pass' } }),
    { env: ENV_NONE },
  )
  assert.equal(plan.kind, 'privateKey')
  assert.equal(plan.config.passphrase, 'key-pass')
  assert.equal(plan.describe(), 'privateKey(inline, encrypted)')
  assert.equal(plan.describe().includes('key-pass'), false)
})

test('a malformed key is unreadable rather than a passphrase problem', async () => {
  const error = await planAuthError(makeProfile({ auth: 'privateKey', secrets: { privateKey: 'not a key at all' } }))
  assert.equal(error.code, 'SSH_AUTH_KEY_UNREADABLE')
})

test('parsePrivateKey accepts a valid key and rejects garbage', () => {
  parsePrivateKey(Buffer.from(CLIENT_KEY.private), undefined)
  assert.throws(
    () => parsePrivateKey(Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----\nnope\n'), undefined, '/k'),
    (error) => error instanceof SshError && error.code === 'SSH_AUTH_KEY_UNREADABLE' && error.details.path === '/k',
  )
})

test('agent resolution prefers an explicit socket, then the environment, then Pageant', () => {
  assert.equal(resolveAgentSource({ agentSocket: '/tmp/agent.sock' }, { SSH_AUTH_SOCK: '/env.sock' }, 'linux'), '/tmp/agent.sock')
  assert.equal(resolveAgentSource({}, { SSH_AUTH_SOCK: '/env.sock' }, 'linux'), '/env.sock')
  assert.equal(resolveAgentSource({}, {}, 'win32'), 'pageant')
  assert.equal(resolveAgentSource({}, {}, 'linux'), undefined)
  assert.equal(resolveAgentSource({}, { SSH_AUTH_SOCK: '   ' }, 'linux'), undefined)
})

test('agent auth without a reachable agent reports SSH_AUTH_AGENT_UNAVAILABLE', async () => {
  const error = await planAuthError(makeProfile({ auth: 'agent', secrets: {} }))
  assert.equal(error.code, 'SSH_AUTH_AGENT_UNAVAILABLE')
  assert.equal(error.message.includes('agent'), true)
})

test('agent auth passes the socket through and never describes it verbatim', async () => {
  const plan = await planAuth(makeProfile({ auth: 'agent', secrets: { agentSocket: '/tmp/agent.sock' } }), { env: ENV_NONE })
  assert.equal(plan.config.agent, '/tmp/agent.sock')
  assert.equal(plan.describe(), 'agent(socket)')
  const pageant = await planAuth(makeProfile({ auth: 'agent', secrets: {} }), { env: {}, platform: 'win32' })
  assert.equal(pageant.config.agent, 'pageant')
  assert.equal(pageant.describe(), 'agent(pageant)')
})

test('an unknown auth kind is rejected instead of silently degrading', async () => {
  const error = await planAuthError(makeProfile({ auth: 'kerberos', secrets: {} }))
  assert.equal(error.code, 'SSH_CFG_INVALID')
  assert.equal(error.details.auth, 'kerberos')
})

test('resolveProfileSecrets prefers inline secrets and falls back to the resolver', async () => {
  const inline = makeProfile({ secrets: { password: 'inline' } })
  assert.equal((await resolveProfileSecrets(inline, undefined)).secrets.password, 'inline')

  const calls = []
  const credentials = {
    async resolve(profile) {
      calls.push(profile.id)
      return { password: 'resolved', source: { password: 'env', passphrase: 'none' } }
    },
  }
  const resolved = await resolveProfileSecrets(makeProfile({ secrets: {} }), credentials)
  assert.deepEqual(calls, ['p_test'])
  assert.equal(resolved.secrets.password, 'resolved')
  // Extra fields on sp4's `ResolvedSecrets` (source/toJSON) are harmless.
  assert.equal(resolved.secrets.source.password, 'env')

  const empty = await resolveProfileSecrets(makeProfile({ secrets: {} }), undefined)
  assert.deepEqual(empty.secrets, {})
})

test('maskedSecret never reveals a length', () => {
  assert.equal(maskedSecret(undefined), '')
  assert.equal(maskedSecret(''), '')
  assert.equal(maskedSecret('a'), '••••••••')
  assert.equal(maskedSecret('a-very-long-password'), '••••••••')
})
