/**
 * Failure classification (ICD §5), retry policy, state machine, ids and secret
 * hygiene helpers — the pure parts of the connection layer.
 *
 * The first test is the important one: every code this module can raise must
 * exist in the frozen `ERROR_CODES` table, so a typo can never reach the wire.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  assertTransition,
  backoffDelay,
  canTransition,
  classifyError,
  CONNECTION_ERROR_CODES,
  defaultSleep,
  isAbortError,
  newOpId,
  newProfileId,
  newSessionId,
  newStreamId,
  readHostKeyType,
  scanForSecrets,
  SESSION_STATES,
  SessionStateMachine,
  sshFingerprint,
  stripSecrets,
  ulid,
  withRetry,
} from '../../lib/connection/index.js'
import { ERROR_CODES, SshError } from '../../lib/protocol.js'

function coded(code, message = '', extra = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, extra)
  return error
}

function levelled(level, message) {
  const error = new Error(message)
  error.level = level
  return error
}

test('every code the connection layer raises is part of the frozen error table', () => {
  const frozen = new Set(ERROR_CODES)
  for (const code of CONNECTION_ERROR_CODES) {
    assert.ok(frozen.has(code), `${code} is not in ICD §5`)
  }
  assert.equal(new Set(CONNECTION_ERROR_CODES).size, CONNECTION_ERROR_CODES.length, 'no duplicates')
})

test('classifies socket errno values', () => {
  const cases = [
    ['ENOTFOUND', 'SSH_NET_DNS'],
    ['EAI_AGAIN', 'SSH_NET_DNS'],
    ['ECONNREFUSED', 'SSH_NET_REFUSED'],
    ['EHOSTUNREACH', 'SSH_NET_UNREACHABLE'],
    ['ENETUNREACH', 'SSH_NET_UNREACHABLE'],
    ['ECONNRESET', 'SSH_NET_RESET'],
    ['EPIPE', 'SSH_NET_RESET'],
    ['ETIMEDOUT', 'SSH_NET_TIMEOUT'],
  ]
  for (const [errno, expected] of cases) {
    const classified = classifyError(coded(errno, `connect ${errno}`), {
      phase: 'connect',
      auth: 'password',
      host: 'h',
      port: 22,
    })
    assert.equal(classified.code, expected, `${errno} → ${expected}`)
    assert.equal(classified.details.errno, errno)
    assert.equal(classified.details.host, 'h')
    assert.equal(classified.details.port, 22)
  }
})

test('classifies ssh2 error levels', () => {
  const context = { phase: 'connect', auth: 'password' }
  assert.equal(classifyError(levelled('client-dns', 'boom'), context).code, 'SSH_NET_DNS')
  assert.equal(classifyError(levelled('agent', 'Agent: no keys'), { phase: 'connect', auth: 'agent' }).code, 'SSH_AUTH_AGENT_UNAVAILABLE')
  assert.equal(classifyError(levelled('sftp-protocol', 'bad packet'), { phase: 'runtime' }).code, 'SSH_SFTP_PROTOCOL')
  assert.equal(
    classifyError(levelled('client-timeout', 'Timed out while waiting for handshake'), context).code,
    'SSH_TIMEOUT_CONNECT',
  )
  assert.equal(classifyError(levelled('client-timeout', 'Keepalive timeout'), { phase: 'runtime' }).code, 'SSH_TIMEOUT_IDLE')
})

test('classifies authentication failures without inventing codes', () => {
  const cases = [
    ['All configured authentication methods failed', 'password', 'SSH_AUTH_FAILED'],
    ['All configured authentication methods failed', 'agent', 'SSH_AUTH_AGENT_UNAVAILABLE'],
    ['All configured authentication methods failed', 'privateKey', 'SSH_AUTH_FAILED'],
    ['Encrypted private OpenSSH key detected, but no passphrase given', 'privateKey', 'SSH_AUTH_PASSPHRASE_REQUIRED'],
    ['OpenSSH key integrity check failed -- bad passphrase?', 'privateKey', 'SSH_AUTH_PASSPHRASE_REQUIRED'],
    ['Unsupported key format', 'privateKey', 'SSH_AUTH_KEY_UNREADABLE'],
    ['Cannot parse privateKey: bad key', 'privateKey', 'SSH_AUTH_KEY_UNREADABLE'],
    ['No matching authentication method found', 'password', 'SSH_AUTH_METHOD_UNSUPPORTED'],
  ]
  for (const [message, auth, expected] of cases) {
    const classified = classifyError(levelled('client-authentication', message), { phase: 'connect', auth })
    assert.equal(classified.code, expected, `${message} → ${expected}`)
  }
})

test('classifies channel, handshake and unknown failures', () => {
  assert.equal(
    classifyError(new Error('Channel open failure: administratively prohibited'), { phase: 'runtime' }).code,
    'SSH_STATE_INVALID',
  )
  assert.equal(
    classifyError(new Error('Channel open failure: no more sessions'), { phase: 'connect' }).code,
    'SSH_NET_RESET',
  )
  assert.equal(classifyError(levelled('protocol', 'Connection lost before handshake'), { phase: 'connect' }).code, 'SSH_NET_RESET')
  assert.equal(classifyError(new Error('no matching host key format'), { phase: 'connect' }).code, 'SSH_UNKNOWN')
  assert.equal(classifyError(new Error('something entirely new'), { phase: 'runtime' }).code, 'SSH_UNKNOWN')
})

test('a stashed host-key verdict wins over the generic ssh2 message', () => {
  const hostKeyError = new SshError('SSH_HOSTKEY_UNKNOWN', 'not in known_hosts', {
    details: { fingerprint: 'SHA256:abc', host: 'h', port: 22 },
  })
  const classified = classifyError(new Error('Host denied (verification failed)'), {
    phase: 'connect',
    auth: 'password',
    hostKeyError,
  })
  assert.equal(classified.code, 'SSH_HOSTKEY_UNKNOWN')
  assert.equal(classified.details.fingerprint, 'SHA256:abc')
})

test('a host-key denial without a stashed verdict fails closed', () => {
  const classified = classifyError(new Error('Host denied (verification failed)'), { phase: 'connect' })
  assert.equal(classified.code, 'SSH_HOSTKEY_MISMATCH')
})

test('an SshError passes through unchanged and an abort becomes SSH_CANCELLED', () => {
  const original = new SshError('SSH_CFG_INVALID', 'bad input', { details: { field: 'host' } })
  const classified = classifyError(original, { phase: 'connect' })
  assert.equal(classified.code, 'SSH_CFG_INVALID')
  assert.equal(classified.details.field, 'host')

  const abort = new Error('aborted')
  abort.name = 'AbortError'
  assert.equal(isAbortError(abort), true)
  assert.equal(classifyError(abort, { phase: 'runtime' }).code, 'SSH_CANCELLED')

  const codeAbort = coded('ABORT_ERR', 'nope')
  assert.equal(isAbortError(codeAbort), true)
  assert.equal(isAbortError(new Error('ordinary')), false)
})

test('readHostKeyType parses the wire blob and rejects malformed ones', () => {
  const name = Buffer.from('ssh-ed25519', 'ascii')
  const blob = Buffer.concat([Buffer.from([0, 0, 0, name.length]), name, Buffer.alloc(32, 7)])
  assert.equal(readHostKeyType(blob), 'ssh-ed25519')
  assert.equal(readHostKeyType(Buffer.alloc(0)), 'unknown')
  assert.equal(readHostKeyType(Buffer.from([0, 0, 0, 200])), 'unknown')
  assert.equal(readHostKeyType(Buffer.concat([Buffer.from([0, 0, 0, 3]), Buffer.from([0x01, 0x02, 0x03])])), 'unknown')
})

test('sshFingerprint matches the OpenSSH SHA256 form', async () => {
  const { createHash } = await import('node:crypto')
  const blob = Buffer.from('some-host-key-blob')
  const expected = `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`
  assert.equal(sshFingerprint(blob), expected)
  assert.equal(sshFingerprint(blob).endsWith('='), false, 'no base64 padding')
})

test('backoff is exponential, capped and optionally jittered', () => {
  const policy = { max: 4, backoffBaseMs: 500, backoffMaxMs: 5000, jitter: false }
  assert.deepEqual(
    [0, 1, 2, 3, 4, 10].map((attempt) => backoffDelay(attempt, policy)),
    [500, 1000, 2000, 4000, 5000, 5000],
  )
  const jittered = { ...policy, jitter: true }
  assert.equal(backoffDelay(0, jittered, () => 0), 375, '-25%')
  assert.equal(backoffDelay(0, jittered, () => 1), 625, '+25%')
  assert.equal(backoffDelay(0, jittered, () => 0.5), 500, 'neutral')
})

test('withRetry replays retryable failures and gives up at the policy limit', async () => {
  const policy = { max: 2, backoffBaseMs: 1, backoffMaxMs: 4, jitter: false }
  const attempts = []
  const retries = []
  const result = await withRetry(
    async (attempt) => {
      attempts.push(attempt)
      if (attempt < 3) throw new SshError('SSH_NET_REFUSED', 'refused')
      return 'ok'
    },
    { policy, sleep: async () => {}, onRetry: (info) => retries.push([info.attempt, info.code, info.delayMs]) },
  )
  assert.equal(result, 'ok')
  assert.deepEqual(attempts, [1, 2, 3])
  assert.deepEqual(retries, [
    [1, 'SSH_NET_REFUSED', 1],
    [2, 'SSH_NET_REFUSED', 2],
  ])

  const alwaysFails = new SshError('SSH_TIMEOUT_CONNECT', 'handshake timeout')
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          throw alwaysFails
        },
        { policy, sleep: async () => {} },
      ),
    (error) => error === alwaysFails,
  )
})

test('withRetry never replays non-retryable failures or a narrowed code set', async () => {
  let calls = 0
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls += 1
          throw new SshError('SSH_AUTH_FAILED', 'denied')
        },
        { policy: { max: 5, backoffBaseMs: 1, backoffMaxMs: 1, jitter: false }, sleep: async () => {} },
      ),
    (error) => error.code === 'SSH_AUTH_FAILED',
  )
  assert.equal(calls, 1)

  let narrowed = 0
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          narrowed += 1
          throw new SshError('SSH_NET_REFUSED', 'refused')
        },
        {
          policy: { max: 5, backoffBaseMs: 1, backoffMaxMs: 1, jitter: false },
          shouldRetry: () => false,
          sleep: async () => {},
        },
      ),
    (error) => error.code === 'SSH_NET_REFUSED',
  )
  assert.equal(narrowed, 1)
})

test('withRetry stops when the signal is aborted', async () => {
  const controller = new AbortController()
  let calls = 0
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls += 1
          controller.abort()
          throw new SshError('SSH_NET_REFUSED', 'refused')
        },
        {
          policy: { max: 5, backoffBaseMs: 1, backoffMaxMs: 1, jitter: false },
          signal: controller.signal,
          sleep: async () => {},
        },
      ),
    (error) => error.code === 'SSH_CANCELLED',
  )
  assert.equal(calls, 1)
})

test('defaultSleep resolves immediately for zero and aborts with SSH_CANCELLED', async () => {
  await defaultSleep(0)
  const controller = new AbortController()
  const pending = defaultSleep(5000, controller.signal)
  controller.abort()
  await assert.rejects(() => pending, (error) => error.code === 'SSH_CANCELLED')

  const preAborted = new AbortController()
  preAborted.abort()
  await assert.rejects(() => defaultSleep(10, preAborted.signal), (error) => error.code === 'SSH_CANCELLED')
})

test('the state machine accepts the documented transitions only', () => {
  assert.equal(canTransition('idle', 'connecting'), true)
  assert.equal(canTransition('connecting', 'authenticating'), true)
  assert.equal(canTransition('authenticating', 'connected'), true)
  assert.equal(canTransition('connected', 'closing'), true)
  assert.equal(canTransition('closing', 'closed'), true)
  assert.equal(canTransition('error', 'connecting'), true, 'a retry may reuse the handle')
  assert.equal(canTransition('closed', 'connected'), false)
  assert.equal(canTransition('idle', 'connected'), false)
  assert.throws(
    () => assertTransition('closed', 'connected'),
    (error) => error instanceof SshError && error.code === 'SSH_STATE_INVALID' && error.details.from === 'closed',
  )
  for (const state of SESSION_STATES) assert.equal(canTransition(state, state), true)
})

test('SessionStateMachine publishes changes once and survives a throwing listener', () => {
  const machine = new SessionStateMachine('idle')
  const seen = []
  const unsubscribe = machine.subscribe((change) => {
    seen.push(`${change.from}->${change.to}`)
    throw new Error('listener exploded')
  })
  assert.equal(machine.set('connecting'), true)
  assert.equal(machine.set('connecting'), false, 'same state is a no-op')
  assert.equal(machine.state, 'connecting')
  unsubscribe()
  assert.equal(machine.set('authenticating'), true)
  assert.deepEqual(seen, ['idle->connecting'])
})

test('identifiers are prefixed, unique and time ordered', () => {
  assert.match(newSessionId(), /^s_[0-9A-HJKMNP-TV-Z]{26}$/)
  assert.match(newStreamId(), /^st_[0-9A-HJKMNP-TV-Z]{26}$/)
  assert.match(newOpId(), /^op_[0-9A-HJKMNP-TV-Z]{26}$/)
  assert.match(newProfileId(), /^p_[0-9A-HJKMNP-TV-Z]{26}$/)
  const ids = new Set()
  for (let i = 0; i < 500; i++) ids.add(ulid())
  assert.equal(ids.size, 500)
  assert.ok(ulid(1_000_000) < ulid(2_000_000), 'lexicographic order follows the timestamp')
})

test('stripSecrets deep-copies and drops credential-shaped keys', () => {
  const input = {
    id: 's_1',
    password: 'pw-secret-1',
    nested: { passphrase: 'pp-secret-2', token: 'tok-secret-3', keep: 'ok' },
    list: [{ privateKey: 'key-secret-4', keep: true }],
    buffer: Buffer.from('secret-bytes'),
    date: new Date('2025-01-01T00:00:00.000Z'),
    error: new Error('boom'),
  }
  const out = stripSecrets(input)
  assert.deepEqual(out, {
    id: 's_1',
    nested: { keep: 'ok' },
    list: [{ keep: true }],
    buffer: '<12 bytes>',
    date: '2025-01-01T00:00:00.000Z',
    error: { name: 'Error', message: 'boom' },
  })
  assert.equal(input.password, 'pw-secret-1', 'the input is never mutated')
  assert.deepEqual(scanForSecrets(out, ['pw-secret-1', 'pp-secret-2', 'tok-secret-3', 'key-secret-4']), [])
  assert.deepEqual(scanForSecrets({ a: [{ b: 'contains-pw-secret-1' }] }, ['pw-secret-1']), ['$.a[0].b'])
  assert.deepEqual(scanForSecrets(out, []), [])
})
