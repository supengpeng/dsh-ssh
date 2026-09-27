/**
 * Progress coalescing (ICD §4.5 ≥200 ms or ≥1 MiB) and the §3 frame mapping.
 *
 * The clock is injected, so the cadence is asserted exactly rather than
 * approximately: a real 200 ms wait would make the suite slow *and* flaky, and
 * "the frame arrived after about 200 ms" is not a specification.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ProgressReporter, toProgressFrame } from '../../lib/sftp/progress.js'

/** A clock the test drives by hand; timers fire when their due time is reached. */
class ManualClock {
  constructor(now = 1_000_000) {
    this.time = now
    this.timers = []
    this.nextId = 1
  }

  now() {
    return this.time
  }

  setTimer(callback, ms) {
    const handle = { id: this.nextId++, at: this.time + ms, callback }
    this.timers.push(handle)
    return handle
  }

  clearTimer(handle) {
    this.timers = this.timers.filter((timer) => timer !== handle)
  }

  /** Advance time, firing every timer that comes due, in order. */
  advance(ms) {
    this.time += ms
    for (const timer of [...this.timers].sort((a, b) => a.at - b.at)) {
      if (timer.at <= this.time) {
        this.clearTimer(timer)
        timer.callback()
      }
    }
  }
}

function reporterWith(options = {}) {
  const clock = new ManualClock()
  const samples = []
  const reporter = new ProgressReporter({
    intervalMs: 200,
    byteThreshold: 1024 * 1024,
    clock,
    onProgress: (progress) => samples.push(progress),
    ...options,
  })
  return { clock, samples, reporter }
}

const MiB = 1024 * 1024
const KiB = 1024

test('begin() emits the opening sample', () => {
  const { samples, reporter } = reporterWith()
  reporter.begin(undefined, 'scan')
  assert.deepEqual(samples, [{ transferred: 0, bytesPerSec: 0, phase: 'scan' }])
})

test('a byte threshold of 1 MiB emits exactly once per MiB', () => {
  const { samples, reporter } = reporterWith()
  reporter.begin()
  reporter.setTotal(8 * MiB)
  reporter.setPhase('transfer')
  const afterPhaseChange = samples.length

  for (let index = 0; index < 3; index++) reporter.advance(256 * KiB)
  assert.equal(samples.length, afterPhaseChange, 'three 256 KiB chunks must not emit')
  reporter.advance(256 * KiB)
  assert.equal(samples.length, afterPhaseChange + 1)
  assert.equal(samples.at(-1).transferred, MiB)
  assert.equal(samples.at(-1).totalBytes, 8 * MiB)
})

test('the 200 ms rule emits without new bytes, and only once per interval', () => {
  const { clock, samples, reporter } = reporterWith()
  reporter.begin()
  reporter.setPhase('transfer')
  reporter.advance(64 * KiB)
  const before = samples.length
  clock.advance(199)
  assert.equal(samples.length, before, 'nothing may fire before the interval')
  clock.advance(1)
  assert.equal(samples.length, before + 1, 'the timer must fire at the interval')
})

test('touch() keeps a silent scan alive without inventing bytes', () => {
  const { clock, samples, reporter } = reporterWith()
  reporter.begin(undefined, 'scan')
  const before = samples.length
  reporter.touch()
  assert.equal(samples.length, before, 'a touch within the interval is coalesced')
  clock.advance(200)
  reporter.touch()
  assert.equal(samples.length, before + 1)
  assert.equal(samples.at(-1).transferred, 0)
  assert.equal(samples.at(-1).phase, 'scan')
})

test('transferred never decreases and totalBytes is fixed once known', () => {
  const { samples, reporter } = reporterWith({ byteThreshold: 1 })
  reporter.begin()
  reporter.setTotal(2 * MiB)
  reporter.setTotal(99 * MiB)
  reporter.advance(10)
  reporter.advance(10)
  assert.equal(samples.at(-1).totalBytes, 2 * MiB)
  // Monotone non-decreasing (ICD §3): a total becoming known emits a sample at
  // the same byte count, which is legitimate — a *decrease* never is.
  for (let index = 1; index < samples.length; index++) {
    assert.ok(samples[index].transferred >= samples[index - 1].transferred)
    assert.equal(samples[index].totalBytes, 2 * MiB)
  }
  assert.equal(samples.at(-1).transferred, 20)
})

test('a phase change is always observable', () => {
  const { samples, reporter } = reporterWith()
  reporter.begin()
  reporter.setPhase('transfer')
  reporter.setPhase('finalize')
  reporter.setPhase('verify')
  assert.deepEqual(
    samples.map((sample) => sample.phase),
    ['scan', 'transfer', 'finalize', 'verify'],
  )
})

test('stop() emits the final sample exactly once', () => {
  const { clock, samples, reporter } = reporterWith()
  reporter.begin()
  reporter.setPhase('transfer')
  reporter.advance(100)
  const before = samples.length
  reporter.stop()
  assert.equal(samples.length, before + 1)
  assert.equal(samples.at(-1).transferred, 100)
  clock.advance(1000)
  reporter.advance(100)
  reporter.flush()
  assert.equal(samples.length, before + 1, 'a stopped reporter must stay silent')
})

test('bytesPerSec and etaMs are derived from the transfer window only', () => {
  const { clock, samples, reporter } = reporterWith({ byteThreshold: 1 })
  reporter.begin()
  reporter.setTotal(4000)
  reporter.setPhase('transfer')
  reporter.advance(1000)
  clock.advance(1000)
  reporter.flush()
  const sample = samples.at(-1)
  assert.equal(sample.bytesPerSec, 1000)
  assert.equal(sample.etaMs, 3000)
})

test('a throwing sink is counted, never propagated', () => {
  const { reporter } = reporterWith({
    onProgress: () => {
      throw new Error('renderer went away')
    },
  })
  reporter.begin()
  reporter.setPhase('transfer')
  reporter.advance(MiB)
  reporter.stop()
  assert.ok(reporter.sinkErrorCount > 0)
})

test('toProgressFrame maps one-to-one onto the ICD §3 frame', () => {
  const frame = toProgressFrame('st_1', { transferred: 5, totalBytes: 10, bytesPerSec: 2, etaMs: 2500, phase: 'transfer' })
  assert.deepEqual(frame, {
    t: 'progress',
    streamId: 'st_1',
    transferred: 5,
    totalBytes: 10,
    bytesPerSec: 2,
    etaMs: 2500,
    phase: 'transfer',
  })
  const minimal = toProgressFrame('st_2', { transferred: 0, bytesPerSec: 0, phase: 'scan' })
  assert.deepEqual(minimal, { t: 'progress', streamId: 'st_2', transferred: 0, bytesPerSec: 0, phase: 'scan' })
  assert.ok(!('totalBytes' in minimal), 'unknown totals must be omitted, not zeroed')
})
