/**
 * The agent tools' side of the activity mirror (ICD §4.7).
 *
 * `src/activity/feed.ts` promises that nothing handed to it can fail the operation
 * it observes. That promise is only worth anything if a tool can instrument itself
 * without thinking about failure, so every feed call the agent tools make goes
 * through this module and picks up the same four guarantees:
 *
 *   1. **A missing feed is not a special case.** `activity` is optional on all three
 *      tool-deps interfaces (a composition may be built without a mirror, and unit
 *      doubles predate the subsystem), so `undefined` records nothing and every
 *      helper here accepts it.
 *   2. **A broken mirror cannot reach the tool.** A `begin`/`chunk`/`finish` that
 *      throws — or a handle from a feed disposed mid-call — costs the record and
 *      nothing else. The mirror is an observation; the tool result is the product.
 *   3. **A frame callback stays cheap.** `mirrorExecFrame` runs on the data path of
 *      a command the user is waiting for: it decodes one chunk and returns. It never
 *      awaits, never queues, and never allocates more than the text it was given —
 *      the ring is what bounds what is retained.
 *   4. **The one unbounded field is bounded here.** The ring caps the transcript,
 *      but `note` is a single string that is filled from strings a model supplied
 *      (a label, a path, a message); `finishActivity` clips it before it is stored.
 */

import type { ActivityFeed } from '../activity/feed.js'
import type { ActivityBeginInput, ActivityFinishInput, ActivityHandle } from '../activity/feed.js'
import type { ActivityChannel, ActivityStatus, Frame } from '../protocol.js'

/** How much of a note the pane keeps. Long enough for a message, short enough to draw. */
const MAX_NOTE_CHARS = 400

/**
 * Codes that mean "the plugin declined the call" rather than "the call ran and
 * failed".
 *
 * The distinction matters to the reader of the panel: a refused operation never
 * touched the remote host, so a `connect` refused by the host-key policy is a
 * decision (`refused`), while a rejected password is a failed attempt (`error`).
 * Anything unrecognised is an error — the feed's rule is that an unknown outcome is
 * never reported as a success.
 */
const REFUSAL_CODES: readonly string[] = [
  'SSH_CFG_INVALID',
  'SSH_STATE_INVALID',
  'SSH_HOSTKEY_UNKNOWN',
  'SSH_HOSTKEY_MISMATCH',
]

/** Open a record, or record nothing when there is no feed. Never throws. */
export function beginActivity(feed: ActivityFeed | undefined, input: ActivityBeginInput): ActivityHandle | undefined {
  if (feed === undefined || feed === null) return undefined
  try {
    return feed.begin(input)
  } catch {
    return undefined
  }
}

/** Append streamed text to a record. Never throws; a missing handle is a no-op. */
export function chunkActivity(handle: ActivityHandle | undefined, channel: ActivityChannel, text: string): void {
  if (handle === undefined) return
  try {
    handle.chunk(channel, text)
  } catch {
    /* deliberately ignored: a mirror must not fail the command it mirrors */
  }
}

/** Close a record with its outcome. Never throws; idempotent as the feed's `finish` itself. */
export function finishActivity(handle: ActivityHandle | undefined, input: ActivityFinishInput): void {
  if (handle === undefined) return
  try {
    handle.finish({ ...input, note: clipNote(input.note) })
  } catch {
    /* deliberately ignored: see the module header */
  }
}

/**
 * One complete record for an operation that streams nothing: a refusal, or a
 * summary written after the fact.
 *
 * Opened and closed in the same call on purpose — a record that is never finished
 * would sit in the ring as `running` forever, and a running record is exactly the
 * one the feed never evicts.
 */
export function recordActivity(
  feed: ActivityFeed | undefined,
  begin: ActivityBeginInput,
  finish: ActivityFinishInput,
): void {
  finishActivity(beginActivity(feed, begin), finish)
}

/**
 * One `Frame` of a running command, mirrored into the record.
 *
 * Only `data` frames carry text a terminal can draw; `progress` is a transfer
 * concept and `exit`/`end` arrive through the tool's own result, which is where the
 * outcome is decided.
 *
 * `term` is folded into `stdout` because a PTY merges the two streams on the remote
 * side: the bytes are stdout as far as the pane is concerned, and inventing a
 * separate channel would draw a merged terminal as two interleaved ones.
 */
export function mirrorExecFrame(handle: ActivityHandle | undefined, frame: Frame): void {
  if (handle === undefined || frame.t !== 'data') return
  const text = frame.encoding === 'base64' ? Buffer.from(frame.chunk, 'base64').toString('utf8') : frame.chunk
  chunkActivity(handle, frame.channel === 'term' ? 'stdout' : frame.channel, text)
}

/** `user@host` for the pane's session line, or null when neither half is known. */
export function targetOf(user: unknown, host: unknown): string | null {
  const userText = typeof user === 'string' ? user : ''
  const hostText = typeof host === 'string' ? host : ''
  if (userText === '') return hostText === '' ? null : hostText
  return hostText === '' ? userText : `${userText}@${hostText}`
}

/**
 * Clip a note to what the pane can draw.
 *
 * `note` is the one field the feed's byte budgets do not touch, and every caller
 * fills it from strings a model supplied; an unclipped note is therefore the one
 * way a tool call could grow the ring without bound. An empty note becomes null so
 * the feed records "no note" rather than an empty string.
 */
export function clipNote(note: string | null | undefined): string | null {
  if (typeof note !== 'string' || note === '') return null
  return note.length > MAX_NOTE_CHARS ? `${note.slice(0, MAX_NOTE_CHARS - 1)}…` : note
}

/**
 * Join the parts of a note, dropping the empty ones.
 *
 * A refusal's message says what went wrong and its envelope's notes say what to do
 * about it ("the host key is not in known_hosts and the policy is strict: …", "the
 * credential was rejected: update it in the panel"); the panel row is only as useful
 * as the second half, so both go into the record.
 */
export function noteOf(...parts: Array<string | null | undefined>): string | null {
  const text = parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' · ')
  return text === '' ? null : text
}

/** The feed's terminal class for a failure, from the code its envelope carries. */
export function statusOfCode(code: string | null | undefined): ActivityStatus {
  if (typeof code !== 'string' || code === '') return 'error'
  if (REFUSAL_CODES.includes(code)) return 'refused'
  if (code === 'SSH_CANCELLED') return 'cancelled'
  if (code.startsWith('SSH_TIMEOUT_')) return 'timeout'
  return 'error'
}
