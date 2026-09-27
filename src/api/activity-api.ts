/**
 * §4.7 agent activity: the read side of the mirror.
 *
 * The model's own `ssh_*` calls never pass through this endpoint — the tools
 * record into the feed directly. This group exists so a browser can *watch*:
 * `follow` opens with what the feed already retained and then relays live events
 * for as long as the subscriber stays attached.
 *
 * Two decisions are worth stating:
 *
 *   1. **The snapshot is the first frame, not a separate call.** `followSessions`
 *      (ICD §4.3) already settled this shape: a client that subscribed and *then*
 *      asked for the current state would open a window in which an activity that
 *      started between the two calls is never announced, and the panel would show
 *      a command that is already running as if it did not exist.
 *   2. **No `sessionId` parameter.** Activities are keyed by session and labelled
 *      with it, but the panel mirrors *everything the agent does*, including work
 *      aimed at a host other than the one the visible tab is showing. Filtering is
 *      therefore the view's decision (it draws the session on every record), not a
 *      wire restriction that would silently hide the agent's work.
 */

import type { Frame } from '../protocol.js'
import { ApiGroup } from './deps.js'
import { FrameQueue } from './frames.js'

export class ActivityApi extends ApiGroup {
  /**
   * ICD §4.7 `followActivity` (stream).
   *
   * The feed's own events already carry whole records for `begin`/`end` and a
   * delta for `chunk`, so the translation to frames is a rename with a guard: a
   * feed that is disposed while a subscriber is attached must end the stream
   * cleanly (the generator's `finally` unsubscribes) rather than throw into the
   * carrier.
   */
  async *follow(): AsyncGenerator<Frame, void, undefined> {
    const feed = this.deps.activity
    const queue = new FrameQueue()
    queue.push({ t: 'activity-snapshot', activities: feed.snapshot() })

    const unsubscribe = feed.subscribe((event) => {
      if (event.t === 'activity' && event.phase === 'chunk') {
        queue.push({ t: 'activity', phase: 'chunk', id: event.id, chunk: event.chunk })
        return
      }
      if (event.t === 'activity') {
        queue.push({ t: 'activity', phase: event.phase, activity: event.activity })
        return
      }
      queue.push({ t: 'activity-reset' })
    })

    try {
      for await (const frame of queue) yield frame
    } finally {
      // Cancelling the subscription is the client's only cleanup path (`return()`
      // on the async iterator), so it must release the listener here.
      unsubscribe()
    }
  }

  /**
   * ICD §4.7 `clearActivity`.
   *
   * Drops the retained history for every subscriber. This is deliberately a host
   * operation rather than a client-side filter: two panels (or a reloaded page)
   * must not disagree about what the agent did.
   */
  clear(): { cleared: number } {
    const cleared = this.deps.activity.clear()
    this.auditOutcome('clearActivity', 'ok', { cleared })
    return { cleared }
  }
}
