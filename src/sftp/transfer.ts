/**
 * The transfer engine: chunked, resumable, verifiable transfer over one frozen
 * `SftpHandle` (ICD §7.2), emitting coalesced progress per ICD §3/§4.5.
 *
 * ## How a transfer is executed
 *
 * A file is split into `concurrency` **contiguous ranges** (not interleaved
 * chunks). Each worker writes its range sequentially from its own offset, which
 * buys three properties interleaved chunking cannot:
 *
 *  - a worker's committed bytes always form a contiguous prefix of its range, so
 *    the durable prefix of the whole file is `first-incomplete-range.start +
 *    committed` — exactly the offset a resume must start from;
 *  - no per-chunk open/close on the remote side (one write stream per range, and
 *    ssh2 ACKs each stream's writes in order);
 *  - a memory ceiling of `chunkBytes × concurrency` (256 KiB × 4 = 1 MiB by
 *    default) independent of file size — which is what makes 100 MiB safe.
 *
 * ## Resume, and why an abort truncates
 *
 * Resume-by-size (`resumedFrom = destination size`) is only *safe* while the
 * destination file's length equals its durable prefix. With parallel ranges that
 * is not automatic: if range 2 lands while range 1 is half-written, the file is
 * longer than the durable prefix and a later run would resume past a hole. So
 * the engine restores the length — `truncate(destination, durable)` — once a
 * transfer fails and **all** workers have settled. Uploads therefore need an
 * offset-capable *and* truncatable handle for parallel ranges; when either
 * capability is missing the upload degrades to a **single ordered range**, which
 * keeps length == durable prefix and needs no truncate at all. Downloads
 * truncate locally through `node:fs`, so they are always parallel and always
 * resumable.
 *
 * ## Verification
 *
 * `sha256` compares both files after the transfer, reading each side
 * independently: the local file from disk and the remote file over SFTP. That is
 * also the only check that can validate a resumed prefix.
 */

import { createHash, randomBytes } from 'node:crypto'
import { open as openLocal, truncate as truncateLocal } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'

import { newOpId } from '../connection/ids.js'
import { SshError } from '../protocol.js'

import { SftpClient } from './client.js'
import { abortedTransfer, cancelledTransfer, codedError, isLinkClassCode, targetExists, toSftpError, verifyMismatch } from './errors.js'
import { formatMode, typeOfStat } from './format.js'
import {
  createOrTruncateLocalFile,
  destroyStream,
  ensureLocalDir,
  listLocalTree,
  lstatLocal,
  readExactly,
  sha256OfFile,
  statLocal,
  writeExactly,
  type LocalEntry,
} from './local.js'
import { isProtectedLocalPath, localBasename, localDirname, localJoin, remoteBasename, remoteDirname, remoteJoin, remoteNormalize } from './paths.js'
import { ProgressReporter, type ProgressClock } from './progress.js'

import type {
  ConflictDecision,
  OffsetWriteMode,
  ResolvedTransferOptions,
  SftpHandle,
  TransferDirection,
  TransferEngineDefaults,
  TransferEntryResult,
  TransferLogger,
  TransferOptionOverrides,
  TransferOutcome,
  TransferRequest,
  TransferVerify,
} from './types.js'

/** Guard rails for operator-supplied numbers (a 4 GiB chunk is never useful). */
const MIN_CHUNK_BYTES = 16 * 1024
const MAX_CHUNK_BYTES = 16 * 1024 * 1024
const MAX_CONCURRENCY = 32
const DEFAULT_MAX_DEPTH = 64
/**
 * How long the post-failure truncate may take before it is abandoned.
 *
 * A repair step that runs *after* a failure must never be able to hang the error
 * path: if the connection died, the SFTP callback for the truncate may never
 * arrive (observed against a server that destroys the socket mid-write). Ten
 * seconds is far more than one round trip and still finite.
 */
const DEFAULT_RESTORE_TIMEOUT_MS = 10_000
/**
 * How long a single chunk may take before the peer is declared dead.
 *
 * Measured against a server that destroys the socket mid-write: ssh2's pending
 * SFTP write callbacks are **never invoked** in that case, so without a deadline
 * a worker waits forever and the transfer never reports anything — the worst
 * possible outcome for a UI (a spinner that never stops). 256 KiB in 60 s is
 * 4.3 KiB/s; below that the link cannot carry this transfer anyway. The timer is
 * per chunk, not cumulative, so a slow-but-alive link is unaffected.
 */
const DEFAULT_CHUNK_TIMEOUT_MS = 60_000
/** Probe/housekeeping operations get their own, shorter bound. */
const PROBE_TIMEOUT_MS = 15_000
/** One bounded retry at a single stream: correctness first, throughput second. */
const DEFAULT_LINK_RETRY = { attempts: 1, concurrency: 1 }
/** ICD §4.5: progress fires at ≥200 ms **or** ≥1 MiB, whichever comes first. */
const DEFAULT_PROGRESS_INTERVAL_MS = 200
const DEFAULT_PROGRESS_BYTE_THRESHOLD = 1024 * 1024

export interface TransferEngineOptions {
  /** `sftp.*` defaults (ICD §6); overridden per request, then clamped. */
  defaults?: TransferEngineDefaults
  logger?: TransferLogger
  /** Injectable clock, so the progress cadence is unit-testable. */
  clock?: ProgressClock
  /** `auto` (declare/probe), `require` or `disable` offset writes. Default `auto`. */
  offsetWrite?: OffsetWriteMode
  maxDepth?: number
  progressByteThreshold?: number
  /** Deadline for the post-failure truncate (default 10 s); never hangs a failure. */
  restoreTimeoutMs?: number
  /**
   * Deadline for one chunk read/write (default 60 s). Bounds a transfer whose
   * peer vanished without closing the channel; the manager may derive it from
   * `operationTimeoutMs`.
   */
  chunkTimeoutMs?: number
  /** Apply the source's permission bits to the destination (`chmod`). Off by default. */
  preserveMode?: boolean
  /**
   * Bounded retry for **link-class** failures (a dropped/failed channel, a chunk
   * deadline, "No response from server"), resuming from the durable offset with
   * fewer streams. Default `{ attempts: 1, concurrency: 1 }`.
   *
   * Deliberately engine-side and resume-based rather than "start over": ICD §5
   * requires a transfer retry to continue from the break point, and resuming keeps
   * `transferred` monotone and `totalBytes` fixed, so the progress bar never jumps
   * backwards. A retry happens only when the durable prefix was restored
   * (`resumeSafe`) and the caller did not abort; otherwise the failure is reported
   * with `resumable: false` as before.
   */
  linkRetry?: { attempts?: number; concurrency?: number }
}

export interface TransferRunContext {
  /** Operation id minted by the manager; the engine only reports it. */
  opId?: string
}

interface RangeState {
  start: number
  end: number
  committed: number
}

interface PlannedFile {
  localPath: string
  remotePath: string
  size: number
  resumedFrom: number
  /** Source permission bits, applied with `chmod` only when `preserveMode` is on. */
  mode: string
  ranges: RangeState[]
  entry: TransferEntryResult
  /**
   * Highest durable offset already reported to the progress sink.
   *
   * Progress advances by the **durable prefix**, not by bytes written: a retried
   * attempt re-writes bytes that were written but never made durable, and
   * counting those twice would push `transferred` past `totalBytes` — an ICD §3
   * violation ("progress 单调不减，totalBytes 确定后不再变化").
   */
  reportedDurable: number
}

interface PlannedDirectory {
  localPath: string
  remotePath: string
}

interface TransferPlan {
  files: PlannedFile[]
  directories: PlannedDirectory[]
  skipped: Array<{ path: string; reason: string }>
  recursive: boolean
}

interface Capabilities {
  /** The handle writes at `options.start` (uploads only). */
  canOffsetWrite: boolean
  /** The handle can shrink a remote file back to its durable prefix. */
  canTruncate: boolean
  /** Uploads may run more than one range at a time. */
  parallelUpload: boolean
}

interface RunState {
  opId: string
  handle: SftpHandle
  client: SftpClient
  request: TransferRequest
  opts: ResolvedTransferOptions
  reporter: ProgressReporter
  signal: AbortSignal
  direction: TransferDirection
  capabilities: Capabilities
  logger?: TransferLogger
  preserveMode: boolean
  /** Planned files, so an abort can report the durable offset of the whole op. */
  files: PlannedFile[]
  /** Path currently in flight, for diagnostics. */
  currentPath?: string
  /**
   * Whether every aborted file was cut back to its durable prefix.
   *
   * `false` only when the restore itself failed — in practice a dropped
   * connection, where the destination may now be *longer* than the bytes that are
   * known good. The abort report then says `resumable: false` instead of
   * promising a resume that would skip a hole.
   */
  resumeSafe: boolean
}

function abortedError(): Error {
  const error = new Error('the operation was aborted')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortedError()
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Resolve per-transfer settings: defaults → request → clamps. */
export function resolveTransferOptions(
  defaults: TransferEngineDefaults = {},
  overrides: TransferOptionOverrides = {},
  extra: { offsetWrite?: OffsetWriteMode; maxDepth?: number; progressByteThreshold?: number } = {},
): ResolvedTransferOptions {
  return {
    chunkBytes: clampInt(overrides.chunkBytes ?? defaults.chunkBytes, 262144, MIN_CHUNK_BYTES, MAX_CHUNK_BYTES),
    concurrency: clampInt(overrides.concurrency ?? defaults.maxConcurrentChunks, 4, 1, MAX_CONCURRENCY),
    resume: overrides.resume ?? defaults.resume ?? true,
    verify: normaliseVerify(overrides.verify ?? defaults.verify),
    overwrite: overrides.overwrite ?? false,
    followSymlinks: overrides.followSymlinks ?? defaults.followSymlinks ?? false,
    progressIntervalMs: clampInt(
      overrides.progressIntervalMs ?? defaults.progressIntervalMs,
      DEFAULT_PROGRESS_INTERVAL_MS,
      1,
      60_000,
    ),
    progressByteThreshold: clampInt(extra.progressByteThreshold, DEFAULT_PROGRESS_BYTE_THRESHOLD, 1, Number.MAX_SAFE_INTEGER),
    maxDepth: clampInt(extra.maxDepth, DEFAULT_MAX_DEPTH, 1, 512),
    offsetWrite: extra.offsetWrite ?? 'auto',
    // Safety defaults: the gate is on unless a composition turns it off, and the
    // protected list is empty only when the caller supplied none (tests, or an
    // embedder that has its own policy).
    confirmDangerous: defaults.confirmDangerous ?? true,
    protectedLocalPaths: defaults.protectedLocalPaths ?? [],
  }
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const usable = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(max, Math.max(min, usable))
}

function normaliseVerify(value: TransferVerify | undefined): TransferVerify {
  return value === 'none' || value === 'sha256' || value === 'size+mtime' ? value : 'size+mtime'
}

/** Split `[offset, size)` into contiguous ranges, at most one per worker. */
export function buildRanges(offset: number, size: number, concurrency: number, chunkBytes: number): RangeState[] {
  const remaining = size - offset
  if (remaining <= 0) return []
  const maxRanges = Math.max(1, Math.ceil(remaining / chunkBytes))
  const count = Math.max(1, Math.min(Math.max(1, Math.trunc(concurrency)), maxRanges))
  const per = Math.ceil(remaining / count)
  const ranges: RangeState[] = []
  for (let index = 0; index < count; index++) {
    const start = offset + index * per
    if (start >= size) break
    ranges.push({ start, end: Math.min(size, start + per), committed: 0 })
  }
  return ranges
}

/**
 * The durable, contiguous prefix of a planned file: what a resume may trust.
 *
 * Ranges are contiguous by construction and each worker writes its range in
 * order, so walking them from the start and stopping at the first gap is exact.
 */
export function durableOffset(file: { resumedFrom: number; size: number; ranges: RangeState[] }): number {
  let position = file.resumedFrom
  for (const range of file.ranges) {
    if (range.start > position) break
    position = range.start + range.committed
    if (range.committed < range.end - range.start) break
  }
  return Math.min(position, file.size)
}

/**
 * Move the progress sink forward by however much the durable prefix grew.
 *
 * Reporting *written* bytes would be wrong the moment a transfer is retried: the
 * second attempt rewrites bytes that were written but never made durable, so a
 * per-chunk counter would exceed the plan total and break the ICD §3 monotone
 * guarantee. Counting the durable prefix instead makes `transferred` exactly the
 * bytes this operation has provably committed, once each.
 */
function reportDurableProgress(file: PlannedFile, reporter: ProgressReporter): void {
  const durable = durableOffset(file)
  if (durable <= file.reportedDurable) return
  const delta = durable - file.reportedDurable
  file.reportedDurable = durable
  reporter.advance(delta)
}

// ---------------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------------

const probeCache = new WeakMap<object, Promise<boolean>>()

/**
 * Can this handle write at an offset?
 *
 * An explicit `supportsOffsetWrite()` declaration wins (our adapter answers
 * `true` because ssh2 honours `options.start`); otherwise the handle is probed
 * **once per handle** by writing a marker at offset 8 of a scratch file and
 * reading it back. Anything unexpected — including a probe that cannot run
 * because the directory is read-only — answers `false`, which degrades the
 * upload to a single ordered range rather than risking a silently misplaced
 * write.
 */
async function canOffsetWrite(
  handle: SftpHandle,
  probeDirectory: string,
  mode: OffsetWriteMode,
  logger?: TransferLogger,
): Promise<boolean> {
  if (mode === 'disable') return false
  if (mode === 'require') return true
  if (typeof handle.supportsOffsetWrite === 'function') {
    try {
      const declared = handle.supportsOffsetWrite()
      if (typeof declared === 'boolean') return declared
    } catch {
      /* a declaration that throws is simply not a declaration */
    }
  }
  const cached = probeCache.get(handle as unknown as object)
  if (cached !== undefined) return cached
  const pending = probeOffsetWrite(handle, probeDirectory).catch(() => false)
  probeCache.set(handle as unknown as object, pending)
  const supported = await pending
  logger?.debug(`dsh-ssh: offset-write probe on this SFTP handle: ${supported ? 'supported' : 'unsupported'}`)
  return supported
}

async function probeOffsetWrite(handle: SftpHandle, directory: string): Promise<boolean> {
  const dir = remoteDirname(directory === '' ? '/' : directory)
  const name = remoteJoin(dir, `.dsh-ssh-probe-${process.pid.toString(36)}-${randomBytes(4).toString('hex')}`)
  const head = Buffer.alloc(8, 0x41)
  const marker = Buffer.alloc(8, 0x5a)
  try {
    await writeStreamOnce(handle.createWriteStream(name, { flags: 'w' }), head)
    await writeStreamOnce(handle.createWriteStream(name, { flags: 'r+', start: 8 }), marker)
    const read = await collectStream(handle.createReadStream(name, { start: 0, end: 15 }), new AbortController().signal, 16)
    return read.subarray(0, 8).equals(head) && read.subarray(8, 16).equals(marker)
  } catch {
    return false
  } finally {
    try {
      await handle.remove(name)
    } catch {
      /* a scratch file that cannot be removed must not fail a transfer */
    }
  }
}

/**
 * Write one buffer, wait for the ACK, then end and wait for the stream to close.
 *
 * `buffer.length === 0` skips the write entirely: Node answers an empty write on
 * a byte-mode Writable inconsistently, and there is nothing to send anyway — this
 * is how an empty destination file is created.
 */
async function writeStreamOnce(stream: NodeJS.WritableStream, buffer: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const settle = (error?: unknown): void => {
      if (settled) return
      settled = true
      if (error !== undefined && error !== null) reject(error)
      else resolve()
    }
    stream.once('error', settle)
    // An ssh2 SFTP `WriteStream` emits `open`/`ready`/`close` and calls the
    // write/end callbacks, but **never emits `finish`** (its `_final` destroys the
    // stream instead). Waiting only for `finish` therefore hangs forever, which is
    // what a real protocol server exposed and the fs-backed fake could not.
    stream.once('close', () => settle())
    if (buffer.length === 0) {
      stream.end()
      return
    }
    stream.write(buffer, (error?: Error | null) => {
      if (error) settle(error)
      else stream.end()
    })
  })
}

/**
 * Collect a whole readable into one buffer, abort-aware, with an exact
 * expectation and a deadline.
 *
 * `timeoutMs` exists for the same reason as the write-side deadline: a peer that
 * disappears mid-read can leave a stream that never emits `end`.
 */
function collectStream(
  readable: NodeJS.ReadableStream,
  signal: AbortSignal,
  expectedBytes: number,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<Buffer> {
  const raw = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort)
      readable.removeListener('data', onData)
      readable.removeListener('end', onEnd)
      readable.removeListener('error', onError)
    }
    const settle = (error: unknown, value?: Buffer): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error !== undefined && error !== null) reject(error)
      else resolve(value as Buffer)
    }
    const onAbort = (): void => {
      destroyStream(readable)
      settle(abortedError())
    }
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      chunks.push(buffer)
      total += buffer.length
    }
    const onEnd = (): void => {
      const buffer = chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks)
      if (buffer.length !== expectedBytes) {
        settle(
          new SshError('SSH_SFTP_TRANSFER_ABORTED', `expected ${expectedBytes} bytes but read ${buffer.length}`, {
            details: { expectedBytes, readBytes: buffer.length, resumable: true },
          }),
        )
        return
      }
      settle(undefined, buffer)
    }
    const onError = (error: unknown): void => settle(error)

    if (signal.aborted) {
      destroyStream(readable)
      settle(abortedError())
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    readable.on('data', onData)
    readable.on('end', onEnd)
    readable.on('error', onError)
  })
  return withDeadline(raw, timeoutMs, () => {
    destroyStream(readable)
    return new SshError('SSH_TIMEOUT_OPERATION', `the peer did not deliver ${expectedBytes} bytes in time`, {
      details: { expectedBytes, timeoutMs },
    })
  })
}

/**
 * Write one chunk and wait for ssh2 to ACK it (the write callback).
 *
 * Deadline-bounded: when a peer dies without closing the channel, ssh2 never
 * calls the write callback, and an unbounded await here is what turns a broken
 * link into a transfer that hangs forever.
 */
function writeToStream(stream: NodeJS.WritableStream, buffer: Buffer, signal: AbortSignal, timeoutMs: number): Promise<void> {
  if (signal.aborted) return Promise.reject(abortedError())
  const raw = new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: unknown): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      if (error !== undefined && error !== null) reject(error)
      else resolve()
    }
    const onAbort = (): void => {
      destroyStream(stream)
      finish(abortedError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    stream.write(buffer, (error?: Error | null) => finish(error ?? undefined))
  })
  return withDeadline(raw, timeoutMs, () => {
    destroyStream(stream)
    return new SshError('SSH_TIMEOUT_OPERATION', `the peer did not acknowledge ${buffer.length} bytes in time`, {
      details: { bytes: buffer.length, timeoutMs },
    })
  })
}

/**
 * `end()` + wait for the stream to be done, so the last ACK is observed before we
 * move on.
 *
 * Completion is `close` **or** `finish`: ssh2's SFTP `WriteStream` only emits
 * `close`, while a `node:fs` write stream only emits `finish`. Whichever the
 * implementation produces is treated as "all writes acknowledged"; an `error`
 * always wins if it arrives.
 */
function endStream(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: unknown): void => {
      if (settled) return
      settled = true
      if (error !== undefined && error !== null) reject(error)
      else resolve()
    }
    stream.once('error', finish)
    stream.once('finish', () => finish())
    stream.once('close', () => finish())
    stream.end()
  })
}

/** Link `from` to `to`: aborting the outer signal aborts the inner controller. */
function forwardAbort(from: AbortSignal, to: AbortController): () => void {
  if (from.aborted) {
    to.abort()
    return () => undefined
  }
  const onAbort = (): void => to.abort()
  from.addEventListener('abort', onAbort, { once: true })
  return () => from.removeEventListener('abort', onAbort)
}

/**
 * Bound a promise that cleans up after a failure.
 *
 * The underlying operation is not cancelled (Node has no way to abort an SFTP
 * request in flight); it is simply abandoned, which is safe here because the only
 * caller is a repair step whose result is already optional.
 */
function withDeadline<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(onTimeout())
    }, ms)
    timer.unref?.()
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class TransferEngine {
  private readonly options: TransferEngineOptions

  constructor(options: TransferEngineOptions = {}) {
    this.options = options
  }

  /** Effective options for one request (the manager reports them too). */
  resolvedOptions(overrides: TransferOptionOverrides = {}): ResolvedTransferOptions {
    return resolveTransferOptions(this.options.defaults ?? {}, overrides, {
      offsetWrite: this.options.offsetWrite,
      maxDepth: this.options.maxDepth,
      progressByteThreshold: this.options.progressByteThreshold,
    })
  }

  /**
   * Run one transfer to completion.
   *
   * Resolves with the outcome on success. Rejects with an `SshError`:
   * `SSH_SFTP_TARGET_EXISTS` (conflict with `overwrite: false`),
   * `SSH_SFTP_TRANSFER_ABORTED` (aborted mid-flight; `details.resumedFrom` is the
   * resumable offset), `SSH_SFTP_VERIFY_MISMATCH`, `SSH_CANCELLED`,
   * `SSH_SFTP_NO_SUCH_FILE`, `SSH_PERM_LOCAL_DENIED`, …
   */
  async run(handle: SftpHandle, request: TransferRequest, context: TransferRunContext = {}): Promise<TransferOutcome> {
    this.validate(request)
    const opId = context.opId ?? newOpId()
    const opts = this.resolvedOptions({
      ...(request.chunkBytes === undefined ? {} : { chunkBytes: request.chunkBytes }),
      ...(request.concurrency === undefined ? {} : { concurrency: request.concurrency }),
      ...(request.resume === undefined ? {} : { resume: request.resume }),
      ...(request.verify === undefined ? {} : { verify: request.verify }),
      ...(request.overwrite === undefined ? {} : { overwrite: request.overwrite }),
    })
    // A request that can read or write one of the plugin's own trust anchors is
    // refused before any filesystem work happens — for both directions, because
    // an upload of `known_hosts` leaks it just as a download onto it corrupts it.
    if (isProtectedLocalPath(request.localPath, opts.protectedLocalPaths)) {
      throw new SshError('SSH_CFG_INVALID', `refusing to touch a file the plugin relies on: ${request.localPath}`, {
        details: { localPath: request.localPath, reason: 'protected-path', direction: request.direction },
      })
    }
    const reporter = new ProgressReporter({
      intervalMs: opts.progressIntervalMs,
      byteThreshold: opts.progressByteThreshold,
      ...(this.options.clock === undefined ? {} : { clock: this.options.clock }),
      ...(request.onProgress === undefined ? {} : { onProgress: request.onProgress }),
    })
    const client = new SftpClient(handle, {
      followSymlinks: opts.followSymlinks,
      maxDepth: opts.maxDepth,
      ...(this.options.logger === undefined ? {} : { logger: this.options.logger }),
    })
    const state: RunState = {
      opId,
      handle,
      client,
      request,
      opts,
      reporter,
      signal: request.signal ?? new AbortController().signal,
      direction: request.direction,
      capabilities: await this.#capabilities(handle, request, opts),
      ...(this.options.logger === undefined ? {} : { logger: this.options.logger }),
      preserveMode: this.options.preserveMode === true,
      files: [],
      resumeSafe: true,
    }

    const startedAt = Date.now()
    reporter.begin(undefined, 'scan')
    try {
      const plan = await this.#plan(state)
      state.files = plan.files

      // Scan phase: create the destination shape and decide the exact offsets.
      // Doing it before `setTotal` is what keeps `totalBytes` exact — the ICD
      // forbids changing it once it is known.
      for (const directory of plan.directories) await this.#createDirectory(state, directory)
      for (const file of plan.files) {
        if (file.entry.skipped === true) continue
        await this.#prepareDestination(state, file)
        reporter.touch()
      }
      const totalBytes = plan.files.reduce(
        (sum, file) => sum + (file.entry.skipped === true ? 0 : Math.max(0, file.size - file.resumedFrom)),
        0,
      )
      const resumedFrom = plan.files.reduce(
        (sum, file) => sum + (file.entry.skipped === true ? 0 : file.resumedFrom),
        0,
      )
      reporter.setTotal(totalBytes)
      reporter.setPhase('transfer')

      for (const file of plan.files) {
        if (file.entry.skipped === true) continue
        if (file.size - file.resumedFrom <= 0) continue
        // `transferred` is accumulated inside `#transferFile` (a link-class retry
        // moves additional bytes within the same operation, so it cannot be
        // derived from the resumed offset afterwards).
        await this.#transferFile(state, file)
      }

      reporter.setPhase('finalize')
      if (state.preserveMode) {
        for (const file of plan.files) {
          if (file.entry.skipped === true || file.mode === '' || file.mode === '0000') continue
          await this.#chmod(state, file.remotePath, file.mode)
        }
      }

      reporter.setPhase('verify')
      const digest = await this.#verify(state, plan)
      reporter.flush()
      reporter.stop()

      const durationMs = Date.now() - startedAt
      const snapshot = reporter.snapshot()
      const outcome: TransferOutcome = {
        opId,
        direction: request.direction,
        localPath: request.localPath,
        remotePath: request.remotePath,
        resumedFrom,
        transferred: snapshot.transferred,
        totalBytes,
        bytesPerSec: snapshot.bytesPerSec,
        durationMs,
        verify: opts.verify,
        entries: plan.files.map((file) => file.entry),
        skipped: plan.skipped,
      }
      if (digest !== undefined) outcome.sha256 = digest
      state.logger?.debug(
        `dsh-ssh: ${request.direction} done (${outcome.transferred}/${outcome.totalBytes} bytes, ` +
          `${durationMs}ms, resume=${outcome.resumedFrom}, verify=${opts.verify})`,
      )
      return outcome
    } catch (error) {
      reporter.stop()
      throw this.#asTransferError(error, state, startedAt)
    }
  }

  /** Deadline for one chunk operation; also used to bound the capability probe. */
  #chunkTimeoutMs(): number {
    return clampInt(this.options.chunkTimeoutMs, DEFAULT_CHUNK_TIMEOUT_MS, 1, 30 * 60_000)
  }

  private validate(request: TransferRequest): void {
    const fail = (message: string, field: string): never => {
      throw new SshError('SSH_CFG_INVALID', message, { details: { field } })
    }
    if (request.direction !== 'upload' && request.direction !== 'download') {
      fail(`unknown transfer direction "${String(request.direction)}"`, 'direction')
    }
    if (typeof request.localPath !== 'string' || request.localPath.trim() === '') fail('localPath is required', 'localPath')
    if (typeof request.remotePath !== 'string' || request.remotePath.trim() === '') fail('remotePath is required', 'remotePath')
  }

  async #capabilities(
    handle: SftpHandle,
    request: TransferRequest,
    opts: ResolvedTransferOptions,
  ): Promise<Capabilities> {
    const canTruncate = typeof (handle as { truncate?: unknown }).truncate === 'function'
    const offsetWrite =
      request.direction === 'upload'
        ? await canOffsetWrite(handle, request.remotePath, opts.offsetWrite, this.options.logger)
        : true
    return {
      canOffsetWrite: offsetWrite,
      canTruncate,
      // A parallel upload needs both: offsets to place each range, and a way to
      // cut the file back to its durable prefix if the transfer dies.
      parallelUpload: offsetWrite && canTruncate && opts.concurrency > 1,
    }
  }

  // -------------------------------------------------------------------------
  // Planning
  // -------------------------------------------------------------------------

  async #plan(state: RunState): Promise<TransferPlan> {
    return state.direction === 'upload' ? await this.#planUpload(state) : await this.#planDownload(state)
  }

  async #planUpload(state: RunState): Promise<TransferPlan> {
    const { request, opts, signal } = state
    const rootStats = await lstatLocal(request.localPath)
    if (rootStats === undefined) {
      throw toSftpError(codedError('ENOENT', `the local source does not exist: ${request.localPath}`), {
        op: 'upload',
        path: request.localPath,
        local: true,
      })
    }
    // The explicitly requested root is followed even when links are not: asking
    // to upload a symlink means asking for its content.
    let root = rootStats
    if (rootStats.isSymbolicLink()) {
      const followed = await statLocal(request.localPath)
      if (followed === undefined) {
        throw toSftpError(codedError('ENOENT', `the local source is a dangling symlink: ${request.localPath}`), {
          op: 'upload',
          path: request.localPath,
          local: true,
        })
      }
      root = followed
    }
    const rootType = typeOfStat(root)
    const plan: TransferPlan = { files: [], directories: [], skipped: [], recursive: rootType === 'dir' }

    if (rootType === 'file') {
      plan.files.push(
        await this.#planUploadFile(state, {
          localPath: request.localPath,
          remotePath: remoteNormalize(request.remotePath),
          size: root.size,
          mode: formatMode(root.mode),
        }),
      )
    } else if (rootType === 'dir') {
      const tree = await listLocalTree(request.localPath, {
        followSymlinks: opts.followSymlinks,
        maxDepth: opts.maxDepth,
        signal,
        onEntry: () => state.reporter.touch(),
      })
      for (const entry of tree) {
        throwIfAborted(signal)
        const destination = joinUnder(request.remotePath, entry.relPath)
        if (entry.type === 'dir') {
          plan.directories.push({ localPath: entry.path, remotePath: destination })
          continue
        }
        if (entry.isSymlink || entry.type === 'symlink') {
          plan.skipped.push({ path: entry.path, reason: 'symlink (sftp.followSymlinks is false)' })
          continue
        }
        if (entry.type !== 'file') {
          plan.skipped.push({ path: entry.path, reason: `unsupported entry type: ${entry.type}` })
          continue
        }
        plan.files.push(await this.#planUploadFile(state, sourceOf(entry, destination)))
      }
    } else {
      plan.skipped.push({ path: request.localPath, reason: `unsupported entry type: ${rootType}` })
    }
    return plan
  }

  async #planUploadFile(
    state: RunState,
    source: { localPath: string; remotePath: string; size: number; mode: string },
  ): Promise<PlannedFile> {
    const { client, signal } = state
    const destination = await client.stat(source.remotePath, signal)
    if (destination.exists && destination.type === 'dir') {
      throw new SshError('SSH_SFTP_IS_A_DIRECTORY', `the remote destination is a directory: ${source.remotePath}`, {
        details: { path: source.remotePath, direction: 'upload' },
      })
    }
    const decision = await this.#decideDestination(state, {
      path: source.remotePath,
      destinationExists: destination.exists,
      destinationSize: destination.size,
      sourceSize: source.size,
    })
    if (decision.skip) {
      return skippedFile(source.localPath, decision.path, source.size, source.mode)
    }
    return plannedFile({ ...source, remotePath: decision.path }, decision.resumedFrom)
  }

  async #planDownload(state: RunState): Promise<TransferPlan> {
    const { request, opts, client, signal } = state
    const rootInfo = await client.stat(request.remotePath, signal)
    if (!rootInfo.exists) {
      throw toSftpError(codedError(2, `no such file or directory: ${request.remotePath}`), {
        op: 'download',
        path: request.remotePath,
      })
    }
    const plan: TransferPlan = { files: [], directories: [], skipped: [], recursive: rootInfo.type === 'dir' }

    if (rootInfo.type === 'file') {
      plan.files.push(
        await this.#planDownloadFile(state, {
          remotePath: remoteNormalize(request.remotePath),
          localPath: request.localPath,
          size: rootInfo.size,
          mode: rootInfo.mode,
        }),
      )
    } else if (rootInfo.type === 'dir') {
      const tree = await client.walk(request.remotePath, {
        followSymlinks: opts.followSymlinks,
        maxDepth: opts.maxDepth,
        signal,
        onEntry: () => state.reporter.touch(),
      })
      for (const node of tree) {
        throwIfAborted(signal)
        const localPath = joinLocalUnder(request.localPath, node.relPath)
        if (node.type === 'dir') {
          plan.directories.push({ localPath, remotePath: node.path })
          continue
        }
        if (node.isSymlink || node.type === 'symlink') {
          plan.skipped.push({ path: node.path, reason: 'symlink (sftp.followSymlinks is false)' })
          continue
        }
        if (node.type !== 'file') {
          plan.skipped.push({ path: node.path, reason: `unsupported entry type: ${node.type}` })
          continue
        }
        plan.files.push(
          await this.#planDownloadFile(state, {
            remotePath: node.path,
            localPath,
            size: node.size,
            mode: node.mode,
          }),
        )
      }
    } else {
      plan.skipped.push({ path: request.remotePath, reason: `unsupported entry type: ${rootInfo.type}` })
    }
    return plan
  }

  async #planDownloadFile(
    state: RunState,
    source: { remotePath: string; localPath: string; size: number; mode: string },
  ): Promise<PlannedFile> {
    const localInfo = await lstatLocal(source.localPath)
    if (localInfo !== undefined && typeOfStat(localInfo) === 'dir') {
      throw new SshError('SSH_SFTP_IS_A_DIRECTORY', `the local destination is a directory: ${source.localPath}`, {
        details: { path: source.localPath, direction: 'download', side: 'local' },
      })
    }
    const decision = await this.#decideDestination(state, {
      path: source.localPath,
      destinationExists: localInfo !== undefined,
      destinationSize: localInfo?.size ?? 0,
      sourceSize: source.size,
    })
    if (decision.skip) {
      return skippedFile(decision.path, source.remotePath, source.size, source.mode)
    }
    return plannedFile({ ...source, localPath: decision.path }, decision.resumedFrom)
  }

  /**
   * Resume or conflict, decided from sizes alone — never from a caught error
   * (SFTP v3 cannot distinguish "exists" from a generic failure).
   *
   * `SSH_SFTP_TARGET_EXISTS` is raised only when the request neither allows
   * overwriting nor supplies `onConflict`: that is the ICD §4.5 flow where the UI
   * asks the user and re-sends the request.
   */
  async #decideDestination(
    state: RunState,
    input: { path: string; destinationExists: boolean; destinationSize: number; sourceSize: number },
  ): Promise<{ resumedFrom: number; skip: boolean; path: string }> {
    const { opts, request, direction, capabilities, client } = state
    const { path, destinationExists, destinationSize, sourceSize } = input
    if (!destinationExists) return { resumedFrom: 0, skip: false, path }
    // An empty destination is not a conflict: nothing can be lost by writing it.
    if (destinationSize === 0 || sourceSize === 0) return { resumedFrom: 0, skip: false, path }

    // Resume must *place* bytes at an offset: uploads need an offset-capable
    // handle, downloads only need positional local writes.
    const canResume = direction === 'download' || capabilities.canOffsetWrite
    if (opts.resume && canResume && destinationSize < sourceSize) {
      // Appending into a destination we did not create is only safe when the
      // caller said so. Sizes alone cannot tell a truncated download from an
      // unrelated file that happens to be smaller, and treating the latter as a
      // partial transfer silently corrupts it — so `confirmDangerous` (default
      // true) routes the decision through the conflict path below, which either
      // has an explicit `overwrite: true` or raises SSH_SFTP_TARGET_EXISTS for
      // the caller to confirm and re-send (ICD §4.5).
      if (!opts.confirmDangerous || opts.overwrite) {
        return { resumedFrom: destinationSize, skip: false, path }
      }
    } else if (opts.resume && destinationSize === sourceSize) {
      // Already the right length: nothing to move, `verify` decides whether it is
      // actually correct (it is the only check that can tell).
      return { resumedFrom: destinationSize, skip: false, path }
    }

    let decision: ConflictDecision
    if (opts.overwrite) {
      decision = 'overwrite'
    } else if (request.onConflict !== undefined) {
      decision = await request.onConflict({ path, remoteSize: destinationSize, localSize: sourceSize })
    } else {
      throw targetExists({
        path,
        remoteSize: destinationSize,
        localSize: sourceSize,
        direction,
        resumable: opts.resume && canResume,
      })
    }
    if (decision === 'skip') return { resumedFrom: 0, skip: true, path }
    if (decision === 'cancel') {
      throw cancelledTransfer({
        opId: state.opId,
        direction,
        localPath: request.localPath,
        remotePath: request.remotePath,
      })
    }
    if (decision === 'rename') {
      const renamed = direction === 'download' ? await freeLocalName(path) : await freeRemoteName(client, path)
      return { resumedFrom: 0, skip: false, path: renamed }
    }
    return { resumedFrom: 0, skip: false, path }
  }

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  async #createDirectory(state: RunState, directory: PlannedDirectory): Promise<void> {
    throwIfAborted(state.signal)
    if (state.direction === 'upload') {
      await state.client.mkdir(directory.remotePath, { recursive: true })
    } else {
      await ensureLocalDir(directory.localPath)
    }
  }

  /** Create or truncate the destination so that exactly `resumedFrom` bytes remain. */
  async #prepareDestination(state: RunState, file: PlannedFile): Promise<void> {
    throwIfAborted(state.signal)
    if (file.resumedFrom === 0) {
      if (state.direction === 'upload') {
        await writeStreamOnce(state.handle.createWriteStream(file.remotePath, { flags: 'w' }), Buffer.alloc(0))
      } else {
        await createOrTruncateLocalFile(file.localPath)
      }
      return
    }
    if (state.direction === 'download') {
      // The planner resumed from the local file's size; if anything wrote to it
      // in between, restarting is the only safe answer.
      const info = await lstatLocal(file.localPath)
      if (info === undefined || info.size !== file.resumedFrom) {
        file.resumedFrom = 0
        file.entry.resumedFrom = 0
        await createOrTruncateLocalFile(file.localPath)
      }
    }
  }

  /**
   * Move one file, with a bounded resume-retry for link-class failures.
   *
   * Each attempt moves `[durable, size)`; the durable prefix is recomputed from
   * the range ledger, so an attempt never re-sends bytes that were acknowledged
   * and never skips one. `transferred` therefore stays monotone and `totalBytes`
   * (fixed by the plan) is untouched, which is what lets a retry stay invisible to
   * the progress bar except for a brief stall.
   */
  async #transferFile(state: RunState, file: PlannedFile): Promise<void> {
    const { opts, reporter } = state
    const initialResumedFrom = file.resumedFrom
    const retry = this.#linkRetry()
    for (let attempt = 0; ; attempt++) {
      const failed = await this.#attemptFile(state, file, attempt === 0 ? opts.concurrency : retry.concurrency)
      // Bytes moved across every attempt: from the original resume point to the
      // final durable offset. No byte is counted twice.
      file.entry.transferred = Math.max(0, durableOffset(file) - initialResumedFrom)
      if (failed === undefined) {
        reporter.flush()
        return
      }
      const retriable = this.#shouldRetryLinkFailure(state, failed, attempt, retry.attempts)
      if (!retriable) throw failed
      // Resume inside the same operation: the plan's `totalBytes` stays valid and
      // the reporter keeps counting up from where it stopped. `reportedDurable`
      // follows the new durable prefix, so the bytes this attempt rewrites are
      // not counted a second time.
      file.resumedFrom = durableOffset(file)
      state.logger?.warn(
        `dsh-ssh: retrying ${file.remotePath} from the durable offset ${file.resumedFrom} ` +
          `with concurrency ${retry.concurrency} (attempt ${attempt + 2}/${retry.attempts + 1})`,
      )
    }
  }

  /** One attempt over the remaining bytes; resolves with the failure, if any. */
  async #attemptFile(state: RunState, file: PlannedFile, concurrency: number): Promise<unknown | undefined> {
    const { opts, signal, reporter } = state
    const parallel = state.direction === 'download' ? concurrency : state.capabilities.parallelUpload ? concurrency : 1
    const ranges = buildRanges(file.resumedFrom, file.size, parallel, opts.chunkBytes)
    file.ranges = ranges
    if (ranges.length === 0) return undefined
    state.currentPath = file.localPath
    state.logger?.debug(
      `dsh-ssh: transfer ${file.localPath} <-> ${file.remotePath} ` +
        `${file.resumedFrom}/${file.size} bytes in ${ranges.length} range(s) of ${opts.chunkBytes}`,
    )

    const controller = new AbortController()
    const unlink = forwardAbort(signal, controller)
    let firstError: unknown
    const workers = ranges.map((range) =>
      (async (): Promise<void> => {
        try {
          if (state.direction === 'upload') await this.#uploadRange(state, file, range, controller.signal)
          else await this.#downloadRange(state, file, range, controller.signal)
        } catch (error) {
          if (firstError === undefined) firstError = error
          controller.abort()
          throw error
        }
      })(),
    )
    try {
      // allSettled, not all: the destination must be quiescent before it is
      // truncated, and `all` would return while other workers were still writing.
      await Promise.allSettled(workers)
    } finally {
      unlink()
    }
    if (firstError === undefined) {
      reporter.flush()
      return undefined
    }
    const restored = await this.#restoreDurableLength(state, file)
    if (!restored) state.resumeSafe = false
    return firstError
  }

  /** Effective retry policy for link-class failures. */
  #linkRetry(): { attempts: number; concurrency: number } {
    const configured = this.options.linkRetry ?? DEFAULT_LINK_RETRY
    return {
      attempts: clampInt(configured.attempts, DEFAULT_LINK_RETRY.attempts, 0, 3),
      concurrency: clampInt(configured.concurrency, DEFAULT_LINK_RETRY.concurrency, 1, MAX_CONCURRENCY),
    }
  }

  /**
   * Retry only what a retry can actually fix.
   *
   * Never after a caller abort (the user asked to stop), never when the durable
   * prefix could not be restored (`resumeSafe === false`: a retry would have to
   * skip bytes it cannot trust), and never for a *definitive* failure —
   * a conflict, a missing path, a permission error or a digest mismatch will
   * reproduce identically, so retrying only wastes the user's time.
   */
  #shouldRetryLinkFailure(
    state: RunState,
    error: unknown,
    attempt: number,
    attempts: number,
  ): boolean {
    if (attempt >= attempts) return false
    if (state.signal.aborted) return false
    if (!state.resumeSafe) return false
    if (error instanceof SshError) {
      const definitive = new Set([
        'SSH_SFTP_TARGET_EXISTS',
        'SSH_SFTP_IS_A_DIRECTORY',
        'SSH_SFTP_NO_SUCH_FILE',
        'SSH_SFTP_VERIFY_MISMATCH',
        'SSH_CFG_INVALID',
        'SSH_PERM_DENIED',
        'SSH_PERM_LOCAL_DENIED',
        'SSH_CANCELLED',
      ])
      if (definitive.has(error.code)) return false
    }
    return true
  }

  async #uploadRange(state: RunState, file: PlannedFile, range: RangeState, signal: AbortSignal): Promise<void> {
    const { handle, opts, reporter } = state
    let reader: FileHandle
    try {
      reader = await openLocal(file.localPath, 'r')
    } catch (error) {
      throw toSftpError(error, { op: 'upload', path: file.localPath, local: true })
    }
    try {
      // Created inside the `try` so the reader can never outlive a throw from the
      // stream factory: a leaked descriptor keeps the event loop alive and shows
      // up as a GC warning rather than a failure.
      const stream = handle.createWriteStream(file.remotePath, { flags: 'r+', start: range.start })
      // Permanent sink for late transport errors: once `writeToStream` has settled
      // (or been abandoned by an abort) a subsequent error on this stream would
      // otherwise be an unhandled 'error' event, which crashes the process instead
      // of failing the transfer.
      stream.on('error', () => undefined)
      try {
        for (let position = range.start; position < range.end; position += opts.chunkBytes) {
          throwIfAborted(signal)
          const length = Math.min(opts.chunkBytes, range.end - position)
          let buffer: Buffer
          try {
            buffer = await readExactly(reader, length, position, signal)
          } catch (error) {
            throw toSftpError(error, { op: 'upload-read', path: file.localPath, local: true })
          }
          if (buffer.length !== length) {
            throw new SshError('SSH_SFTP_TRANSFER_ABORTED', 'the local source shrank while it was being uploaded', {
              details: { path: file.localPath, position, expected: length, read: buffer.length, resumable: true },
            })
          }
          await writeToStream(stream, buffer, signal, this.#chunkTimeoutMs())
          range.committed += length
          reportDurableProgress(file, reporter)
        }
        await endStream(stream)
      } catch (error) {
        destroyStream(stream)
        throw error
      }
    } finally {
      await reader.close().catch(() => undefined)
    }
  }

  async #downloadRange(state: RunState, file: PlannedFile, range: RangeState, signal: AbortSignal): Promise<void> {
    const { handle, opts, reporter } = state
    let writer: FileHandle
    try {
      writer = await openLocal(file.localPath, 'r+')
    } catch (error) {
      throw toSftpError(error, { op: 'download', path: file.localPath, local: true })
    }
    try {
      for (let position = range.start; position < range.end; position += opts.chunkBytes) {
        throwIfAborted(signal)
        const length = Math.min(opts.chunkBytes, range.end - position)
        const chunkStream = handle.createReadStream(file.remotePath, { start: position, end: position + length - 1 })
        chunkStream.on('error', () => undefined)
        const buffer = await collectStream(chunkStream, signal, length, this.#chunkTimeoutMs())
        try {
          await writeExactly(writer, buffer, position, signal)
        } catch (error) {
          throw toSftpError(error, { op: 'download-write', path: file.localPath, local: true })
        }
        range.committed += length
        reportDurableProgress(file, reporter)
      }
    } finally {
      await writer.close().catch(() => undefined)
    }
  }

  /**
   * Cut the destination back to its durable prefix so resume-by-size is exact.
   *
   * Returns `false` when the destination could **not** be proven equal to its
   * durable prefix — in practice a connection that died before the truncate could
   * be sent. The caller then withdraws the "resumable" promise rather than let a
   * retry skip a hole.
   */
  async #restoreDurableLength(state: RunState, file: PlannedFile): Promise<boolean> {
    const durable = durableOffset(file)
    if (durable >= file.size) return true
    const timeoutMs = clampInt(this.options.restoreTimeoutMs, DEFAULT_RESTORE_TIMEOUT_MS, 1, 120_000)
    const attempt = async (): Promise<boolean> => {
      if (state.direction === 'upload') {
        const truncate = (state.handle as { truncate?: (path: string, size: number) => Promise<void> }).truncate
        // Without `truncate` the upload ran a single ordered range, so the file
        // length already equals the durable prefix: nothing to restore.
        if (typeof truncate !== 'function') return true
        await truncate.call(state.handle, file.remotePath, durable)
        return true
      }
      await truncateLocal(file.localPath, durable)
      return true
    }
    try {
      return await withDeadline(
        attempt(),
        timeoutMs,
        () =>
          new SshError('SSH_TIMEOUT_OPERATION', `truncating ${file.remotePath} to its durable length timed out`, {
            details: { path: file.remotePath, durable, timeoutMs },
          }),
      )
    } catch (error) {
      state.logger?.warn(
        `dsh-ssh: could not restore ${file.remotePath} to its durable length ${durable}: ${messageOf(error)}; ` +
          'the transfer is reported as not resumable',
      )
      return false
    }
  }

  async #chmod(state: RunState, path: string, mode: string): Promise<void> {
    try {
      await state.client.chmod(path, mode)
    } catch (error) {
      // Permission bits are cosmetic next to the bytes: report, do not fail.
      state.logger?.warn(`dsh-ssh: could not chmod ${path} to ${mode}: ${messageOf(error)}`)
    }
  }

  // -------------------------------------------------------------------------
  // Verification
  // -------------------------------------------------------------------------

  async #verify(state: RunState, plan: TransferPlan): Promise<{ local: string; remote: string } | undefined> {
    const { opts, client, signal } = state
    if (opts.verify === 'none') return undefined
    let single: { local: string; remote: string } | undefined
    for (const file of plan.files) {
      if (file.entry.skipped === true) continue
      throwIfAborted(signal)
      if (opts.verify === 'size+mtime') {
        // The frozen handle has no `utimes`, so a destination's mtime is always
        // the moment it was written: size is what can actually be enforced. The
        // mtime is reported for diagnostics in `TransferEntryResult`.
        let localInfo: Awaited<ReturnType<typeof lstatLocal>>
        try {
          localInfo = await lstatLocal(file.localPath)
        } catch (error) {
          throw toSftpError(error, { op: 'verify-local', path: file.localPath, local: true })
        }
        const remoteInfo = await client.stat(file.remotePath, signal)
        const localSize = localInfo?.size ?? -1
        if (!remoteInfo.exists || localSize !== remoteInfo.size) {
          throw verifyMismatch({
            mode: 'size+mtime',
            localPath: file.localPath,
            remotePath: file.remotePath,
            localSize,
            remoteSize: remoteInfo.exists ? remoteInfo.size : -1,
          })
        }
        continue
      }
      // The local re-read during verification is the moment a source that was
      // removed (or replaced) mid-transfer finally surfaces: an *already open*
      // handle survives removal on every platform, so the failure appears here and
      // must be attributed to the local side rather than reading like a transfer
      // bug. Observed for real: a 28-second upload died with a bare ENOENT after its
      // scratch directory had been deleted underneath it.
      let local: { hex: string; bytes: number }
      try {
        local = await sha256OfFile(file.localPath, signal)
      } catch (error) {
        throw toSftpError(error, { op: 'verify-local', path: file.localPath, local: true })
      }
      const remote = await digestRemote(
        { handle: state.handle, signal, chunkBytes: opts.chunkBytes, chunkTimeoutMs: this.#chunkTimeoutMs() },
        file.remotePath,
        file.size,
      )
      if (local.hex !== remote.hex) {
        throw verifyMismatch({
          mode: 'sha256',
          localPath: file.localPath,
          remotePath: file.remotePath,
          localSize: local.bytes,
          remoteSize: remote.bytes,
          localSha256: local.hex,
          remoteSha256: remote.hex,
        })
      }
      file.entry.sha256 = local.hex
      if (plan.files.length === 1) single = { local: local.hex, remote: remote.hex }
    }
    return single
  }

  // -------------------------------------------------------------------------
  // Failure shaping
  // -------------------------------------------------------------------------

  /** Turn whatever ended a transfer into the wire error, with the resume offset. */
  #asTransferError(error: unknown, state: RunState, startedAt: number): SshError {
    if (error instanceof SshError) {
      const passthrough = new Set([
        'SSH_SFTP_VERIFY_MISMATCH',
        'SSH_CFG_INVALID',
        'SSH_SFTP_TARGET_EXISTS',
        'SSH_SFTP_IS_A_DIRECTORY',
        'SSH_SFTP_NO_SUCH_FILE',
        'SSH_PERM_LOCAL_DENIED',
        'SSH_PERM_DENIED',
        'SSH_CANCELLED',
      ])
      if (passthrough.has(error.code)) return error
    }
    const { request, reporter } = state
    const mapped = toSftpError(error, {
      op: request.direction,
      path: request.direction === 'upload' ? request.remotePath : request.localPath,
      local: request.direction === 'download',
    })
    /*
     * Anything that interrupted a transfer *in flight* is reported as
     * `SSH_SFTP_TRANSFER_ABORTED` — the ICD's own wording for this code is
     * "传输中断（可续传）" — and the original network class travels in `details` as
     * the cause. Reporting a bare `SSH_NET_RESET` here would lose the one thing
     * the UI needs to offer a resume: the durable offset.
     */
    const interruption = new Set([
      'SSH_NET_RESET',
      'SSH_NET_TIMEOUT',
      'SSH_NET_UNREACHABLE',
      'SSH_TIMEOUT_OPERATION',
      'SSH_SFTP_TRANSFER_ABORTED',
    ])
    /*
     * ssh2 reports a channel that closed with requests still pending as a bare
     * `Error('No response from server')` with **no code**, which lands on
     * `SSH_UNKNOWN`. That is a link-class interruption, not an opaque unknown: it
     * is precisely what the real-host 100 MiB run produced, and reporting it as
     * `SSH_SFTP_TRANSFER_ABORTED` (with the durable offset and the network cause in
     * `details`) is what lets the UI offer a resume and the retry policy act.
     */
    const looksLikeLinkLoss = isLinkClassCode(mapped.code, mapped.message)
    const isAbort =
      state.signal.aborted ||
      (error instanceof Error && error.name === 'AbortError') ||
      interruption.has(mapped.code) ||
      looksLikeLinkLoss
    if (isAbort) {
      // The offset a retry would start from: every planned file's durable prefix.
      // Re-planning recomputes exactly this from the destination sizes, so the
      // number is actionable — but only while the destination is known to be
      // exactly that long, i.e. while the restore above succeeded.
      const durable = state.files.reduce((sum, file) => sum + durableOffset(file), 0)
      const snapshot = reporter.snapshot()
      const causes = { causeCode: mapped.code, causeMessage: mapped.message }
      return abortedTransfer(
        {
          opId: state.opId,
          direction: request.direction,
          localPath: request.localPath,
          remotePath: request.remotePath,
          resumedFrom: state.resumeSafe ? durable : 0,
          transferred: snapshot.transferred,
          ...(snapshot.totalBytes === undefined ? {} : { totalBytes: snapshot.totalBytes }),
          ...(state.currentPath === undefined ? {} : { entry: state.currentPath }),
          ...causes,
          ...(state.resumeSafe
            ? {}
            : {
                resumable: false,
                resumeHint:
                  'the destination could not be cut back to its known-good prefix (the connection dropped); ' +
                  'retry with overwrite: true instead of resume: true',
              }),
        },
        error,
      )
    }
    state.logger?.warn(`dsh-ssh: ${request.direction} failed after ${Date.now() - startedAt}ms: ${mapped.message}`)
    return mapped
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Source description of a walked local entry.
 *
 * `remotePath` is the *destination* path computed from the entry's relative
 * path: the walk itself only knows local paths, and mapping `relPath` onto the
 * destination root is what preserves the tree's structure.
 */
function sourceOf(
  entry: LocalEntry,
  remotePath: string,
): { localPath: string; remotePath: string; size: number; mode: string } {
  return {
    localPath: entry.path,
    remotePath,
    size: entry.size,
    mode: entry.mode,
  }
}

function plannedFile(
  source: { localPath: string; remotePath: string; size: number; mode: string },
  resumedFrom: number,
): PlannedFile {
  return {
    localPath: source.localPath,
    remotePath: source.remotePath,
    size: source.size,
    resumedFrom,
    mode: source.mode,
    ranges: [],
    entry: {
      localPath: source.localPath,
      remotePath: source.remotePath,
      size: source.size,
      resumedFrom,
      transferred: 0,
    },
    // Bytes kept from a previous run are not progress *of this run*; reporting
    // starts at the resume point and only ever counts bytes this operation made
    // durable.
    reportedDurable: resumedFrom,
  }
}

function skippedFile(localPath: string, remotePath: string, size: number, mode: string): PlannedFile {
  return {
    localPath,
    remotePath,
    size,
    resumedFrom: 0,
    mode,
    ranges: [],
    entry: { localPath, remotePath, size, resumedFrom: 0, transferred: 0, skipped: true },
    reportedDurable: 0,
  }
}

/**
 * Stream a remote file through sha256, verifying the byte count as it goes.
 *
 * Read in `chunkBytes` ranges rather than as one unbounded stream, for three
 * reasons learned from the real host:
 *
 *  - an unbounded whole-file read has **no deadline**, so a stalled link hangs
 *    until the caller's own timeout;
 *  - one stream carrying many outstanding requests is exactly what loses its
 *    channel on a high-latency link (ssh2 answers "No response from server" from
 *    `cleanupRequests` when the channel closes with requests still pending);
 *  - per-chunk reads are abortable, so cancelling a verify is immediate.
 *
 * The stream also gets a permanent no-op `error` listener: a transport error that
 * arrives *after* a chunk settled must never become an unhandled `error` event,
 * which would crash the process instead of failing the operation.
 */
export async function digestRemote(
  state: Pick<RunState, 'handle' | 'signal'> & { chunkBytes?: number; chunkTimeoutMs?: number },
  remotePath: string,
  expectedBytes: number,
): Promise<{ hex: string; bytes: number }> {
  const hash = createHash('sha256')
  const chunkBytes = Math.max(64 * 1024, Math.trunc(state.chunkBytes ?? 1024 * 1024))
  const timeoutMs = state.chunkTimeoutMs ?? DEFAULT_CHUNK_TIMEOUT_MS
  let bytes = 0
  for (let position = 0; position < expectedBytes; position += chunkBytes) {
    const length = Math.min(chunkBytes, expectedBytes - position)
    const stream = state.handle.createReadStream(remotePath, { start: position, end: position + length - 1 })
    stream.on('error', () => undefined)
    const buffer = await collectStream(stream, state.signal, length, timeoutMs)
    hash.update(buffer)
    bytes += buffer.length
  }
  if (bytes !== expectedBytes) {
    throw new SshError('SSH_SFTP_TRANSFER_ABORTED', `expected ${expectedBytes} bytes but read ${bytes}`, {
      details: { expectedBytes, readBytes: bytes, resumable: true },
    })
  }
  return { hex: hash.digest('hex'), bytes }
}

/** Destination path for a walked relative path, remote side. */
function joinUnder(root: string, relPath: string): string {
  return relPath === '' ? remoteNormalize(root) : remoteJoin(root, relPath)
}

/** Destination path for a walked relative path, local side. */
function joinLocalUnder(root: string, relPath: string): string {
  return relPath === '' ? root : localJoin(root, relPath)
}

/** Pick a non-existing sibling name (`report.txt` → `report (1).txt`). */
async function freeRemoteName(client: SftpClient, path: string): Promise<string> {
  for (let index = 1; index <= 1000; index++) {
    const candidate = numberedName(path, index, false)
    if (!(await client.stat(candidate)).exists) return candidate
  }
  throw new SshError('SSH_SFTP_TARGET_EXISTS', `could not find a free name for ${path}`, { details: { path } })
}

async function freeLocalName(path: string): Promise<string> {
  for (let index = 1; index <= 1000; index++) {
    const candidate = numberedName(path, index, true)
    if ((await lstatLocal(candidate)) === undefined) return candidate
  }
  throw new SshError('SSH_SFTP_TARGET_EXISTS', `could not find a free name for ${path}`, { details: { path } })
}

function numberedName(path: string, index: number, local: boolean): string {
  const base = local ? localBasename(path) : remoteBasename(path)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const extension = dot > 0 ? base.slice(dot) : ''
  const named = `${stem} (${index})${extension}`
  if (local) return localJoin(localDirname(path), named)
  return remoteJoin(remoteDirname(path), named)
}

export { joinUnder, joinLocalUnder, numberedName, forwardAbort, sourceOf }
