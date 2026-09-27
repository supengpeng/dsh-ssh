/**
 * §4.5 SFTP: single-path operations, the dual-pane local half, and transfers.
 *
 * Two wire details are decided here and documented in `src/api/README.md`:
 *
 *   - **A transfer stream carries its handshake in the `open` frame's `meta`.**
 *     §4.5's return value `{ streamId, opId, resumedFrom }` describes a *stream*,
 *     and a Remote stream method's return value is the frame sequence itself, so
 *     `open.meta = { opId, resumedFrom, totalBytes? }`. The UI can label the row
 *     "resuming at 34%" from the very first frame (`resumedFrom` is answered before
 *     the transfer starts — that is the manager's whole reason for two `stat`
 *     calls on a single file).
 *   - **Cancellation answers `{ cancelled: false }` for an unknown or finished op**
 *     rather than throwing. "Nothing to cancel" is a true answer to "cancel this",
 *     and the UI has usually just settled the row itself; turning it into an error
 *     produces a spurious toast.
 */

import { SshError, type ErrorInfo, type Frame, type TransferPhase } from '../protocol.js'
import { newStreamId } from '../connection/ids.js'
import { listLocalDir, statLocal as statLocalFs } from './local-fs.js'
import {
  optionalBoolean,
  optionalNumber,
  optionalString,
  readParams,
  requiredString,
  type Params,
} from './params.js'
import { ApiGroup, sftpClientOf } from './deps.js'
import { FrameQueue } from './frames.js'

/**
 * ICD §4.5 / DESIGN §4 `TransferTask` — the live row behind `listTransfers`.
 *
 * Declared here rather than in `src/protocol.ts` because that file does not carry
 * it yet and this module is its only producer; reported to the Lead so it can be
 * promoted to the frozen wire module (where the client half would then import it).
 */
export interface TransferTaskView {
  opId: string
  direction: 'upload' | 'download'
  localPath: string
  remotePath: string
  totalBytes?: number
  transferred: number
  phase: TransferPhase | 'done' | 'cancelled' | 'error'
  bytesPerSec: number
  etaMs?: number
  resumeFrom?: number
  error?: ErrorInfo
}

/** The frozen `TransferTask` projection (ICD §4.5 / DESIGN §4). */
function toTask(record: {
  opId: string
  direction: 'upload' | 'download'
  localPath: string
  remotePath: string
  totalBytes?: number
  transferred: number
  phase: TransferPhase | 'done' | 'cancelled' | 'error'
  bytesPerSec: number
  etaMs?: number
  resumeFrom?: number
  error?: ErrorInfo
}): TransferTaskView {
  return {
    opId: record.opId,
    direction: record.direction,
    localPath: record.localPath,
    remotePath: record.remotePath,
    ...(record.totalBytes === undefined ? {} : { totalBytes: record.totalBytes }),
    transferred: record.transferred,
    phase: record.phase,
    bytesPerSec: record.bytesPerSec,
    ...(record.etaMs === undefined ? {} : { etaMs: record.etaMs }),
    ...(record.resumeFrom === undefined ? {} : { resumeFrom: record.resumeFrom }),
    ...(record.error === undefined ? {} : { error: record.error }),
  }
}

export class FilesApi extends ApiGroup {
  /** ICD §4.5 `listDir`. */
  async listDir(raw: unknown): Promise<{ entries: unknown[]; cwd: string }> {
    const { params } = readParams(raw)
    const sessionId = requiredString(params, 'sessionId')
    const path = requiredString(params, 'path', 'the remote directory to list')
    const client = await sftpClientOf(this.deps, sessionId)
    const result = await client.listDir(path, { showHidden: optionalBoolean(params, 'showHidden') === true })
    this.auditOutcome('listDir', 'ok', { sessionId, path: result.cwd, entries: result.entries.length })
    return result
  }

  /** ICD §4.5 `stat`. */
  async stat(raw: unknown): Promise<{ info: unknown }> {
    const { params } = readParams(raw)
    const sessionId = requiredString(params, 'sessionId')
    const path = requiredString(params, 'path', 'the remote path to stat')
    const client = await sftpClientOf(this.deps, sessionId)
    return { info: await client.stat(path) }
  }

  /** ICD §4.5 `mkdir` (recursive by default, ICD §4.5). */
  async mkdir(raw: unknown): Promise<{ created: true }> {
    const { params } = readParams(raw)
    const sessionId = requiredString(params, 'sessionId')
    const path = requiredString(params, 'path')
    const client = await sftpClientOf(this.deps, sessionId)
    await client.mkdir(path, { recursive: optionalBoolean(params, 'recursive') !== false })
    this.auditOutcome('mkdir', 'ok', { sessionId, path })
    return { created: true }
  }

  /** ICD §4.5 `rename`. */
  async rename(raw: unknown): Promise<{ renamed: true }> {
    const { params } = readParams(raw)
    const sessionId = requiredString(params, 'sessionId')
    const from = requiredString(params, 'from')
    const to = requiredString(params, 'to')
    const client = await sftpClientOf(this.deps, sessionId)
    await client.rename(from, to)
    this.auditOutcome('rename', 'ok', { sessionId, from, to })
    return { renamed: true }
  }

  /**
   * ICD §4.5 `removePath`; answers how many entries disappeared.
   *
   * The wire method is `removePath` because a Remote method named `remove` collides with
   * the Gateway's own `RemoteNamespaceService.remove` (see `src/service.ts`). This
   * in-process name stays `remove`, mirroring `SftpHandle.remove` from ICD §7.
   */
  async remove(raw: unknown): Promise<{ removed: number }> {
    const { params } = readParams(raw)
    const sessionId = requiredString(params, 'sessionId')
    const path = requiredString(params, 'path')
    const client = await sftpClientOf(this.deps, sessionId)
    const removed = await client.remove(path, { recursive: optionalBoolean(params, 'recursive') === true })
    this.auditOutcome('remove', 'ok', { sessionId, path, removed })
    return { removed }
  }

  /** ICD §4.5 `chmod` (octal string, e.g. `"0755"`). */
  async chmod(raw: unknown): Promise<{ mode: string }> {
    const { params } = readParams(raw)
    const sessionId = requiredString(params, 'sessionId')
    const path = requiredString(params, 'path')
    const mode = requiredString(params, 'mode')
    const client = await sftpClientOf(this.deps, sessionId)
    await client.chmod(path, mode)
    this.auditOutcome('chmod', 'ok', { sessionId, path, mode })
    return { mode }
  }

  /** ICD §4.5 `upload` (stream). */
  async *upload(raw: unknown): AsyncGenerator<Frame, void, undefined> {
    yield* this.transferStream('upload', raw)
  }

  /** ICD §4.5 `download` (stream). */
  async *download(raw: unknown): AsyncGenerator<Frame, void, undefined> {
    yield* this.transferStream('download', raw)
  }

  /** ICD §4.5 `cancelTransfer`. */
  cancelTransfer(raw: unknown): { cancelled: boolean } {
    const { params } = readParams(raw)
    const opId = requiredString(params, 'opId')
    const cancelled = this.deps.transfers.cancel(opId)
    this.auditOutcome('cancelTransfer', cancelled ? 'ok' : 'denied', { opId, cancelled })
    return { cancelled }
  }

  /** ICD §4.5 `listTransfers`. */
  listTransfers(): { tasks: TransferTaskView[] } {
    return { tasks: this.deps.transfers.list().map((record) => toTask(record)) }
  }

  /** The local half of the dual pane (`sshPlugin/listLocalDir`). */
  async listLocalDir(raw: unknown): Promise<{ entries: unknown[]; cwd: string }> {
    const { params } = readParams(raw)
    const path = optionalString(params, 'path')
    const showHidden = optionalBoolean(params, 'showHidden')
    const result = await listLocalDir(
      { ...(path === undefined ? {} : { path }), ...(showHidden === undefined ? {} : { showHidden }) },
      { logger: this.localLogger() },
    )
    this.auditOutcome('listLocalDir', 'ok', { path: result.cwd, entries: result.entries.length })
    return result
  }

  /** The local half of the dual pane (`sshPlugin/statLocal`). */
  async statLocal(raw: unknown): Promise<{ info: unknown }> {
    const { params } = readParams(raw)
    const path = requiredString(params, 'path', 'the local path to stat')
    return statLocalFs({ path }, { logger: this.localLogger() })
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * One transfer, as a frame stream.
   *
   * `start()` returns as soon as the transfer is under way, so the generator can
   * emit `open` (with the handshake in `meta`) and then relay the manager's
   * progress frames until its `onEnd` fires. The manager owns every terminal
   * outcome — including cancellation and verification mismatch — so the wire layer
   * never has to classify a failure itself.
   */
  private async *transferStream(direction: 'upload' | 'download', raw: unknown): AsyncGenerator<Frame, void, undefined> {
    const { params } = readParams(raw)
    const sessionId = requiredString(params, 'sessionId')
    const localPath = requiredString(params, 'localPath')
    const remotePath = requiredString(params, 'remotePath')
    const chunkBytes = optionalNumber(params, 'chunkBytes')
    const concurrency = optionalNumber(params, 'concurrency')
    const resume = optionalBoolean(params, 'resume')
    const overwrite = optionalBoolean(params, 'overwrite')
    const verify = optionalString(params, 'verify')
    if (verify !== undefined && verify !== 'none' && verify !== 'size+mtime' && verify !== 'sha256') {
      throw new SshError('SSH_CFG_INVALID', 'verify must be none, size+mtime or sha256')
    }
    const streamId = newStreamId()
    const queue = new FrameQueue()

    const started = await this.deps.transfers.start({
      sessionId,
      direction,
      localPath,
      remotePath,
      streamId,
      ...(chunkBytes === undefined ? {} : { chunkBytes }),
      ...(concurrency === undefined ? {} : { concurrency }),
      ...(resume === undefined ? {} : { resume }),
      ...(overwrite === undefined ? {} : { overwrite }),
      ...(verify === undefined ? {} : { verify: verify as 'none' | 'size+mtime' | 'sha256' }),
      sink: {
        onProgress: (progress) => {
          queue.push({
            t: 'progress',
            streamId,
            transferred: progress.transferred,
            ...(progress.totalBytes === undefined ? {} : { totalBytes: progress.totalBytes }),
            bytesPerSec: progress.bytesPerSec,
            ...(progress.etaMs === undefined ? {} : { etaMs: progress.etaMs }),
            phase: progress.phase,
          })
        },
        onEnd: (event) => {
          queue.push({
            t: 'end',
            streamId,
            reason: event.reason,
            ...(event.error === undefined ? {} : { error: event.error }),
          })
          queue.close()
        },
      },
    })

    this.auditOutcome(direction, 'ok', { sessionId, localPath, remotePath, opId: started.opId, resumedFrom: started.resumedFrom })
    yield {
      t: 'open',
      streamId,
      kind: direction,
      meta: {
        opId: started.opId,
        resumedFrom: started.resumedFrom,
        ...(started.totalBytes === undefined ? {} : { totalBytes: started.totalBytes }),
        localPath,
        remotePath,
      },
    }
    for await (const frame of queue) yield frame
  }

  /** The local filesystem logger face the dual pane expects. */
  private localLogger(): { warn(message: string): void } {
    return {
      warn: (message: string): void => {
        this.log.warn(message)
      },
    }
  }
}

export type { Params }
