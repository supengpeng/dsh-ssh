/**
 * §4.7 agent activity, through the real wire service.
 *
 * Two properties are worth a test rather than a comment, because both are easy to
 * get subtly wrong and impossible to see from the panel:
 *
 *   - **The snapshot is the first frame.** A subscriber must be able to render the
 *     history it missed without a second round trip, and a record that started
 *     between "subscribe" and "list" must not be invisible. `followSessions` and
 *     `followAudit` share this shape; this test is what keeps the third one honest.
 *   - **`clearActivity` is host state, not a client filter.** It must drop the ring
 *     *and* tell every attached subscriber, or a reloaded page and an open one
 *     would disagree about what the agent did.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { ActivityFeed } from '../../lib/activity/feed.js'
import { Config, resolveConfig } from '../../lib/config.js'
import { LocalApi } from '../../lib/api/local-api.js'
import { SshPluginService } from '../../lib/service.js'

const root = mkdtempSync(join(tmpdir(), 'dsh-ssh-activity-'))
after(() => rmSync(root, { recursive: true, force: true }))

let counter = 0
/** The smallest service that can serve §4.7: a config, a logger, a feed. */
function harness(options = {}) {
  counter += 1
  const home = join(root, `case-${counter}`)
  const config = resolveConfig(Config({}), { DSH_HOME: home })
  const logger = { debug() {}, info() {}, warn() {}, error() {} }
  let now = 1_000
  const activity = new ActivityFeed({ now: () => now, ...(options.feed ?? {}) })
  const deps = {
    config,
    logger,
    redactor: { scrub: (value) => value, forgetAll() {} },
    store: { list: () => [] },
    credentials: {},
    knownHosts: {},
    audit: { record() {}, async flush() {} },
    activity,
    // §4.7 must not need a connection, a pool or a transfer: the mirror records
    // what the *tools* did, and the tools own those services, not this endpoint.
    pool: {},
    registry: { list: () => [] },
    exec: { limits: {}, dispose() {} },
    transfers: {},
  }
  const service = new SshPluginService({}, config, logger, { api: new LocalApi(deps) })
  return {
    service,
    activity,
    advance: (ms) => {
      now += ms
    },
  }
}

test('followActivity opens with the retained history, then relays live events in order', async () => {
  const h = harness()

  // History the subscriber missed: one finished command, one that never ended.
  h.activity.begin({ kind: 'exec', sessionId: 's_1', subject: 'uptime', target: 'root@h.example' })
  const finished = h.activity.begin({ kind: 'listDir', sessionId: 's_1', subject: '/var/log' })
  finished.finish({ status: 'ok', note: '3 entries' })

  const stream = h.service.followActivity('{}')
  const iterator = stream[Symbol.asyncIterator]()

  const first = await iterator.next()
  assert.equal(first.done, false)
  assert.equal(first.value.t, 'activity-snapshot', 'the snapshot must be the first frame')
  assert.equal(first.value.activities.length, 2, 'every retained record is in the snapshot')
  assert.equal(first.value.activities[0].subject, 'uptime')
  assert.equal(first.value.activities[1].status, 'ok')

  // Live: a command that starts, produces output on both channels, then ends.
  const handle = h.activity.begin({ kind: 'exec', sessionId: 's_1', subject: 'ls -la', cwd: '/tmp' })
  const began = await iterator.next()
  assert.deepEqual(
    { t: began.value.t, phase: began.value.phase, subject: began.value.activity.subject, status: began.value.activity.status },
    { t: 'activity', phase: 'begin', subject: 'ls -la', status: 'running' },
  )
  assert.equal(began.value.activity.cwd, '/tmp')

  handle.chunk('stdout', 'total 0\n')
  const chunk = await iterator.next()
  assert.equal(chunk.value.t, 'activity')
  assert.equal(chunk.value.phase, 'chunk')
  assert.equal(chunk.value.id, handle.id, 'a chunk is addressed by record id, not resent whole')
  assert.deepEqual(chunk.value.chunk, { channel: 'stdout', text: 'total 0\n' })

  handle.chunk('stderr', 'permission denied\n')
  const stderr = await iterator.next()
  assert.equal(stderr.value.chunk.channel, 'stderr')

  h.advance(42)
  handle.finish({ status: 'ok', exitCode: 0 })
  const ended = await iterator.next()
  assert.equal(ended.value.phase, 'end')
  assert.equal(ended.value.activity.status, 'ok')
  assert.equal(ended.value.activity.exitCode, 0)
  assert.equal(ended.value.activity.durationMs, 42)
  assert.deepEqual(
    ended.value.activity.segments.map((segment) => segment.channel),
    ['stdout', 'stderr'],
    'the framed end frame carries the whole transcript, not just its tail',
  )

  // Cancelling the stream (what the carrier does when the client goes away)
  // releases the feed subscription; a later event must not throw.
  await iterator.return()
  handle.finish({ status: 'error' })
  assert.equal(h.activity.snapshot().length, 3)
})

test('clearActivity drops the retained history and resets every subscriber', async () => {
  const h = harness()
  h.activity.begin({ kind: 'exec', sessionId: 's_1', subject: 'one' }).finish({ status: 'ok' })
  h.activity.begin({ kind: 'exec', sessionId: 's_1', subject: 'two' }).finish({ status: 'ok' })

  const iterator = h.service.followActivity('{}')[Symbol.asyncIterator]()
  const snapshot = await iterator.next()
  assert.equal(snapshot.value.activities.length, 2)

  assert.deepEqual(await h.service.clearActivity(), { cleared: 2 })
  const reset = await iterator.next()
  assert.equal(reset.value.t, 'activity-reset', 'an attached subscriber is told, not left with a stale view')
  assert.deepEqual(h.activity.snapshot(), [])
  await iterator.return()
})

test('a disabled feed serves an empty stream instead of failing', async () => {
  const h = harness({ feed: { enabled: false } })
  h.activity.begin({ kind: 'exec', sessionId: 's_1', subject: 'never recorded' })

  const iterator = h.service.followActivity('{}')[Symbol.asyncIterator]()
  const first = await iterator.next()
  assert.deepEqual(first.value, { t: 'activity-snapshot', activities: [] })
  assert.deepEqual(await h.service.clearActivity(), { cleared: 0 })
  await iterator.return()
})
