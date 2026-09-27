/**
 * The agent tools' side of the activity mirror (ICD §4.7).
 *
 * The mirror itself is covered by `activity-feed.test.mjs`; what is covered here is
 * the half that was missing: an `ssh_exec`/`ssh_upload`/… call from the model
 * actually reaching the feed. The 终端 tab used to show an empty interactive shell
 * while the model worked, because the tools recorded nothing — a correct feed with
 * no writers is invisible.
 *
 * Two rules are asserted for every family of tools, because they are what makes it
 * safe to instrument a working call:
 *
 *   1. **The record matches the envelope.** Status, code, session, target and the
 *      byte total are read off the same value the model receives, so the panel can
 *      never claim an outcome the tool did not report.
 *   2. **Recording changes nothing.** A missing feed, a disabled one, a throwing
 *      subscriber, or a feed disposed while the call is in flight must leave the
 *      returned envelope byte-identical.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

import { ActivityFeed } from '../../lib/activity/feed.js'
import { ExecService } from '../../lib/exec/service.js'
import { SshError } from '../../lib/protocol.js'
import { sshExecTool } from '../../lib/tools/exec.js'
import { fileTools } from '../../lib/tools/files.js'
import { sessionTools } from '../../lib/tools/sessions.js'
import { FakeSession, ManualTimers, flush, withTimeout } from './exec-fakes.test.mjs'

// ── helpers ─────────────────────────────────────────────────────────────────

/** A feed on a scripted clock, with a recording subscriber. */
function makeFeed(options = {}) {
  let now = 1_000
  const feed = new ActivityFeed({
    now: () => now,
    logger: { warn() {} },
    ...options,
  })
  const events = []
  feed.subscribe((event) => events.push(event))
  return {
    feed,
    events,
    advance: (delta) => {
      now += delta
    },
  }
}

/** The execution context the registry hands a tool body; only `signal` is read. */
function context(overrides = {}) {
  const controller = new AbortController()
  return {
    signal: controller.signal,
    controller,
    callId: 'call_1',
    deferContext() {},
    concludeTurn() {},
    ...overrides,
  }
}

function toolByName(tools, name) {
  const tool = tools.find((candidate) => candidate.name === name)
  assert.ok(tool, `tool ${name} must exist`)
  return tool
}

// ── ssh_exec ────────────────────────────────────────────────────────────────

/** `ssh_exec` over a fake session and a manual clock, with a feed when asked. */
function execHarness(options = {}) {
  const timers = new ManualTimers(1_000)
  const session = options.session ?? new FakeSession()
  const fallback = options.defaultSessionId === undefined ? () => session.id : options.defaultSessionId
  const service = new ExecService({
    resolveSession: (id) => (id === session.id ? session : undefined),
    listSessions: () =>
      options.listSessions?.() ?? [session].map((item) => ({ id: item.id, host: item.info.host, user: item.info.user, state: item.state })),
    ...(fallback === null ? {} : { defaultSessionId: fallback }),
    limits: { maxOutputBytes: 4096, operationTimeoutMs: 5_000, graceKillMs: 100, ...(options.limits ?? {}) },
    timers,
    now: () => timers.now,
    settleMs: 100,
  })
  const tool = sshExecTool({ exec: service, ...(options.activity === undefined ? {} : { activity: options.activity }) })
  return { tool, service, session, timers }
}

/** Run one command to completion, emitting the given output. */
async function _completes(harnessed, args, { stdout = 'ok\n', stderr = '', code = 0 } = {}) {
  const promise = harnessed.tool.execute(args, context())
  await flush()
  if (stdout.length > 0) harnessed.session.handle.emit('stdout', stdout)
  if (stderr.length > 0) harnessed.session.handle.emit('stderr', stderr)
  harnessed.session.handle.exit({ code, durationMs: 12, timedOut: false })
  return withTimeout(promise, 1000, 'tool call')
}

test('ssh_exec mirrors a running command and finishes with its outcome', async () => {
  const { feed } = makeFeed()
  const harnessed = execHarness({ activity: feed })
  const promise = harnessed.tool.execute({ command: 'tail -f app.log', cwd: '/srv', label: 'watch' }, context())
  await flush()

  // While it runs: one open record carrying what the model asked for. A `running`
  // record is the one the ring never evicts, which is why every exit path closes it.
  const [running] = feed.snapshot()
  assert.equal(feed.size(), 1)
  assert.equal(running.kind, 'exec')
  assert.equal(running.status, 'running')
  assert.equal(running.endedAt, null)
  assert.equal(running.subject, 'tail -f app.log')
  assert.equal(running.sessionId, 's_test')
  assert.equal(running.target, 'tester@example.test')
  assert.equal(running.cwd, '/srv')
  assert.equal(running.label, 'watch')

  harnessed.session.handle.emit('stdout', 'line 1\n')
  harnessed.session.handle.emit('stdout', 'line 2\n')
  harnessed.session.handle.emit('stderr', 'warn\n')
  await flush()
  // Live output, not a re-read of the capture: nothing has finished yet, and the
  // repeated channel has already merged into one segment.
  assert.deepEqual(feed.snapshot()[0].segments, [
    { channel: 'stdout', text: 'line 1\nline 2\n' },
    { channel: 'stderr', text: 'warn\n' },
  ])

  harnessed.session.handle.exit({ code: 0, durationMs: 12, timedOut: false })
  const envelope = await withTimeout(promise, 1000, 'tool call')
  const [record] = feed.snapshot()
  assert.equal(record.status, 'ok')
  assert.equal(record.exitCode, 0)
  assert.equal(record.signal, null)
  assert.equal(record.code, null)
  assert.equal(record.truncated, false)
  assert.ok(Number.isFinite(record.durationMs) && record.durationMs >= 0)
  assert.match(record.note, /^exit 0/)
  assert.match(record.note, /host: s_test \(tester@example\.test\)/)
  // The record and the model-visible answer are the same run.
  assert.equal(envelope.stdout, 'line 1\nline 2\n')
  assert.equal(envelope.stderr, 'warn\n')
})

test('ssh_exec folds a PTY frame into stdout', async () => {
  const { feed } = makeFeed()
  const harnessed = execHarness({ activity: feed })
  const promise = harnessed.tool.execute({ command: 'top', pty: true, cols: 100, rows: 30 }, context())
  await flush()
  // A PTY has no stderr, so the exec layer frames its bytes as `term`; the mirror
  // folds that into stdout, which is where the tool result puts it too.
  harnessed.session.handle.emit('stdout', 'merged\n')
  await flush()
  assert.deepEqual(feed.snapshot()[0].segments, [{ channel: 'stdout', text: 'merged\n' }])

  harnessed.session.handle.exit({ code: 0, durationMs: 3, timedOut: false })
  const envelope = await withTimeout(promise, 1000, 'tool call')
  assert.equal(envelope.stdout, 'merged\n', 'the tool result is unchanged by the mirror')
})

test('ssh_exec records a refusal instead of hiding it', async () => {
  const { feed } = makeFeed()
  const harnessed = execHarness({ activity: feed })
  await harnessed.tool.execute({ command: 'ls', timeoutMs: 1.5, nope: true }, context())
  await harnessed.tool.execute({ command: 'uptime', sessionId: 's_nope' }, context())

  const [invalid, unknown] = feed.snapshot()
  assert.equal(invalid.status, 'refused')
  assert.equal(invalid.code, 'SSH_CFG_INVALID')
  assert.equal(invalid.subject, 'ls')
  assert.equal(invalid.sessionId, null)
  assert.match(invalid.note, /"timeoutMs" must be an integer/)
  assert.equal(invalid.endedAt !== null, true, 'a refusal is a complete record, not an open one')

  assert.equal(unknown.status, 'refused')
  assert.equal(unknown.code, 'SSH_STATE_INVALID')
  assert.equal(unknown.subject, 'uptime')
  assert.equal(unknown.sessionId, 's_nope')
  assert.match(unknown.note, /unknown session s_nope/)
  assert.match(unknown.note, /host: s_nope/, 'the notes the envelope carries reach the record too')
  assert.equal(feed.size(), 2, 'the failed attempts are what a result-only view never showed')

  // An omitted sessionId with no active session: this one is refused before the
  // service is touched, and the record carries the way out, not just the failure.
  const unaddressed = makeFeed()
  const fallback = execHarness({ activity: unaddressed.feed, defaultSessionId: null })
  await fallback.tool.execute({ command: 'uptime' }, context())
  const [noSession] = unaddressed.feed.snapshot()
  assert.equal(noSession.status, 'refused')
  assert.equal(noSession.code, 'SSH_CFG_INVALID')
  assert.equal(noSession.sessionId, null)
  assert.match(noSession.note, /sessionId is required/)
  assert.match(noSession.note, /available sessions: s_test/)
})

test('ssh_exec mirrors a timeout, a cancellation and a truncated capture', async () => {
  const timedOut = makeFeed()
  const first = execHarness({ activity: timedOut.feed })
  const running = first.tool.execute({ command: 'sleep 999', timeoutMs: 50 }, context())
  await flush()
  await first.timers.advance(50) // SIGTERM
  await first.timers.advance(100) // SIGKILL
  await first.timers.advance(100) // watchdog settle
  await withTimeout(running, 1000, 'tool call')
  const [timeoutRecord] = timedOut.feed.snapshot()
  assert.equal(timeoutRecord.status, 'timeout')
  assert.equal(timeoutRecord.exitCode, null)
  assert.equal(timeoutRecord.code, 'SSH_TIMEOUT_OPERATION')
  assert.match(timeoutRecord.note, /deadline/)

  const cancelled = makeFeed()
  const second = execHarness({ activity: cancelled.feed })
  const exec = context()
  const pending = second.tool.execute({ command: 'tail -f /var/log/syslog' }, exec)
  await flush()
  exec.controller.abort()
  await second.timers.advance(100) // grace: SIGKILL
  second.session.handle.exit({ code: null, signal: 'TERM', durationMs: 3, timedOut: false })
  await withTimeout(pending, 1000, 'tool call')
  const [cancelRecord] = cancelled.feed.snapshot()
  assert.equal(cancelRecord.status, 'cancelled')
  assert.equal(cancelRecord.signal, 'TERM')

  const limited = makeFeed()
  const third = execHarness({ activity: limited.feed, limits: { maxOutputBytes: 100 } })
  const capped = third.tool.execute({ command: 'yes' }, context())
  await flush()
  for (let index = 0; index < 10; index += 1) third.session.handle.emit('stdout', String(index).repeat(20))
  third.session.handle.exit({ code: 0, durationMs: 5, timedOut: false })
  await withTimeout(capped, 1000, 'tool call')
  const [limitRecord] = limited.feed.snapshot()
  assert.equal(limitRecord.status, 'ok', 'a head+tail capture is reported, not failed')
  assert.equal(limitRecord.truncated, true, 'the flag is what stops a short transcript being read as a quiet command')
  assert.match(limitRecord.note, /truncated at maxOutputBytes=100/)
})

// ── the mirror changes nothing ──────────────────────────────────────────────

test('a disabled, throwing or disposed feed leaves the ssh_exec envelope identical', async () => {
  // Every run gets its own service, and a service mints a fresh stream id per start:
  // the id is the one field that legitimately differs between two runs, so it is
  // compared by shape instead of by value.
  const comparable = ({ streamId, ...rest }) => {
    assert.match(streamId, /^st_/)
    return rest
  }
  const run = async (prepare) => {
    const prepared = prepare === undefined ? {} : prepare()
    const harnessed = execHarness(prepared.activity === undefined ? {} : { activity: prepared.activity })
    const promise = harnessed.tool.execute({ command: 'uname -a', label: 'kernel' }, context())
    await flush()
    if (prepared.dispose !== undefined) prepared.dispose()
    harnessed.session.handle.emit('stdout', 'Linux host\n')
    harnessed.session.handle.emit('stderr', 'warn\n')
    harnessed.session.handle.exit({ code: 0, durationMs: 12, timedOut: false })
    return comparable(await withTimeout(promise, 1000, 'tool call'))
  }

  const healthy = await run(() => makeFeed())
  const unrecorded = await run(() => ({}))
  assert.deepEqual(unrecorded, healthy, 'no feed at all must behave exactly as before')

  const disabled = await run(() => ({ activity: new ActivityFeed({ enabled: false }) }))
  assert.deepEqual(disabled, healthy)

  const throwing = await run(() => {
    const feed = new ActivityFeed({ logger: { warn() {} } })
    feed.subscribe(() => {
      throw new Error('pane exploded')
    })
    return { activity: feed }
  })
  assert.deepEqual(throwing, healthy, 'a broken panel must not reach the tool result')

  const midCall = makeFeed()
  const disposed = await run(() => ({ activity: midCall.feed, dispose: () => midCall.feed.dispose() }))
  assert.deepEqual(disposed, healthy, 'disposing the feed mid-call must not reach the tool result')
  assert.equal(midCall.feed.size(), 0)
  assert.deepEqual(midCall.feed.snapshot(), [])
})

// ── ssh_upload / ssh_download / ssh_list_dir ────────────────────────────────

const SESSION = {
  id: 's_1',
  label: 'test',
  host: 'example.test',
  port: 22,
  user: 'tester',
  state: 'connected',
  since: new Date(0).toISOString(),
  metrics: { bytesIn: 0, bytesOut: 0 },
  capabilities: { shell: true, sftp: true },
}

const DIRECTORY = [
  { name: 'docs', path: '/home/tester/docs', type: 'dir', size: 0, mode: '0755', mtime: '2024-01-01T00:00:00.000Z', isSymlink: false },
  { name: 'notes.txt', path: '/home/tester/notes.txt', type: 'file', size: 12, mode: '0644', mtime: '2024-01-02T00:00:00.000Z', isSymlink: false },
  { name: 'shortcut', path: '/home/tester/shortcut', type: 'symlink', size: 9, mode: '0777', mtime: '2024-01-03T00:00:00.000Z', isSymlink: true, target: '/home/tester/notes.txt' },
]

function transferOutcome(request, extra = {}) {
  return {
    opId: 'op_1',
    direction: request.direction,
    localPath: request.localPath,
    remotePath: request.remotePath,
    resumedFrom: 0,
    transferred: 2048,
    totalBytes: 2048,
    bytesPerSec: 4096,
    durationMs: 500,
    verify: 'size+mtime',
    entries: [],
    skipped: [],
    ...extra,
  }
}

/** Minimal files-tool deps double: no SSH, no filesystem. */
function filesDeps(overrides = {}) {
  return {
    getSession: (sessionId) => (sessionId === SESSION.id ? SESSION : undefined),
    listDir: async (request) => ({ entries: DIRECTORY, cwd: request.path }),
    stat: async () => {
      throw new Error('not used')
    },
    transfer: async (request) => transferOutcome(request),
    ...overrides,
  }
}

const SIGNAL = () => ({ signal: new AbortController().signal })

test('ssh_upload mirrors progress lines and finishes with the byte total', async () => {
  const { feed } = makeFeed()
  const deps = filesDeps({
    activity: feed,
    transfer: async (request) => {
      request.onProgress({ transferred: 0, totalBytes: 2048, bytesPerSec: 0, phase: 'scan' })
      request.onProgress({ transferred: 1024, totalBytes: 2048, bytesPerSec: 1000, phase: 'transfer' })
      request.onProgress({ transferred: 2048, totalBytes: 2048, bytesPerSec: 1000, phase: 'verify' })
      return transferOutcome(request)
    },
  })
  const tool = toolByName(fileTools(deps), 'ssh_upload')
  const value = await tool.execute(
    { sessionId: SESSION.id, localPath: 'C:/tmp/a.txt', remotePath: '/home/tester/a.txt' },
    SIGNAL(),
  )
  assert.equal(value.ok, true)

  const [record] = feed.snapshot()
  assert.equal(record.kind, 'upload')
  assert.equal(record.status, 'ok')
  assert.equal(record.sessionId, 's_1')
  assert.equal(record.target, 'tester@example.test')
  assert.equal(record.subject, 'C:/tmp/a.txt → /home/tester/a.txt')
  assert.match(record.note, /transferred 2048 of 2048 bytes in 500 ms \(verify size\+mtime\)/)
  // One streamed line for three progress events: the mirror speaks at the log's
  // bounded cadence, so a chatty transfer cannot fill the ring with one line per chunk.
  assert.deepEqual(record.segments, [
    { channel: 'info', text: 'ssh_upload 0% (0 B/2.0 KiB, scan, n/a)\n' },
    { channel: 'info', text: 'upload 2.0 KiB in 0.5s (4.0 KiB/s) · verify size+mtime' },
  ])
})

test('a failed or refused transfer is recorded with its code', async () => {
  const { feed } = makeFeed()
  const deps = filesDeps({
    activity: feed,
    transfer: async () => {
      throw new SshError('SSH_SFTP_TARGET_EXISTS', 'the destination already exists: /home/tester/x')
    },
  })
  const tool = toolByName(fileTools(deps), 'ssh_download')
  await tool.execute({ sessionId: SESSION.id, localPath: 'C:/tmp/x', remotePath: '/home/tester/x' }, SIGNAL())
  await tool.execute({ sessionId: 's_nope', localPath: 'C:/tmp/x', remotePath: '/home/tester/x' }, SIGNAL())

  const [failed, refused] = feed.snapshot()
  assert.equal(failed.kind, 'download')
  assert.equal(failed.status, 'error')
  assert.equal(failed.code, 'SSH_SFTP_TARGET_EXISTS')
  assert.match(failed.note, /already exists/)
  assert.equal(failed.segments.at(-1).text, 'SSH_SFTP_TARGET_EXISTS: the destination already exists: /home/tester/x')

  assert.equal(refused.status, 'refused', 'a call that never reached the transport says so')
  assert.equal(refused.code, 'SSH_STATE_INVALID')
  assert.equal(refused.subject, 'C:/tmp/x ← /home/tester/x')
})

test('ssh_list_dir records one summary record', async () => {
  const { feed } = makeFeed()
  const deps = filesDeps({ activity: feed, listDir: async (request) => ({ entries: DIRECTORY, cwd: request.path }) })
  const tool = toolByName(fileTools(deps), 'ssh_list_dir')
  const value = await tool.execute({ sessionId: SESSION.id, path: '/home/tester', limit: 2 }, SIGNAL())
  assert.equal(value.count, 2)
  assert.equal(value.truncated, true)

  const [record] = feed.snapshot()
  assert.equal(record.kind, 'listDir')
  assert.equal(record.status, 'ok')
  assert.equal(record.subject, '/home/tester')
  assert.equal(record.cwd, '/home/tester')
  assert.equal(record.note, '2 of 3 entries in /home/tester')
  assert.equal(record.segments.length, 1, 'a listing is one final line, not a stream')
  assert.equal(record.truncated, false, 'a limit-cut listing is not a truncated transcript')

  const failing = makeFeed()
  const failingTool = toolByName(
    fileTools(
      filesDeps({
        activity: failing.feed,
        listDir: async () => {
          throw new SshError('SSH_SFTP_NO_SUCH_FILE', 'no such file or directory: /gone')
        },
      }),
    ),
    'ssh_list_dir',
  )
  await failingTool.execute({ sessionId: SESSION.id, path: '/gone' }, SIGNAL())
  const [failure] = failing.feed.snapshot()
  assert.equal(failure.status, 'error')
  assert.equal(failure.code, 'SSH_SFTP_NO_SUCH_FILE')
  assert.equal(failure.note, 'no such file or directory: /gone')
})

test('a throwing subscriber cannot change a transfer result', async () => {
  const run = async (deps) => {
    const tool = toolByName(fileTools(deps), 'ssh_upload')
    return tool.execute({ sessionId: SESSION.id, localPath: 'C:/tmp/a.txt', remotePath: '/home/tester/a.txt' }, SIGNAL())
  }
  const plain = await run(filesDeps())
  const feed = new ActivityFeed({ logger: { warn() {} } })
  feed.subscribe(() => {
    throw new Error('pane exploded')
  })
  const deps = filesDeps({
    activity: feed,
    transfer: async (request) => {
      request.onProgress({ transferred: 1, totalBytes: 2, bytesPerSec: 1, phase: 'transfer' })
      return transferOutcome(request)
    },
  })
  assert.deepEqual(await run(deps), plain)
  assert.equal(feed.snapshot()[0].status, 'ok')
})

// ── ssh_connect / ssh_disconnect / ssh_sessions ─────────────────────────────

function sessionInfo(id, overrides = {}) {
  return {
    id,
    label: 'test',
    host: 'example.test',
    port: 22,
    user: 'tester',
    state: 'connected',
    since: new Date(0).toISOString(),
    metrics: { bytesIn: 0, bytesOut: 0 },
    capabilities: { shell: true, sftp: true },
    ...overrides,
  }
}

/** Minimal sessions-tool deps double. */
function sessionsDeps(overrides = {}) {
  return {
    listSessions: () => [],
    connect: async () => ({ session: sessionInfo('s_1') }),
    disconnect: async (sessionId) => ({ session: sessionInfo(sessionId) }),
    hostKeyPolicy: 'accept-new',
    listProfiles: () => [],
    ...overrides,
  }
}

test('ssh_connect records the attempt and its outcome', async () => {
  const { feed } = makeFeed()
  const deps = sessionsDeps({
    activity: feed,
    connect: async () => ({ session: sessionInfo('s_9', { host: 'prod.example', user: 'deploy', port: 2222 }) }),
  })
  const tool = toolByName(sessionTools(deps), 'ssh_connect')
  const value = await tool.execute({ host: 'prod.example', port: 2222, user: 'deploy' }, context())
  assert.equal(value.ok, true)

  const [record] = feed.snapshot()
  assert.equal(record.kind, 'connect')
  assert.equal(record.status, 'ok')
  assert.equal(record.subject, 'deploy@prod.example')
  assert.equal(record.target, 'deploy@prod.example')
  assert.equal(record.note, 'connected s_9 as deploy@prod.example:2222')

  // A refusal explains itself in the record too: the user watching the panel sees the
  // host-key decision, not just "the model tried something".
  const refusedFeed = makeFeed()
  const refused = toolByName(
    sessionTools(
      sessionsDeps({
        activity: refusedFeed.feed,
        connect: async () => {
          throw new SshError('SSH_HOSTKEY_UNKNOWN', 'the host key is not known')
        },
      }),
    ),
    'ssh_connect',
  )
  const refusal = await refused.execute({ host: 'new.example', user: 'root' }, context())
  assert.equal(refusal.ok, false)
  const [hostKey] = refusedFeed.feed.snapshot()
  assert.equal(hostKey.status, 'refused')
  assert.equal(hostKey.code, 'SSH_HOSTKEY_UNKNOWN')
  assert.equal(hostKey.target, 'root@new.example')
  assert.match(hostKey.note, /host key is not known/)
  assert.match(hostKey.note, /known_hosts/, 'the actionable note reaches the record as well')

  // A profile connection names the host it targeted, which only the profile knows.
  const profileFeed = makeFeed()
  const byProfile = toolByName(
    sessionTools(
      sessionsDeps({
        activity: profileFeed.feed,
        listProfiles: () => [{ id: 'p_1', name: 'prod', host: 'saved.example', user: 'root' }],
        connect: async () => ({ session: sessionInfo('s_2', { host: 'saved.example', user: 'root' }) }),
      }),
    ),
    'ssh_connect',
  )
  await byProfile.execute({ profileId: 'p_1' }, context())
  const [record2] = profileFeed.feed.snapshot()
  assert.equal(record2.subject, 'p_1')
  assert.equal(record2.target, 'root@saved.example')
})

test('ssh_disconnect and ssh_sessions record one line each', async () => {
  const { feed } = makeFeed()
  const deps = sessionsDeps({ activity: feed, listSessions: () => [sessionInfo('s_1')] })
  const tools = sessionTools(deps)

  await toolByName(tools, 'ssh_sessions').execute({}, context())
  await toolByName(tools, 'ssh_disconnect').execute({ sessionId: 's_1' }, context())
  await toolByName(tools, 'ssh_disconnect').execute({}, context())

  const [listed, closed, missing] = feed.snapshot()
  assert.equal(listed.kind, 'sessions')
  assert.equal(listed.status, 'ok')
  assert.equal(listed.subject, 'ssh_sessions')
  assert.equal(listed.note, '1 connected: s_1')

  assert.equal(closed.kind, 'disconnect')
  assert.equal(closed.status, 'ok')
  assert.equal(closed.sessionId, 's_1')
  assert.equal(closed.target, 'tester@example.test')
  assert.equal(closed.note, 'closed s_1')

  assert.equal(missing.status, 'refused')
  assert.equal(missing.code, 'SSH_CFG_INVALID')
  assert.match(missing.note, /^sessionId is required/)
  assert.match(missing.note, /s_1: tester@example\.test/, 'the alternatives the model was given reach the record too')
})

// ── the ssh_sessions output-schema defect (regression) ──────────────────────

test('the ssh_sessions schema accepts the real session projection', async () => {
  const deps = sessionsDeps({
    listSessions: () => [
      sessionInfo('s_1'),
      sessionInfo('s_2', { metrics: { bytesIn: 10, bytesOut: 20, rttMs: 12.5 } }),
    ],
  })
  const tool = toolByName(sessionTools(deps), 'ssh_sessions')
  const value = await tool.execute({}, context())
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value), [], 'a real envelope must validate')
  assert.equal(value.sessions.length, 2)

  // The declaration itself is asserted, because an empty envelope would hide the
  // defect: the item node must name the projection and leave `rttMs` optional.
  const items = tool.output.schema.properties.sessions.items
  assert.equal(items.type, 'object')
  assert.equal(items.additionalProperties, false)
  assert.deepEqual(Object.keys(items.properties).sort(), [
    'bytesIn',
    'bytesOut',
    'capabilities',
    'connectedForMs',
    'host',
    'label',
    'port',
    'rttMs',
    'sessionId',
    'since',
    'state',
    'user',
  ])
  assert.deepEqual(items.required, ['sessionId', 'label', 'host', 'port', 'user', 'state', 'since', 'connectedForMs', 'bytesIn', 'bytesOut', 'capabilities'])
  assert.equal(items.required.includes('rttMs'), false, 'a session that has not been measured has no rttMs')

  // The declaration this replaces: `objectNode({})` is a closed empty object node, and
  // the real list failed it with `"value.sessions[0].sessionId" is not a declared property`.
  const closedEmptyItem = {
    type: 'object',
    properties: { ok: { type: 'boolean' }, sessions: { type: 'array', items: { type: 'object', properties: {}, additionalProperties: false } } },
    required: ['ok'],
    additionalProperties: false,
  }
  assert.notDeepEqual(validateJsonSchemaValue(closedEmptyItem, value), [])
})
