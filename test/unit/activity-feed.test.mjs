/**
 * The agent-activity mirror (ICD §4.7): ring bookkeeping, the two text budgets,
 * subscriber isolation, and the mirror's one hard promise — that it can never
 * fail the operation it observes.
 *
 * Every timestamp is driven by an injected clock, so nothing here depends on wall
 * time, on a real connection, or on how fast the machine is.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ActivityFeed } from '../../lib/activity/feed.js'

// ── helpers ─────────────────────────────────────────────────────────────────

/** A clock the test drives: the feed reads `now()`, the test calls `set`/`advance`. */
function scriptedClock(start = 1000) {
  let value = start
  const now = () => value
  now.set = (next) => {
    value = next
  }
  now.advance = (delta) => {
    value += delta
  }
  return now
}

/** A clock that steps backwards, to prove the feed clamps instead of trusting it. */
function countingDownClock(start) {
  let value = start
  return () => {
    value -= 10
    return value
  }
}

/** A feed with a scripted clock, a recording logger and a recording subscriber. */
function makeFeed({ start = 1000, ...options } = {}) {
  const now = options.now ?? scriptedClock(start)
  const warns = []
  const feed = new ActivityFeed({
    now,
    logger: { warn: (message, fields) => warns.push({ message, fields }) },
    ...options,
  })
  const events = []
  feed.subscribe((event) => events.push(event))
  return { feed, now, events, warns }
}

function begin(feed, input = {}) {
  return feed.begin({ kind: 'exec', subject: 'uname -a', ...input })
}

/** `id` + `status` of every retained record, oldest first. */
function shape(feed) {
  return feed.snapshot().map((record) => `${record.id}:${record.status}`)
}

function chunkEvents(events) {
  return events.filter((event) => event.t === 'activity' && event.phase === 'chunk')
}

// ── ids ─────────────────────────────────────────────────────────────────────

test('ids are monotonic per feed and never reused after clear', () => {
  const { feed } = makeFeed()
  const first = begin(feed)
  const second = begin(feed)
  assert.equal(first.id, 'act-1')
  assert.equal(second.id, 'act-2')

  second.finish({ status: 'ok' })
  assert.equal(feed.clear(), 1)

  const third = begin(feed)
  assert.equal(third.id, 'act-3', 'the counter is not reset by clear()')
  assert.deepEqual(shape(feed), ['act-1:running', 'act-3:running'])
})

// ── begin ───────────────────────────────────────────────────────────────────

test('begin retains a running record and announces a deep copy', () => {
  const { feed, now, events } = makeFeed({ start: 5000 })
  now.set(5000)
  const handle = feed.begin({
    kind: 'exec',
    subject: 'uname -a',
    sessionId: 'sess-1',
    cwd: '/tmp',
    label: 'probe',
    target: 'user@host',
  })

  assert.equal(feed.size(), 1)
  assert.equal(events.length, 1)
  const [event] = events
  assert.equal(event.t, 'activity')
  assert.equal(event.phase, 'begin')
  assert.deepEqual(event.activity, {
    id: 'act-1',
    kind: 'exec',
    sessionId: 'sess-1',
    target: 'user@host',
    subject: 'uname -a',
    cwd: '/tmp',
    label: 'probe',
    startedAt: 5000,
    endedAt: null,
    durationMs: null,
    status: 'running',
    exitCode: null,
    signal: null,
    code: null,
    note: null,
    segments: [],
    truncated: false,
  })
  assert.deepEqual(event.activity, handle.view())

  // The event carries a copy, not the retained record.
  event.activity.subject = 'rewritten'
  event.activity.segments.push({ channel: 'stdout', text: 'injected' })
  const [view] = feed.snapshot()
  assert.equal(view.subject, 'uname -a')
  assert.deepEqual(view.segments, [])
  assert.equal(view.status, 'running')
  assert.equal(view.endedAt, null)
  assert.equal(view.durationMs, null)
  assert.equal(view.truncated, false)
})

test('begin normalises the optional fields to null when they are absent', () => {
  const { feed } = makeFeed()
  const handle = feed.begin({ kind: 'sessions', subject: 'ssh_sessions' })
  const view = handle.view()
  assert.equal(view.sessionId, null)
  assert.equal(view.target, null)
  assert.equal(view.cwd, null)
  assert.equal(view.label, null)
  assert.equal(view.kind, 'sessions')
})

// ── chunks ──────────────────────────────────────────────────────────────────

test('chunks merge into the previous segment while the channel repeats', () => {
  const { feed, events } = makeFeed()
  const handle = begin(feed)
  handle.chunk('stdout', 'line 1\n')
  handle.chunk('stdout', 'line 2\n')
  handle.chunk('stderr', 'warn\n')
  handle.chunk('stdout', 'line 3\n')

  assert.deepEqual(feed.snapshot()[0].segments, [
    { channel: 'stdout', text: 'line 1\nline 2\n' },
    { channel: 'stderr', text: 'warn\n' },
    { channel: 'stdout', text: 'line 3\n' },
  ])

  const emitted = chunkEvents(events)
  assert.equal(emitted.length, 4)
  assert.deepEqual(emitted[0], {
    t: 'activity',
    phase: 'chunk',
    id: 'act-1',
    chunk: { channel: 'stdout', text: 'line 1\n' },
  })
  assert.equal(emitted[3].chunk.channel, 'stdout')
})

test('an empty chunk is a no-op', () => {
  const { feed, events } = makeFeed()
  const handle = begin(feed)
  handle.chunk('stdout', '')
  assert.deepEqual(feed.snapshot()[0].segments, [])
  assert.equal(feed.snapshot()[0].truncated, false, 'an empty chunk drops nothing')
  assert.equal(events.length, 1, 'only the begin event was emitted')
})

test('the per-record cap keeps the head, drops the tail and flags it', () => {
  const { feed, events } = makeFeed({ maxRecordBytes: 8 })
  const handle = begin(feed)
  handle.chunk('stdout', 'abcdef')
  handle.chunk('stdout', 'ghijkl')

  assert.deepEqual(feed.snapshot()[0].segments, [{ channel: 'stdout', text: 'abcdefgh' }])
  assert.equal(feed.snapshot()[0].truncated, true)
  assert.equal(chunkEvents(events).length, 2)
  assert.equal(chunkEvents(events)[1].chunk.text, 'gh', 'the event carries only what was retained')

  // No room left: the flag stays set and there is nothing left to announce.
  handle.chunk('stderr', 'more')
  assert.equal(chunkEvents(events).length, 2)
  assert.deepEqual(feed.snapshot()[0].segments, [{ channel: 'stdout', text: 'abcdefgh' }])
  assert.equal(feed.snapshot()[0].truncated, true)
})

test('the cap never cuts a multi-byte character in half', () => {
  const { feed } = makeFeed({ maxRecordBytes: 4 })
  const handle = begin(feed)
  handle.chunk('stdout', '中文字')
  const [segment] = feed.snapshot()[0].segments
  assert.equal(segment.text, '中', '3 bytes fit in a 4-byte budget, the next character does not')
  assert.ok(Buffer.byteLength(segment.text, 'utf8') <= 4)
  assert.equal(feed.snapshot()[0].truncated, true)

  const emoji = makeFeed({ maxRecordBytes: 3 })
  const emojiHandle = begin(emoji.feed)
  emojiHandle.chunk('stdout', '😀')
  assert.deepEqual(emoji.feed.snapshot()[0].segments, [], 'a 4-byte character cannot be split to fit 3')
  assert.equal(emoji.feed.snapshot()[0].truncated, true)
})

test('chunks after finish are ignored', () => {
  const { feed, events } = makeFeed()
  const handle = begin(feed)
  handle.chunk('stdout', 'before')
  handle.finish({ status: 'ok' })
  const sealed = feed.snapshot()[0]
  const count = events.length

  assert.doesNotThrow(() => {
    handle.chunk('stdout', 'after')
    handle.chunk('stderr', 'late')
  })
  assert.deepEqual(feed.snapshot()[0], sealed)
  assert.equal(events.length, count)
})

// ── finish ──────────────────────────────────────────────────────────────────

test('finish sets the terminal fields and emits exactly one end event', () => {
  const { feed, now, events } = makeFeed({ start: 1000 })
  const handle = begin(feed)
  handle.chunk('stdout', 'Linux\n')
  now.advance(250)
  handle.finish({ status: 'ok', exitCode: 0, note: 'exit 0' })

  const [view] = feed.snapshot()
  assert.equal(view.status, 'ok')
  assert.equal(view.endedAt, 1250)
  assert.equal(view.durationMs, 250)
  assert.equal(view.exitCode, 0)
  assert.equal(view.signal, null)
  assert.equal(view.code, null)
  assert.equal(view.note, 'exit 0')

  const ends = events.filter((event) => event.t === 'activity' && event.phase === 'end')
  assert.equal(ends.length, 1)
  assert.deepEqual(ends[0], { t: 'activity', phase: 'end', activity: view })

  ends[0].activity.segments.push({ channel: 'stderr', text: 'injected' })
  assert.equal(feed.snapshot()[0].segments.length, 1, 'the end event carries a copy too')
})

test('a failed call keeps its code, signal and status', () => {
  const { feed } = makeFeed({ start: 100 })
  const handle = begin(feed, { kind: 'upload', subject: 'local → remote' })
  handle.finish({ status: 'timeout', exitCode: null, signal: 'KILL', code: 'SSH_TIMEOUT_OPERATION', note: 'deadline' })
  const [view] = feed.snapshot()
  assert.equal(view.status, 'timeout')
  assert.equal(view.exitCode, null)
  assert.equal(view.signal, 'KILL')
  assert.equal(view.code, 'SSH_TIMEOUT_OPERATION')
  assert.equal(view.durationMs, 0)
})

test('finish text lands as one final info segment, even after streamed info', () => {
  const { feed, events } = makeFeed()
  const handle = begin(feed, { kind: 'listDir', subject: '/var/log' })
  handle.chunk('info', 'streamed')
  handle.finish({ status: 'ok', text: '3 entries' })

  const expected = [
    { channel: 'info', text: 'streamed' },
    { channel: 'info', text: '3 entries' },
  ]
  assert.deepEqual(feed.snapshot()[0].segments, expected)
  assert.deepEqual(events.at(-1).activity.segments, expected, 'the end event already carries it')
})

test('a second finish changes nothing and emits nothing', () => {
  const { feed, events } = makeFeed()
  const handle = begin(feed)
  handle.finish({ status: 'ok', exitCode: 0, text: 'first' })
  const sealed = feed.snapshot()[0]
  const count = events.length

  handle.finish({ status: 'error', exitCode: 9, note: 'second', text: 'second' })
  assert.deepEqual(feed.snapshot()[0], sealed)
  assert.equal(events.length, count)
  assert.equal(sealed.note, null)
  assert.deepEqual(sealed.segments, [{ channel: 'info', text: 'first' }])
})

test('finish ORs the truncated flag and caps the appended text', () => {
  const capped = makeFeed({ maxRecordBytes: 4 })
  const cappedHandle = begin(capped.feed)
  cappedHandle.chunk('stdout', 'abcdef')
  cappedHandle.finish({ status: 'ok', truncated: false })
  assert.equal(capped.feed.snapshot()[0].truncated, true, 'finish never clears the flag')

  const clean = makeFeed()
  const cleanHandle = begin(clean.feed)
  cleanHandle.finish({ status: 'cancelled', truncated: true })
  assert.equal(clean.feed.snapshot()[0].truncated, true)

  const text = makeFeed({ maxRecordBytes: 6 })
  const textHandle = begin(text.feed)
  textHandle.finish({ status: 'ok', text: '0123456789' })
  assert.deepEqual(text.feed.snapshot()[0].segments, [{ channel: 'info', text: '012345' }])
  assert.equal(text.feed.snapshot()[0].truncated, true)
})

// ── ring budgets ────────────────────────────────────────────────────────────

test('finished records beyond maxRecords are dropped oldest first, running ones stay', () => {
  const { feed, events } = makeFeed({ maxRecords: 2 })
  const running = begin(feed, { subject: 'tail -f' })
  for (let index = 0; index < 4; index += 1) {
    const handle = begin(feed, { subject: `call ${index}` })
    handle.finish({ status: 'ok' })
  }

  // act-1 is the oldest record, but it is still running: it is never a candidate,
  // so the two newest finished records are what survives.
  assert.deepEqual(shape(feed), ['act-1:running', 'act-4:ok', 'act-5:ok'])
  assert.equal(running.view().status, 'running')
  assert.equal(
    events.filter((event) => event.t === 'activity-reset').length,
    0,
    'eviction is silent',
  )
})

test('maxRecords 0 keeps only what is still running', () => {
  const { feed } = makeFeed({ maxRecords: 0 })
  const running = begin(feed, { subject: 'tail -f' })
  const done = begin(feed)
  done.finish({ status: 'ok' })
  assert.deepEqual(shape(feed), ['act-1:running'])
  assert.equal(running.id, 'act-1')
})

test('the feed-wide text budget evicts oldest finished records until it fits', () => {
  const { feed } = makeFeed({ maxTotalBytes: 20, maxRecordBytes: 100 })
  const running = begin(feed, { subject: 'tail -f' })
  running.chunk('stdout', 'r'.repeat(10))
  const first = begin(feed, { subject: 'call 1' })
  first.chunk('stdout', 'a'.repeat(10))
  first.finish({ status: 'ok' })
  const second = begin(feed, { subject: 'call 2' })
  second.chunk('stdout', 'b'.repeat(10))
  second.finish({ status: 'ok' })

  // 30 bytes of text over a 20-byte budget: the oldest *finished* record goes, the
  // running one at the front of the ring does not.
  assert.deepEqual(shape(feed), ['act-1:running', 'act-3:ok'])
  assert.deepEqual(feed.snapshot()[1].segments, [{ channel: 'stdout', text: 'b'.repeat(10) }])
})

test('a single record larger than the whole budget stays', () => {
  const { feed } = makeFeed({ maxTotalBytes: 5, maxRecordBytes: 100 })
  const only = begin(feed)
  only.chunk('stdout', 'x'.repeat(20))
  only.finish({ status: 'ok' })
  assert.equal(feed.size(), 1, 'the ring is never emptied to satisfy the byte budget')
  assert.equal(feed.snapshot()[0].segments[0].text.length, 20)

  // A second over-budget record makes the first one evictable; the newest stays, so
  // the panel is never left blank.
  const newer = begin(feed)
  newer.chunk('stdout', 'y'.repeat(20))
  newer.finish({ status: 'ok' })
  assert.deepEqual(shape(feed), ['act-2:ok'])
  assert.deepEqual(feed.snapshot()[0].segments, [{ channel: 'stdout', text: 'y'.repeat(20) }])
})

test('eviction never drops a record that is still running', () => {
  const { feed } = makeFeed({ maxTotalBytes: 8, maxRecordBytes: 100 })
  const running = begin(feed, { subject: 'tail -f' })
  running.chunk('stdout', 'z'.repeat(40))
  const done = begin(feed)
  done.chunk('stdout', 'y'.repeat(8))
  done.finish({ status: 'ok' })

  assert.deepEqual(shape(feed), ['act-1:running'], 'the running record outlives every candidate')
  assert.equal(feed.snapshot()[0].segments[0].text.length, 40)
})

// ── snapshots and subscribers ───────────────────────────────────────────────

test('snapshot returns deep copies of records and segments', () => {
  const { feed } = makeFeed()
  const handle = begin(feed)
  handle.chunk('stdout', 'original')
  handle.finish({ status: 'ok', note: 'done' })

  const first = feed.snapshot()
  first.push({ id: 'injected' })
  first[0].subject = 'rewritten'
  first[0].note = 'rewritten'
  first[0].segments.push({ channel: 'stderr', text: 'injected' })
  first[0].segments[0].text = 'rewritten'
  first[0].segments[0].channel = 'stderr'

  const second = feed.snapshot()
  assert.equal(second.length, 1)
  assert.equal(second[0].subject, 'uname -a')
  assert.equal(second[0].note, 'done')
  assert.deepEqual(second[0].segments, [{ channel: 'stdout', text: 'original' }])
})

test('a throwing subscriber breaks neither the producer nor the other subscribers', () => {
  const warnings = []
  const feed = new ActivityFeed({ logger: { warn: (message, fields) => warnings.push({ message, fields }) } })
  const seen = []
  feed.subscribe(() => {
    throw new Error('pane exploded')
  })
  feed.subscribe((event) => seen.push(event))

  const handle = feed.begin({ kind: 'exec', subject: 'uname -a' })
  handle.chunk('stdout', 'Linux\n')
  handle.finish({ status: 'ok' })

  assert.deepEqual(
    seen.map((event) => event.phase),
    ['begin', 'chunk', 'end'],
    'the healthy subscriber saw every event',
  )
  assert.equal(feed.snapshot()[0].status, 'ok', 'the operation it observes completed')
  assert.equal(warnings.length, 3)
  assert.equal(warnings[0].message, 'activity subscriber failed')
  assert.equal(warnings[0].fields.reason, 'pane exploded')
})

test('unsubscribe stops delivery and is safe to call twice', () => {
  const { feed, events } = makeFeed()
  const extra = []
  const off = feed.subscribe((event) => extra.push(event))

  const handle = begin(feed)
  assert.equal(extra.length, 1)
  off()
  off()

  handle.finish({ status: 'ok' })
  assert.equal(extra.length, 1)
  assert.equal(events.length, 2, 'the other subscriber is unaffected')
})

test('a logger that throws cannot break the operation', () => {
  const feed = new ActivityFeed({
    logger: {
      warn: () => {
        throw new Error('log sink is dead')
      },
    },
  })
  feed.subscribe(() => {
    throw new Error('pane exploded')
  })

  const handle = feed.begin({ kind: 'exec', subject: 'uname -a' })
  assert.doesNotThrow(() => {
    handle.chunk('stdout', 'Linux\n')
    handle.finish({ status: 'ok' })
  })
  assert.equal(feed.snapshot()[0].status, 'ok')
})

test('clear drops every finished record, keeps running ones and announces the reset', () => {
  const { feed, events } = makeFeed()
  const running = begin(feed, { subject: 'still going' })
  const done = begin(feed, { subject: 'finished' })
  done.finish({ status: 'ok' })

  assert.equal(feed.clear(), 1)
  assert.deepEqual(shape(feed), ['act-1:running'])
  assert.equal(running.view().status, 'running')
  assert.equal(events.at(-1).t, 'activity-reset')

  const count = events.length
  assert.equal(feed.clear(), 0, 'nothing left to drop')
  assert.equal(events.length, count, 'no reset frame when nothing was dropped')
})

// ── disabled and disposed ───────────────────────────────────────────────────

test('enabled false records nothing and emits nothing', () => {
  const { feed, events } = makeFeed({ enabled: false })
  assert.equal(feed.enabled, false)

  const handle = begin(feed)
  assert.equal(handle.id, 'act-1')
  assert.doesNotThrow(() => {
    handle.chunk('stdout', 'invisible')
    handle.finish({ status: 'ok', text: 'invisible' })
  })

  assert.deepEqual(feed.snapshot(), [])
  assert.equal(feed.size(), 0)
  assert.equal(feed.clear(), 0)
  assert.equal(events.length, 0)

  // The handle still answers with a well-formed view of what was asked for.
  const view = handle.view()
  assert.equal(view.subject, 'uname -a')
  assert.equal(view.status, 'running')
  assert.equal(view.endedAt, null)
  assert.deepEqual(view.segments, [])
})

test('dispose is idempotent, finishes nothing and stops delivery', () => {
  const { feed, events } = makeFeed()
  const running = begin(feed, { subject: 'tail -f' })
  running.chunk('stdout', 'stream')
  const count = events.length

  assert.doesNotThrow(() => {
    feed.dispose()
    feed.dispose()
  })
  assert.deepEqual(feed.snapshot(), [], 'dispose releases the captured output')
  assert.equal(feed.size(), 0)
  assert.equal(events.length, count, 'no event is delivered after dispose')

  // Nothing was *finished*: the handle still reports the record as it was, and
  // records it holds are its own copies rather than the released ring.
  const held = running.view()
  assert.equal(held.status, 'running')
  assert.equal(held.endedAt, null)
  assert.deepEqual(held.segments, [{ channel: 'stdout', text: 'stream' }])

  // Handles taken out before dispose are as inert as the ones taken after it.
  running.chunk('stdout', 'late')
  running.finish({ status: 'ok' })
  assert.equal(running.view().endedAt, null)
  assert.deepEqual(running.view().segments, [{ channel: 'stdout', text: 'stream' }])

  const after = begin(feed)
  after.chunk('stdout', 'nothing')
  after.finish({ status: 'ok' })
  assert.equal(feed.size(), 0)
  assert.equal(after.view().endedAt, null)
  assert.deepEqual(after.view().segments, [])

  const late = []
  feed.subscribe((event) => late.push(event))
  begin(feed, { subject: 'after dispose' })
  assert.equal(late.length, 0)
  assert.equal(events.length, count)
})

// ── the mirror never fails what it observes ─────────────────────────────────

test('begin, chunk and finish never throw, whatever they are handed', () => {
  const { feed } = makeFeed()

  assert.doesNotThrow(() => {
    const nonsense = feed.begin(undefined)
    assert.equal(nonsense.view().kind, 'exec')
    assert.equal(nonsense.view().subject, 'exec', 'an unusable subject falls back to the kind')
    nonsense.chunk(undefined, undefined)
    nonsense.finish(undefined)
  })

  const handle = feed.begin({ kind: 'nonsense', subject: 42, sessionId: 7, cwd: '', label: {}, target: [] })
  const view = handle.view()
  assert.equal(view.kind, 'exec', 'a kind outside the frozen vocabulary is normalised')
  assert.equal(view.subject, 'exec')
  assert.equal(view.sessionId, null)
  assert.equal(view.cwd, null, 'an empty string is not a value the pane can draw')
  assert.equal(view.label, null)
  assert.equal(view.target, null)

  assert.doesNotThrow(() => {
    handle.chunk('nonsense', 1234)
    handle.chunk(null, null)
    handle.chunk('stdout', undefined)
    handle.finish({ status: 'nonsense', exitCode: 'zero', signal: 5, code: {}, note: [], truncated: 'yes' })
  })
  const finished = feed.snapshot().find((record) => record.id === handle.id)
  assert.equal(finished.status, 'error', 'an unreadable outcome is never reported as ok')
  assert.equal(finished.exitCode, null)
  assert.equal(finished.signal, null)
  assert.equal(finished.code, null)
  assert.equal(finished.note, null)
  assert.equal(finished.truncated, false, 'only a boolean true sets the flag')

  // A clock that answers nonsense cannot put NaN on the wire either.
  const broken = new ActivityFeed({ now: () => Number.NaN })
  const brokenHandle = broken.begin({ kind: 'exec', subject: 'x' })
  brokenHandle.finish({ status: 'ok' })
  const brokenView = broken.snapshot()[0]
  assert.ok(Number.isFinite(brokenView.startedAt))
  assert.ok(Number.isFinite(brokenView.endedAt))
  assert.ok(Number.isFinite(brokenView.durationMs))
  assert.ok(brokenView.durationMs >= 0)
})

test('timestamps come from the injected clock and a backwards clock is clamped', () => {
  const { feed, now } = makeFeed({ start: 1000 })
  const handle = begin(feed, { kind: 'connect', subject: 'user@host' })
  now.advance(75)
  handle.finish({ status: 'ok' })
  const [view] = feed.snapshot()
  assert.equal(view.startedAt, 1000)
  assert.equal(view.endedAt, 1075)
  assert.equal(view.durationMs, 75)

  const backwards = new ActivityFeed({ now: countingDownClock(500) })
  const rewind = backwards.begin({ kind: 'exec', subject: 'x' })
  rewind.finish({ status: 'ok' })
  assert.equal(backwards.snapshot()[0].durationMs, 0, 'a negative duration would render as nonsense')
})

test('an input whose getters throw is recorded as nothing, not as a failure', () => {
  const { feed } = makeFeed()
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error('getter exploded')
      },
    },
  )

  let handle
  assert.doesNotThrow(() => {
    handle = feed.begin(hostile)
  })
  assert.equal(handle.id, 'act-1')
  assert.equal(feed.size(), 0, 'a record nothing could describe was not left behind')
  assert.deepEqual(feed.snapshot(), [])
  assert.equal(handle.view().kind, 'exec', 'the handle still answers with a usable view')
  assert.equal(handle.view().subject, 'exec')

  // The counters keep moving, so the next real record is not handed a live id.
  const real = feed.begin({ kind: 'exec', subject: 'uname -a' })
  assert.equal(real.id, 'act-2')

  // A hostile *finish* input cannot half-apply either: nothing is mutated.
  const sealed = () => JSON.stringify(feed.snapshot())
  assert.doesNotThrow(() => real.finish(hostile))
  assert.equal(sealed(), sealed())
  assert.equal(real.view().status, 'running', 'an unreadable outcome is not invented')

  // Even a getter that throws *after* the first field: no terminal state is
  // written without the `end` event that would announce it.
  const lateBoom = {
    status: 'ok',
    exitCode: 0,
    get text() {
      throw new Error('late boom')
    },
  }
  assert.doesNotThrow(() => real.finish(lateBoom))
  assert.equal(real.view().endedAt, null)
  assert.equal(real.view().status, 'running')
  assert.equal(real.view().exitCode, null)

  // The record is still usable afterwards, which is what "read before commit"
  // buys: the tool's next (sane) report still lands.
  real.finish({ status: 'ok', exitCode: 0 })
  assert.equal(real.view().status, 'ok')
  assert.equal(real.view().endedAt, 1000)
})
