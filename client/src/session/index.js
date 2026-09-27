/**
 * @module ssh.session
 * @order 480
 *
 * Integration surface for the session workspace.
 *
 * SP5's workspace container mounts the four tabs and passes the frozen ICD §8.3
 * props; this module is what it requires once, plus a standalone composition used
 * by the component tests and by the demo/screenshot harness:
 *
 * ```js
 * const session = SSH.require('ssh.session')
 * session.configure({ bridge, app })          // once, from the plugin body
 * const { TerminalTab, CommandPanel, FileManager, LogTab } = session.components()
 * const { AgentActivityPane, AgentActivitySwitch } = session.activityComponents()
 * ```
 *
 * `configure` is a passthrough to the runtime so the plugin body needs one require
 * and no knowledge of the tab internals. The agent-activity mirror lives on its own
 * accessor for the reason spelled out at `activityComponents()` below.
 */

SSH.define('ssh.session', function (SSH) {
  const { useState, useEffect } = SSH.react
  const h = SSH.h

  const TAB_IDS = ['terminal', 'command', 'files', 'logs']

  function runtime() {
    return SSH.require('ssh.session.runtime')
  }

  function configure(wiring) {
    return runtime().configure(wiring)
  }

  /** Install the workspace stylesheet and the vendored emulator stylesheet. */
  function installStyles() {
    SSH.require('ssh.session.styles').ensureStyles()
    try {
      SSH.require('ssh.vendor.xterm.css').install()
    } catch {
      /* the emulator stylesheet is optional (the built-in screen has its own) */
    }
  }

  function components() {
    return {
      TerminalTab: SSH.require('ssh.session.terminal').TerminalTab,
      CommandPanel: SSH.require('ssh.session.command').CommandPanel,
      FileManager: SSH.require('ssh.session.files').FileManager,
      LogTab: SSH.require('ssh.session.logs').LogTab,
    }
  }

  /**
   * The agent-activity mirror (ICD §4.7), as its own surface.
   *
   * Deliberately **not** keys of `components()`: that object is pinned to the four
   * frozen §8.3 workspace components by `test/client/session.test.mjs`
   * ("ssh.session exposes the four frozen components" — an exact
   * `Object.keys(...).sort()` comparison), so growing it there would convert a
   * frozen set into a failing test instead of an added capability. Both are plain
   * components of props and are re-exported here — next to `configure`/`runtime` —
   * so a test, a later seat or the demo harness reaches them the same way.
   * (`client/src/panel.js`, the real mount point, requires `ssh.session.activity`
   * directly and tolerates the module being absent.)
   */
  function activityComponents() {
    const activity = SSH.require('ssh.session.activity')
    return {
      AgentActivityPane: activity.AgentActivityPane,
      AgentActivitySwitch: activity.AgentActivitySwitch,
    }
  }

  /**
   * Standalone four-tab composition.
   *
   * SP5 owns the mounted container (tab strip, session list, persistence); this one
   * exists so the component tests, the screenshot harness and a fallback mount all
   * have a working surface that composes exactly the frozen components. It reads
   * nothing from the store and forwards its own props to the active tab.
   */
  function StandaloneWorkspace(props) {
    const settings = props || {}
    const ui = SSH.require('ssh.session.ui')
    const primitives = ui.ui()
    const t = ui.t
    const [active, setActive] = useState(typeof settings.activeTab === 'string' ? settings.activeTab : 'terminal')

    useEffect(() => {
      installStyles()
    }, [])

    const tabs = TAB_IDS.map((id) => ({ id, label: t(`ws.tabs.${id}`) }))
    const activeId = TAB_IDS.includes(active) ? active : 'terminal'

    const strip =
      typeof primitives.Tabs === 'function'
        ? h(primitives.Tabs, { tabs, activeId, onChange: setActive })
        : h(
            'div',
            { className: 'ssh-ws-toolbar', 'data-testid': 'ssh-ws-standalone-tabs' },
            tabs.map((tab) =>
              h(
                'button',
                {
                  key: tab.id,
                  type: 'button',
                  className: 'ssh-ws-filter',
                  'data-active': tab.id === activeId ? 'true' : 'false',
                  onClick: () => setActive(tab.id),
                },
                tab.label,
              ),
            ),
          )

    const body = (() => {
      if (activeId === 'terminal') {
        return h(SSH.require('ssh.session.terminal').TerminalTab, {
          sessionId: settings.sessionId,
          streamId: settings.streamId,
          fontSize: settings.fontSize,
          onFontSizeChange: settings.onFontSizeChange,
          onReconnect: settings.onReconnect,
          onDirtyChange: settings.onDirtyChange,
          onExit: settings.onExit,
          session: settings.session,
        })
      }
      if (activeId === 'command') {
        return h(SSH.require('ssh.session.command').CommandPanel, {
          sessionId: settings.sessionId,
          history: settings.history,
          onRun: settings.onRun,
          running: settings.running,
          result: settings.result,
          onClear: settings.onClearResult,
          onCancel: settings.onCancel,
          streamId: settings.execStreamId,
        })
      }
      if (activeId === 'files') {
        return h(SSH.require('ssh.session.files').FileManager, {
          sessionId: settings.sessionId,
          localRoot: settings.localRoot,
          remoteRoot: settings.remoteRoot,
          localEntries: settings.localEntries,
          remoteEntries: settings.remoteEntries,
          transfers: settings.transfers,
          loadingByPane: settings.loadingByPane,
          onUpload: settings.onUpload,
          onDownload: settings.onDownload,
          onMkdir: settings.onMkdir,
          onRename: settings.onRename,
          onDelete: settings.onDelete,
          onChmod: settings.onChmod,
          onRefresh: settings.onRefreshFiles,
          onNavigate: settings.onNavigate,
          onTransferCancel: settings.onTransferCancel,
        })
      }
      return h(SSH.require('ssh.session.logs').LogTab, {
        sessionId: settings.sessionId,
        entries: settings.auditEntries,
        levelFilter: settings.levelFilter,
        onLevelFilterChange: settings.onLevelFilterChange,
        onClear: settings.onClearAudit,
        onRefresh: settings.onRefreshAudit,
        onExport: settings.onExportAudit,
      })
    })()

    return h('div', { className: 'ssh-ws', 'data-testid': 'ssh-ws-standalone' }, strip, body)
  }

  return {
    configure,
    runtime,
    components,
    activityComponents,
    installStyles,
    StandaloneWorkspace,
    TAB_IDS,
    // Also on the module surface directly, so a caller needs one require and one
    // property read. Materialising `ssh.session.activity` here is safe: its factory
    // only defines functions (every `SSH.require` inside it is lazy).
    ...activityComponents(),
  }
})
