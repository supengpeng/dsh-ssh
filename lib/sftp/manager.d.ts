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
import { TransferEngine, type TransferEngineOptions } from './transfer.js';
import type { OpId, SessionId, SessionLookup, StreamId, TransferDirection, TransferEngineDefaults, TransferEventSink, TransferOptionOverrides, TransferOutcome, TransferProgress, TransferRequest, TransferTaskRecord } from './types.js';
export interface StartTransferParams extends TransferOptionOverrides {
    sessionId: SessionId;
    direction: TransferDirection;
    localPath: string;
    remotePath: string;
    /** Caller-supplied identity from the wire layer; minted here when absent. */
    opId?: OpId;
    streamId?: StreamId;
    /** Merged with `sink.onProgress`; both are optional. */
    onProgress?: (progress: TransferProgress) => void;
    onConflict?: TransferRequest['onConflict'];
    signal?: AbortSignal;
    sink?: TransferEventSink;
}
export interface StartedTransfer {
    streamId: StreamId;
    opId: OpId;
    /** Bytes a previous attempt already moved; `0` for a fresh or directory transfer. */
    resumedFrom: number;
    /** Known up-front for a single file; `undefined` until the scan finishes for a tree. */
    totalBytes?: number;
}
export interface TransferManagerOptions {
    /** Session registry lookup (`ConnectionPool` satisfies it: it has `get`). */
    sessions: SessionLookup;
    /** `sftp.*` defaults from the plugin config (ICD §6). */
    defaults?: TransferEngineDefaults;
    logger?: TransferEngineOptions['logger'];
    clock?: TransferEngineOptions['clock'];
    /** Injectable for tests; a default engine is built otherwise. */
    engine?: TransferEngine;
    /**
     * Bounded resume-retry for link-class failures (see
     * `TransferEngineOptions.linkRetry`); defaults to one retry over a single stream.
     */
    linkRetry?: TransferEngineOptions['linkRetry'];
    now?: () => number;
    /** Called when a transfer ends, for audit/telemetry. Never allowed to throw inward. */
    onSettled?: (record: TransferTaskRecord) => void;
}
export declare class TransferManager {
    #private;
    private readonly options;
    private readonly engine;
    private readonly live;
    private readonly order;
    constructor(options: TransferManagerOptions);
    /** Transfers still running. */
    get active(): number;
    /** The §4.5 handshake: return immediately, report the rest through the sink. */
    start(params: StartTransferParams): Promise<StartedTransfer>;
    /** Run to completion; rejects with the transfer's `SshError` on failure. */
    run(params: StartTransferParams): Promise<TransferOutcome>;
    /**
     * Abort one transfer. Returns `false` for an unknown or already-settled op.
     *
     * A cancelled transfer ends as `SSH_SFTP_TRANSFER_ABORTED` carrying the durable
     * offset, so the UI can offer "resume" instead of restarting from zero.
     */
    cancel(opId: OpId): boolean;
    /** Live + recent tasks, oldest first. Copies, never internals. */
    list(): TransferTaskRecord[];
    get(opId: OpId): TransferTaskRecord | undefined;
    /** Reads a record or throws `SSH_STATE_INVALID` (for `cancelTransfer`). */
    require(opId: OpId): TransferTaskRecord;
    /** Abort everything (plugin unload); safe to call twice. */
    dispose(): void;
}
//# sourceMappingURL=manager.d.ts.map