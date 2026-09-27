/**
 * `TransferManager` — the stateful half of §4.5: op ids, cancellation, the live
 * task list behind `sshPlugin/listTransfers`, and the `{ streamId, opId,
 * resumedFrom }` handshake.
 *
 * The split from `TransferEngine` is deliberate. The engine is pure I/O with an
 * injected clock and logger, so it can be tested to the byte; the manager owns
 * process-lifetime state (a registry keyed by `opId`, abort controllers, a
 * bounded history) and is the only object the wire layer has to keep.
 *
 * Two entry points, one implementation:
 *  - `start()` — the §4.5 streaming handshake. Returns immediately; everything
 *    afterwards is reported through the sink and the live record, because the
 *    stream is already open and the UI expects an `end` frame with a structured
 *    error rather than a rejected call.
 *  - `run()` — awaits the outcome and throws on failure. This is what the
 *    model-facing tools (`ssh_upload`/`ssh_download`) use, since a tool call
 *    wants a result, not a stream.
 *
 * ## `resumedFrom` is answered before the stream starts
 *
 * §4.5 returns `resumedFrom` synchronously with the stream handle so the UI can
 * label a row "resuming at 34%" before the first frame arrives. That is
 * affordable for a *single file* (two `stat` calls) and deliberately **not**
 * attempted for a directory: scanning a whole tree before responding would make
 * the call's latency proportional to the tree. A directory therefore answers
 * `resumedFrom: 0` and updates the live record as the engine's scan phase
 * discovers each partial file — the UI reads it from `listTransfers`.
 */

import { newOpId, newStreamId } from '../connection/ids.js'
import { SshError, toErrorInfo } from '../protocol.js'

import { SftpClient } from './client.js'
import { noSuchSession, noSuchTransfer } from './errors.js'
import { typeOfStat } from './format.js'
import { lstatLocal } from './local.js'
import { TransferEngine, type TransferEngineOptions } from './transfer.js'

import type {
  OpId,
  SessionId,
  SessionLookup,
  SftpSessionSource,
  StreamId,
  TransferDirection,
  TransferEngineDefaults,
  TransferEventSink,
  TransferOptionOverrides,
  TransferOutcome,
  TransferProgress,
  TransferRequest,
  TransferTaskRecord,
} from './types.js'

/** How many finished transfers stay queryable through `listTransfers`. */
const HISTORY_LIMIT = 100

export interface StartTransferParams extends TransferOptionOverrides {
  sessionId: SessionId
  direction: TransferDirection
  localPath: string
  remotePath: string
  /** Caller-supplied identity from the wire layer; minted here when absent. */
  opId?: OpId
  streamId?: StreamId
  /** Merged with `sink.onProgress`; both are optional. */
  onProgress?: (progress: TransferProgress) => void
  onConflict?: TransferRequest['onConflict']
  signal?: AbortSignal
  sink?: TransferEventSink
}

export interface StartedTransfer {
  streamId: StreamId
  opId: OpId
  /** Bytes a previous attempt already moved; `0` for a fresh or directory transfer. */
  resumedFrom: number
  /** Known up-front for a single file; `undefined` until the scan finishes for a tree. */
  totalBytes?: number
}

export interface TransferManagerOptions {
  /** Session registry lookup (`ConnectionPool` satisfies it: it has `get`). */
  sessions: SessionLookup
  /** `sftp.*` defaults from the plugin config (ICD §6). */
  defaults?: TransferEngineDefaults
  logger?: TransferEngineOptions['logger']
  clock?: TransferEngineOptions['clock']
  /** Injectable for tests; a default engine is built otherwise. */
  engine?: TransferEngine
  /**
   * Bounded resume-retry for link-class failures (see
   * `TransferEngineOptions.linkRetry`); defaults to one retry over a single stream.
   */
  linkRetry?: TransferEngineOptions['linkRetry']
  now?: () => number
  /** Called when a transfer ends, for audit/telemetry. Never allowed to throw inward. */
  onSettled?: (record: TransferTaskRecord) => void
}

interface LiveTransfer {
  record: TransferTaskRecord
  controller: AbortController
  cancelledByUser: boolean
}

interface Launched {
  started: StartedTransfer
  /** Resolves with the outcome, rejects on failure — for `run()`. */
  raw: Promise<TransferOutcome>
  /** Always resolves; owns the record bookkeeping and the `end` event. */
  tracked: Promise<void>
}

export class TransferManager {
  private readonly options: TransferManagerOptions
  private readonly engine: TransferEngine
  private readonly live = new Map<OpId, LiveTransfer>()
  private readonly order: OpId[] = []

  constructor(options: TransferManagerOptions) {
    this.options = options
    this.engine =
      options.engine ??
      new TransferEngine({
        ...(options.defaults === undefined ? {} : { defaults: options.defaults }),
        ...(options.logger === undefined ? {} : { logger: options.logger }),
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        ...(options.linkRetry === undefined ? {} : { linkRetry: options.linkRetry }),
      })
  }

  /** Transfers still running. */
  get active(): number {
    let count = 0
    for (const entry of this.live.values()) {
      if (entry.record.finishedAt === undefined) count++
    }
    return count
  }

  /** The §4.5 handshake: return immediately, report the rest through the sink. */
  async start(params: StartTransferParams): Promise<StartedTransfer> {
    const launched = await this.#launch(params)
    void launched.tracked
    return launched.started
  }

  /** Run to completion; rejects with the transfer's `SshError` on failure. */
  async run(params: StartTransferParams): Promise<TransferOutcome> {
    const launched = await this.#launch(params)
    void launched.tracked
    return await launched.raw
  }

  /**
   * Abort one transfer. Returns `false` for an unknown or already-settled op.
   *
   * A cancelled transfer ends as `SSH_SFTP_TRANSFER_ABORTED` carrying the durable
   * offset, so the UI can offer "resume" instead of restarting from zero.
   */
  cancel(opId: OpId): boolean {
    const entry = this.live.get(opId)
    if (entry === undefined || entry.record.finishedAt !== undefined) return false
    entry.cancelledByUser = true
    entry.controller.abort()
    return true
  }

  /** Live + recent tasks, oldest first. Copies, never internals. */
  list(): TransferTaskRecord[] {
    const records: TransferTaskRecord[] = []
    for (const opId of this.order) {
      const entry = this.live.get(opId)
      if (entry !== undefined) records.push({ ...entry.record })
    }
    return records
  }

  get(opId: OpId): TransferTaskRecord | undefined {
    const entry = this.live.get(opId)
    return entry === undefined ? undefined : { ...entry.record }
  }

  /** Reads a record or throws `SSH_STATE_INVALID` (for `cancelTransfer`). */
  require(opId: OpId): TransferTaskRecord {
    const record = this.get(opId)
    if (record === undefined) throw noSuchTransfer(opId)
    return record
  }

  /** Abort everything (plugin unload); safe to call twice. */
  dispose(): void {
    for (const entry of this.live.values()) {
      entry.cancelledByUser = true
      entry.controller.abort()
    }
  }

  async #launch(params: StartTransferParams): Promise<Launched> {
    const session = this.#session(params.sessionId)
    const opId = params.opId ?? newOpId()
    const streamId = params.streamId ?? newStreamId()
    const controller = new AbortController()
    const unlink = forward(params.signal, controller)

    const record: TransferTaskRecord = {
      opId,
      streamId,
      sessionId: params.sessionId,
      direction: params.direction,
      localPath: params.localPath,
      remotePath: params.remotePath,
      transferred: 0,
      phase: 'scan',
      bytesPerSec: 0,
      resumeFrom: 0,
      startedAt: new Date(this.#now()).toISOString(),
    }
    const entry: LiveTransfer = { record, controller, cancelledByUser: false }
    this.live.set(opId, entry)
    this.order.push(opId)
    this.#trim()

    let preflight: { resumedFrom: number; totalBytes?: number } = { resumedFrom: 0 }
    try {
      preflight = await this.#preflight(params, session, controller.signal)
    } catch {
      // A pre-flight failure is not fatal: the engine reports the real error
      // through the stream with the code the UI understands.
    }
    record.resumeFrom = preflight.resumedFrom
    if (preflight.totalBytes !== undefined) record.totalBytes = preflight.totalBytes

    const request: TransferRequest = {
      direction: params.direction,
      localPath: params.localPath,
      remotePath: params.remotePath,
      ...(params.chunkBytes === undefined ? {} : { chunkBytes: params.chunkBytes }),
      ...(params.concurrency === undefined ? {} : { concurrency: params.concurrency }),
      ...(params.resume === undefined ? {} : { resume: params.resume }),
      ...(params.verify === undefined ? {} : { verify: params.verify }),
      ...(params.overwrite === undefined ? {} : { overwrite: params.overwrite }),
      signal: controller.signal,
      onProgress: (progress) => {
        record.transferred = progress.transferred
        record.phase = progress.phase
        record.bytesPerSec = progress.bytesPerSec
        if (progress.totalBytes !== undefined) record.totalBytes = progress.totalBytes
        if (progress.etaMs !== undefined) record.etaMs = progress.etaMs
        else delete record.etaMs
        invoke(() => params.onProgress?.(progress))
        invoke(() => params.sink?.onProgress?.(progress))
      },
      ...(params.onConflict === undefined ? {} : { onConflict: params.onConflict }),
    }

    // Started here, awaited by `run()`; the handle is opened lazily so a broken
    // SFTP subsystem fails inside the transfer, where the record can show it.
    const raw = (async (): Promise<TransferOutcome> => {
      const handle = await session.sftp(controller.signal)
      return await this.engine.run(handle, request, { opId })
    })()

    const tracked = raw.then(
      (outcome) => {
        record.phase = 'done'
        record.transferred = outcome.transferred
        record.totalBytes = outcome.totalBytes
        record.resumeFrom = outcome.resumedFrom
        record.bytesPerSec = outcome.bytesPerSec
        delete record.etaMs
        record.finishedAt = new Date(this.#now()).toISOString()
        if (outcome.sha256 !== undefined) record.sha256 = outcome.sha256
        invoke(() => params.sink?.onEnd?.({ reason: 'completed', outcome }))
      },
      (error: unknown) => {
        const info = toErrorInfo(error)
        record.phase = entry.cancelledByUser ? 'cancelled' : 'error'
        record.error = info
        record.finishedAt = new Date(this.#now()).toISOString()
        const details = error instanceof SshError ? (error.details as { resumedFrom?: unknown } | undefined) : undefined
        if (details !== undefined && typeof details.resumedFrom === 'number') record.resumeFrom = details.resumedFrom
        invoke(() => params.sink?.onEnd?.({ reason: entry.cancelledByUser ? 'cancelled' : 'error', error: info }))
      },
    )
    const trackedDone = tracked.finally(() => {
      unlink()
      invoke(() => this.options.onSettled?.({ ...record }))
    })

    const started: StartedTransfer = { streamId, opId, resumedFrom: preflight.resumedFrom }
    if (preflight.totalBytes !== undefined) started.totalBytes = preflight.totalBytes
    return { started, raw, tracked: trackedDone }
  }

  async #preflight(
    params: StartTransferParams,
    session: SftpSessionSource,
    signal: AbortSignal,
  ): Promise<{ resumedFrom: number; totalBytes?: number }> {
    const resume = params.resume !== false
    if (params.direction === 'upload') {
      const info = await lstatLocal(params.localPath)
      if (info === undefined || typeOfStat(info) !== 'file') return { resumedFrom: 0 }
      const totalBytes = info.size
      if (!resume || totalBytes === 0) return { resumedFrom: 0, totalBytes }
      const handle = await session.sftp(signal)
      // Unknown capability ⇒ assume it works: the engine probes, and a restart
      // from 0 stays correct — only the label would have been optimistic.
      if (handle.supportsOffsetWrite?.() === false) return { resumedFrom: 0, totalBytes }
      const destination = await new SftpClient(handle).stat(params.remotePath, signal)
      const resumedFrom = destination.exists && destination.size > 0 && destination.size < totalBytes ? destination.size : 0
      return { resumedFrom, totalBytes }
    }
    const handle = await session.sftp(signal)
    const source = await new SftpClient(handle).stat(params.remotePath, signal)
    if (!source.exists || source.type !== 'file') return { resumedFrom: 0 }
    const totalBytes = source.size
    if (!resume || totalBytes === 0) return { resumedFrom: 0, totalBytes }
    const localInfo = await lstatLocal(params.localPath)
    const resumedFrom =
      localInfo !== undefined && typeOfStat(localInfo) === 'file' && localInfo.size > 0 && localInfo.size < totalBytes
        ? localInfo.size
        : 0
    return { resumedFrom, totalBytes }
  }

  #session(sessionId: SessionId): SftpSessionSource {
    const session = this.options.sessions.get(sessionId)
    if (session === undefined) throw noSuchSession(sessionId)
    return session
  }

  #now(): number {
    return this.options.now?.() ?? Date.now()
  }

  /** Keep only the newest `HISTORY_LIMIT` operations. */
  #trim(): void {
    while (this.order.length > HISTORY_LIMIT) {
      const oldest = this.order.shift()
      if (oldest !== undefined) this.live.delete(oldest)
    }
  }
}

/** A sink must never be able to abort a running transfer. */
function invoke(callback: () => void): void {
  try {
    callback()
  } catch {
    /* ignored on purpose */
  }
}

/** Link a caller signal to the internal controller; returns the unlink function. */
function forward(from: AbortSignal | undefined, to: AbortController): () => void {
  if (from === undefined) return () => undefined
  if (from.aborted) {
    to.abort()
    return () => undefined
  }
  const onAbort = (): void => to.abort()
  from.addEventListener('abort', onAbort, { once: true })
  return () => from.removeEventListener('abort', onAbort)
}
