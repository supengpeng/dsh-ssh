/**
 * Frame-sequence validator for the ICD §3 scheduling invariants.
 *
 * The invariants are the part of the contract that a type checker cannot see —
 * a stream that emits `open`, data and then nothing, or that restarts `seq`
 * after a reconnect, type-checks perfectly and still breaks the terminal. Every
 * layer that observes a stream (conformance, E2E, perf) runs the same validator
 * so a violation is reported identically no matter where it is found.
 *
 * Checked (ICD §3):
 *   - exactly one `open` first, exactly one `end` last;
 *   - `data.seq` starts at 0 and is strictly increasing (no gaps, no repeats);
 *   - `progress.transferred` is monotonically non-decreasing and `totalBytes`
 *     never changes once set;
 *   - `exit` appears only on `exec`/`shell` streams and before `end`;
 *   - every frame carries the same `streamId` as its `open`.
 */

/** @typedef {{ t: string, streamId?: string, [key: string]: any }} Frame */

export class FrameInvariantError extends Error {
  constructor(message, context = {}) {
    super(message)
    this.name = 'FrameInvariantError'
    this.context = context
  }
}

/**
 * Validate a complete (already collected) frame sequence.
 *
 * @param {Frame[]} frames
 * @param {{ label?: string, expectKind?: string, requireExit?: boolean }} [options]
 * @returns {{ streamId: string, kind: string, dataBytes: number, dataFrames: number, exitCode: number|null|undefined }}
 */
export function validateFrameSequence(frames, options = {}) {
  const label = options.label ?? 'stream'
  const fail = (message, context) => {
    throw new FrameInvariantError(`${label}: ${message}`, context)
  }
  if (!Array.isArray(frames) || frames.length === 0) fail('no frames were emitted')
  if (frames[0].t !== 'open') fail(`first frame must be 'open', saw '${frames[0].t}'`, { frame: frames[0] })
  if (frames[frames.length - 1].t !== 'end') fail(`last frame must be 'end', saw '${frames[frames.length - 1].t}'`, { frame: frames[frames.length - 1] })

  const openFrames = frames.filter((frame) => frame.t === 'open')
  const endFrames = frames.filter((frame) => frame.t === 'end')
  if (openFrames.length !== 1) fail(`expected exactly one 'open' frame, saw ${openFrames.length}`)
  if (endFrames.length !== 1) fail(`expected exactly one 'end' frame, saw ${endFrames.length}`)

  const open = openFrames[0]
  const streamId = open.streamId
  if (!streamId) fail('open frame has no streamId')
  if (options.expectKind && open.kind !== options.expectKind) {
    fail(`open.kind must be '${options.expectKind}', saw '${open.kind}'`)
  }

  let expectedSeq = 0
  let lastTransferred = -1
  let totalBytes
  let exitCode
  let exitSeen = false
  let dataBytes = 0
  let dataFrames = 0

  for (const frame of frames) {
    if (frame.streamId !== streamId) fail(`frame carries streamId ${JSON.stringify(frame.streamId)}, expected ${JSON.stringify(streamId)}`, { frame })
    switch (frame.t) {
      case 'open':
        break
      case 'data': {
        if (exitSeen) fail('data frame after exit', { frame })
        if (frame.seq !== expectedSeq) {
          fail(`data.seq must be ${expectedSeq} (strictly increasing from 0, no gaps), saw ${frame.seq}`, { frame })
        }
        expectedSeq += 1
        dataFrames += 1
        if (frame.encoding !== 'utf8' && frame.encoding !== 'base64') fail(`data.encoding must be utf8|base64, saw ${JSON.stringify(frame.encoding)}`)
        if (!['stdout', 'stderr', 'term'].includes(frame.channel)) fail(`data.channel must be stdout|stderr|term, saw ${JSON.stringify(frame.channel)}`)
        if (typeof frame.chunk !== 'string') fail('data.chunk must be a string')
        dataBytes += frame.encoding === 'base64' ? Buffer.byteLength(frame.chunk, 'base64') : Buffer.byteLength(frame.chunk, 'utf8')
        break
      }
      case 'progress': {
        if (typeof frame.transferred !== 'number') fail('progress.transferred must be a number')
        if (frame.transferred < lastTransferred) {
          fail(`progress.transferred must be monotonically non-decreasing (${lastTransferred} -> ${frame.transferred})`, { frame })
        }
        lastTransferred = frame.transferred
        if (frame.totalBytes !== undefined) {
          if (totalBytes === undefined) totalBytes = frame.totalBytes
          else if (frame.totalBytes !== totalBytes) {
            fail(`progress.totalBytes must not change once set (${totalBytes} -> ${frame.totalBytes})`, { frame })
          }
        }
        if (!['scan', 'transfer', 'finalize', 'verify'].includes(frame.phase)) fail(`progress.phase invalid: ${JSON.stringify(frame.phase)}`)
        if (typeof frame.bytesPerSec !== 'number' || frame.bytesPerSec < 0) fail('progress.bytesPerSec must be a non-negative number')
        break
      }
      case 'exit': {
        if (open.kind !== 'exec' && open.kind !== 'shell') fail(`exit frame is only valid on exec/shell streams, kind=${open.kind}`)
        if (exitSeen) fail('more than one exit frame')
        if (typeof frame.durationMs !== 'number') fail('exit.durationMs must be a number')
        if (typeof frame.timedOut !== 'boolean') fail('exit.timedOut must be a boolean')
        if (frame.exitCode !== null && typeof frame.exitCode !== 'number') fail('exit.exitCode must be a number or null')
        exitSeen = true
        exitCode = frame.exitCode
        break
      }
      case 'state':
      case 'audit':
        break
      case 'end':
        break
      default:
        fail(`unknown frame type ${JSON.stringify(frame.t)}`, { frame })
    }
  }

  if (options.requireExit && !exitSeen) fail('expected an exit frame before end')
  return { streamId, kind: open.kind, dataBytes, dataFrames, exitCode, exitSeen }
}

/**
 * Validate frames collected from a transferred file: the sum of data bytes must
 * match what the caller expected (used by the transfer tests).
 */
export function assertDataBytes(result, expectedBytes, label = 'stream') {
  if (result.dataBytes !== expectedBytes) {
    throw new FrameInvariantError(`${label}: data carried ${result.dataBytes} bytes, expected ${expectedBytes}`)
  }
  return result
}
