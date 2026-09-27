/**
 * `ExecHandle` / `ShellHandle` implementation (ICD §7.1, v1.0.4).
 *
 * One instance owns one `ssh2` channel. The handle is the *only* place that
 * knows when a channel dies, so it is also the place that guarantees the ICD's
 * terminal-event invariants: exactly one `exit` event, always after the last
 * `data` event, `timedOut` set when the deadline fired, and no silent loss of
 * output (chunks that arrive before the first subscriber are buffered, not
 * dropped).
 *
 * Deadline (ICD §4.4): at `timeoutMs` send SIGTERM, at `timeoutMs + graceKillMs`
 * send SIGKILL and force the channel closed; every exit after the TERM reports
 * `timedOut: true`. The exec layer may run the same escalation on its side — the
 * handle is idempotent, so the observable outcome is one terminal event.
 */

import { SshError } from '../protocol.js'
import type { ClientChannelPort, ExecExit, ExecHandle, LoggerPort, ShellHandle, StreamId } from './types.js'

/** Grace between `cancel()`'s TERM and the forced channel close. */
const CANCEL_GRACE_MS = 750

/** Buffered bytes kept for subscribers that attach after the first chunk. */
const PRE_SUBSCRIBE_BUFFER_BYTES = 4 * 1024 * 1024

export interface ChannelHandleOptions {
  streamId: StreamId
  channel: ClientChannelPort
  logger: LoggerPort
  now: () => number
  /** `kind` only affects log wording. */
  kind: 'exec' | 'shell'
  /** Command/term label for logs; never contains secrets. */
  label: string
  /** Cooperative deadline; `undefined` = no deadline. */
  timeoutMs?: number | undefined
  /** `config.graceKillMs`: SIGTERM → SIGKILL delay. */
  graceKillMs: number
  /** Output accounting hook (session `metrics.bytesIn`). */
  onBytesIn?: ((bytes: number) => void) | undefined
  /** Stdin accounting hook (session `metrics.bytesOut`). */
  onBytesOut?: ((bytes: number) => void) | undefined
  /** Called exactly once when the channel finished. */
  onFinished?: (() => void) | undefined
}

type DataListener = (channel: 'stdout' | 'stderr', chunk: Buffer) => void
type ExitListener = (event: ExecExit) => void

export class ChannelHandle implements ShellHandle {
  readonly streamId: StreamId

  private readonly channel: ClientChannelPort
  private readonly logger: LoggerPort
  private readonly now: () => number
  private readonly kind: 'exec' | 'shell'
  private readonly label: string
  private readonly onBytesIn: ((bytes: number) => void) | undefined
  private readonly onBytesOut: ((bytes: number) => void) | undefined
  private readonly onFinished: (() => void) | undefined
  private readonly startedAt: number

  private readonly dataListeners = new Set<DataListener>()
  private readonly exitListeners = new Set<ExitListener>()
  private readonly pending: Array<{ channel: 'stdout' | 'stderr'; chunk: Buffer }> = []
  private pendingBytes = 0
  private droppedBytes = 0

  private finished = false
  private stdinEnded = false
  private cancelled = false
  private timedOut = false
  private exitEvent: ExecExit | undefined
  private exitStatus: { code: number | null; signal: string | undefined } | undefined
  private termTimer: NodeJS.Timeout | undefined
  private killTimer: NodeJS.Timeout | undefined
  private cancelTimer: NodeJS.Timeout | undefined

  constructor(options: ChannelHandleOptions) {
    this.streamId = options.streamId
    this.channel = options.channel
    this.logger = options.logger
    this.now = options.now
    this.kind = options.kind
    this.label = options.label
    this.onBytesIn = options.onBytesIn
    this.onBytesOut = options.onBytesOut
    this.onFinished = options.onFinished
    this.startedAt = this.now()

    this.channel.on('data', (chunk: Buffer) => {
      this.onBytesIn?.(chunk.length)
      this.emitData('stdout', chunk)
    })
    const stderr = this.channel.stderr
    stderr?.on('data', (chunk: Buffer) => {
      this.onBytesIn?.(chunk.length)
      this.emitData('stderr', chunk)
    })
    this.channel.on('exit', (code: number | null, signal: string | undefined) => {
      this.exitStatus = { code, signal }
    })
    this.channel.on('close', (code: number | null, signal: string | undefined) => {
      const status = this.exitStatus
      this.finish(
        status === undefined ? (code ?? null) : status.code,
        status === undefined ? signal : status.signal,
      )
    })

    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      const grace = Math.max(0, Math.trunc(options.graceKillMs))
      this.termTimer = this.schedule(() => {
        this.timedOut = true
        this.signal('TERM')
        this.logger.debug(`${this.kind} ${this.streamId} deadline reached; sent TERM (~${options.timeoutMs}ms)`)
      }, options.timeoutMs)
      this.killTimer = this.schedule(() => {
        this.timedOut = true
        this.signal('KILL')
        this.logger.warn(`${this.kind} ${this.streamId} did not exit after TERM; sent KILL and closed the channel`)
        this.forceFinish()
      }, options.timeoutMs + grace)
    }
  }

  // -- observable surface --------------------------------------------------

  onData(cb: DataListener): () => void {
    this.dataListeners.add(cb)
    if (this.pending.length > 0) {
      const buffered = this.pending.splice(0, this.pending.length)
      this.pendingBytes = 0
      for (const item of buffered) cb(item.channel, item.chunk)
    }
    if (this.droppedBytes > 0) {
      this.logger.error(
        `${this.kind} ${this.streamId}: ${this.droppedBytes} bytes arrived before any subscriber and were dropped`,
      )
    }
    return () => {
      this.dataListeners.delete(cb)
    }
  }

  onExit(cb: ExitListener): () => void {
    if (this.exitEvent !== undefined) {
      const event = this.exitEvent
      queueMicrotask(() => cb(event))
      return () => {}
    }
    this.exitListeners.add(cb)
    return () => {
      this.exitListeners.delete(cb)
    }
  }

  write(stdin: string | Buffer): void {
    if (this.finished) {
      throw new SshError('SSH_STATE_INVALID', 'cannot write to a closed channel', {
        details: { streamId: this.streamId },
      })
    }
    if (this.stdinEnded) {
      throw new SshError('SSH_STATE_INVALID', 'cannot write after endInput(): stdin was already closed', {
        details: { streamId: this.streamId },
      })
    }
    const bytes = Buffer.byteLength(stdin)
    try {
      this.channel.write(stdin)
      this.onBytesOut?.(bytes)
    } catch (error) {
      throw new SshError('SSH_NET_RESET', `writing to channel ${this.streamId} failed: ${errorText(error)}`, {
        details: { streamId: this.streamId },
        cause: error,
      })
    }
  }

  endInput(): void {
    if (this.finished) {
      throw new SshError('SSH_STATE_INVALID', 'cannot close stdin of a closed channel', {
        details: { streamId: this.streamId },
      })
    }
    if (this.stdinEnded) return
    this.stdinEnded = true
    try {
      this.channel.end()
    } catch (error) {
      this.logger.debug(`${this.kind} ${this.streamId}: stdin end failed: ${errorText(error)}`)
    }
  }

  signal(sig: 'INT' | 'TERM' | 'KILL' | 'QUIT' | 'HUP'): void {
    if (this.finished) return
    try {
      this.channel.signal(sig)
    } catch (error) {
      // Signals are best effort: a server may refuse the request, and a channel
      // may already be gone.
      this.logger.debug(`${this.kind} ${this.streamId}: signal ${sig} failed: ${errorText(error)}`)
    }
  }

  cancel(): void {
    if (this.finished || this.cancelled) return
    this.cancelled = true
    this.signal('TERM')
    this.cancelTimer = this.schedule(() => {
      this.forceFinish()
    }, CANCEL_GRACE_MS)
  }

  resize(cols: number, rows: number): void {
    if (this.finished) return
    const safeCols = Math.max(1, Math.trunc(cols))
    const safeRows = Math.max(1, Math.trunc(rows))
    try {
      this.channel.setWindow(safeRows, safeCols, 0, 0)
    } catch (error) {
      this.logger.debug(`${this.kind} ${this.streamId}: resize failed: ${errorText(error)}`)
    }
  }

  // -- internals -----------------------------------------------------------

  private emitData(channel: 'stdout' | 'stderr', chunk: Buffer): void {
    if (this.dataListeners.size === 0) {
      if (this.pendingBytes + chunk.length > PRE_SUBSCRIBE_BUFFER_BYTES) {
        this.droppedBytes += chunk.length
        return
      }
      this.pending.push({ channel, chunk })
      this.pendingBytes += chunk.length
      return
    }
    for (const listener of [...this.dataListeners]) {
      try {
        listener(channel, chunk)
      } catch (error) {
        this.logger.error(`${this.kind} ${this.streamId}: data subscriber threw: ${errorText(error)}`)
      }
    }
  }

  private finish(code: number | null, signal: string | undefined): void {
    if (this.finished) return
    this.finished = true
    this.clearTimers()
    const event: ExecExit = {
      code,
      ...(signal === undefined ? {} : { signal }),
      durationMs: Math.max(0, this.now() - this.startedAt),
      timedOut: this.timedOut,
    }
    this.exitEvent = event
    if (this.pending.length > 0) {
      // Deliver whatever arrived before the first subscriber attached, so the
      // terminal event never overtakes buffered output.
      const buffered = this.pending.splice(0, this.pending.length)
      this.pendingBytes = 0
      for (const item of buffered) {
        for (const listener of [...this.dataListeners]) {
          try {
            listener(item.channel, item.chunk)
          } catch {
            /* already logged above */
          }
        }
      }
    }
    for (const listener of [...this.exitListeners]) {
      try {
        listener(event)
      } catch (error) {
        this.logger.error(`${this.kind} ${this.streamId}: exit subscriber threw: ${errorText(error)}`)
      }
    }
    this.exitListeners.clear()
    try {
      this.onFinished?.()
    } catch {
      /* a bookkeeping hook must not break teardown */
    }
    this.logger.debug(
      `${this.kind} ${this.streamId} finished (code=${code ?? 'null'}${signal === undefined ? '' : `, signal=${signal}`}, ` +
        `${event.durationMs}ms${event.timedOut ? ', timed out' : ''}${this.cancelled ? ', cancelled' : ''})`,
    )
  }

  /** Deadline / cancel path: close the channel and settle the terminal event. */
  private forceFinish(): void {
    if (this.finished) return
    try {
      this.channel.close()
    } catch (error) {
      this.logger.debug(`${this.kind} ${this.streamId}: channel close failed: ${errorText(error)}`)
    }
    const status = this.exitStatus
    this.finish(status?.code ?? null, status?.signal)
  }

  private schedule(task: () => void, ms: number): NodeJS.Timeout {
    const timer = setTimeout(task, Math.max(0, ms))
    timer.unref?.()
    return timer
  }

  private clearTimers(): void {
    for (const timer of [this.termTimer, this.killTimer, this.cancelTimer]) {
      if (timer !== undefined) clearTimeout(timer)
    }
    this.termTimer = undefined
    this.killTimer = undefined
    this.cancelTimer = undefined
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** True when a handle satisfies the frozen `ExecHandle` surface (used by tests). */
export function isExecHandle(value: unknown): value is ExecHandle {
  if (value === null || typeof value !== 'object') return false
  const handle = value as Partial<ExecHandle>
  return (
    typeof handle.streamId === 'string' &&
    typeof handle.onData === 'function' &&
    typeof handle.onExit === 'function' &&
    typeof handle.write === 'function' &&
    typeof handle.endInput === 'function' &&
    typeof handle.signal === 'function' &&
    typeof handle.cancel === 'function'
  )
}
