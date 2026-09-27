/**
 * Command execution: frames, timeout escalation, truncation, lifecycle.
 *
 * Every test drives a fake `SessionHandle`, so the assertions are about the exec
 * layer's own contract (ICD §3 and §4.4) and not about ssh2 or a live host.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ExecService } from '../../lib/exec/service.js'
import { inspectFrameSequence } from '../../lib/exec/frames.js'
import { SshError } from '../../lib/protocol.js'
import { FakeSession, ManualTimers, collect, dataByChannel, flush, kinds, waitFor, withTimeout } from './exec-fakes.test.mjs'

const LIMITS = { maxOutputBytes: 262_144, operationTimeoutMs: 60_000, graceKillMs: 3_000 }

/** A service wired to a manual clock and one fake session. */
function harness(options = {}) {
  const timers = new ManualTimers(options.start ?? 1_000)
  const session = options.session ?? new FakeSession()
  const sessions = options.sessions ?? [session]
  const service = new ExecService({
    resolveSession: (id) => (options.resolveSession ? options.resolveSession(id) : sessions.find((candidate) => candidate.id === id)),
    listSessions: () => sessions.map((candidate) => ({ id: candidate.id, host: candidate.info.host, user: candidate.info.user, state: candidate.state })),
    defaultSessionId: options.defaultSessionId,
    limits: { ...LIMITS, ...(options.limits ?? {}) },
    timers,
    now: () => timers.now,
    settleMs: options.settleMs ?? 1_000,
  })
  return { service, session, timers }
}

// ── happy path ──────────────────────────────────────────────────────────────

test('a command produces open → data → exit → end with a gapless seq', async () => {
  const { service, session } = harness()
  const started = service.exec({ sessionId: 's_test', command: 'uname -a' })
  const { frames } = collect(service.hub, started.streamId)
  await flush()

  session.handle.emit('stdout', 'Linux host 6.1\n')
  session.handle.emit('stderr', 'warning\n')
  session.handle.emit('stdout', 'more\n')
  session.handle.exit({ code: 0, durationMs: 42, timedOut: false })
  const result = await withTimeout(started.done, 1000, 'done')

  assert.deepEqual(kinds(frames), ['open', 'data:stdout', 'data:stderr', 'data:stdout', 'exit', 'end'])
  assert.deepEqual(inspectFrameSequence(frames), [])
  assert.deepEqual(
    frames.filter((frame) => frame.t === 'data').map((frame) => frame.seq),
    [0, 1, 2],
  )
  const open = frames[0]
  assert.equal(open.kind, 'exec')
  assert.equal(open.meta.command, 'uname -a')
  assert.equal(open.meta.pty, false)

  const end = frames.at(-1)
  assert.equal(end.reason, 'completed')
  assert.equal(end.error, undefined)
  const exit = frames.find((frame) => frame.t === 'exit')
  assert.equal(exit.exitCode, 0)
  assert.equal(exit.timedOut, false)
  assert.equal(exit.durationMs, 42)

  const { text } = dataByChannel(frames)
  assert.equal(text.stdout, 'Linux host 6.1\nmore\n')
  assert.equal(text.stderr, 'warning\n')
  assert.equal(result.stdout, 'Linux host 6.1\nmore\n')
  assert.equal(result.stderr, 'warning\n')
  assert.equal(result.exitCode, 0)
  assert.equal(result.endReason, 'completed')
  assert.deepEqual(result.truncated, { stdout: false, stderr: false })
  assert.equal(result.binary.stdout, false)
})

test('the request carries command, cwd, env, deadline and output budget', async () => {
  const { service, session } = harness({ limits: { maxOutputBytes: 4096, operationTimeoutMs: 5000, graceKillMs: 100 } })
  const started = service.exec({
    sessionId: 's_test',
    command: 'ls -l',
    cwd: '/srv/app',
    env: { LANG: 'C' },
    timeoutMs: 1234,
    maxOutputBytes: 2048,
  })
  await flush()
  assert.deepEqual(session.execRequests[0], {
    command: 'ls -l',
    cwd: '/srv/app',
    env: { LANG: 'C' },
    timeoutMs: 1234,
    maxOutputBytes: 2048,
  })

  session.handle.exit({ code: 0, durationMs: 1, timedOut: false })
  await started.done
})

test('the configured deadline is used when the caller omits one', async () => {
  const { service, session, timers } = harness({ limits: { operationTimeoutMs: 777 } })
  const started = service.exec({ sessionId: 's_test', command: 'sleep 1' })
  await flush()
  assert.equal(session.execRequests[0].timeoutMs, 777)
  await timers.advance(776)
  assert.deepEqual(session.handle.signals, [], 'nothing fires before the deadline')
  await timers.advance(1)
  assert.deepEqual(session.handle.signals, ['TERM'])
  session.handle.exit({ code: null, signal: 'TERM', durationMs: 777, timedOut: true })
  await started.done
})

test('a non-zero exit code is a result, not a failure', async () => {
  const { service, session } = harness()
  const started = service.exec({ sessionId: 's_test', command: 'false' })
  await flush()
  session.handle.emit('stdout', '')
  session.handle.exit({ code: 3, durationMs: 7, timedOut: false })
  const result = await started.done
  assert.equal(result.exitCode, 3)
  assert.equal(result.endReason, 'completed')
  assert.equal(result.error, undefined)
})

test('stdin is written once the channel opens and end-of-input is requested', async () => {
  const { service, session } = harness()
  const result = await (async () => {
    const started = service.execWait({ sessionId: 's_test', command: 'cat' }, { stdin: 'hello\n' })
    await flush()
    session.handle.exit({ code: 0, durationMs: 2, timedOut: false })
    return started
  })()
  assert.deepEqual(session.handle.writes, ['hello\n'])
  assert.equal(session.handle.endedInput, 1, 'the duck-typed endInput() path is used')
  assert.equal(result.exitCode, 0)
})

// ── timeout escalation ──────────────────────────────────────────────────────

test('timeout escalates TERM then KILL then closes with timedOut and reason timeout', async () => {
  const { service, session, timers } = harness({ limits: { graceKillMs: 300 }, settleMs: 500 })
  const started = service.exec({ sessionId: 's_test', command: 'sleep 999', timeoutMs: 1000 })
  const { frames } = collect(service.hub, started.streamId)
  await flush()

  // The fake channel obeys SIGKILL by reporting its exit, like ssh2 does.
  const realSignal = session.handle.signal.bind(session.handle)
  session.handle.signal = (sig) => {
    realSignal(sig)
    if (sig === 'KILL') session.handle.exit({ code: null, signal: 'KILL', durationMs: 1300, timedOut: true })
  }

  await timers.advance(999)
  assert.deepEqual(session.handle.signals, [])
  await timers.advance(1)
  assert.deepEqual(session.handle.signals, ['TERM'], 'SIGTERM at the deadline')
  await timers.advance(299)
  assert.deepEqual(session.handle.signals, ['TERM'], 'SIGKILL waits out the grace period')
  await timers.advance(1)
  assert.deepEqual(session.handle.signals, ['TERM', 'KILL'], 'SIGKILL after graceKillMs')

  const result = await withTimeout(started.done, 1000, 'done')
  assert.equal(result.timedOut, true)
  assert.equal(result.endReason, 'timeout')
  assert.equal(result.error.code, 'SSH_TIMEOUT_OPERATION')
  assert.equal(result.write, undefined)

  assert.deepEqual(kinds(frames), ['open', 'exit', 'end'])
  const exit = frames.find((frame) => frame.t === 'exit')
  assert.equal(exit.timedOut, true)
  assert.equal(exit.signal, 'KILL')
  const end = frames.at(-1)
  assert.equal(end.reason, 'timeout')
  assert.equal(end.error.code, 'SSH_TIMEOUT_OPERATION')
  assert.deepEqual(inspectFrameSequence(frames), [])
  assert.equal(timers.pending, 0, 'no timer is left armed')
})

test('a peer that never reports an exit is force-closed after the settle window', async () => {
  const { service, session, timers } = harness({ limits: { graceKillMs: 100 }, settleMs: 250 })
  const started = service.exec({ sessionId: 's_test', command: 'stuck', timeoutMs: 10 })
  const { frames } = collect(service.hub, started.streamId)
  await flush()

  await timers.advance(10) // TERM
  await timers.advance(100) // KILL
  assert.deepEqual(session.handle.signals, ['TERM', 'KILL'])
  let settled = false
  void started.done.then(() => {
    settled = true
  })
  await timers.advance(249)
  assert.equal(settled, false, 'the layer waits for the peer inside the settle window')
  await timers.advance(1)

  const result = await withTimeout(started.done, 1000, 'done')
  assert.equal(settled, true)
  assert.equal(result.timedOut, true)
  assert.equal(result.exitCode, null)
  assert.equal(result.signal, 'KILL')
  assert.equal(result.endReason, 'timeout')
  assert.deepEqual(kinds(frames), ['open', 'exit', 'end'])
  assert.deepEqual(inspectFrameSequence(frames), [])
})

test('a late exit event after the watchdog fired adds no second terminal frame', async () => {
  // The two termination paths (the peer's own exit event and this layer's
  // watchdog) must funnel into exactly one `exit` + one `end` (ICD §3), no matter
  // in which order they fire.
  const { service, session, timers } = harness({ limits: { graceKillMs: 10 }, settleMs: 10 })
  const started = service.exec({ sessionId: 's_test', command: 'wedged', timeoutMs: 5 })
  const { frames } = collect(service.hub, started.streamId)
  await flush()

  await timers.advance(5) // SIGTERM
  await timers.advance(10) // SIGKILL
  await timers.advance(10) // watchdog gives up waiting
  const result = await withTimeout(started.done, 1000, 'done')
  assert.equal(result.endReason, 'timeout')
  const afterWatchdog = frames.length
  assert.deepEqual(kinds(frames), ['open', 'exit', 'end'])

  // The channel reports its exit only now, long after the stream was closed.
  session.handle.exit({ code: null, signal: 'KILL', durationMs: 30, timedOut: true })
  await flush()
  assert.equal(frames.length, afterWatchdog, 'no frame is appended after `end`')
  assert.deepEqual(
    frames.filter((frame) => frame.t === 'exit').length,
    1,
    'exactly one exit frame',
  )
  assert.deepEqual(
    frames.filter((frame) => frame.t === 'end').length,
    1,
    'exactly one end frame',
  )
  assert.deepEqual(inspectFrameSequence(frames), [])
  assert.equal(service.hub.get(started.streamId).violations.length, 0, 'no invariant breach was recorded')
})

test('no deadline means no signals', async () => {
  const { service, session, timers } = harness()
  const started = service.exec({ sessionId: 's_test', command: 'interactive', timeoutMs: 0 })
  await flush()
  await timers.advance(600_000)
  assert.deepEqual(session.handle.signals, [])
  session.handle.exit({ code: 0, durationMs: 1, timedOut: false })
  assert.equal((await started.done).endReason, 'completed')
})

// ── cancellation ────────────────────────────────────────────────────────────

test('cancel closes the channel and ends the stream as cancelled', async () => {
  const { service, session, timers } = harness({ limits: { graceKillMs: 50 }, settleMs: 50 })
  const started = service.exec({ sessionId: 's_test', command: 'top', timeoutMs: 0 })
  const { frames } = collect(service.hub, started.streamId)
  await flush()

  session.handle.signal = (sig) => {
    session.handle.signals.push(sig)
    if (sig === 'KILL') session.handle.exit({ code: null, signal: 'KILL', durationMs: 20, timedOut: false })
  }

  assert.equal(service.cancel(started.streamId), true)
  assert.equal(session.handle.cancelled, 1, 'the channel is asked to stop politely first')
  await timers.advance(50)

  const result = await withTimeout(started.done, 1000, 'done')
  assert.equal(result.endReason, 'cancelled')
  assert.equal(result.timedOut, false)
  assert.equal(result.error, undefined)
  assert.deepEqual(session.handle.signals, ['KILL'])
  const end = frames.at(-1)
  assert.equal(end.reason, 'cancelled')
  assert.equal(end.error, undefined)
  assert.deepEqual(inspectFrameSequence(frames), [])
})

test('an AbortSignal cancels the command', async () => {
  const { service, session, timers } = harness({ limits: { graceKillMs: 10 }, settleMs: 10 })
  const controller = new AbortController()
  const started = service.exec({ sessionId: 's_test', command: 'sleep 100', timeoutMs: 0 }, { signal: controller.signal })
  const { frames } = collect(service.hub, started.streamId)
  await flush()
  controller.abort()
  assert.equal(session.handle.cancelled, 1)
  await timers.advance(10)
  session.handle.exit({ code: null, signal: 'TERM', durationMs: 5, timedOut: false })
  const result = await withTimeout(started.done, 1000, 'done')
  assert.equal(result.endReason, 'cancelled')
  assert.equal(frames.at(-1).reason, 'cancelled')
})

test('an already-aborted signal does not leave a running command behind', async () => {
  const { service, session, timers } = harness({ limits: { graceKillMs: 10 }, settleMs: 10 })
  const controller = new AbortController()
  controller.abort()
  const started = service.exec({ sessionId: 's_test', command: 'sleep 100', timeoutMs: 0 }, { signal: controller.signal })
  await flush()
  // The abort fired before the channel existed; it must still reach the channel.
  assert.equal(session.handle.cancelled, 1)
  await timers.advance(10)
  session.handle.exit({ code: null, durationMs: 1, timedOut: false })
  const result = await withTimeout(started.done, 1000, 'done')
  assert.equal(result.endReason, 'cancelled')
  assert.equal(timers.pending, 0)
})

// ── output limit ────────────────────────────────────────────────────────────

test('output above maxOutputBytes keeps head+tail, flags it and reports the code', async () => {
  const { service, session } = harness({ limits: { maxOutputBytes: 100 } })
  const started = service.exec({ sessionId: 's_test', command: 'yes', maxOutputBytes: 100 })
  const { frames } = collect(service.hub, started.streamId)
  await flush()

  // 10 chunks of 20 bytes: the head is 50 bytes and the tail is the last 50.
  for (let index = 0; index < 10; index += 1) {
    session.handle.emit('stdout', String(index).repeat(20))
  }
  session.handle.exit({ code: 0, durationMs: 3, timedOut: false })
  const result = await withTimeout(started.done, 1000, 'done')

  assert.deepEqual(result.truncated, { stdout: true, stderr: false })
  assert.equal(result.endReason, 'error')
  assert.equal(result.error.code, 'SSH_LIMIT_OUTPUT_TRUNCATED')
  assert.equal(result.error.retryable, false)
  assert.match(result.stdout, /^0{20}1{20}2{5}/)
  assert.match(result.stdout, /9{20}$/)
  assert.equal(result.stdout.length, 100)
  assert.equal(result.bytes.stdout, 200, 'the byte count reports what the command produced')

  const end = frames.at(-1)
  assert.equal(end.reason, 'error')
  assert.equal(end.error.code, 'SSH_LIMIT_OUTPUT_TRUNCATED')
  assert.ok(frames.findIndex((frame) => frame.t === 'exit') < frames.length - 1)
  assert.deepEqual(inspectFrameSequence(frames), [])
  const { buffers } = dataByChannel(frames)
  assert.equal(Buffer.concat(buffers.stdout).length, 100, 'the wire carries exactly the retained head+tail')
})

test('output exactly at the limit is not truncated', async () => {
  const { service, session } = harness()
  const started = service.exec({ sessionId: 's_test', command: 'exact', maxOutputBytes: 10 })
  const { frames } = collect(service.hub, started.streamId)
  await flush()
  session.handle.emit('stdout', 'x'.repeat(5))
  session.handle.emit('stdout', 'y'.repeat(5))
  session.handle.exit({ code: 0, durationMs: 1, timedOut: false })
  const result = await started.done
  assert.deepEqual(result.truncated, { stdout: false, stderr: false })
  assert.equal(result.endReason, 'completed')
  assert.equal(result.stdout, 'xxxxxyyyyy')
  assert.deepEqual(kinds(frames), ['open', 'data:stdout', 'data:stdout', 'exit', 'end'])
})

test('truncation of one channel does not flag the other', async () => {
  const { service, session } = harness()
  const started = service.exec({ sessionId: 's_test', command: 'noisy', maxOutputBytes: 20 })
  await flush()
  session.handle.emit('stderr', 'e'.repeat(10))
  session.handle.emit('stdout', 's'.repeat(100))
  session.handle.exit({ code: 0, durationMs: 1, timedOut: false })
  const result = await started.done
  assert.deepEqual(result.truncated, { stdout: true, stderr: false })
  assert.equal(result.stderr, 'e'.repeat(10))
})

test('execWait returns a truncated result instead of throwing', async () => {
  const { service, session } = harness()
  const pending = service.execWait({ sessionId: 's_test', command: 'big', maxOutputBytes: 10 })
  await flush()
  session.handle.emit('stdout', 'a'.repeat(100))
  session.handle.exit({ code: 0, durationMs: 1, timedOut: false })
  const result = await withTimeout(pending, 1000, 'execWait')
  assert.equal(result.truncated.stdout, true)
  assert.equal(result.exitCode, 0)
})

// ── encoding ────────────────────────────────────────────────────────────────

test('a multi-byte character split across reads is reassembled as utf8', async () => {
  const { service, session } = harness()
  const started = service.exec({ sessionId: 's_test', command: 'echo 中文' })
  const { frames } = collect(service.hub, started.streamId)
  await flush()
  const bytes = Buffer.from('中文', 'utf8')
  session.handle.emit('stdout', bytes.subarray(0, 2))
  session.handle.emit('stdout', bytes.subarray(2, 4))
  session.handle.emit('stdout', bytes.subarray(4))
  session.handle.exit({ code: 0, durationMs: 1, timedOut: false })
  const result = await started.done
  assert.equal(result.stdout, '中文')
  const dataFrames = frames.filter((frame) => frame.t === 'data')
  // The first two reads are incomplete sequence prefixes: they are held back and
  // released together, so '中' arrives as one frame rather than three broken ones.
  assert.deepEqual(
    dataFrames.map((frame) => frame.encoding),
    ['utf8', 'utf8'],
  )
  assert.equal(dataFrames.map((frame) => frame.chunk).join(''), '中文')
})

test('non-UTF-8 output is shipped as base64 and stays byte-exact', async () => {
  const { service, session } = harness()
  const started = service.exec({ sessionId: 's_test', command: 'cat /bin/x' })
  const { frames, subscription } = collect(service.hub, started.streamId)
  await flush()
  const raw = Buffer.from([0x00, 0xff, 0xfe, 0x01])
  session.handle.emit('stdout', raw)
  session.handle.exit({ code: 0, durationMs: 1, timedOut: false })
  const result = await started.done

  const dataFrame = frames.find((frame) => frame.t === 'data')
  assert.equal(dataFrame.encoding, 'base64')
  assert.deepEqual(Buffer.from(dataFrame.chunk, 'base64'), raw)
  assert.equal(result.binary.stdout, true)
  assert.equal(subscription.replayed >= 0, true)
})

test('an incomplete trailing sequence is released when the command ends', async () => {
  const { service, session } = harness()
  const started = service.exec({ sessionId: 's_test', command: 'binary' })
  const { frames } = collect(service.hub, started.streamId)
  await flush()
  session.handle.emit('stdout', Buffer.from([0x41, 0xe4, 0xb8]))
  session.handle.exit({ code: 0, durationMs: 1, timedOut: false })
  await started.done
  const dataFrames = frames.filter((frame) => frame.t === 'data')
  assert.equal(dataFrames.length, 2)
  assert.equal(dataFrames[0].encoding, 'utf8')
  assert.equal(dataFrames[0].chunk, 'A')
  assert.equal(dataFrames[1].encoding, 'base64')
  assert.deepEqual(Buffer.from(dataFrames[1].chunk, 'base64'), Buffer.from([0xe4, 0xb8]))
})

// ── errors ──────────────────────────────────────────────────────────────────

test('a channel that fails to open still produces open → exit → end', async () => {
  const failure = new SshError('SSH_NET_RESET', 'connection reset by peer')
  const session = new FakeSession({ execError: failure })
  const { service } = harness({ session, sessions: [session] })
  const started = service.exec({ sessionId: 's_test', command: 'uname' })
  const { frames } = collect(service.hub, started.streamId)
  await flush()

  const result = await withTimeout(started.done, 1000, 'done')
  assert.equal(result.endReason, 'error')
  assert.equal(result.error.code, 'SSH_NET_RESET')
  assert.deepEqual(kinds(frames), ['open', 'exit', 'end'])
  assert.deepEqual(inspectFrameSequence(frames), [])
  assert.equal(frames.at(-1).reason, 'error')
  assert.equal(frames.at(-1).error.code, 'SSH_NET_RESET')
  assert.equal(frames.find((frame) => frame.t === 'exit').exitCode, null)

  // `execWait` turns a genuine startup failure into a thrown SshError ...
  const session2 = new FakeSession({ id: 's_two', execError: failure })
  const second = harness({ session: session2, sessions: [session2] })
  await assert.rejects(
    second.service.execWait({ sessionId: 's_two', command: 'uname' }),
    (error) => error instanceof SshError && error.code === 'SSH_NET_RESET',
  )
})

test('a closed session is refused before any stream is created', () => {
  const session = new FakeSession({ state: 'closed' })
  const { service } = harness({ session, sessions: [session] })
  assert.throws(
    () => service.exec({ sessionId: 's_test', command: 'uname' }),
    (error) => error instanceof SshError && error.code === 'SSH_STATE_INVALID',
  )
  assert.equal(service.hub.size, 0)
})

test('an unknown session is refused with SSH_STATE_INVALID', () => {
  const { service } = harness()
  assert.throws(
    () => service.exec({ sessionId: 's_missing', command: 'uname' }),
    (error) => error instanceof SshError && error.code === 'SSH_STATE_INVALID' && /unknown session/.test(error.message),
  )
})

test('an empty command is refused with SSH_CFG_INVALID', () => {
  const { service } = harness()
  for (const command of ['', '   ']) {
    assert.throws(
      () => service.exec({ sessionId: 's_test', command }),
      (error) => error instanceof SshError && error.code === 'SSH_CFG_INVALID',
    )
  }
  assert.equal(service.hub.size, 0)
})

test('a missing sessionId is refused with SSH_CFG_INVALID', () => {
  const { service } = harness()
  assert.throws(
    () => service.exec({ sessionId: '', command: 'uname' }),
    (error) => error instanceof SshError && error.code === 'SSH_CFG_INVALID',
  )
})

// ── stream bookkeeping ──────────────────────────────────────────────────────

test('listStreams reports live streams and their terminal state', async () => {
  const { service, session } = harness()
  const started = service.exec({ sessionId: 's_test', command: 'ls' })
  assert.deepEqual(service.listStreams({ sessionId: 's_test' }).streams.map((stream) => stream.streamId), [started.streamId])
  const live = service.listStreams({ sessionId: 's_test' }).streams[0]
  assert.equal(live.kind, 'exec')
  assert.equal(live.alive, true)
  assert.match(live.startedAt, /^\d{4}-\d{2}-\d{2}T/)

  await flush()
  session.handle.emit('stdout', 'a')
  session.handle.exit({ code: 0, durationMs: 1, timedOut: false })
  await started.done
  assert.equal(service.listStreams({ sessionId: 's_test' }).streams[0].alive, false)
  assert.equal(service.listStreams({ sessionId: 's_test' }).streams[0].dataFrames, 1)
  assert.equal(service.listStreams({ sessionId: 'other' }).streams.length, 0)
})

test('a late subscriber replays the whole finished stream', async () => {
  const { service, session } = harness()
  const started = service.exec({ sessionId: 's_test', command: 'ls' })
  await flush()
  session.handle.emit('stdout', 'done\n')
  session.handle.exit({ code: 0, durationMs: 1, timedOut: false })
  await started.done

  const { frames, subscription } = collect(service.hub, started.streamId)
  assert.equal(subscription.finished, true)
  assert.deepEqual(kinds(frames), ['open', 'data:stdout', 'exit', 'end'])
  assert.deepEqual(inspectFrameSequence(frames), [])
})

test('resubscribing with sinceSeq delivers only the missing frames', async () => {
  const { service, session } = harness()
  const started = service.exec({ sessionId: 's_test', command: 'seq' })
  const first = collect(service.hub, started.streamId)
  await flush()
  for (let index = 0; index < 5; index += 1) session.handle.emit('stdout', `${index}`)
  const seen = first.frames.filter((frame) => frame.t === 'data').length
  assert.equal(seen, 5)

  const second = collect(service.hub, started.streamId, { sinceSeq: 3 })
  assert.equal(second.subscription.replayed, 2, 'only seq 3 and 4 are replayed')
  assert.equal(second.subscription.gap, false)
  assert.deepEqual(second.frames.map((frame) => frame.seq), [3, 4])

  session.handle.emit('stdout', '5')
  assert.deepEqual(second.frames.at(-1).seq, 5)

  session.handle.exit({ code: 0, durationMs: 1, timedOut: false })
  await started.done
  assert.deepEqual(kinds(second.frames), ['data:stdout', 'data:stdout', 'data:stdout', 'exit', 'end'])
})

test('subscribing to an unknown stream fails explicitly', () => {
  const { service } = harness()
  assert.throws(
    () => service.subscribe('st_nope', () => {}),
    (error) => error instanceof SshError && error.code === 'SSH_STATE_INVALID',
  )
})

test('many chunks keep the sequence gapless and never trip an invariant', async () => {
  const { service, session } = harness()
  const started = service.exec({ sessionId: 's_test', command: 'seq 1 500' })
  const { frames } = collect(service.hub, started.streamId)
  await flush()
  for (let index = 0; index < 500; index += 1) session.handle.emit(index % 2 === 0 ? 'stdout' : 'stderr', `${index}\n`)
  session.handle.exit({ code: 0, durationMs: 9, timedOut: false })
  await started.done

  assert.deepEqual(inspectFrameSequence(frames), [])
  const seqs = frames.filter((frame) => frame.t === 'data').map((frame) => frame.seq)
  assert.equal(seqs.length, 500)
  assert.deepEqual(seqs, Array.from({ length: 500 }, (_value, index) => index))

  // The frame writer recorded no invariant breach, and the hub reported none.
  assert.equal(service.hub.get(started.streamId).violations.length, 0)
})

test('dispose ends every live stream instead of leaving it open', async () => {
  const { service, session } = harness()
  const started = service.exec({ sessionId: 's_test', command: 'tail -f', timeoutMs: 0 })
  const { frames } = collect(service.hub, started.streamId)
  await flush()
  service.dispose('peer-closed')
  await waitFor(() => frames.at(-1).t === 'end')
  assert.deepEqual(kinds(frames), ['open', 'exit', 'end'])
  assert.equal(frames.at(-1).reason, 'peer-closed')
  assert.equal(session.handle.cancelled, 1)
  const result = await withTimeout(started.done, 1000, 'done')
  assert.equal(result.endReason, 'peer-closed')
})
