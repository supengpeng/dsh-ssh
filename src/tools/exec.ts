/**
 * `ssh_exec` — run one command on a connected remote host.
 *
 * Follows the pattern established by `@local/dsh-python`'s `python_exec`: one
 * canonical result envelope for every outcome (including refusals), an
 * `output.schema` the Host validates the value against, a `render` that puts
 * "did it work / what did it print / what went wrong" on the first lines, and a
 * terminal card for the Web UI.
 *
 * Differences that follow from running on a remote host:
 *
 *   - the call names a `sessionId` (or uses the active session), so the model can
 *     keep several hosts apart;
 *   - a non-zero exit code is a **result**, not a tool error: the model asked to
 *     run a command and the command ran. `ok` reports whether the channel worked;
 *   - a timeout or an output truncation is reported in the envelope (and in the
 *     `truncated` flags) instead of being thrown, because the caller still needs
 *     the captured output.
 */

import type { JsonSchemaNode, ToolCallView, ToolDefinition, ToolResult, ToolResultView } from '@deepseek-ai/dsh-tools'

import { SshError } from '../protocol.js'
import type { ExecRunResult } from '../exec/exec.js'
import {
  arrayNode,
  booleanNode,
  integerNode,
  lines,
  mapNode,
  nullable,
  objectNode,
  parameterRoot,
  stringNode,
  text,
  toLossless,
  type JsonValue,
  type TextBlock,
} from '../exec/schema.js'
import type { ExecService } from '../exec/service.js'

export const SSH_EXEC_TOOL_NAME = 'ssh_exec'

/** The only surface the tool needs from the plugin. */
export interface SshExecToolDeps {
  exec: ExecService
  /** Called once per finished call, for the audit log (SP4 owns the auditor). */
  onResult?: (event: {
    sessionId: string | null
    command: string
    outcome: string
    exitCode: number | null
    durationMs: number
    streamId: string | null
    truncated: boolean
  }) => void
  /** Extra milliseconds the cooperative tool budget allows beyond the command deadline. */
  budgetSlackMs?: number
}

/** Terminal classification of one call. */
export type ExecOutcome = 'success' | 'timeout' | 'cancelled' | 'output-limit' | 'error' | 'refused'

/** The canonical value every `ssh_exec` call returns. */
export interface SshExecEnvelope {
  ok: boolean
  outcome: ExecOutcome
  /** Stable machine-readable code when `ok` is false. */
  code: string | null
  message: string | null
  sessionId: string | null
  streamId: string | null
  command: string
  cwd: string | null
  exitCode: number | null
  signal: string | null
  durationMs: number
  timedOut: boolean
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  bytes: { stdout: number; stderr: number }
  /** True when the captured output contained bytes that are not valid UTF-8. */
  binary: { stdout: boolean; stderr: boolean }
  notes: string[]
  [extra: string]: unknown
}

const DEFAULT_TIMEOUT_TEXT = 'the configured operationTimeoutMs'

export function sshExecTool(deps: SshExecToolDeps): ToolDefinition {
  const limits = deps.exec.limits
  const slack = Math.max(1000, deps.budgetSlackMs ?? 15_000)

  return {
    name: SSH_EXEC_TOOL_NAME,
    description: lines(
      'Run a shell command on a connected SSH host and return its stdout, stderr, exit code,',
      'duration and whether the output was truncated.',
      '',
      `The command runs through the session's non-PTY channel by default; pass \`pty:true\` for a`,
      'command that needs a terminal (it then reads stdin from `stdin`), and `stdin` to feed input.',
      '',
      `A non-zero exit code is reported in \`exitCode\` and is not a failure of the call. A command`,
      `that exceeds \`timeoutMs\` (default ${limits.operationTimeoutMs} ms) is terminated (SIGTERM, then SIGKILL)`,
      `and reported with \`timedOut:true\`. Output above \`maxOutputBytes\` (default ${limits.maxOutputBytes}) is`,
      'kept as head+tail and reported through `stdoutTruncated`/`stderrTruncated`.',
      '',
      'Omit `sessionId` to use the active session; `ssh_sessions` lists the connected hosts.',
    ),
    parameters: parameterRoot({
      command: stringNode('Shell command to run on the remote host.'),
      sessionId: stringNode('Connected session to run on. Omit to use the active session.'),
      cwd: stringNode('Working directory for the command (remote path).'),
      env: mapNode('Extra environment variables for the command.'),
      stdin: stringNode('Text written to the command\'s stdin once the channel is open.'),
      timeoutMs: integerNode(
        `Deadline in milliseconds before SIGTERM (default ${limits.operationTimeoutMs}; 0 disables it).`,
      ),
      maxOutputBytes: integerNode(`Bytes retained before head+tail truncation (default ${limits.maxOutputBytes}).`),
      pty: booleanNode('Run on a pseudo-terminal. Use for commands that check isatty or need terminal semantics.'),
      cols: integerNode('PTY width in columns (with `pty`).'),
      rows: integerNode('PTY height in rows (with `pty`).'),
      label: stringNode('Short label echoed into the result notes and the UI card.'),
    }),
    output: {
      schema: envelopeSchema(),
      render: renderEnvelope,
      presentationMeta: envelopePresentation,
    },
    timeoutMs: limits.operationTimeoutMs + limits.graceKillMs + slack,
    // Remote commands carry no plugin-local mutable state; the session's own
    // concurrency semaphore is what serializes work per host.
    isConcurrencySafe: () => true,

    async execute(rawArgs: unknown, exec): Promise<unknown> {
      const errors: string[] = []
      const args = readArgs(rawArgs, errors)
      const label = args.label

      if (errors.length > 0) {
        return refusal({
          code: 'SSH_CFG_INVALID',
          message: `invalid arguments: ${errors.join('; ')}`,
          command: args.command ?? '',
          cwd: args.cwd ?? null,
          notes: label !== undefined ? [`label: ${label}`] : [],
        })
      }

      let sessionId: string
      try {
        sessionId = deps.exec.resolveTargetSession(args.sessionId)
      } catch (error) {
        const info = toErrorInfoSafe(error)
        return refusal({
          code: info.code,
          message: info.message,
          command: args.command ?? '',
          cwd: args.cwd ?? null,
          notes: sessionNotes(deps, info.details),
        })
      }

      const notes: string[] = []
      if (label !== undefined) notes.push(`label: ${label}`)
      notes.push(`host: ${describeSession(deps, sessionId)}`)

      let result: ExecRunResult
      try {
        result = await deps.exec.execWait(
          {
            sessionId,
            command: args.command ?? '',
            ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
            ...(args.env !== undefined ? { env: args.env } : {}),
            ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
            ...(args.maxOutputBytes !== undefined ? { maxOutputBytes: args.maxOutputBytes } : {}),
          },
          {
            ...(args.stdin !== undefined ? { stdin: args.stdin } : {}),
            signal: exec.signal,
            ...(args.pty === true
              ? {
                  pty: true,
                  ...(args.cols !== undefined ? { cols: args.cols } : {}),
                  ...(args.rows !== undefined ? { rows: args.rows } : {}),
                }
              : {}),
          },
        )
      } catch (error) {
        const info = toErrorInfoSafe(error)
        return refusal({
          code: info.code,
          message: info.message,
          command: args.command ?? '',
          cwd: args.cwd ?? null,
          sessionId,
          notes,
        })
      }

      const truncated = result.truncated.stdout || result.truncated.stderr
      const outcome: ExecOutcome = result.timedOut
        ? 'timeout'
        : result.endReason === 'cancelled'
          ? 'cancelled'
          : result.error !== undefined && result.error.code === 'SSH_LIMIT_OUTPUT_TRUNCATED'
            ? 'output-limit'
            : result.error !== undefined
              ? 'error'
              : 'success'

      if (truncated) {
        notes.push(
          `output truncated at maxOutputBytes=${args.maxOutputBytes ?? limits.maxOutputBytes}: ` +
            `${result.bytes.stdout + result.bytes.stderr} bytes produced, head+tail kept`,
        )
      }
      if (result.binary.stdout || result.binary.stderr) {
        notes.push('output contained bytes that are not valid UTF-8; invalid bytes are shown as U+FFFD')
      }
      if (args.pty === true) notes.push('ran on a PTY (stdout and stderr are merged)')
      if (result.timedOut) {
        notes.push(`terminated after the ${args.timeoutMs ?? limits.operationTimeoutMs} ms deadline`)
      }
      if (args.stdin !== undefined) {
        notes.push('the channel accepts no explicit end-of-input, so a command that waits for EOF may need a deadline')
      }

      const envelope: SshExecEnvelope = toLossless({
        // A non-zero exit code is the command's own result, not a tool failure.
        ok: outcome === 'success' || outcome === 'output-limit',
        outcome,
        code: result.error?.code ?? null,
        message: result.error?.message ?? null,
        sessionId,
        streamId: result.streamId,
        command: args.command ?? '',
        cwd: args.cwd ?? null,
        exitCode: result.exitCode,
        signal: result.signal ?? null,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        stdout: result.stdout,
        stderr: result.stderr,
        stdoutTruncated: result.truncated.stdout,
        stderrTruncated: result.truncated.stderr,
        bytes: { stdout: result.bytes.stdout, stderr: result.bytes.stderr },
        binary: { stdout: result.binary.stdout, stderr: result.binary.stderr },
        notes,
      })

      try {
        deps.onResult?.({
          sessionId,
          command: envelope.command,
          outcome: envelope.outcome,
          exitCode: envelope.exitCode,
          durationMs: envelope.durationMs,
          streamId: envelope.streamId,
          truncated,
        })
      } catch {
        /* auditing must never fail the call */
      }

      return envelope
    },

    presentCall(args: unknown): ToolCallView {
      const view = args as { command?: unknown; cwd?: unknown; sessionId?: unknown; label?: unknown } | null
      const command = typeof view?.command === 'string' ? view.command : 'ssh'
      const description = typeof view?.label === 'string' && view.label.length > 0 ? view.label : undefined
      const title =
        typeof view?.sessionId === 'string' && view.sessionId.length > 0 ? `ssh ${view.sessionId} · ${preview(command)}` : `ssh · ${preview(command)}`
      return {
        card: 'terminal',
        title,
        ...(description !== undefined ? { description } : {}),
        ...(typeof view?.cwd === 'string' ? { cwd: view.cwd } : {}),
      }
    },

    presentResult(_args: unknown, result: ToolResult): ToolResultView | undefined {
      const meta = result.meta
      if (meta === null || typeof meta !== 'object') return undefined
      const view = meta as Record<string, unknown>
      const output = typeof view['output'] === 'string' ? view['output'] : ''
      const exitCode = typeof view['exitCode'] === 'number' ? view['exitCode'] : undefined
      const signal = typeof view['signal'] === 'string' ? view['signal'] : undefined
      return {
        card: 'terminal',
        ...(typeof view['title'] === 'string' ? { title: view['title'] } : {}),
        ...(output.length > 0 ? { output } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(signal !== undefined ? { signal } : {}),
      }
    },
  }
}

/** The canonical value shape, declared for the Host's own validation. */
export function envelopeSchema(): JsonSchemaNode {
  return objectNode(
    {
      ok: booleanNode('True when the command ran and its output was captured (a non-zero exit code is still ok).'),
      outcome: stringNode('Terminal classification of the call.', {
        enum: ['success', 'timeout', 'cancelled', 'output-limit', 'error', 'refused'],
      }),
      code: nullable(stringNode('Stable error code when ok is false.')),
      message: nullable(stringNode('Human-readable reason when ok is false.')),
      sessionId: nullable(stringNode('Session the command ran on.')),
      streamId: nullable(stringNode('Frame stream carrying the command output.')),
      command: stringNode('The command that was requested.'),
      cwd: nullable(stringNode('Working directory used, when one was given.')),
      exitCode: nullable(integerNode('Remote exit code, or null when the command was signalled or never started.')),
      signal: nullable(stringNode('Signal that terminated the command.')),
      durationMs: integerNode('Wall-clock duration of the command.'),
      timedOut: booleanNode('True when the deadline terminated the command.'),
      stdout: stringNode('Captured standard output (head+tail when truncated).'),
      stderr: stringNode('Captured standard error (head+tail when truncated).'),
      stdoutTruncated: booleanNode('True when stdout exceeded the retained byte budget.'),
      stderrTruncated: booleanNode('True when stderr exceeded the retained byte budget.'),
      bytes: objectNode(
        {
          stdout: integerNode('Bytes stdout produced, before truncation.'),
          stderr: integerNode('Bytes stderr produced, before truncation.'),
        },
        ['stdout', 'stderr'],
      ),
      binary: objectNode(
        {
          stdout: booleanNode('stdout contained non-UTF-8 bytes.'),
          stderr: booleanNode('stderr contained non-UTF-8 bytes.'),
        },
        ['stdout', 'stderr'],
      ),
      notes: arrayNode('Diagnostic notes assembled while running.', stringNode('Note.')),
    },
    ['ok', 'outcome', 'sessionId', 'streamId', 'command', 'exitCode', 'durationMs', 'timedOut', 'stdout', 'stderr', 'stdoutTruncated', 'stderrTruncated', 'bytes', 'binary', 'notes'],
  )
}

/**
 * The model-facing rendering: the answer to "did it work, what did it print,
 * what went wrong" is on the first lines, not at the end of a wall of output.
 */
export function renderEnvelope(args: unknown, value: unknown): TextBlock[] {
  const envelope = value as SshExecEnvelope
  const head: string[] = []
  const status = envelope.ok ? `ok (${envelope.outcome})` : `FAILED (${envelope.outcome}${envelope.code ? `: ${envelope.code}` : ''})`
  head.push(
    `ssh: ${status} — exit=${envelope.exitCode ?? 'n/a'}` +
      `${envelope.signal ? ` signal=${envelope.signal}` : ''} · ${envelope.durationMs} ms` +
      `${envelope.sessionId ? ` · ${envelope.sessionId}` : ''}`,
  )
  const label = (args as { label?: unknown } | null)?.label
  if (typeof label === 'string' && label.length > 0) head.push(`label: ${label}`)
  head.push(`command: ${envelope.command}`)
  if (envelope.cwd) head.push(`cwd: ${envelope.cwd}`)
  if (envelope.message) head.push(`reason: ${envelope.message}`)

  const body: string[] = []
  if (envelope.stdout.trimEnd().length > 0) {
    body.push('--- stdout ---')
    body.push(envelope.stdout.trimEnd())
  }
  if (envelope.stderr.trimEnd().length > 0) {
    body.push('--- stderr ---')
    body.push(envelope.stderr.trimEnd())
  }
  if (envelope.stdout.trimEnd().length === 0 && envelope.stderr.trimEnd().length === 0) {
    body.push('(no output)')
  }
  if (envelope.notes.length > 0) {
    body.push('--- notes ---')
    for (const note of envelope.notes) body.push(note)
  }
  return [text(lines(head.join('\n'), '', body.join('\n')).trimEnd())]
}

/** Compact view model for the Web UI terminal card, carried in `meta`. */
export function envelopePresentation(args: unknown, value: unknown): Record<string, JsonValue> {
  const envelope = value as SshExecEnvelope
  const requested = (args as { command?: unknown; label?: unknown } | null)?.command
  const command = envelope.command || (typeof requested === 'string' ? requested : '')
  const output = [
    `$ ${command}`,
    envelope.stdout.trimEnd(),
    envelope.stderr.trimEnd() ? `[stderr]\n${envelope.stderr.trimEnd()}` : '',
    envelope.notes.join('\n'),
  ]
    .filter((part) => part.length > 0)
    .join('\n')
  return {
    title: envelope.sessionId ? `ssh ${envelope.sessionId}` : 'ssh',
    output,
    exitCode: envelope.exitCode,
    ...(envelope.signal ? { signal: envelope.signal } : {}),
    outcome: envelope.outcome,
    sessionId: envelope.sessionId,
    streamId: envelope.streamId,
    durationMs: envelope.durationMs,
  }
}

// ── argument handling ────────────────────────────────────────────────────────

interface ParsedArgs {
  command?: string
  sessionId?: string
  cwd?: string
  env?: Record<string, string>
  stdin?: string
  timeoutMs?: number
  maxOutputBytes?: number
  pty?: boolean
  cols?: number
  rows?: number
  label?: string
}

function readArgs(raw: unknown, errors: string[]): ParsedArgs {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('arguments must be an object')
    return {}
  }
  const source = raw as Record<string, unknown>
  const known = new Set([
    'command',
    'sessionId',
    'cwd',
    'env',
    'stdin',
    'timeoutMs',
    'maxOutputBytes',
    'pty',
    'cols',
    'rows',
    'label',
  ])
  for (const key of Object.keys(source)) {
    if (!known.has(key)) errors.push(`unknown argument "${key}"`)
  }

  const args: ParsedArgs = {}
  const command = stringOf(source['command'])
  if (command === undefined) errors.push('"command" is required and must be a string')
  else if (command.trim() === '') errors.push('"command" must not be empty')
  else args.command = command

  const sessionId = stringOf(source['sessionId'])
  if (source['sessionId'] !== undefined && sessionId === undefined) errors.push('"sessionId" must be a string')
  if (sessionId !== undefined) args.sessionId = sessionId

  const cwd = stringOf(source['cwd'])
  if (source['cwd'] !== undefined && cwd === undefined) errors.push('"cwd" must be a string')
  if (cwd !== undefined) args.cwd = cwd

  const stdin = stringOf(source['stdin'])
  if (source['stdin'] !== undefined && stdin === undefined) errors.push('"stdin" must be a string')
  if (stdin !== undefined) args.stdin = stdin

  const label = stringOf(source['label'])
  if (source['label'] !== undefined && label === undefined) errors.push('"label" must be a string')
  if (label !== undefined) args.label = label

  const env = recordOf(source['env'])
  if (source['env'] !== undefined && env === undefined) errors.push('"env" must be an object of strings')
  if (env !== undefined) args.env = env

  const timeoutMs = integerOf(source['timeoutMs'], 0, errors, 'timeoutMs')
  if (timeoutMs !== undefined) args.timeoutMs = timeoutMs

  const maxOutputBytes = integerOf(source['maxOutputBytes'], 64, errors, 'maxOutputBytes')
  if (maxOutputBytes !== undefined) args.maxOutputBytes = maxOutputBytes

  const cols = integerOf(source['cols'], 1, errors, 'cols')
  if (cols !== undefined) args.cols = cols
  const rows = integerOf(source['rows'], 1, errors, 'rows')
  if (rows !== undefined) args.rows = rows

  if (source['pty'] !== undefined) {
    if (typeof source['pty'] !== 'boolean') errors.push('"pty" must be a boolean')
    else args.pty = source['pty']
  }
  if ((args.cols !== undefined || args.rows !== undefined) && args.pty !== true) {
    errors.push('"cols"/"rows" require "pty": true')
  }

  return args
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function integerOf(value: unknown, min: number, errors: string[], name: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    errors.push(`"${name}" must be an integer`)
    return undefined
  }
  if (value < min) {
    errors.push(`"${name}" must be >= ${min}`)
    return undefined
  }
  return value
}

function recordOf(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== 'string') return undefined
    out[key] = item
  }
  return out
}

// ── refusals ────────────────────────────────────────────────────────────────

interface RefusalInput {
  code: string
  message: string
  command: string
  cwd: string | null
  sessionId?: string | null
  notes?: string[]
}

/** A complete envelope for a call that never reached the remote host. */
function refusal(input: RefusalInput): SshExecEnvelope {
  return toLossless({
    ok: false,
    outcome: 'refused' as ExecOutcome,
    code: input.code,
    message: input.message,
    sessionId: input.sessionId ?? null,
    streamId: null,
    command: input.command,
    cwd: input.cwd,
    exitCode: null,
    signal: null,
    durationMs: 0,
    timedOut: false,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    bytes: { stdout: 0, stderr: 0 },
    binary: { stdout: false, stderr: false },
    notes: input.notes ?? [],
  })
}

function toErrorInfoSafe(error: unknown): { code: string; message: string; details?: unknown } {
  if (error instanceof SshError) return { code: error.code, message: error.message, details: error.details }
  if (error instanceof Error) return { code: 'SSH_UNKNOWN', message: error.message }
  return { code: 'SSH_UNKNOWN', message: String(error) }
}

function sessionNotes(deps: SshExecToolDeps, details: unknown): string[] {
  const sessions = (details as { sessions?: Array<{ id: string; host?: string }> } | undefined)?.sessions ?? deps.exec.sessions()
  if (sessions.length === 0) return ['no connected session']
  return [`available sessions: ${sessions.map((session) => `${session.id}${session.host ? ` (${session.host})` : ''}`).join(', ')}`]
}

function describeSession(deps: SshExecToolDeps, sessionId: string): string {
  const session = deps.exec.sessions().find((candidate) => candidate.id === sessionId)
  if (session === undefined) return sessionId
  const target = [session.user, session.host].filter((part): part is string => typeof part === 'string' && part.length > 0).join('@')
  return target.length > 0 ? `${sessionId} (${target})` : sessionId
}

/** First line of the command, for the pending card title. */
function preview(command: string, max = 60): string {
  const first = command.split('\n').find((line) => line.trim().length > 0) ?? command
  const trimmed = first.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}
