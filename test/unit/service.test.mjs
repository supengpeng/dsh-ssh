/**
 * Host service behaviour and the Remote marker contract.
 *
 * The markers are what make `ping` reachable from the browser at all, so they
 * are asserted directly rather than inferred from a successful call: the
 * Gateway discovers Remote methods from `remoteMethods(service)` plus the
 * `typertRemote` binding, and a missing marker fails silently at the wire.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'

import { Config, resolveConfig } from '../../lib/config.js'
import { ERROR_CODES, isRetryable, SshError, toErrorInfo } from '../../lib/protocol.js'
import { SshPluginService } from '../../lib/service.js'

const logger = { debug() {}, info() {}, warn() {}, error() {} }

function makeService() {
  return new SshPluginService({}, resolveConfig(Config({})), logger)
}

test('the service declares its Remote binding under the sshPlugin namespace', () => {
  const service = makeService()
  assert.ok(service.typertRemote, 'typertRemote binding is required for Gateway discovery')
  assert.equal(service.typertRemote.serviceKey, 'sshPlugin')
  assert.equal(service.typertRemote.namespace, 'sshPlugin')
  assert.equal(service.typertRemote.service, service)
  assert.ok(Object.isFrozen(service.typertRemote), 'the binding must be frozen')
})

test('the M0 Remote surface survives, with the stream mode flagged', () => {
  // Deliberately NOT "exactly these four": the service grows endpoints as ICD §4
  // is implemented, and a test that must be edited for every new endpoint is a
  // test that gets weakened. This asserts the M0 invariants; the *complete* §4
  // method table is covered by the ICD-conformance suite (ICD §9 assigns it to
  // test/integration/icd-conformance.test.mjs), which is where "all methods exist"
  // belongs.
  const markers = remoteMethods(makeService())
  const byMethod = new Map(markers.map((m) => [m.method, m]))

  for (const method of ['ping', 'probeStream', 'describe', 'reportSpike']) {
    assert.ok(byMethod.has(method), `M0 endpoint "${method}" must stay registered`)
  }
  assert.equal(byMethod.get('ping').mode, undefined)
  assert.equal(byMethod.get('probeStream').mode, 'stream', 'the stream probe keeps its mode')
  assert.equal(byMethod.get('reportSpike').mode, undefined)
  for (const marker of markers) {
    assert.deepEqual(marker.invocation, { kind: 'direct' }, `${marker.method} must stay a direct invocation`)
  }
  // No method may be declared twice: a duplicate would make the Gateway's
  // resolution order decide which one answers.
  assert.equal(new Set(markers.map((m) => m.method)).size, markers.length)
})

test('ping answers with host facts and echoes the caller payload', async () => {
  const service = makeService()
  const result = await service.ping({ echo: 'hello' })
  assert.equal(result.pong, true)
  assert.equal(result.echo, 'hello')
  assert.equal(result.namespace, 'sshPlugin')
  assert.equal(result.version, '1.0.0')
  assert.equal(result.node, process.version)
  assert.equal(typeof result.handlerMs, 'number')
  assert.ok(!Number.isNaN(Date.parse(result.at)))
})

test('ping tolerates an absent argument', async () => {
  const result = await makeService().ping(undefined)
  assert.equal(result.pong, true)
  assert.equal('echo' in result, false)
})

test('probeStream emits open, ordered data frames and exactly one terminal end', async () => {
  const frames = []
  for await (const frame of makeService().probeStream({ count: 3, intervalMs: 0 })) frames.push(frame)

  assert.equal(frames[0].t, 'open')
  const data = frames.filter((f) => f.t === 'data')
  assert.equal(data.length, 3)
  assert.deepEqual(data.map((f) => f.seq), [0, 1, 2])
  assert.ok(data.every((f) => f.encoding === 'utf8' && f.channel === 'stdout'))
  assert.ok(data.every((f) => typeof f.streamId === 'string' && f.streamId === frames[0].streamId))

  const ends = frames.filter((f) => f.t === 'end')
  assert.equal(ends.length, 1, 'a stream ends exactly once')
  assert.equal(ends[0].reason, 'completed')
  assert.equal(frames.at(-1).t, 'end', 'end is the last frame')
})

test('probeStream can exercise the failure path end-to-end', async () => {
  const frames = []
  for await (const frame of makeService().probeStream({ count: 1, intervalMs: 0, fail: true })) frames.push(frame)
  const end = frames.at(-1)
  assert.equal(end.t, 'end')
  assert.equal(end.reason, 'error')
  assert.equal(end.error.code, 'SSH_UNKNOWN')
})

test('probeStream clamps its frame budget', async () => {
  const frames = []
  for await (const frame of makeService().probeStream({ count: 100000, intervalMs: 0 })) frames.push(frame)
  assert.equal(frames.filter((f) => f.t === 'data').length, 200, 'MAX_PROBE_FRAMES bounds the stream')
})

test('describe reports configuration without any secret material', async () => {
  const described = await makeService().describe()
  const serialised = JSON.stringify(described)
  assert.equal(described.namespace, 'sshPlugin')
  assert.ok(described.config.hostKeyPolicy)
  // The projection must not leak the redaction table or any credential field.
  assert.equal(serialised.includes('redactKeys'), false)
  assert.equal(serialised.includes('password'), false)
  assert.equal(serialised.includes('passphrase'), false)
})

test('every declared error code classifies and only the intended ones retry', () => {
  assert.equal(new Set(ERROR_CODES).size, ERROR_CODES.length, 'codes are unique')
  for (const code of ERROR_CODES) {
    assert.equal(typeof code, 'string')
    assert.ok(code.startsWith('SSH_'), `${code} follows the SSH_ prefix convention`)
  }
  // Spot-check the table: retryable means "may be replayed unchanged".
  assert.equal(isRetryable('SSH_NET_REFUSED'), true)
  assert.equal(isRetryable('SSH_TIMEOUT_CONNECT'), true)
  assert.equal(isRetryable('SSH_AUTH_FAILED'), false)
  assert.equal(isRetryable('SSH_CFG_INVALID'), false)
})

test('SshError derives retryability from the code, never from the call site', () => {
  const retryable = new SshError('SSH_NET_RESET', 'reset by peer').toErrorInfo()
  assert.equal(retryable.retryable, true)
  assert.equal(retryable.code, 'SSH_NET_RESET')

  const fatal = new SshError('SSH_AUTH_FAILED', 'permission denied', { details: { method: 'password' } })
  const info = fatal.toErrorInfo()
  assert.equal(info.retryable, false)
  assert.deepEqual(info.details, { method: 'password' })
  assert.equal('retryAfterMs' in info, false)
})

test('toErrorInfo never leaks a foreign error object into the wire shape', () => {
  const info = toErrorInfo(new Error('boom'))
  assert.deepEqual(info, { code: 'SSH_UNKNOWN', message: 'boom', retryable: false })
  assert.equal(toErrorInfo('plain string').code, 'SSH_UNKNOWN')
})

test('the wire probe is silent unless the plugin entry enables it', async () => {
  // Regression guard for a real measurement mistake: the probe used to record
  // in-process calls too, so unit tests looked exactly like browser evidence.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-probe-'))
  try {
    const config = resolveConfig(Config({ auditFile: join(dir, 'audit.jsonl') }))
    const silent = new SshPluginService({}, config, logger)
    await silent.ping({ echo: 'unit' })
    assert.equal(existsSync(join(dir, 'wire-probe.jsonl')), false, 'disabled by default')

    const recording = new SshPluginService({}, config, logger, { probeWire: true })
    await recording.ping({ echo: 'unit' })
    const file = join(dir, 'wire-probe.jsonl')
    assert.equal(existsSync(file), true, 'enabled explicitly')
    const line = JSON.parse(readFileSync(file, 'utf8').trim())
    assert.equal(line.method, 'ping')
    assert.equal(line.argCount, 1)
    assert.equal(line.args[0].type, 'object')
    assert.equal(line.args[0].raw, '{"echo":"unit"}')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reportSpike records the browser binding next to the plugin log', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-report-'))
  try {
    const config = resolveConfig(Config({ auditFile: join(dir, 'audit.jsonl') }))
    const service = new SshPluginService({}, config, logger)

    const receipt = await service.reportSpike({
      carrier: 'remote-mount',
      ok: true,
      transport: { kind: 'remote-mount', status: 'ready', generation: 2 },
      attempts: [{ id: 'remote-mount', ok: true }],
      serviceShapes: { remote: 'Object{sshPlugin,$mount}' },
      userAgent: 'harness',
    })

    assert.equal(receipt.recorded, true)
    assert.equal(receipt.file, join(dir, 'client-transport.json'))
    const record = JSON.parse(readFileSync(receipt.file, 'utf8'))
    assert.equal(record.carrier, 'remote-mount')
    assert.equal(record.ok, true)
    assert.equal(record.transport.status, 'ready')
    assert.equal(record.serviceShapes.remote, 'Object{sshPlugin,$mount}')
    assert.ok(!Number.isNaN(Date.parse(record.at)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reportSpike tolerates a partial report and an unwritable path', async () => {
  const service = makeService()
  // A minimal report must still be recorded rather than rejected.
  const receipt = await service.reportSpike({ carrier: null, ok: false })
  assert.equal(receipt.recorded, true)
  const record = JSON.parse(readFileSync(receipt.file, 'utf8'))
  assert.equal(record.carrier, null)
  assert.equal(record.ok, false)
  assert.deepEqual(record.attempts, [])

  // An unwritable destination degrades to a warning: the client is already
  // talking to us successfully by the time this is called.
  const broken = new SshPluginService({}, resolveConfig(Config({ auditFile: '\u0000bad/audit.jsonl' })), logger)
  const failed = await broken.reportSpike({ carrier: 'x', ok: true })
  assert.equal(failed.recorded, false)
})
