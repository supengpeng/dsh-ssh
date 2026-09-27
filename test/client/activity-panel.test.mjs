/**
 * §4.7 agent-activity mirror — INDEPENDENT client verification (task-3).
 *
 * The subject is the **built artifact** (`lib/client.js`, loaded through
 * `test/client/harness.mjs` `loadBundle`) driven the way the real page drives it:
 *
 *     loadBundle → materialise → apply(ctx)              ← the shipped bundle
 *       ctx.remote = a fake carrier whose `sshPlugin.followActivity` is an async
 *       generator the test pushes host frames into
 *         → the bundle's *real* bridge (`ssh.bridge`) resolves that carrier
 *         → the *real* store (`app.actions.connect`) opens a session
 *         → rendering `components().SshWorkspace` mounts the 终端 tab, whose
 *           `ssh.session.activity` pane subscribes through the real bridge
 *         → frames arrive → the pane's markup is asserted from the DOM
 *
 * Why this shape: the authors' `test/client/activity.test.mjs` loads the *sources*
 * into its own assembler registry (its own header says so), which cannot prove the
 * artifact in `lib/client.js` carries and wires the mirror. This file never touches
 * `client/src/**`; it only reads the bundle.
 *
 * What is checked:
 *   1. the frames really reach the pane: `activity-snapshot` / `begin` / `chunk` /
 *      `end` from a fake carrier produce a rendered record with the command, its
 *      stdout and its stderr in order, the running→ok transition and the exit code;
 *   2. a feed that is unavailable, that throws synchronously, or whose generator
 *      rejects leaves the pane in its empty state without an exception;
 *   3. 清除 issues exactly one zero-payload `clearActivity` unary, and a cleared
 *      record cannot come back through a later `chunk` or a reload snapshot;
 *   4. the mirror never issues exec / keystroke / transfer traffic;
 *   5. adversarial: `activity-reset` does not lose a still-running record's later
 *      `end` frame, and a `chunk` after `end` cannot corrupt the outcome the pane
 *      shows.
 *
 * Discipline: this file must be run alone
 * (`node --test --test-concurrency=1 --test-force-exit --test-timeout=60000 <file>`).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  fakeContext,
  fakeLocale,
  fakeSlots,
  fakeTabRegistry,
  installDom,
  loadBundle,
} from './harness.mjs'

// The DOM must exist *before* react-dom is evaluated (React decides once whether the
// environment supports the `input` event; the polyfill path dereferences a null
// instance under linkedom). Same ordering rule as the other client tests.
const restoreDom = installDom()
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.window.IS_REACT_ACT_ENVIRONMENT = true
globalThis.document.documentElement.setAttribute('lang', 'en')
Object.defineProperty(globalThis.document, 'oninput', { value: null, configurable: true, writable: true })

// linkedom has no layout engine: supply the geometry the terminal's fit logic reads,
// a frame clock and a ResizeObserver, so mounting the 终端 tab is not an error path.
let layoutSize = { width: 820, height: 420 }
Object.defineProperty(globalThis.window.HTMLElement.prototype, 'clientWidth', {
  configurable: true,
  get: () => layoutSize.width,
})
Object.defineProperty(globalThis.window.HTMLElement.prototype, 'clientHeight', {
  configurable: true,
  get: () => layoutSize.height,
})
if (typeof globalThis.window.requestAnimationFrame !== 'function') {
  globalThis.window.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0)
  globalThis.window.cancelAnimationFrame = (handle) => clearTimeout(handle)
}
if (typeof globalThis.window.ResizeObserver !== 'function') {
  globalThis.window.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

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

/** The session the harness carrier reports, and the panel follows. */
const SESSION = {
  id: 's_1',
  label: 'web-01',
  host: 'web-01',
  port: 22,
  user: 'deploy',
  state: 'connected',
  since: '2026-01-05T12:00:00.000Z',
  metrics: { bytesIn: 0, bytesOut: 0 },
  capabilities: { shell: true, sftp: true },
}

// Unused today (kept for the next case): `_` prefix marks it intentionally unreferenced.
const _ids = (list) => list.map((item) => item.id)

/**
 * A push-driven stand-in for the host's `FrameQueue`.
 *
 * The mirror's ingestion is synchronous, so the test decides exactly when the host
 * speaks; nothing arrives because of a timer.
 */
function frameChannel() {
  const buffer = []
  const waiters = []
  let closed = false
  return {
    push(frame) {
      const waiter = waiters.shift()
      if (waiter) waiter({ value: frame, done: false })
      else buffer.push(frame)
    },
    close() {
      closed = true
      for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true })
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          const buffered = buffer.shift()
          if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false })
          if (closed) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve) => waiters.push(resolve))
        },
      }
    },
  }
}

/**
 * The carrier the bundle's real bridge resolves.
 *
 * `sshPlugin` carries exactly the endpoints the bundle's own code needs (`ping` is
 * what the bridge verifies a carrier with), plus the §4.7 pair under test.
 */
function activityCarrier(options = {}) {
  const calls = []
  const channels = []
  const face = {
    async ping(params) {
      calls.push({ method: 'ping', params })
      return { pong: true, echo: params?.echo, version: '1.0.0', namespace: 'sshPlugin', node: 'harness' }
    },
    async describe() {
      calls.push({ method: 'describe', params: undefined })
      return { namespace: 'sshPlugin', version: '0.1.0', config: {} }
    },
    async reportSpike(params) {
      calls.push({ method: 'reportSpike', params })
      return { recorded: true, file: 'harness://client-transport.json' }
    },
    async connect(params) {
      calls.push({ method: 'connect', params })
      return { session: SESSION }
    },
    async listSessions() {
      calls.push({ method: 'listSessions', params: undefined })
      return { sessions: [SESSION], total: 1 }
    },
    async listTransfers() {
      calls.push({ method: 'listTransfers', params: undefined })
      return { transfers: [] }
    },
    async clearActivity(params) {
      calls.push({ method: 'clearActivity', params })
      return { cleared: options.clearAnswer ?? 1 }
    },
  }

  if (options.follow === 'sync-throw') {
    face.followActivity = (params) => {
      calls.push({ method: 'followActivity', params })
      throw new Error('followActivity is not wired into this carrier')
    }
  } else if (options.follow === 'fail-once-sync') {
    // A carrier that is not ready on the first attempt and works afterwards — the
    // late-mounting case the module's own header says it self-heals from.
    face.followActivity = (params) => {
      calls.push({ method: 'followActivity', params })
      if (calls.filter((call) => call.method === 'followActivity').length === 1) {
        throw new Error('followActivity is not ready yet')
      }
      const channel = frameChannel()
      channels.push(channel)
      return channel
    }
  } else if (options.follow === 'async-throw') {
    face.followActivity = (params) => {
      calls.push({ method: 'followActivity', params })
      return (async function* failing() {
        throw new Error('the feed died on its first frame')
      })()
    }
  } else if (options.follow !== false) {
    face.followActivity = (params) => {
      calls.push({ method: 'followActivity', params })
      const channel = frameChannel()
      channels.push(channel)
      return channel
    }
  }

  return { calls, channels, $mount: async () => {}, sshPlugin: face }
}

/** One record as the host half emits it (ICD §4.7 `ActivityView`). */
let nextRecordId = 0
function view(overrides = {}) {
  nextRecordId += 1
  return {
    id: `act-${nextRecordId}`,
    kind: 'exec',
    sessionId: SESSION.id,
    target: 'deploy@web-01',
    subject: 'uname -a',
    cwd: null,
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

/** Mount a component into the test document; effects and events run for real. */
async function mount(element) {
  const container = globalThis.document.createElement('div')
  globalThis.document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(element)
  })
  return {
    container,
    html: () => container.innerHTML,
    text: () => container.textContent ?? '',
    find: (selector) => container.querySelector(selector),
    findAll: (selector) => [...container.querySelectorAll(selector)],
    async flush(times = 3) {
      for (let index = 0; index < times; index += 1) {
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

/** Click through React's delegated listener (linkedom has no MouseEvent). */
async function click(node) {
  assert.ok(node, 'the click target must exist')
  await act(async () => {
    node.dispatchEvent(new globalThis.window.Event('click', { bubbles: true }))
  })
}

/**
 * Boot the shipped bundle exactly as the page does, resolve its carrier, open a
 * session in its real store, then mount the 终端 tab body.
 */
async function boot(options = {}) {
  const { rows, materialise } = await loadBundle({ react: React })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, '@local/dsh-ssh')
  const { exports } = materialise()

  const carrier = activityCarrier(options)
  const slots = fakeSlots()
  const tabs = fakeTabRegistry()
  const ctx = fakeContext({
    locale: fakeLocale(),
    slots,
    sidebarRightTabs: tabs,
    sidebarRight: { openTab() {} },
    remote: carrier,
  })
  exports.apply(ctx)

  const runtime = exports.introspect()
  assert.ok(runtime && runtime.bridge, 'the bundle published its live runtime (bridge + store)')
  // The carrier must be resolved before the pane subscribes, so the subscription
  // under test is the one this carrier answers (not a retry loop).
  const resolvedId = await runtime.resolution
  assert.equal(resolvedId, 'remote-mount', 'the bundle resolved the injected carrier')

  const session = await runtime.app.actions.connect({ profileId: 'p_harness' })
  assert.equal(session.id, SESSION.id, 'the session is open in the real store')
  assert.equal(runtime.app.store.getState().panel.view, 'session')

  const workspace = exports.components().SshWorkspace
  assert.equal(typeof workspace, 'function')
  const view0 = await mount(React.createElement(workspace))
  await view0.flush()
  return { exports, carrier, slots, tabs, ctx, runtime, view: view0 }
}

/** The host frames of one finished command, in the order the host emits them. */
function _framesOf(record, { stdout = '', stderr = '', exitCode = 0 } = {}) {
  const segments = []
  if (stdout !== '') segments.push({ channel: 'stdout', text: stdout })
  if (stderr !== '') segments.push({ channel: 'stderr', text: stderr })
  return [
    { t: 'activity-snapshot', activities: [] },
    { t: 'activity', phase: 'begin', activity: record },
    ...segments.map((segment) => ({ t: 'activity', phase: 'chunk', id: record.id, chunk: segment })),
    {
      t: 'activity',
      phase: 'end',
      activity: { ...record, status: 'ok', exitCode, endedAt: record.startedAt + 250, durationMs: 250, segments },
    },
  ]
}

test('the bundle under test is the current source (freshness probe for the evidence above)', async () => {
  // Not a behaviour test: it guards the *evidence*. These tests read only
  // `lib/client.js`; if the artifact were stale, they would be verifying a previous
  // revision of `client/src/session/activity.js`.
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = fileURLToPath(new URL('../..', import.meta.url))
  const source = readFileSync(join(root, 'client', 'src', 'session', 'activity.js'), 'utf8')
  const bundle = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

  const limitOf = (text, name) => {
    const match = new RegExp(`${name} = (\\d+)`).exec(text)
    return match ? Number(match[1]) : null
  }
  for (const name of ['RETAIN_LIMIT', 'RENDER_LIMIT', 'MAX_SEGMENTS', 'MAX_SEGMENT_CHARS', 'MAX_RECORD_CHARS']) {
    assert.equal(
      limitOf(bundle, name),
      limitOf(source, name),
      `${name} agrees between lib/client.js and client/src/session/activity.js`,
    )
  }
  assert.ok(bundle.includes("SSH.define('ssh.session.activity'"), 'the bundle carries the mirror module')

  // The artifact also names the revision it was built from; the running bundle and
  // the source must not disagree about it.
  const marker = /BUILD_MARKER = '([^']+)'/.exec(readFileSync(join(root, 'client', 'src', 'plugin.js'), 'utf8'))?.[1]
  assert.ok(marker, 'client/src/plugin.js declares a build marker')
  assert.ok(bundle.includes(marker), `lib/client.js carries the current build marker ${marker}`)
  const { materialise } = await loadBundle({ react: React })
  const { exports } = materialise()
  assert.equal(exports.describeRegistrations().buildMarker, marker)
})

// ── 3. the pane, end to end, from the built bundle ─────────────────────────

test('followActivity frames from a carrier reach the 终端 tab mirror: command, stdout, stderr, running→ok, exit code', async () => {
  const { carrier, view: page } = await boot()
  try {
    // The tab strip and the 终端 | AI 活动 switch are the built bundle's own markup.
    assert.ok(page.find('[data-testid="ssh-session-view"]'), 'the session view is mounted')
    assert.ok(page.find('[data-testid="ssh-term-switch-row"]'), 'the switch row sits inside the 终端 tab')
    const switchEl = page.find('[data-testid="ssh-ws-activity-switch"]')
    assert.ok(switchEl, 'the 终端 | AI 活动 switch is rendered')
    assert.equal(page.find('[data-testid="ssh-ws-activity"]'), null, 'the mirror is not shown while nothing happened')
    assert.equal(
      page.find('[data-testid="ssh-ws-activity-mode-terminal"]').getAttribute('data-active'),
      'true',
      'the interactive terminal is the initial face',
    )

    // The pane's subscription went through the bundle's real bridge to this carrier.
    const opened = carrier.calls.filter((call) => call.method === 'followActivity')
    assert.equal(opened.length, 1, 'exactly one feed subscription for the whole run')
    assert.equal(carrier.channels.length, 1)
    const stream = carrier.channels[0]

    const record = view({ id: 'act-live', subject: 'systemctl restart app', startedAt: Date.now() })

    // 1. The snapshot is the first frame; an empty one leaves the terminal showing.
    await act(async () => {
      stream.push({ t: 'activity-snapshot', activities: [] })
    })
    await page.flush()
    assert.equal(page.find('[data-testid="ssh-ws-activity"]'), null, 'no activity yet: the shell keeps the tab')

    // 2. A live `begin` makes the mirror the visible face (that is the point of the
    //    feature: a user watching the terminal must see the agent working).
    await act(async () => {
      stream.push({ t: 'activity', phase: 'begin', activity: record })
    })
    await page.flush()
    const pane = page.find('[data-testid="ssh-ws-activity"]')
    assert.ok(pane, 'activity switches the 终端 tab to the AI 活动 mirror')
    assert.equal(pane.getAttribute('data-session-id'), SESSION.id)
    assert.equal(pane.getAttribute('data-records'), '1')
    assert.equal(pane.getAttribute('data-running'), '1')
    assert.equal(
      page.find('[data-testid="ssh-ws-activity-mode-activity"]').getAttribute('data-active'),
      'true',
      'the switch follows the agent',
    )

    let entry = page.find('[data-activity-id="act-live"]')
    assert.ok(entry, 'the record is drawn')
    assert.equal(entry.getAttribute('data-status'), 'running')
    assert.equal(entry.getAttribute('data-kind'), 'exec')
    assert.equal(entry.querySelector('[data-testid="ssh-ws-activity-target"]').textContent, 'deploy@web-01')
    assert.equal(
      entry.querySelector('[data-testid="ssh-ws-activity-subject"]').textContent,
      '$ systemctl restart app',
      'the command the agent ran is on screen',
    )
    assert.ok(page.find('[data-testid="ssh-ws-activity-running"]'), 'the running indicator is shown')
    assert.equal(entry.querySelector('[data-testid="ssh-ws-activity-foot"]'), null, 'a running record states no facts yet')

    // 3. Live output, on both channels, in the order the host sent it.
    await act(async () => {
      stream.push({ t: 'activity', phase: 'chunk', id: record.id, chunk: { channel: 'stdout', text: 'restarting\n' } })
    })
    await page.flush()
    await act(async () => {
      stream.push({ t: 'activity', phase: 'chunk', id: record.id, chunk: { channel: 'stdout', text: 'ok\n' } })
      stream.push({ t: 'activity', phase: 'chunk', id: record.id, chunk: { channel: 'stderr', text: 'unit not found\n' } })
    })
    await page.flush()

    entry = page.find('[data-activity-id="act-live"]')
    const segments = [...entry.querySelectorAll('[data-testid="ssh-ws-activity-seg"]')]
    assert.deepEqual(
      segments.map((node) => node.getAttribute('data-channel')),
      ['stdout', 'stderr'],
      'adjacent stdout merges, the channel change opens stderr',
    )
    assert.deepEqual(
      segments.map((node) => node.textContent),
      ['restarting\nok\n', 'unit not found\n'],
      'both streams are on screen, in wire order',
    )

    // 4. The end frame: running → ok, with the exit code, and the running badge gone.
    await act(async () => {
      stream.push({
        t: 'activity',
        phase: 'end',
        activity: {
          ...record,
          status: 'ok',
          exitCode: 0,
          endedAt: record.startedAt + 250,
          durationMs: 250,
          segments: [
            { channel: 'stdout', text: 'restarting\nok\n' },
            { channel: 'stderr', text: 'unit not found\n' },
          ],
        },
      })
    })
    await page.flush()

    entry = page.find('[data-activity-id="act-live"]')
    assert.equal(entry.getAttribute('data-status'), 'ok', 'running became ok')
    assert.equal(entry.querySelector('[data-testid="ssh-ws-activity-status"]').getAttribute('data-outcome'), 'ok')
    assert.equal(page.find('[data-testid="ssh-ws-activity-running"]'), null, 'nothing runs any more')
    assert.equal(page.find('[data-testid="ssh-ws-activity"]').getAttribute('data-running'), '0')
    const foot = entry.querySelector('[data-testid="ssh-ws-activity-foot"]')
    assert.match(foot.textContent, /(^|\D)0(\D|$)/, 'the exit code is stated')
    assert.match(foot.textContent, /250 ms/, 'the duration is stated')
    assert.equal(page.find('[data-testid="ssh-ws-activity"]').getAttribute('data-records'), '1', 'one record, not two')

    // 5. The feed is global: a record for another host is drawn too, labelled with
    //    its own target rather than the visible session's.
    const other = view({ id: 'act-other', sessionId: 's_2', target: 'root@db-01', subject: 'pg_dump', status: 'ok', endedAt: 1, durationMs: 1 })
    await act(async () => {
      stream.push({ t: 'activity', phase: 'begin', activity: other })
    })
    await page.flush()
    assert.equal(page.find('[data-testid="ssh-ws-activity"]').getAttribute('data-records'), '2')
    assert.deepEqual(
      [...page.findAll('[data-testid="ssh-ws-activity-target"]')].map((node) => node.textContent),
      ['deploy@web-01', 'root@db-01'],
    )
  } finally {
    await page.unmount()
  }
})

test('a feed that is unavailable, throws, or fails mid-stream leaves the pane empty without throwing', async () => {
  const cases = [
    { label: 'the carrier has no followActivity', options: { follow: false } },
    { label: 'followActivity throws synchronously', options: { follow: 'sync-throw' } },
    { label: 'followActivity rejects on its first frame', options: { follow: 'async-throw' } },
  ]

  for (const testCase of cases) {
    const logs = []
    const originalWarn = console.warn
    const originalInfo = console.info
    console.warn = (...args) => logs.push(args.map(String).join(' '))
    console.info = (...args) => logs.push(args.map(String).join(' '))
    let page = null
    try {
      const booted = await boot(testCase.options)
      page = booted.view
      const feedEnded = () => logs.filter((line) => /the agent feed ended/.test(line)).length

      // The user reaches the mirror by choosing it (nothing has happened, so the
      // automatic switch has no reason to fire).
      await click(page.find('[data-testid="ssh-ws-activity-mode-activity"]'))
      await page.flush()

      const pane = page.find('[data-testid="ssh-ws-activity"]')
      assert.ok(pane, `${testCase.label}: the pane still renders`)
      assert.equal(pane.getAttribute('data-records'), '0', `${testCase.label}: nothing was invented`)
      assert.ok(page.find('[data-testid="ssh-ws-activity-empty"]'), `${testCase.label}: the empty state explains itself`)
      assert.equal(page.findAll('[data-testid="ssh-ws-activity-entry"]').length, 0)
      assert.doesNotThrow(() => page.text())

      // How the failure is observed on this path: the bridge turns it into an error
      // `end` frame, which the module reports (and which releases its handle). A
      // *synchronous* failure additionally names its cause — the earlier revision only
      // logged the generic `end` frame, so "this host half predates ICD §4.7" was
      // indistinguishable from a feed that died for any other reason. An asynchronous
      // failure still reports the frame alone; there the stream existed first.
      assert.ok(feedEnded() >= 1, `${testCase.label}: the feed failure was reported (logs: ${logs.join(' | ')})`)
      if (testCase.options.follow !== 'async-throw') {
        const named = logs.filter((line) => /followActivity is unavailable/.test(line))
        assert.ok(named.length >= 1, `${testCase.label}: a synchronous failure names its cause (logs: ${logs.join(' | ')})`)
        assert.ok(named.length <= 2, `${testCase.label}: the warning stays deduped, saw ${named.length}`)
      }

      // Contrast that isolates the defect below: a failure that arrives
      // *asynchronously* does release the module's handle, so the next mount retries.
      if (testCase.options.follow === 'async-throw') {
        const attempts = feedEnded()
        await page.unmount()
        page = await mount(React.createElement(booted.exports.components().SshWorkspace))
        await page.flush()
        assert.ok(feedEnded() > attempts, 'an async failure is retried on the next mount')
        await click(page.find('[data-testid="ssh-ws-activity-mode-activity"]'))
        await page.flush()
        assert.ok(page.find('[data-testid="ssh-ws-activity-empty"]'))
      }
    } finally {
      console.warn = originalWarn
      console.info = originalInfo
      if (page) await page.unmount()
    }
  }
})

test('the bridge delivers a synchronous stream failure before stream() returns — the ordering behind the defect above', async () => {
  // Independent, component-free proof of the mechanism, so the defect report does not
  // rest on inference: for a carrier whose `followActivity` is missing or throws
  // synchronously, `ssh.bridge`'s `stream()` calls back with the error `end` frame
  // during its own synchronous prefix — i.e. *before* it returns the handle. A caller
  // that assigns its handle after the call therefore resurrects an ended stream.
  const { materialise } = await loadBundle({ react: React })
  const { exports } = materialise()
  const carrier = activityCarrier({ follow: 'sync-throw' })
  const ctx = fakeContext({
    locale: fakeLocale(),
    slots: fakeSlots(),
    sidebarRightTabs: fakeTabRegistry(),
    remote: carrier,
  })
  exports.apply(ctx)
  const runtime = exports.introspect()
  await runtime.resolution

  const frames = []
  const handle = runtime.bridge.stream('followActivity', {}, (frame) => frames.push(frame))
  assert.deepEqual(
    frames.map((frame) => frame.t),
    ['end'],
    'the error end frame is delivered synchronously, inside stream()',
  )
  assert.equal(frames[0].reason, 'error')
  assert.match(String(frames[0].error && frames[0].error.message), /not a function|not wired/)
  assert.ok(handle && typeof handle === 'object', 'stream() still returns a handle for the dead stream')
  await handle.done
})

test('a feed that fails on the first attempt and works afterwards is retried, and a later mount recovers', async () => {
  // The module's own header promises self-healing: "bridge.stream may not be wired
  // yet (or at all) — the module then stays idle and the next mount retries, exactly
  // like the runtime's self-healing wiring". This scenario is exactly that promise:
  // the first `followActivity` fails synchronously (a carrier/host half that is not
  // ready yet), and the second one would work.
  //
  // Lead note (2026-09-27): this test was written to FAIL and pin a real defect —
  // `ensureConnected()` stored the handle *after* the synchronous error `end` frame had
  // already cleared it, so the dead handle was cached forever and no remount could
  // recover. The module now refuses to store a handle whose `state.error` is already
  // set (and warns once, naming the cause). The assertions below were updated to the
  // fixed contract: attempts are bounded per mount (two subscribers race for the feed
  // on the first mount — the switch's store subscription and the pane's mount effect),
  // and a later mount must reach the carrier again.
  const logs = []
  const originalInfo = console.info
  const originalWarn = console.warn
  console.info = (...args) => logs.push(args.map(String).join(' '))
  console.warn = (...args) => logs.push(args.map(String).join(' '))
  let page = null
  const callsTo = (carrier) => carrier.calls.filter((call) => call.method === 'followActivity').length
  try {
    const booted = await boot({ follow: 'fail-once-sync' })
    page = booted.view
    await click(page.find('[data-testid="ssh-ws-activity-mode-activity"]'))
    await page.flush()

    // What does hold: the pane renders, empty, and nothing threw.
    assert.ok(page.find('[data-testid="ssh-ws-activity-empty"]'))
    assert.equal(page.find('[data-testid="ssh-ws-activity"]').getAttribute('data-records'), '0')
    const firstMountAttempts = callsTo(booted.carrier)
    assert.ok(
      firstMountAttempts >= 1 && firstMountAttempts <= 2,
      `the first mount attempted the feed once per subscriber and stopped (saw ${firstMountAttempts})`,
    )
    assert.ok(
      logs.some((line) => /the agent feed ended/.test(line)),
      'the failure was reported as an error end frame',
    )
    assert.ok(
      logs.some((line) => /followActivity is unavailable/.test(line)),
      'the failure named its cause instead of caching a dead handle silently',
    )

    // The required behaviour: a later mount retries and the mirror starts following.
    await page.unmount()
    page = await mount(React.createElement(booted.exports.components().SshWorkspace))
    await page.flush()
    // …the remount really does re-render the 终端 tab (so the module's subscription
    // hook ran again) — the failure below would be a cached handle, not a missing mount.
    assert.ok(page.find('[data-testid="ssh-session-view"]'), 'the session view remounted')
    await click(page.find('[data-testid="ssh-ws-activity-mode-activity"]'))
    await page.flush()

    const afterRemount = callsTo(booted.carrier)
    assert.ok(afterRemount >= firstMountAttempts, `no attempt was lost (saw ${afterRemount})`)
    assert.ok(afterRemount <= firstMountAttempts + 2, `the retry stays bounded (saw ${afterRemount})`)

    // …and the mirror must be FOLLOWING now. This carrier fails exactly once, so the
    // recovery normally happens on the first mount's second attempt (the pane's mount
    // effect) and the remount correctly finds a live handle and adds nothing; a
    // remount that had to supply the attempt would be equally fine. What the pre-fix
    // code could not do is reach this assertion: its newest channel was the *dead* one
    // behind the cached handle, so the frames below never reached the pane.
    const channel = booted.carrier.channels.at(-1)
    assert.ok(channel, 'the recovered subscription produced a stream')
    const record = view({ id: 'act-recovered' })
    await act(async () => {
      channel.push({ t: 'activity-snapshot', activities: [] })
      channel.push({ t: 'activity', phase: 'begin', activity: record })
    })
    await page.flush()
    assert.equal(page.find('[data-testid="ssh-ws-activity"]').getAttribute('data-records'), '1')
  } finally {
    console.info = originalInfo
    console.warn = originalWarn
    if (page) await page.unmount()
  }
})

test('清除 sends one zero-payload clearActivity unary and cleared history cannot come back', async () => {
  const { carrier, view: page } = await boot({ clearAnswer: 1 })
  try {
    const stream = carrier.channels[0]
    const record = view({ id: 'act-clear', subject: 'rm -rf /srv/old' })
    await act(async () => {
      stream.push({ t: 'activity-snapshot', activities: [] })
      stream.push({ t: 'activity', phase: 'begin', activity: record })
      stream.push({ t: 'activity', phase: 'chunk', id: record.id, chunk: { channel: 'stdout', text: 'removing\n' } })
      stream.push({
        t: 'activity',
        phase: 'end',
        activity: { ...record, status: 'ok', exitCode: 0, endedAt: 2, durationMs: 1, segments: [{ channel: 'stdout', text: 'removing\n' }] },
      })
    })
    await page.flush()
    assert.equal(page.find('[data-testid="ssh-ws-activity"]').getAttribute('data-records'), '1')

    const before = carrier.calls.length
    await click(page.find('[data-testid="ssh-ws-activity-clear"]'))
    await page.flush()

    const added = carrier.calls.slice(before)
    assert.deepEqual(added.map((call) => call.method), ['clearActivity'], 'the clear asks the host exactly once')
    const arg = added[0].params
    assert.ok(
      arg === undefined || (typeof arg === 'object' && arg !== null && Object.keys(arg).length === 0),
      `clearActivity carries no payload (got ${JSON.stringify(arg)})`,
    )
    assert.equal(page.find('[data-testid="ssh-ws-activity"]').getAttribute('data-records'), '0', 'the list empties immediately')
    assert.ok(page.find('[data-testid="ssh-ws-activity-empty"]'))

    // The host confirms with its own reset frame; applying it again changes nothing.
    await act(async () => {
      stream.push({ t: 'activity-reset' })
    })
    await page.flush()
    assert.equal(page.find('[data-testid="ssh-ws-activity"]').getAttribute('data-records'), '0')

    // A chunk for a record this client no longer holds cannot resurrect it…
    await act(async () => {
      stream.push({ t: 'activity', phase: 'chunk', id: record.id, chunk: { channel: 'stdout', text: 'zombie\n' } })
    })
    await page.flush()
    assert.equal(page.findAll('[data-testid="ssh-ws-activity-entry"]').length, 0, 'a cleared record is not resurrected by a late chunk')

    // …and the reload the user would do next gets the host's own (now empty) history.
    await act(async () => {
      stream.push({ t: 'activity-snapshot', activities: [] })
    })
    await page.flush()
    assert.equal(page.find('[data-testid="ssh-ws-activity"]').getAttribute('data-records'), '0')
    assert.equal(carrier.channels.length, 1, 'clearing does not re-subscribe')
  } finally {
    await page.unmount()
  }
})

test('the mirror never issues exec, keystroke or transfer traffic', async () => {
  const { carrier, view: page } = await boot()
  try {
    const stream = carrier.channels[0]
    const record = view({ id: 'act-quiet', subject: 'df -h' })
    await act(async () => {
      stream.push({ t: 'activity-snapshot', activities: [] })
      stream.push({ t: 'activity', phase: 'begin', activity: record })
      stream.push({ t: 'activity', phase: 'chunk', id: record.id, chunk: { channel: 'stdout', text: '/dev/sda1  40G\n' } })
      stream.push({
        t: 'activity',
        phase: 'end',
        activity: { ...record, status: 'ok', exitCode: 0, endedAt: 2, durationMs: 1, segments: [{ channel: 'stdout', text: '/dev/sda1  40G\n' }] },
      })
    })
    await page.flush()

    // Interact with everything the pane offers: follow toggle (twice), copy, clear.
    await click(page.find('[data-testid="ssh-ws-activity-follow"]'))
    await click(page.find('[data-testid="ssh-ws-activity-latest"]'))
    await click(page.find('[data-testid="ssh-ws-activity-copy"]'))
    const beforeClear = carrier.calls.length
    await click(page.find('[data-testid="ssh-ws-activity-clear"]'))
    await page.flush()

    assert.deepEqual(
      carrier.calls.slice(beforeClear).map((call) => call.method),
      ['clearActivity'],
      'rendering, following, scrolling and copying are local: only 清除 talks to the host',
    )

    const forbidden = new Set([
      'exec',
      'execWait',
      'shellWrite',
      'shellSignal',
      'upload',
      'download',
      'listDir',
      'stat',
      'mkdir',
      'rename',
      'removePath',
      'chmod',
      'cancelTransfer',
    ])
    const issued = carrier.calls.filter((call) => forbidden.has(call.method))
    assert.deepEqual(issued, [], 'the mirror drove no host operation')
    assert.equal(carrier.calls.filter((call) => call.method === 'shellWrite').length, 0, 'the pane typed nothing')
  } finally {
    await page.unmount()
  }
})

test('activity-reset does not lose a running record, and a chunk after end cannot corrupt its outcome', async () => {
  const { carrier, view: page } = await boot()
  try {
    const stream = carrier.channels[0]
    const record = view({ id: 'act-running', subject: 'tail -f /var/log/app.log' })
    await act(async () => {
      stream.push({ t: 'activity-snapshot', activities: [] })
      stream.push({ t: 'activity', phase: 'begin', activity: record })
      stream.push({ t: 'activity', phase: 'chunk', id: record.id, chunk: { channel: 'stdout', text: 'line 1\n' } })
    })
    await page.flush()
    assert.equal(page.find('[data-testid="ssh-ws-activity"]').getAttribute('data-running'), '1')

    // The host cleared finished records while this one was still running. The reset
    // frame carries no detail, so the client drops its local list…
    await act(async () => {
      stream.push({ t: 'activity-reset' })
    })
    await page.flush()
    assert.equal(page.find('[data-testid="ssh-ws-activity"]').getAttribute('data-records'), '0')

    // …but the still-running record's own `end` frame is not lost: it re-creates the
    // record complete, because the host's end frame carries the whole transcript.
    await act(async () => {
      stream.push({
        t: 'activity',
        phase: 'end',
        activity: {
          ...record,
          status: 'ok',
          exitCode: 0,
          endedAt: record.startedAt + 900,
          durationMs: 900,
          segments: [{ channel: 'stdout', text: 'line 1\nline 2\n' }],
        },
      })
    })
    await page.flush()
    const entry = page.find('[data-activity-id="act-running"]')
    assert.ok(entry, 'the end frame rebuilt the record after the reset')
    assert.equal(entry.getAttribute('data-status'), 'ok')
    assert.match(entry.querySelector('[data-testid="ssh-ws-activity-seg"]').textContent, /line 1\nline 2/)
    assert.equal(page.find('[data-testid="ssh-ws-activity"]').getAttribute('data-records'), '1')

    // Adversarial: a chunk after `end` (which the host's sealed ring cannot emit —
    // `lib/activity/feed.js` `appendChunk` returns early once `endedAt !== null`)
    // must not be able to rewrite the outcome the user was shown.
    await act(async () => {
      stream.push({ t: 'activity', phase: 'chunk', id: record.id, chunk: { channel: 'stdout', text: 'LATE TEXT\n' } })
    })
    await page.flush()
    const after = page.find('[data-activity-id="act-running"]')
    assert.equal(after.getAttribute('data-status'), 'ok', 'the outcome is untouched')
    assert.equal(after.querySelector('[data-testid="ssh-ws-activity-status"]').getAttribute('data-outcome'), 'ok')
    assert.equal(page.find('[data-testid="ssh-ws-activity"]').getAttribute('data-records'), '1', 'still one record')
    const foot = after.querySelector('[data-testid="ssh-ws-activity-foot"]')
    assert.match(foot.textContent, /(^|\D)0(\D|$)/, 'the exit code is untouched')
    const text = after.textContent ?? ''
    assert.ok(text.includes('line 1\nline 2'), 'the transcript the end frame carried is still shown')
    // Reported as an observation, not asserted as desirable: because the client has no
    // "sealed record" guard either, that late frame's text is *appended* to the
    // finished transcript (the outcome above is unaffected). The host never emits it.
  } finally {
    await page.unmount()
  }
})
