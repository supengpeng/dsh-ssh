/**
 * @module ssh.store
 * @order 30
 *
 * The single client-side state container (ICD §8.2). Components read it through
 * `useApp()` and never mutate it directly: every write is an `actions.*` call,
 * which keeps the connection manager, the session workspace and the M0 spike on
 * one predictable update path (and makes them testable without a DOM event).
 *
 * **Layering.** The store owns state and orchestration, never transport. Endpoint
 * calls arrive through a *connector* that `ssh.plugin` attaches
 * (`attachConnector`); components call `actions.*` and never the bridge. That is
 * what lets the same actions run headless in a test, with a fake carrier, and in
 * the browser, with the real one.
 *
 * **Secret discipline.** A plaintext password never enters this store. The form
 * holds it in component-local state and hands it to `actions.setSecret()`, which
 * forwards it to the connector and keeps only the *masked* projection
 * (`{ masked, present, persisted }`) in state. Nothing here writes a credential to
 * `localStorage`: `persistPanel()` stores the panel geometry and the view name
 * only, and the persisted view is deliberately never `form`.
 */

SSH.define('ssh.store', function (SSH) {
  const core = () => SSH.require('ssh.core')

  /** localStorage keys are namespaced so a stale DSH build cannot collide. */
  const STORAGE_KEY = 'dsh-ssh.state'

  /** Views the workspace can be in (ICD §8.3 container). */
  const VIEWS = Object.freeze(['list', 'form', 'session', 'debug'])

  /** Views that are safe to restore on the next run (`form` would be an empty draft). */
  const PERSISTED_VIEWS = Object.freeze(['list', 'session', 'debug'])

  /** A session state, normalised for the chrome's tab dots (ICD §8.3 `TabStrip`). */
  function tabStateOf(state) {
    if (state === 'connected' || state === 'connecting' || state === 'error') return state
    if (state === 'authenticating' || state === 'closing') return 'connecting'
    return 'idle'
  }

  /** `user@host:port`, the one-line identity used by tabs and dialogs. */
  function labelOfProfile(profile) {
    if (!profile) return '—'
    const user = profile.user ? `${profile.user}@` : ''
    const port = profile.port ? `:${profile.port}` : ''
    return `${user}${profile.host || '—'}${port}`
  }

  /** Start a draft for the form: either a copy of a stored profile or a blank one. */
  function draftFrom(profile) {
    const base = {
      name: '',
      host: '',
      port: 22,
      user: '',
      auth: 'password',
      privateKeyPath: '',
      group: '',
      tags: '',
      connectTimeoutMs: 15000,
      keepaliveIntervalMs: 15000,
    }
    if (!profile) return base
    return {
      ...base,
      name: profile.name || '',
      host: profile.host || '',
      port: typeof profile.port === 'number' ? profile.port : 22,
      user: profile.user || '',
      auth: profile.auth || 'password',
      privateKeyPath: (profile.secrets && profile.secrets.privateKeyPath) || '',
      group: profile.group || '',
      tags: Array.isArray(profile.tags) ? profile.tags.join(', ') : '',
      connectTimeoutMs:
        typeof profile.connectTimeoutMs === 'number' ? profile.connectTimeoutMs : base.connectTimeoutMs,
      keepaliveIntervalMs:
        typeof profile.keepaliveIntervalMs === 'number' ? profile.keepaliveIntervalMs : base.keepaliveIntervalMs,
    }
  }

  /** The tab strip projection: one tab per session, in the order the host lists them. */
  function tabsFromSessions(sessions, activeSessionId) {
    return (sessions || []).map((session) => ({
      id: session.id,
      sessionId: session.id,
      title: session.label || `${session.user ? `${session.user}@` : ''}${session.host || '—'}`,
      state: tabStateOf(session.state),
      active: session.id === activeSessionId,
    }))
  }

  /** A structured "no connector yet" failure, so the UI can explain itself. */
  function notWired(action) {
    return {
      code: 'SSH_STATE_INVALID',
      message: `connection actions are not wired yet (${action}); ssh.plugin attaches the endpoint connector`,
      retryable: false,
    }
  }

  function readPersisted() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      return raw ? JSON.parse(raw) : {}
    } catch {
      return {}
    }
  }

  function writePersisted(snapshot) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
    } catch {
      /* storage may be unavailable (private mode); the panel still works */
    }
  }

  /**
   * @param {{connector?: object}} [options] `connector` is the endpoint client
   *        (`ssh.conn.api`); it can also be attached later with `attachConnector`.
   */
  function createAppStore(options = {}) {
    const persisted = readPersisted()
    /** Legacy M0 value: the spike workspace is now the session view. */
    const persistedView = persisted.view === 'workspace' ? 'session' : persisted.view
    const store = core().createStore({
      panel: {
        // The M0 debug view and the connection manager are the restorable surfaces; a
        // half-filled form is not (see `persistPanel`).
        view: PERSISTED_VIEWS.includes(persistedView) ? persistedView : 'list',
        width: typeof persisted.width === 'number' ? persisted.width : 420,
        collapsed: persisted.collapsed === true,
        /** Which profile the form edits (`null` = creating). */
        editingId: null,
        /** Non-secret draft fields only; the password lives in the form component. */
        form: draftFrom(null),
        /** Connection-list search text; never persisted. */
        query: '',
      },
      profiles: { items: [], loading: false, error: null, loadedAt: null },
      sessions: { items: [], loading: false, error: null },
      activeSessionId: null,
      tabs: [],
      /** Transient, user-visible outcomes: a test result, a notice, a secret remark. */
      ui: { busy: false, testResult: null, notice: null, secretNotice: null },
      // Transport + spike state, all owned by the bridge.
      bridge: { resolvedId: null, transport: { kind: 'unknown', status: 'connecting', generation: 0 } },
      spike: {
        running: false,
        ping: null,
        pingError: null,
        frames: [],
        streamNote: null,
        diagnostics: null,
        registrationErrors: [],
        // The floating M0 diagnostics card is opt-in and **not restorable**: it is
        // `position: fixed` with a very high z-index, so a stale persisted `true` from
        // the M0 era would reappear on top of the session view and cover the terminal.
        showOverlay: false,
      },
    })

    let connector = options.connector ?? null

    const persistPanel = () => {
      const { panel } = store.getState()
      writePersisted({
        // A draft is not restorable, so it persists as the list.
        view: PERSISTED_VIEWS.includes(panel.view) ? panel.view : 'list',
        width: panel.width,
        collapsed: panel.collapsed,
      })
    }

    const setProfiles = (patch) => store.setState((state) => ({ profiles: { ...state.profiles, ...patch } }))
    const setSessionsState = (patch) => store.setState((state) => ({ sessions: { ...state.sessions, ...patch } }))
    const setUi = (patch) => store.setState((state) => ({ ui: { ...state.ui, ...patch } }))

    /** Apply a session-list change and refresh the tab projection with it. */
    const putSessions = (items, activeSessionId) =>
      store.setState((state) => {
        const active = activeSessionId === undefined ? state.activeSessionId : activeSessionId
        const stillPresent = items.some((session) => session.id === active)
        const nextActive = stillPresent ? active : items.length > 0 ? items[items.length - 1].id : null
        return { sessions: { ...state.sessions, items, error: null }, activeSessionId: nextActive, tabs: tabsFromSessions(items, nextActive) }
      })

    /** Any thrown value becomes a structured, displayable error (never a secret). */
    const asError = (error) => ({
      code: (error && error.code) || 'SSH_UNKNOWN',
      message: (error && error.message) || String(error),
      retryable: Boolean(error && error.retryable),
    })

    /** Every endpoint method `ssh.conn.api` exposes. */
    const CONNECTOR_METHODS = Object.freeze([
      'listProfiles',
      'saveProfile',
      'deleteProfile',
      'duplicateProfile',
      'testProfile',
      'setSecret',
      'clearSecret',
      'connect',
      'disconnect',
      'listSessions',
    ])

    /**
     * The endpoint client, or a stand-in whose every method rejects with the
     * structured "not wired" failure.
     *
     * It must not *throw* here: an action is called from a component (often in an
     * effect, with no catch), so a synchronous throw would surface as an unhandled
     * rejection instead of the notice the user is supposed to read. The stand-in
     * keeps each action's own `try/catch` in charge, which is what turns a missing
     * connector into a visible, structured error on every path.
     */
    const requireConnector = (action) => {
      if (connector) return connector
      const failure = notWired(action)
      setUi({ notice: { tone: 'error', error: failure } })
      const missing = {}
      for (const method of CONNECTOR_METHODS) {
        missing[method] = () => {
          throw failure
        }
      }
      return missing
    }

    const actions = {
      // ── panel geometry / view (unchanged names: the chrome and the session
      //    workspace both read them) ───────────────────────────────────────────
      setPanel(patch) {
        store.setState((state) => ({ panel: { ...state.panel, ...patch } }))
        persistPanel()
      },
      setBridge(patch) {
        store.setState((state) => ({ bridge: { ...state.bridge, ...patch } }))
      },
      setSpike(patch) {
        store.setState((state) => ({ spike: { ...state.spike, ...patch } }))
        persistPanel()
      },
      appendFrame(frame) {
        store.setState((state) => ({ spike: { ...state.spike, frames: [...state.spike.frames, frame].slice(-400) } }))
      },
      clearFrames() {
        store.setState((state) => ({ spike: { ...state.spike, frames: [], streamNote: null } }))
      },
      addRegistrationError(entry) {
        store.setState((state) => ({ spike: { ...state.spike, registrationErrors: [...state.spike.registrationErrors, entry] } }))
      },

      // ── connection list ─────────────────────────────────────────────────────
      setQuery(query) {
        store.setState((state) => ({ panel: { ...state.panel, query: String(query ?? '') } }))
      },
      async loadProfiles() {
        const client = requireConnector('listProfiles')
        setProfiles({ loading: true, error: null })
        try {
          const profiles = await client.listProfiles()
          setProfiles({ items: profiles, loading: false, error: null, loadedAt: new Date().toISOString() })
          return profiles
        } catch (error) {
          const failure = asError(error)
          setProfiles({ loading: false, error: failure })
          return null
        }
      },
      openForm(profileId) {
        const state = store.getState()
        const profile = profileId ? state.profiles.items.find((item) => item.id === profileId) : null
        store.setState((current) => ({
          panel: {
            ...current.panel,
            view: 'form',
            editingId: profile ? profile.id : null,
            form: draftFrom(profile),
          },
          ui: { ...current.ui, testResult: null, notice: null, secretNotice: null },
        }))
        persistPanel()
      },
      setForm(patch) {
        // Guard rail rather than a policy: a secret field must never arrive here.
        const safe = { ...(patch || {}) }
        delete safe.password
        delete safe.passphrase
        delete safe.secrets
        store.setState((state) => ({ panel: { ...state.panel, form: { ...state.panel.form, ...safe } } }))
      },
      async saveProfile(input) {
        const client = requireConnector('saveProfile')
        setUi({ busy: true, notice: null })
        try {
          const saved = await client.saveProfile(input)
          store.setState((state) => {
            const items = state.profiles.items.some((item) => item.id === saved.id)
              ? state.profiles.items.map((item) => (item.id === saved.id ? saved : item))
              : [...state.profiles.items, saved]
            return {
              profiles: { ...state.profiles, items, error: null, loadedAt: new Date().toISOString() },
              panel: { ...state.panel, view: 'list', editingId: null, form: draftFrom(null) },
              ui: { ...state.ui, busy: false, notice: { tone: 'ok', messageKey: 'toast.saved' } },
            }
          })
          persistPanel()
          return saved
        } catch (error) {
          const failure = asError(error)
          setUi({ busy: false, notice: { tone: 'error', error: failure } })
          return null
        }
      },
      async deleteProfile(profileId) {
        const client = requireConnector('deleteProfile')
        setUi({ busy: true, notice: null })
        try {
          await client.deleteProfile(profileId)
          store.setState((state) => ({
            profiles: { ...state.profiles, items: state.profiles.items.filter((item) => item.id !== profileId) },
            panel: state.panel.editingId === profileId ? { ...state.panel, view: 'list', editingId: null } : state.panel,
            ui: { ...state.ui, busy: false },
          }))
          persistPanel()
          return true
        } catch (error) {
          const failure = asError(error)
          setUi({ busy: false, notice: { tone: 'error', error: failure } })
          return false
        }
      },
      async duplicateProfile(profileId, name) {
        const client = requireConnector('duplicateProfile')
        setUi({ busy: true, notice: null })
        try {
          const copy = await client.duplicateProfile(profileId, name)
          store.setState((state) => ({
            profiles: { ...state.profiles, items: [...state.profiles.items, copy] },
            ui: { ...state.ui, busy: false },
          }))
          return copy
        } catch (error) {
          const failure = asError(error)
          setUi({ busy: false, notice: { tone: 'error', error: failure } })
          return null
        }
      },
      async testProfile(target) {
        const client = requireConnector('testProfile')
        setUi({ busy: true, testResult: { pending: true } })
        try {
          const result = await client.testProfile(target)
          setUi({ busy: false, testResult: result })
          return result
        } catch (error) {
          const failure = asError(error)
          setUi({ busy: false, testResult: { ok: false, error: failure } })
          return null
        }
      },
      /**
       * Store a credential. The plaintext is forwarded and dropped: only the
       * masked projection survives in state (ICD §4.2 invariant).
       */
      async setSecret(request) {
        const client = requireConnector('setSecret')
        try {
          const result = await client.setSecret(request)
          // `persisted: false` is the documented read-only/one-shot degradation,
          // not a failure: the UI reports it as such.
          setUi({
            secretNotice: {
              field: request.field,
              masked: result && result.masked ? result.masked : '',
              persisted: result && result.persisted === false ? false : true,
              reason: (result && result.reason) || null,
            },
          })
          return result
        } catch (error) {
          const failure = asError(error)
          setUi({ secretNotice: { field: request.field, error: failure, persisted: null } })
          return null
        }
      },
      async clearSecret(request) {
        const client = requireConnector('clearSecret')
        try {
          await client.clearSecret(request)
          setUi({ secretNotice: { field: request.field, cleared: true, masked: '', persisted: null } })
          return true
        } catch (error) {
          setUi({ secretNotice: { field: request.field, error: asError(error) } })
          return false
        }
      },

      // ── sessions / tabs ────────────────────────────────────────────────────
      /**
       * @param {{profileId?: string, inline?: object, secrets?: object, name?: string}} request
       * @returns the `SessionInfo`, or null when the connection failed.
       */
      async connect(request) {
        const client = requireConnector('connect')
        setUi({ busy: true, notice: null })
        try {
          const session = await client.connect(request)
          store.setState((state) => {
            const items = state.sessions.items.some((item) => item.id === session.id)
              ? state.sessions.items.map((item) => (item.id === session.id ? session : item))
              : [...state.sessions.items, session]
            return {
              sessions: { ...state.sessions, items, error: null },
              activeSessionId: session.id,
              tabs: tabsFromSessions(items, session.id),
              panel: { ...state.panel, view: 'session' },
              ui: { ...state.ui, busy: false },
            }
          })
          persistPanel()
          return session
        } catch (error) {
          const failure = asError(error)
          setUi({ busy: false, notice: { tone: 'error', error: failure } })
          return null
        }
      },
      async disconnect(sessionId, force) {
        const client = requireConnector('disconnect')
        setUi({ busy: true, notice: null })
        try {
          const session = await client.disconnect(sessionId, force)
          store.setState((state) => {
            const items = state.sessions.items.map((item) => (item.id === session.id ? session : item))
            return {
              sessions: { ...state.sessions, items },
              tabs: tabsFromSessions(items, state.activeSessionId),
              ui: { ...state.ui, busy: false },
            }
          })
          return session
        } catch (error) {
          const failure = asError(error)
          setUi({ busy: false, notice: { tone: 'error', error: failure } })
          return null
        }
      },
      async loadSessions() {
        const client = requireConnector('listSessions')
        setSessionsState({ loading: true, error: null })
        try {
          const sessions = await client.listSessions()
          putSessions(sessions)
          return sessions
        } catch (error) {
          const failure = asError(error)
          setSessionsState({ loading: false, error: failure })
          return null
        }
      },
      /**
       * Adopt the tab order the user dragged into place.
       *
       * Tab order is a view preference, so it is applied to the local session list
       * only: the host owns session identity and lifetime, and a later `listSessions`
       * legitimately restores the host's order. Unknown ids are ignored rather than
       * dropping a session from the strip.
       */
      reorderTabs(ids) {
        const order = Array.isArray(ids) ? ids : []
        store.setState((state) => {
          const byId = new Map(state.sessions.items.map((item) => [item.id, item]))
          const reordered = order.map((id) => byId.get(id)).filter(Boolean)
          for (const item of state.sessions.items) {
            if (!order.includes(item.id)) reordered.push(item)
          }
          return { sessions: { ...state.sessions, items: reordered }, tabs: tabsFromSessions(reordered, state.activeSessionId) }
        })
      },
      /** Make one session the visible tab (by id). */
      activateTab(input) {
        // The click path may hand us a tab record rather than its id (a caller that passes the
        // whole object, or the current active id). Comparing an object against string ids can
        // never match — which is exactly how a click became a silent no-op in the real app
        // while a string-based test stayed green.
        const requested = typeof input === 'object' && input !== null ? input.sessionId ?? input.id : input
        const sessionId = typeof requested === 'string' ? requested : null
        const from = store.getState().activeSessionId
        let outcome = 'switched'
        store.setState((state) => {
          const exists = sessionId !== null && state.sessions.items.some((item) => item.id === sessionId)
          if (!exists) {
            // A tab whose session is missing from the list is a mapping bug, and returning
            // silently made the click look ignored — the reported "cannot switch back".
            // Report it, and still honour the id so the strip responds.
            const known = sessionId !== null && state.tabs.some((tab) => tab.id === sessionId)
            outcome = known ? 'tab-without-session' : 'unknown-id'
            if (!known) return {}
          }
          return {
            activeSessionId: sessionId,
            tabs: tabsFromSessions(state.sessions.items, sessionId),
            panel: { ...state.panel, view: 'session' },
          }
        })
        const to = store.getState().activeSessionId
        console.info('[dsh-ssh] session tab switch', {
          from,
          to,
          requested,
          inputType: typeof input,
          toType: typeof requested,
          outcome,
          changed: from !== to,
        })
        if (outcome !== 'switched') {
          console.warn('[dsh-ssh] session tab has no session entry', {
            to: sessionId,
            inputType: typeof input,
            outcome,
            sessions: store.getState().sessions.items.map((item) => item.id),
            tabs: store.getState().tabs.map((tab) => tab.id),
          })
        }
        persistPanel()
      },
      selectTab(sessionId) {
        actions.activateTab(sessionId)
      },
      /**
       * Close a tab: disconnect that session and drop it from the strip. Closing a
       * live session is a dangerous operation, so the *caller* asks first
       * (`confirm.danger('closeSession')`); this action only executes.
       */
      async closeTab(sessionId, options = {}) {
        const client = requireConnector('disconnect')
        const state = store.getState()
        const session = state.sessions.items.find((item) => item.id === sessionId)
        const live = session && (session.state === 'connected' || session.state === 'connecting')
        if (live) {
          try {
            await client.disconnect(sessionId, options.force === true)
          } catch (error) {
            setUi({ notice: { tone: 'error', error: asError(error) } })
            return false
          }
        }
        store.setState((current) => {
          const items = current.sessions.items.filter((item) => item.id !== sessionId)
          const active = current.activeSessionId === sessionId
            ? items.length > 0
              ? items[items.length - 1].id
              : null
            : current.activeSessionId
          return {
            sessions: { ...current.sessions, items },
            activeSessionId: active,
            tabs: tabsFromSessions(items, active),
            panel: { ...current.panel, view: items.length === 0 ? 'list' : current.panel.view },
          }
        })
        persistPanel()
        return true
      },
      /** Move the active tab by `delta` (+1 next, -1 previous), wrapping around. */
      cycleTab(delta) {
        store.setState((state) => {
          const items = state.sessions.items
          if (items.length === 0) return {}
          const current = items.findIndex((item) => item.id === state.activeSessionId)
          const step = delta < 0 ? -1 : 1
          const base = current < 0 ? (step > 0 ? -1 : 0) : current
          const next = (base + step + items.length) % items.length
          const id = items[next].id
          return {
            activeSessionId: id,
            tabs: tabsFromSessions(items, id),
            panel: { ...state.panel, view: 'session' },
          }
        })
        persistPanel()
      },
      /** Jump to a 1-based tab index (the `jumpTab` shortcut's parameter). */
      jumpTab(index) {
        const parsed = Number(index)
        if (!Number.isFinite(parsed)) return
        store.setState((state) => {
          const position = Math.trunc(parsed) - 1
          if (position < 0 || position >= state.sessions.items.length) return {}
          const id = state.sessions.items[position].id
          return {
            activeSessionId: id,
            tabs: tabsFromSessions(state.sessions.items, id),
            panel: { ...state.panel, view: 'session' },
          }
        })
        persistPanel()
      },
      /** The `escape` / `dismissOverlays` shortcut: close transient surfaces first. */
      dismissOverlays() {
        const state = store.getState()
        if (state.spike.showOverlay === true) {
          actions.setSpike({ showOverlay: false })
          return 'overlay'
        }
        if (state.panel.view === 'form' || state.panel.view === 'debug') {
          actions.setPanel({ view: 'list' })
          return 'view'
        }
        if (state.ui.notice || state.ui.testResult || state.ui.secretNotice) {
          setUi({ notice: null, testResult: null, secretNotice: null })
          return 'notice'
        }
        return null
      },
      /** Attach the endpoint client (called once by `ssh.plugin`). */
      attachConnector(next) {
        connector = next
        return connector
      },
    }

    return {
      store,
      actions,
      useApp: () => store.useStore((state) => state),
      /** Exposed for tests and for the plugin's wiring report. */
      hasConnector: () => Boolean(connector),
    }
  }

  return {
    createAppStore,
    STORAGE_KEY,
    VIEWS,
    PERSISTED_VIEWS,
    // Pure helpers, exported because they encode policy worth testing on their own.
    tabStateOf,
    labelOfProfile,
    draftFrom,
    tabsFromSessions,
  }
})
