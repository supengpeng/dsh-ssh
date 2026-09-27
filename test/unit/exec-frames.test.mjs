/**
 * Frame scheduling invariants, output limiting and byte decoding (ICD §3, §4.4).
 *
 * These are the rules every other layer (and SP8's conformance suite) asserts
 * against, so they are tested directly rather than only through a running
 * command.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ChannelDecoder, completeUtf8Length } from '../../lib/exec/encoding.js'
import { FrameWriter, inspectFrameSequence, requiresExit } from '../../lib/exec/frames.js'
import { OutputLimiter } from '../../lib/exec/limits.js'
import { newStreamId } from '../../lib/exec/ids.js'

function writerOf(options = {}) {
  const frames = []
  const writer = new FrameWriter({
    streamId: options.streamId ?? 'st_unit',
    kind: options.kind ?? 'exec',
    sink: (frame) => frames.push(frame),
    replayLimitBytes: options.replayLimitBytes,
    // `undefined` keeps the shipped default (8192 frames); `0` disables it.
    replayLimitFrames: options.replayLimitFrames,
    now: options.now ?? (() => 1000),
  })
  return { writer, frames }
}

// ── FrameWriter ─────────────────────────────────────────────────────────────

test('open is the first frame and carries the stream identity', () => {
  const { writer, frames } = writerOf({ kind: 'shell' })
  assert.equal(frames.length, 1)
  assert.deepEqual(frames[0], { t: 'open', streamId: 'st_unit', kind: 'shell' })
  assert.equal(writer.openedFlag, true)
  assert.equal(writer.ended, false)
  // `meta` is omitted entirely when undefined, never sent as null.
  writer.data('x', 'term', 'utf8')
  assert.equal(frames[1].t, 'data')
})

test('data seq starts at 0 and increases by exactly one', () => {
  const { writer, frames } = writerOf()
  for (let index = 0; index < 25; index += 1) writer.data(`chunk-${index}`, 'stdout', 'utf8')
  const seqs = frames.filter((frame) => frame.t === 'data').map((frame) => frame.seq)
  assert.deepEqual(
    seqs,
    Array.from({ length: 25 }, (_value, index) => index),
  )
  assert.equal(writer.lastSeq, 24)
})

test('a stream carries exactly one exit and exactly one end, in that order', () => {
  const { writer, frames } = writerOf()
  writer.data('out', 'stdout', 'utf8')
  assert.equal(writer.exit({ code: 0, durationMs: 12, timedOut: false }), true)
  assert.equal(writer.exit({ code: 1, durationMs: 13, timedOut: false }), false)
  assert.equal(writer.end('completed'), true)
  assert.equal(writer.end('error'), false)
  assert.equal(writer.violations.length, 2, 'both duplicate attempts are recorded')
  assert.deepEqual(inspectFrameSequence(frames), [])
  const exitIndex = frames.findIndex((frame) => frame.t === 'exit')
  const endIndex = frames.findIndex((frame) => frame.t === 'end')
  assert.ok(exitIndex < endIndex)
})

test('frames after end are discarded instead of appended', () => {
  const { writer, frames } = writerOf()
  writer.exit({ code: 0, durationMs: 1, timedOut: false })
  writer.end('completed')
  const before = frames.length
  assert.equal(writer.data('late', 'stdout', 'utf8'), false)
  assert.equal(writer.exit({ code: 9, durationMs: 2, timedOut: false }), false)
  assert.equal(frames.length, before)
  assert.equal(writer.violations.length, 2)
})

test('end without exit is recorded for kinds that require one', () => {
  const { writer } = writerOf({ kind: 'shell' })
  assert.equal(requiresExit('shell'), true)
  writer.end('completed')
  assert.equal(writer.violations.length, 1)
  assert.match(writer.violations[0], /end\(completed\) before exit/)
})

test('exit omits an empty signal field and truncates durations', () => {
  const { writer, frames } = writerOf()
  writer.exit({ code: null, signal: '', durationMs: 3.7, timedOut: true })
  const exit = frames.find((frame) => frame.t === 'exit')
  assert.deepEqual(exit, { t: 'exit', streamId: 'st_unit', exitCode: null, durationMs: 3, timedOut: true })
})

test('replay from 0 includes everything the writer still holds', () => {
  const { writer } = writerOf()
  writer.data('a', 'stdout', 'utf8')
  writer.data('b', 'stderr', 'utf8')
  writer.exit({ code: 0, durationMs: 4, timedOut: false })
  writer.end('completed')
  const { frames, gap } = writer.replay()
  assert.equal(gap, false)
  assert.deepEqual(inspectFrameSequence(frames), [])
  assert.equal(frames.length, 5)
})

test('replay honours sinceSeq and reports a gap instead of hiding a loss', () => {
  const { writer } = writerOf({ replayLimitBytes: 8 })
  for (let index = 0; index < 10; index += 1) writer.data(`chunk-${index}`, 'stdout', 'utf8', 7)
  const fresh = writer.replay()
  assert.equal(fresh.gap, true, 'evicted data frames are reported as a gap')
  assert.equal(fresh.frames[0].t, 'open', 'a fresh subscription still starts at open')

  // The retained window is the newest frame only (7 bytes fit in an 8-byte
  // budget), so resuming from there loses nothing and must not claim a gap.
  const resumed = writer.replay(9)
  assert.equal(resumed.frames[0].t, 'data')
  assert.equal(resumed.frames[0].seq, 9)
  assert.equal(resumed.gap, false, 'resuming inside the retained window loses nothing')

  // Resuming before the window does lose frames, and says so.
  assert.equal(writer.replay(5).gap, true)
  assert.ok(writer.replayDropped > 0)
})

test('a replay window that never overflowed reports no gap', () => {
  const { writer } = writerOf({ replayLimitBytes: 4096 })
  for (let index = 0; index < 10; index += 1) writer.data('small', 'stdout', 'utf8')
  assert.equal(writer.replay().gap, false)
  assert.equal(writer.replay(5).gap, false)
})

// ── the replay log's cost and its second budget ──────────────────────────────

/** Best-of-`reps` per-frame cost of `data()` once the window is full, in µs. */
function frameCostUs(options, window, frames, reps) {
  const { writer } = writerOf(options)
  for (let index = 0; index < window + 8; index += 1) writer.data('xy', 'stdout', 'utf8', 2)
  let best = Number.POSITIVE_INFINITY
  for (let rep = 0; rep < reps; rep += 1) {
    const started = process.hrtime.bigint()
    for (let index = 0; index < frames; index += 1) writer.data('xy', 'stdout', 'utf8', 2)
    const us = Number(process.hrtime.bigint() - started) / 1000 / frames
    if (us < best) best = us
  }
  return { us: best, retained: writer.retainedDataFrames }
}

test('replay trim is O(1): a 2-byte-frame stream stays fast', () => {
  // Trim runs on *every* data frame, and it used to scan the whole log four times
  // per frame (`countData`/`findIndex`/`splice`/`find`). With the default 256 KiB
  // byte budget and 2-byte frames that is ~131k entries to walk per frame, which
  // measured ~3.5 ms/frame: the cost tracked the number of *frames* while the
  // budget was expressed in *bytes*. Eviction is now O(1) amortised, so the cost
  // per frame must not grow with the retained window.
  //
  // One warm-up pass first: at ~0.2 µs/frame these numbers are otherwise
  // dominated by JIT warm-up rather than by the eviction itself.
  frameCostUs({ replayLimitFrames: 8193 }, 8193, 20000, 1)

  const windows = [8193, 16385, 32769]
  const costs = windows.map((window) => {
    const { us, retained } = frameCostUs({ replayLimitFrames: window }, window, 5000, 5)
    assert.equal(retained, window, `${window}: the frame budget is the binding one here`)
    assert.ok(us < 20, `${window} retained frames: ${us.toFixed(2)} µs/frame`)
    return us
  })
  // The previous build measured 35 µs/frame at 8193 retained frames and 339 µs at
  // 32769 (i.e. growing with the window, as a per-frame scan must). A 4× larger
  // window may not cost more than 3× per frame.
  assert.ok(
    costs[2] < costs[0] * 3,
    `per-frame cost must not grow with the window: ${costs[0].toFixed(2)} → ${costs[2].toFixed(2)} µs/frame`,
  )
})

test('the replay log keeps at least one data frame and never drops control frames', () => {
  const { writer } = writerOf({ replayLimitBytes: 64, replayLimitFrames: 4 })
  writer.data('a', 'stdout', 'utf8', 10)
  writer.data('b', 'stdout', 'utf8', 10)
  // A frame larger than both budgets together stays: it is the only content a
  // late subscriber could be shown, so the budgets may not empty the log.
  writer.data('huge', 'stdout', 'utf8', 4096)
  writer.exit({ code: 0, durationMs: 3, timedOut: false })
  writer.end('completed')

  assert.equal(writer.retainedDataFrames, 1, 'the oversized frame is the one kept')
  assert.equal(writer.replayDropped, 2)
  const retained = writer.retained()
  assert.deepEqual(
    retained.map((frame) => frame.t),
    ['open', 'data', 'exit', 'end'],
    'open/exit/end survive eviction and keep their order',
  )
  assert.equal(retained[1].chunk, 'huge')
  assert.deepEqual(writer.violations, [])
})

test('a fresh replay reports a gap once frames were dropped', () => {
  // The drops are driven by the *frame* budget alone: 2-byte frames cannot reach
  // the 256 KiB byte budget within this many frames.
  const { writer } = writerOf({ replayLimitFrames: 16 })
  const total = 4096
  for (let index = 0; index < total; index += 1) writer.data('xy', 'stdout', 'utf8', 2)
  assert.equal(writer.retainedDataFrames, 16)
  assert.equal(writer.replayDropped, total - 16)

  const fresh = writer.replay()
  assert.equal(fresh.gap, true, 'lost frames are reported, never hidden')
  assert.equal(fresh.frames[0].t, 'open', 'a fresh subscription still starts at open')
  const data = fresh.frames.filter((frame) => frame.t === 'data')
  assert.deepEqual(
    data.map((frame) => frame.seq),
    Array.from({ length: 16 }, (_value, index) => total - 16 + index),
    'the window is the newest 16 frames, in order',
  )
  // Resuming at the oldest retained frame loses nothing; before it, it does.
  assert.equal(writer.replay(total - 16).gap, false)
  assert.equal(writer.replay(total - 17).gap, true)
})

test('the 8192-frame cap does not change behaviour for 32-byte-and-larger frames', () => {
  // 8192 × 32 equals the default byte budget, so for frames of 32 bytes or more
  // the byte budget is at least as binding as the frame cap: the cap can only
  // change behaviour for the small-frame streams it exists for.
  for (const size of [32, 64, 1024]) {
    const count = size === 32 ? 30000 : 20000
    const capped = writerOf({ replayLimitBytes: 262144 })
    const uncapped = writerOf({ replayLimitBytes: 262144, replayLimitFrames: 0 })
    const chunk = 'x'.repeat(size)
    for (let index = 0; index < count; index += 1) {
      capped.writer.data(chunk, 'stdout', 'utf8', size)
      uncapped.writer.data(chunk, 'stdout', 'utf8', size)
    }
    assert.equal(
      capped.writer.retainedDataFrames,
      uncapped.writer.retainedDataFrames,
      `${size}-byte frames: the cap changed the retained count`,
    )
    assert.equal(capped.writer.replayDropped, uncapped.writer.replayDropped, `${size}-byte frames: dropped differs`)
    assert.deepEqual(capped.writer.replay(), uncapped.writer.replay(), `${size}-byte frames: replay differs`)
    assert.equal(capped.writer.retainedDataFrames, Math.floor(262144 / size), `${size}-byte frames: byte budget wins`)
  }
})

test('the frame budget holds a small-frame window flat', () => {
  const { writer } = writerOf({ replayLimitBytes: 262144 })
  const total = 40000
  for (let index = 0; index < total; index += 1) writer.data('xy', 'stdout', 'utf8', 2)
  assert.equal(writer.retainedDataFrames, 8192, 'the default cap holds the window at 8192 frames')
  assert.equal(writer.replayDropped, total - 8192)
  assert.equal(writer.replay().gap, true)
})

test('an exit frame inside the evicted prefix survives eviction and compaction', () => {
  // Eviction only ever takes data frames, so the cursor has to walk *past* a live
  // control frame that sits in front of the oldest retained data frame — and the
  // amortised compaction must keep it rather than truncating the array.
  const { writer } = writerOf({ replayLimitBytes: 8, replayLimitFrames: 0 })
  writer.data('first', 'stdout', 'utf8', 7)
  writer.exit({ code: 0, durationMs: 1, timedOut: false })
  for (let index = 0; index < 600; index += 1) writer.data('later', 'stdout', 'utf8', 7)
  writer.end('completed')

  assert.ok(writer.replayDropped >= 590, `the log must have evicted, dropped ${writer.replayDropped}`)
  const retained = writer.retained()
  assert.deepEqual(
    retained.map((frame) => frame.t),
    ['open', 'exit', 'data', 'end'],
    'the control frames must still be part of the replay',
  )
  assert.equal(retained[2].seq, 600)
  assert.equal(
    writer.replay().frames.some((frame) => frame.t === 'exit'),
    true,
  )
  assert.deepEqual(writer.violations, [])
})

// ── inspectFrameSequence ────────────────────────────────────────────────────

test('inspectFrameSequence reports holes, double ends and misplaced exit', () => {
  const open = { t: 'open', streamId: 'st_x', kind: 'exec' }
  const data = (seq) => ({ t: 'data', streamId: 'st_x', seq, chunk: 'x', encoding: 'utf8', channel: 'stdout' })
  const exit = { t: 'exit', streamId: 'st_x', exitCode: 0, durationMs: 1, timedOut: false }
  const end = { t: 'end', streamId: 'st_x', reason: 'completed' }

  assert.deepEqual(inspectFrameSequence([open, data(0), data(1), exit, end]), [])
  assert.match(inspectFrameSequence([data(0), exit, end]).join('\n'), /first frame/)
  assert.match(inspectFrameSequence([open, data(0), data(2), exit, end]).join('\n'), /seq 2/)
  assert.match(inspectFrameSequence([open, exit, end, exit]).join('\n'), /at most one exit/)
  assert.match(inspectFrameSequence([open, end, exit]).join('\n'), /after end/)
  assert.match(inspectFrameSequence([open, data(0), end]).join('\n'), /no exit frame/)
  assert.match(inspectFrameSequence([{ t: 'open', streamId: 'a', kind: 'exec' }, { t: 'end', streamId: 'b', reason: 'completed' }]).join('\n'), /mix stream ids/)
  assert.deepEqual(inspectFrameSequence([]), ['empty frame sequence'])
})

test('inspectFrameSequence tolerates state/audit frames that have no streamId', () => {
  const frames = [
    { t: 'open', streamId: 'st_y', kind: 'shell' },
    { t: 'state', sessionId: 's_1', state: 'connected' },
    { t: 'exit', streamId: 'st_y', exitCode: 0, durationMs: 1, timedOut: false },
    { t: 'end', streamId: 'st_y', reason: 'completed' },
  ]
  // A `state` frame inside a stream is not produced by this layer, but a
  // conformance walk over a session-wide frame log must not explode on it.
  assert.deepEqual(inspectFrameSequence(frames), [])
})

// ── OutputLimiter ───────────────────────────────────────────────────────────

function limitBytes(chunks) {
  return chunks.reduce((sum, entry) => sum + entry.chunk.length, 0)
}

test('output under the budget is emitted in full and never flagged', () => {
  const limiter = new OutputLimiter(1000)
  const emitted = []
  for (let index = 0; index < 10; index += 1) emitted.push(...limiter.push('stdout', Buffer.from('x'.repeat(50))))
  const tail = limiter.flush()
  assert.equal(limitBytes(emitted) + limitBytes(tail), 500)
  assert.equal(limiter.exceeded, false)
  assert.deepEqual(limiter.flags, { stdout: false, stderr: false, term: false })
})

test('output over the budget keeps the head and the tail and flags the loss', () => {
  const limiter = new OutputLimiter(100)
  const emitted = []
  for (let index = 0; index < 10; index += 1) {
    emitted.push(...limiter.push('stdout', Buffer.from(String(index).padStart(2, '0').repeat(10))))
  }
  const tail = limiter.flush()
  const head = Buffer.concat(emitted.map((entry) => entry.chunk)).toString('utf8')
  const tailText = Buffer.concat(tail.map((entry) => entry.chunk)).toString('utf8')
  assert.equal(head.length, 50, 'head half is emitted live')
  assert.equal(tailText.length, 50, 'tail half is retained until the end')
  assert.match(head, /^00/)
  // The tail is the last 50 bytes of a 200-byte stream: the second half of
  // chunk 7, then chunks 8 and 9 (`08`/`09` repeated).
  assert.equal(tailText, '07'.repeat(5) + '08'.repeat(10) + '09'.repeat(10))
  assert.equal(limiter.exceeded, true)
  assert.equal(limiter.truncated('stdout'), true)
  assert.equal(limiter.truncated('stderr'), false)
  assert.equal(limiter.totalBytes, 200)
  assert.equal(limiter.emittedBytes, 100)
})

test('a chunk straddling the head boundary is split, never duplicated or lost', () => {
  const limiter = new OutputLimiter(12)
  const bytes = Buffer.from('中文测试', 'utf8') // 12 bytes: exactly the budget
  const emitted = limiter.push('stdout', bytes)
  const tail = limiter.flush()
  const head = Buffer.concat(emitted.map((entry) => entry.chunk))
  const tailBytes = Buffer.concat(tail.map((entry) => entry.chunk))
  assert.equal(head.length, 6, 'the head half is emitted immediately')
  assert.equal(tailBytes.length, 6)
  assert.deepEqual(Buffer.concat([head, tailBytes]), bytes, 'the two halves reassemble byte-exactly')
  assert.equal(limiter.exceeded, false, 'splitting across the halves is not truncation')
})

test('a code point split across the halves is reported, not silently mangled', () => {
  // 8 bytes of budget for 12 bytes of text: head keeps 4, tail keeps the last 4,
  // so both halves end mid-character. The bytes are reported as truncated (and
  // the pump ships each half that is not valid UTF-8 as base64) — the contract is
  // "no silent loss", not "text survives an arbitrary cut".
  const limiter = new OutputLimiter(8)
  const bytes = Buffer.from('中文测试', 'utf8')
  const emitted = limiter.push('stdout', bytes)
  const tail = limiter.flush()
  const out = Buffer.concat([...emitted, ...tail].map((entry) => entry.chunk))
  assert.equal(out.length, 8)
  assert.deepEqual(out, Buffer.concat([bytes.subarray(0, 4), bytes.subarray(8)]))
  assert.equal(limiter.exceeded, true)
  assert.equal(limiter.truncated('stdout'), true)
})

test('a single chunk larger than the whole tail window keeps only its last bytes', () => {
  const limiter = new OutputLimiter(10)
  const emitted = limiter.push('stdout', Buffer.from('0123456789ABCDEFGHIJ'))
  const tail = limiter.flush()
  const out = Buffer.concat([...emitted, ...tail].map((entry) => entry.chunk)).toString('utf8')
  assert.equal(out.length, 10)
  assert.equal(out, '01234FGHIJ')
  assert.equal(limiter.truncated('stdout'), true)
})

test('truncation is attributed to the channel that overflowed', () => {
  const limiter = new OutputLimiter(20)
  limiter.push('stdout', Buffer.from('s'.repeat(10)))
  limiter.push('stderr', Buffer.from('e'.repeat(100)))
  limiter.flush()
  assert.deepEqual(limiter.flags, { stdout: false, stderr: true, term: false })
})

// ── ChannelDecoder ──────────────────────────────────────────────────────────

test('completeUtf8Length finds the last complete code point boundary', () => {
  const text = Buffer.from('a中b', 'utf8')
  assert.equal(completeUtf8Length(text), 5)
  assert.equal(completeUtf8Length(text.subarray(0, 2)), 1, 'the two-byte prefix of 中 is incomplete')
  assert.equal(completeUtf8Length(text.subarray(0, 4)), 4)
  assert.equal(completeUtf8Length(Buffer.alloc(0)), 0)
  assert.equal(completeUtf8Length(Buffer.from([0xff])), 1, 'invalid bytes are handed to the decoder')
})

test('a multi-byte character split across chunks decodes to one utf8 piece', () => {
  const decoder = new ChannelDecoder()
  const bytes = Buffer.from('中', 'utf8')
  const first = decoder.push(bytes.subarray(0, 1))
  assert.deepEqual(first, [], 'nothing is emitted while the sequence is incomplete')
  const second = decoder.push(bytes.subarray(1))
  assert.equal(second.length, 1)
  assert.equal(second[0].encoding, 'utf8')
  assert.equal(second[0].chunk, '中')
  assert.equal(decoder.pendingBytes, 0)
})

test('invalid UTF-8 falls back to base64 without losing a byte', () => {
  const decoder = new ChannelDecoder()
  const raw = Buffer.from([0x41, 0xff, 0xfe, 0x00, 0x42])
  const pieces = decoder.push(raw)
  assert.equal(pieces.length, 1)
  assert.equal(pieces[0].encoding, 'base64')
  assert.deepEqual(Buffer.from(pieces[0].chunk, 'base64'), raw)
})

test('flush releases a dangling incomplete sequence as base64', () => {
  const decoder = new ChannelDecoder()
  assert.deepEqual(decoder.push(Buffer.from([0xe4, 0xb8])), [])
  const flushed = decoder.flush()
  assert.equal(flushed.length, 1)
  assert.equal(flushed[0].encoding, 'base64')
  assert.deepEqual(Buffer.from(flushed[0].chunk, 'base64'), Buffer.from([0xe4, 0xb8]))
  assert.deepEqual(decoder.flush(), [])
})

// ── ids ─────────────────────────────────────────────────────────────────────

test('stream ids are well formed, time-sortable and unique', () => {
  const early = newStreamId(1_700_000_000_000)
  const late = newStreamId(1_700_000_001_000)
  assert.match(early, /^st_[0-9A-HJKMNP-TV-Z]{26}$/)
  assert.ok(early < late, 'the timestamp prefix sorts')
  const ids = new Set(Array.from({ length: 200 }, () => newStreamId()))
  assert.equal(ids.size, 200)
})
