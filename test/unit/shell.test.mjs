/**
 * Interactive PTY shell: frames, input, resize, signals, close — and the reason
 * this layer exists at all, a full-screen application that redraws.
 *
 * The full-screen test drives a curses-style app through the runner with a fake
 * `ShellHandle`, so "the terminal works for `top`/`vim`" is asserted rather than
 * assumed: the redraw traffic (alternate screen, cursor addressing, line clears)
 * must arrive byte-exact and in order, a resize must reach the app and produce a
 * redraw at the new size, and a keystroke must reach the app.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ExecService } from '../../lib/exec/service.js'
import { inspectFrameSequence } from '../../lib/exec/frames.js'
import { SshError } from '../../lib/protocol.js'
import { FakeSession, ManualTimers, collect, dataByChannel, kinds, flush, withTimeout } from './exec-fakes.test.mjs'

/** ANSI/VT sequences a full-screen app uses; kept as constants so they are readable. */
const ESC = '\u001b'
const ALT_SCREEN_ON = `${ESC}[?1049h`
const ALT_SCREEN_OFF = `${ESC}[?1049l`
const CLEAR = `${ESC}[2J`
const HOME = `${ESC}[H`
const HIDE_CURSOR = `${ESC}[?25l`
const SHOW_CURSOR = `${ESC}[?25h`
const CLEAR_LINE = `${ESC}[K`
const CTRL_C = '\u0003'

/**
 * A minimal curses-style full-screen application.
 *
 * It writes through `sink` exactly as a remote program writes to its PTY, and
 * reacts to input, resize and signals the way a real TUI does: leaving the
 * alternate screen and restoring the cursor on exit.
 */
class FakeFullScreenApp {
  constructor({ cols, rows, sink }) {
    this.cols = cols
    this.rows = rows
    this.sink = sink
    this.altScreen = false
    this.cursorHidden = false
    this.running = true
    this.renders = 0
    this.keys = []
    this.geometry = []
    this.emitted = []
    this.exitEvent = null
    this.onExit = null
    this.ticker = 0
  }

  start() {
    this.sink(ALT_SCREEN_ON)
    this.altScreen = true
    this.render()
  }

  render() {
    this.renders += 1
    this.ticker += 1
    this.sink(CLEAR)
    this.sink(`${HOME}${HIDE_CURSOR}`)
    this.cursorHidden = true
    for (let row = 1; row <= this.rows; row += 1) {
      const line = row === 1 ? `top - ${this.cols}x${this.rows} tick ${this.ticker}` : `  proc ${row - 1}`
      this.sink(`${ESC}[${row};1H${line.slice(0, this.cols)}${CLEAR_LINE}`)
    }
    this.sink(`${ESC}[${this.rows};1Hstatus: q=quit`)
  }

  onKey(key) {
    this.keys.push(key)
    if (key === 'q') return this.quit(0)
    if (key === CTRL_C) return this.quit(130)
    if (key === ' ') return this.render()
    return undefined
  }

  /** A PTY window change: SIGWINCH + full redraw at the new geometry. */
  onResize(cols, rows) {
    this.geometry.push({ cols, rows })
    this.cols = cols
    this.rows = rows
    this.render()
  }

  onSignal(signal) {
    if (signal === 'INT') return this.quit(130)
    if (signal === 'TERM' || signal === 'KILL') return this.quit(null, signal)
    return undefined
  }

  quit(code, signal) {
    if (!this.running) return
    this.running = false
    if (signal === undefined) this.sink(`${SHOW_CURSOR}${ALT_SCREEN_OFF}`)
    this.cursorHidden = false
    this.altScreen = false
    this.exitEvent = { code, durationMs: 4, timedOut: false, ...(signal !== undefined ? { signal } : {}) }
    this.onExit?.(this.exitEvent)
  }

  /** Bytes as the terminal would receive them. */
  bytes() {
    return Buffer.concat(this.emitted.map((piece) => (Buffer.isBuffer(piece) ? piece : Buffer.from(piece, 'utf8'))))
  }
}

/** A service wired to a manual clock, one fake session and a full-screen app. */
function harness(options = {}) {
  const timers = new ManualTimers(5_000)
  const session = options.session ?? new FakeSession()
  const service = new ExecService({
    resolveSession: (id) => (id === session.id ? session : undefined),
    listSessions: () => [{ id: session.id, host: session.info.host, user: session.info.user, state: session.state }],
    limits: {
      maxOutputBytes: options.maxOutputBytes ?? 262_144,
      operationTimeoutMs: 60_000,
      graceKillMs: options.graceKillMs ?? 1_000,
      // Accept both spellings so a reader cannot pass a limit that is silently
      // ignored (`{graceKillMs}` and `{limits: {graceKillMs}}` both work).
      ...(options.limits ?? {}),
    },
    timers,
    now: () => timers.now,
    settleMs: options.settleMs ?? 500,
    ...(options.replayLimitBytes !== undefined ? { replayLimitBytes: options.replayLimitBytes } : {}),
  })
  return { service, session, timers }
}

/** Start a shell and wire a fake app to the resulting handle. */
async function startWithApp(options = {}) {
  const context = harness(options)
  const app = new FakeFullScreenApp({
    cols: options.cols ?? 80,
    rows: options.rows ?? 24,
    sink: (piece) => {
      app.emitted.push(piece)
      context.session.shellHandle?.emit('stdout', piece)
    },
  })
  const started = context.service.openShell({
    sessionId: 's_test',
    cols: app.cols,
    rows: app.rows,
    ...(options.term !== undefined ? { term: options.term } : {}),
  })
  const collected = collect(context.service.hub, started.streamId)
  await flush()
  const handle = context.session.shellHandle
  app.onExit = (event) => handle.exit(event)
  const realResize = handle.resize.bind(handle)
  handle.resize = (cols, rows) => {
    realResize(cols, rows)
    app.onResize(cols, rows)
  }
  const realWrite = handle.write.bind(handle)
  handle.write = (data) => {
    realWrite(data)
    for (const character of data.toString('utf8')) app.onKey(character)
  }
  const realSignal = handle.signal.bind(handle)
  handle.signal = (signal) => {
    realSignal(signal)
    app.onSignal(signal)
  }
  const realCancel = handle.cancel.bind(handle)
  handle.cancel = () => {
    realCancel()
    // SP1's `cancel()` sends TERM and then force-closes after a grace period, so a
    // real PTY dies from the polite request. `cancelKills: false` models a program
    // that ignores it and must therefore be SIGKILLed by this layer.
    if (options.cancelKills !== false) app.onSignal('TERM')
  }
  app.start()
  return { ...context, app, handle, started, frames: collected.frames }
}

// ── opening ─────────────────────────────────────────────────────────────────

test('openShell requests a PTY and announces its geometry', async () => {
  const { service, session } = harness()
  const started = service.openShell({ sessionId: 's_test', cols: 120, rows: 40 })
  const { frames } = collect(service.hub, started.streamId)
  await flush()

  // The request also carries the configured output budget; the exec layer does
  // not truncate a terminal, but the connection layer still receives the value.
  assert.deepEqual(
    { ...session.shellRequests[0], maxOutputBytes: undefined },
    { cols: 120, rows: 40, term: 'xterm-256color', maxOutputBytes: undefined },
  )
  const open = frames[0]
  assert.equal(open.t, 'open')
  assert.equal(open.kind, 'shell')
  assert.deepEqual(open.meta, {
    cols: 120,
    rows: 40,
    term: 'xterm-256color',
    sessionState: 'connected',
    outputLimit: 'none',
  })
  assert.equal(service.listStreams({ sessionId: 's_test' }).streams[0].kind, 'shell')

  session.shellHandle.exit({ code: 0, durationMs: 1, timedOut: false })
  await started.done
})

test('a custom term name is passed through and geometry is clamped', async () => {
  const { service, session } = harness()
  const started = service.openShell({ sessionId: 's_test', cols: 0, rows: 99_999, term: 'screen-256color' })
  await flush()
  assert.deepEqual(
    { ...session.shellRequests[0], maxOutputBytes: undefined },
    { cols: 1, rows: 1000, term: 'screen-256color', maxOutputBytes: undefined },
  )
  session.shellHandle.exit({ code: 0, durationMs: 1, timedOut: false })
  await started.done
})

test('a session without shell capability is refused', () => {
  const session = new FakeSession({ capabilities: { shell: false, sftp: true } })
  const { service } = harness({ session })
  assert.throws(
    () => service.openShell({ sessionId: 's_test', cols: 80, rows: 24 }),
    (error) => error instanceof SshError && error.code === 'SSH_STATE_INVALID',
  )
  assert.equal(service.hub.size, 0)
})

test('a closed session is refused before the PTY is requested', () => {
  const session = new FakeSession({ state: 'closed' })
  const { service } = harness({ session })
  assert.throws(() => service.openShell({ sessionId: 's_test', cols: 80, rows: 24 }), /is closed/)
  assert.equal(session.shellRequests.length, 0)
})

// ── full-screen application ─────────────────────────────────────────────────

test('a full-screen app drives the terminal: redraw traffic, input, resize, exit', async () => {
  const { service, app, frames, started, handle } = await startWithApp({ cols: 80, rows: 24 })

  // 1. The app's byte stream arrives exactly, escape sequences intact.
  assert.deepEqual(kinds(frames).slice(0, 1), ['open'])
  const firstScreen = frames.filter((frame) => frame.t === 'data')
  assert.ok(firstScreen.length >= 3, 'a redraw is several writes, not one blob')
  assert.equal(
    frames.filter((frame) => frame.t === 'data').every((frame) => frame.channel === 'term'),
    true,
    'PTY output uses the `term` channel',
  )
  const { text } = dataByChannel(frames)
  assert.equal(text.term, app.bytes().toString('utf8'), 'every byte the app wrote reached the wire')
  assert.ok(text.term.startsWith(ALT_SCREEN_ON), 'the alternate screen is entered first')
  assert.ok(text.term.includes(CLEAR) && text.term.includes(HOME), 'the screen is cleared and homed')
  assert.ok(text.term.includes(HIDE_CURSOR), 'the cursor is hidden while the app owns the screen')
  assert.ok(text.term.includes(`${ESC}[24;1Hstatus: q=quit`), 'cursor addressing reaches the last row')

  // 2. Keystrokes reach the app (write → PTY → key handler).
  const beforeTyping = app.renders
  assert.deepEqual(service.shellWrite({ streamId: started.streamId, data: ' ' }), { written: 1 })
  assert.deepEqual(app.keys, [' '])
  assert.equal(app.renders, beforeTyping + 1, 'the space redraws')
  assert.equal(handle.writes.length, 1)

  // 3. A resize reaches the app and produces a redraw at the new geometry.
  const rendersBeforeResize = app.renders
  const bytesBeforeResize = app.bytes().length
  assert.deepEqual(service.shellResize({ streamId: started.streamId, cols: 120, rows: 40 }), { resized: true })
  assert.deepEqual(handle.resizes, [{ cols: 120, rows: 40 }])
  assert.deepEqual(app.geometry, [{ cols: 120, rows: 40 }])
  assert.equal(app.renders, rendersBeforeResize + 1, 'SIGWINCH triggers a redraw')
  assert.ok(app.bytes().length > bytesBeforeResize)
  const afterResize = dataByChannel(frames).text.term
  assert.ok(afterResize.includes('top - 120x40'), 'the redrawn screen uses the new width')
  assert.ok(afterResize.slice(bytesBeforeResize).includes(CLEAR), 'the redraw clears first')

  // 4. Quitting restores the terminal and reports the app's exit code.
  service.shellWrite({ streamId: started.streamId, data: 'q' })
  const result = await withTimeout(started.done, 1000, 'shell done')
  assert.equal(result.exitCode, 0)
  assert.equal(result.endReason, 'completed')
  assert.equal(app.altScreen, false)
  const finalText = dataByChannel(frames).text.term
  assert.ok(finalText.endsWith(`${SHOW_CURSOR}${ALT_SCREEN_OFF}`), 'the app leaves the alternate screen')
  assert.deepEqual(kinds(frames).slice(-2), ['exit', 'end'])
  assert.deepEqual(inspectFrameSequence(frames), [])
  assert.equal(service.hub.get(started.streamId).violations.length, 0)
  assert.equal(result.bytes, app.bytes().length)
  assert.equal(result.binary, false)
})

test('Ctrl-C reaches the app as a byte and it exits with 130', async () => {
  const { service, app, frames, started } = await startWithApp()
  service.shellWrite({ streamId: started.streamId, data: CTRL_C })
  const result = await withTimeout(started.done, 1000, 'shell done')
  assert.deepEqual(app.keys, [CTRL_C])
  assert.equal(result.exitCode, 130)
  const end = frames.at(-1)
  assert.equal(end.t, 'end')
  assert.equal(end.reason, 'completed')
  assert.deepEqual(inspectFrameSequence(frames), [])
})

test('shellSignal delivers a POSIX signal to the app', async () => {
  const { service, app, started } = await startWithApp()
  assert.deepEqual(service.shellSignal({ streamId: started.streamId, signal: 'INT' }), { sent: true })
  const result = await withTimeout(started.done, 1000, 'shell done')
  assert.equal(result.exitCode, 130)
  assert.equal(app.running, false)
})

test('a long-running full-screen session is never output-truncated on the wire', async () => {
  // The configured limit is tiny; the live terminal path must ignore it (ICD
  // v1.0.4 §4.4: a terminal is a live screen, head+tail would freeze it).
  const { service, app, frames, started, handle } = await startWithApp({ maxOutputBytes: 1024 })
  const baseline = app.bytes().length
  const chunk = `${CLEAR}${HOME}${'x'.repeat(4095)}`
  let produced = 0
  for (let index = 0; index < 64; index += 1) {
    handle.emit('stdout', chunk)
    produced += Buffer.byteLength(chunk, 'utf8')
  }

  const { buffers, text } = dataByChannel(frames)
  const wire = Buffer.concat(buffers.term).length
  assert.equal(wire, baseline + produced, 'every emitted byte is on the wire')
  assert.ok(wire > 100 * 1024, 'far past maxOutputBytes=1024')
  assert.equal(text.term.includes('x'.repeat(100)), true)
  assert.equal(
    frames.some((frame) => frame.t === 'end'),
    false,
    'the stream is still live: no truncation end',
  )

  service.shellClose({ streamId: started.streamId })
  const result = await withTimeout(started.done, 1000, 'shell done')
  assert.equal(result.endReason, 'cancelled')
  const end = frames.at(-1)
  assert.equal(end.reason, 'cancelled')
  assert.equal(end.error, undefined, 'no truncation error: nothing was dropped')
  assert.deepEqual(inspectFrameSequence(frames), [])
})

// ── binary safety ───────────────────────────────────────────────────────────

test('terminal bytes that are not valid UTF-8 are shipped base64 and stay exact', async () => {
  const { app, frames, started, handle } = await startWithApp()
  const raw = Buffer.from([ESC, 0x5b, 0x33, 0x31, 0x6d, 0xff, 0xfe, 0x0a])
  app.emitted.push(raw)
  handle.emit('stdout', raw)
  handle.exit({ code: 0, durationMs: 1, timedOut: false })
  await started.done

  const dataFrames = frames.filter((frame) => frame.t === 'data')
  const fallback = dataFrames.filter((frame) => frame.encoding === 'base64')
  assert.equal(fallback.length, 1, 'the invalid run falls back to base64')
  assert.deepEqual(Buffer.from(fallback[0].chunk, 'base64'), raw)
  assert.deepEqual(inspectFrameSequence(frames), [])
})

test('a multi-byte character split across PTY reads is reassembled', async () => {
  const { frames, started, handle } = await startWithApp()
  const bytes = Buffer.from('中文', 'utf8')
  handle.emit('stdout', bytes.subarray(0, 2))
  handle.emit('stdout', bytes.subarray(2, 4))
  handle.emit('stdout', bytes.subarray(4))
  handle.exit({ code: 0, durationMs: 1, timedOut: false })
  await started.done
  const { text } = dataByChannel(frames)
  assert.ok(text.term.endsWith('中文'))
  const dataFrames = frames.filter((frame) => frame.t === 'data')
  assert.equal(dataFrames.every((frame) => frame.encoding === 'utf8'), true)
})

// ── lifecycle ───────────────────────────────────────────────────────────────

test('shellClose ends the terminal as cancelled and stops the channel', async () => {
  const { service, started, handle, frames } = await startWithApp()
  const before = handle.listeners
  assert.ok(before > 0)
  assert.deepEqual(service.shellClose({ streamId: started.streamId }), { closed: true })
  const result = await withTimeout(started.done, 1000, 'shell done')
  assert.equal(handle.cancelled, 1)
  assert.equal(result.endReason, 'cancelled')
  assert.deepEqual(kinds(frames).slice(-2), ['exit', 'end'])
  assert.equal(frames.at(-1).reason, 'cancelled')
})

test('a PTY that ignores the close is force-closed after the grace window', async () => {
  // `cancelKills: false` models a program that ignores the polite close.
  const { service, session, timers, started, frames } = await startWithApp({
    graceKillMs: 100,
    settleMs: 200,
    cancelKills: false,
  })
  const handle = session.shellHandle
  service.shellClose({ streamId: started.streamId })
  assert.equal(handle.cancelled, 1)
  await timers.advance(100)
  assert.deepEqual(handle.signals, ['KILL'], 'SIGKILL follows the grace period')
  await timers.advance(200)
  const result = await withTimeout(started.done, 1000, 'shell done')
  assert.equal(result.endReason, 'cancelled')
  assert.deepEqual(kinds(frames).slice(-2), ['exit', 'end'])
  assert.equal(frames.at(-1).reason, 'cancelled')
  assert.equal(timers.pending, 0)
})

test('write, resize and signal are refused once the shell has ended', async () => {
  const { service, started } = await startWithApp()
  const { streamId } = started
  service.shellClose({ streamId })
  await started.done
  for (const call of [
    () => service.shellWrite({ streamId, data: 'x' }),
    () => service.shellResize({ streamId, cols: 80, rows: 24 }),
    () => service.shellSignal({ streamId, signal: 'TERM' }),
  ]) {
    assert.throws(call, (error) => error instanceof SshError && error.code === 'SSH_STATE_INVALID')
  }
  assert.throws(
    () => service.shellClose({ streamId }),
    (error) => error instanceof SshError && error.code === 'SSH_STATE_INVALID',
  )
})

test('input typed before the PTY opens is buffered and delivered in order', async () => {
  const { service, session, timers } = harness({ limits: { graceKillMs: 100 }, settleMs: 100 })
  const started = service.openShell({ sessionId: 's_test', cols: 80, rows: 24 })
  // No `await flush()`: a real PTY takes a round trip to open and a user types
  // immediately, so these keystrokes must be held and delivered, not dropped.
  assert.deepEqual(service.shellWrite({ streamId: started.streamId, data: 'e' }), { written: 1 })
  assert.deepEqual(service.shellWrite({ streamId: started.streamId, data: 'cho hi\n' }), { written: 7 })
  await flush()
  // Each call keeps its own boundary, so the terminal receives the keystrokes in
  // the order they were typed rather than as one unpredictable blob.
  assert.deepEqual(session.shellHandle.writes, ['e', 'cho hi\n'])

  // Past the cap the call fails loudly instead of silently discarding input.
  const second = harness()
  const other = second.service.openShell({ sessionId: 's_test', cols: 80, rows: 24 })
  assert.throws(
    () => second.service.shellWrite({ streamId: other.streamId, data: 'x'.repeat(70_000) }),
    (error) => error instanceof SshError && error.code === 'SSH_STATE_INVALID',
  )
  second.service.dispose()

  // Closing a PTY that never reports its exit ends after the grace escalation.
  service.shellClose({ streamId: started.streamId })
  await timers.advance(300)
  const result = await withTimeout(started.done, 1000, 'shell done')
  assert.equal(result.endReason, 'cancelled')
  assert.equal(timers.pending, 0, 'the test leaves no timer armed')
})

test('shellWrite reports the accepted byte count for utf8 and base64 input', async () => {
  const { service, started, handle } = await startWithApp()
  assert.deepEqual(service.shellWrite({ streamId: started.streamId, data: 'héllo' }), { written: 6 })
  assert.deepEqual(service.shellWrite({ streamId: started.streamId, data: 'aGVsbG8=', encoding: 'base64' }), {
    written: 5,
  })
  assert.equal(handle.writes[0].toString('utf8'), 'héllo')
  assert.equal(handle.writes[1].toString('utf8'), 'hello')
  service.shellClose({ streamId: started.streamId })
  await started.done
})

test('a channel that fails to open still terminates the stream', async () => {
  const session = new FakeSession({ shellError: new SshError('SSH_PERM_DENIED', 'pty refused') })
  const { service } = harness({ session })
  const started = service.openShell({ sessionId: 's_test', cols: 80, rows: 24 })
  const { frames } = collect(service.hub, started.streamId)
  const result = await withTimeout(started.done, 1000, 'shell done')
  assert.equal(result.endReason, 'error')
  assert.equal(result.error.code, 'SSH_PERM_DENIED')
  assert.deepEqual(kinds(frames), ['open', 'exit', 'end'])
  assert.deepEqual(inspectFrameSequence(frames), [])
})

test('dispose ends a live terminal instead of leaving it open', async () => {
  const { service, started, frames, handle } = await startWithApp()
  service.dispose('peer-closed')
  const result = await withTimeout(started.done, 1000, 'shell done')
  assert.equal(result.endReason, 'peer-closed')
  assert.deepEqual(kinds(frames).slice(-2), ['exit', 'end'])
  assert.equal(frames.at(-1).reason, 'peer-closed')
  assert.equal(handle.cancelled, 1)
})

// ── replay window (the shell variant of "report, never drop") ────────────────

test('a terminal stream keeps a bounded replay window and reports a gap', async () => {
  const { service, started, handle, frames } = await startWithApp({ replayLimitBytes: 4096, maxOutputBytes: 262_144 })
  for (let index = 0; index < 40; index += 1) handle.emit('stdout', `line ${index} ${'y'.repeat(200)}\n`)
  const lastSeq = service.hub.get(started.streamId).lastSeq
  assert.ok(lastSeq > 20)

  // Everything is on the live path...
  assert.equal(frames.filter((frame) => frame.t === 'data').length, lastSeq + 1)
  // ...while a fresh subscriber is told that the beginning is no longer retained.
  const fresh = collect(service.hub, started.streamId)
  assert.equal(fresh.subscription.gap, true, 'the gap is reported, never hidden')
  assert.equal(fresh.frames[0].t, 'open')
  assert.ok(fresh.frames.filter((frame) => frame.t === 'data').length < lastSeq + 1)

  // A resubscription from the last seen seq loses nothing.
  const resumed = collect(service.hub, started.streamId, { sinceSeq: lastSeq })
  assert.equal(resumed.subscription.gap, false)
  handle.emit('stdout', 'tail\n')
  assert.equal(resumed.frames.at(-1).chunk, 'tail\n')
  assert.equal(resumed.frames.at(-1).seq, lastSeq + 1)

  service.shellClose({ streamId: started.streamId })
  await started.done
})
