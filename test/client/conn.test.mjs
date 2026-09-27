/**
 * Connection manager tests (T12): the store extension, the endpoint client's wire
 * contract, the list/form components, the panel's view switch, and the shortcut
 * target table.
 *
 * The DOM must exist before `react-dom` is evaluated, and `document.oninput` must be
 * advertised, or React installs a legacy `input` polyfill that crashes on keydown
 * under linkedom (see `session.test.mjs` for the full explanation).
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { installDom } from './harness.mjs'
import { loadBundle, fakeContext, fakeLocale, fakeRemoteCarrier, fakeSlots, fakeTabRegistry } from './harness.mjs'

const restoreDom = installDom()
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.window.IS_REACT_ACT_ENVIRONMENT = true
globalThis.document.documentElement.setAttribute('lang', 'en')
Object.defineProperty(globalThis.document, 'oninput', { value: null, configurable: true, writable: true })

const React = await import('react')
const { act } = React
const { createRoot } = await import('react-dom/client')

process.on('exit', () => {
  try {
    restoreDom()
  } catch {
    /* nothing left to restore */
  }
})

const SRC_DIR = fileURLToPath(new URL('../../client/src', import.meta.url))
const LOCALE_DIR = fileURLToPath(new URL('../../locale', import.meta.url))

/**
 * The shipped dictionaries, with `{name}` interpolation.
 *
 * Wiring these in means an assertion checks the *real* sentence (and that the key
 * exists at all), instead of matching a key that survived untranslated.
 */
function realTranslator(locale = 'en') {
  const dictionary = JSON.parse(readFileSync(join(LOCALE_DIR, `${locale}.json`), 'utf8'))
  return (key, params) => {
    const text = dictionary[key]
    if (typeof text !== 'string') return key
    if (!params) return text
    return text.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])))
  }
}

/** The chrome module the connection surfaces find, backed by the real strings. */
function chromeStub(options = {}) {
  const t = options.t ?? realTranslator()
  const dangerCalls = []
  return {
    dangerCalls,
    i18n: { t },
    describeShortcuts: () => [],
    ShortcutHelp: null,
    TabStrip: null,
    StatusBar: null,
    danger: async (kind, details) => {
      dangerCalls.push({ kind, details })
      return options.approveDelete === true
    },
    install: () => ({ errors: [] }),
  }
}

/** Load every client source into the assembler's own registry. */
function loadSources(options = {}) {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.js')) files.push(full)
    }
  }
  walk(SRC_DIR)
  const orderOf = (file) => Number(/@order[ \t]+(\d+)/.exec(readFileSync(file, 'utf8'))?.[1] ?? 500)
  files.sort((a, b) => orderOf(a) - orderOf(b) || (a < b ? -1 : a > b ? 1 : 0))

  const factories = Object.create(null)
  const cache = Object.create(null)
  const styles = []
  const SSH = {
    id: '@local/dsh-ssh',
    react: React,
    h: React.createElement,
    Fragment: React.Fragment,
    define(name, factory) {
      factories[name] = factory
    },
    has: (name) => Object.prototype.hasOwnProperty.call(factories, name),
    names: () => Object.keys(factories),
    require(name) {
      if (Object.prototype.hasOwnProperty.call(cache, name)) return cache[name]
      if (!Object.prototype.hasOwnProperty.call(factories, name)) throw new Error(`unknown module "${name}"`)
      cache[name] = {}
      const produced = factories[name](SSH)
      if (produced !== undefined) cache[name] = produced
      return cache[name]
    },
    style: { insert: (css) => { styles.push(css); return () => {} }, disposeAll: () => { styles.length = 0 } },
  }
  for (const file of files) new Function('SSH', readFileSync(file, 'utf8'))(SSH)
  for (const [name, factory] of Object.entries(options.extras ?? {})) SSH.define(name, factory)
  return { SSH, styles, files }
}

/** Boot a fresh module tree (a fresh store per test). */
function boot(options = {}) {
  // Cross-test isolation: a persisted view from the previous test would otherwise
  // decide this one's starting view. The tests that *seed* storage ask to keep it.
  if (options.storage !== 'preserve') globalThis.window.localStorage.clear()
  const chrome = options.chrome === null ? null : options.chrome ?? chromeStub()
  const { SSH } = loadSources({
    extras: {
      // Present in a real bundle; the connection surfaces read its dictionaries.
      ...(chrome === null ? {} : { 'ssh.chrome': () => chrome }),
      ...(options.extras ?? {}),
    },
  })
  const storeModule = SSH.require('ssh.store')
  const app = storeModule.createAppStore()
  const ui = SSH.require('ssh.conn.ui')
  const api = SSH.require('ssh.conn.api')
  ui.configure({ app, api, chrome })
  return { SSH, app, store: app.store, actions: app.actions, ui, api, storeModule, chrome }
}

/** A fake endpoint client that records calls (the shape `ssh.conn.api` exposes). */
function fakeConnector(options = {}) {
  const calls = []
  const profiles = options.profiles ?? []
  const sessions = options.sessions ?? []
  let counter = 0
  const record = (method, params) => {
    calls.push({ method, params })
  }
  return {
    calls,
    callsFor: (method) => calls.filter((call) => call.method === method),
    async listProfiles() {
      record('listProfiles', {})
      if (options.failList) throw { code: 'SSH_UNKNOWN', message: 'list failed', retryable: false }
      return profiles.map((profile) => ({ ...profile }))
    },
    async saveProfile(input) {
      record('saveProfile', input)
      counter += 1
      const saved = { id: input.id ?? `p_new_${counter}`, createdAt: 'now', updatedAt: 'now', ...input }
      return { ...saved, secrets: { password: { present: false, source: 'none', masked: '' }, passphrase: { present: false, source: 'none', masked: '' } } }
    },
    async deleteProfile(profileId) {
      record('deleteProfile', { profileId })
      return true
    },
    async duplicateProfile(profileId, name) {
      record('duplicateProfile', { profileId, name })
      counter += 1
      const source = profiles.find((profile) => profile.id === profileId) || { host: 'h', user: 'u', port: 22, auth: 'password', name: 'x' }
      return { ...source, id: `p_dup_${counter}`, name: name || `${source.name} copy` }
    },
    async testProfile(target) {
      record('testProfile', target)
      if (options.failTest) throw { code: 'SSH_AUTH_FAILED', message: 'nope', retryable: false }
      return { ok: true, latencyMs: 42 }
    },
    async setSecret(request) {
      record('setSecret', request)
      return { ref: `ref_${request.field}`, masked: '••••••••', persisted: options.persistSecrets !== false }
    },
    async clearSecret(request) {
      record('clearSecret', request)
      return true
    },
    async connect(request) {
      record('connect', request)
      if (options.failConnect) throw { code: 'SSH_NET_REFUSED', message: 'refused', retryable: true }
      if (sessions.length > 0) return sessions.shift()
      return { id: 's_1', profileId: request.profileId, label: 'prod', host: 'h', port: 22, user: 'u', state: 'connected', since: new Date().toISOString(), metrics: { rttMs: 12, bytesIn: 1, bytesOut: 2 }, capabilities: { shell: true, sftp: true } }
    },
    async disconnect(sessionId) {
      record('disconnect', { sessionId })
      return { id: sessionId, state: 'closed', label: 'prod', host: 'h', port: 22, user: 'u', since: 'now', metrics: { bytesIn: 0, bytesOut: 0 }, capabilities: { shell: false, sftp: false } }
    },
    async listSessions() {
      record('listSessions', {})
      return []
    },
  }
}

const PROFILE_A = {
  id: 'p_1',
  name: 'prod-web',
  host: 'web.example',
  port: 22,
  user: 'deploy',
  auth: 'password',
  group: 'production',
  tags: ['web'],
  secrets: { password: { present: true, source: 'profile', masked: '••••••••' }, passphrase: { present: false, source: 'none', masked: '' } },
}
const PROFILE_B = {
  id: 'p_2',
  name: 'staging',
  host: 'stg.example',
  port: 2222,
  user: 'root',
  auth: 'privateKey',
  group: '',
  tags: [],
  secrets: { password: { present: false, source: 'env', masked: '' }, passphrase: { present: true, source: 'profile', masked: '••••••••' } },
}

async function mount(element) {
  const container = globalThis.document.createElement('div')
  globalThis.document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(element)
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5))
  })
  return {
    container,
    html: () => container.innerHTML,
    text: () => container.textContent ?? '',
    find: (selector) => container.querySelector(selector),
    findAll: (selector) => [...container.querySelectorAll(selector)],
    async flush(times = 3) {
      for (let index = 0; index < times; index++) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5))
        })
      }
    },
    async unmount() {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    },
  }
}

function click(element) {
  assert.ok(element, 'click target must exist')
  act(() => {
    element.dispatchEvent(new globalThis.window.Event('click', { bubbles: true }))
  })
}

function typeInto(element, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis.window.HTMLInputElement.prototype, 'value')
  act(() => {
    if (descriptor && descriptor.set) descriptor.set.call(element, value)
    else element.value = value
    element.dispatchEvent(new globalThis.window.Event('input', { bubbles: true }))
  })
}

// ── store: state transitions ───────────────────────────────────────────────

test('loadProfiles fills the list through the connector and clears the loading flag', async () => {
  const { actions, store } = boot()
  const connector = fakeConnector({ profiles: [PROFILE_A, PROFILE_B] })
  actions.attachConnector(connector)
  const loaded = await actions.loadProfiles()
  assert.equal(loaded.length, 2)
  assert.equal(connector.callsFor('listProfiles').length, 1)
  const state = store.getState()
  assert.equal(state.profiles.items.length, 2)
  assert.equal(state.profiles.loading, false)
  assert.equal(state.profiles.error, null)
  assert.ok(state.profiles.loadedAt)
})

test('a failing loadProfiles records a structured error instead of throwing', async () => {
  const { actions, store } = boot()
  actions.attachConnector(fakeConnector({ failList: true }))
  const loaded = await actions.loadProfiles()
  assert.equal(loaded, null)
  assert.equal(store.getState().profiles.error.code, 'SSH_UNKNOWN')
  assert.equal(store.getState().profiles.loading, false)
})

test('saveProfile inserts a new profile, then updates it in place', async () => {
  const { actions, store } = boot()
  actions.attachConnector(fakeConnector({ profiles: [] }))
  const created = await actions.saveProfile({ name: 'a', host: 'h1', port: 22, user: 'u', auth: 'password' })
  assert.ok(created.id)
  assert.equal(store.getState().profiles.items.length, 1)
  const updated = await actions.saveProfile({ id: created.id, name: 'a2', host: 'h2', port: 22, user: 'u', auth: 'password' })
  assert.equal(store.getState().profiles.items.length, 1, 'an edit must not duplicate')
  assert.equal(store.getState().profiles.items[0].host, 'h2')
  // Saving returns the user to the list.
  assert.equal(store.getState().panel.view, 'list')
  assert.equal(store.getState().ui.notice.tone, 'ok')
  assert.equal(updated.id, created.id)
})

test('deleteProfile removes the profile and leaves the form when it was editing it', async () => {
  const { actions, store } = boot()
  actions.attachConnector(fakeConnector({ profiles: [PROFILE_A] }))
  await actions.loadProfiles()
  actions.openForm(PROFILE_A.id)
  assert.equal(store.getState().panel.editingId, PROFILE_A.id)
  const ok = await actions.deleteProfile(PROFILE_A.id)
  assert.equal(ok, true)
  assert.deepEqual(store.getState().profiles.items, [])
  assert.equal(store.getState().panel.view, 'list')
})

test('duplicateProfile appends the copy the host returns', async () => {
  const { actions, store } = boot()
  actions.attachConnector(fakeConnector({ profiles: [PROFILE_A] }))
  await actions.loadProfiles()
  const copy = await actions.duplicateProfile(PROFILE_A.id, 'prod-web-2')
  assert.equal(copy.name, 'prod-web-2')
  assert.equal(store.getState().profiles.items.length, 2)
})

test('with no connector every action fails closed instead of pretending', async () => {
  const { app, actions, store } = boot()
  assert.equal(app.hasConnector(), false)
  const loaded = await actions.loadProfiles()
  assert.equal(loaded, null)
  const notice = store.getState().ui.notice
  assert.equal(notice.tone, 'error')
  assert.equal(notice.error.code, 'SSH_STATE_INVALID')
  assert.match(notice.error.message, /not wired/)
  app.actions.attachConnector(fakeConnector())
  assert.equal(app.hasConnector(), true)
})

test('setForm refuses credential fields (they never belong in store state)', () => {
  const { actions, store } = boot()
  actions.setForm({ host: 'h', password: 'hunter2', passphrase: 'x', secrets: { password: 'y' } })
  const draft = store.getState().panel.form
  assert.equal(draft.host, 'h')
  assert.equal('password' in draft, false)
  assert.equal('passphrase' in draft, false)
  assert.equal('secrets' in draft, false)
  assert.equal(JSON.stringify(store.getState()).includes('hunter2'), false)
})

test('openForm builds a draft from the stored profile without any secret', async () => {
  const { actions, store } = boot()
  actions.attachConnector(fakeConnector({ profiles: [PROFILE_A] }))
  await actions.loadProfiles()
  actions.openForm(PROFILE_A.id)
  const { panel } = store.getState()
  assert.equal(panel.view, 'form')
  assert.equal(panel.editingId, 'p_1')
  assert.deepEqual(
    { name: panel.form.name, host: panel.form.host, port: panel.form.port, user: panel.form.user, group: panel.form.group },
    { name: 'prod-web', host: 'web.example', port: 22, user: 'deploy', group: 'production' },
  )
  assert.equal('password' in panel.form, false)
  assert.equal('passphrase' in panel.form, false)
  assert.equal(panel.form.auth, 'password', 'the auth *mode* is not a credential')
})

test('connect activates the new session and projects the tab strip', async () => {
  const { actions, store } = boot()
  actions.attachConnector(fakeConnector())
  const session = await actions.connect({ profileId: 'p_1' })
  assert.equal(session.id, 's_1')
  const state = store.getState()
  assert.equal(state.activeSessionId, 's_1')
  assert.equal(state.panel.view, 'session')
  assert.equal(state.tabs.length, 1)
  assert.deepEqual(state.tabs[0], { id: 's_1', sessionId: 's_1', title: 'prod', state: 'connected', active: true })
})

test('a failed connect reports the endpoint error and stays on the form', async () => {
  const { actions, store } = boot()
  actions.attachConnector(fakeConnector({ failConnect: true }))
  const session = await actions.connect({ profileId: 'p_1' })
  assert.equal(session, null)
  assert.equal(store.getState().ui.notice.error.code, 'SSH_NET_REFUSED')
  assert.equal(store.getState().activeSessionId, null)
})

test('tabs: activate, cycle, jump and reorder all follow the session list', async () => {
  const { actions, store } = boot()
  const connector = fakeConnector({
    sessions: [
      { id: 's_1', profileId: 'p_1', label: 'a', host: 'h', port: 22, user: 'u', state: 'connected', since: 'now', metrics: { bytesIn: 0, bytesOut: 0 }, capabilities: {} },
      { id: 's_2', profileId: 'p_2', label: 'b', host: 'h', port: 22, user: 'u', state: 'connected', since: 'now', metrics: { bytesIn: 0, bytesOut: 0 }, capabilities: {} },
    ],
  })
  actions.attachConnector(connector)
  await actions.connect({ profileId: 'p_1' })
  await actions.connect({ profileId: 'p_2' })
  assert.equal(store.getState().activeSessionId, 's_2')

  actions.cycleTab(1)
  assert.equal(store.getState().activeSessionId, 's_1', 'cycle wraps forward')
  actions.cycleTab(-1)
  assert.equal(store.getState().activeSessionId, 's_2', 'cycle wraps back')

  actions.jumpTab(1)
  assert.equal(store.getState().activeSessionId, 's_1')
  actions.jumpTab(9)
  assert.equal(store.getState().activeSessionId, 's_1', 'an out-of-range jump is ignored')

  actions.activateTab('s_2')
  assert.equal(store.getState().tabs.find((tab) => tab.id === 's_2').active, true)

  actions.reorderTabs(['s_2', 's_1'])
  assert.deepEqual(store.getState().sessions.items.map((session) => session.id), ['s_2', 's_1'])
  assert.deepEqual(store.getState().tabs.map((tab) => tab.id), ['s_2', 's_1'])
})

test('closeTab disconnects a live session, then drops it and picks a neighbour', async () => {
  const { actions, store } = boot()
  const connector = fakeConnector({
    sessions: [
      { id: 's_1', profileId: 'p_1', label: 'a', host: 'h', port: 22, user: 'u', state: 'connected', since: 'now', metrics: { bytesIn: 0, bytesOut: 0 }, capabilities: {} },
      { id: 's_2', profileId: 'p_2', label: 'b', host: 'h', port: 22, user: 'u', state: 'connected', since: 'now', metrics: { bytesIn: 0, bytesOut: 0 }, capabilities: {} },
    ],
  })
  actions.attachConnector(connector)
  await actions.connect({ profileId: 'p_1' })
  await actions.connect({ profileId: 'p_2' })
  await actions.closeTab('s_2')
  assert.equal(connector.callsFor('disconnect').length, 1, 'a live session is disconnected first')
  assert.deepEqual(store.getState().sessions.items.map((session) => session.id), ['s_1'])
  assert.equal(store.getState().activeSessionId, 's_1')
  // An already-closed session is dropped without another round trip.
  actions.attachConnector({ ...connector, disconnect: async () => { throw new Error('must not be called') } })
  const profileOnly = fakeConnector()
  actions.attachConnector(profileOnly)
  store.setState((state) => ({
    sessions: { ...state.sessions, items: [{ id: 's_9', state: 'closed', label: 'x', host: 'h', port: 22, user: 'u', since: 'now', metrics: {} }] },
  }))
  await actions.closeTab('s_9')
  assert.equal(profileOnly.callsFor('disconnect').length, 0)
})

test('dismissOverlays closes the transient surface first, then the view', () => {
  const { actions, store } = boot()
  actions.setSpike({ showOverlay: true })
  assert.equal(actions.dismissOverlays(), 'overlay')
  assert.equal(store.getState().spike.showOverlay, false)

  actions.setPanel({ view: 'form' })
  assert.equal(actions.dismissOverlays(), 'view')
  assert.equal(store.getState().panel.view, 'list')

  assert.equal(actions.dismissOverlays(), null, 'nothing left to dismiss')
})

test('the persisted snapshot carries geometry and view only — never a draft or a secret', () => {
  const { actions } = boot()
  globalThis.window.localStorage.clear()
  actions.setPanel({ view: 'form' })
  actions.setForm({ name: 'draft-name', password: 'hunter2' })
  actions.setQuery('secret-search')
  const raw = globalThis.window.localStorage.getItem('dsh-ssh.state')
  const snapshot = JSON.parse(raw)
  assert.equal(snapshot.view, 'list', 'a draft is not restorable, so it persists as the list')
  assert.equal(raw.includes('draft-name'), false)
  assert.equal(raw.includes('hunter2'), false)
  assert.equal(raw.includes('secret-search'), false)

  actions.setPanel({ view: 'session' })
  actions.setSpike({ showOverlay: false })
  const next = JSON.parse(globalThis.window.localStorage.getItem('dsh-ssh.state'))
  assert.equal(next.view, 'session')
  assert.equal(typeof next.width, 'number')
  // The M0 diagnostics card is never restorable: it is a fixed, high-z-index layer, so a
  // stale `true` from the M0 era would cover the terminal on the next page load.
  assert.equal('showOverlay' in next, false, 'the floating card is not persisted at all')
})

test('a stale persisted overlay flag from the M0 era cannot cover the workspace', () => {
  globalThis.window.localStorage.setItem('dsh-ssh.state', JSON.stringify({ view: 'list', showOverlay: true }))
  const { store } = boot({ storage: 'preserve' })
  assert.equal(store.getState().spike.showOverlay, false, 'only an explicit toggle may raise the card')
  globalThis.window.localStorage.clear()
})

test('the legacy M0 view name still resolves to the session view', () => {
  globalThis.window.localStorage.setItem('dsh-ssh.state', JSON.stringify({ view: 'workspace', width: 300 }))
  const { store } = boot({ storage: 'preserve' })
  assert.equal(store.getState().panel.view, 'session')
  assert.equal(store.getState().panel.width, 300)
  globalThis.window.localStorage.clear()
})

test('the spike overlay is opt-in, so a first run shows the connection manager', () => {
  globalThis.window.localStorage.clear()
  const { store } = boot()
  assert.equal(store.getState().spike.showOverlay, false)
  assert.equal(store.getState().panel.view, 'list')
})

test('setSecret keeps only the masked projection in state', async () => {
  const { actions, store } = boot()
  const connector = fakeConnector()
  actions.attachConnector(connector)
  const result = await actions.setSecret({ profileId: 'p_1', field: 'password', value: 'hunter2', persist: true })
  assert.equal(result.masked, '••••••••')
  assert.equal(connector.callsFor('setSecret')[0].params.value, 'hunter2', 'the value must reach the endpoint')
  const notice = store.getState().ui.secretNotice
  assert.equal(notice.persisted, true)
  assert.equal(notice.masked, '••••••••')
  assert.equal(JSON.stringify(store.getState()).includes('hunter2'), false, 'the plaintext must not be retained')
})

test('setSecret reports persisted:false as a normal degradation', async () => {
  const { actions, store } = boot()
  actions.attachConnector(fakeConnector({ persistSecrets: false }))
  await actions.setSecret({ profileId: 'p_1', field: 'password', value: 'x', persist: true })
  const notice = store.getState().ui.secretNotice
  assert.equal(notice.persisted, false)
  assert.equal(notice.error, undefined, 'a read-only credential store is not an error')
})

// ── pure helpers (the policies worth testing on their own) ─────────────────

test('groupProfiles groups, alphabetises and searches host/user/group/tags', () => {
  const { ui } = boot()
  const profiles = [PROFILE_A, PROFILE_B, { ...PROFILE_A, id: 'p_3', name: 'local', host: 'localhost', group: '', user: 'me', tags: [] }]
  const grouped = ui.groupProfiles(profiles, '')
  assert.deepEqual(grouped.map((bucket) => bucket.group), ['production', ''], 'named groups lead, ungrouped last')
  assert.deepEqual(grouped[0].items.map((profile) => profile.id), ['p_1', 'p_2'].filter((id) => id === 'p_1'))

  assert.deepEqual(ui.groupProfiles(profiles, 'stg.example').flatMap((bucket) => bucket.items.map((p) => p.id)), ['p_2'])
  assert.deepEqual(ui.groupProfiles(profiles, 'DEPLOY').flatMap((bucket) => bucket.items.map((p) => p.id)), ['p_1'], 'search is case-insensitive')
  assert.deepEqual(ui.groupProfiles(profiles, 'web').flatMap((bucket) => bucket.items.map((p) => p.id)), ['p_1'], 'tags match')
  assert.deepEqual(ui.groupProfiles(profiles, '2222').flatMap((bucket) => bucket.items.map((p) => p.id)), ['p_2'], 'the port matches')
  assert.deepEqual(ui.groupProfiles(profiles, 'nothing'), [])
})

test('secretSummary maps present / from-env / absent and never invents a value', () => {
  const { ui } = boot()
  assert.deepEqual(
    { key: ui.secretSummary(PROFILE_A, 'password').labelKey, masked: ui.secretSummary(PROFILE_A, 'password').masked },
    { key: 'conn.secret.present', masked: '••••••••' },
  )
  assert.equal(ui.secretSummary(PROFILE_B, 'password').labelKey, 'conn.secret.fromEnv')
  assert.equal(ui.secretSummary(PROFILE_B, 'password').present, false)
  assert.equal(ui.secretSummary(null, 'password').labelKey, 'conn.secret.absent')
})

test('toProfileInput omits empty optionals and preserves identity and references', () => {
  const { ui } = boot()
  const input = ui.toProfileInput(
    { name: ' n ', host: 'h', port: '22', user: 'u', auth: 'password', group: '', tags: ' a, b ,,', privateKeyPath: '', connectTimeoutMs: 1000, keepaliveIntervalMs: 2000 },
    { id: 'p_1', secretRefs: { password: 'ref_a' } },
  )
  assert.deepEqual(input, {
    name: 'n',
    host: 'h',
    port: 22,
    user: 'u',
    auth: 'password',
    tags: ['a', 'b'],
    connectTimeoutMs: 1000,
    keepaliveIntervalMs: 2000,
    id: 'p_1',
    secretRefs: { password: 'ref_a' },
  })
  assert.equal('group' in input, false, 'an empty group is omitted so a stored value survives the merge')
  assert.equal('privateKeyPath' in input, false)
  const fresh = ui.toProfileInput({ name: 'a', host: 'h', port: '', user: 'u', auth: 'agent' }, null)
  assert.equal(fresh.port, 22, 'a cleared port falls back to 22, not to 0')
  const outOfRange = ui.toProfileInput({ name: 'a', host: 'h', port: 99999, user: 'u', auth: 'agent' }, null)
  assert.equal(outOfRange.port, 22)
  assert.equal('connectTimeoutMs' in fresh, false, 'a cleared timeout is omitted, not sent as 0')
  assert.equal('secretRefs' in fresh, false)
  assert.equal('id' in fresh, false)
})

test('errorText prefers the dictionary sentence, appends the host detail, and falls back to the host message', () => {
  const { ui } = boot()
  const dictionary = JSON.parse(readFileSync(join(LOCALE_DIR, 'en.json'), 'utf8'))
  // A known code reads as its sentence **plus** the host's message: the sentence alone
  // ("Parameter validation failed") names neither the field nor the rule, while the host's
  // message does ("profileId or an inline profile is required"). Losing that detail is what
  // made a whole class of failures undiagnosable from the UI.
  assert.equal(
    ui.errorText({ code: 'SSH_AUTH_FAILED', message: 'host text' }),
    `${dictionary['err.SSH_AUTH_FAILED']}：host text`,
    'the user reads the dictionary sentence together with the host detail',
  )
  // A message that carries nothing is not appended, and one already present is not repeated.
  assert.equal(ui.errorText({ code: 'SSH_AUTH_FAILED', message: '' }), dictionary['err.SSH_AUTH_FAILED'])
  assert.equal(ui.errorText({ code: 'SSH_AUTH_FAILED' }), dictionary['err.SSH_AUTH_FAILED'])
  assert.equal(
    ui.errorText({ code: 'SSH_AUTH_FAILED', message: dictionary['err.SSH_AUTH_FAILED'] }),
    dictionary['err.SSH_AUTH_FAILED'],
  )
  assert.equal(ui.errorText({ code: 'SSH_NOPE_NOT_A_CODE', message: 'host text' }), 'host text', 'an unknown code surfaces the host message')
  assert.equal(ui.errorText(null), '')
  // The registry-level translator (`SSH.i18n`, published by the chrome and probed by
  // the session UI kit) is the safety net: even when the connection UI cannot reach the
  // chrome module, `err.<CODE>` still resolves to a sentence instead of leaking the raw
  // host string. An unknown code still falls through to the host message.
  const bare = boot({ chrome: null })
  assert.equal(
    bare.ui.errorText({ code: 'SSH_AUTH_FAILED', message: 'host text' }),
    `${dictionary['err.SSH_AUTH_FAILED']}：host text`,
    'the registry-level translator keeps the sentence available',
  )
  assert.equal(bare.ui.errorText({ code: 'SSH_NOPE_NOT_A_CODE', message: 'host text' }), 'host text')
})

test('targetOf and stateLabelKey describe a profile or session consistently', () => {
  const { ui } = boot()
  assert.equal(ui.targetOf(PROFILE_A), 'deploy@web.example:22')
  assert.equal(ui.targetOf({ host: 'h' }), 'h')
  assert.equal(ui.targetOf(null), '—')
  assert.equal(ui.stateLabelKey('connected'), 'conn.state.connected')
  assert.equal(ui.stateLabelKey('authenticating'), 'conn.state.authenticating')
  assert.equal(ui.stateLabelKey('nonsense'), 'conn.state.idle')
})

// ── endpoint client: the R1.3 wire contract ────────────────────────────────

test('assertFlat turns a nested parameter into a loud error instead of a silent drop', () => {
  const { api } = boot()
  assert.deepEqual(api.assertFlat({ a: 1, b: 'x', c: true, d: null }, 'm'), { a: 1, b: 'x', c: true, d: null })
  assert.deepEqual(api.assertFlat({ profileJson: { a: 1 } }, 'm'), { profileJson: '{"a":1}' }, 'a *Json key is encoded')
  assert.throws(() => api.assertFlat({ profile: { a: 1 } }, 'saveProfile'), (error) => {
    assert.equal(error.code, 'SSH_CFG_INVALID')
    assert.match(error.message, /profileJson/)
    return true
  })
  assert.throws(
    () =>
      api.assertFlat({ list: [1, 2] }, 'm'),
    (error) => {
      assert.equal(error.code, 'SSH_CFG_INVALID')
      assert.match(error.message, /listJson/)
      return true
    },
  )
  assert.throws(
    () =>
      api.assertFlat({ fn: () => {} }, 'm'),
    (error) => {
      assert.match(error.message, /unsupported type/)
      return true
    },
  )
  assert.deepEqual(api.assertFlat({ a: undefined, b: 1 }, 'm'), { b: 1 }, 'undefined means "leave it out"')
})

test('the endpoint client sends flat params with <field>Json for nested data', async () => {
  const { api } = boot()
  const calls = []
  api.configure({
    bridge: {
      call: async (method, params) => {
        calls.push({ method, params })
        if (method === 'listProfiles') return { profiles: [] }
        if (method === 'saveProfile') return { profile: { id: 'p_9' } }
        if (method === 'connect') return { session: { id: 's_1' } }
        if (method === 'testProfile') return { ok: true, latencyMs: 5 }
        return {}
      },
    },
    app: null,
  })

  await api.saveProfile({ name: 'a', host: 'h', password: 'hunter2', passphrase: 'x', secrets: { password: 'y' }, tags: ['t'] })
  const save = calls.find((call) => call.method === 'saveProfile')
  assert.deepEqual(Object.keys(save.params), ['profileJson'])
  assert.equal(save.params.profileJson.includes('hunter2'), false, 'a password must never travel inside a profile')
  assert.deepEqual(JSON.parse(save.params.profileJson), { name: 'a', host: 'h', tags: ['t'] })

  await api.connect({ inline: { host: 'h', password: 'nope' }, secrets: { password: 'once' } })
  const connect = calls.find((call) => call.method === 'connect')
  assert.deepEqual(Object.keys(connect.params).sort(), ['inlineJson', 'secretsJson'])
  assert.equal(connect.params.inlineJson.includes('nope'), false)
  assert.equal(connect.params.secretsJson, '{"password":"once"}', 'one-shot secrets are the documented carrier')

  await api.setSecret({ profileId: 'p_1', field: 'password', value: 'v', persist: true })
  const secret = calls.find((call) => call.method === 'setSecret')
  assert.deepEqual(secret.params, { profileId: 'p_1', field: 'password', value: 'v', persist: true })

  await api.listProfiles()
  assert.deepEqual(calls.find((call) => call.method === 'listProfiles').params, {})
})

test('the endpoint client wraps a bridge failure in the endpoint error shape', async () => {
  const { api } = boot()
  api.configure({
    bridge: {
      call: async () => {
        throw { code: 'SSH_NET_TIMEOUT', message: 'timed out', retryable: true }
      },
    },
  })
  await assert.rejects(() => api.listProfiles(), (error) => {
    assert.equal(error.code, 'SSH_NET_TIMEOUT')
    return true
  })
})

test('without a bridge the endpoint client explains itself instead of throwing TypeError', async () => {
  const { api } = boot()
  api.configure({ bridge: null })
  await assert.rejects(() => api.listSessions(), (error) => {
    assert.equal(error.code, 'SSH_STATE_INVALID')
    assert.match(error.message, /not wired/)
    return true
  })
})

// ── components ─────────────────────────────────────────────────────────────

test('ConnList renders the grouped profiles, the mask and the empty state', async () => {
  const { SSH, app, actions } = boot()
  actions.attachConnector(fakeConnector({ profiles: [PROFILE_A, PROFILE_B] }))
  await actions.loadProfiles()
  const view = await mount(React.createElement(SSH.require('ssh.conn.list').ConnList, { app }))
  try {
    assert.match(view.html(), /ssh-conn-row-p_1/)
    assert.match(view.html(), /web\.example/)
    assert.match(view.html(), /ssh-conn-group-production/)
    assert.match(view.html(), /••••••••/, 'a stored credential renders its mask')
    assert.equal(view.html().includes('hunter2'), false)
    assert.equal(view.find('[data-testid="ssh-conn-empty"]'), null)
    assert.equal(view.find('[data-testid="ssh-conn-search"]').getAttribute('placeholder').length > 0, true)
  } finally {
    await view.unmount()
  }
})

test('ConnList shows conn.list.empty when there is nothing to list', async () => {
  const { SSH, app, actions } = boot()
  actions.attachConnector(fakeConnector({ profiles: [] }))
  await actions.loadProfiles()
  const view = await mount(React.createElement(SSH.require('ssh.conn.list').ConnList, { app }))
  try {
    const empty = view.find('[data-testid="ssh-conn-empty"]')
    assert.ok(empty)
    const dictionary = JSON.parse(readFileSync(join(LOCALE_DIR, 'en.json'), 'utf8'))
    assert.match(empty.textContent, new RegExp(dictionary['conn.list.empty'].slice(0, 20)), 'the empty state explains itself')
  } finally {
    await view.unmount()
  }
})

test('the ssh namespace has one owner: the full dictionary survives registration', async () => {
  // The plugin body used to register its own three-key M0 dictionary on the same
  // namespace the chrome's full one uses. Under a last-write-wins locale service that
  // replaces the whole table, so every key but three rendered as a key name.
  const { materialise } = await loadBundle({ react: React })
  const { exports } = materialise()
  const locale = fakeLocale()
  const registrations = []
  const register = locale.register.bind(locale)
  locale.register = (namespace, dictionaries) => {
    registrations.push({ namespace, keys: Object.keys(dictionaries.zh || {}).length })
    return register(namespace, dictionaries)
  }
  exports.apply(fakeContext({
    locale,
    slots: fakeSlots(),
    sidebarRightTabs: fakeTabRegistry(),
    remote: fakeRemoteCarrier(),
  }))

  const dict = locale.dictionaries.get('ssh')
  assert.ok(dict, 'the ssh namespace is registered')
  assert.equal(typeof dict.zh['conn.new'], 'string', 'the full dictionary is the one that stands')
  assert.equal(typeof dict.zh['panel.title'], 'string')
  assert.equal(typeof dict.zh['conn.list.search'], 'string')
  assert.ok(Object.keys(dict.zh).length > 100, `expected the full table, saw ${Object.keys(dict.zh).length} keys`)

  // Every registration of the namespace carries the full table; none carries the M0 three.
  for (const entry of registrations) {
    assert.equal(entry.namespace, 'ssh')
    assert.ok(entry.keys > 100, `a partial registration would clobber the dictionary (saw ${entry.keys} keys)`)
  }
  assert.equal('spike.title' in dict.zh, false, 'the plugin body no longer registers its own table')
})

test('a first load that lands before the carrier exists heals itself', async () => {
  const { SSH, app, actions } = boot()
  const profiles = [PROFILE_A]
  let attempts = 0
  const connector = fakeConnector()
  connector.listProfiles = async () => {
    attempts += 1
    // The carrier is not resolvable yet: the bridge answers with the not-ready error.
    if (attempts < 2) throw { code: 'SSH_STATE_INVALID', message: 'no carrier yet', retryable: true }
    return profiles.map((profile) => ({ ...profile }))
  }
  actions.attachConnector(connector)
  const view = await mount(React.createElement(SSH.require('ssh.conn.list').ConnList, { app }))
  try {
    await view.flush(2)
    assert.equal(attempts, 1, 'the first attempt happened on mount')
    assert.equal(view.find('[data-testid="ssh-conn-row-p_1"]'), null, 'nothing to show yet')

    // The retry is bounded but automatic: no user action, no refresh.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700))
    })
    await view.flush(2)
    assert.equal(attempts >= 2, true, 'the list retried on its own')
    assert.ok(view.find('[data-testid="ssh-conn-row-p_1"]'), 'the profiles appear once the carrier answers')
    assert.equal(app.store.getState().profiles.error, null)
  } finally {
    await view.unmount()
  }
})

test('the session view holds a layout contract: strip, viewport, status row, in that order', async () => {
  // What this test can and cannot do: linkedom has no layout engine, so *pixel* geometry is
  // verified in a real browser (headless Edge over the DevTools protocol — the measured
  // numbers live in `client/src/session/README.md`). Locked here is the structure and the
  // CSS invariants whose loss collapsed the terminal: the strip stays whole, the viewport is
  // the only growing child, and the status row is clamped with an idle transfer slot that
  // costs no height.
  // `chrome: null` keeps the real `ssh.chrome` module in play (boot() otherwise installs a
  // stub under that name): this test is about the status row the chrome renders.
  const { SSH, app, actions } = boot({ chrome: null })
  const panel = SSH.require('ssh.panel')
  const sessionRuntime = SSH.require('ssh.session.runtime')
  const bridge = {
    call: async () => ({ ok: true }),
    stream() {
      return { streamId: null, cancel() {}, done: new Promise(() => {}) }
    },
    transportState: () => ({ kind: 'stub', status: 'ready', generation: 1 }),
    onTransportChange: () => () => {},
  }
  panel.configure({ bridge, app })
  sessionRuntime.configure({ bridge, app })
  const connector = fakeConnector()
  actions.attachConnector(connector)
  const session = await actions.connect({ profileId: 'p_1' })
  assert.ok(session, 'a session is active')

  const view = await mount(React.createElement(panel.SshWorkspace, null))
  try {
    const root = view.find('[data-testid="ssh-session-view"]')
    assert.ok(root, 'the session view is mounted')
    const order = [...root.children].map((node) => node.className)
    assert.deepEqual(
      order,
      ['dsh-ssh-session-tabs', 'dsh-ssh-session-body', 'dsh-ssh-session-status'],
      'the strip sits above the viewport and the status row below it',
    )
    const tabs = view.findAll('[data-testid^="ssh-session-tab-"]').filter((node) => node.getAttribute('data-testid') !== 'ssh-session-tabs')
    assert.equal(tabs.length, 4, 'all four view tabs render')

    const status = view.find('[data-testid="ssh-session-status"]')
    assert.equal(status.getAttribute('data-transfer'), 'idle', 'an idle transfer slot is marked so CSS can drop it')
    assert.ok(view.find('[data-testid="ssh-status-transfer"]'), 'the chrome status bar rendered its items')
    assert.ok(view.find('[data-testid="ssh-status-target"]'), 'and the connection target is among them')
  } finally {
    await view.unmount()
  }

  // The invariants themselves: the sheet is injected by the panel, and removing any of
  // these is exactly how the terminal collapsed to a few rows.
  const panelSource = readFileSync(new URL('../../client/src/panel.js', import.meta.url), 'utf8')
  for (const rule of [
    '.dsh-ssh-session-body { flex:1 1 auto; min-height:0;',
    '.dsh-ssh-session-tabs { flex:0 0 auto;',
    '.dsh-ssh-session-status { flex:0 0 auto; max-height:calc(2 * 1.6em + 10px);',
    '[data-transfer="idle"] [data-testid="ssh-status-transfer"] { display:none; }',
    '@container (max-width: 320px)',
  ]) {
    assert.ok(panelSource.includes(rule), `the layout sheet must keep: ${rule}`)
  }
  const sheet = panelSource.slice(panelSource.indexOf('const LAYOUT_CSS'), panelSource.indexOf('let disposeLayoutCss'))
  assert.equal(/#[0-9a-f]{3,8}\b/i.test(sheet) || /\brgba?\(/.test(sheet), false, 'every colour in the sheet is a token (ICD §8.6)')
})

test('typing in the search box filters the rows without a round trip', async () => {
  const { SSH, app, actions } = boot()
  const connector = fakeConnector({ profiles: [PROFILE_A, PROFILE_B] })
  actions.attachConnector(connector)
  await actions.loadProfiles()
  const view = await mount(React.createElement(SSH.require('ssh.conn.list').ConnList, { app }))
  try {
    typeInto(view.find('[data-testid="ssh-conn-search"]'), 'stg')
    await view.flush(2)
    assert.equal(view.find('[data-testid="ssh-conn-row-p_1"]'), null)
    assert.ok(view.find('[data-testid="ssh-conn-row-p_2"]'))
    typeInto(view.find('[data-testid="ssh-conn-search"]'), 'zzz')
    await view.flush(2)
    assert.ok(view.find('[data-testid="ssh-conn-no-match"]'))
    assert.equal(connector.callsFor('listProfiles').length, 1, 'search is local')
  } finally {
    await view.unmount()
  }
})

test('the tab click resolves to the clicked session id, whatever shape the strip hands over', async () => {
  // The real app handed an *object* (and the active id) to `activateTab`, which compared it
  // against string ids and therefore did nothing — the reported "cannot switch back".
  // String-only tests stayed green, so these shapes are the ones that must be covered.
  const { app, actions, store } = boot({ chrome: null })
  let counter = 0
  const connector = fakeConnector()
  connector.connect = async (request) => {
    counter += 1
    return {
      id: `s_${counter}`,
      profileId: request.profileId,
      label: `host-${counter}`,
      host: `h${counter}.example`,
      port: 22,
      user: 'root',
      state: 'connected',
      since: new Date().toISOString(),
      metrics: { rttMs: 10, bytesIn: 0, bytesOut: 0 },
      capabilities: { shell: true, sftp: true },
    }
  }
  actions.attachConnector(connector)
  const first = await app.actions.connect({ profileId: 'p_1' })
  const second = await actions.connect({ profileId: 'p_2' })
  assert.equal(store.getState().activeSessionId, second.id)

  const switchTo = (input) => {
    actions.activateTab(input)
    return store.getState().activeSessionId
  }

  assert.equal(switchTo(first.id), first.id, 'a string id')
  assert.equal(switchTo({ id: second.id, title: 'b' }), second.id, 'a tab record keyed by id')
  assert.equal(switchTo({ sessionId: first.id, id: first.id }), first.id, 'a tab record keyed by sessionId')
  assert.equal(switchTo({ id: 'tab-2', sessionId: second.id }), second.id, 'a record whose tab id differs from its session')
  assert.equal(switchTo(store.getState().activeSessionId), second.id, 'the current active id stays put')

  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.map((part) => (typeof part === 'object' ? JSON.stringify(part) : String(part))).join(' '))
  try {
    assert.equal(switchTo(undefined), second.id, 'undefined changes nothing')
    assert.equal(switchTo({}), second.id, 'an empty record changes nothing')
    const reported = warnings.filter((line) => line.includes('session tab has no session entry')).length
    assert.equal(reported >= 2, true, `each dead click is reported (saw ${reported})`)
  } finally {
    console.warn = originalWarn
  }
})

test('two sessions: the strip switches A → B → A, and the view follows', async () => {
  // Reported as "opening a second session makes the first tab unclickable". The store must
  // keep both sessions, honour a click on either, and the visible workspace must follow —
  // this asserts the whole chain, not just the action.
  const { SSH, app, actions, store } = boot({ chrome: null })
  let counter = 0
  const connector = fakeConnector()
  connector.connect = async (request) => {
    counter += 1
    return {
      id: `s_${counter}`,
      profileId: request.profileId,
      label: `host-${counter}`,
      host: `h${counter}.example`,
      port: 22,
      user: 'root',
      state: 'connected',
      since: new Date().toISOString(),
      metrics: { rttMs: 10, bytesIn: 0, bytesOut: 0 },
      capabilities: { shell: true, sftp: true },
    }
  }
  actions.attachConnector(connector)
  const bridge = {
    call: async () => ({ ok: true }),
    stream: () => ({ streamId: null, cancel() {}, done: new Promise(() => {}) }),
    transportState: () => ({ kind: 'stub', status: 'ready', generation: 1 }),
    onTransportChange: () => () => {},
  }
  const panel = SSH.require('ssh.panel')
  panel.configure({ bridge, app })
  SSH.require('ssh.session.runtime').configure({ bridge, app })

  const first = await actions.connect({ profileId: 'p_1' })
  const view = await mount(React.createElement(panel.SshWorkspace, null))
  try {
    await view.flush(2)
    assert.equal(view.find('[data-testid="ssh-session-view"]').getAttribute('data-session-id'), first.id)

    const second = await actions.connect({ profileId: 'p_2' })
    await view.flush(2)
    assert.deepEqual(store.getState().sessions.items.map((item) => item.id), [first.id, second.id], 'both sessions stay in the list')
    assert.equal(view.find('[data-testid="ssh-session-view"]').getAttribute('data-session-id'), second.id, 'the new session takes over')

    // The reported failure: clicking the first tab again.
    actions.activateTab(first.id)
    await view.flush(2)
    assert.equal(store.getState().activeSessionId, first.id, 'the active session really changed back')
    assert.equal(view.find('[data-testid="ssh-session-view"]').getAttribute('data-session-id'), first.id, 'and the view followed')
    assert.equal(store.getState().tabs.find((tab) => tab.id === first.id).active, true)

    // An id that belongs to no session must not be silent: it is reported and ignored.
    const warnings = []
    const originalWarn = console.warn
    console.warn = (...args) => warnings.push(args.map((part) => (typeof part === 'object' ? JSON.stringify(part) : String(part))).join(' '))
    try {
      actions.activateTab('s_missing')
      assert.equal(store.getState().activeSessionId, first.id, 'an unknown id changes nothing')
      assert.equal(warnings.some((line) => line.includes('session tab has no session entry')), true, 'and it is not silent')
    } finally {
      console.warn = originalWarn
    }
  } finally {
    await view.unmount()
  }
})

test('the test button reports latency on success and the error sentence on failure', async () => {
  const { SSH, app, actions } = boot()
  const connector = fakeConnector({ profiles: [PROFILE_A] })
  actions.attachConnector(connector)
  await actions.loadProfiles()
  const view = await mount(React.createElement(SSH.require('ssh.conn.list').ConnList, { app }))
  try {
    click(view.find('[data-testid="ssh-conn-test-btn-p_1"]'))
    await view.flush(3)
    const notice = view.find('[data-testid="ssh-conn-test-p_1"]')
    assert.ok(notice, 'the result is shown on the row that was tested')
    assert.match(notice.textContent, /42/)
    assert.equal(notice.getAttribute('data-tone'), 'ok')
    assert.equal(connector.callsFor('testProfile')[0].params.profileId, 'p_1')
  } finally {
    await view.unmount()
  }
})

test('deleting a profile asks the chrome first, and refuses when nothing can confirm', async () => {
  const { SSH, app, actions } = boot()
  const connector = fakeConnector({ profiles: [PROFILE_A] })
  actions.attachConnector(connector)
  await actions.loadProfiles()

  const asked = []
  const chrome = chromeStub()
  chrome.danger = async (kind, details) => {
    asked.push({ kind, details })
    return false
  }
  SSH.require('ssh.conn.ui').configure({ app, api: connector, chrome })
  const view = await mount(React.createElement(SSH.require('ssh.conn.list').ConnList, { app }))
  try {
    click(view.find('[data-testid="ssh-conn-delete-p_1"]'))
    await view.flush(2)
    assert.equal(asked.length, 1)
    assert.equal(asked[0].kind, 'deleteProfile')
    assert.match(asked[0].details.body, /prod-web/, 'the dialog names the profile')
    assert.equal(connector.callsFor('deleteProfile').length, 0, 'a declined confirmation deletes nothing')

    // Approving deletes; a missing chrome (fail-closed) never does.
    const approving = chromeStub({ approveDelete: true })
    SSH.require('ssh.conn.ui').configure({ app, api: connector, chrome: approving })
    click(view.find('[data-testid="ssh-conn-delete-p_1"]'))
    await view.flush(2)
    assert.equal(connector.callsFor('deleteProfile').length, 1)

    // Put the profile back so the fail-closed case has a row to click.
    await actions.loadProfiles()
    await view.flush(2)
    SSH.require('ssh.conn.ui').configure({ app, api: connector, chrome: null })
    click(view.find('[data-testid="ssh-conn-delete-p_1"]'))
    await view.flush(2)
    assert.equal(connector.callsFor('deleteProfile').length, 1, 'no confirmation host means no deletion')
  } finally {
    await view.unmount()
  }
})

test('ConnForm masks the password, never puts it in an attribute, and can reveal it', async () => {
  const { SSH, app, actions } = boot()
  actions.attachConnector(fakeConnector({ profiles: [PROFILE_A] }))
  await actions.loadProfiles()
  actions.openForm(PROFILE_A.id)
  const view = await mount(React.createElement(SSH.require('ssh.conn.form').ConnForm, { app }))
  try {
    const field = view.find('[data-testid="ssh-conn-field-password"]')
    assert.equal(field.getAttribute('type'), 'password')
    typeInto(field, 'hunter2')
    await view.flush(2)
    const html = view.html()
    // The typed value may exist as the input's own value property (that is what a
    // password field is); it must never appear in any *attribute* or in a log line.
    const attributesOnly = html.replace(/(<input[^>]*\bvalue=")[^"]*(")/g, '$1$2')
    assert.equal(attributesOnly.includes('hunter2'), false, 'no attribute may carry the plaintext')
    assert.match(html, /••••••••/, 'the stored credential shows its mask')

    click(view.find('[data-testid="ssh-conn-secret-toggle"]'))
    await view.flush(2)
    assert.equal(view.find('[data-testid="ssh-conn-field-password"]').getAttribute('type'), 'text')
  } finally {
    await view.unmount()
  }
})

test('ConnForm saves, stores a typed secret, then connects — and clears the field', async () => {
  const { SSH, app, actions, store } = boot()
  const connector = fakeConnector({ profiles: [] })
  actions.attachConnector(connector)
  await actions.loadProfiles()
  actions.openForm(null)
  actions.setForm({ name: 'new-host', host: 'h.example', port: 22, user: 'root', auth: 'password' })
  const view = await mount(React.createElement(SSH.require('ssh.conn.form').ConnForm, { app }))
  try {
    typeInto(view.find('[data-testid="ssh-conn-field-password"]'), 'hunter2')
    await view.flush(2)
    click(view.find('[data-testid="ssh-conn-submit"]'))
    await view.flush(4)
    const order = connector.calls.map((call) => call.method)
    assert.deepEqual(order, ['listProfiles', 'saveProfile', 'setSecret', 'connect'], 'the main chain runs in order')
    assert.equal(connector.callsFor('saveProfile')[0].params.password, undefined, 'the profile never carries the password')
    assert.equal(connector.callsFor('setSecret')[0].params.value, 'hunter2')
    assert.equal(connector.callsFor('connect')[0].params.profileId, 'p_new_1')
    assert.equal(view.find('[data-testid="ssh-conn-field-password"]').value, '', 'the typed secret is cleared')
    assert.equal(JSON.stringify(store.getState()).includes('hunter2'), false)
  } finally {
    await view.unmount()
  }
})

test('ConnForm reports persisted:false as a warning, and validation blocks an empty host', async () => {
  const { SSH, app, actions } = boot()
  const connector = fakeConnector({ profiles: [], persistSecrets: false })
  actions.attachConnector(connector)
  await actions.loadProfiles()
  actions.openForm(null)
  actions.setForm({ name: 'n', host: 'h', port: 22, user: 'u', auth: 'password' })
  const view = await mount(React.createElement(SSH.require('ssh.conn.form').ConnForm, { app }))
  try {
    typeInto(view.find('[data-testid="ssh-conn-field-password"]'), 'x')
    await view.flush(2)
    click(view.find('[data-testid="ssh-conn-submit"]'))
    await view.flush(4)
    const notice = view.find('[data-testid="ssh-conn-secret-notice"]')
    assert.ok(notice, 'the degradation is visible')
    assert.equal(notice.getAttribute('data-tone'), 'warn', 'session-only is not an error')
    assert.match(notice.textContent, /••••••••/)
  } finally {
    await view.unmount()
  }

  // An incomplete draft cannot be submitted.
  const second = await mount(React.createElement(SSH.require('ssh.conn.form').ConnForm, { app }))
  try {
    actions.setForm({ host: '' })
    await second.flush(2)
    assert.equal(second.find('[data-testid="ssh-conn-submit"]').hasAttribute('disabled'), true)
  } finally {
    await second.unmount()
  }
})

test('the workspace switches between list, form, session and debug views', async () => {
  const { SSH, app, actions } = boot()
  actions.attachConnector(fakeConnector({ profiles: [PROFILE_A] }))
  await actions.loadProfiles()
  const panel = SSH.require('ssh.panel')
  panel.configure({ bridge: { onTransportChange: () => () => {}, diagnostics: () => ({ inventory: [], attempts: [], serviceShapes: {} }), context: () => ({ resolvedId: null }), transportState: () => ({ kind: 'none', status: 'lost', generation: 0 }), call: async () => ({}) }, app })

  const view = await mount(React.createElement(panel.SshWorkspace))
  try {
    assert.equal(view.find('[data-testid="ssh-workspace"]').getAttribute('data-view'), 'list')
    assert.ok(view.find('[data-testid="ssh-conn-list"]'))

    actions.setPanel({ view: 'form' })
    await view.flush(2)
    assert.ok(view.find('[data-testid="ssh-conn-form"]'))

    actions.setPanel({ view: 'session' })
    await view.flush(2)
    assert.ok(view.find('[data-testid="ssh-session-none"]'), 'no session yet, so the view explains itself')

    actions.setPanel({ view: 'debug' })
    await view.flush(2)
    assert.ok(view.find('[data-testid="ssh-spike-panel"]'), 'the M0 diagnostics stay reachable')
  } finally {
    await view.unmount()
  }
})

// ── chrome wiring ──────────────────────────────────────────────────────────

test('a missing target answers pass, and a provided one is handled and run', () => {
  const { SSH } = boot()
  const shortcuts = SSH.require('ssh.chrome.shortcuts')
  const registered = new Map()
  const service = {
    platform: 'win',
    register(row) {
      registered.set(row.id, row)
      return () => {}
    },
  }
  // `registerShortcuts(ctx, …)` reads the service off the context, exactly as the
  // plugin body calls it.
  const ctx = {
    get: (name) => (name === 'shortcuts' ? service : undefined),
    effect: () => {},
  }
  let ran = 0
  const result = shortcuts.registerShortcuts(ctx, { newConnection: () => { ran += 1 } }, { isOwned: () => true })

  const row = registered.get('ssh.conn.new')
  assert.ok(row, 'the new-connection command is registered with the shell')
  const handled = row.resolve({ target: globalThis.document.body })
  assert.equal(handled.status, 'handled')
  handled.run()
  assert.equal(ran, 1, 'the provided target runs')

  // A command with no target is `pass`: it must not preventDefault, and it must not
  // throw when the key is actually pressed.
  const missing = registered.get('ssh.tab.close')
  assert.ok(missing)
  assert.equal(missing.resolve({ target: globalThis.document.body }).status, 'pass')
  const event = new globalThis.window.Event('keydown', { bubbles: true, cancelable: true })
  event.key = 'Escape'
  globalThis.document.dispatchEvent(event)
  assert.equal(Array.isArray(result.registrations), true)
  // Commands that stay local are never handed to the shell's service.
  assert.equal(registered.has('ssh.history.prev'), false)
  assert.equal(result.registrations.some((entry) => entry.id === 'ssh.history.prev' && entry.status === 'local'), true)
})

test('chrome.install with only the implemented targets reports no error', () => {
  const { SSH } = boot()
  const chrome = SSH.require('ssh.chrome')
  const ctx = {
    get: (name) => (name === 'locale' ? { register: () => () => {}, bind: () => (key) => key } : undefined),
    effect: () => {},
  }
  const errors = []
  const result = chrome.install(ctx, { focusPanel: () => {}, newConnection: () => {}, escape: () => {} }, {
    report: (what, error) => errors.push({ what, message: String(error && error.message) }),
  })
  assert.deepEqual(errors, [], 'installing with a partial table is not an error')
  assert.equal(Array.isArray(result.errors), true)
})
