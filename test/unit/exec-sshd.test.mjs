/**
 * End-to-end over a **real SSH protocol**: sp8's ssh2 server double
 * (`test/support/sshd.mjs`, an in-process `minish` interpreter) driven through
 * sp1's real `ConnectionPool` and this layer's `ExecService`.
 *
 * The unit tests drive fakes so they can assert impossible states; this file is
 * the opposite — it proves the three claims that cannot be proven with a fake:
 *
 *   1. a real timeout really kills the remote process (SIGTERM → SIGKILL), and
 *      the stream ends with `exit{timedOut:true}` + `end{reason:'timeout'}`;
 *   2. a real `endInput()` gives a remote `cat` its end-of-file, so a command
 *      that reads until EOF finishes instead of waiting for its deadline;
 *   3. a real PTY runs a full-screen application (`top`): alternate screen,
 *      redraws, a resize that reaches the application, and a clean restore of the
 *      terminal when it quits.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createConnectionPool } from '../../lib/connection/index.js'
import { inspectFrameSequence } from '../../lib/exec/frames.js'
import { ExecService } from '../../lib/exec/service.js'
// SP8's protocol-level sshd double: a real ssh2 server with `minish` behind it,
// so commands are actually interpreted and `top` is a real full-screen app.
import { startSshd } from '../support/sshd.mjs'
import { makeConfig, makeProfile, memoryLogger, trackingRedactor } from './connection-fixture.test.mjs'

const PASSWORD = 'exec-e2e-secret'

/** Connect through the real pool to the real protocol double. */
async function connect(t, limits = {}) {
  const server = await startSshd({ host: '127.0.0.1', user: 'sshuser', password: PASSWORD })
  const pool = createConnectionPool({
    config: makeConfig(),
    logger: memoryLogger(),
    redactor: trackingRedactor(),
    env: {},
    platform: 'linux',
  })
  t.after(async () => {
    await pool.disposeAll('exec e2e teardown')
    await server.stop()
  })
  const profile = makeProfile({
    host: server.host,
    port: server.port,
    user: server.user,
    auth: 'password',
    secretRefs: {},
    secrets: { password: server.password },
    // The double generates a throwaway host key per run.
    hostKeyPolicy: 'insecure',
  })
  const session = await pool.acquire({ profile })
  assert.equal(session.state, 'connected')

  const service = new ExecService({
    resolveSession: (id) => pool.get(id),
    listSessions: () => [{ id: session.id, host: session.info.host, user: session.info.user, state: session.state }],
    defaultSessionId: () => session.id,
    limits: { maxOutputBytes: 65_536, operationTimeoutMs: 10_000, graceKillMs: 300, ...limits },
    logger: memoryLogger(),
    settleMs: 1_000,
  })
  t.after(() => service.dispose())
  return { server, pool, session, service }
}

/** Frames of one stream, collected from the moment it is created. */
function collector(service, streamId) {
  const frames = []
  const subscription = service.subscribe(streamId, (frame) => frames.push(frame))
  const text = () =>
    Buffer.concat(
      frames
        .filter((frame) => frame.t === 'data')
        .map((frame) => Buffer.from(frame.chunk, frame.encoding === 'base64' ? 'base64' : 'utf8')),
    ).toString('utf8')
  const kinds = () => frames.map((frame) => (frame.t === 'data' ? `data:${frame.channel}` : frame.t))
  return { frames, subscription, text, kinds }
}

/** Real-time wait (this file talks to a real server, so real timers apply). */
async function waitUntil(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${label}`)
}

test('a real command end-to-end: frames, output and exit code', async (t) => {
  const { session, service } = await connect(t)
  const started = service.exec({ sessionId: session.id, command: 'uname -a' })
  const stream = collector(service, started.streamId)

  const result = await started.done
  assert.equal(result.exitCode, 0)
  assert.equal(result.endReason, 'completed')
  assert.equal(result.timedOut, false)
  assert.match(result.stdout, /Linux/i)
  assert.deepEqual(inspectFrameSequence(stream.frames), [])
  assert.equal(stream.frames[0].t === 'open' ? stream.frames[0].kind : null, 'exec')
  assert.equal(stream.kinds().at(-2), 'exit')
  assert.equal(stream.kinds().at(-1), 'end')
  assert.equal(service.hub.get(started.streamId).violations.length, 0)
})

test('a real timeout kills the remote process and reports timedOut', async (t) => {
  const { session, service } = await connect(t, { graceKillMs: 200 })
  const startedMs = Date.now()
  const started = service.exec({ sessionId: session.id, command: 'sleep 30', timeoutMs: 400 })
  const stream = collector(service, started.streamId)

  const result = await started.done
  const elapsed = Date.now() - startedMs
  assert.equal(result.timedOut, true)
  assert.equal(result.endReason, 'timeout')
  assert.equal(result.error.code, 'SSH_TIMEOUT_OPERATION')
  assert.ok(elapsed < 8_000, `the remote sleep must be killed, not awaited (took ${elapsed} ms)`)

  const exit = stream.frames.find((frame) => frame.t === 'exit')
  assert.equal(exit.timedOut, true)
  assert.equal(stream.frames.at(-1).reason, 'timeout')
  assert.equal(stream.frames.at(-1).error.code, 'SSH_TIMEOUT_OPERATION')
  assert.deepEqual(inspectFrameSequence(stream.frames), [])
  assert.equal(stream.frames.filter((frame) => frame.t === 'exit').length, 1)
  assert.equal(stream.frames.filter((frame) => frame.t === 'end').length, 1)
})

test('a real stdin plus endInput() gives a remote cat its EOF', async (t) => {
  const { session, service } = await connect(t)
  // Without `endInput()` this would hang until the deadline: the whole point of
  // the ICD v1.0.4 addition.
  const result = await service.execWait(
    { sessionId: session.id, command: 'cat', timeoutMs: 8_000 },
    { stdin: 'hello from stdin\n' },
  )
  assert.equal(result.stdout, 'hello from stdin\n')
  assert.equal(result.exitCode, 0)
  assert.equal(result.timedOut, false)
})

test('a real PTY echoes input and closes cleanly', async (t) => {
  const { session, service } = await connect(t)
  const started = service.openShell({ sessionId: session.id, cols: 80, rows: 24 })
  const stream = collector(service, started.streamId)
  await waitUntil(() => stream.text().length > 0, 'the shell prompt')

  service.shellWrite({ streamId: started.streamId, data: 'echo pty-ok\n' })
  await waitUntil(() => stream.text().includes('pty-ok'), 'the echoed command output')

  service.shellClose({ streamId: started.streamId })
  const result = await started.done
  assert.equal(result.endReason, 'cancelled')
  assert.deepEqual(inspectFrameSequence(stream.frames), [])
  assert.equal(stream.frames.at(-1).t, 'end')
  assert.equal(stream.frames.at(-1).reason, 'cancelled')
  assert.equal(service.hub.get(started.streamId).violations.length, 0)
})

test('a real full-screen app (top) redraws, resizes and restores the terminal', async (t) => {
  const { session, service } = await connect(t)
  const started = service.openShell({ sessionId: session.id, cols: 100, rows: 30, term: 'xterm-256color' })
  const stream = collector(service, started.streamId)

  // 1. The application takes over the screen: alternate screen + hidden cursor.
  //    The keystrokes are written immediately after `openShell`, before the PTY
  //    exists on the wire: they must be buffered and delivered, not lost.
  service.shellWrite({ streamId: started.streamId, data: 'top\n' })
  await waitUntil(() => stream.text().includes('\u001b[?1049h'), 'the alternate screen')
  await waitUntil(() => stream.text().includes('size: 100x30'), 'the first full-size frame')
  assert.ok(stream.text().includes('\u001b[?25l'), 'the cursor is hidden while the app owns the screen')

  // 2. It keeps redrawing (the fixture repaints on an interval), so the stream is
  //    genuinely live rather than a single snapshot.
  const framesBefore = stream.frames.filter((frame) => frame.t === 'data').length
  await waitUntil(
    () => stream.frames.filter((frame) => frame.t === 'data').length >= framesBefore + 2,
    'further redraw frames',
  )

  // 3. A window change reaches the application: the next frame renders 120x40.
  service.shellResize({ streamId: started.streamId, cols: 120, rows: 40 })
  await waitUntil(() => stream.text().includes('size: 120x40'), 'a redraw at the new geometry')

  // 4. Quitting restores the terminal (cursor back, alternate screen left).
  service.shellWrite({ streamId: started.streamId, data: 'q' })
  await waitUntil(() => stream.text().includes('\u001b[?1049l'), 'the alternate screen to be left')
  assert.ok(stream.text().includes('\u001b[?25h'), 'the cursor is restored')

  // 5. Nothing was ever truncated on the terminal path.
  assert.equal(
    stream.frames.some((frame) => frame.t === 'end' && frame.reason === 'error'),
    false,
    'a terminal stream never ends with a truncation error',
  )
  assert.ok(stream.frames.filter((frame) => frame.t === 'data').length >= 4)

  service.shellClose({ streamId: started.streamId })
  const result = await started.done
  assert.equal(result.endReason, 'cancelled')
  assert.ok(result.bytes > 500, `the terminal produced real traffic (${result.bytes} bytes)`)
  // The sequence is only complete once the stream has ended.
  assert.deepEqual(inspectFrameSequence(stream.frames), [])
  assert.equal(stream.frames.at(-1).reason, 'cancelled')
})
