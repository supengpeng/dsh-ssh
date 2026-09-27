/**
 * Head+tail output limiting (ICD §4.4).
 *
 * `maxOutputBytes` is the whole stream's budget, so the limiter splits it into a
 * head half that is emitted as it arrives and a tail half that is held until the
 * command ends. Nothing is dropped silently:
 *
 *   - bytes that fit are emitted exactly once, in arrival order;
 *   - bytes dropped between head and tail set the per-channel `truncated` flag;
 *   - the caller turns that flag into `end{reason:'error', error.code:'SSH_LIMIT_OUTPUT_TRUNCATED'}`.
 *
 * The tail is a ring: it never grows past its half of the budget, so a command
 * that prints forever (until its timeout) still costs a bounded amount of memory.
 */

import type { TerminalChannel } from './types.js'

export interface RetainedChunk {
  channel: TerminalChannel
  chunk: Buffer
}

export interface TruncationFlags {
  stdout: boolean
  stderr: boolean
  term: boolean
}

/**
 * Splits a channel's byte stream into "emitted now" and "retained for the end".
 */
export class OutputLimiter {
  private readonly headBudget: number
  private readonly tailBudget: number
  private headEmitted = 0
  private tailBytes = 0
  private flushed = 0
  private readonly tail: Array<{ channel: TerminalChannel; data: Buffer }> = []
  private readonly dropped: TruncationFlags = { stdout: false, stderr: false, term: false }
  private seenBytesTotal = 0

  constructor(readonly maxBytes: number) {
    const budget = Math.max(0, Math.trunc(maxBytes))
    this.headBudget = Math.floor(budget / 2)
    this.tailBudget = budget - this.headBudget
  }

  /** Total bytes observed on all channels. */
  get totalBytes(): number {
    return this.seenBytesTotal
  }

  /** Bytes handed back for emission so far, including the tail already flushed. */
  get emittedBytes(): number {
    return this.headEmitted + this.tailBytes + this.flushed
  }

  /** True once any byte was dropped. */
  get exceeded(): boolean {
    return this.dropped.stdout || this.dropped.stderr || this.dropped.term
  }

  /** Whether bytes were dropped on a specific channel. */
  truncated(channel: TerminalChannel): boolean {
    return this.dropped[channel]
  }

  /** The full per-channel flag set, in the wire vocabulary. */
  get flags(): TruncationFlags {
    return { ...this.dropped }
  }

  /** Chunks to emit immediately (head phase). */
  push(channel: TerminalChannel, chunk: Buffer): RetainedChunk[] {
    if (chunk.length === 0) return []
    this.seenBytesTotal += chunk.length

    const out: RetainedChunk[] = []
    const room = this.headBudget - this.headEmitted
    if (room > 0) {
      const take = Math.min(room, chunk.length)
      out.push({ channel, chunk: chunk.subarray(0, take) })
      this.headEmitted += take
      if (take === chunk.length) return out
      this.retain(channel, chunk.subarray(take))
      return out
    }
    this.retain(channel, chunk)
    return out
  }

  /** Chunks retained for the tail half, in arrival order. Clears the ring. */
  flush(): RetainedChunk[] {
    const out = this.tail.map((entry) => ({ channel: entry.channel, chunk: entry.data }))
    for (const entry of out) this.flushed += entry.chunk.length
    this.tail.length = 0
    this.tailBytes = 0
    return out
  }

  private retain(channel: TerminalChannel, data: Buffer): void {
    if (data.length === 0) return
    if (this.tailBudget === 0) {
      this.dropped[channel] = true
      return
    }

    if (data.length >= this.tailBudget) {
      // This chunk alone fills the tail window; anything older has to go.
      const evicted = this.tail.length > 0
      if (evicted) {
        for (const entry of this.tail) this.dropped[entry.channel] = true
        this.tail.length = 0
        this.tailBytes = 0
      }
      if (data.length > this.tailBudget || evicted) this.dropped[channel] = true
      this.tail.push({ channel, data: data.subarray(data.length - this.tailBudget) })
      this.tailBytes = this.tailBudget
      return
    }

    let overflow = this.tailBytes + data.length - this.tailBudget
    while (overflow > 0 && this.tail.length > 0) {
      const oldest = this.tail[0]!
      this.dropped[oldest.channel] = true
      if (oldest.data.length <= overflow) {
        overflow -= oldest.data.length
        this.tailBytes -= oldest.data.length
        this.tail.shift()
      } else {
        oldest.data = oldest.data.subarray(overflow)
        this.tailBytes -= overflow
        overflow = 0
      }
    }
    this.tail.push({ channel, data })
    // Incremental bookkeeping: recomputing by reduction here once cost a whole
    // budget's worth of over-retention, because the new chunk was not counted.
    this.tailBytes += data.length
  }
}
