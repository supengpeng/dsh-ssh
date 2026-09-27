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
import { SftpClient } from './client.js';
import { type LocalEntry } from './local.js';
import { ProgressReporter, type ProgressClock } from './progress.js';
import type { OffsetWriteMode, ResolvedTransferOptions, SftpHandle, TransferDirection, TransferEngineDefaults, TransferEntryResult, TransferLogger, TransferOptionOverrides, TransferOutcome, TransferRequest } from './types.js';
export interface TransferEngineOptions {
    /** `sftp.*` defaults (ICD §6); overridden per request, then clamped. */
    defaults?: TransferEngineDefaults;
    logger?: TransferLogger;
    /** Injectable clock, so the progress cadence is unit-testable. */
    clock?: ProgressClock;
    /** `auto` (declare/probe), `require` or `disable` offset writes. Default `auto`. */
    offsetWrite?: OffsetWriteMode;
    maxDepth?: number;
    progressByteThreshold?: number;
    /** Deadline for the post-failure truncate (default 10 s); never hangs a failure. */
    restoreTimeoutMs?: number;
    /**
     * Deadline for one chunk read/write (default 60 s). Bounds a transfer whose
     * peer vanished without closing the channel; the manager may derive it from
     * `operationTimeoutMs`.
     */
    chunkTimeoutMs?: number;
    /** Apply the source's permission bits to the destination (`chmod`). Off by default. */
    preserveMode?: boolean;
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
    linkRetry?: {
        attempts?: number;
        concurrency?: number;
    };
}
export interface TransferRunContext {
    /** Operation id minted by the manager; the engine only reports it. */
    opId?: string;
}
interface RangeState {
    start: number;
    end: number;
    committed: number;
}
interface PlannedFile {
    localPath: string;
    remotePath: string;
    size: number;
    resumedFrom: number;
    /** Source permission bits, applied with `chmod` only when `preserveMode` is on. */
    mode: string;
    ranges: RangeState[];
    entry: TransferEntryResult;
    /**
     * Highest durable offset already reported to the progress sink.
     *
     * Progress advances by the **durable prefix**, not by bytes written: a retried
     * attempt re-writes bytes that were written but never made durable, and
     * counting those twice would push `transferred` past `totalBytes` — an ICD §3
     * violation ("progress 单调不减，totalBytes 确定后不再变化").
     */
    reportedDurable: number;
}
interface Capabilities {
    /** The handle writes at `options.start` (uploads only). */
    canOffsetWrite: boolean;
    /** The handle can shrink a remote file back to its durable prefix. */
    canTruncate: boolean;
    /** Uploads may run more than one range at a time. */
    parallelUpload: boolean;
}
interface RunState {
    opId: string;
    handle: SftpHandle;
    client: SftpClient;
    request: TransferRequest;
    opts: ResolvedTransferOptions;
    reporter: ProgressReporter;
    signal: AbortSignal;
    direction: TransferDirection;
    capabilities: Capabilities;
    logger?: TransferLogger;
    preserveMode: boolean;
    /** Planned files, so an abort can report the durable offset of the whole op. */
    files: PlannedFile[];
    /** Path currently in flight, for diagnostics. */
    currentPath?: string;
    /**
     * Whether every aborted file was cut back to its durable prefix.
     *
     * `false` only when the restore itself failed — in practice a dropped
     * connection, where the destination may now be *longer* than the bytes that are
     * known good. The abort report then says `resumable: false` instead of
     * promising a resume that would skip a hole.
     */
    resumeSafe: boolean;
}
/** Resolve per-transfer settings: defaults → request → clamps. */
export declare function resolveTransferOptions(defaults?: TransferEngineDefaults, overrides?: TransferOptionOverrides, extra?: {
    offsetWrite?: OffsetWriteMode;
    maxDepth?: number;
    progressByteThreshold?: number;
}): ResolvedTransferOptions;
/** Split `[offset, size)` into contiguous ranges, at most one per worker. */
export declare function buildRanges(offset: number, size: number, concurrency: number, chunkBytes: number): RangeState[];
/**
 * The durable, contiguous prefix of a planned file: what a resume may trust.
 *
 * Ranges are contiguous by construction and each worker writes its range in
 * order, so walking them from the start and stopping at the first gap is exact.
 */
export declare function durableOffset(file: {
    resumedFrom: number;
    size: number;
    ranges: RangeState[];
}): number;
/** Link `from` to `to`: aborting the outer signal aborts the inner controller. */
declare function forwardAbort(from: AbortSignal, to: AbortController): () => void;
export declare class TransferEngine {
    #private;
    private readonly options;
    constructor(options?: TransferEngineOptions);
    /** Effective options for one request (the manager reports them too). */
    resolvedOptions(overrides?: TransferOptionOverrides): ResolvedTransferOptions;
    /**
     * Run one transfer to completion.
     *
     * Resolves with the outcome on success. Rejects with an `SshError`:
     * `SSH_SFTP_TARGET_EXISTS` (conflict with `overwrite: false`),
     * `SSH_SFTP_TRANSFER_ABORTED` (aborted mid-flight; `details.resumedFrom` is the
     * resumable offset), `SSH_SFTP_VERIFY_MISMATCH`, `SSH_CANCELLED`,
     * `SSH_SFTP_NO_SUCH_FILE`, `SSH_PERM_LOCAL_DENIED`, …
     */
    run(handle: SftpHandle, request: TransferRequest, context?: TransferRunContext): Promise<TransferOutcome>;
    private validate;
}
/**
 * Source description of a walked local entry.
 *
 * `remotePath` is the *destination* path computed from the entry's relative
 * path: the walk itself only knows local paths, and mapping `relPath` onto the
 * destination root is what preserves the tree's structure.
 */
declare function sourceOf(entry: LocalEntry, remotePath: string): {
    localPath: string;
    remotePath: string;
    size: number;
    mode: string;
};
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
export declare function digestRemote(state: Pick<RunState, 'handle' | 'signal'> & {
    chunkBytes?: number;
    chunkTimeoutMs?: number;
}, remotePath: string, expectedBytes: number): Promise<{
    hex: string;
    bytes: number;
}>;
/** Destination path for a walked relative path, remote side. */
declare function joinUnder(root: string, relPath: string): string;
/** Destination path for a walked relative path, local side. */
declare function joinLocalUnder(root: string, relPath: string): string;
declare function numberedName(path: string, index: number, local: boolean): string;
export { joinUnder, joinLocalUnder, numberedName, forwardAbort, sourceOf };
//# sourceMappingURL=transfer.d.ts.map