/**
 * `ssh_exec` — the model-facing tool.
 *
 * The tool is the only part of this layer a model actually sees, so these tests
 * cover the four things that decide whether it is usable: the argument surface,
 * the canonical result envelope (validated against the tool's OWN declared
 * `output.schema`), the model-facing text, and the Web UI card.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

import { ExecService } from '../../lib/exec/service.js'
import { SshError } from '../../lib/protocol.js'
import { SSH_EXEC_TOOL_NAME, sshExecTool } from '../../lib/tools/exec.js'
import { FakeSession, ManualTimers, flush, withTimeout } from './exec-fakes.test.mjs'

const LIMITS = { maxOutputBytes: 4096, operationTimeoutMs: 5_000, graceKillMs: 100 }

/** Build the tool over a fake session, with a manual clock. */
function harness(options = {}) {
  const timers = new ManualTimers(1_000)
  const session = options.session ?? new FakeSession()
  const recorded = []
  // By default the fake session is the active one, as it would be in a
  // single-host deployment; `defaultSessionId: null` disables that.
  const defaultSessionId =
    options.defaultSessionId === undefined ? () => session.id : (options.defaultSessionId ?? undefined)
  const service = new ExecService({
    resolveSession: (id) => (id === session.id ? session : undefined),
    listSessions: () =>
      options.listSessions?.() ?? [session].map((item) => ({ id: item.id, host: item.info.host, user: item.info.user, state: item.state })),
    ...(defaultSessionId !== undefined ? { defaultSessionId } : {}),
    limits: { ...LIMITS, ...(options.limits ?? {}) },
    timers,
    now: () => timers.now,
    settleMs: options.settleMs ?? 100,
  })
  const tool = sshExecTool({ exec: service, onResult: (event) => recorded.push(event) })
  return { tool, service, session, timers, recorded }
}

/** The execution context the registry hands a tool body; only `signal` is read. */
function context(overrides = {}) {
  const controller = new AbortController()
  return {
    signal: controller.signal,
    controller,
    callId: 'call_1',
    rootCallId: 'call_1',
    name: SSH_EXEC_TOOL_NAME,
    arguments: {},
    deferContext() {},
    concludeTurn() {},
    ...overrides,
  }
}

/** Run one command to completion with output and exit code. */
async function completes(harnessed, args, { stdout = 'ok\n', stderr = '', code = 0 } = {}) {
  const promise = harnessed.tool.execute(args, context())
  await flush()
  if (stdout.length > 0) harnessed.session.handle.emit('stdout', stdout)
  if (stderr.length > 0) harnessed.session.handle.emit('stderr', stderr)
  harnessed.session.handle.exit({ code, durationMs: 12, timedOut: false })
  return withTimeout(promise, 1000, 'tool call')
}

// ── tool surface ────────────────────────────────────────────────────────────

test('the tool is named ssh_exec and declares a supported parameter schema', () => {
  const { tool } = harness()
  assert.equal(tool.name, 'ssh_exec')
  assert.equal(SSH_EXEC_TOOL_NAME, 'ssh_exec')
  assert.match(tool.description, /ssh|host/i)
  assert.match(tool.description, /sessionId/)
  assert.match(tool.description, /pty/)
  assert.doesNotThrow(() => assertSupportedJsonSchema(tool.parameters))

  const parameters = tool.parameters
  assert.equal(parameters.type, 'object')
  assert.equal(parameters.additionalProperties, true, 'unknown keys are an argument error, not a schema violation')
  const properties = parameters.properties
  for (const key of ['command', 'sessionId', 'cwd', 'env', 'stdin', 'timeoutMs', 'maxOutputBytes', 'pty', 'cols', 'rows', 'label']) {
    assert.ok(properties[key] !== undefined, `${key} is part of the argument surface`)
  }
  assert.equal(properties.command.type, 'string')
  assert.equal(properties.timeoutMs.type, 'integer')
  assert.equal(properties.pty.type, 'boolean')
  assert.equal(properties.env.type, 'object')
})

test("the result envelope validates against the tool's own output schema", async () => {
  const harnessed = harness()
  const envelope = await completes(harnessed, { command: 'uname -a' })
  assert.doesNotThrow(() => assertSupportedJsonSchema(harnessed.tool.output.schema))
  assert.deepEqual(validateJsonSchemaValue(harnessed.tool.output.schema, envelope), [])
  // An invalid variant must actually be rejected by the same schema checker.
  assert.notDeepEqual(validateJsonSchemaValue(harnessed.tool.output.schema, { ok: 'yes' }), [])
})

test('a refusal envelope also validates against the output schema', async () => {
  const harnessed = harness()
  const envelope = await harnessed.tool.execute({ command: 'ls', sessionId: 's_missing' }, context())
  assert.equal(envelope.ok, false)
  assert.equal(envelope.outcome, 'refused')
  assert.deepEqual(validateJsonSchemaValue(harnessed.tool.output.schema, envelope), [])
})

// ── canonical value ─────────────────────────────────────────────────────────

test('a successful command returns output, exit code and duration', async () => {
  const harnessed = harness()
  const envelope = await completes(harnessed, { command: 'uname -a' }, { stdout: 'Linux host\n', stderr: 'warn\n' })
  assert.equal(envelope.ok, true)
  assert.equal(envelope.outcome, 'success')
  assert.equal(envelope.sessionId, 's_test')
  assert.equal(envelope.command, 'uname -a')
  assert.equal(envelope.exitCode, 0)
  assert.equal(envelope.durationMs, 12)
  assert.equal(envelope.timedOut, false)
  assert.equal(envelope.stdout, 'Linux host\n')
  assert.equal(envelope.stderr, 'warn\n')
  assert.equal(envelope.stdoutTruncated, false)
  assert.equal(envelope.stderrTruncated, false)
  assert.deepEqual(envelope.bytes, { stdout: 11, stderr: 5 })
  assert.match(envelope.streamId, /^st_/)
  assert.equal(envelope.code, null)
  assert.equal(envelope.message, null)
  assert.match(envelope.notes.join('\n'), /host: s_test \(tester@example\.test\)/)
  // The value must survive the registry's lossless-JSON snapshot unchanged.
  assert.deepEqual(JSON.parse(JSON.stringify(envelope)), envelope)
})

test('a non-zero exit code is reported, not treated as a tool failure', async () => {
  const harnessed = harness()
  const envelope = await completes(harnessed, { command: 'grep x /nope' }, { stdout: '', stderr: 'no file\n', code: 2 })
  assert.equal(envelope.ok, true)
  assert.equal(envelope.outcome, 'success')
  assert.equal(envelope.exitCode, 2)
})

test('truncated output is reported as output-limit and stays ok', async () => {
  const harnessed = harness({ limits: { maxOutputBytes: 100 } })
  const promise = harnessed.tool.execute({ command: 'yes' }, context())
  await flush()
  for (let index = 0; index < 10; index += 1) harnessed.session.handle.emit('stdout', String(index).repeat(20))
  harnessed.session.handle.exit({ code: 0, durationMs: 5, timedOut: false })
  const envelope = await withTimeout(promise, 1000, 'tool call')

  assert.equal(envelope.ok, true, 'truncation is reported, not a failure')
  assert.equal(envelope.outcome, 'output-limit')
  assert.equal(envelope.stdoutTruncated, true)
  assert.equal(envelope.code, 'SSH_LIMIT_OUTPUT_TRUNCATED')
  assert.equal(envelope.stdout.length, 100)
  assert.match(envelope.notes.join('\n'), /truncated at maxOutputBytes=100/)
})

test('a timeout is reported with the operation-timeout code', async () => {
  const harnessed = harness()
  const promise = harnessed.tool.execute({ command: 'sleep 999', timeoutMs: 50 }, context())
  await flush()
  await harnessed.timers.advance(50) // SIGTERM
  await harnessed.timers.advance(100) // SIGKILL
  await harnessed.timers.advance(100) // watchdog settle
  const envelope = await withTimeout(promise, 1000, 'tool call')

  assert.equal(envelope.ok, false)
  assert.equal(envelope.outcome, 'timeout')
  assert.equal(envelope.timedOut, true)
  assert.equal(envelope.exitCode, null)
  assert.equal(envelope.code, 'SSH_TIMEOUT_OPERATION')
  assert.match(envelope.notes.join('\n'), /terminated after the 50 ms deadline/)
})

test('an aborted tool call cancels the command', async () => {
  const harnessed = harness()
  const exec = context()
  const promise = harnessed.tool.execute({ command: 'tail -f /var/log/syslog' }, exec)
  await flush()
  exec.controller.abort()
  await harnessed.timers.advance(100) // grace: SIGKILL
  harnessed.session.handle.exit({ code: null, signal: 'TERM', durationMs: 3, timedOut: false })
  const envelope = await withTimeout(promise, 1000, 'tool call')
  assert.equal(envelope.outcome, 'cancelled')
  assert.equal(harnessed.session.handle.cancelled, 1)
})

test('a binary capture is flagged instead of pretending to be text', async () => {
  const harnessed = harness()
  const promise = harnessed.tool.execute({ command: 'cat /bin/ls' }, context())
  await flush()
  harnessed.session.handle.emit('stdout', Buffer.from([0x00, 0xff, 0xfe]))
  harnessed.session.handle.exit({ code: 0, durationMs: 1, timedOut: false })
  const envelope = await withTimeout(promise, 1000, 'tool call')
  assert.equal(envelope.binary.stdout, true)
  assert.match(envelope.notes.join('\n'), /not valid UTF-8/)
})

test('the audit hook receives one event per finished call', async () => {
  const harnessed = harness()
  await completes(harnessed, { command: 'id' }, { code: 0 })
  assert.equal(harnessed.recorded.length, 1)
  assert.deepEqual(harnessed.recorded[0], {
    sessionId: 's_test',
    command: 'id',
    outcome: 'success',
    exitCode: 0,
    durationMs: 12,
    streamId: harnessed.recorded[0].streamId,
    truncated: false,
  })
})

test('a throwing audit hook cannot fail the call', async () => {
  const harnessed = harness()
  const tool = sshExecTool({
    exec: harnessed.service,
    onResult: () => {
      throw new Error('audit unavailable')
    },
  })
  const promise = tool.execute({ command: 'id' }, context())
  await flush()
  harnessed.session.handle.exit({ code: 0, durationMs: 1, timedOut: false })
  assert.equal((await withTimeout(promise, 1000, 'tool call')).ok, true)
})

// ── session resolution ──────────────────────────────────────────────────────

test('the active session is used when the model omits sessionId', async () => {
  const harnessed = harness()
  const envelope = await completes(harnessed, { command: 'uptime' })
  assert.equal(envelope.sessionId, 's_test')
})

test('an omitted sessionId with no active session is refused with the session list', async () => {
  const harnessed = harness({ defaultSessionId: null })
  const envelope = await harnessed.tool.execute({ command: 'uptime' }, context())
  assert.equal(envelope.ok, false)
  assert.equal(envelope.outcome, 'refused')
  assert.equal(envelope.code, 'SSH_CFG_INVALID')
  assert.match(envelope.message, /sessionId is required/)
  assert.match(envelope.notes.join('\n'), /available sessions: s_test/)
})

test('no connected session at all is refused with an actionable message', async () => {
  const harnessed = harness({ defaultSessionId: null, listSessions: () => [] })
  const envelope = await harnessed.tool.execute({ command: 'uptime' }, context())
  assert.equal(envelope.code, 'SSH_CFG_INVALID')
  assert.match(envelope.message, /no SSH session is available/)
  assert.match(envelope.notes.join('\n'), /no connected session/)
})

test('an unknown sessionId is refused without running anything', async () => {
  const harnessed = harness()
  const envelope = await harnessed.tool.execute({ command: 'uptime', sessionId: 's_nope' }, context())
  assert.equal(envelope.code, 'SSH_STATE_INVALID')
  assert.equal(harnessed.session.execRequests.length, 0)
})

test('a command that fails to start is refused with its own code', async () => {
  const session = new FakeSession({ execError: new SshError('SSH_NET_RESET', 'connection reset') })
  const harnessed = harness({ session })
  const envelope = await harnessed.tool.execute({ command: 'uptime' }, context())
  assert.equal(envelope.outcome, 'refused')
  assert.equal(envelope.code, 'SSH_NET_RESET')
  assert.equal(envelope.ok, false)
})

// ── argument validation ─────────────────────────────────────────────────────

test('invalid arguments are refused with a message naming each problem', async () => {
  const harnessed = harness()
  const envelope = await harnessed.tool.execute(
    { command: 'ls', timeoutMs: 1.5, maxOutputBytes: 10, cols: 80, nope: true },
    context(),
  )
  assert.equal(envelope.ok, false)
  assert.equal(envelope.code, 'SSH_CFG_INVALID')
  assert.match(envelope.message, /"timeoutMs" must be an integer/)
  assert.match(envelope.message, /"maxOutputBytes" must be >= 64/)
  assert.match(envelope.message, /"cols"\/"rows" require "pty": true/)
  assert.match(envelope.message, /unknown argument "nope"/)
  assert.equal(harnessed.session.execRequests.length, 0)
})

test('a missing or empty command is refused', async () => {
  const harnessed = harness()
  for (const args of [{}, { command: '' }, { command: '   ' }, { command: 42 }]) {
    const envelope = await harnessed.tool.execute(args, context())
    assert.equal(envelope.ok, false)
    assert.equal(envelope.code, 'SSH_CFG_INVALID')
  }
})

test('non-object arguments, bad env maps and bad types are refused', async () => {
  const harnessed = harness()
  for (const args of [null, 'ls', ['ls'], { command: 'ls', env: { A: 1 } }, { command: 'ls', pty: 'yes' }, { command: 'ls', cwd: 5 }]) {
    const envelope = await harnessed.tool.execute(args, context())
    assert.equal(envelope.ok, false, `${JSON.stringify(args)} must be refused`)
    assert.equal(envelope.code, 'SSH_CFG_INVALID')
  }
})

// ── pty + stdin ─────────────────────────────────────────────────────────────

test('pty, cols/rows and stdin are forwarded to the channel', async () => {
  const harnessed = harness()
  const promise = harnessed.tool.execute(
    { command: 'cat', pty: true, cols: 100, rows: 30, stdin: 'hello\n', cwd: '/srv', env: { LANG: 'C' } },
    context(),
  )
  await flush()
  assert.equal(harnessed.session.execRequests[0].pty, true)
  assert.equal(harnessed.session.execRequests[0].cols, 100)
  assert.equal(harnessed.session.execRequests[0].rows, 30)
  assert.equal(harnessed.session.execRequests[0].cwd, '/srv')
  assert.deepEqual(harnessed.session.execRequests[0].env, { LANG: 'C' })
  assert.deepEqual(harnessed.session.handle.writes, ['hello\n'])
  assert.equal(harnessed.session.handle.endedInput, 1)

  harnessed.session.handle.emit('stdout', 'hello\n')
  harnessed.session.handle.exit({ code: 0, durationMs: 2, timedOut: false })
  const envelope = await withTimeout(promise, 1000, 'tool call')
  assert.equal(envelope.stdout, 'hello\n', 'PTY output lands in stdout')
  assert.match(envelope.notes.join('\n'), /ran on a PTY/)
  assert.match(envelope.notes.join('\n'), /no explicit end-of-input|end-of-input/)
})

test('the output budget and timeout reach the request', async () => {
  const harnessed = harness()
  const promise = harnessed.tool.execute({ command: 'ls', timeoutMs: 77, maxOutputBytes: 512 }, context())
  await flush()
  assert.equal(harnessed.session.execRequests[0].timeoutMs, 77)
  assert.equal(harnessed.session.execRequests[0].maxOutputBytes, 512)
  harnessed.session.handle.exit({ code: 0, durationMs: 1, timedOut: false })
  await promise
})

// ── presentation ────────────────────────────────────────────────────────────

test('render puts the status, the command and the output first', async () => {
  const harnessed = harness()
  const args = { command: 'uname -a', cwd: '/srv', label: 'kernel' }
  const envelope = await completes(harnessed, args, { stdout: 'Linux host\n' })
  const blocks = harnessed.tool.output.render(args, envelope)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  const text = blocks[0].text
  assert.match(text, /^ssh: ok \(success\) — exit=0 · 12 ms · s_test/)
  assert.match(text, /label: kernel/)
  assert.match(text, /command: uname -a/)
  assert.match(text, /cwd: \/srv/)
  assert.match(text, /--- stdout ---\nLinux host/)
  assert.equal(text.includes('--- stderr ---'), false, 'an empty channel is not shown')
})

test('render reports a refusal without pretending there was output', async () => {
  const harnessed = harness()
  const envelope = await harnessed.tool.execute({ command: 'ls', sessionId: 's_nope' }, context())
  const text = harnessed.tool.output.render({ command: 'ls' }, envelope)[0].text
  assert.match(text, /^ssh: FAILED \(refused: SSH_STATE_INVALID\)/)
  assert.match(text, /\(no output\)/)
  assert.match(text, /reason: /)
})

test('presentCall and presentResult drive the terminal card', async () => {
  const harnessed = harness()
  const args = { command: 'uname -a', sessionId: 's_test', cwd: '/srv', label: 'kernel' }
  const call = harnessed.tool.presentCall(args)
  assert.equal(call.card, 'terminal')
  assert.equal(call.title, 'ssh s_test · uname -a')
  assert.equal(call.description, 'kernel')
  assert.equal(call.cwd, '/srv')

  const envelope = await completes(harnessed, args, { stdout: 'Linux host\n' })
  const meta = harnessed.tool.output.presentationMeta(args, envelope)
  const result = harnessed.tool.presentResult(args, { content: [], isError: false, meta })
  assert.equal(result.card, 'terminal')
  assert.equal(result.title, 'ssh s_test')
  assert.match(result.output, /^\$ uname -a\nLinux host/)
  assert.equal(result.exitCode, 0)

  // A missing meta degrades to the default card rather than throwing.
  assert.equal(harnessed.tool.presentResult(args, { content: [], isError: false }), undefined)
})

test('presentCall truncates a multi-line command to one short line', () => {
  const { tool } = harness()
  const view = tool.presentCall({ command: `echo ${'x'.repeat(200)}\nrm -rf /` })
  assert.ok(view.title.length < 100)
  assert.equal(view.title.includes('\n'), false)
  assert.equal(view.title.endsWith('…'), true)
})

test('the tool declares a cooperative budget that outlives the command deadline', () => {
  const { tool, service } = harness()
  assert.ok(tool.timeoutMs > service.limits.operationTimeoutMs)
  assert.equal(tool.isConcurrencySafe({}), true)
})
