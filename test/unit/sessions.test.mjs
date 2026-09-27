/**
 * `SessionRegistry` (ICD §7.1): the projection store the UI reads, plus the
 * per-session concurrency gate that answers over-limit calls with
 * `SSH_LIMIT_QUEUE_FULL` instead of queueing.
 *
 * The store is also the last line of defence for credentials: everything it
 * accepts or returns passes through the redactor and the key-name scrubber.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { scanForSecrets } from '../../lib/connection/index.js'
import { OperationLimiter } from '../../lib/connection/semaphore.js'
import { createSessionRegistry, SessionRegistryImpl } from '../../lib/sessions.js'
import { SshError } from '../../lib/protocol.js'
import { memoryLogger, trackingRedactor } from './connection-fixture.test.mjs'

const SECRET = 'registry-secret-pw'

function fakeInfo(overrides = {}) {
  return {
    id: 's_1',
    profileId: 'p_1',
    label: 'prod',
    host: 'example.com',
    port: 22,
    user: 'deploy',
    state: 'connected',
    since: '2025-01-01T00:00:00.000Z',
    metrics: { connectMs: 12, bytesIn: 0, bytesOut: 0 },
    capabilities: { shell: true, sftp: true },
    ...overrides,
  }
}

function fakeHandle(overrides = {}) {
  return { id: 's_1', info: fakeInfo(overrides.info), state: overrides.state ?? 'connected' }
}

test('create registers a projection and notifies subscribers', () => {
  const registry = createSessionRegistry({ maxConcurrentOpsPerSession: 2 })
  const events = []
  registry.subscribe((info, event) => events.push([event, info.id]))

  const created = registry.create(fakeHandle())
  assert.equal(created.id, 's_1')
  assert.equal(created.state, 'connected')
  assert.deepEqual(events, [['added', 's_1']])
  assert.equal(registry.get('s_1').label, 'prod')
  assert.equal(registry.list().length, 1)
  assert.equal(registry.get('nope'), undefined)
})

test('create is idempotent per id and re-registration reports an update', () => {
  const registry = createSessionRegistry({ maxConcurrentOpsPerSession: 2 })
  const events = []
  registry.subscribe((_info, event) => events.push(event))
  registry.create(fakeHandle())
  registry.create(fakeHandle({ info: { state: 'error' } }))
  assert.deepEqual(events, ['added', 'updated'])
  assert.equal(registry.list().length, 1)
  assert.equal(registry.get('s_1').state, 'error')
})

test('update merges nested objects and ignores unknown or credential-shaped keys', () => {
  const registry = createSessionRegistry({ maxConcurrentOpsPerSession: 2 })
  registry.create(fakeHandle())
  registry.update('s_1', {
    state: 'closing',
    metrics: { rttMs: 31 },
    capabilities: { sftp: false },
    password: 'should never be stored',
    nonsense: true,
  })
  const info = registry.get('s_1')
  assert.equal(info.state, 'closing')
  assert.equal(info.metrics.rttMs, 31)
  assert.equal(info.metrics.connectMs, 12, 'untouched metrics survive')
  assert.equal(info.capabilities.sftp, false)
  assert.equal(info.capabilities.shell, true, 'untouched capabilities survive')
  assert.equal('password' in info, false)
  assert.equal('nonsense' in info, false)
})

test('a late update for a removed session is ignored', () => {
  const registry = createSessionRegistry({ maxConcurrentOpsPerSession: 2 })
  const events = []
  registry.create(fakeHandle())
  registry.subscribe((_info, event) => events.push(event))
  registry.remove('s_1')
  registry.update('s_1', { state: 'connected' })
  registry.update('ghost', { state: 'connected' })
  assert.deepEqual(events, ['removed'])
  assert.equal(registry.list().length, 0)
  assert.equal(registry.get('s_1'), undefined)
})

test('readers receive deep copies that cannot corrupt the store', () => {
  const registry = createSessionRegistry({ maxConcurrentOpsPerSession: 2 })
  registry.create(fakeHandle())
  const first = registry.get('s_1')
  first.state = 'tampered'
  first.metrics.bytesIn = 999
  first.capabilities.sftp = false
  const second = registry.get('s_1')
  assert.equal(second.state, 'connected')
  assert.equal(second.metrics.bytesIn, 0)
  assert.equal(second.capabilities.sftp, true)

  const created = registry.create(fakeHandle({ info: { id: 's_2' } }))
  created.label = 'mutated'
  assert.equal(registry.get('s_2').label, 'prod')
})

test('remove reports the last projection and unsubscribing stops delivery', () => {
  const registry = createSessionRegistry({ maxConcurrentOpsPerSession: 2 })
  const seen = []
  const unsubscribe = registry.subscribe((info, event) => seen.push([event, info.state]))
  registry.create(fakeHandle())
  registry.update('s_1', { state: 'closing' })
  unsubscribe()
  registry.remove('s_1')
  assert.deepEqual(seen, [
    ['added', 'connected'],
    ['updated', 'closing'],
  ])
})

test('a throwing subscriber cannot break the registry', () => {
  const registry = createSessionRegistry({
    maxConcurrentOpsPerSession: 2,
    logger: memoryLogger(),
  })
  const seen = []
  registry.subscribe(() => {
    throw new Error('subscriber exploded')
  })
  registry.subscribe((_info, event) => seen.push(event))
  registry.create(fakeHandle())
  registry.update('s_1', { state: 'closing' })
  registry.remove('s_1')
  assert.deepEqual(seen, ['added', 'updated', 'removed'])
})

test('the projection is redacted before it is stored or returned', () => {
  const redactor = trackingRedactor()
  redactor.track(SECRET)
  const registry = createSessionRegistry({ maxConcurrentOpsPerSession: 2, redactor })
  registry.create(
    fakeHandle({
      info: { label: `leaked ${SECRET}`, extra: { password: SECRET }, error: { code: 'SSH_AUTH_FAILED', message: `bad ${SECRET}`, retryable: false } },
    }),
  )
  const info = registry.get('s_1')
  assert.equal(JSON.stringify(info).includes(SECRET), false)
  assert.equal(info.label, 'leaked ••••••••')
  assert.equal('extra' in info, false, 'unknown keys never enter the projection')
  assert.equal(info.error.code, 'SSH_AUTH_FAILED')
  assert.equal(scanForSecrets(info, [SECRET]).length, 0)
})

test('run executes the task with an abort signal and releases its slot', async () => {
  const registry = createSessionRegistry({ maxConcurrentOpsPerSession: 2 })
  const signals = []
  const results = await Promise.all([
    registry.run('s_1', 'a', async (signal) => {
      signals.push(signal)
      assert.equal(signal.aborted, false)
      return 'A'
    }),
    registry.run('s_1', 'b', async () => 'B'),
  ])
  assert.deepEqual(results, ['A', 'B'])
  assert.equal(signals.length, 1)
  assert.equal(registry.activeOps('s_1'), 0)

  // The slot is released on failure too.
  await assert.rejects(
    () =>
      registry.run('s_1', 'boom', async () => {
        throw new Error('task failed')
      }),
    /task failed/,
  )
  assert.equal(registry.activeOps('s_1'), 0)
})

test('run refuses work beyond maxConcurrentOpsPerSession', async () => {
  const registry = new SessionRegistryImpl({ maxConcurrentOpsPerSession: 2 })
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const running = [registry.run('s_1', 'op-1', () => gate), registry.run('s_1', 'op-2', () => gate)]
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(registry.activeOps('s_1'), 2)

  await assert.rejects(
    () => registry.run('s_1', 'op-3', async () => 'never'),
    (error) => {
      assert.ok(error instanceof SshError)
      assert.equal(error.code, 'SSH_LIMIT_QUEUE_FULL')
      assert.equal(error.retryable, true)
      assert.equal(error.details.op, 'op-3')
      assert.equal(error.details.limit, 2)
      return true
    },
  )
  release()
  await Promise.all(running)
  assert.equal(registry.activeOps('s_1'), 0)
  // Slots came back: the same session can run again.
  assert.equal(await registry.run('s_1', 'op-4', async () => 'ok'), 'ok')
})

test('limits are per session, not global', async () => {
  const registry = createSessionRegistry({ maxConcurrentOpsPerSession: 1 })
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const first = registry.run('s_1', 'a', () => gate)
  await assert.rejects(() => registry.run('s_1', 'b', async () => 1), (error) => error.code === 'SSH_LIMIT_QUEUE_FULL')
  const other = registry.run('s_2', 'a', async () => 'other')
  release()
  assert.equal(await other, 'other')
  await first
})

test('removing a session aborts its in-flight operations', async () => {
  const registry = createSessionRegistry({ maxConcurrentOpsPerSession: 2 })
  let observed
  const pending = registry.run('s_1', 'long', (signal) => {
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        observed = signal
        reject(new Error('aborted by registry'))
      })
    })
  })
  await new Promise((resolve) => setTimeout(resolve, 5))
  registry.create(fakeHandle())
  registry.remove('s_1')
  await assert.rejects(() => pending, (error) => error instanceof SshError && error.code === 'SSH_CANCELLED')
  assert.equal(observed.aborted, true)
  assert.equal(registry.activeOps('s_1'), 0)
})

test('a task that aborts on its own becomes SSH_CANCELLED', async () => {
  const registry = createSessionRegistry({ maxConcurrentOpsPerSession: 2 })
  await assert.rejects(
    () =>
      registry.run('s_1', 'self-abort', async () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        throw error
      }),
    (error) => error instanceof SshError && error.code === 'SSH_CANCELLED' && error.details.op === 'self-abort',
  )
})

test('a non-retryable task error is rethrown unchanged', async () => {
  const registry = createSessionRegistry({ maxConcurrentOpsPerSession: 2 })
  const original = new SshError('SSH_CMD_EXIT_NONZERO', 'exit 3')
  await assert.rejects(
    () =>
      registry.run('s_1', 'exec', async () => {
        throw original
      }),
    (error) => error === original,
  )
})

test('the operation limiter hands out and reclaims slots exactly once', () => {
  const limiter = new OperationLimiter(2)
  assert.equal(limiter.limit, 2)
  assert.equal(limiter.available, 2)
  assert.equal(limiter.inFlight, 0)

  const first = limiter.tryAcquire()
  const second = limiter.tryAcquire()
  assert.equal(limiter.inFlight, 2)
  assert.equal(limiter.available, 0)
  assert.equal(limiter.tryAcquire(), undefined, 'over-limit calls are refused, not queued')

  first()
  first() // releasing twice must not inflate the count
  assert.equal(limiter.inFlight, 1)
  assert.equal(limiter.available, 1)
  second()
  assert.equal(limiter.inFlight, 0)
  assert.equal(new OperationLimiter(0).limit, 1, 'a zero limit is clamped to one')
})

test('the registry can be constructed with a logger and clock', async () => {
  const logger = memoryLogger()
  const registry = new SessionRegistryImpl({ maxConcurrentOpsPerSession: 1, logger, now: () => 1000 })
  await registry.run('s_1', 'quick', async () => 'done')
  assert.equal(logger.lines.length, 1)
  assert.match(logger.lines[0].message, /session s_1 op "quick" finished in 0ms/)
})
