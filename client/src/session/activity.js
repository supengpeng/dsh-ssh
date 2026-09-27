/**
 * @module ssh.session.activity
 * @order 470
 *
 * `AgentActivityPane` + `AgentActivitySwitch` — the read-only mirror of what the AI
 * agent did through this plugin's host tools (ICD §4.7, wire method
 * `followActivity`).
 *
 * **Why it exists.** Every `ssh_*` tool call happens on the host, outside this
 * client: the workspace only ever drew the streams *it* opened, so a user watching
 * the 终端 tab while the model worked saw an empty screen — and afterwards had no
 * way to find out what had run. The host keeps a feed of those operations and
 * relays it on `followActivity`; this module is the client half of that mirror.
 *
 * **What the mirror may do.** It renders; it does not drive. No `exec`, no
 * keystroke, no transfer is ever issued from here. The one deliberate exception is
 * 清除 (clear): it empties the local list *and* best-effort asks the host to drop
 * the same history (`clearActivity`), because a purely local clear would disagree
 * with every other panel and would come back on the next reload. The call is
 * skipped entirely when no bridge is wired, and a failure is swallowed.
 *
 * **One global feed.** The agent may be working on a host other than the one on
 * screen, so the subscription is not scoped to a session: every record is retained
 * and drawn, and each one names its own `sessionId`/`target` so nothing is
 * misattributed. The summary the switch reads is scoped by `{ sessionId }`, because
 * "should this tab follow the agent?" is a per-session question — `summary.all`
 * carries the global counts for anything that wants them.
 *
 * **Never into React.** Frames are untrusted input: a malformed one is dropped,
 * nothing in the ingest path throws, and the subscription is created lazily, once
 * per bundle run. `bridge.stream` may not be wired yet (or at all) — the module then
 * stays idle and the next mount retries, exactly like the runtime's self-healing
 * wiring. The handle is deliberately *not* cancelled on unmount: the feed outlives
 * every pane, the same rule the runtime's stream registry follows.
 *
 * **Ingestion is synchronous** so a frame's effect is visible immediately (the
 * tests rely on it, and so does a user watching a command finish). What keeps a
 * chatty command from becoming unbounded work is the caps below: the newest 200
 * records are drawn out of 400 retained, a record keeps at most 40 segments and
 * 48 kB of text, a segment at most 4 kB (its tail — the part nearest the outcome),
 * and the pane drops the rest before it reaches the DOM.
 */

SSH.define('ssh.session.activity', function (SSH) {
  const { useState, useEffect, useRef, useCallback, useMemo, useSyncExternalStore } = SSH.react
  const h = SSH.h

  // ── limits ────────────────────────────────────────────────────────────────

  /** Records retained by the store; the oldest are dropped first. */
  const RETAIN_LIMIT = 400
  /** Records the pane draws (the newest N of the retained ones). */
  const RENDER_LIMIT = 200
  /** Segments kept — and drawn — per record. Older ones set `truncated`. */
  const MAX_SEGMENTS = 40
  /** Characters kept per segment; the tail is kept, the head is dropped. */
  const MAX_SEGMENT_CHARS = 4096
  /** Characters kept per record; segments are dropped from the front. */
  const MAX_RECORD_CHARS = 49152
  /** Distance from the bottom (px) that still counts as "at the tail". */
  const FOLLOW_SLACK_PX = 24

  const STATUSES = ['running', 'ok', 'error', 'timeout', 'cancelled', 'refused']
  const CHANNELS = ['stdout', 'stderr', 'info']

  /** Status → locale key. The keys are flat and live in `locale/*.json`. */
  const STATUS_KEY = {
    running: 'ws.activity.running',
    ok: 'ws.activity.ok',
    error: 'ws.activity.error',
    timeout: 'ws.activity.timeout',
    cancelled: 'ws.activity.cancelled',
    refused: 'ws.activity.refused',
  }

  // ── store state (module-level: one feed per bundle run) ────────────────────

  /** Retained records, oldest first — exactly the order the host sends them in. */
  let records = []
  /** Arrivals (begin/end) seen while no pane was mounted. One global badge. */
  let unread = 0
  /** Monotonic change counter: the snapshot `useSyncExternalStore` reads. */
  let revision = 0
  const listeners = new Set()
  /** The single `followActivity` handle of this run (null until it is opened). */
  let handle = null
  /** How many panes are on screen; arrivals with none are what `unread` counts. */
  let mountedPanes = 0
  /** One warning per run when the feed cannot be opened at all. */
  let warnedUnavailable = false

  function emit() {
    revision += 1
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[dsh-ssh] activity listener failed', error)
      }
    }
  }

  function revisionOf() {
    return revision
  }

  // ── normalisation ─────────────────────────────────────────────────────────

  /** Keep the tail of an over-long text; '' stays ''. */
  function tailText(text, max) {
    if (typeof text !== 'string') return ''
    return text.length > max ? text.slice(text.length - max) : text
  }

  /**
   * One wire record as this module holds it.
   *
   * Field by field rather than a spread, for two reasons: a frame is untrusted input
   * (a missing `segments`, a `status` outside the enum or a `startedAt` that is not a
   * number would reach the renderer otherwise), and the shape stays exactly
   * `ActivityView` — callers that read `getRecords()` see the frozen fields and
   * nothing of this store's bookkeeping.
   */
  function normaliseActivity(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || raw.id === '') return null
    const provided = Array.isArray(raw.segments) ? raw.segments : []
    const segments = []
    // The tail matters most, so an over-long list keeps its newest entries.
    for (const entry of provided.slice(-MAX_SEGMENTS)) {
      const segment = normaliseSegment(entry)
      if (segment) segments.push(segment)
    }
    return {
      id: raw.id,
      kind: typeof raw.kind === 'string' && raw.kind !== '' ? raw.kind : 'exec',
      sessionId: typeof raw.sessionId === 'string' && raw.sessionId !== '' ? raw.sessionId : null,
      target: typeof raw.target === 'string' && raw.target !== '' ? raw.target : null,
      subject: typeof raw.subject === 'string' ? raw.subject : '',
      cwd: typeof raw.cwd === 'string' && raw.cwd !== '' ? raw.cwd : null,
      label: typeof raw.label === 'string' && raw.label !== '' ? raw.label : null,
      startedAt: typeof raw.startedAt === 'number' && Number.isFinite(raw.startedAt) ? raw.startedAt : 0,
      endedAt: typeof raw.endedAt === 'number' && Number.isFinite(raw.endedAt) ? raw.endedAt : null,
      durationMs: typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs) ? raw.durationMs : null,
      status: STATUSES.includes(raw.status) ? raw.status : 'running',
      exitCode: typeof raw.exitCode === 'number' && Number.isFinite(raw.exitCode) ? raw.exitCode : null,
      signal: typeof raw.signal === 'string' && raw.signal !== '' ? raw.signal : null,
      code: typeof raw.code === 'string' && raw.code !== '' ? raw.code : null,
      note: typeof raw.note === 'string' && raw.note !== '' ? raw.note : null,
      segments,
      truncated: raw.truncated === true || provided.length > MAX_SEGMENTS,
    }
  }

  function normaliseSegment(entry) {
    if (!entry || typeof entry !== 'object') return null
    const text = typeof entry.text === 'string' ? entry.text : ''
    if (text === '') return null
    // An unknown channel is narration, not output the user should read as a result.
    const channel = CHANNELS.includes(entry.channel) ? entry.channel : 'info'
    return { channel, text: tailText(text, MAX_SEGMENT_CHARS) }
  }

  function findRecord(id) {
    if (typeof id !== 'string' || id === '') return null
    return records.find((record) => record.id === id) || null
  }

  /** Insert or replace one record, keeping what a thin frame left out. */
  function upsert(view) {
    const index = records.findIndex((record) => record.id === view.id)
    if (index < 0) {
      records = [...records, view]
      if (records.length > RETAIN_LIMIT) records = records.slice(records.length - RETAIN_LIMIT)
      return view
    }
    const previous = records[index]
    const merged = { ...view }
    // An `end` frame always carries the whole transcript, but a frame that carried
    // none must not erase what the chunks already delivered.
    if (view.segments.length === 0 && previous.segments.length > 0) merged.segments = previous.segments
    if (previous.truncated === true) merged.truncated = true
    records = [...records.slice(0, index), merged, ...records.slice(index + 1)]
    return merged
  }

  /**
   * Append one chunk to a record that is already held.
   *
   * Adjacent same-channel text is merged, which is what the host does on its side
   * too: a chatty command then costs a handful of DOM nodes instead of one per read.
   * A chunk for an id this store does not hold is dropped — it cannot be placed
   * chronologically, and the host's next `begin`/`end`/snapshot carries the record
   * (with its full transcript) anyway.
   */
  function appendChunk(record, chunk) {
    if (!chunk || typeof chunk !== 'object') return
    const text = typeof chunk.text === 'string' ? chunk.text : ''
    if (text === '') return
    const channel = CHANNELS.includes(chunk.channel) ? chunk.channel : 'info'
    const last = record.segments[record.segments.length - 1]
    if (last && last.channel === channel) {
      last.text = tailText(`${last.text}${text}`, MAX_SEGMENT_CHARS)
    } else {
      record.segments.push({ channel, text: tailText(text, MAX_SEGMENT_CHARS) })
      if (record.segments.length > MAX_SEGMENTS) {
        record.segments.shift()
        record.truncated = true
      }
    }
    trimRecord(record)
  }

  /** Enforce the per-record character budget by dropping the oldest text. */
  function trimRecord(record) {
    let total = 0
    for (const segment of record.segments) total += segment.text.length
    let excess = total - MAX_RECORD_CHARS
    while (excess > 0 && record.segments.length > 1) {
      const first = record.segments[0]
      if (first.text.length <= excess) {
        excess -= first.text.length
        record.segments.shift()
      } else {
        first.text = first.text.slice(excess)
        excess = 0
      }
      record.truncated = true
    }
  }

  // ── the wire ──────────────────────────────────────────────────────────────

  /**
   * The transport, discovered rather than injected.
   *
   * `ssh.session.runtime` owns the wiring (`configure({ bridge, app })`, called once
   * by the plugin body) and publishes it through `discover()`, so this module reads
   * the object the rest of the workspace uses instead of creating a second
   * transport. A partial bundle without the runtime falls back to the published
   * plugin runtime. Nothing is cached negatively: a later mount retries.
   */
  function discoverBridge() {
    try {
      const runtime = SSH.require('ssh.session.runtime')
      const wiring = runtime && typeof runtime.discover === 'function' ? runtime.discover() : null
      const bridge = wiring ? wiring.bridge : null
      if (bridge && typeof bridge.stream === 'function') return bridge
    } catch {
      /* a partial bundle may not carry the runtime; that is not an error here */
    }
    try {
      const plugin = SSH.require('ssh.plugin')
      const face = plugin && typeof plugin.currentRuntime === 'function' ? plugin.currentRuntime() : null
      const bridge = face ? face.bridge : null
      if (bridge && typeof bridge.stream === 'function') return bridge
    } catch {
      /* the plugin body is optional for a standalone pane */
    }
    return null
  }

  /** Open the run's single subscription; idempotent, and never throws. */
  function ensureConnected() {
    if (handle) return handle
    const bridge = discoverBridge()
    if (!bridge) return null
    try {
      const opened = bridge.stream('followActivity', {}, onFrame)
      if (!opened) return null
      /**
       * A carrier that fails **synchronously** delivers its terminal `end` frame from
       * inside `stream()` — `client/src/bridge.js` fills `state.error` and calls
       * `onFrame` before it returns the handle — so `ingest` has already cleared
       * `handle` by the time we get here. Storing that dead handle would make the
       * `if (handle) return handle` above permanent and the pane would never retry on
       * the next mount, which is exactly the "older host half without ICD §4.7" case.
       * An asynchronous failure is unaffected: there the handle is live when it is
       * stored and the later `end` frame clears it as before.
       */
      const failure = opened.state && opened.state.error ? opened.state.error : null
      if (failure) {
        if (!warnedUnavailable) {
          warnedUnavailable = true
          console.warn(
            '[dsh-ssh] activity: followActivity is unavailable',
            failure.message ? failure.message : failure,
          )
        }
        return null
      }
      handle = opened
      console.info('[dsh-ssh] activity: following the agent feed')
      return handle
    } catch (error) {
      handle = null
      if (!warnedUnavailable) {
        warnedUnavailable = true
        console.warn('[dsh-ssh] activity: followActivity is unavailable', error && error.message ? error.message : error)
      }
      return null
    }
  }

  /** Frame entry point: nothing a frame says may reach React as an exception. */
  function onFrame(frame) {
    try {
      ingest(frame)
    } catch (error) {
      console.warn('[dsh-ssh] activity: dropping a frame that could not be applied', error)
    }
  }

  function ingest(frame) {
    if (!frame || typeof frame.t !== 'string') return

    if (frame.t === 'activity-snapshot') {
      // The first frame of every (re)subscribe: it *replaces* the list, because the
      // host is the source of truth and a reconnect must not double a record.
      const list = Array.isArray(frame.activities) ? frame.activities : []
      records = list.map(normaliseActivity).filter(Boolean).slice(-RETAIN_LIMIT)
      emit()
      return
    }

    if (frame.t === 'activity-reset') {
      // The host dropped its history: keeping a copy would draw records it no longer
      // has. `unread` goes with it — there is nothing left to be unread about.
      records = []
      unread = 0
      emit()
      return
    }

    if (frame.t === 'activity') {
      if (frame.phase === 'chunk') {
        const record = findRecord(frame.id)
        if (!record) return
        appendChunk(record, frame.chunk)
        emit()
        return
      }
      if (frame.phase !== 'begin' && frame.phase !== 'end') return
      const view = normaliseActivity(frame.activity)
      if (!view) return
      upsert(view)
      // An arrival nobody is looking at is exactly what the unread badge counts.
      if (mountedPanes === 0) unread += 1
      emit()
      return
    }

    if (frame.t === 'end') {
      // The feed's stream is over (carrier lost, plugin unloaded). The records stay —
      // they are still the memory of what happened — and the next mount re-subscribes.
      handle = null
      console.info('[dsh-ssh] activity: the agent feed ended', frame.reason || 'end')
    }
  }

  // ── store actions ─────────────────────────────────────────────────────────

  function clearLocal() {
    records = []
    unread = 0
    emit()
  }

  /**
   * The pane's 清除 action: local first (the list must empty even when the transport
   * is down), then best-effort on the host so no other panel and no later reload
   * resurrects history the user just dismissed. No parameter: `clearActivity` takes
   * none, so the zero-argument wire shape is the first one the bridge tries.
   */
  function clearEverywhere() {
    clearLocal()
    const bridge = discoverBridge()
    if (!bridge || typeof bridge.call !== 'function') return
    try {
      const answer = bridge.call('clearActivity')
      if (answer && typeof answer.catch === 'function') answer.catch(() => {})
    } catch (error) {
      console.warn('[dsh-ssh] activity: the host did not clear the feed', error && error.message ? error.message : error)
    }
  }

  function markActivitySeen() {
    if (unread === 0) return
    unread = 0
    emit()
  }

  /**
   * The counts the switch and the session view read.
   *
   * `total`/`running`/`newestAt` are scoped to `sessionId` when one is given — the
   * question they answer is "did the agent touch the session on screen?" — while
   * `all` is the whole global feed. `unread` is the single global badge counter
   * (`markActivitySeen()` takes no argument), and `newestAt` is epoch ms, 0 when
   * there is nothing to show.
   */
  function buildSummary(sessionId) {
    const scoped = sessionId ? records.filter((record) => record.sessionId === sessionId) : records
    let running = 0
    let newestAt = 0
    for (const record of scoped) {
      if (record.status === 'running') running += 1
      const at = record.endedAt === null ? record.startedAt : record.endedAt
      if (typeof at === 'number' && Number.isFinite(at) && at > newestAt) newestAt = at
    }
    let allRunning = 0
    for (const record of records) {
      if (record.status === 'running') allRunning += 1
    }
    return {
      total: scoped.length,
      running,
      unread,
      newestAt,
      all: { total: records.length, running: allRunning, unread },
    }
  }

  const EMPTY_SUMMARY = Object.freeze({
    total: 0,
    running: 0,
    unread: 0,
    newestAt: 0,
    all: Object.freeze({ total: 0, running: 0, unread: 0 }),
  })

  const activityStore = {
    /**
     * The retained records, oldest first — a copy, so a caller cannot corrupt the
     * store by sorting it.
     *
     * `getRecords(sessionId)` filters to one session (the panel asks "did the agent
     * work on *this* session?"); `getRecords()` is the whole global feed, which is
     * what the pane draws.
     */
    getRecords(sessionId) {
      if (typeof sessionId === 'string' && sessionId !== '') {
        return records.filter((record) => record.sessionId === sessionId)
      }
      return records.slice()
    },
    /** Subscribe to changes; the first subscriber is what connects the feed. */
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      ensureConnected()
      return () => {
        listeners.delete(listener)
      }
    },
    /** Drop the mirror. Local only — the store is what the tests drive. */
    clear() {
      clearLocal()
    },
  }

  // ── rendering helpers ─────────────────────────────────────────────────────

  /** Local `HH:MM:SS` for an epoch-ms timestamp; a placeholder when unusable. */
  function clockOf(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '--:--:--'
    const date = new Date(ms)
    const pad = (value) => String(value).padStart(2, '0')
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  }

  /** One line naming the record, for the head row. */
  function targetOf(record) {
    if (record.target) return record.target
    if (record.sessionId) return record.sessionId
    return '—'
  }

  /** The record as plain text, for the copy affordance. */
  function transcriptOf(record) {
    const head = [clockOf(record.startedAt), record.kind, targetOf(record), record.status].join(' · ')
    const facts = []
    if (record.exitCode !== null) facts.push(`exit ${record.exitCode}`)
    if (record.signal) facts.push(`signal ${record.signal}`)
    if (record.durationMs !== null) facts.push(`${Math.round(record.durationMs)} ms`)
    if (record.truncated) facts.push('truncated')
    if (record.code) facts.push(record.code)
    if (record.note) facts.push(record.note)
    const body = record.segments.map((segment) => segment.text).join('')
    return [head, `$ ${record.subject}`, body, facts.join(' · ')].filter((part) => part !== '').join('\n')
  }

  // ── components ────────────────────────────────────────────────────────────

  /**
   * The 终端 | AI 活动 segmented control.
   *
   * Frozen props: `{ mode, onMode, summary }`. The unread badge comes from
   * `summary.unread` and the running indicator from `summary.running`; both are
   * hidden at zero, so an idle panel adds no chrome. Real `<button>`s, so keyboard
   * reach and activation are the platform's, not a re-implementation.
   */
  function AgentActivitySwitch(props) {
    const settings = props || {}
    const ui = SSH.require('ssh.session.ui')
    const t = ui.t
    const primitives = ui.ui()
    const mode = settings.mode === 'activity' ? 'activity' : 'terminal'
    const onMode = typeof settings.onMode === 'function' ? settings.onMode : null
    const summary = settings.summary && typeof settings.summary === 'object' ? settings.summary : EMPTY_SUMMARY
    const unread = Math.max(0, Math.floor(Number(summary.unread)) || 0)
    const running = Math.max(0, Math.floor(Number(summary.running)) || 0)

    const choose = (next) => () => {
      if (onMode) onMode(next)
    }

    return h(
      'div',
      {
        className: 'ssh-ws-activity-switch',
        'data-testid': 'ssh-ws-activity-switch',
        role: 'group',
        'aria-label': t('ws.activity.tab'),
      },
      h(
        'button',
        {
          type: 'button',
          className: 'ssh-ws-activity-switch-btn',
          'data-active': mode === 'activity' ? 'true' : 'false',
          'data-testid': 'ssh-ws-activity-mode-activity',
          'aria-pressed': mode === 'activity',
          title: t('ws.activity.tab'),
          onClick: choose('activity'),
        },
        t('ws.activity.tab'),
        running > 0
          ? h(
              'span',
              {
                className: 'ssh-ws-activity-running',
                'data-testid': 'ssh-ws-activity-running',
                title: `${t('ws.activity.running')} ${running}`,
              },
              h(primitives.Spinner, { size: 10 }),
              String(running),
            )
          : null,
        unread > 0
          ? h(
              'span',
              {
                className: 'ssh-ws-activity-unread',
                'data-testid': 'ssh-ws-activity-unread',
                title: t('ws.activity.running'),
              },
              unread > 99 ? '99+' : String(unread),
            )
          : null,
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'ssh-ws-activity-switch-btn',
          'data-active': mode === 'terminal' ? 'true' : 'false',
          'data-testid': 'ssh-ws-activity-mode-terminal',
          'aria-pressed': mode === 'terminal',
          onClick: choose('terminal'),
        },
        t('ws.tabs.terminal'),
      ),
    )
  }

  /**
   * The transcript of every agent-driven activity, newest last.
   *
   * Frozen props: `{ sessionId }` — and nothing else is required, so the pane renders
   * standalone. The feed is global, so `sessionId` only labels the pane; each record
   * carries its own session/`target` instead of inheriting the visible one.
   */
  function AgentActivityPane(props) {
    const settings = props || {}
    const sessionId = typeof settings.sessionId === 'string' ? settings.sessionId : null

    const ui = SSH.require('ssh.session.ui')
    const t = ui.t
    const primitives = ui.ui()
    const { Button, EmptyState } = primitives

    const current = useSyncExternalStore(activityStore.subscribe, revisionOf, revisionOf)
    const all = useMemo(() => activityStore.getRecords(), [current])
    const visible = useMemo(() => all.slice(-RENDER_LIMIT), [all])
    const running = useMemo(() => all.filter((record) => record.status === 'running').length, [all])

    const [following, setFollowing] = useState(true)
    const [copiedId, setCopiedId] = useState(null)
    const listRef = useRef(null)

    useEffect(() => {
      SSH.require('ssh.session.styles').ensureStyles()
    }, [])

    // Mounting the pane is what makes the badge honest: `unread` counts arrivals
    // while nothing is on screen, so the mount/unmount pair is the counter. The same
    // moment is the retry point for a feed that was not wired at the last mount.
    useEffect(() => {
      mountedPanes += 1
      ensureConnected()
      return () => {
        mountedPanes = Math.max(0, mountedPanes - 1)
      }
    }, [])

    // Follow the tail while the user is at the bottom; scrolling up stops it (and the
    // jump-to-latest button brings it back). Synchronous, because a follow that lags
    // a frame shows the user the wrong end of a running command.
    useEffect(() => {
      if (!following) return
      const element = listRef.current
      if (!element) return
      element.scrollTop = element.scrollHeight
    }, [following, current])

    useEffect(() => {
      if (copiedId === null) return undefined
      const timer = setTimeout(() => setCopiedId(null), 1600)
      return () => clearTimeout(timer)
    }, [copiedId])

    const onScroll = useCallback(() => {
      const element = listRef.current
      if (!element) return
      const scrollHeight = Number(element.scrollHeight) || 0
      const clientHeight = Number(element.clientHeight) || 0
      const scrollTop = Number(element.scrollTop) || 0
      // No layout (or nothing to scroll): the user is at the tail by definition.
      if (scrollHeight <= clientHeight) {
        setFollowing(true)
        return
      }
      setFollowing(scrollHeight - scrollTop - clientHeight <= FOLLOW_SLACK_PX)
    }, [])

    const jumpToLatest = useCallback(() => {
      setFollowing(true)
      const element = listRef.current
      if (element) element.scrollTop = element.scrollHeight
    }, [])

    const copyRecord = useCallback(
      (record) => {
        Promise.resolve(ui.copyText(transcriptOf(record))).then(
          (ok) => setCopiedId(ok ? record.id : null),
          () => setCopiedId(null),
        )
      },
      [ui],
    )

    /** The `err.SSH_*` sentence for a code, when the dictionary has one. */
    const codeTitle = (code) => {
      const sentence = t(`err.${code}`)
      return sentence === `err.${code}` ? code : sentence
    }

    const renderSegments = (record) => {
      if (record.segments.length === 0) return null
      // The store already caps both, so these are the last line of defence before the
      // DOM: a record that somehow arrives huge still cannot flood the panel.
      const shown = record.segments.slice(-MAX_SEGMENTS)
      return h(
        'div',
        { className: 'ssh-ws-activity-segs' },
        shown.map((segment, index) =>
          h(
            'pre',
            {
              key: `seg-${index}`,
              className: 'ssh-ws-activity-seg',
              'data-channel': segment.channel,
              'data-testid': 'ssh-ws-activity-seg',
            },
            tailText(segment.text, MAX_SEGMENT_CHARS),
          ),
        ),
      )
    }

    const renderFacts = (record) => {
      const parts = []
      if (record.exitCode !== null) parts.push(`${t('ws.activity.exit')} ${record.exitCode}`)
      if (record.signal) parts.push(`signal ${record.signal}`)
      if (record.durationMs !== null) parts.push(`${t('ws.activity.duration')} ${ui.formatDuration(record.durationMs)}`)
      if (record.truncated) parts.push(t('ws.activity.truncated'))
      if (parts.length === 0 && record.code === null && record.note === null) return null
      return h(
        'div',
        { className: 'ssh-ws-activity-foot', 'data-testid': 'ssh-ws-activity-foot' },
        parts.length > 0 ? h('span', null, parts.join(' · ')) : null,
        record.code
          ? h(
              'span',
              { className: 'ssh-ws-activity-code', 'data-testid': 'ssh-ws-activity-code', title: codeTitle(record.code) },
              record.code,
            )
          : null,
        record.note ? h('span', { className: 'ssh-ws-activity-note', 'data-testid': 'ssh-ws-activity-note' }, record.note) : null,
      )
    }

    const renderRecord = (record) => {
      const ended = record.endedAt === null ? '' : ` · ${t('ws.activity.done')} ${clockOf(record.endedAt)}`
      return h(
        'div',
        {
          key: record.id,
          className: 'ssh-ws-activity-entry',
          'data-testid': 'ssh-ws-activity-entry',
          'data-activity-id': record.id,
          'data-status': record.status,
          'data-kind': record.kind,
        },
        h(
          'div',
          { className: 'ssh-ws-activity-head' },
          h(
            'span',
            { className: 'ssh-ws-activity-time', title: `${t('ws.activity.started')} ${clockOf(record.startedAt)}${ended}` },
            clockOf(record.startedAt),
          ),
          h('span', { className: 'ssh-ws-activity-kind', title: record.label || record.kind }, record.kind),
          h('span', { className: 'ssh-ws-activity-target', 'data-testid': 'ssh-ws-activity-target' }, targetOf(record)),
          h(
            'span',
            { className: 'ssh-ws-badge', 'data-outcome': record.status, 'data-testid': 'ssh-ws-activity-status' },
            t(STATUS_KEY[record.status] || STATUS_KEY.running),
          ),
          h('span', { className: 'ssh-ws-spacer' }),
          h(
            'button',
            {
              type: 'button',
              className: 'ssh-ws-filter',
              'data-testid': 'ssh-ws-activity-copy',
              title: t('ws.activity.copy'),
              onClick: () => copyRecord(record),
            },
            copiedId === record.id ? t('toast.copied') : t('ws.activity.copy'),
          ),
        ),
        h(
          'div',
          { className: 'ssh-ws-activity-subject', 'data-testid': 'ssh-ws-activity-subject' },
          record.kind === 'exec' ? `$ ${record.subject || record.id}` : record.subject || record.id,
        ),
        record.cwd ? h('div', { className: 'ssh-ws-activity-cwd', 'data-testid': 'ssh-ws-activity-cwd' }, record.cwd) : null,
        renderSegments(record),
        renderFacts(record),
      )
    }

    return h(
      'div',
      {
        className: 'ssh-ws ssh-ws-activity',
        'data-testid': 'ssh-ws-activity',
        'data-session-id': sessionId || '',
        'data-records': String(all.length),
        'data-running': String(running),
      },
      h(
        'div',
        { className: 'ssh-ws-toolbar' },
        h('span', { className: 'ssh-ws-title' }, t('ws.activity.tab')),
        h(
          'span',
          { className: 'ssh-ws-sub', 'data-testid': 'ssh-ws-activity-session' },
          sessionId ? `${t('ws.activity.session')} ${sessionId}` : '—',
        ),
        h('span', { className: 'ssh-ws-spacer' }),
        running > 0
          ? h(
              'span',
              { className: 'ssh-ws-badge', 'data-outcome': 'running', 'data-testid': 'ssh-ws-activity-running' },
              h(primitives.Spinner, { size: 10 }),
              `${t('ws.activity.running')} ${running}`,
            )
          : null,
        h('span', { className: 'ssh-ws-sub', 'data-testid': 'ssh-ws-activity-count' }, String(all.length)),
        h(
          'button',
          {
            type: 'button',
            className: 'ssh-ws-filter ssh-ws-activity-follow',
            'data-testid': 'ssh-ws-activity-follow',
            'data-following': following ? 'true' : 'false',
            'aria-pressed': following,
            onClick: () => setFollowing((value) => !value),
          },
          t('ws.activity.follow'),
        ),
        following
          ? null
          : h(
              'button',
              { type: 'button', className: 'ssh-ws-filter', 'data-testid': 'ssh-ws-activity-latest', onClick: jumpToLatest },
              t('ws.activity.latest'),
            ),
        h(Button, { onClick: clearEverywhere, disabled: all.length === 0, dataTestId: 'ssh-ws-activity-clear' }, t('ws.activity.clear')),
      ),
      h(
        'div',
        {
          className: 'ssh-ws-body ssh-ws-scroll ssh-ws-activity-list',
          'data-testid': 'ssh-ws-activity-list',
          ref: listRef,
          onScroll,
        },
        visible.length === 0
          ? h(EmptyState, {
              title: t('ws.activity.empty'),
              hint: t('ws.activity.emptyHint'),
              dataTestId: 'ssh-ws-activity-empty',
            })
          : visible.map(renderRecord),
      ),
    )
  }

  /**
   * Scoped summary hook.
   *
   * `useActivitySummary({ sessionId })` — the object identity is stable between
   * revisions (it is memoised on the change counter), so a caller may use it in an
   * effect's dependency list without re-running on every render.
   */
  function useActivitySummary(options) {
    const sessionId =
      options && typeof options.sessionId === 'string' && options.sessionId !== '' ? options.sessionId : null
    const current = useSyncExternalStore(activityStore.subscribe, revisionOf, revisionOf)
    return useMemo(() => buildSummary(sessionId), [sessionId, current])
  }

  return {
    AgentActivityPane,
    AgentActivitySwitch,
    useActivitySummary,
    markActivitySeen,
    activityStore,
    /** Exposed for the tests: the limits the pane and the store enforce. */
    LIMITS: { RETAIN_LIMIT, RENDER_LIMIT, MAX_SEGMENTS, MAX_SEGMENT_CHARS, MAX_RECORD_CHARS },
    /** Exposed for the tests: the pure helpers worth asserting directly. */
    clockOf,
    tailText,
    transcriptOf,
  }
})
