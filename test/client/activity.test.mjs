/**
 * Agent-activity mirror tests (ICD §4.7 `followActivity`).
 *
 * What is asserted here is the property the mirror exists for: a user watching the
 * right-sidebar SSH panel sees what the AI agent did through the `ssh_*` tools —
 * the command, its live output, and how it ended — for every session the agent
 * touched, not only the one on screen. The pane is read-only, so no test asserts a
 * host call from it except the one narrow exception (清除 → `clearActivity`).
 *
 * **Loader note.** The shared harness's `loadBundle` materialises the *package
 * entry* (`apply` / `components` / `introspect`) and does not hand out the internal
 * module registry, so the component tests load the same sources into the
 * assembler's own registry — exactly the way `session.test.mjs` and
 * `terminal.test.mjs` do. The *shipped artifact* is still verified here: it parses,
 * it carries this module in `@order` position, it carries the regenerated locale
 * mirror, and a real `apply()` succeeds against it.
 *
 * **No geometry.** linkedom is a DOM without a layout engine, so every assertion is
 * on text, `data-*` hooks and the stylesheet's rules — never on measured boxes. The
 * one behaviour that needs measurements (follow-the-tail) supplies them by hand.
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { parseHTML } from 'linkedom'

import {
  BUNDLE_PATH,
  fakeContext,
  fakeLocale,
  fakeRemoteCarrier,
  fakeSlots,
  fakeTabRegistry,
  installDom,
  loadBundle,
} from './harness.mjs'

// The DOM must exist *before* react-dom is evaluated: React decides once whether
// the environment supports the `input` event, and without a document it installs a
// legacy polyfill whose keydown handler dereferences a null instance under linkedom.
const restoreDom = installDom()
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.window.IS_REACT_ACT_ENVIRONMENT = true
// Pin the language: dictionary-backed labels must not depend on the machine.
globalThis.document.documentElement.setAttribute('lang', 'en')
Object.defineProperty(globalThis.document, 'oninput', { value: null, configurable: true, writable: true })

const React = await import('react')
const { act } = React
const { renderToStaticMarkup } = await import('react-dom/server')

process.on('exit', () => {
  try {
    restoreDom()
  } catch {
    /* nothing left to restore */
  }
})

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SRC_DIR = fileURLToPath(new URL('../../client/src', import.meta.url))

/**
 * The dependency set of the mirror: the session workspace (the runtime it reads its
 * transport from, the UI primitives, the stylesheet) plus the two shared roots.
 * Loading exactly this set keeps the suite a property of the mirror — the whole
 * artifact is `bundle.test.mjs`'s subject.
 */
const WORKSPACE_SOURCES = [
  /client[\\/]src[\\/]session[\\/]/,
  /client[\\/]src[\\/]vendor[\\/]/,
  /client[\\/]src[\\/]core\.js$/,
  /client[\\/]src[\\/]bridge\.js$/,
]

function collectSources(dir, filter) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectSources(full, filter))
    else if (entry.isFile() && entry.name.endsWith('.js') && filter(full)) out.push(full)
  }
  const orderOf = (file) => Number(/@order[ \t]+(\d+)/.exec(readFileSync(file, 'utf8'))?.[1] ?? 500)
  return out.sort((a, b) => orderOf(a) - orderOf(b) || (a < b ? -1 : a > b ? 1 : 0))
}

/** Materialise the client sources into the assembler's own `SSH` registry. */
function loadSources(options = {}) {
  const react = options.react ?? React
  const factories = Object.create(null)
  const cache = Object.create(null)
  const styles = []
  const SSH = {
    id: '@local/dsh-ssh',
    react,
    h: react.createElement,
    Fragment: react.Fragment,
    define(name, factory) {
      if (Object.prototype.hasOwnProperty.call(factories, name)) throw new Error(`duplicate module "${name}"`)
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
    style: {
      insert(css) {
        styles.push(css)
        return () => {
          const index = styles.indexOf(css)
          if (index >= 0) styles.splice(index, 1)
        }
      },
      disposeAll() {
        styles.length = 0
      },
    },
  }
  for (const file of options.files ?? collectSources(SRC_DIR, (file) => WORKSPACE_SOURCES.some((p) => p.test(file)))) {
    // The same contract the assembler enforces: each file must compile on its own.
    new Function('SSH', readFileSync(file, 'utf8'))(SSH)
  }
  // Modules a test wants in the registry (a stub for the plugin body, …),
  // registered exactly like a bundle source would be.
  for (const [name, factory] of Object.entries(options.extras ?? {})) SSH.define(name, factory)
  return { SSH, styles }
}

/**
 * One booted bundle run.
 *
 * A fresh registry per test is what keeps the module-level store (one feed per
 * bundle run, by design) from leaking between cases.
 */
function boot(options = {}) {
  const { SSH, styles } = loadSources({ react: React, extras: options.extras })
  const activity = SSH.require('ssh.session.activity')
  const runtime = SSH.require('ssh.session.runtime')
  if (options.bridge) runtime.configure({ bridge: options.bridge, app: null })
  return { SSH, activity, runtime, styles }
}

/**
 * A bridge with only the two entries the mirror may use.
 *
 * `stream` never pushes a frame by itself: the test decides when the host speaks,
 * which is what makes "the snapshot replaces the list" testable at all.
 */
function fakeBridge(options = {}) {
  const calls = []
  const streams = []
  const bridge = {
    call(method, params) {
      calls.push({ method, params })
      return Promise.resolve({ cleared: 1 })
    },
  }
  if (options.stream !== false) {
    bridge.stream = (method, params, onFrame) => {
      calls.push({ method, params })
      if (options.streamThrows) throw new Error('followActivity is not wired into this carrier')
      const handle = { streamId: null, state: {}, cancelled: false, cancel: () => { handle.cancelled = true } }
      streams.push({ method, params, onFrame, handle })
      return handle
    }
  }
  return { bridge, calls, streams }
}

/** Connect the feed and hand back the frame sink the host would write into. */
function connect(activity, streams) {
  const unsubscribe = activity.activityStore.subscribe(() => {})
  const entry = streams[streams.length - 1]
  assert.ok(entry, 'the mirror subscribed to followActivity exactly once')
  return { push: entry.onFrame, handle: entry.handle, unsubscribe }
}

let nextId = 0

/** One `ActivityView` as the host half emits it (ICD §4.7). */
function view(overrides = {}) {
  nextId += 1
  return {
    id: `act-${nextId}`,
    kind: 'exec',
    sessionId: 's_1',
    target: 'deploy@web-01',
    subject: 'uname -a',
    cwd: '/srv/app',
    label: null,
    startedAt: Date.UTC(2026, 0, 5, 12, 0, 1),
    endedAt: null,
    durationMs: null,
    status: 'running',
    exitCode: null,
    signal: null,
    code: null,
    note: null,
    segments: [],
    truncated: false,
    ...overrides,
  }
}

const ids = (activity) => activity.activityStore.getRecords().map((record) => record.id)

/** Parse SSR markup into a queryable fragment (structure only: no layout engine). */
function parsed(markup) {
  const { document } = parseHTML(`<!doctype html><html><body><div id="mirror">${markup}</div></body></html>`)
  return document.getElementById('mirror')
}

const renderPane = (activity, props = { sessionId: 's_1' }) =>
  renderToStaticMarkup(React.createElement(activity.AgentActivityPane, props))

const renderSwitch = (activity, props) =>
  renderToStaticMarkup(React.createElement(activity.AgentActivitySwitch, props))

/** The switch as the session view mounts it: the summary comes from the real hook. */
function SwitchHarness(props) {
  const summary = props.activity.useActivitySummary({ sessionId: props.sessionId })
  return React.createElement(props.activity.AgentActivitySwitch, { mode: 'activity', onMode: () => {}, summary })
}

const renderHarness = (activity, sessionId) =>
  renderToStaticMarkup(React.createElement(SwitchHarness, { activity, sessionId }))

/** The unread badge as a user would read it, or null when there is none. */
function unreadBadge(activity, sessionId = 's_1') {
  const root = parsed(renderHarness(activity, sessionId))
  const badge = root.querySelector('[data-testid="ssh-ws-activity-unread"]')
  return badge ? badge.textContent : null
}

/** The summary object the switch receives, as JSON (hooks cannot be called bare). */
function summaryProbe(activity, sessionId) {
  function Probe(props) {
    const summary = props.activity.useActivitySummary({ sessionId: props.sessionId })
    return React.createElement('span', { 'data-testid': 'summary' }, JSON.stringify(summary))
  }
  const root = parsed(renderToStaticMarkup(React.createElement(Probe, { activity, sessionId })))
  return JSON.parse(root.querySelector('[data-testid="summary"]').textContent)
}

/** Mount a component into the test document (real root: effects and events run). */
async function mount(element) {
  const { createRoot } = await import('react-dom/client')
  const container = globalThis.document.createElement('div')
  globalThis.document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(element)
  })
  return {
    container,
    find: (selector) => container.querySelector(selector),
    findAll: (selector) => [...container.querySelectorAll(selector)],
    async unmount() {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    },
  }
}

/**
 * Click through React's delegated listener.
 *
 * A plain `Event` rather than `MouseEvent`: linkedom does not expose a
 * `MouseEvent` constructor, and React's click dispatch only needs the type and a
 * bubbling path (the same reason `session.test.mjs` drives `input` with `Event`).
 */
async function click(node) {
  await act(async () => {
    node.dispatchEvent(new globalThis.window.Event('click', { bubbles: true }))
  })
}

// ── ingestion ──────────────────────────────────────────────────────────────

test('a snapshot replaces the list instead of appending to it', () => {
  const bridge = fakeBridge()
  const { activity } = boot({ bridge: bridge.bridge })
  const { push } = connect(activity, bridge.streams)

  push({ t: 'activity', phase: 'begin', activity: view({ id: 'act-a', subject: 'first' }) })
  push({ t: 'activity', phase: 'begin', activity: view({ id: 'act-b', subject: 'second' }) })
  assert.deepEqual(ids(activity), ['act-a', 'act-b'], 'records arrive oldest first')

  // Every (re)subscribe opens with the host's retained history: it is the truth,
  // so what the client held before it must go — otherwise a reconnect doubles it.
  push({ t: 'activity-snapshot', activities: [view({ id: 'act-c', subject: 'after the reconnect' })] })
  assert.deepEqual(ids(activity), ['act-c'])
  assert.equal(activity.activityStore.getRecords()[0].subject, 'after the reconnect')

  // An empty snapshot (the host has nothing retained) is still a replacement.
  push({ t: 'activity-snapshot', activities: [] })
  assert.deepEqual(ids(activity), [])

  // Untrusted input: a snapshot whose payload is not a list empties rather than throws.
  assert.doesNotThrow(() => push({ t: 'activity-snapshot', activities: null }))
  assert.deepEqual(ids(activity), [])
})

test('begin, chunk and end upsert one record in arrival order, merging channels', () => {
  const bridge = fakeBridge()
  const { activity } = boot({ bridge: bridge.bridge })
  const { push } = connect(activity, bridge.streams)

  push({ t: 'activity', phase: 'begin', activity: view({ id: 'act-1', subject: 'ls -la' }) })
  assert.deepEqual(ids(activity), ['act-1'])
  assert.equal(activity.activityStore.getRecords()[0].status, 'running')

  push({ t: 'activity', phase: 'chunk', id: 'act-1', chunk: { channel: 'stdout', text: 'total 4\n' } })
  push({ t: 'activity', phase: 'chunk', id: 'act-1', chunk: { channel: 'stdout', text: 'drwxr-xr-x app\n' } })
  push({ t: 'activity', phase: 'chunk', id: 'act-1', chunk: { channel: 'stderr', text: 'ls: cannot access tmp\n' } })
  push({ t: 'activity', phase: 'chunk', id: 'act-1', chunk: { channel: 'stdout', text: 'done\n' } })

  let [record] = activity.activityStore.getRecords()
  assert.deepEqual(
    record.segments.map((segment) => segment.channel),
    ['stdout', 'stderr', 'stdout'],
    'adjacent same-channel text merges, a channel change opens a new segment',
  )
  assert.equal(record.segments[0].text, 'total 4\ndrwxr-xr-x app\n')
  assert.equal(record.segments[2].text, 'done\n')

  push({
    t: 'activity',
    phase: 'end',
    activity: view({
      id: 'act-1',
      subject: 'ls -la',
      status: 'ok',
      exitCode: 0,
      durationMs: 12,
      endedAt: Date.UTC(2026, 0, 5, 12, 0, 2),
      segments: record.segments.map((segment) => ({ ...segment })),
    }),
  })

  const list = activity.activityStore.getRecords()
  assert.equal(list.length, 1, 'end updates the record instead of adding one')
  ;[record] = list
  assert.equal(record.status, 'ok')
  assert.equal(record.exitCode, 0)
  assert.equal(record.durationMs, 12)

  // A chunk for an id this client does not hold cannot be placed in time: it is
  // dropped rather than invented, and the host's next frame carries the record.
  assert.doesNotThrow(() => push({ t: 'activity', phase: 'chunk', id: 'act-gone', chunk: { channel: 'stdout', text: 'orphan' } }))
  assert.equal(activity.activityStore.getRecords().length, 1)

  // A chunk with nothing usable in it changes nothing (and does not throw).
  push({ t: 'activity', phase: 'chunk', id: 'act-1', chunk: { channel: 'stdout', text: '' } })
  push({ t: 'activity', phase: 'chunk', id: 'act-1', chunk: null })
  assert.equal(activity.activityStore.getRecords()[0].segments.length, 3)

  // A frame this module does not own is ignored, not an error.
  assert.doesNotThrow(() => push({ t: 'audit', entry: {} }))
  assert.doesNotThrow(() => push(null))
})

test('a record keeps exactly the frozen ActivityView fields', () => {
  const bridge = fakeBridge()
  const { activity } = boot({ bridge: bridge.bridge })
  const { push } = connect(activity, bridge.streams)

  const startedAt = Date.UTC(2026, 0, 5, 12, 0, 1)
  push({
    t: 'activity',
    phase: 'end',
    activity: view({
      id: 'act-shape',
      kind: 'upload',
      sessionId: 's_2',
      target: 'root@db-01',
      subject: '/local/dump.sql → /srv/dump.sql',
      cwd: null,
      label: 'restore the dump',
      startedAt,
      endedAt: startedAt + 2500,
      durationMs: 2500,
      status: 'error',
      exitCode: 1,
      signal: 'SIGTERM',
      code: 'SSH_SFTP_VERIFY_MISMATCH',
      note: 'the local and remote digests differ',
      segments: [
        { channel: 'info', text: 'scanning\n' },
        { channel: 'stderr', text: 'digest mismatch\n' },
        { channel: 'bogus', text: 'unknown channel -> info\n' },
        null,
      ],
      truncated: true,
    }),
  })

  const [record] = activity.activityStore.getRecords()
  assert.deepEqual(record, {
    id: 'act-shape',
    kind: 'upload',
    sessionId: 's_2',
    target: 'root@db-01',
    subject: '/local/dump.sql → /srv/dump.sql',
    cwd: null,
    label: 'restore the dump',
    startedAt,
    endedAt: startedAt + 2500,
    durationMs: 2500,
    status: 'error',
    exitCode: 1,
    signal: 'SIGTERM',
    code: 'SSH_SFTP_VERIFY_MISMATCH',
    note: 'the local and remote digests differ',
    segments: [
      { channel: 'info', text: 'scanning\n' },
      { channel: 'stderr', text: 'digest mismatch\n' },
      { channel: 'info', text: 'unknown channel -> info\n' },
    ],
    truncated: true,
  })

  // Defensive normalisation of a record the host could not have meant to send.
  push({
    t: 'activity',
    phase: 'begin',
    activity: { id: 'act-thin', kind: 7, status: 'exploded', startedAt: 'yesterday', segments: 'nope' },
  })
  const thin = activity.activityStore.getRecords().find((entry) => entry.id === 'act-thin')
  assert.equal(thin.kind, 'exec', 'an unusable kind falls back to exec')
  assert.equal(thin.status, 'running', 'a status outside the enum is not rendered as words')
  assert.equal(thin.startedAt, 0)
  assert.deepEqual(thin.segments, [])
  assert.equal(thin.sessionId, null)

  // A record without an id cannot be keyed or upserted, so it is refused outright.
  push({ t: 'activity', phase: 'begin', activity: { subject: 'no id' } })
  assert.equal(activity.activityStore.getRecords().some((entry) => entry.subject === 'no id'), false)
})

test('the store caps what it retains: segment count, segment text and record text', () => {
  const bridge = fakeBridge()
  const { activity } = boot({ bridge: bridge.bridge })
  const { push } = connect(activity, bridge.streams)
  const limits = activity.LIMITS

  push({ t: 'activity', phase: 'begin', activity: view({ id: 'act-chatty' }) })
  // Alternating channels: nothing can merge, so the segment cap is what limits it.
  for (let index = 0; index < limits.MAX_SEGMENTS + 5; index += 1) {
    push({
      t: 'activity',
      phase: 'chunk',
      id: 'act-chatty',
      chunk: { channel: index % 2 === 0 ? 'stdout' : 'stderr', text: `line ${index}\n` },
    })
  }
  let [record] = activity.activityStore.getRecords()
  assert.equal(record.segments.length, limits.MAX_SEGMENTS, 'the oldest segments are dropped')
  assert.equal(record.truncated, true, 'dropping text is reported, never hidden')
  assert.equal(record.segments[0].text, 'line 5\n', 'the surviving window is the newest one')

  // A single oversized chunk keeps its tail: the end of the output is what carries
  // the outcome, and the head is recoverable from the command itself.
  const huge = `${'x'.repeat(limits.MAX_SEGMENT_CHARS + 500)}THE-END`
  push({ t: 'activity', phase: 'chunk', id: 'act-chatty', chunk: { channel: 'info', text: huge } })
  ;[record] = activity.activityStore.getRecords()
  const last = record.segments[record.segments.length - 1]
  assert.equal(last.text.length, limits.MAX_SEGMENT_CHARS)
  assert.ok(last.text.endsWith('THE-END'), 'the tail is what survives')

  // The retained record count is bounded too: an endless feed cannot grow forever.
  const many = Array.from({ length: limits.RETAIN_LIMIT + 25 }, (_, index) =>
    view({ id: `act-ring-${index}`, subject: `cmd ${index}`, status: 'ok', endedAt: 1, durationMs: 1 }),
  )
  push({ t: 'activity-snapshot', activities: many })
  assert.equal(activity.activityStore.getRecords().length, limits.RETAIN_LIMIT)
  assert.equal(activity.activityStore.getRecords()[0].id, 'act-ring-25', 'the oldest are the ones dropped')
})

test('activity-reset clears the list and the unread it was counting', () => {
  const bridge = fakeBridge()
  const { activity } = boot({ bridge: bridge.bridge })
  const { push } = connect(activity, bridge.streams)

  push({ t: 'activity', phase: 'begin', activity: view({ id: 'act-1' }) })
  push({ t: 'activity', phase: 'end', activity: view({ id: 'act-1', status: 'ok', endedAt: 1, durationMs: 1 }) })
  assert.equal(unreadBadge(activity), '2')

  push({ t: 'activity-reset' })
  assert.deepEqual(ids(activity), [])
  assert.equal(unreadBadge(activity), null, 'nothing is left to be unread about')
})

// ── unread semantics ───────────────────────────────────────────────────────

test('unread counts arrivals while no pane is mounted, and markActivitySeen clears it', () => {
  const bridge = fakeBridge()
  const { activity } = boot({ bridge: bridge.bridge })
  const { push } = connect(activity, bridge.streams)

  assert.equal(unreadBadge(activity), null, 'an empty feed shows no badge')

  push({ t: 'activity', phase: 'begin', activity: view({ id: 'act-1' }) })
  assert.equal(unreadBadge(activity), '1', 'a begin with no pane mounted is unread')

  // Chunks are not arrivals: they describe a record the user has already missed.
  push({ t: 'activity', phase: 'chunk', id: 'act-1', chunk: { channel: 'stdout', text: 'output\n' } })
  assert.equal(unreadBadge(activity), '1')

  push({ t: 'activity', phase: 'end', activity: view({ id: 'act-1', status: 'error', exitCode: 1, endedAt: 2, durationMs: 1 }) })
  assert.equal(unreadBadge(activity), '2', 'the end of a record is an arrival too')

  activity.markActivitySeen()
  assert.equal(unreadBadge(activity), null, 'markActivitySeen() resets the badge')

  // Idempotent: the session view calls it on every render while the mirror is shown.
  assert.doesNotThrow(() => activity.markActivitySeen())
  assert.equal(unreadBadge(activity), null)

  // The badge is bounded, so an untouched panel cannot grow an unbounded number.
  for (let index = 0; index < 120; index += 1) {
    push({ t: 'activity', phase: 'begin', activity: view({ id: `act-flood-${index}` }) })
  }
  assert.equal(unreadBadge(activity), '99+')
  activity.markActivitySeen()
  assert.equal(unreadBadge(activity), null)
})

test('the summary is scoped to the session on screen while all.* stays global', () => {
  const bridge = fakeBridge()
  const { activity } = boot({ bridge: bridge.bridge })
  const { push } = connect(activity, bridge.streams)

  push({ t: 'activity', phase: 'begin', activity: view({ id: 'act-1', sessionId: 's_1', startedAt: 1000 }) })
  push({ t: 'activity', phase: 'begin', activity: view({ id: 'act-2', sessionId: 's_2', startedAt: 2000 }) })
  push({
    t: 'activity',
    phase: 'end',
    activity: view({ id: 'act-3', sessionId: 's_2', startedAt: 500, endedAt: 3000, durationMs: 2500, status: 'ok' }),
  })

  assert.deepEqual(summaryProbe(activity, 's_1'), {
    total: 1,
    running: 1,
    unread: 3,
    newestAt: 1000,
    all: { total: 3, running: 2, unread: 3 },
  })
  assert.deepEqual(summaryProbe(activity, 's_2'), {
    total: 2,
    running: 1,
    unread: 3,
    newestAt: 3000,
    all: { total: 3, running: 2, unread: 3 },
  })
  // No session (or no sessionId) means the global view — what the pane draws.
  assert.equal(summaryProbe(activity, undefined).total, 3)
  assert.equal(summaryProbe(activity, null).total, 3)
})

test('getRecords(sessionId) filters for the caller while getRecords() is the whole feed', () => {
  const bridge = fakeBridge()
  const { activity } = boot({ bridge: bridge.bridge })
  const { push } = connect(activity, bridge.streams)

  push({ t: 'activity', phase: 'begin', activity: view({ id: 'act-1', sessionId: 's_1' }) })
  push({ t: 'activity', phase: 'begin', activity: view({ id: 'act-2', sessionId: 's_2' }) })
  push({ t: 'activity', phase: 'begin', activity: view({ id: 'act-3', sessionId: null }) })

  assert.equal(activity.activityStore.getRecords().length, 3)
  assert.deepEqual(activity.activityStore.getRecords('s_1').map((record) => record.id), ['act-1'])
  assert.deepEqual(activity.activityStore.getRecords('s_9'), [])
  // A record with no session belongs to no session — the session view must not claim it.
  assert.deepEqual(activity.activityStore.getRecords('s_3'), [])

  // The store hands out copies: a caller sorting its view cannot reorder the feed.
  const copy = activity.activityStore.getRecords()
  copy.reverse()
  assert.deepEqual(ids(activity), ['act-1', 'act-2', 'act-3'])
})

// ── rendering (SSR) ────────────────────────────────────────────────────────

test('the pane draws every record with its own session and target', () => {
  const bridge = fakeBridge()
  const { activity } = boot({ bridge: bridge.bridge })
  const { push } = connect(activity, bridge.streams)

  // The agent works on another host: the pane is opened for s_1 and must still show
  // s_2's work, labelled with s_2's own target — nothing inherited from the panel.
  push({ t: 'activity', phase: 'begin', activity: view({ id: 'act-1', sessionId: 's_1', target: 'deploy@web-01', subject: 'uptime' }) })
  push({ t: 'activity', phase: 'begin', activity: view({ id: 'act-2', sessionId: 's_2', target: 'root@db-01', subject: 'pg_dump' }) })
  push({
    t: 'activity',
    phase: 'begin',
    activity: view({ id: 'act-3', kind: 'connect', sessionId: null, target: null, subject: '10.0.0.7:22' }),
  })

  const root = parsed(renderPane(activity, { sessionId: 's_1' }))
  const entries = root.querySelectorAll('[data-testid="ssh-ws-activity-entry"]')
  assert.equal(entries.length, 3, 'every record is drawn, whichever session it belongs to')
  assert.deepEqual(
    [...root.querySelectorAll('[data-testid="ssh-ws-activity-target"]')].map((node) => node.textContent),
    ['deploy@web-01', 'root@db-01', '—'],
  )
  assert.deepEqual(
    [...root.querySelectorAll('[data-testid="ssh-ws-activity-entry"]')].map((node) => node.getAttribute('data-activity-id')),
    ['act-1', 'act-2', 'act-3'],
    'oldest first: the newest activity is the last block',
  )
  assert.equal(root.querySelector('[data-testid="ssh-ws-activity"]').getAttribute('data-records'), '3')
  assert.match(root.querySelector('[data-testid="ssh-ws-activity-session"]').textContent, /s_1/)

  // The subject of an exec is the command, marked like a shell line; another kind is
  // a one-line description and carries no `$`.
  assert.deepEqual(
    [...root.querySelectorAll('[data-testid="ssh-ws-activity-subject"]')].map((node) => node.textContent),
    ['$ uptime', '$ pg_dump', '10.0.0.7:22'],
  )

  const other = parsed(renderPane(activity, { sessionId: 's_2' }))
  assert.equal(other.querySelectorAll('[data-testid="ssh-ws-activity-entry"]').length, 3)
})

test('the header line carries the local clock time, the kind and the status', () => {
  const bridge = fakeBridge()
  const { activity } = boot({ bridge: bridge.bridge })
  const { push } = connect(activity, bridge.streams)

  const startedAt = Date.UTC(2026, 0, 5, 12, 0, 1)
  push({ t: 'activity', phase: 'begin', activity: view({ id: 'act-1', startedAt }) })

  const root = parsed(renderPane(activity))
  const entry = root.querySelector('[data-activity-id="act-1"]')
  assert.equal(entry.getAttribute('data-kind'), 'exec')
  assert.equal(entry.getAttribute('data-status'), 'running')

  // HH:MM:SS in the *local* zone, which is what a user compares against their own clock.
  const date = new Date(startedAt)
  const pad = (value) => String(value).padStart(2, '0')
  const expected = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  assert.equal(entry.querySelector('.ssh-ws-activity-time').textContent, expected)
  assert.match(entry.querySelector('.ssh-ws-activity-kind').textContent, /exec/)
  assert.ok(entry.querySelector('[data-testid="ssh-ws-activity-status"]').textContent.length > 0)

  // An unusable timestamp renders a placeholder rather than "Invalid Date".
  push({ t: 'activity', phase: 'begin', activity: view({ id: 'act-2', startedAt: 0 }) })
  const again = parsed(renderPane(activity))
  assert.equal(again.querySelector('[data-activity-id="act-2"] .ssh-ws-activity-time').textContent, '--:--:--')
})

test('stdout, stderr and info render apart, and stderr keeps the error channel', () => {
  const bridge = fakeBridge()
  const { activity } = boot({ bridge: bridge.bridge })
  const { push } = connect(activity, bridge.streams)

  push({ t: 'activity', phase: 'begin', activity: view({ id: 'act-1', subject: 'systemctl restart app' }) })
  push({ t: 'activity', phase: 'chunk', id: 'act-1', chunk: { channel: 'stdout', text: 'restarting\n' } })
  push({ t: 'activity', phase: 'chunk', id: 'act-1', chunk: { channel: 'stderr', text: 'unit not found\n' } })
  push({ t: 'activity', phase: 'chunk', id: 'act-1', chunk: { channel: 'info', text: 'retrying once\n' } })

  const root = parsed(renderPane(activity))
  const segments = root.querySelectorAll('[data-testid="ssh-ws-activity-seg"]')
  assert.deepEqual(
    [...segments].map((node) => node.getAttribute('data-channel')),
    ['stdout', 'stderr', 'info'],
    'the wire order is the render order',
  )
  assert.deepEqual(
    [...segments].map((node) => node.textContent),
    ['restarting\n', 'unit not found\n', 'retrying once\n'],
  )
  // The channel is the only styling input: the colour decision lives in the
  // stylesheet (asserted below), because linkedom cannot compute it.
  assert.equal(root.querySelectorAll('[data-channel="stderr"]').length, 1)
})

test('a running record becomes ok or error with its exit code in the footer', () => {
  const bridge = fakeBridge()
  const { activity } = boot({ bridge: bridge.bridge })
  const { push } = connect(activity, bridge.streams)

  push({ t: 'activity', phase: 'begin', activity: view({ id: 'act-1', subject: 'npm run build' }) })
  let root = parsed(renderPane(activity))
  assert.equal(root.querySelector('[data-activity-id="act-1"]').getAttribute('data-status'), 'running')
  assert.equal(
    root.querySelector('[data-testid="ssh-ws-activity-foot"]'),
    null,
    'a running record with no facts yet has no footer row',
  )
  // The header reports the running count, and only while something runs.
  assert.match(root.querySelector('[data-testid="ssh-ws-activity-running"]').textContent, /1/)

  push({
    t: 'activity',
    phase: 'end',
    activity: view({
      id: 'act-1',
      subject: 'npm run build',
      status: 'ok',
      exitCode: 0,
      durationMs: 250,
      endedAt: Date.UTC(2026, 0, 5, 12, 0, 3),
      segments: [{ channel: 'stdout', text: 'built in 1.2s\n' }],
    }),
  })
  root = parsed(renderPane(activity))
  const entry = root.querySelector('[data-activity-id="act-1"]')
  assert.equal(entry.getAttribute('data-status'), 'ok')
  assert.equal(root.querySelector('[data-testid="ssh-ws-activity-running"]'), null, 'nothing runs now')
  const foot = entry.querySelector('[data-testid="ssh-ws-activity-foot"]')
  assert.match(foot.textContent, /(^|\D)0(\D|$)/, 'the exit code is stated')
  assert.match(foot.textContent, /250 ms/, 'the duration is stated in human units')
  assert.match(entry.querySelector('.ssh-ws-activity-seg').textContent, /built in 1\.2s/)

  push({
    t: 'activity',
    phase: 'end',
    activity: view({
      id: 'act-2',
      subject: 'make release',
      status: 'error',
      exitCode: 2,
      durationMs: 40,
      endedAt: Date.UTC(2026, 0, 5, 12, 0, 4),
      segments: [{ channel: 'stderr', text: 'make: *** [release] Error 2\n' }],
    }),
  })
  root = parsed(renderPane(activity))
  const failed = root.querySelector('[data-activity-id="act-2"]')
  assert.equal(failed.getAttribute('data-status'), 'error')
  assert.equal(failed.querySelector('[data-testid="ssh-ws-activity-status"]').getAttribute('data-outcome'), 'error')
  assert.match(failed.querySelector('[data-testid="ssh-ws-activity-foot"]').textContent, /(^|\D)2(\D|$)/)
})

test('a refused record renders its code and its note, not just a word', () => {
  const bridge = fakeBridge()
  const { activity } = boot({ bridge: bridge.bridge })
  const { push } = connect(activity, bridge.streams)

  push({
    t: 'activity',
    phase: 'end',
    activity: view({
      id: 'act-refused',
      kind: 'exec',
      subject: 'rm -rf /srv/old',
      status: 'refused',
      code: 'SSH_PERM_DENIED',
      note: 'the tool was refused before it reached the host',
      endedAt: Date.UTC(2026, 0, 5, 12, 0, 5),
      durationMs: 0,
    }),
  })

  const root = parsed(renderPane(activity))
  const entry = root.querySelector('[data-activity-id="act-refused"]')
  assert.equal(entry.getAttribute('data-status'), 'refused')
  assert.equal(entry.querySelector('[data-testid="ssh-ws-activity-status"]').getAttribute('data-outcome'), 'refused')
  assert.equal(entry.querySelector('[data-testid="ssh-ws-activity-code"]').textContent, 'SSH_PERM_DENIED')
  assert.equal(
    entry.querySelector('[data-testid="ssh-ws-activity-note"]').textContent,
    'the tool was refused before it reached the host',
  )
  assert.match(entry.querySelector('[data-testid="ssh-ws-activity-subject"]').textContent, /rm -rf/)

  // A cancelled record states its signal, and a truncated one says so.
  push({
    t: 'activity',
    phase: 'end',
    activity: view({
      id: 'act-cancelled',
      status: 'cancelled',
      signal: 'SIGTERM',
      durationMs: 300,
      truncated: true,
      endedAt: Date.UTC(2026, 0, 5, 12, 0, 6),
    }),
  })
  const again = parsed(renderPane(activity))
  const cancelled = again.querySelector('[data-activity-id="act-cancelled"]')
  assert.match(cancelled.querySelector('[data-testid="ssh-ws-activity-foot"]').textContent, /SIGTERM/)
  assert.match(cancelled.querySelector('[data-testid="ssh-ws-activity-foot"]').textContent, /ws\.activity\.truncated|truncated/i)
})

test('an empty feed explains itself instead of drawing an empty box', () => {
  const bridge = fakeBridge()
  const { activity } = boot({ bridge: bridge.bridge })
  connect(activity, bridge.streams)

  const root = parsed(renderPane(activity, { sessionId: 's_1' }))
  assert.ok(root.querySelector('[data-testid="ssh-ws-activity-empty"]'), 'the empty state is a named seat')
  assert.equal(root.querySelectorAll('[data-testid="ssh-ws-activity-entry"]').length, 0)
  assert.equal(root.querySelector('[data-testid="ssh-ws-activity-count"]').textContent, '0')
  const clear = root.querySelector('[data-testid="ssh-ws-activity-clear"]')
  assert.equal(clear.disabled, true, 'there is nothing to clear yet')
})

test('the pane draws the newest records only, so a long feed cannot flood the panel', () => {
  const bridge = fakeBridge()
  const { activity } = boot({ bridge: bridge.bridge })
  const { push } = connect(activity, bridge.streams)
  const limit = activity.LIMITS.RENDER_LIMIT
  assert.ok(limit > 0 && limit <= 500, 'a bounded render window is the point of the cap')

  const total = limit + 37
  const many = Array.from({ length: total }, (_, index) =>
    view({ id: `act-${index}`, subject: `cmd ${index}`, status: 'ok', endedAt: 10, durationMs: 10 }),
  )
  push({ t: 'activity-snapshot', activities: many })

  const root = parsed(renderPane(activity))
  const drawn = [...root.querySelectorAll('[data-testid="ssh-ws-activity-entry"]')].map((node) =>
    node.getAttribute('data-activity-id'),
  )
  assert.equal(drawn.length, limit, 'the DOM holds the render window, not the whole feed')
  assert.equal(drawn[drawn.length - 1], `act-${total - 1}`, 'the newest record is always the last block')
  assert.equal(drawn[0], `act-${total - limit}`)
  assert.equal(root.querySelector('[data-testid="ssh-ws-activity"]').getAttribute('data-records'), String(total))
  assert.equal(root.querySelector('[data-testid="ssh-ws-activity-count"]').textContent, String(total))
})

// ── the switch ─────────────────────────────────────────────────────────────

test('the switch renders both modes as reachable buttons with a badge and a spinner', () => {
  const bridge = fakeBridge()
  const { activity } = boot({ bridge: bridge.bridge })
  const { push } = connect(activity, bridge.streams)

  const idle = parsed(renderSwitch(activity, { mode: 'terminal', onMode: () => {}, summary: { total: 0, running: 0, unread: 0, newestAt: 0 } }))
  const terminal = idle.querySelector('[data-testid="ssh-ws-activity-mode-terminal"]')
  const mirror = idle.querySelector('[data-testid="ssh-ws-activity-mode-activity"]')
  assert.equal(terminal.tagName, 'BUTTON', 'a real button is keyboard reachable and activatable')
  assert.equal(mirror.tagName, 'BUTTON')
  assert.equal(terminal.getAttribute('data-active'), 'true')
  assert.equal(mirror.getAttribute('data-active'), 'false')
  assert.equal(terminal.getAttribute('aria-pressed'), 'true')
  assert.equal(idle.querySelector('[data-testid="ssh-ws-activity-unread"]'), null, 'no badge at zero')
  assert.equal(idle.querySelector('[data-testid="ssh-ws-activity-running"]'), null, 'no spinner at zero')

  const busy = parsed(
    renderSwitch(activity, { mode: 'activity', onMode: () => {}, summary: { total: 4, running: 2, unread: 3, newestAt: 1 } }),
  )
  assert.equal(busy.querySelector('[data-testid="ssh-ws-activity-mode-activity"]').getAttribute('data-active'), 'true')
  assert.equal(busy.querySelector('[data-testid="ssh-ws-activity-unread"]').textContent, '3')
  assert.match(busy.querySelector('[data-testid="ssh-ws-activity-running"]').textContent, /2/)

  // The callback is how the panel keeps an explicit choice; the component never
  // decides the mode itself.
  const choices = []
  const markup = renderSwitch(activity, { mode: 'terminal', onMode: (next) => choices.push(next), summary: {} })
  assert.match(markup, /data-testid="ssh-ws-activity-switch"/)
  assert.deepEqual(choices, [], 'rendering is not choosing')
  push({ t: 'activity', phase: 'begin', activity: view({ id: 'act-1' }) })
})

test('the unread badge and the running indicator react to the feed', () => {
  const bridge = fakeBridge()
  const { activity } = boot({ bridge: bridge.bridge })
  const { push } = connect(activity, bridge.streams)

  assert.equal(unreadBadge(activity), null)
  push({ t: 'activity', phase: 'begin', activity: view({ id: 'act-1', sessionId: 's_1', status: 'running' }) })
  const badge = parsed(renderHarness(activity, 's_1'))
  assert.equal(badge.querySelector('[data-testid="ssh-ws-activity-unread"]').textContent, '1')
  assert.match(badge.querySelector('[data-testid="ssh-ws-activity-running"]').textContent, /1/)
  assert.equal(
    badge.querySelector('[data-testid="ssh-ws-activity-mode-activity"]').getAttribute('aria-pressed'),
    'true',
    'the harness renders the mirror face',
  )

  // A running record on another session still counts for *that* session's switch.
  push({ t: 'activity', phase: 'begin', activity: view({ id: 'act-2', sessionId: 's_2', status: 'running' }) })
  const other = parsed(renderHarness(activity, 's_2'))
  assert.match(other.querySelector('[data-testid="ssh-ws-activity-running"]').textContent, /1/, 'one running record')
  assert.equal(other.querySelector('[data-testid="ssh-ws-activity-unread"]').textContent, '2')
})

// ── lifecycle: mount, follow, clear ────────────────────────────────────────

test('a mounted pane absorbs arrivals and follows the tail until the user scrolls up', async () => {
  const bridge = fakeBridge()
  const { activity, styles } = boot({ bridge: bridge.bridge })
  const { push } = connect(activity, bridge.streams)
  const view0 = await mount(React.createElement(activity.AgentActivityPane, { sessionId: 's_1' }))
  try {
    assert.ok(view0.find('[data-testid="ssh-ws-activity-empty"]'), 'nothing has happened yet')
    // The stylesheet is installed once per client run, and it is this module's rules.
    assert.equal(styles.length, 1, 'the workspace sheet is inserted exactly once')
    assert.match(styles[0], /\.ssh-ws-activity-seg/)

    // A pane is on screen, so an arrival is not "unread" — the user is looking at it.
    await act(async () => {
      push({ t: 'activity', phase: 'begin', activity: view({ id: 'act-1' }) })
    })
    assert.equal(unreadBadge(activity), null, 'a mounted pane absorbs arrivals')
    assert.ok(view0.find('[data-activity-id="act-1"]'), 'the record reached the DOM')

    const list = view0.find('[data-testid="ssh-ws-activity-list"]')
    // No layout engine: supply the geometry the scroll decision reads.
    Object.defineProperty(list, 'scrollHeight', { value: 600, configurable: true })
    Object.defineProperty(list, 'clientHeight', { value: 200, configurable: true })

    const follow = view0.find('[data-testid="ssh-ws-activity-follow"]')
    assert.equal(follow.getAttribute('data-following'), 'true', 'the pane starts at the tail')
    assert.equal(view0.find('[data-testid="ssh-ws-activity-latest"]'), null)

    // Scrolled to the bottom: still following.
    list.scrollTop = 600
    await act(async () => {
      list.dispatchEvent(new globalThis.window.Event('scroll'))
    })
    assert.equal(view0.find('[data-testid="ssh-ws-activity-follow"]').getAttribute('data-following'), 'true')

    // Scrolled up into the history: the follow stops and the jump appears.
    list.scrollTop = 0
    await act(async () => {
      list.dispatchEvent(new globalThis.window.Event('scroll'))
    })
    assert.equal(view0.find('[data-testid="ssh-ws-activity-follow"]').getAttribute('data-following'), 'false')
    const latest = view0.find('[data-testid="ssh-ws-activity-latest"]')
    assert.ok(latest, 'the jump-to-latest affordance appears once the follow stops')

    await click(latest)
    assert.equal(view0.find('[data-testid="ssh-ws-activity-follow"]').getAttribute('data-following'), 'true')
    assert.equal(view0.find('[data-testid="ssh-ws-activity-latest"]'), null, 'and goes away again')

    // The follow affordance is a control too: pressing it stops the follow by hand.
    await click(view0.find('[data-testid="ssh-ws-activity-follow"]'))
    assert.equal(view0.find('[data-testid="ssh-ws-activity-follow"]').getAttribute('data-following'), 'false')
  } finally {
    await view0.unmount()
  }
})

test('the clear action empties the mirror locally and asks the host to do the same', async () => {
  const bridge = fakeBridge()
  const { activity } = boot({ bridge: bridge.bridge })
  const { push } = connect(activity, bridge.streams)

  push({ t: 'activity', phase: 'begin', activity: view({ id: 'act-1' }) })
  push({ t: 'activity', phase: 'end', activity: view({ id: 'act-1', status: 'ok', endedAt: 5, durationMs: 5 }) })

  const mounted = await mount(React.createElement(activity.AgentActivityPane, { sessionId: 's_1' }))
  try {
    assert.equal(mounted.findAll('[data-testid="ssh-ws-activity-entry"]').length, 1)
    await click(mounted.find('[data-testid="ssh-ws-activity-clear"]'))
    assert.deepEqual(ids(activity), [], 'the list is emptied')
    assert.ok(mounted.find('[data-testid="ssh-ws-activity-empty"]'), 'and the pane says so')

    const clears = bridge.calls.filter((call) => call.method === 'clearActivity')
    assert.equal(clears.length, 1, 'the host is told once, so no other panel resurrects the history')
    assert.equal(clears[0].params, undefined, 'clearActivity takes no argument on the wire')

    // The host then confirms with its own reset frame; applying it twice changes nothing.
    push({ t: 'activity-reset' })
    assert.deepEqual(ids(activity), [])
  } finally {
    await mounted.unmount()
  }
})

test('the pane never issues a host operation of its own', async () => {
  const bridge = fakeBridge()
  const { activity } = boot({ bridge: bridge.bridge })
  const { push } = connect(activity, bridge.streams)

  push({ t: 'activity', phase: 'begin', activity: view({ id: 'act-1' }) })
  push({ t: 'activity', phase: 'chunk', id: 'act-1', chunk: { channel: 'stdout', text: 'output\n' } })
  push({ t: 'activity', phase: 'end', activity: view({ id: 'act-1', status: 'ok', exitCode: 0, endedAt: 6, durationMs: 6 }) })

  const mounted = await mount(React.createElement(activity.AgentActivityPane, { sessionId: 's_1' }))
  try {
    // Rendering, scrolling and following are local: the only bridge traffic is the
    // subscription itself.
    await click(mounted.find('[data-testid="ssh-ws-activity-follow"]'))
    await click(mounted.find('[data-testid="ssh-ws-activity-follow"]'))
    const methods = bridge.calls.map((call) => call.method)
    assert.deepEqual(methods, ['followActivity'], 'the mirror opens a feed and nothing else')
    assert.deepEqual(bridge.calls[0].params, {}, 'no session filter: the agent may work elsewhere')
    assert.equal(bridge.streams.length, 1, 'one subscription per bundle run, not one per mount')
  } finally {
    await mounted.unmount()
  }

  // Unmounting does not cancel the feed: the agent keeps working while no pane is open.
  assert.equal(bridge.streams[0].handle.cancelled, false)
})

test('a second mount reuses the one subscription instead of opening another', async () => {
  const bridge = fakeBridge()
  const { activity } = boot({ bridge: bridge.bridge })
  connect(activity, bridge.streams)

  const first = await mount(React.createElement(activity.AgentActivityPane, { sessionId: 's_1' }))
  const second = await mount(React.createElement(activity.AgentActivityPane, { sessionId: 's_2' }))
  try {
    assert.equal(bridge.streams.length, 1, 'the feed is global: one handle for the whole run')
    assert.equal(bridge.calls.filter((call) => call.method === 'followActivity').length, 1)
  } finally {
    await first.unmount()
    await second.unmount()
  }
})

// ── tolerance: an unwired or hostile transport ─────────────────────────────

test('a bridge with no stream entry leaves the mirror idle instead of throwing', () => {
  const bridge = fakeBridge({ stream: false })
  const { activity } = boot({ bridge: bridge.bridge })

  // Subscribing is what connects; with no `stream` there is nothing to connect to,
  // and that must be a no-op rather than an exception into React.
  assert.doesNotThrow(() => activity.activityStore.subscribe(() => {}))
  assert.deepEqual(activity.activityStore.getRecords(), [])
  assert.doesNotThrow(() => activity.markActivitySeen())
  assert.doesNotThrow(() => activity.activityStore.clear())
  const markup = renderPane(activity)
  assert.match(markup, /data-testid="ssh-ws-activity-empty"/, 'the pane still renders, explained')
  assert.equal(bridge.calls.length, 0)
})

test('a bridge whose stream throws is survived, and a later mount retries', () => {
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.map((value) => String(value)).join(' '))
  const calls = []
  const bridge = {
    call: () => Promise.resolve({}),
    stream: () => {
      calls.push('stream')
      throw new Error('followActivity is not wired into this carrier')
    },
  }
  try {
    const { activity } = boot({ bridge })
    // Both entry points into the transport — the store's subscriber and the pane's
    // mount effect — must survive it.
    assert.doesNotThrow(() => activity.activityStore.subscribe(() => {}))
    assert.doesNotThrow(() => renderPane(activity))
    assert.equal(calls.length >= 1, true, 'the transport was actually attempted')
    assert.equal(warnings.some((line) => line.includes('followActivity')), true, 'and the reason is reported once')

    // Nothing was cached negatively: the next mount tries again (the carrier may
    // simply not have been mounted yet).
    const before = calls.length
    assert.doesNotThrow(() => activity.activityStore.subscribe(() => {}))
    assert.equal(calls.length > before, true)
    assert.deepEqual(activity.activityStore.getRecords(), [])
  } finally {
    console.warn = originalWarn
  }
})

test('frames this module does not own are dropped without a trace', () => {
  const bridge = fakeBridge()
  const { activity } = boot({ bridge: bridge.bridge })
  const { push } = connect(activity, bridge.streams)

  for (const frame of [
    null,
    undefined,
    'a string',
    { t: 42 },
    { t: 'activity', phase: 'sideways', activity: view({ id: 'act-x' }) },
    { t: 'activity', phase: 'begin' },
    { t: 'activity', phase: 'chunk' },
    { t: 'open', streamId: 'st_1' },
    { t: 'data', streamId: 'st_1', seq: 1, chunk: 'open\n', encoding: 'utf8', channel: 'stdout' },
  ]) {
    assert.doesNotThrow(() => push(frame), `frame ${JSON.stringify(frame)} must be ignored`)
  }
  assert.deepEqual(activity.activityStore.getRecords(), [], 'nothing was invented from a foreign frame')
})

// ── the ends of the system: stylesheet, module surface, artifact ───────────

test('the mirror stylesheet stays token-only and marks stderr as an error channel', () => {
  const { SSH } = loadSources({ react: React })
  const css = SSH.require('ssh.session.styles').CSS

  assert.match(css, /\.ssh-ws-activity-seg\[data-channel="stderr"\]\s*\{\s*color:var\(--dsw-alias-state-error-primary\)/)
  assert.match(css, /\.ssh-ws-activity-seg\[data-channel="info"\]\s*\{\s*color:var\(--dsw-alias-label-secondary\)/)
  assert.match(css, /\.ssh-ws-activity-entry\[data-status="running"\]/)
  assert.match(css, /\.ssh-ws-activity-switch-btn\[data-active="true"\]/)
  assert.match(css, /\.ssh-ws-activity-unread\s*\{[^}]*background:var\(--dsw-alias-brand-primary\)/)
  // No colour literals anywhere in the workspace sources (ICD §8.6), this sheet included.
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+/)
  // A scrolling transcript must not let the flex column shrink its own blocks.
  assert.match(css, /\.ssh-ws-activity-entry\s*\{[^}]*flex:0 0 auto/)
})

test('ssh.session exposes the mirror without disturbing the four frozen components', () => {
  const { SSH } = loadSources({ react: React })
  const session = SSH.require('ssh.session')

  // The frozen §8.3 set is pinned by an exact key comparison in session.test.mjs, so
  // the mirror is registered beside it rather than inside it.
  assert.deepEqual(Object.keys(session.components()).sort(), ['CommandPanel', 'FileManager', 'LogTab', 'TerminalTab'])
  const pair = session.activityComponents()
  assert.equal(typeof pair.AgentActivityPane, 'function')
  assert.equal(typeof pair.AgentActivitySwitch, 'function')
  assert.equal(session.AgentActivityPane, pair.AgentActivityPane, 'and on the module surface itself')
  assert.equal(session.AgentActivitySwitch, pair.AgentActivitySwitch)

  // The frozen interface of the module other files depend on.
  const activity = SSH.require('ssh.session.activity')
  for (const name of ['AgentActivityPane', 'AgentActivitySwitch', 'useActivitySummary', 'markActivitySeen']) {
    assert.equal(typeof activity[name], 'function', `ssh.session.activity.${name}`)
  }
  assert.equal(typeof activity.activityStore.getRecords, 'function')
  assert.equal(typeof activity.activityStore.subscribe, 'function')
  assert.equal(typeof activity.activityStore.clear, 'function')
})

test('every key the mirror asks for exists in both locales', () => {
  const zh = JSON.parse(readFileSync(join(ROOT, 'locale', 'zh.json'), 'utf8'))
  const en = JSON.parse(readFileSync(join(ROOT, 'locale', 'en.json'), 'utf8'))
  const keys = [
    'ws.activity.tab',
    'ws.activity.empty',
    'ws.activity.emptyHint',
    'ws.activity.clear',
    'ws.activity.running',
    'ws.activity.ok',
    'ws.activity.error',
    'ws.activity.timeout',
    'ws.activity.cancelled',
    'ws.activity.refused',
    'ws.activity.session',
    'ws.activity.follow',
    'ws.activity.latest',
    'ws.activity.started',
    'ws.activity.done',
    'ws.activity.exit',
    'ws.activity.duration',
    'ws.activity.truncated',
    'ws.activity.copy',
  ]
  for (const key of keys) {
    assert.equal(typeof zh[key], 'string', `zh.${key}`)
    assert.equal(typeof en[key], 'string', `en.${key}`)
    assert.notEqual(zh[key].trim(), '', `zh.${key} must not be empty`)
    assert.notEqual(en[key].trim(), '', `en.${key} must not be empty`)
  }
  // Chinese must be real Chinese, not a copy of the English string.
  for (const key of keys) assert.notEqual(zh[key], en[key], `${key} is untranslated`)
  assert.match(zh['ws.activity.tab'], /[\u4e00-\u9fff]/, 'the tab label is Chinese in zh')
})

test('the shipped artifact carries the mirror, its order and its locale keys', async () => {
  const { Script } = await import('node:vm')
  const source = readFileSync(BUNDLE_PATH, 'utf8')

  // A parse gate first: the assembler does not check syntax, and a bundle that cannot
  // parse takes the whole plugin off the live page.
  new Script(source)

  assert.match(source, /SSH\.define\('ssh\.session\.activity'/)
  // `@order 470`: after the log tab, before the workspace's integration surface.
  assert.ok(
    source.indexOf("SSH.define('ssh.session.logs'") < source.indexOf("SSH.define('ssh.session.activity'"),
    'the mirror is assembled after the log tab',
  )
  assert.ok(
    source.indexOf("SSH.define('ssh.session.activity'") < source.indexOf("SSH.define('ssh.session'"),
    'and before the module that re-exports it',
  )
  // The regenerated dictionary is inside the bundle, which is the only way the
  // browser can read `locale/*.json` (ICD §8.5).
  assert.match(source, /"ws\.activity\.tab":/)
  assert.match(source, /"ws\.activity\.emptyHint":/)

  // And the artifact still loads and applies with the module in it.
  const restore = installDom()
  try {
    const { rows, materialise } = await loadBundle({ react: React })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, '@local/dsh-ssh')
    const { exports } = materialise()
    const ctx = fakeContext({
      locale: fakeLocale(),
      slots: fakeSlots(),
      sidebarRightTabs: fakeTabRegistry(),
      remote: fakeRemoteCarrier(),
    })
    assert.doesNotThrow(() => exports.apply(ctx))
    assert.equal(typeof exports.components().SshPanelIcon, 'function')
  } finally {
    restore()
  }
})
