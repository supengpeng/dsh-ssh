/**
 * The stream registry: one place that owns every live exec/shell stream.
 *
 * The wire layer (ICD §4.4) addresses streams by `streamId` for `shellWrite`,
 * `shellResize`, `shellSignal`, `shellClose` and `cancel`, and it subscribes
 * with `sinceSeq` after a transport break. Both need a single table, so this hub
 * keeps it:
 *
 *   - `open()` creates the stream (and emits `open` immediately);
 *   - `subscribe(streamId, onFrame, {sinceSeq})` replays what the client missed
 *     and then delivers live frames;
 *   - `write/resize/signal/close` route to the channel controls the runner
 *     attached to the stream;
 *   - `dispose()` guarantees that no stream is left without its terminal `end`.
 *
 * Finished streams stay addressable for a bounded number of entries so a client
 * that reconnects after the command ended still gets the exit code and output.
 * A replay request that reaches further back than the retained window is
 * reported as `gap:true` — never silently.
 */

import { SshError } from '../protocol.js'
import type { Frame, StreamKind } from '../protocol.js'
import { FrameWriter } from './frames.js'
import { newStreamId } from './ids.js'
import type { ChunkEncoding, SshSignal } from './types.js'

/** Operations the runner exposes for a live stream. */
export interface StreamControl {
  /** Number of bytes accepted by the channel. */
  write?(data: string, encoding: ChunkEncoding): number
  resize?(cols: number, rows: number): void
  signal?(signal: SshSignal): void
  /** Ask the runner to terminate the command; it ends the stream itself. */
  cancel(reason: string): void
  /** Interactive-close path (`shellClose`); falls back to `cancel`. */
  close?(): void
  /**
   * The hub had to terminate the stream itself (`dispose`) because the runner
   * did not. The runner must settle its own bookkeeping — otherwise the caller's
   * promise would wait forever on a stream the wire already saw end.
   */
  terminated?(reason: string): void
}

export interface OpenStreamOptions {
  kind: StreamKind
  sessionId?: string
  meta?: unknown
  controls?: StreamControl
  /** Overrides the hub default; the exec layer passes the config value. */
  replayLimitBytes?: number
  /** Count bound on the replay window; `undefined` keeps `FrameWriter`'s default. */
  replayLimitFrames?: number
  /** Caller-supplied id (tests, reconnect); generated when omitted. */
  streamId?: string
}

export interface StreamSummary {
  streamId: string
  kind: StreamKind
  sessionId?: string
  startedAt: string
  alive: boolean
  dataFrames: number
  bytes: number
  durationMs: number
}

export interface Subscription {
  unsubscribe(): void
  /** Frames delivered from the replay log. */
  replayed: number
  /** True when the requested `sinceSeq` predates the retained window. */
  gap: boolean
  /** True when the stream had already finished: nothing live will follow. */
  finished: boolean
}

export interface SubscribeOptions {
  sinceSeq?: number
}

export interface StreamHubOptions {
  now?: () => number
  replayLimitBytes?: number
  /** Count bound on the replay window; `undefined` keeps `FrameWriter`'s default. */
  replayLimitFrames?: number
  /** How many finished streams stay addressable for late subscribers. */
  maxFinishedStreams?: number
  onViolation?: (violation: string) => void
}

interface StreamRecord {
  streamId: string
  kind: StreamKind
  sessionId: string | undefined
  controls: StreamControl | undefined
  startedAt: number
  finishedAt: number | undefined
  bytes: number
  listeners: Set<(frame: Frame) => void>
  writer: FrameWriter
}

const DEFAULT_FINISHED_STREAMS = 64

export class StreamHub {
  private readonly now: () => number
  private readonly replayLimitBytes: number
  /**
   * `undefined` is preserved, never collapsed to 0: `FrameWriter` reads 0 as
   * "no count bound", so defaulting here would silently *disable* the bound this
   * option exists to enforce. Unset must stay unset and let FrameWriter decide.
   */
  private readonly replayLimitFrames: number | undefined
  private readonly maxFinishedStreams: number
  private readonly onViolation: (violation: string) => void
  private readonly records = new Map<string, StreamRecord>()
  private readonly quarantined: string[] = []

  constructor(options: StreamHubOptions = {}) {
    this.now = options.now ?? Date.now
    this.replayLimitBytes = Math.max(4096, Math.trunc(options.replayLimitBytes ?? 262_144))
    this.replayLimitFrames =
      options.replayLimitFrames === undefined ? undefined : Math.max(0, Math.trunc(options.replayLimitFrames))
    this.maxFinishedStreams = Math.max(1, Math.trunc(options.maxFinishedStreams ?? DEFAULT_FINISHED_STREAMS))
    this.onViolation = options.onViolation ?? (() => {})
  }

  /** Number of streams currently held (live + finished). */
  get size(): number {
    return this.records.size
  }

  get liveCount(): number {
    let count = 0
    for (const record of this.records.values()) if (record.finishedAt === undefined) count += 1
    return count
  }

  /** Create a stream; `open` is emitted before this returns. */
  open(options: OpenStreamOptions): FrameWriter {
    const streamId = options.streamId ?? newStreamId(this.now())
    if (this.records.has(streamId)) {
      throw new SshError('SSH_STATE_INVALID', `stream ${streamId} already exists`)
    }
    const startedAt = this.now()
    const record: StreamRecord = {
      streamId,
      kind: options.kind,
      sessionId: options.sessionId,
      controls: options.controls,
      startedAt,
      finishedAt: undefined,
      bytes: 0,
      listeners: new Set(),
      // Assigned immediately below; the sink closes over `record`, not `writer`.
      writer: undefined as unknown as FrameWriter,
    }
    const replayLimitFrames = options.replayLimitFrames ?? this.replayLimitFrames
    const writer = new FrameWriter({
      streamId,
      kind: options.kind,
      meta: options.meta,
      replayLimitBytes: options.replayLimitBytes ?? this.replayLimitBytes,
      ...(replayLimitFrames === undefined ? {} : { replayLimitFrames }),
      now: this.now,
      sink: (frame) => this.dispatch(record, frame),
      onViolation: this.onViolation,
      onEnd: () => this.finishRecord(record),
    })
    record.writer = writer
    this.records.set(streamId, record)
    return writer
  }

  get(streamId: string): FrameWriter | undefined {
    return this.records.get(streamId)?.writer
  }

  has(streamId: string): boolean {
    return this.records.has(streamId)
  }

  /** Set (or replace) the controls of a live stream. */
  attach(streamId: string, controls: StreamControl): void {
    const record = this.require(streamId)
    record.controls = controls
  }

  /** Live and finished streams, oldest first, optionally for one session. */
  list(sessionId?: string): StreamSummary[] {
    const out: StreamSummary[] = []
    for (const record of this.records.values()) {
      if (sessionId !== undefined && record.sessionId !== sessionId) continue
      out.push(this.summarize(record))
    }
    return out
  }

  summarizeById(streamId: string): StreamSummary | undefined {
    const record = this.records.get(streamId)
    return record === undefined ? undefined : this.summarize(record)
  }

  /**
   * Deliver the frames a (re)subscriber needs.
   *
   * Frames buffered while the replay runs are flushed afterwards, so a sink that
   * re-enters the hub cannot reorder the sequence.
   */
  subscribe(streamId: string, onFrame: (frame: Frame) => void, options: SubscribeOptions = {}): Subscription {
    const record = this.require(streamId)
    const { frames, gap } = record.writer.replay(options.sinceSeq)

    const pending: Frame[] = []
    let replaying = true
    const listener = (frame: Frame): void => {
      if (replaying) pending.push(frame)
      else safeCall(onFrame, frame)
    }
    record.listeners.add(listener)

    for (const frame of frames) safeCall(onFrame, frame)
    replaying = false
    for (const frame of pending) safeCall(onFrame, frame)

    const finished = record.writer.ended
    if (finished) record.listeners.delete(listener)

    let active = true
    return {
      unsubscribe: () => {
        if (!active) return
        active = false
        record.listeners.delete(listener)
      },
      replayed: frames.length,
      gap,
      finished,
    }
  }

  /** Route `shellWrite`; returns the number of accepted bytes. */
  write(streamId: string, data: string, encoding: ChunkEncoding = 'utf8'): number {
    const record = this.requireLive(streamId, 'write')
    const control = record.controls?.write
    if (control === undefined) {
      throw new SshError('SSH_STATE_INVALID', `stream ${streamId} does not accept input`)
    }
    return control.call(record.controls, data, encoding)
  }

  /** Route `shellResize`. */
  resize(streamId: string, cols: number, rows: number): void {
    const record = this.requireLive(streamId, 'resize')
    const control = record.controls?.resize
    if (control === undefined) {
      throw new SshError('SSH_STATE_INVALID', `stream ${streamId} has no PTY to resize`)
    }
    control.call(record.controls, cols, rows)
  }

  /** Route `shellSignal`. */
  signal(streamId: string, signal: SshSignal): void {
    const record = this.requireLive(streamId, 'signal')
    const control = record.controls?.signal
    if (control === undefined) {
      throw new SshError('SSH_STATE_INVALID', `stream ${streamId} does not accept signals`)
    }
    control.call(record.controls, signal)
  }

  /** Ask a live stream to stop; the runner emits the terminal frames. */
  cancel(streamId: string, reason = 'cancelled'): boolean {
    const record = this.records.get(streamId)
    if (record === undefined || record.finishedAt !== undefined) return false
    try {
      record.controls?.cancel(reason)
    } catch (error) {
      this.onViolation(`cancel(${streamId}) failed: ${messageOf(error)}`)
    }
    return true
  }

  /** `shellClose`: close the interactive channel, ending the stream as cancelled. */
  close(streamId: string, reason = 'cancelled'): boolean {
    const record = this.records.get(streamId)
    if (record === undefined || record.finishedAt !== undefined) return false
    try {
      if (record.controls?.close !== undefined) record.controls.close()
      else record.controls?.cancel(reason)
    } catch (error) {
      this.onViolation(`close(${streamId}) failed: ${messageOf(error)}`)
    }
    return true
  }

  /**
   * Terminate everything (plugin unload).
   *
   * A control that ends its stream synchronously wins; anything still live is
   * closed here so no client is left holding a stream that never ends.
   */
  dispose(reason: 'peer-closed' | 'cancelled' = 'peer-closed'): void {
    for (const record of [...this.records.values()]) {
      if (record.finishedAt !== undefined) continue
      const controls = record.controls
      try {
        controls?.cancel('dispose')
      } catch (error) {
        this.onViolation(`dispose cancel(${record.streamId}) failed: ${messageOf(error)}`)
      }
      if (!record.writer.ended) {
        if (record.kind === 'exec' || record.kind === 'shell') {
          record.writer.exit({
            code: null,
            durationMs: record.writer.elapsedMs(),
            timedOut: false,
          })
        }
        record.writer.end(reason)
      }
      try {
        controls?.terminated?.(reason)
      } catch (error) {
        this.onViolation(`dispose terminated(${record.streamId}) failed: ${messageOf(error)}`)
      }
    }
  }

  private dispatch(record: StreamRecord, frame: Frame): void {
    if (frame.t === 'data') record.bytes += byteSizeOf(frame)
    for (const listener of [...record.listeners]) safeCall(listener, frame)
  }

  private finishRecord(record: StreamRecord): void {
    record.finishedAt = this.now()
    record.listeners.clear()
    if (record.kind === 'exec' || record.kind === 'shell') record.controls = undefined
    this.quarantine(record.streamId)
  }

  /** Keep at most `maxFinishedStreams` finished streams addressable. */
  private quarantine(streamId: string): void {
    this.quarantined.push(streamId)
    while (this.quarantined.length > this.maxFinishedStreams) {
      const oldest = this.quarantined.shift()
      if (oldest === undefined) return
      const record = this.records.get(oldest)
      if (record !== undefined && record.finishedAt !== undefined) this.records.delete(oldest)
    }
  }

  private summarize(record: StreamRecord): StreamSummary {
    const end = record.finishedAt ?? this.now()
    return {
      streamId: record.streamId,
      kind: record.kind,
      ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
      startedAt: new Date(record.startedAt).toISOString(),
      alive: record.finishedAt === undefined,
      dataFrames: record.writer.dataFrames,
      bytes: record.bytes,
      durationMs: Math.max(0, end - record.startedAt),
    }
  }

  private require(streamId: string): StreamRecord {
    const record = this.records.get(streamId)
    if (record === undefined) throw new SshError('SSH_STATE_INVALID', `unknown stream ${streamId}`)
    return record
  }

  private requireLive(streamId: string, operation: string): StreamRecord {
    const record = this.require(streamId)
    if (record.finishedAt !== undefined) {
      throw new SshError('SSH_STATE_INVALID', `cannot ${operation}: stream ${streamId} has ended`)
    }
    return record
  }
}

function byteSizeOf(frame: Extract<Frame, { t: 'data' }>): number {
  return frame.encoding === 'base64' ? Buffer.byteLength(frame.chunk, 'base64') : Buffer.byteLength(frame.chunk, 'utf8')
}

function safeCall(listener: (frame: Frame) => void, frame: Frame): void {
  try {
    listener(frame)
  } catch {
    // A subscriber must never be able to break the stream it observes.
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
