/**
 * @module ssh.panel
 * @order 100
 *
 * The right-sidebar tab body: the product's main surface.
 *
 * It is a *view switch* over one store (`panel.view`, ICD §8.3):
 *
 *   - `list`    — the connection manager (`ssh.conn.list`),
 *   - `form`    — create/edit a profile (`ssh.conn.form`),
 *   - `session` — the session workspace: sp7's tab strip and status bar, plus the
 *                 four `ssh.session.*` tabs driven by `ssh.session.runtime`,
 *   - `debug`   — the M0 transport spike, kept because a binding that silently
 *                 degrades is exactly the failure it exists to catch.
 *
 * The M0 spike used to *be* the panel. It is reachable from the header now, and its
 * floating card is opt-in (`spike.showOverlay`), so a first-run user sees the
 * connection manager rather than a diagnostics card.
 */

SSH.define('ssh.panel', function (SSH) {
  const { useState, useEffect, useCallback, useRef } = SSH.react
  const h = SSH.h
  const core = () => SSH.require('ssh.core')

  /**
   * Components are handed the bridge and the store once, by `ssh.plugin`, rather
   * than through props: a slot occupant only receives the props its *owner*
   * declares, so a consumer cannot inject its own. Keeping this in module state
   * also avoids a require cycle between the plugin body and its components.
   */
  let rt = { bridge: null, app: null }

  function configure(next) {
    rt = { ...rt, ...next }
  }

  const conn = () => SSH.require('ssh.conn')
  const sessionRuntime = () => SSH.require('ssh.session.runtime')
  const sessionUi = () => SSH.require('ssh.session.ui')

  /**
   * The agent-activity module (ICD §4.7), or `null`.
   *
   * Tolerated rather than required: a page that is still running a bundle from
   * before this module existed (or one where the module failed to materialise)
   * must keep its terminal tab, not lose the whole session view to a `require`
   * that throws.
   */
  function sessionActivity() {
    try {
      return SSH.require('ssh.session.activity')
    } catch (error) {
      console.warn('[dsh-ssh] the activity module is unavailable', error && error.message)
      return null
    }
  }

  /**
   * The one font-size controller of this client run.
   *
   * Created lazily and shared: the terminal's toolbar, the `fontUp`/`fontDown`/
   * `fontReset` shortcuts and the persisted key (`dsh-ssh.termFontSize`) must all be
   * the same object, or a keystroke would write a size no component is subscribed to.
   */
  let fontControllerInstance = null
  function fontController() {
    if (fontControllerInstance) return fontControllerInstance
    const theme = SSH.require('ssh.chrome.theme')
    fontControllerInstance = theme.createFontController()
    return fontControllerInstance
  }

  /**
   * The shell stream of the session on screen, published for the panel-wide
   * `clearTerminal` shortcut (the chrome's target table is built in `ssh.plugin`,
   * which has no way to reach a component's stream otherwise).
   */
  let activeShellState = null
  function setActiveShell(next) {
    activeShellState = next
  }
  function activeShell() {
    return activeShellState
  }

  /** Translate through the connection layer (chrome dictionaries, then the UI kit). */
  const t = (key, params) => conn().ui().t(key, params)

  /**
   * Layout of the session view.
   *
   * The sidebar is narrow, and a flex column only shrinks children that allow it: a
   * child with the default `min-height: auto` refuses, so the terminal's box collapses
   * to ~0 while the status block keeps its natural height — which in a narrow column
   * wrapped to five lines ("已连接 / user@host / ↑0 B ↓0 B / 无传输任务 / 断开连接").
   * That is why the terminal was invisible *and* why xterm crashed on a zero-height
   * viewport. So: every level needs `min-height: 0`, the tab strip must never wrap
   * away, the terminal needs an `overflow: hidden` parent, the status row truncates
   * instead of wrapping, and an idle transfer slot is not rendered at all.
   */
  const LAYOUT_CSS = `
.dsh-ssh-session-view { display:flex; flex-direction:column; flex:1 1 auto; min-height:0; height:100%;
  container-type:inline-size; }
/* In the narrowest sidebar the shortcut reference is the one element that does not fit:
   dropping it keeps all four view tabs whole instead of scrolling them out of reach. */
@container (max-width: 320px) { .dsh-ssh-session-help { display:none; } }
/* The header must not grow tall in a narrow column: the hint truncates instead of wrapping. */
.dsh-ssh-session-head { flex:0 0 auto; flex-wrap:nowrap; }
.dsh-ssh-session-head > .dsh-ssh-title { flex:0 0 auto; }
.dsh-ssh-session-head > .dsh-ssh-hint { flex:0 1 auto; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dsh-ssh-session-head > button { flex:0 0 auto; }
.dsh-ssh-session-tabs { flex:0 0 auto; display:flex; flex-wrap:nowrap; align-items:center; gap:4px;
  padding:6px 8px; border-bottom:1px solid var(--dsw-alias-border-l1); overflow-x:auto; overflow-y:hidden; }
.dsh-ssh-session-tabs > button { flex:0 0 auto; white-space:nowrap; }
.dsh-ssh-session-body { flex:1 1 auto; min-height:0; display:flex; flex-direction:column; overflow:hidden; }
/* The panel that owns the viewport is the only thing allowed to grow. */
.dsh-ssh-session-body > * { flex:1 1 auto; min-height:0; }
/* …except the 终端 / AI 活动 switch, which is chrome and must keep its own height. */
.dsh-ssh-session-body > .dsh-ssh-term-switch-row { flex:0 0 auto; min-height:0;
  padding:6px 8px 0; border-bottom:1px solid var(--dsw-alias-border-l1); }
.dsh-ssh-session-status { flex:0 0 auto; max-height:calc(2 * 1.6em + 10px); overflow:hidden;
  border-top:1px solid var(--dsw-alias-border-l1); }
.dsh-ssh-session-status .dsh-ssh-statusbar { display:flex; flex-wrap:wrap; align-items:center; gap:2px 8px; padding:4px 8px; }
.dsh-ssh-session-status .dsh-ssh-status-item { flex:0 1 auto; min-width:0; max-width:100%;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
/* An idle transfer slot is not information: it is a row of vertical space we do not have. */
.dsh-ssh-session-status[data-transfer="idle"] [data-testid="ssh-status-transfer"] { display:none; }
`

  let disposeLayoutCss = null
  /** Install the session-view layout sheet once per client run. */
  function ensureLayoutStyles() {
    if (disposeLayoutCss) return
    disposeLayoutCss = SSH.style.insert(LAYOUT_CSS)
  }

  /**
   * "No agent activity", in the shape `ssh.session.activity` reports a summary.
   *
   * Frozen and shared so the summary below is always an object: the switch reads
   * it on every render, and a `null` would have to be guarded at each use site.
   */
  const EMPTY_ACTIVITY_SUMMARY = Object.freeze({ total: 0, running: 0, unread: 0, newestAt: 0, all: { total: 0, running: 0, unread: 0 } })

  // ── M0 diagnostics (unchanged surface, now behind `panel.view === 'debug'`) ──

  function inventoryRows(diagnostics) {
    if (!diagnostics) return []
    return diagnostics.inventory.map((row) => [
      row.id,
      `${row.servicePresent ? 'service present' : 'service absent'}${diagnostics.resolvedId === row.id ? ' · ACTIVE' : ''}`,
    ])
  }

  function SpikePanel() {
    const [busy, setBusy] = useState(false)
    const { ui } = core()
    const { Card, Button, KV, Mono, Pill } = ui
    const { bridge, app } = rt
    const state = app.useApp()
    const { actions } = app
    const spike = state.spike
    const transport = state.bridge.transport

    const refreshDiagnostics = () => {
      actions.setSpike({ diagnostics: bridge.diagnostics() })
    }

    useEffect(() => {
      refreshDiagnostics()
      return bridge.onTransportChange((next) => {
        actions.setBridge({ transport: next })
        refreshDiagnostics()
      })
    }, [])

    const runPing = async () => {
      setBusy(true)
      actions.setSpike({ running: true, pingError: null })
      try {
        const result = await bridge.call('ping', { echo: 'ui' })
        actions.setSpike({ ping: result, pingError: null })
        actions.setBridge({ resolvedId: bridge.context().resolvedId })
      } catch (error) {
        actions.setSpike({ ping: null, pingError: error })
      } finally {
        setBusy(false)
        actions.setSpike({ running: false })
        refreshDiagnostics()
      }
    }

    const runStream = (fail) => {
      actions.clearFrames()
      actions.setSpike({ streamNote: fail ? 'running failing stream…' : 'running stream…' })
      bridge.stream('probeStream', { count: 5, intervalMs: 120, fail }, (frame) => {
        actions.appendFrame(frame)
        if (frame.t === 'end') {
          actions.setSpike({
            streamNote: `stream ended: ${frame.reason}${frame.error ? ` (${frame.error.code})` : ''}`,
          })
        }
      })
      refreshDiagnostics()
    }

    const tone = transport.status === 'ready' ? 'ok' : transport.status === 'lost' ? 'error' : 'warn'

    return h(
      'div',
      { className: 'dsh-ssh-body', 'data-testid': 'ssh-spike-panel' },
      h(
        Card,
        { tone },
        h(
          'div',
          { className: 'dsh-ssh-row' },
          h(Pill, { state: transport.status === 'ready' ? 'connected' : 'connecting' },
            `carrier: ${state.bridge.resolvedId || 'unresolved'}`),
          h(Pill, null, `version: ${spike.ping ? spike.ping.version : '—'}`),
        ),
        h(KV, {
          rows: [
            ['transport', `${transport.kind} / ${transport.status} (gen ${transport.generation})`],
            ['plugin', spike.ping ? spike.ping.pluginVersion : SSH.id],
            ['host node', spike.ping ? spike.ping.node : '—'],
            ['handler', spike.ping ? `${spike.ping.handlerMs} ms` : '—'],
          ],
        }),
        h(
          'div',
          { className: 'dsh-ssh-row' },
          h(Button, { kind: 'primary', loading: busy, onClick: runPing, dataTestId: 'ssh-ping' }, 'Run ping'),
          h(Button, { onClick: () => runStream(false), disabled: busy, dataTestId: 'ssh-stream' }, 'Stream 5 frames'),
          h(Button, { onClick: () => runStream(true), disabled: busy, dataTestId: 'ssh-stream-fail' }, 'Stream (failure)'),
          h(Button, { onClick: refreshDiagnostics, disabled: busy }, 'Refresh diagnostics'),
        ),
        spike.pingError
          ? h(Mono, { dataTestId: 'ssh-ping-error' },
              `${spike.pingError.code}: ${spike.pingError.message}\n${JSON.stringify(spike.pingError.details ?? {}, null, 2)}`)
          : null,
        spike.ping
          ? h(Mono, { dataTestId: 'ssh-ping-result' }, JSON.stringify(spike.ping, null, 2))
          : h('div', { className: 'dsh-ssh-hint' }, 'No ping yet — press "Run ping" to verify the client→host carrier.'),
      ),

      h(
        Card,
        null,
        h('div', { className: 'dsh-ssh-label' }, 'Carrier inventory'),
        h(KV, { rows: inventoryRows(spike.diagnostics) }),
        h('div', { className: 'dsh-ssh-hint' }, 'A carrier is only accepted after a real ping round trip answers.'),
      ),

      h(
        Card,
        { tone: spike.frames.length > 0 ? 'ok' : 'neutral' },
        h(
          'div',
          { className: 'dsh-ssh-row' },
          h('span', { className: 'dsh-ssh-label' }, 'Stream probe'),
          h('span', { className: 'dsh-ssh-hint' }, spike.streamNote || 'idle'),
        ),
        h(Mono, { dataTestId: 'ssh-stream-log' },
          spike.frames.length === 0
            ? '(no frames)'
            : spike.frames
                .map((frame) => {
                  if (frame.t === 'data') return `[${frame.seq}] ${frame.channel}: ${String(frame.chunk).trimEnd()}`
                  if (frame.t === 'open') return `open kind=${frame.kind} stream=${frame.streamId}`
                  if (frame.t === 'end') return `end reason=${frame.reason}${frame.error ? ` code=${frame.error.code}` : ''}`
                  return `${frame.t} ${JSON.stringify(frame)}`
                })
                .join('\n')),
      ),

      spike.diagnostics
        ? h(
            Card,
            null,
            h('div', { className: 'dsh-ssh-label' }, 'Probe attempts'),
            h(Mono, null, JSON.stringify(spike.diagnostics.attempts, null, 2)),
            h('div', { className: 'dsh-ssh-label' }, 'Service shapes'),
            h(Mono, null, JSON.stringify(spike.diagnostics.serviceShapes, null, 2)),
          )
        : null,

      spike.registrationErrors.length > 0
        ? h(
            Card,
            { tone: 'error' },
            h('div', { className: 'dsh-ssh-label' }, 'Registration problems'),
            h(Mono, { dataTestId: 'ssh-registration-errors' },
              spike.registrationErrors.map((entry) => `${entry.what}: ${entry.message}`).join('\n')),
          )
        : null,
    )
  }

  // ── Session view ──────────────────────────────────────────────────────────

  /** The four workspace tabs of one session (`ws.tabs.*`, ICD §8.5). */
  const WORKSPACE_TABS = [
    ['terminal', 'ws.tabs.terminal'],
    ['command', 'ws.tabs.command'],
    ['files', 'ws.tabs.files'],
    ['logs', 'ws.tabs.logs'],
  ]

  /**
   * One session: open its shell (`openShell`), then host the four tabs.
   *
   * The shell stream is opened by the container — not by `TerminalTab` — because the
   * stream belongs to the session, not to the tab that happens to be visible: a user
   * who switches to the file manager must not lose the terminal's scrollback.
   *
   * The 终端 tab has two faces: the interactive PTY and the mirror of what the model
   * did through the `ssh_*` tools (ICD §4.7). The mirror exists because the agent's
   * commands never travel through this client — before it, a user watching the
   * terminal while the model worked saw an empty screen, and afterwards had no way to
   * find out what had run. The switch is therefore *inside* the tab rather than a
   * fifth tab, and it follows the agent on its own:
   *
   *   - a session with activity opens on the mirror, so the tab is never a blank
   *     shell pretending nothing happened;
   *   - new activity switches to it, unless the user is typing into the PTY (the
   *     one case where an automatic switch would fight the user) or has picked a
   *     face themselves (an explicit choice is never overridden).
   */
  function SessionView(props) {
    const { sessionId, onOpenHelp } = props
    const app = rt.app
    const runtime = sessionRuntime()
    const state = app.useApp()
    const chrome = conn().chrome()
    const { Button } = sessionUi().ui()
    const session = state.sessions.items.find((item) => item.id === sessionId) || null
    const { transfers } = runtime.useTransfers()
    const [active, setActive] = useState('terminal')
    const [shellLocalId, setShellLocalId] = useState(null)
    const [history, setHistory] = useState([])
    const [exec, setExec] = useState({ running: false, result: null, localId: null })
    const activity = sessionActivity()
    // Read from the store, not from a first render: a panel reopened after the agent
    // worked must land on the mirror even though the snapshot arrives asynchronously.
    const [termFace, setTermFace] = useState(() => {
      if (!activity) return 'terminal'
      try {
        return activity.activityStore.getRecords(sessionId).length > 0 ? 'activity' : 'terminal'
      } catch {
        return 'terminal'
      }
    })
    const faceChosenByUser = useRef(false)
    /**
     * The activity module owns the subscription; this component only reads its
     * summary. The hook is called through the module when it is present and
     * replaced by a plain reader when it is not, so the hook order never depends on
     * whether this bundle contains the module (an HMR'd page may not).
     */
    const summary = activity && typeof activity.useActivitySummary === 'function'
      ? activity.useActivitySummary({ sessionId })
      : EMPTY_ACTIVITY_SUMMARY
    /**
     * Primitive projections of the summary.
     *
     * The effect below must not depend on the summary *object*: the store hands out
     * a fresh one per change, and depending on its identity would re-run the effect
     * on every store notification — which, with `markActivitySeen()` inside, is how
     * a polling loop starts. `unread` is global (the badge surfaces work the agent
     * did on another host); the counts that decide the automatic switch are this
     * session's, so a background host cannot steal the view.
     */
    const unread = (summary.all && typeof summary.all.unread === 'number' ? summary.all.unread : summary.unread) || 0
    const activityCount = summary.total
    const activityRunning = summary.running

    ensureLayoutStyles()

    // Follow the agent while the interactive terminal is showing. The focus test is a
    // DOM read at the decision point rather than a prop on `TerminalTab`: the terminal
    // owns its own focus handling, and a stale boolean here would either switch away
    // mid-keystroke or refuse to follow a genuinely idle user.
    useEffect(() => {
      if (!activity) return
      if (active !== 'terminal') return
      if (termFace === 'activity') {
        // Only when there is something to mark: a store that notifies even on a
        // no-op clear would otherwise re-enter this effect forever.
        if (unread > 0) activity.markActivitySeen()
        return
      }
      if (activityCount === 0 || faceChosenByUser.current) return
      const focused = typeof document !== 'undefined' ? document.activeElement : null
      if (focused && typeof focused.closest === 'function' && focused.closest('.ssh-ws-term')) return
      setTermFace('activity')
    }, [active, activity, activityCount, activityRunning, unread, termFace])

    useEffect(() => {
      if (!sessionId) return undefined
      let shell = null
      try {
        console.info('[dsh-ssh] session view mounted; opening the shell', { sessionId })
        shell = runtime.actions.openShell({ sessionId, cols: 80, rows: 24, term: 'xterm-256color' })
        setShellLocalId(shell.localId)
        setActiveShell({ sessionId, localId: shell.localId })
      } catch (error) {
        console.warn('[dsh-ssh] openShell threw', { code: error && error.code, message: error && error.message })
        setShellLocalId(null)
        setActiveShell(null)
      }
      return () => {
        if (activeShell() && activeShell().localId === (shell && shell.localId)) setActiveShell(null)
        if (!shell) return
        // A rejected close is normal (the stream may already be gone), and `try/catch`
        // does not catch a promise: without this the cleanup surfaces as an unhandled
        // rejection in the page console.
        try {
          const closing = runtime.actions.shellClose(shell.localId)
          if (closing && typeof closing.catch === 'function') closing.catch(() => {})
        } catch {
          /* the stream may already be gone */
        }
      }
    }, [sessionId])

    const { record } = runtime.useStream(shellLocalId)
    const streamId = record ? record.streamId : null

    // The font size is *controlled* by the shared controller so the toolbar buttons,
    // the shortcuts and the persisted value cannot drift apart.
    const controller = fontController()
    const theme = SSH.require('ssh.chrome.theme')
    const fontSize = theme.useFontSize(controller)

    const runCommand = useCallback(
      async (command) => {
        setHistory((current) => [...current, command])
        setExec({ running: true, result: null, localId: null })
        try {
          const started = runtime.actions.exec({ sessionId, command })
          setExec({ running: true, result: null, localId: started.localId })
          const result = await started.result
          setExec({ running: false, result, localId: started.localId })
        } catch (error) {
          setExec({
            running: false,
            localId: null,
            result: {
              stdout: '',
              stderr: '',
              exitCode: null,
              durationMs: 0,
              error: { code: error && error.code ? error.code : 'SSH_UNKNOWN', message: error && error.message ? error.message : String(error) },
            },
          })
        }
      },
      [sessionId],
    )

    const body = () => {
      if (active === 'terminal') {
        const terminal = h(SSH.require('ssh.session.terminal').TerminalTab, {
          sessionId,
          streamId,
          fontSize,
          onFontSizeChange: (next) => controller.setSize(next),
          // `streamId` here is the stream's *local* id, which is what
          // `reconnectShell` resumes from (`sinceSeq`).
          onReconnect: () => runtime.actions.reconnectShell({ sessionId, streamId: shellLocalId }),
        })
        if (!activity || typeof activity.AgentActivitySwitch !== 'function') {
          return h('div', { className: 'dsh-ssh-session-body' }, terminal)
        }
        return h(
          'div',
          { className: 'dsh-ssh-session-body' },
          h(
            'div',
            { className: 'dsh-ssh-term-switch-row', 'data-testid': 'ssh-term-switch-row' },
            h(activity.AgentActivitySwitch, {
              mode: termFace,
              onMode: (next) => {
                // An explicit choice outranks the automatic follow for the rest of
                // this session view's life.
                faceChosenByUser.current = true
                setTermFace(next)
              },
              summary,
            }),
          ),
          termFace === 'activity' && typeof activity.AgentActivityPane === 'function'
            ? h(activity.AgentActivityPane, { sessionId })
            : terminal,
        )
      }
      if (active === 'command') {
        return h('div', { className: 'dsh-ssh-session-body' },
          h(SSH.require('ssh.session.command').CommandPanel, {
            sessionId,
            history,
            running: exec.running,
            result: exec.result,
            onRun: runCommand,
            onCancel: () => runtime.actions.cancel(exec.localId),
            onClear: () => setExec({ running: false, result: null, localId: null }),
          }))
      }
      if (active === 'files') {
        return h('div', { className: 'dsh-ssh-session-body' },
          h(SSH.require('ssh.session.files').FileManager, { sessionId }))
      }
      return h('div', { className: 'dsh-ssh-session-body' },
        h(SSH.require('ssh.session.logs').LogTab, { sessionId }))
    }

    return h(
      'div',
      {
        className: 'dsh-ssh-root dsh-ssh-session-view',
        'data-testid': 'ssh-session-view',
        'data-session-id': sessionId || '',
      },
      h(
        'div',
        { className: 'dsh-ssh-session-tabs', 'data-testid': 'ssh-session-tabs' },
        WORKSPACE_TABS.map(([name, key]) =>
          h(Button, {
            key: name,
            kind: active === name ? 'primary' : 'secondary',
            size: 'sm',
            onClick: () => setActive(name),
            dataTestId: `ssh-session-tab-${name}`,
            'aria-pressed': active === name,
          }, t(key))),
        h('span', { style: { flex: '1 1 auto' } }),
        // The theme switch sits **outside** the wrapper below: the sidebar at its
        // narrowest is the width the user actually works at, and the container query that
        // drops the shortcut reference must not take the theme control with it.
        chrome && chrome.ThemeToggle ? h(chrome.ThemeToggle, {}) : null,
        // Wrapped so a container query can drop it when the sidebar is at its narrowest.
        h('span', { className: 'dsh-ssh-session-help' },
          h(Button, { size: 'sm', onClick: () => onOpenHelp(), dataTestId: 'ssh-session-help' }, t('chrome.shortcut.title'))),
      ),
      body(),
      h(
        'div',
        {
          className: 'dsh-ssh-session-status',
          'data-testid': 'ssh-session-status',
          // Drives the CSS that hides the idle transfer slot: the container knows whether
          // a transfer is in flight, so the status bar does not have to.
          'data-transfer': transfers.length > 0 ? 'active' : 'idle',
        },
        chrome && chrome.StatusBar
          ? h(chrome.StatusBar, {
              info: session
                ? {
                    ...session,
                    sessionId: session.id,
                    sessionState: session.state,
                    target: conn().ui().targetOf(session),
                    rttMs: session.metrics ? session.metrics.rttMs : undefined,
                    bytesIn: session.metrics ? session.metrics.bytesIn : undefined,
                    bytesOut: session.metrics ? session.metrics.bytesOut : undefined,
                    connectedAt: session.since,
                  }
                : null,
              onDisconnect: () => app.actions.closeTab(sessionId),
              onReconnect: () => runtime.actions.reconnectShell({ sessionId, streamId: shellLocalId }),
            })
          : null,
      ),
    )
  }

  // ── Header + view switch ──────────────────────────────────────────────────

  /**
   * The tab body: the shell owns the tab strip, so this is content only.
   *
   * `panel.view` decides what that content is (list / form / session / debug).
   */
  function SshWorkspace() {
    const app = rt.app
    const state = app.useApp()
    const { Button } = sessionUi().ui()
    const view = state.panel.view
    const [helpOpen, setHelpOpen] = useState(false)
    const transport = state.bridge.transport
    const dot = transport.status === 'ready' ? 'connected' : transport.status === 'lost' ? 'error' : 'connecting'

    conn().installStyles()
    ensureLayoutStyles()

    const chrome = conn().chrome()
    const ShortcutHelp = chrome ? chrome.ShortcutHelp : null
    const TabStrip = chrome ? chrome.TabStrip : null

    const goDebug = () => app.actions.setPanel({ view: view === 'debug' ? (state.activeSessionId ? 'session' : 'list') : 'debug' })

    // Diagnostic only: "session view with nothing to open" is one of the reasons a
    // terminal stays empty, and it is invisible without saying so.
    useEffect(() => {
      if (view === 'session' && !state.activeSessionId) {
        console.info('[dsh-ssh] session view has no active session; nothing to open', {
          view,
          tabs: state.tabs.length,
          sessions: state.sessions.items.length,
        })
      }
    }, [view, state.activeSessionId])

    return h(
      'div',
      { className: 'dsh-ssh-root', 'data-testid': 'ssh-workspace', 'data-view': view },
      h(
        'div',
        { className: 'dsh-ssh-head dsh-ssh-session-head' },
        h('span', { className: 'dsh-ssh-dot', 'data-state': dot }),
        h('span', { className: 'dsh-ssh-title' }, t('panel.title')),
        h('span', { className: 'dsh-ssh-hint', 'data-testid': 'ssh-transport-hint' },
          state.bridge.resolvedId ? `${transport.kind} · ${transport.status}` : t('status.disconnected')),
        h('span', { style: { flex: '1 1 auto' } }),
        view !== 'form'
          ? h(Button, { size: 'sm', onClick: () => app.actions.openForm(null), dataTestId: 'ssh-head-new' }, t('conn.new'))
          : null,
        h(Button, { size: 'sm', kind: view === 'debug' ? 'primary' : 'secondary', onClick: goDebug, dataTestId: 'ssh-head-debug' },
          t('spike.title')),
      ),

      // One tab per session; the strip is the chrome's, the list is the store's.
      view === 'session' && TabStrip && state.tabs.length > 0
        ? h(TabStrip, {
            tabs: state.tabs,
            activeId: state.activeSessionId,
            /**
             * Resolve the *clicked* tab to its session id string.
             *
             * The strip may hand back a tab record (and a real report showed exactly that:
             * an object reaching the store, which can never equal a string id — so the click
             * did nothing). Only the clicked tab is consulted; the active id is never used
             * here, or clicking a background tab would just re-select the current one.
             */
            onChange: (input) => {
              const requested = typeof input === 'object' && input !== null ? input.sessionId ?? input.id : input
              const match = state.tabs.find((tab) => tab.id === requested || tab.sessionId === requested)
              app.actions.activateTab(match ? match.sessionId ?? match.id : requested)
            },
            // A live session is confirmed by the strip itself (`confirm.danger('closeSession')`).
            onClose: (input) => {
              const requested = typeof input === 'object' && input !== null ? input.sessionId ?? input.id : input
              if (typeof requested === 'string') app.actions.closeTab(requested)
            },
            onReorder: (order) => app.actions.reorderTabs(order),
            onNew: () => app.actions.openForm(null),
          })
        : null,

      view === 'list' ? h(conn().components().ConnList, { app }) : null,
      view === 'form' ? h(conn().components().ConnForm, { app }) : null,
      view === 'session'
        ? state.activeSessionId
          ? h(SessionView, { sessionId: state.activeSessionId, onOpenHelp: () => setHelpOpen(true) })
          : h('div', { className: 'dsh-ssh-body' },
              h('div', { className: 'dsh-ssh-hint', 'data-testid': 'ssh-session-none' }, t('conn.list.empty')),              h(Button, { kind: 'primary', onClick: () => app.actions.setPanel({ view: 'list' }), dataTestId: 'ssh-session-back' },
                t('conn.new')))
        : null,
      view === 'debug' ? h(SpikePanel) : null,

      helpOpen && ShortcutHelp
        ? h(ShortcutHelp, { open: true, onClose: () => setHelpOpen(false), bindings: chrome.describeShortcuts ? chrome.describeShortcuts() : undefined })
        : null,
    )
  }

  /**
   * Panel-list icon: monochrome, inherits the row colour.
   * The owner supplies `{ size, active }`, so the glyph follows the shell's
   * geometry instead of assuming 16px in every context (expanded row vs rail).
   */
  function SshPanelIcon(props) {
    const size = typeof props?.size === 'number' && props.size > 0 ? props.size : 16
    return h(
      'svg',
      {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      h('rect', { x: 2.5, y: 4, width: 19, height: 14, rx: 2.5 }),
      h('path', { d: 'M6.5 9.2 9 11.4l-2.5 2.2' }),
      h('path', { d: 'M11.5 13.6h6' }),
    )
  }

  /**
   * Floating diagnostics card (root `shell.overlay` slot).
   *
   * M0 legacy, kept because a binding that degrades silently is what it exists to catch.
   * It is `position: fixed` with a very high `z-index`, so if it ever appeared over the
   * session view it would cover the terminal — which is exactly what a stray persisted
   * flag from the M0 era would have done. Two conditions now: the flag **and** the debug
   * view. Neither the store nor the persisted snapshot can raise it on its own.
   */
  function SpikeOverlay() {
    const state = rt.app.useApp()
    if (state.spike.showOverlay !== true || state.panel.view !== 'debug') return null
    return h(
      'div',
      { className: 'dsh-ssh-float', 'data-testid': 'ssh-spike-overlay' },
      h(
        'div',
        { className: 'dsh-ssh-head' },
        h('span', {
          className: 'dsh-ssh-dot',
          'data-state': state.bridge.transport.status === 'ready' ? 'connected' : 'connecting',
        }),
        h('span', { className: 'dsh-ssh-title' }, t('spike.title')),
        h('span', { style: { flex: '1 1 auto' } }),
        h(core().ui.Button, { onClick: () => rt.app.actions.setSpike({ showOverlay: false }) }, t('chrome.shortcut.close')),
      ),
      h(SpikePanel),
    )
  }

  return {
    configure,
    SpikePanel,
    SshWorkspace,
    SshPanelIcon,
    SpikeOverlay,
    SessionView,
    WORKSPACE_TABS,
    // Shared with `ssh.plugin`: one font controller, one published shell stream.
    fontController,
    activeShell,
    setActiveShell,
  }
})
