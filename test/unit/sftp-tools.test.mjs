/**
 * The model-facing tools (`ssh_upload`, `ssh_download`, `ssh_list_dir`).
 *
 * The host validates every tool's declared schemas when the tool is registered
 * and every emitted value against `output.schema` before it reaches the model, so
 * these tests run the same two gates (`assertSupportedJsonSchema` /
 * `assertObjectJsonSchema` / `validateJsonSchemaValue` from `@deepseek-ai/dsh-tools`)
 * rather than trusting the literals by eye. A schema keyword outside the enforced
 * subset, or a value that does not match its own declaration, fails here instead
 * of failing in the user's session.
 *
 * The tools themselves are tested with hand-written doubles: no SSH, no
 * filesystem, so every branch (bad arguments, unknown session, refused transfer,
 * deadline abort, truncated listing) is reachable and instant.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { assertObjectJsonSchema, assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

import { SshError } from '../../lib/protocol.js'
import { holdLoop } from '../support/loop.mjs'
import {
  FILES_TOOL_NAMES,
  fileTools,
  filesToolFactories,
} from '../../lib/tools/files.js'

const SESSION = {
  id: 's_1',
  profileId: 'p_1',
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
  {
    name: 'docs',
    path: '/home/tester/docs',
    type: 'dir',
    size: 0,
    mode: '0755',
    mtime: '2024-01-01T00:00:00.000Z',
    isSymlink: false,
  },
  {
    name: 'notes.txt',
    path: '/home/tester/notes.txt',
    type: 'file',
    size: 12,
    mode: '0644',
    mtime: '2024-01-02T00:00:00.000Z',
    isSymlink: false,
  },
  {
    name: 'shortcut',
    path: '/home/tester/shortcut',
    type: 'symlink',
    size: 9,
    mode: '0777',
    mtime: '2024-01-03T00:00:00.000Z',
    isSymlink: true,
    target: '/home/tester/notes.txt',
  },
]

/** A deps double recording what the tools asked for. */
function depsWith(overrides = {}) {
  const calls = { listDir: [], stat: [], transfer: [] }
  const logs = []
  const deps = {
    log: {
      debug: (message) => logs.push(['debug', message]),
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message]),
      error: (message) => logs.push(['error', message]),
    },
    defaults: { chunkBytes: 262144, maxConcurrentChunks: 4, resume: true, verify: 'size+mtime' },
    getSession: (sessionId) => (sessionId === 's_1' ? SESSION : undefined),
    listDir: async (request) => {
      calls.listDir.push(request)
      return { entries: DIRECTORY, cwd: request.path }
    },
    stat: async (request) => {
      calls.stat.push(request)
      return { ...DIRECTORY[1], path: request.path, exists: true }
    },
    transfer: async (request) => {
      calls.transfer.push(request)
      return {
        opId: 'op_test',
        direction: request.direction,
        localPath: request.localPath,
        remotePath: request.remotePath,
        resumedFrom: 1024,
        transferred: 2048,
        totalBytes: 2048,
        bytesPerSec: 4096,
        durationMs: 500,
        verify: request.verify ?? 'size+mtime',
        sha256: { local: 'aa', remote: 'aa' },
        entries: [
          {
            localPath: request.localPath,
            remotePath: request.remotePath,
            size: 3072,
            resumedFrom: 1024,
            transferred: 2048,
            sha256: 'aa',
          },
        ],
        skipped: [{ path: '/home/tester/link', reason: 'symlink (sftp.followSymlinks is false)' }],
      }
    },
    ...overrides,
  }
  return { deps, calls, logs }
}

function toolByName(tools, name) {
  const tool = tools.find((candidate) => candidate.name === name)
  assert.ok(tool, `tool ${name} must be registered`)
  return tool
}

/** Run the same schema gates the host runs, for one tool. */
function assertSchemaContract(tool, args) {
  assertSupportedJsonSchema(tool.parameters)
  assertObjectJsonSchema(tool.parameters)
  assertObjectJsonSchema(tool.output.schema)
  assert.equal(typeof tool.description, 'string')
  assert.ok(tool.description.length > 40, `${tool.name} needs a real description for the model`)
  assert.equal(args.length, 0)
}

test('the three tools exist with names from the ICD and valid schemas', () => {
  const { deps } = depsWith()
  const tools = fileTools(deps)
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [...FILES_TOOL_NAMES],
  )
  assert.deepEqual(Object.keys(filesToolFactories(deps)).sort(), [...FILES_TOOL_NAMES].sort())
  for (const tool of tools) assertSchemaContract(tool, [])
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['ssh_upload', 'ssh_download', 'ssh_list_dir'],
  )
})

test('ssh_upload maps the outcome into a validated envelope', async () => {
  const { deps, calls } = depsWith()
  const tool = toolByName(fileTools(deps), 'ssh_upload')
  const value = await tool.execute(
    { sessionId: 's_1', localPath: 'C:/tmp/report.txt', remotePath: '/home/tester/report.txt', verify: 'sha256', overwrite: true },
    { signal: new AbortController().signal },
  )

  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value), [], 'the value must satisfy its own output schema')
  assert.equal(value.ok, true)
  assert.equal(value.code, '')
  assert.equal(value.direction, 'upload')
  assert.equal(value.resumedFrom, 1024)
  assert.equal(value.transferred, 2048)
  assert.equal(value.sha256, 'aa')
  assert.equal(value.entries.length, 1)
  assert.equal(value.entries[0].sha256, 'aa')
  assert.equal(value.skipped.length, 1)
  assert.ok(value.notes.some((note) => /skipped/.test(note)))

  const request = calls.transfer[0]
  assert.equal(request.direction, 'upload')
  assert.equal(request.verify, 'sha256')
  assert.equal(request.overwrite, true)
  assert.equal(request.signal.aborted, false, 'the caller signal is forwarded, not replaced')

  const rendered = tool.output.render({}, value)
  assert.equal(rendered.length, 1)
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /ssh_upload ok/)
  assert.match(rendered[0].text, /resumed from: 1\.0 KiB/)
  assert.match(rendered[0].text, /sha256 aa/)
})

test('ssh_download renders a refusal the model can act on', async () => {
  const { deps } = depsWith({
    transfer: async () => {
      throw new SshError('SSH_SFTP_TARGET_EXISTS', 'the destination already exists: /tmp/x', {
        details: { path: '/tmp/x', remoteSize: 10, localSize: 20 },
      })
    },
  })
  const tool = toolByName(fileTools(deps), 'ssh_download')
  const value = await tool.execute(
    { sessionId: 's_1', localPath: 'C:/tmp/x', remotePath: '/home/tester/x' },
    { signal: new AbortController().signal },
  )

  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value), [])
  assert.equal(value.ok, false)
  assert.equal(value.code, 'SSH_SFTP_TARGET_EXISTS')
  assert.equal(value.retryable, false)
  assert.match(value.details, /"remoteSize":10/)
  const text = tool.output.render({}, value)[0].text
  assert.match(text, /ssh_download FAILED/)
  assert.match(text, /code: SSH_SFTP_TARGET_EXISTS/)
})

test('invalid arguments and unknown sessions are refused without calling the transport', async () => {
  const { deps, calls } = depsWith()
  const tool = toolByName(fileTools(deps), 'ssh_upload')
  const signal = new AbortController().signal

  const missing = await tool.execute({ sessionId: 's_1', localPath: 'a' }, { signal })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'SSH_CFG_INVALID')
  assert.match(missing.message, /remotePath/)

  const empty = await tool.execute({ sessionId: 's_1', localPath: '  ', remotePath: '/x' }, { signal })
  assert.equal(empty.code, 'SSH_CFG_INVALID')

  const badChunk = await tool.execute(
    { sessionId: 's_1', localPath: 'a', remotePath: '/x', chunkBytes: 10, concurrency: 0 },
    { signal },
  )
  assert.equal(badChunk.code, 'SSH_CFG_INVALID')
  assert.match(badChunk.message, /chunkBytes/)
  assert.match(badChunk.message, /concurrency/)

  const unknown = await tool.execute({ sessionId: 's_nope', localPath: 'a', remotePath: '/x' }, { signal })
  assert.equal(unknown.code, 'SSH_STATE_INVALID')
  assert.match(unknown.message, /ssh_sessions/)

  assert.equal(calls.transfer.length, 0, 'no transport call may happen for a refused call')
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, unknown), [])
})

test('a transfer deadline aborts with a resumable report', async (t) => {
  holdLoop(t)
  const { deps } = depsWith({
    transfer: async (request) =>
      await new Promise((resolve, reject) => {
        request.signal.addEventListener('abort', () => {
          reject(
            new SshError('SSH_SFTP_TRANSFER_ABORTED', 'aborted', {
              details: { resumedFrom: 4096, resumable: true },
            }),
          )
        })
      }),
  })
  const tool = toolByName(fileTools(deps), 'ssh_upload')
  // The floor is 1 s on purpose: a sub-second deadline on a file transfer is a
  // configuration mistake, and saying so beats starting something impossible.
  const started = Date.now()
  const value = await tool.execute(
    { sessionId: 's_1', localPath: 'a', remotePath: '/x', timeoutMs: 1000 },
    { signal: new AbortController().signal },
  )
  assert.ok(Date.now() - started >= 900, 'the deadline must actually be waited out')
  assert.equal(value.ok, false)
  assert.equal(value.code, 'SSH_SFTP_TRANSFER_ABORTED')
  assert.equal(value.retryable, true)
  assert.match(value.details, /"resumedFrom":4096/)
  assert.ok(value.notes.some((note) => /deadline/.test(note)))
  const text = tool.output.render({}, value)[0].text
  assert.match(text, /resume=true/)
})

test('a deadline below the floor is refused as a configuration error', async () => {
  const { deps, calls } = depsWith()
  const tool = toolByName(fileTools(deps), 'ssh_upload')
  const value = await tool.execute(
    { sessionId: 's_1', localPath: 'a', remotePath: '/x', timeoutMs: 50 },
    { signal: new AbortController().signal },
  )
  assert.equal(value.code, 'SSH_CFG_INVALID')
  assert.match(value.message, /timeoutMs/)
  assert.equal(calls.transfer.length, 0)
})

test('the caller signal cancels a running transfer', async () => {
  const controller = new AbortController()
  const { deps } = depsWith({
    transfer: async (request) =>
      await new Promise((resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(new SshError('SSH_SFTP_TRANSFER_ABORTED', 'aborted')))
      }),
  })
  const tool = toolByName(fileTools(deps), 'ssh_download')
  const pending = tool.execute({ sessionId: 's_1', localPath: 'a', remotePath: '/x' }, { signal: controller.signal })
  controller.abort()
  const value = await pending
  assert.equal(value.code, 'SSH_SFTP_TRANSFER_ABORTED')
  assert.ok(value.notes.some((note) => /caller/.test(note)))
})

test('ssh_list_dir maps entries, honours showHidden and reports truncation', async () => {
  const { deps, calls } = depsWith()
  const tool = toolByName(fileTools(deps), 'ssh_list_dir')

  const value = await tool.execute(
    { sessionId: 's_1', path: '/home/tester', showHidden: true, limit: 2 },
    { signal: new AbortController().signal },
  )
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value), [])
  assert.equal(value.ok, true)
  assert.equal(value.cwd, '/home/tester')
  assert.equal(value.total, 3)
  assert.equal(value.count, 2)
  assert.equal(value.truncated, true)
  assert.deepEqual(
    value.entries.map((entry) => entry.type),
    ['dir', 'file'],
  )
  assert.equal(value.entries[0].mode, '0755')
  assert.equal(calls.listDir[0].showHidden, true)

  const text = tool.output.render({}, value)[0].text
  assert.match(text, /d 0755/)
  assert.match(text, /truncated at 2/)

  // Default limit and hidden handling.
  const one = await tool.execute({ sessionId: 's_1', path: '/' }, { signal: new AbortController().signal })
  assert.equal(one.truncated, false)
  assert.equal(one.count, 3)
})

test('ssh_list_dir renders the symlink target and maps a remote failure', async () => {
  const { deps } = depsWith({ listDir: async () => ({ entries: DIRECTORY, cwd: '/home/tester' }) })
  const tool = toolByName(fileTools(deps), 'ssh_list_dir')
  const value = await tool.execute({ sessionId: 's_1', path: '/home/tester' }, { signal: new AbortController().signal })
  assert.equal(value.entries[2].target, '/home/tester/notes.txt')
  assert.match(tool.output.render({}, value)[0].text, /l 0777/)

  const failing = depsWith({
    listDir: async () => {
      throw new SshError('SSH_SFTP_NO_SUCH_FILE', 'no such file or directory: /gone', { details: { path: '/gone' } })
    },
  })
  const failingTool = toolByName(fileTools(failing.deps), 'ssh_list_dir')
  const refusal = await failingTool.execute({ sessionId: 's_1', path: '/gone' }, { signal: new AbortController().signal })
  assert.equal(refusal.ok, false)
  assert.equal(refusal.code, 'SSH_SFTP_NO_SUCH_FILE')
  assert.deepEqual(validateJsonSchemaValue(failingTool.output.schema, refusal), [])
  assert.match(failingTool.output.render({}, refusal)[0].text, /FAILED/)
})

test('tool metadata matches the contract', () => {
  const { deps } = depsWith()
  const tools = fileTools(deps)
  const upload = tools[0]
  const download = tools[1]
  const list = tools[2]

  assert.equal(upload.isConcurrencySafe({}), false, 'transfers mutate state: never parallel')
  assert.equal(download.isConcurrencySafe({}), false)
  assert.equal(list.isConcurrencySafe({}), true, 'a listing is read-only')
  assert.ok(upload.timeoutMs > 0 && download.timeoutMs > 0)
  assert.equal(list.timeoutMs, undefined, 'a listing needs no deadline')

  assert.equal(upload.presentCall({ localPath: '/a', remotePath: '/b' }).title, 'ssh_upload · /a → /b')
  assert.equal(download.presentCall({ localPath: '/a', remotePath: '/b' }).title, 'ssh_download · /a ← /b')
  assert.equal(list.presentCall({ path: '/tmp' }).title, 'ssh_list_dir · /tmp')
  assert.equal(upload.presentCall({}), undefined, 'a malformed call keeps the generic card')

  // The parameters must describe exactly what the tools accept.
  assert.deepEqual(Object.keys(upload.parameters.properties).sort(), [
    'chunkBytes',
    'concurrency',
    'localPath',
    'overwrite',
    'remotePath',
    'resume',
    'sessionId',
    'timeoutMs',
    'verify',
  ])
  assert.deepEqual(Object.keys(list.parameters.properties).sort(), ['limit', 'path', 'sessionId', 'showHidden'])
  // The config defaults are advertised so the model can predict the behaviour.
  assert.match(upload.description, /chunk 256 KiB/)
  assert.match(upload.description, /concurrency 4/)
})

test('progress is logged at a bounded cadence, never per chunk', async () => {
  const { deps, logs } = depsWith({
    transfer: async (request) => {
      for (let index = 0; index < 50; index++) {
        request.onProgress({ transferred: index * 1024, totalBytes: 50 * 1024, bytesPerSec: 100, phase: 'transfer' })
      }
      request.onProgress({ transferred: 50 * 1024, totalBytes: 50 * 1024, bytesPerSec: 100, phase: 'verify' })
      return {
        opId: 'op_test',
        direction: request.direction,
        localPath: request.localPath,
        remotePath: request.remotePath,
        resumedFrom: 0,
        transferred: 50 * 1024,
        totalBytes: 50 * 1024,
        bytesPerSec: 100,
        durationMs: 1,
        verify: 'none',
        entries: [],
        skipped: [],
      }
    },
  })
  const tool = toolByName(fileTools(deps), 'ssh_upload')
  await tool.execute({ sessionId: 's_1', localPath: 'a', remotePath: '/x' }, { signal: new AbortController().signal })
  const progressLines = logs.filter(([, message]) => /ssh_upload/.test(message))
  assert.ok(progressLines.length <= 2, `progress logging must be throttled, saw ${progressLines.length}`)
})

test('a throwing sink never breaks the tool result', async () => {
  const { deps } = depsWith({
    log: {
      debug: () => {
        throw new Error('logger exploded')
      },
      info: () => {
        throw new Error('logger exploded')
      },
      warn: () => undefined,
      error: () => undefined,
    },
    transfer: async (request) => {
      request.onProgress({ transferred: 1, totalBytes: 2, bytesPerSec: 1, phase: 'transfer' })
      return {
        opId: 'op_test',
        direction: request.direction,
        localPath: request.localPath,
        remotePath: request.remotePath,
        resumedFrom: 0,
        transferred: 2,
        totalBytes: 2,
        bytesPerSec: 1,
        durationMs: 1,
        verify: 'none',
        entries: [],
        skipped: [],
      }
    },
  })
  const tool = toolByName(fileTools(deps), 'ssh_upload')
  const value = await tool.execute({ sessionId: 's_1', localPath: 'a', remotePath: '/x' }, { signal: new AbortController().signal })
  // Whether the throttled log line is reached depends on timing; what matters is
  // that the tool still returns a valid, successful envelope.
  assert.equal(value.ok, true)
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value), [])
})
