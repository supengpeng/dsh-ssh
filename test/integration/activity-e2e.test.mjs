/**
 * §4.7 agent-activity mirror — INDEPENDENT end-to-end verification (task-3).
 *
 * This file was written by a verifier who did not write the feature, from the
 * built artifacts only (`lib/**`), and it deliberately does not reuse the
 * authors' harnesses. What it drives is the *whole* host graph:
 *
 *     test/support/sshd.mjs (real ssh2 server + `minish` behind it)
 *        → lib/api/runtime.js `createHostRuntime()`          ← the real object graph
 *             → the real connection pool / session registry
 *             → the real `ExecService` (with the new `ExecWaitOptions.onFrame` hook)
 *             → the real `ActivityFeed`
 *             → the real `registerAgentTools()` (so the tools below are the ones a
 *               model actually calls, taken out of the real registry)
 *             → the real `LocalApi` / `ActivityApi`
 *             → the real `SshPluginService.followActivity` stream
 *
 * Three claims are checked, each of which the authors' own tests could have
 * satisfied for the wrong reason:
 *
 *   1. a command run *through the registered tool* produces one activity record
 *      whose transcript (as delivered on the wire) carries BOTH stdout and stderr,
 *      whose chunks arrive *while the command is still running*, and whose `end`
 *      frame carries the exit code and status;
 *   2. a refusal (unknown sessionId / invalid arguments) is recorded with status
 *      `refused` and its `SSH_*` code — i.e. the model's failed attempts are in the
 *      mirror too;
 *   3. the `ssh_sessions` output-schema regression is real: the *registered* tool's
 *      declared schema accepts the envelope the tool returns for a live session
 *      opened against the sshd double, and the pre-fix closed-item schema is shown
 *      to reject the same value (so the assertion is not vacuous).
 *
 * Plus the adversarial checks the task asks for at host level: a `chunk` after a
 * record ended cannot touch the published record or reach subscribers, and
 * `clearActivity` drops only *finished* records — a still-running record keeps its
 * transcript and its later `end` frame.
 *
 * Discipline: this file must be run alone
 * (`node --test --test-concurrency=1 --test-force-exit --test-timeout=60000 <file>`).
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

import { createHostRuntime } from '../../lib/api/runtime.js'
import { Config, resolveConfig } from '../../lib/config.js'
import { makeProfile, memoryLogger } from '../support/host.mjs'
import { startSshd } from '../support/sshd.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

const PASSWORD = 'activity-e2e-secret'

/**
 * One real command with all four things the mirror must carry: stdout that can be
 * watched *while it runs* (the first line is printed, then the command sleeps long
 * enough that a chunk arriving before the end is unambiguous), a second stdout
 * line, a stderr line, and a non-zero exit code.
 */
const COMMAND = "echo alpha-out; sleep 1.5; echo omega-out; echo beta-err 1>&2; exit 3"

/** The execution context the registry hands a tool body; the tool reads `signal`. */
function toolContext() {
  return { signal: new AbortController().signal, callId: 'call_1', rootCallId: 'call_1', name: 'ssh_exec' }
}

/**
 * The real plugin object graph, wired exactly as `src/index.ts` wires it, minus the
 * Cordis envelope: a `ctx` with a `tools` registry and a logger, and the plugin's own
 * resolved configuration in a throwaway `DSH_HOME`.
 */
async function boot(t, configPatch = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-activity-e2e-'))
  mkdirSync(dir, { recursive: true })
  const server = await startSshd({ host: '127.0.0.1', user: 'sshuser', password: PASSWORD })

  /** The tools the *real* registration path produced, in registration order. */
  const registered = []
  const ctx = {
    tools: {
      register(tool) {
        registered.push(tool)
        return () => {}
      },
    },
    logger: memoryLogger(),
  }
  const config = resolveConfig(Config({ hostKey: { policy: 'insecure' }, ...configPatch }), { DSH_HOME: dir })
  const runtime = await createHostRuntime({ ctx, config })

  t.after(async () => {
    try {
      await runtime.dispose()
    } finally {
      await server.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  const session = await runtime.parts.pool.acquire({ profile: makeProfile(server) })
  assert.equal(session.state, 'connected', 'the sshd double accepted the profile')

  return {
    ctx,
    config,
    dir,
    server,
    session,
    registered,
    runtime,
    /** The tool as registered (not a re-construction of it). */
    tool(name) {
      const found = registered.find((candidate) => candidate.name === name)
      assert.ok(found, `${name} was registered by registerAgentTools()`)
      return found
    },
  }
}

/** One reader over the *service's* stream — what a browser panel receives. */
function follow(service) {
  const iterator = service.followActivity()[Symbol.asyncIterator]()
  return {
    iterator,
    async next(label) {
      const next = await iterator.next()
      assert.equal(next.done, false, `followActivity ended before ${label}`)
      return next.value
    },
    stop() {
      return iterator.return()
    },
  }
}

/** The transcript of a record as one string, in wire order. */
function transcriptOf(activity) {
  return activity.segments.map((segment) => segment.text).join('')
}

test('the built host artifacts carry this revision of the mirror (freshness probe for the evidence above)', () => {
  // Not a behaviour test: it guards the *evidence*. If `lib/**` were stale, every
  // assertion above would be verifying a previous revision of the feature.
  const constantsOf = (text) =>
    Object.fromEntries(
      ['DEFAULT_MAX_RECORDS', 'DEFAULT_MAX_RECORD_BYTES', 'DEFAULT_MAX_TOTAL_BYTES'].map((name) => [
        name,
        Number(new RegExp(`${name} = ([\\d_]+)`).exec(text)?.[1]?.replace(/_/g, '')),
      ]),
    )
  assert.deepEqual(
    constantsOf(readFileSync(join(ROOT, 'lib', 'activity', 'feed.js'), 'utf8')),
    constantsOf(readFileSync(join(ROOT, 'src', 'activity', 'feed.ts'), 'utf8')),
    'lib/activity/feed.js and src/activity/feed.ts agree on the ring budgets',
  )

  // The one hook the live-output claim rests on, and the refusal path, are in the
  // built service/tool — not only in the TypeScript.
  assert.match(readFileSync(join(ROOT, 'lib', 'exec', 'service.js'), 'utf8'), /options\.onFrame/)
  const builtTool = readFileSync(join(ROOT, 'lib', 'tools', 'exec.js'), 'utf8')
  assert.match(builtTool, /onFrame: \(frame\) => mirrorExecFrame/)
  assert.match(builtTool, /recordRefusal/)
})

test('a command run through the registered ssh_exec tool is mirrored live, with stdout, stderr and its exit code', async (t) => {
  const { runtime, session, tool } = await boot(t)
  const exec = tool('ssh_exec')
  assert.doesNotThrow(() => assertSupportedJsonSchema(exec.parameters))
  assert.doesNotThrow(() => assertSupportedJsonSchema(exec.output.schema))

  const stream = follow(runtime.service)
  t.after(() => stream.stop())

  // 1. The stream opens with the retained history — here: nothing yet.
  const snapshot = await stream.next('the first frame')
  assert.equal(snapshot.t, 'activity-snapshot', 'the snapshot is the first frame of followActivity')
  assert.deepEqual(snapshot.activities, [], 'the feed starts empty')

  // 2. Run the real command through the real tool, over the real SSH protocol.
  const startedAt = Date.now()
  let settledAt = 0
  const call = exec.execute({ command: COMMAND, sessionId: session.id, label: 'mirror-e2e' }, toolContext())
  const settled = call.then((value) => {
    settledAt = Date.now()
    return value
  })

  const frames = []
  const at = []
  for (;;) {
    const frame = await stream.next('the end frame of the mirrored record')
    frames.push(frame)
    at.push({ ms: Date.now() - startedAt, toolSettled: settledAt !== 0 })
    if (frame.t === 'activity' && frame.phase === 'end') break
  }
  const envelope = await settled

  // 3. The begin frame describes the operation as the *tool* saw it.
  const begin = frames[0]
  assert.equal(begin.t, 'activity')
  assert.equal(begin.phase, 'begin')
  assert.equal(begin.activity.kind, 'exec')
  assert.equal(begin.activity.status, 'running')
  assert.equal(begin.activity.subject, COMMAND, 'the subject is the command the model asked for')
  assert.equal(begin.activity.sessionId, session.id)
  assert.equal(begin.activity.label, 'mirror-e2e')
  assert.match(String(begin.activity.target), /@127\.0\.0\.1$/, 'the record names the host it ran on')

  // 4. Live output: stdout and stderr reach the panel as chunk frames, in order,
  //    and at least the first stdout chunk arrives while the command is *still
  //    running* (the tool call has not settled), which is the whole point of the
  //    `onFrame` hook — `execWait` only returns when the command is over.
  const chunks = frames.filter((frame) => frame.t === 'activity' && frame.phase === 'chunk')
  const stdoutChunks = chunks.filter((frame) => frame.chunk.channel === 'stdout')
  const stderrChunks = chunks.filter((frame) => frame.chunk.channel === 'stderr')
  assert.ok(stdoutChunks.length > 0, 'stdout was mirrored as it happened')
  assert.ok(stderrChunks.length > 0, 'stderr was mirrored as it happened')

  const alphaIndex = frames.findIndex(
    (frame) => frame.t === 'activity' && frame.phase === 'chunk' && frame.chunk.text.includes('alpha-out'),
  )
  assert.ok(alphaIndex >= 0, 'the first stdout line is on the wire')
  assert.equal(
    at[alphaIndex].toolSettled,
    false,
    'the stdout chunk arrived while the command was still running, not only at the end',
  )
  assert.ok(
    settledAt - (startedAt + at[alphaIndex].ms) > 500,
    `the chunk preceded the tool result by a real margin (${settledAt - (startedAt + at[alphaIndex].ms)} ms)`,
  )
  const order = frames
    .filter((frame) => frame.t === 'activity' && frame.phase === 'chunk')
    .map((frame) => `${frame.chunk.channel}:${frame.chunk.text.trim()}`)
  assert.deepEqual(order.slice(0, 3), ['stdout:alpha-out', 'stdout:omega-out', 'stderr:beta-err'], 'wire order is command order')

  // 5. The end frame carries the outcome — the command's own exit code is a result,
  //    not a mirror failure, and the transcript is complete.
  const end = frames.at(-1)
  assert.equal(end.phase, 'end')
  assert.equal(end.activity.id, begin.activity.id, 'one record, closed by its own end frame')
  assert.equal(end.activity.status, 'ok', 'a non-zero exit code the tool reported is still a finished call')
  assert.equal(end.activity.exitCode, 3)
  assert.equal(end.activity.signal, null)
  assert.equal(typeof end.activity.durationMs, 'number')
  assert.match(transcriptOf(end.activity), /alpha-out/)
  assert.match(transcriptOf(end.activity), /omega-out/)
  assert.match(transcriptOf(end.activity), /beta-err/)
  assert.deepEqual(
    end.activity.segments.map((segment) => segment.channel),
    ['stdout', 'stderr'],
    'stdout is one merged segment (adjacent same-channel text) and stderr is its own',
  )
  assert.ok(
    end.activity.segments[0].text.indexOf('alpha-out') < end.activity.segments[0].text.indexOf('omega-out'),
    'the merged stdout segment preserves the order the command printed in',
  )
  assert.equal(end.activity.truncated, false)

  // 6. The tool result agrees with the mirror, and satisfies its own declared schema.
  assert.equal(envelope.ok, true)
  assert.equal(envelope.outcome, 'success')
  assert.equal(envelope.exitCode, 3)
  assert.equal(envelope.sessionId, session.id)
  assert.match(envelope.stdout, /alpha-out/)
  assert.match(envelope.stdout, /omega-out/)
  assert.match(envelope.stderr, /beta-err/)
  assert.deepEqual(validateJsonSchemaValue(exec.output.schema, envelope), [], 'the envelope satisfies output.schema')

  // 7. The record lives in the same feed the endpoint serves (one graph, not two).
  const retained = runtime.parts.activity.snapshot()
  assert.equal(retained.length, 1)
  assert.equal(retained[0].id, begin.activity.id)
  assert.equal(retained[0].status, 'ok')

  // 8. A panel that attaches *after* the command finished still gets the whole
  //    transcript — both channels — from `activity-snapshot`, which is the other
  //    half of the "the frames carry stdout and stderr" claim.
  const late = follow(runtime.service)
  t.after(() => late.stop())
  const lateSnapshot = await late.next('the late subscriber snapshot')
  assert.equal(lateSnapshot.t, 'activity-snapshot')
  assert.equal(lateSnapshot.activities.length, 1)
  const lateRecord = lateSnapshot.activities[0]
  assert.equal(lateRecord.id, begin.activity.id)
  assert.deepEqual(lateRecord.segments.map((segment) => segment.channel), ['stdout', 'stderr'])
  assert.match(transcriptOf(lateRecord), /alpha-out/)
  assert.match(transcriptOf(lateRecord), /beta-err/)
  assert.equal(lateRecord.exitCode, 3)
  assert.equal(lateRecord.status, 'ok')
})

test('a refused ssh_exec call (unknown sessionId, and invalid arguments) is mirrored with status refused and its SSH_* code', async (t) => {
  const { runtime, session, tool } = await boot(t)
  const exec = tool('ssh_exec')

  const stream = follow(runtime.service)
  t.after(() => stream.stop())
  assert.equal((await stream.next('the snapshot')).t, 'activity-snapshot')

  // A session id the pool cannot resolve: the command never reaches a host.
  const unknown = await exec.execute({ command: 'uptime', sessionId: 's_nope' }, toolContext())
  assert.equal(unknown.ok, false)
  assert.equal(unknown.outcome, 'refused')
  assert.equal(unknown.code, 'SSH_STATE_INVALID')

  const begin = await stream.next('the begin frame of the refusal')
  assert.equal(begin.phase, 'begin')
  assert.equal(begin.activity.subject, 'uptime')
  assert.equal(begin.activity.sessionId, 's_nope')
  assert.equal(begin.activity.target, null, 'no session, no target: the record does not invent a host')

  const end = await stream.next('the end frame of the refusal')
  assert.equal(end.phase, 'end')
  assert.equal(end.activity.id, begin.activity.id)
  assert.equal(end.activity.status, 'refused', 'a declined call is recorded as refused, not as an error')
  assert.equal(end.activity.code, 'SSH_STATE_INVALID', 'the record carries the frozen code the model was given')
  assert.equal(end.activity.exitCode, null)
  assert.match(String(end.activity.note), /unknown session/i)
  assert.match(String(end.activity.note), /host: s_nope/, 'the record says which host was asked for')
  assert.equal(end.activity.segments.length, 0, 'nothing ran, so there is no output to pretend about')

  // A call the tool refuses before it even resolves a session (invalid arguments)
  // is mirrored too — as one complete record.
  const invalid = await exec.execute({ sessionId: session.id }, toolContext())
  assert.equal(invalid.ok, false)
  assert.equal(invalid.outcome, 'refused')
  assert.equal(invalid.code, 'SSH_CFG_INVALID')
  const invalidBegin = await stream.next('the begin frame of the argument refusal')
  const invalidEnd = await stream.next('the end frame of the argument refusal')
  assert.equal(invalidBegin.phase, 'begin')
  assert.equal(invalidEnd.phase, 'end')
  assert.equal(invalidEnd.activity.status, 'refused')
  assert.equal(invalidEnd.activity.code, 'SSH_CFG_INVALID')
  assert.equal(invalidEnd.activity.sessionId, null)

  // Both refusals are in the ring, neither is stuck as `running`.
  const retained = runtime.parts.activity.snapshot()
  assert.equal(retained.length, 2)
  assert.deepEqual(
    retained.map((record) => `${record.status}:${record.code}`),
    ['refused:SSH_STATE_INVALID', 'refused:SSH_CFG_INVALID'],
  )
})

test('the registered ssh_sessions tool satisfies its own output schema for a REAL session (and the pre-fix schema is shown to reject it)', async (t) => {
  const { runtime, session, tool } = await boot(t)
  const sessions = tool('ssh_sessions')
  assert.doesNotThrow(() => assertSupportedJsonSchema(sessions.parameters))

  const value = await sessions.execute({}, toolContext())
  assert.equal(value.ok, true)
  assert.equal(value.sessions.length, 1, 'exactly the session the pool acquired is listed')

  const listed = value.sessions[0]
  assert.equal(listed.sessionId, session.id, 'the id the other ssh_* tools need')
  assert.equal(listed.host, session.info.host)
  assert.equal(listed.port, session.info.port)
  assert.equal(listed.user, session.info.user)
  assert.equal(listed.state, 'connected')
  assert.equal(typeof listed.connectedForMs, 'number')
  assert.ok(listed.connectedForMs >= 0)
  assert.equal(typeof listed.since, 'string')
  assert.equal(listed.bytesIn, 0)
  assert.equal(listed.bytesOut, 0)
  assert.deepEqual(listed.capabilities, { shell: true, sftp: true })

  // The Host validates every tool result against the tool's declared schema before
  // the model sees it, so this is the real acceptance gate.
  assert.deepEqual(validateJsonSchemaValue(sessions.output.schema, value), [], 'a real envelope must pass the declared schema')

  // Non-vacuity: the old declaration used `objectNode({})` for a session item —
  // a *closed* object with no properties — and that is precisely what rejected a
  // real session with "is not a declared property". Re-apply that shape and prove
  // the checker discriminates.
  const preFix = JSON.parse(JSON.stringify(sessions.output.schema))
  preFix.properties.sessions.items = { type: 'object', properties: {}, additionalProperties: false }
  const rejected = validateJsonSchemaValue(preFix, value)
  assert.notDeepEqual(rejected, [], 'the pre-fix item schema must NOT accept the real projection')
  assert.ok(
    rejected.some((message) => String(message).includes('"value.sessions[0].sessionId" is not a declared property')),
    `the old defect's exact message reappears (got: ${JSON.stringify(rejected).slice(0, 200)})`,
  )

  // The one genuinely optional field stays optional: `rttMs` is absent until the
  // connection has been measured, and the schema must not require it.
  assert.equal('rttMs' in listed, false)
  assert.deepEqual(validateJsonSchemaValue(sessions.output.schema, value), [])

  // The tool and the real §4.3 endpoint read one registry, so they cannot disagree
  // about which session exists (a mismatch here would be the same class of bug as
  // the schema defect: two projections of one fact drifting apart).
  const overWire = await runtime.service.listSessions()
  assert.equal(overWire.sessions.length, value.sessions.length)
  assert.equal(overWire.sessions[0].id, listed.sessionId)
  assert.equal(overWire.sessions[0].host, listed.host)
  assert.equal(overWire.sessions[0].user, listed.user)
})

test('two commands running at once keep their output in their own records', async (t) => {
  // The `onFrame` hook is per-command, but the feed is one global ring: a mix-up
  // would be invisible in a single-command test and would put one host's output in
  // another host's record — the one failure a mirror must not have.
  const { runtime, session, tool } = await boot(t)
  const exec = tool('ssh_exec')
  const stream = follow(runtime.service)
  t.after(() => stream.stop())
  assert.equal((await stream.next('the snapshot')).t, 'activity-snapshot')

  const slow = 'echo alpha-one; sleep 0.8; echo alpha-two'
  const fast = 'echo beta-one; sleep 0.3; echo beta-two'
  const calls = [
    exec.execute({ command: slow, sessionId: session.id, label: 'slow' }, toolContext()),
    exec.execute({ command: fast, sessionId: session.id, label: 'fast' }, toolContext()),
  ]

  const begins = new Map()
  const ends = new Map()
  const chunkOwner = new Map()
  for (let guard = 0; guard < 200 && ends.size < 2; guard += 1) {
    const frame = await stream.next('both end frames')
    if (frame.t !== 'activity') continue
    if (frame.phase === 'begin') begins.set(frame.activity.id, frame.activity)
    else if (frame.phase === 'end') ends.set(frame.activity.id, frame.activity)
    else if (frame.phase === 'chunk') {
      const previous = chunkOwner.get(frame.id) ?? ''
      chunkOwner.set(frame.id, previous + frame.chunk.text)
    }
  }
  const [alpha, beta] = await Promise.all(calls)

  assert.equal(begins.size, 2, 'two records were opened')
  assert.equal(ends.size, 2, 'two records were closed')
  const byLabel = new Map([...begins.values()].map((record) => [record.label, record]))
  assert.deepEqual([...byLabel.keys()].sort(), ['fast', 'slow'])
  const slowRecord = byLabel.get('slow')
  const fastRecord = byLabel.get('fast')
  assert.notEqual(slowRecord.id, fastRecord.id)

  assert.equal(ends.get(slowRecord.id).status, 'ok')
  assert.equal(ends.get(fastRecord.id).status, 'ok')
  assert.equal(ends.get(slowRecord.id).exitCode, 0)
  assert.equal(alpha.command, slow)
  assert.equal(beta.command, fast)
  assert.match(alpha.notes.join('\n'), /label: slow/)
  assert.match(beta.notes.join('\n'), /label: fast/)

  // No chunk crossed over, and each transcript holds exactly its own command's output.
  for (const [id, text] of chunkOwner) {
    const other = id === slowRecord.id ? 'beta-' : 'alpha-'
    assert.equal(text.includes(other), false, `record ${id} received another command's output: ${JSON.stringify(text)}`)
  }
  const slowText = transcriptOf(ends.get(slowRecord.id))
  const fastText = transcriptOf(ends.get(fastRecord.id))
  assert.match(slowText, /alpha-one/)
  assert.match(slowText, /alpha-two/)
  assert.equal(slowText.includes('beta-'), false)
  assert.match(fastText, /beta-one/)
  assert.match(fastText, /beta-two/)
  assert.equal(fastText.includes('alpha-'), false)
  assert.equal(runtime.parts.activity.snapshot().length, 2)
})

test('a disabled mirror records nothing and never fails the command it observes', async (t) => {
  const { runtime, session, tool, config } = await boot(t, { activity: { enabled: false } })
  assert.equal(config.activity.enabled, false)
  assert.equal(runtime.parts.activity.enabled, false)

  const stream = follow(runtime.service)
  t.after(() => stream.stop())
  const snapshot = await stream.next('the disabled snapshot')
  assert.deepEqual(snapshot, { t: 'activity-snapshot', activities: [] })

  const envelope = await tool('ssh_exec').execute({ command: 'echo still-run; exit 4', sessionId: session.id }, toolContext())
  assert.equal(envelope.ok, true, 'the command ran normally with the mirror off')
  assert.equal(envelope.exitCode, 4)
  assert.match(envelope.stdout, /still-run/)
  assert.equal(runtime.parts.activity.size(), 0, 'nothing was retained')
  assert.deepEqual(runtime.parts.activity.snapshot(), [])
})

test('a chunk after a record ended cannot touch the published record or reach a subscriber', async (t) => {
  const { runtime } = await boot(t)
  const feed = runtime.parts.activity
  const stream = follow(runtime.service)
  t.after(() => stream.stop())
  assert.deepEqual((await stream.next('the snapshot')).activities, [])

  const handle = feed.begin({ kind: 'exec', sessionId: 's_1', subject: 'tail -f app.log' })
  assert.equal((await stream.next('the begin frame')).phase, 'begin')

  handle.chunk('stdout', 'first line\n')
  const chunk = await stream.next('the chunk frame')
  assert.deepEqual(chunk.chunk, { channel: 'stdout', text: 'first line\n' })

  handle.finish({ status: 'ok', exitCode: 0 })
  const end = await stream.next('the end frame')
  assert.equal(end.phase, 'end')
  const published = JSON.parse(JSON.stringify(end.activity))

  // The record is sealed: a late chunk may not rewrite what subscribers hold.
  assert.doesNotThrow(() => handle.chunk('stdout', 'LATE TEXT\n'))
  assert.doesNotThrow(() => handle.finish({ status: 'error', code: 'SSH_UNKNOWN' }))
  const retained = feed.snapshot().find((record) => record.id === handle.id)
  assert.deepEqual(retained.segments, published.segments, 'the retained transcript is unchanged')
  assert.equal(retained.status, published.status, 'the outcome is unchanged')
  assert.equal(retained.exitCode, published.exitCode)
  assert.equal(retained.truncated, false)

  // …and no frame was announced for it: the very next event is the next record's.
  const probe = feed.begin({ kind: 'sessions', subject: 'probe' })
  const nextFrame = await stream.next('the frame after the late chunk')
  assert.equal(nextFrame.phase, 'begin', 'the late chunk produced no frame at all')
  assert.equal(nextFrame.activity.subject, 'probe')
  probe.finish({ status: 'ok' })
})

test('clearActivity drops finished records only: a running record keeps its transcript and its later end frame still arrives', async (t) => {
  const { runtime } = await boot(t)
  const feed = runtime.parts.activity
  const stream = follow(runtime.service)
  t.after(() => stream.stop())
  assert.deepEqual((await stream.next('the snapshot')).activities, [])

  // One record that is still running, with output already mirrored…
  const running = feed.begin({ kind: 'exec', sessionId: 's_1', subject: 'sleep 30', target: 'sshuser@127.0.0.1' })
  assert.equal((await stream.next('the running begin')).phase, 'begin')
  running.chunk('stdout', 'tick\n')
  assert.equal((await stream.next('the running chunk')).chunk.text, 'tick\n')

  // …and one that has finished.
  const finished = feed.begin({ kind: 'listDir', sessionId: 's_1', subject: '/srv' })
  finished.finish({ status: 'ok', note: '3 entries' })
  assert.equal((await stream.next('the finished begin')).phase, 'begin')
  assert.equal((await stream.next('the finished end')).phase, 'end')

  // The zero-argument unary call (the wire's shape is `{}` / no argument at all).
  assert.deepEqual(await runtime.service.clearActivity(), { cleared: 1 })
  const reset = await stream.next('the reset frame')
  assert.equal(reset.t, 'activity-reset', 'an attached subscriber is told the history it holds is stale')
  assert.deepEqual(
    feed.snapshot().map((record) => record.id),
    [running.id],
    'the finished record is gone and the running one stays',
  )

  // A clear that removes nothing announces nothing (a reset frame would drop the
  // client's view of the still-running record for no reason).
  assert.deepEqual(await runtime.service.clearActivity(), { cleared: 0 })
  assert.deepEqual(await runtime.service.clearActivity('{}'), { cleared: 0 }, 'the wire payload is ignored: clearActivity takes no parameter')
  const probe = feed.begin({ kind: 'sessions', subject: 'after the no-op clear' })
  const afterNoOp = await stream.next('the frame after the no-op clear')
  assert.equal(afterNoOp.t, 'activity', 'a no-op clear emits no activity-reset')
  assert.equal(afterNoOp.phase, 'begin')
  assert.equal(afterNoOp.activity.subject, 'after the no-op clear')
  probe.finish({ status: 'ok' })
  assert.equal((await stream.next('the probe end frame')).activity.id, probe.id)

  // The still-running record's own end frame is not lost by the reset, and it still
  // carries everything the chunks delivered before the clear.
  running.finish({ status: 'ok', exitCode: 0, note: 'exit 0' })
  const end = await stream.next('the running record end frame')
  assert.equal(end.phase, 'end')
  assert.equal(end.activity.id, running.id)
  assert.equal(end.activity.status, 'ok')
  assert.equal(end.activity.exitCode, 0)
  assert.equal(transcriptOf(end.activity), 'tick\n', 'the transcript survived clearActivity')
  assert.equal(feed.snapshot().find((record) => record.id === running.id).status, 'ok')
})
