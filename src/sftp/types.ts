/**
 * SFTP contract — the in-process surface frozen by `docs/ICD.md` §7.2.
 *
 * `SftpHandle` and `TransferRequest` are consumed exactly as frozen: the
 * connection layer hands this module a handle (through the `SftpProvider`
 * factory implemented in `adapter.ts`) and the wire layer hands it a request.
 * Everything else here is the transfer layer's own vocabulary and is free to
 * grow (it is not wire-visible).
 *
 * Three deliberate choices, called out because a reviewer should be able to
 * check them at a glance:
 *
 *  1. `DirEntry` / `FileInfo` are **re-exported** from `src/connection/types.ts`
 *     instead of re-declared. The ICD shape is then defined exactly once, so a
 *     one-sided edit cannot make the remote pane and the local pane disagree.
 *     (`src/api/**` builds local entries with `format.ts` from the same shape.)
 *  2. `createWriteStream` accepts an extra **optional** `start`. Concurrent
 *     chunked uploads must write at an offset, and ssh2 supports it natively
 *     (`SFTP.js` `WriteStream`: `this.pos = options.start`). Because the
 *     parameter is optional, a narrower implementation still type-checks in both
 *     directions (method parameters are bivariant); `transfer.ts` additionally
 *     probes the handle's behaviour and degrades to sequential writes when the
 *     offset is neither declared nor honoured. Raised with the Lead as an
 *     additive ICD item (see `src/sftp/README.md`).
 *  3. Optional `supportsOffsetWrite()` lets a handle *declare* the capability so
 *     the safe fallback proves nothing by accident. The adapter we own returns
 *     `true`; an unknown handle is probed once per handle and otherwise assumed
 *     to be sequential (correct, merely slower).
 */

import type { ErrorInfo } from '../protocol.js'
import type { TransferPhase } from '../protocol.js'
import type { DirEntry, FileInfo, OpId, SessionId, StreamId } from '../connection/types.js'

export type { DirEntry, FileInfo, OpId, SessionId, StreamId } from '../connection/types.js'
export type { TransferPhase } from '../protocol.js'

export type SftpEntryType = DirEntry['type']
export type TransferDirection = 'upload' | 'download'
export type TransferVerify = 'none' | 'size+mtime' | 'sha256'
export type ConflictDecision = 'overwrite' | 'skip' | 'rename' | 'cancel'

/** What `onConflict` receives: both sizes, so a UI can render the difference. */
export interface TransferConflict {
  path: string
  remoteSize: number
  localSize: number
}

/**
 * SFTP session handle (ICD §7.2).
 *
 * `start` on `createWriteStream` and `supportsOffsetWrite` are the additive
 * members described in the module header; every other signature is verbatim.
 */
export interface SftpHandle {
  listDir(path: string, opts?: { showHidden?: boolean; signal?: AbortSignal }): Promise<DirEntry[]>
  stat(path: string, signal?: AbortSignal): Promise<FileInfo>
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>
  rename(from: string, to: string): Promise<void>
  remove(path: string, opts?: { recursive?: boolean }, signal?: AbortSignal): Promise<number>
  chmod(path: string, mode: string): Promise<void>
  createReadStream(path: string, opts?: { start?: number; end?: number }): NodeJS.ReadableStream
  /**
   * `opts` is optional and every field inside it is optional too: "write this
   * file from the beginning" must not require constructing an empty object. The
   * adapter passes the object through to ssh2 **without picking fields**, because
   * dropping `start` silently would break concurrent chunked uploads and resume.
   */
  createWriteStream(path: string, opts?: { flags?: string; mode?: number; start?: number }): NodeJS.WritableStream
  /**
   * Optional capability declaration for offset writes.
   * `true`  — `createWriteStream(path, { flags: 'r+', start })` writes at `start`.
   * `false` — the option is ignored (or unsupported): callers must write
   *           sequentially and restart from 0 instead of resuming.
   * `undefined`/absent — unknown; the engine probes once per handle.
   */
  supportsOffsetWrite?(): boolean | undefined
  /**
   * Optional: shrink (or extend) a remote file to `size` bytes (POSIX truncate).
   *
   * The engine uses it after a failed parallel upload to cut the destination back
   * to its durable prefix, which is what keeps `resumedFrom = destination size`
   * exact (a partially written range can otherwise leave the file longer than
   * the bytes that are known good). When it is absent the engine uploads through
   * a single ordered range instead, which never needs it. Implemented by our
   * adapter through `SFTPWrapper.setstat(path, { size })`.
   */
  truncate?(path: string, size: number): Promise<void>
}

/**
 * One progress sample, field-for-field the payload of the ICD §3 `progress`
 * frame, so the wire layer maps it by spreading instead of by renaming.
 */
export interface TransferProgress {
  transferred: number
  totalBytes?: number
  bytesPerSec: number
  etaMs?: number
  phase: TransferPhase
}

/** One transfer request (ICD §7.2, verbatim). */
export interface TransferRequest {
  direction: TransferDirection
  localPath: string
  remotePath: string
  chunkBytes?: number
  concurrency?: number
  resume?: boolean
  verify?: TransferVerify
  overwrite?: boolean
  signal?: AbortSignal
  onProgress?: (p: TransferProgress) => void
  onConflict?: (c: TransferConflict) => Promise<ConflictDecision>
}

// ---------------------------------------------------------------------------
// Engine vocabulary (not wire-frozen)
// ---------------------------------------------------------------------------

/** `auto` probes the handle once; `require`/`disable` force the decision. */
export type OffsetWriteMode = 'auto' | 'require' | 'disable'

/** Effective per-transfer settings: request overrides on top of `sftp.*` config. */
export interface ResolvedTransferOptions {
  chunkBytes: number
  concurrency: number
  resume: boolean
  verify: TransferVerify
  overwrite: boolean
  followSymlinks: boolean
  progressIntervalMs: number
  /** Emit a progress frame as soon as this many bytes accumulated (ICD §4.5: ≥1 MiB). */
  progressByteThreshold: number
  /** Recursion guard: a tree deeper than this is refused, not silently cut. */
  maxDepth: number
  offsetWrite: OffsetWriteMode
}

/** Overrides accepted by the engine; every field falls back to the config. */
export interface TransferOptionOverrides {
  chunkBytes?: number
  concurrency?: number
  resume?: boolean
  verify?: TransferVerify
  overwrite?: boolean
  followSymlinks?: boolean
  progressIntervalMs?: number
  progressByteThreshold?: number
  maxDepth?: number
  offsetWrite?: OffsetWriteMode
}

/**
 * `sftp.*` configuration subset that seeds transfer defaults (ICD §6).
 *
 * Names match the config keys (`maxConcurrentChunks`) so `resolveConfig()`
 * output can be passed in unchanged.
 */
export interface TransferEngineDefaults {
  chunkBytes?: number
  maxConcurrentChunks?: number
  resume?: boolean
  verify?: TransferVerify
  followSymlinks?: boolean
  progressIntervalMs?: number
}

/** One transferred file, as reported in the outcome (and by `listTransfers`). */
export interface TransferEntryResult {
  localPath: string
  remotePath: string
  size: number
  /** Bytes that already existed and were kept (resume); `0` for a fresh file. */
  resumedFrom: number
  /** Bytes this operation moved for that entry. */
  transferred: number
  /** Set when `verify: 'sha256'` compared the file after the transfer. */
  sha256?: string
  /** Files skipped by a conflict decision (`skip`) or by symlink policy. */
  skipped?: boolean
}

/** Terminal result of one transfer operation. */
export interface TransferOutcome {
  opId: OpId
  direction: TransferDirection
  localPath: string
  remotePath: string
  /** Bytes kept from a previous partial file (sum over entries). */
  resumedFrom: number
  /** Bytes moved by this operation (== `totalBytes` on success). */
  transferred: number
  totalBytes: number
  bytesPerSec: number
  durationMs: number
  verify: TransferVerify
  /** Present when `verify: 'sha256'` ran: both digests, so a mismatch is diagnosable. */
  sha256?: { local: string; remote: string }
  entries: TransferEntryResult[]
  /** Entries the tree walk refused to transfer (symlinks by default, conflicts). */
  skipped: Array<{ path: string; reason: string }>
}

/** Live record behind `sshPlugin/listTransfers` (DESIGN §4 `TransferTask` + extras). */
export interface TransferTaskRecord {
  opId: OpId
  streamId?: StreamId
  sessionId: SessionId
  direction: TransferDirection
  localPath: string
  remotePath: string
  totalBytes?: number
  transferred: number
  phase: TransferPhase | 'done' | 'cancelled' | 'error'
  bytesPerSec: number
  etaMs?: number
  /** Bytes resumed at start-up; refreshed after a directory scan completes. */
  resumeFrom?: number
  /** Digests once `verify: 'sha256'` finished. */
  sha256?: { local: string; remote: string }
  startedAt: string
  finishedAt?: string
  error?: ErrorInfo
}

/** Where the engine reports progress and completion (the wire layer's seam). */
export interface TransferEventSink {
  onProgress?(p: TransferProgress): void
  onEnd?(event: { reason: 'completed' | 'cancelled' | 'error'; error?: ErrorInfo; outcome?: TransferOutcome }): void
}

/** Structured logger (structural mirror of the host logger, so it is injectable). */
export interface TransferLogger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** Minimal session face the manager needs; `SessionHandle` satisfies it structurally. */
export interface SftpSessionSource {
  readonly id: SessionId
  sftp(signal?: AbortSignal): Promise<SftpHandle>
}

/** Session lookup the manager resolves `sessionId` against. */
export interface SessionLookup {
  get(sessionId: SessionId): SftpSessionSource | undefined
}
