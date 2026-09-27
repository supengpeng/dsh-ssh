/**
 * @module ssh.plugin
 * @order 900
 *
 * Client plugin body: the entry DSH's module loader materialises for this
 * package. It wires the bridge and the store, then registers the panel icon,
 * the right-sidebar tab type and its body — each registration independently, so
 * one unavailable seat degrades to a reported problem instead of a dead panel.
 *
 * Injected services are the two every composition provides. `sidebarRightTabs`
 * and `sidebarRight` are looked up opportunistically and their absence is
 * recorded, because a hard `inject` on a seat this build does not have would
 * leave the plugin waiting forever with nothing on screen to explain why.
 */

SSH.define('ssh.plugin', function (SSH) {
  const h = SSH.h

  const inject = ['slots', 'locale']

  /** Tab type / body key; must match `client.tabKind` in dsh.plugin.json. */
  const TAB_ID = 'ssh'
  const TAB_KIND = 'ssh'
  const NS = 'ssh'

  /**
   * Identity of the client half that is actually running.
   *
   * "The fix did not work" has repeatedly meant "the page is still running the previous
   * bundle": a rebuilt artifact is not proof that the browser loaded it. This string is
   * logged once when the plugin body applies and is greppable in `lib/client.js`, so a
   * single console line settles whether the code on screen is the code on disk.
   */
  const BUILD_MARKER = 'ssh-client-2026-09-26.6-tab-id-normalised'

  /**
   * The plugin body's own strings.
   *
   * Deliberately **not** registered with the shell. `ssh.chrome` owns the `ssh`
   * namespace: `chrome.install()` registers the full compiled dictionary (171 keys ×
   * 2 locales) there, and a second, three-key registration on the same namespace would
   * replace it wholesale under a last-write-wins service. This table is only a *local*
   * fallback for a string the compiled dictionary does not carry — `spike.title`, the
   * debug card's heading.
   */
  const LOCAL_STRINGS = {
    zh: {
      'tab.title': 'SSH',
      'panel.title': 'SSH',
      'spike.title': 'SSH 插件 · 传输探针',
    },
    en: {
      'tab.title': 'SSH',
      'panel.title': 'SSH',
      'spike.title': 'SSH plugin · transport spike',
    },
  }

  /** The local table, interpolated the way the compiled dictionaries are. */
  function localString(key, params) {
    let id = 'zh'
    try {
      const chrome = SSH.require('ssh.chrome')
      const snapshot = chrome && chrome.i18n && typeof chrome.i18n.getLocale === 'function' ? chrome.i18n.getLocale() : null
      const value = snapshot && typeof snapshot === 'object' ? snapshot.id : snapshot
      if (typeof value === 'string' && value.toLowerCase().startsWith('en')) id = 'en'
    } catch {
      /* no chrome yet: the Chinese table is the source of truth */
    }
    const text = (LOCAL_STRINGS[id] || LOCAL_STRINGS.zh)[key]
    if (typeof text !== 'string') return null
    if (!params) return text
    return text.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])))
  }

  /**
   * The plugin body's translator.
   *
   * Registration is left **entirely** to the chrome — one owner per namespace, so no
   * partial overwrite is possible. Lookup order: the chrome's `i18n.t` (the compiled
   * dictionary, then the shell's locale service) → the local table above → the key.
   */
  function registerLocale(ctx, report) {
    let chrome = null
    try {
      chrome = SSH.require('ssh.chrome')
    } catch (error) {
      report('locale', error)
    }
    if (!chrome || !chrome.i18n || typeof chrome.i18n.t !== 'function') {
      report('locale', new Error('ssh.chrome.i18n is unavailable; falling back to local strings'))
    } else if (typeof chrome.registerLocale === 'function') {
      // Idempotent inside the chrome; calling it here means the dictionaries exist even
      // if no chrome component has rendered yet.
      try {
        const result = chrome.registerLocale(ctx)
        if (result && result.ok === false) report('locale', new Error(result.reason || 'locale service is absent'))
      } catch (error) {
        report('locale', error)
      }
    }
    return (key, params) => {
      if (chrome && chrome.i18n && typeof chrome.i18n.t === 'function') {
        try {
          const text = chrome.i18n.t(key, params)
          if (typeof text === 'string' && text !== '' && text !== key) return text
        } catch {
          /* fall through to the local table */
        }
      }
      const local = localString(key, params)
      return local === null ? key : local
    }
  }

  /**
   * The live runtime of the most recent `apply()`.
   *
   * A slot occupant receives only the props its owner declares, so components
   * read the bridge and store from here. Exposed through the bundle as
   * `introspect()` as well: the diagnostics panel and the headless tests both
   * need to reach the real bridge rather than a reconstruction of it.
   */
  let runtime = null

  function currentRuntime() {
    return runtime
  }

  function apply(ctx) {
    const core = SSH.require('ssh.core')
    const storeModule = SSH.require('ssh.store')
    const bridgeModule = SSH.require('ssh.bridge')
    const panel = SSH.require('ssh.panel')

    core.ensureStyles()

    // One line that answers "is the page running the code I just built?".
    console.info(`[dsh-ssh] client applied: ${BUILD_MARKER}`)

    const bridge = bridgeModule.createBridge(ctx)
    const app = storeModule.createAppStore()
    panel.configure({ bridge, app })
    // Published before any registration so a component rendered by an early seat
    // never sees a half-built runtime; `resolution` is filled in below.
    const state = { ctx, bridge, app, resolution: null, buildMarker: BUILD_MARKER }
    runtime = state

    // The session workspace's data plane (SP6). Its components never touch the
    // bridge directly; this is the one place that hands them the bridge and the
    // store. The module also self-heals by reading `currentRuntime()` below, so a
    // missing line degrades instead of breaking — but the explicit call wins and
    // keeps the lifecycle readable.
    try {
      const sessionRuntime = SSH.require('ssh.session.runtime')
      if (sessionRuntime && typeof sessionRuntime.configure === 'function') {
        sessionRuntime.configure({ bridge, app })
      }
    } catch (error) {
      console.error(`[dsh-ssh] session runtime configure failed: ${error && error.message ? error.message : error}`)
    }

    const report = (what, error) => {
      const message = error && error.message ? error.message : String(error)
      app.actions.addRegistrationError({ what, message })
      console.error(`[dsh-ssh] ${what} failed: ${message}`)
    }

    const t = registerLocale(ctx, report)

    /** Run one registration, keeping a disposer and never breaking the others. */
    const attempt = (what, fn) => {
      try {
        const dispose = fn()
        if (typeof dispose === 'function') ctx.effect(() => dispose, `dsh-ssh: ${what}`)
      } catch (error) {
        report(what, error)
      }
    }

    /** Require a module without letting its absence break the caller. */
    const safeRequire = (name) => {
      try {
        return SSH.require(name)
      } catch {
        return null
      }
    }

    /** Read a client service without letting an absent one break the caller. */
    const safeService = (name) => {
      try {
        return typeof ctx.get === 'function' ? ctx.get(name) ?? undefined : undefined
      } catch {
        return undefined
      }
    }

    // The connection manager (SP6, taken over from T5): one `configure()` wires the
    // store, the endpoint client and the chrome, and attaches the endpoint client to
    // the store as its *connector* — which is what lets every `actions.*` call reach
    // the host without a component ever touching the bridge.
    attempt('connection manager', () => {
      const conn = safeRequire('ssh.conn')
      if (!conn || typeof conn.configure !== 'function') throw new Error('ssh.conn is unavailable')
      conn.configure({ app, bridge, chrome: safeRequire('ssh.chrome') })
      return undefined
    })

    // The chrome's shortcut table (ICD §8.4). Only targets that really exist are
    // filled in: `resolveFor` answers `pass` for a missing one, so a fabricated
    // target would only fail later, when the user presses the key.
    attempt('chrome', () => {
      const chrome = safeRequire('ssh.chrome')
      if (!chrome || typeof chrome.install !== 'function') throw new Error('ssh.chrome is unavailable')
      const sessionRuntime = safeRequire('ssh.session.runtime')
      const panelModule = safeRequire('ssh.panel')
      const theme = safeRequire('ssh.chrome.theme')
      // The *same* controller the terminal subscribes to, so a shortcut and a toolbar
      // click move one font size (they also share the storage key).
      const font = panelModule && typeof panelModule.fontController === 'function'
        ? panelModule.fontController()
        : theme && typeof theme.createFontController === 'function'
          ? theme.createFontController()
          : null

      const targets = {
        focusPanel: () => {
          const sidebar = safeService('sidebarRight')
          if (sidebar && typeof sidebar.openTab === 'function') sidebar.openTab(TAB_ID, {})
        },
        newConnection: () => app.actions.openForm(null),
        closeTab: () => {
          const state = app.store.getState()
          if (state.activeSessionId) app.actions.closeTab(state.activeSessionId)
        },
        nextTab: () => app.actions.cycleTab(1),
        prevTab: () => app.actions.cycleTab(-1),
        jumpTab: (index) => app.actions.jumpTab(index),
        escape: () => app.actions.dismissOverlays(),
        /**
         * Clear the visible terminal.
         *
         * A focused terminal clears itself (its own Ctrl+L handler). This is the
         * panel-wide route: it asks the *remote* shell to clear, so what the user sees
         * is the same redraw a terminal would produce. Needs a published active shell,
         * which the session container maintains; with none, it is a no-op rather than
         * an error.
         */
        clearTerminal: () => {
          const shell = panelModule && typeof panelModule.activeShell === 'function' ? panelModule.activeShell() : null
          if (!shell || !sessionRuntime) return
          sessionRuntime.actions.shellWrite(shell.localId, '\x0c')
        },
        fontUp: () => font && font.step(1),
        fontDown: () => font && font.step(-1),
        fontReset: () => font && font.reset(),
      }

      const result = chrome.install(ctx, targets, { report })
      if (result && Array.isArray(result.errors)) {
        for (const entry of result.errors) {
          app.actions.addRegistrationError({ what: `chrome ${entry.what}`, message: entry.message })
        }
      }
      return undefined
    })

    const slots = ctx.get('slots')
    if (!slots || typeof slots.register !== 'function' || typeof slots.inject !== 'function') {
      report('slots', new Error('slot registry is absent; the SSH panel cannot be placed'))
      return
    }

    // 1. Panel body + type. The *opening affordance* is deliberately absent in M0:
    //    `sidebar.panellist` addresses a MAIN panel (clicking it would clear the
    //    main column), and `conversation.session.header.corner` is a single slot
    //    already owned by the shipped sidebar expand button — registering there
    //    would replace it. M2 adds the verified additive seats instead:
    //    `sidebar.footer.action` (primary) and `conversation.input.left`.
    //    Until then the floating diagnostics card below is the visible surface.

    // 2. Tab type: what makes the right sidebar able to host this tab at all.
    //
    // `sidebarRightTabs` is provided by ANOTHER client plugin, which can load AFTER
    // this one — so a one-shot lookup loses that race. Measured on a clean start:
    // `tab type failed: sidebarRightTabs service is absent`, and then clicking the
    // footer entry threw `sidebarRight: no tab type is registered as "ssh"`. (The tab
    // *body* survived because `slots.inject` defers; only this lookup was eager.)
    // Retry until the service appears, then register exactly once.
    attempt('tab type', () => {
      const TIMEOUT_MS = 15000
      const STEP_MS = 250
      const registerType = () => {
        const tabs = ctx.get('sidebarRightTabs')
        if (!tabs || typeof tabs.register !== 'function') return false
        tabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          priority: 'feature',
          title: () => t('tab.title'),
        })
        return true
      }

      // Synchronous first attempt: when the right sidebar is already mounted — the
      // normal case — the tab type must exist by the time `apply()` returns, and every
      // other registration (and every test) is allowed to rely on that. Only a
      // genuinely missing seat justifies waiting.
      try {
        if (registerType()) return
      } catch (error) {
        report('tab type', error)
        return
      }

      let tries = 0
      const timer = setInterval(() => {
        tries += 1
        try {
          if (registerType()) {
            clearInterval(timer)
            return
          }
        } catch (error) {
          clearInterval(timer)
          report('tab type', error)
          return
        }
        if (tries * STEP_MS >= TIMEOUT_MS) {
          clearInterval(timer)
          report('tab type', new Error('sidebarRightTabs never appeared (right sidebar plugin missing)'))
        }
      }, STEP_MS)
    })

    // 3. Tab body: the panel content, keyed by the tab id the type dispatches.
    attempt('tab body', () =>
      slots.inject('sidebar.right.pane.tab', () =>
        slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, panel.SshWorkspace)))

    // 4. Tab title override (optional): shows the live transport state in the chip.
    attempt('tab title', () =>
      slots.inject('sidebar.right.pane.tab.title', () =>
        slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, () =>
          h('span', { className: 'dsh-ssh-row', style: { gap: 6 } },
            h('span', { className: 'dsh-ssh-dot', 'data-state': 'connecting' }),
            h('span', null, t('tab.title'))))))

    // 5. Open affordance. A registered tab body is NOT an open tab, and without a
    //    seat here nothing in the UI leads to the panel at all. Measured against the
    //    live Slot tree after the first successful load: `sidebar.footer.action` held
    //    only the shipped `cordis-panel` entry, while our `ssh` tab body was
    //    registered and active — i.e. the feature was unreachable by mouse. A fresh
    //    id adds a seat *beside* the shipped entries rather than replacing one.
    attempt('footer action', () =>
      slots.inject('sidebar.footer.action', () =>
        slots.register(
          { name: 'sidebar.footer.action', id: 'ssh-panel', order: 20, label: () => t('panel.title') },
          function SshFooterAction(props) {
            const wide = !props || props.wide !== false
            return h('button', {
              type: 'button',
              className: 'dsh-ssh-footer-action',
              title: t('panel.title'),
              'aria-label': t('panel.title'),
              'data-testid': 'ssh-footer-action',
              onClick: () => {
                const sidebar = ctx.get('sidebarRight')
                if (sidebar && typeof sidebar.openTab === 'function') sidebar.openTab(TAB_ID, {})
              },
            },
              h('span', { className: 'dsh-ssh-dot', 'data-state': 'idle' }),
              wide ? h('span', null, t('panel.title')) : null)
          })))

    // First-run discoverability: open the panel once, then remember it. Registering
    // the body is not enough for the user to find it, and silently taking over the
    // sidebar on every load would be worse — so it happens once, and afterwards the
    // footer action above is the way back.
    attempt('first-run open', () => {
      const KEY = 'dsh-ssh.autoOpened'
      try {
        if (typeof globalThis.localStorage?.getItem === 'function') {
          if (globalThis.localStorage.getItem(KEY) === '1') return
          globalThis.localStorage.setItem(KEY, '1')
        }
      } catch {
        /* storage may be unavailable; opening once more is harmless */
      }
      const sidebar = ctx.get('sidebarRight')
      if (sidebar && typeof sidebar.openTab === 'function') sidebar.openTab(TAB_ID, {})
    })

    // 6. Temporary floating diagnostics, so the spike result is visible even if
    //    the right sidebar seats are unavailable. Removed in M2.
    attempt('spike overlay', () =>
      slots.inject('shell.overlay', () =>
        slots.register({ name: 'shell.overlay', id: 'ssh-spike', order: 999, label: t('spike.title') }, panel.SpikeOverlay)))

    // Kick off carrier discovery immediately: the result is the spike's evidence.
    const resolution = bridge
      .resolve()
      .then((resolvedId) => {
        app.actions.setBridge({ resolvedId, transport: bridge.transportState() })
        console.info(`[dsh-ssh] carrier resolved: ${resolvedId || 'none'}`, bridge.diagnostics())
        return resolvedId
      })
      .catch((error) => {
        report('carrier resolution', error)
        return null
      })

    // Report the outcome back through the carrier we just found, so the fact
    // outlives this tab (see SshPluginService.reportSpike). The payload is sent
    // as a JSON string: a source-mode Remote method receives no generated
    // parameter codec, and a single scalar survives a positional carrier while a
    // nested object may not — which is exactly what M0 measured.
    resolution
      .then((resolvedId) => {
        const diagnostics = bridge.diagnostics()
        const payload = JSON.stringify({
          carrier: resolvedId ?? null,
          ok: typeof resolvedId === 'string',
          transport: bridge.transportState(),
          attempts: diagnostics.attempts,
          serviceShapes: diagnostics.serviceShapes,
          userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
        })
        return bridge.call('reportSpike', payload, { timeoutMs: 15000 })
      })
      .catch((error) => {
        console.warn('[dsh-ssh] could not report the transport binding to the host', error)
      })

    runtime = state
    state.resolution = resolution
  }

  /** Exposed for the headless component tests. */
  function describeRegistrations() {
    // The dictionaries live in the chrome (compiled from `locale/*.json`); the plugin
    // body registers nothing of its own, so it reports theirs rather than a stale count.
    let locales = []
    try {
      const chrome = SSH.require('ssh.chrome')
      if (chrome && chrome.i18n && typeof chrome.i18n.locales === 'function') locales = chrome.i18n.locales()
    } catch {
      /* no chrome in this composition */
    }
    return { tabId: TAB_ID, tabKind: TAB_KIND, namespace: NS, buildMarker: BUILD_MARKER, dictionaryLocales: locales }
  }

  /**
   * The components this package registers, as one surface.
   *
   * Tests render them directly, and the M2 entry seats (footer action, composer
   * control) reuse the same glyph and panel rather than rebuilding them.
   */
  function components() {
    const panel = SSH.require('ssh.panel')
    return {
      SshPanelIcon: panel.SshPanelIcon,
      SshWorkspace: panel.SshWorkspace,
      SpikeOverlay: panel.SpikeOverlay,
      SpikePanel: panel.SpikePanel,
    }
  }

  return { apply, inject, describeRegistrations, currentRuntime, components }
})
// client rebuild trigger 223633
