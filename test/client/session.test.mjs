/**
 * Session workspace component tests (terminal / command / files / logs).
 *
 * These run the real component sources against a DOM, a real React root and a fake
 * SSH carrier, so what is asserted is the behaviour a user gets: frames arrive and
 * appear on screen, `↑` walks the command history, a delete asks before it deletes,
 * a transfer at 50% renders 50%, and no audit entry can smuggle a credential into
 * the log view.
 *
 * **Loader note.** The shared harness (`test/client/harness.mjs`) loads the *built*
 * `lib/client.js`. While another module of the bundle is mid-edit this file loads
 * the sources instead (same `SSH.define/require` registry, same factory contract),
 * which keeps this suite a property of the session workspace rather than of
 * whatever the tree happens to look like at the moment. `test/client/bundle.test.mjs`
 * owns the "the artifact is loadable and complete" assertion.
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { installDom } from './harness.mjs'

// The DOM must exist *before* react-dom is evaluated: React decides once whether
// the environment supports the `input` event, and without a document it installs a
// legacy polyfill whose keydown handler dereferences a null instance in linkedom
// (`getNodeFromInstance(null)`). Loading the DOM first, and advertising `oninput`,
// is what makes real keyboard interaction testable here.
const restoreDom = installDom()
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.window.IS_REACT_ACT_ENVIRONMENT = true
// Pin the UI language so dictionary-backed labels are deterministic.
globalThis.document.documentElement.setAttribute('lang', 'en')
// `isEventSupported('input')` asks whether `oninput` exists on the document; linkedom
// does not define it, which would select the polyfill path.
Object.defineProperty(globalThis.document, 'oninput', { value: null, configurable: true, writable: true })

/**
 * Inject a container size.
 *
 * linkedom has no layout engine, so every element measures 0×0 and the terminal's
 * "never fit into a zero-sized box" guard (which is what removed `rows: 1` and the xterm
 * `dimensions` crash) would skip sizing forever. The geometry is therefore supplied by
 * the harness: the *decision* is unit-tested against `ssh.session.fit.planFit`, and these
 * numbers stand in for a laid-out container. Set `layoutSize` to zeros to assert the
 * negative case.
 */
let layoutSize = { width: 820, height: 420 }
Object.defineProperty(globalThis.window.HTMLElement.prototype, 'clientWidth', {
  configurable: true,
  get() {
    return layoutSize.width
  },
})
Object.defineProperty(globalThis.window.HTMLElement.prototype, 'clientHeight', {
  configurable: true,
  get() {
    return layoutSize.height
  },
})
// The terminal defers its first fit to the next frame.
if (typeof globalThis.window.requestAnimationFrame !== 'function') {
  globalThis.window.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0)
  globalThis.window.cancelAnimationFrame = (handle) => clearTimeout(handle)
}
if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = globalThis.window.requestAnimationFrame
  globalThis.cancelAnimationFrame = globalThis.window.cancelAnimationFrame
}

const React = await import('react')
const { act } = React
const { createRoot } = await import('react-dom/client')
const { renderToStaticMarkup } = await import('react-dom/server')

process.on('exit', () => {
  try {
    restoreDom()
  } catch {
    /* nothing left to restore */
  }
})

/** Kept as a no-op so every test can end with the same shape. */
function restore() {
  try {
    globalThis.window.localStorage.clear()
  } catch {
    /* ignore */
  }
}

const SRC_DIR = fileURLToPath(new URL('../../client/src', import.meta.url))

/**
 * The dependency set of the session workspace: its own modules, the vendored
 * emulator, and the two shared roots it requires (`ssh.core` for the primitive
 * set, `ssh.bridge` for the transport). Loading exactly this set keeps the suite a
 * property of the workspace - `test/client/bundle.test.mjs` owns whole-artifact
 * verification, including files this workspace never touches.
 */
const WORKSPACE_SOURCES = [
  /client[\\/]src[\\/]session[\\/]/,
  /client[\\/]src[\\/]vendor[\\/]/,
  /client[\\/]src[\\/]core\.js$/,
  /client[\\/]src[\\/]bridge\.js$/,
]

function isWorkspaceSource(file) {
  return WORKSPACE_SOURCES.some((pattern) => pattern.test(file))
}

/** Collect client sources in assembler order (@order, then path). */
function collectSources(dir, filter = () => true) {
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

/**
 * Materialise the client sources into the assembler's own `SSH` registry.
 * @param {{react: unknown, files?: string[]}} options
 */
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
  const files = options.files ?? collectSources(SRC_DIR, isWorkspaceSource)
  for (const file of files) {
    // Same contract the assembler enforces: each file must compile on its own.
    new Function('SSH', readFileSync(file, 'utf8'))(SSH)
  }
  // Extra modules a test wants in the registry (e.g. a stub for a seat another
  // agent owns), registered exactly like a bundle source would be.
  for (const [name, factory] of Object.entries(options.extras ?? {})) {
    SSH.define(name, factory)
  }
  return { SSH, styles, files }
}

/** Boot a fresh module tree against the already-installed DOM. */
function boot(options = {}) {
  const { SSH } = loadSources({ react: React, extras: options.extras })
  return { restore, SSH, session: SSH.require('ssh.session') }
}

/** A carrier whose shell/exec/files/audit methods answer like the host half. */
function fakeSshCarrier(options = {}) {
  const calls = []
  const terminalFrames = options.terminalFrames ?? []
  const execFrames = options.execFrames ?? []
  const face = {
    async ping(params) {
      calls.push({ method: 'ping', params })
      return { pong: true, echo: params?.echo, version: '1.0.0', namespace: 'sshPlugin' }
    },
    async *openShell(params) {
      calls.push({ method: 'openShell', params })
      const streamId = params?.streamId ?? 'st_shell_1'
      yield { t: 'open', streamId, kind: 'shell', meta: {} }
      let seq = 0
      for (const chunk of terminalFrames) {
        yield { t: 'data', streamId, seq: seq++, chunk, encoding: 'utf8', channel: 'term' }
      }
      if (options.shellFails) {
        yield { t: 'end', streamId, reason: 'error', error: { code: 'SSH_NET_RESET', message: 'link dropped', retryable: true } }
        return
      }
      yield { t: 'exit', streamId, exitCode: 0, durationMs: 12, timedOut: false }
      yield { t: 'end', streamId, reason: 'completed' }
    },
    async *exec(params) {
      calls.push({ method: 'exec', params })
      const streamId = 'st_exec_1'
      yield { t: 'open', streamId, kind: 'exec', meta: {} }
      let seq = 0
      for (const frame of execFrames) {
        yield { t: 'data', streamId, seq: seq++, chunk: frame.chunk, encoding: 'utf8', channel: frame.channel }
      }
      yield { t: 'exit', streamId, exitCode: params?.exitCode ?? 0, durationMs: 5, timedOut: false }
      yield { t: 'end', streamId, reason: 'completed' }
    },
    async shellWrite(params) {
      calls.push({ method: 'shellWrite', params })
      return { written: String(params.data ?? '').length }
    },
    async shellResize(params) {
      calls.push({ method: 'shellResize', params })
      return { resized: true }
    },
    async listDir(params) {
      calls.push({ method: 'listDir', params })
      return { entries: options.remoteEntries ?? [], cwd: params.path }
    },
    async listLocalDir(params) {
      calls.push({ method: 'listLocalDir', params })
      return { entries: options.localEntries ?? [], cwd: params.path }
    },
    async queryAudit(params) {
      calls.push({ method: 'queryAudit', params })
      return { entries: options.auditEntries ?? [], total: (options.auditEntries ?? []).length }
    },
    async clearAudit() {
      calls.push({ method: 'clearAudit', params: {} })
      return { cleared: 1 }
    },
  }
  return { calls, $mount: async () => {}, sshPlugin: face }
}

/** Mount a component and return DOM helpers. */
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

/**
 * Event helpers.
 *
 * Every dispatch goes through `act()`: React batches the state updates a handler
 * produces, and reading the DOM before that flush either sees a stale value or, for
 * a handler that walks a cursor (the command history), sees it advanced twice.
 */
function click(element) {
  assert.ok(element, 'click target must exist')
  act(() => {
    element.dispatchEvent(new globalThis.window.Event('click', { bubbles: true }))
  })
}

function keyDown(element, key, extra = {}) {
  assert.ok(element, 'keydown target must exist')
  const event = new globalThis.window.Event('keydown', { bubbles: true })
  event.key = key
  Object.assign(event, extra)
  act(() => {
    element.dispatchEvent(event)
  })
  return event
}

/**
 * Type into a controlled input.
 *
 * The value has to go through the prototype setter: React caches the last value it
 * saw, and a plain `input.value = x` assignment updates the DOM without telling
 * React anything changed.
 */
function typeInto(element, value) {
  assert.ok(element, 'typing target must exist')
  const descriptor = Object.getOwnPropertyDescriptor(globalThis.window.HTMLInputElement.prototype, 'value')
  act(() => {
    if (descriptor && descriptor.set) descriptor.set.call(element, value)
    else element.value = value
    element.dispatchEvent(new globalThis.window.Event('input', { bubbles: true }))
  })
}

async function waitFor(predicate, label = 'condition', timeoutMs = 2000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

// ── the integration surface ────────────────────────────────────────────────

test('ssh.session exposes the four frozen components', () => {
  const { restore, session } = boot()
  try {
    const components = session.components()
    assert.deepEqual(Object.keys(components).sort(), ['CommandPanel', 'FileManager', 'LogTab', 'TerminalTab'])
    for (const [name, component] of Object.entries(components)) {
      assert.equal(typeof component, 'function', `${name} is a function of props`)
    }
    assert.deepEqual(session.TAB_IDS, ['terminal', 'command', 'files', 'logs'])
  } finally {
    restore()
  }
})

test('the workspace stylesheet has no hardcoded colour', () => {
  const { restore } = boot()
  try {
    const files = collectSources(join(SRC_DIR, 'session'))
    assert.ok(files.length >= 8, 'the session workspace ships several modules')
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      const offenders = text.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+[^)]*\)/g) ?? []
      assert.deepEqual(offenders, [], `${file} must use --dsw-* tokens only`)
    }
  } finally {
    restore()
  }
})

test('the shipped bundle carries the session workspace and still loads', async () => {
  const { Script } = await import('node:vm')
  const { loadBundle } = await import('./harness.mjs')
  const bundlePath = fileURLToPath(new URL('../../lib/client.js', import.meta.url))
  const source = readFileSync(bundlePath, 'utf8')

  // A parse gate first: the assembler does not check syntax, and a bundle that
  // cannot parse takes the whole plugin off the live page.
  new Script(source)

  const modules = [
    'ssh.vendor.xterm',
    'ssh.vendor.fit',
    'ssh.vendor.xterm.css',
    'ssh.session.styles',
    'ssh.session.ui',
    'ssh.session.vt',
    'ssh.session.runtime',
    'ssh.session.term',
    'ssh.session.terminal',
    'ssh.session.command',
    'ssh.session.files',
    'ssh.session.logs',
    'ssh.session',
  ]
  for (const name of modules) {
    assert.ok(source.includes(`SSH.define('${name}'`), `${name} is registered in lib/client.js`)
  }
  // Vendor code must be defined before the modules that require it, which is what
  // the @order annotation buys.
  assert.ok(
    source.indexOf("SSH.define('ssh.vendor.xterm'") < source.indexOf("SSH.define('ssh.session.terminal'"),
    'the vendored emulator is defined before the terminal module',
  )

  // And the artifact materialises through the shared harness: one package row with
  // the plugin entry points DSH expects.
  const { rows, materialise } = await loadBundle({ react: React })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, '@local/dsh-ssh')
  const { exports } = materialise()
  assert.equal(typeof exports.apply, 'function')
  assert.equal(typeof exports.components, 'function')
})

// ── terminal ───────────────────────────────────────────────────────────────

test('TerminalTab without a stream explains itself instead of rendering an empty box', async () => {
  const { restore, session } = boot()
  const view = await mount(React.createElement(session.components().TerminalTab, { sessionId: 's_1', streamId: null }))
  try {
    assert.match(view.html(), /data-testid="ssh-ws-terminal"/)
    assert.match(view.html(), /data-testid="ssh-ws-term-empty"/)
    assert.equal(view.find('[data-testid="ssh-ws-term-screen"]'), null, 'no screen without a stream')
  } finally {
    await view.unmount()
    restore()
  }
})

test('the terminal streams frames from a fake bridge and paints them', async () => {
  const { restore, session, SSH } = boot()
  const term = SSH.require('ssh.session.term')
  term.configureHost({ mode: 'fallback' })
  const runtime = SSH.require('ssh.session.runtime')
  const carrier = fakeSshCarrier({ terminalFrames: ['uname -a\r\n', 'Linux target 6.1.0-13-amd64 #1 SMP x86_64 GNU/Linux\r\n'] })
  runtime.configure({ bridge: SSH.require('ssh.bridge').createBridge({ get: (name) => (name === 'remote' ? carrier : undefined) }), app: null })

  const stream = runtime.actions.openShell({ sessionId: 's_1', cols: 80, rows: 24 })
  await waitFor(() => runtime.getStream(stream.localId)?.end, 'the shell stream to finish')
  const streamId = runtime.getStream(stream.localId).streamId

  const view = await mount(React.createElement(session.components().TerminalTab, { sessionId: 's_1', streamId }))
  try {
    await view.flush(4)
    const text = view.find('[data-testid="ssh-ws-term-screen"]').textContent
    assert.match(text, /uname -a/)
    assert.match(text, /Linux target 6\.1\.0-13-amd64/)
    assert.fail && assert.ok(true)
  } finally {
    await view.unmount()
    restore()
  }
})

test('a full-screen application redraws in place (top-style)', async () => {
  const { restore, session, SSH } = boot()
  SSH.require('ssh.session.term').configureHost({ mode: 'fallback' })
  const runtime = SSH.require('ssh.session.runtime')
  const first = '\x1b[2J\x1b[Htop - 12:00:00 up 3 days\r\nTasks: 120 total\r\n%Cpu(s): 3.2 us'
  const second = '\x1b[2;1H\x1b[KTasks: 137 total'
  const carrier = fakeSshCarrier({ terminalFrames: [first, second] })
  runtime.configure({ bridge: SSH.require('ssh.bridge').createBridge({ get: (name) => (name === 'remote' ? carrier : undefined) }), app: null })
  const stream = runtime.actions.openShell({ sessionId: 's_1', cols: 80, rows: 24 })
  await waitFor(() => runtime.getStream(stream.localId)?.end, 'stream end')
  const streamId = runtime.getStream(stream.localId).streamId

  const view = await mount(React.createElement(session.components().TerminalTab, { sessionId: 's_1', streamId }))
  try {
    await view.flush(4)
    const rows = view.findAll('[data-testid="ssh-ws-term-screen"] [data-row]').map((row) => row.textContent)
    assert.equal(rows[0], 'top - 12:00:00 up 3 days')
    assert.equal(rows[1], 'Tasks: 137 total', 'the in-place redraw replaced the old value')
    assert.equal(rows[2], '%Cpu(s): 3.2 us')
    assert.equal(rows.filter((row) => row.includes('Tasks: 120')).length, 0, 'the stale line is gone')
  } finally {
    await view.unmount()
    restore()
  }
})

test('typing in the terminal reaches the host as shellWrite', async () => {
  const { restore, session, SSH } = boot()
  SSH.require('ssh.session.term').configureHost({ mode: 'fallback' })
  const runtime = SSH.require('ssh.session.runtime')
  const carrier = fakeSshCarrier({ terminalFrames: ['$ '] })
  runtime.configure({ bridge: SSH.require('ssh.bridge').createBridge({ get: (name) => (name === 'remote' ? carrier : undefined) }), app: null })
  const stream = runtime.actions.openShell({ sessionId: 's_1', cols: 80, rows: 24 })
  await waitFor(() => runtime.getStream(stream.localId)?.end, 'stream end')
  const streamId = runtime.getStream(stream.localId).streamId

  const view = await mount(React.createElement(session.components().TerminalTab, { sessionId: 's_1', streamId }))
  try {
    await view.flush(3)
    const termArea = view.find('[data-testid="ssh-ws-terminal"] .ssh-ws-term')
    keyDown(termArea, 'l')
    keyDown(termArea, 's')
    keyDown(termArea, 'Enter')
    await view.flush(2)
    const writes = carrier.calls.filter((call) => call.method === 'shellWrite')
    assert.equal(writes.length, 3, 'each keystroke is one shellWrite')
    assert.deepEqual(writes.map((call) => call.params.data), ['l', 's', '\r'])
    assert.equal(writes[0].params.streamId, streamId)
  } finally {
    await view.unmount()
    restore()
  }
})

test('font zoom honours onFontSizeChange, the toolbar and the Cmd/Ctrl shortcuts', async () => {
  const { restore, session, SSH } = boot()
  SSH.require('ssh.session.term').configureHost({ mode: 'fallback' })
  const runtime = SSH.require('ssh.session.runtime')
  const carrier = fakeSshCarrier({ terminalFrames: ['$ '] })
  runtime.configure({ bridge: SSH.require('ssh.bridge').createBridge({ get: (name) => (name === 'remote' ? carrier : undefined) }), app: null })
  const stream = runtime.actions.openShell({ sessionId: 's_1', cols: 80, rows: 24 })
  await waitFor(() => runtime.getStream(stream.localId)?.end, 'stream end')
  const streamId = runtime.getStream(stream.localId).streamId

  const changes = []
  const view = await mount(
    React.createElement(session.components().TerminalTab, {
      sessionId: 's_1',
      streamId,
      fontSize: 13,
      onFontSizeChange: (size) => changes.push(size),
    }),
  )
  try {
    await view.flush(2)
    click(view.find('[data-testid="ssh-ws-term-font-up"]'))
    click(view.find('[data-testid="ssh-ws-term-font-down"]'))
    const termArea = view.find('[data-testid="ssh-ws-terminal"] .ssh-ws-term')
    assert.ok(termArea, 'the terminal area renders once a stream exists')
    keyDown(termArea, '=', { ctrlKey: true })
    keyDown(termArea, '-', { ctrlKey: true })
    assert.deepEqual(changes, [14, 12, 14, 12])
    // The zoom shortcut must not be typed into the remote shell.
    assert.equal(carrier.calls.filter((call) => call.method === 'shellWrite').length, 0)
  } finally {
    await view.unmount()
    restore()
  }
})

// ── command panel ──────────────────────────────────────────────────────────

test('command history: ↑ walks back through the list, ↓ returns to the draft', async () => {
  const { restore, session } = boot()
  const history = ['ls -la', 'uname -a', 'uptime']
  const view = await mount(
    React.createElement(session.components().CommandPanel, {
      sessionId: 's_1',
      history,
      running: false,
      result: null,
      onRun: () => {},
      onClear: () => {},
      onCancel: () => {},
    }),
  )
  try {
    const input = view.find('[data-testid="ssh-ws-cmd-input"]')
    assert.ok(input, 'the command input renders')
    keyDown(input, 'ArrowUp')
    await view.flush(1)
    assert.equal(input.value, 'uptime', '↑ starts at the newest entry')
    keyDown(input, 'ArrowUp')
    await view.flush(1)
    assert.equal(input.value, 'uname -a')
    keyDown(input, 'ArrowUp')
    await view.flush(1)
    assert.equal(input.value, 'ls -la')
    keyDown(input, 'ArrowUp')
    await view.flush(1)
    assert.equal(input.value, 'ls -la', 'the oldest entry is a wall')
    keyDown(input, 'ArrowDown')
    keyDown(input, 'ArrowDown')
    await view.flush(1)
    assert.equal(input.value, 'uptime')
    keyDown(input, 'ArrowDown')
    await view.flush(1)
    assert.equal(input.value, '', '↓ past the newest restores the (empty) draft')
  } finally {
    await view.unmount()
    restore()
  }
})

test('CommandPanel runs on Enter and cancels a running command with Ctrl+C', async () => {
  const { restore, session } = boot()
  const ran = []
  let cancelled = 0
  const view = await mount(
    React.createElement(session.components().CommandPanel, {
      sessionId: 's_1',
      history: [],
      running: false,
      onRun: (command) => ran.push(command),
      onCancel: () => {
        cancelled += 1
      },
    }),
  )
  try {
    const input = view.find('[data-testid="ssh-ws-cmd-input"]')
    keyDown(input, 'Enter')
    await view.flush(1)
    assert.deepEqual(ran, [], 'an empty command must not run')

    typeInto(input, 'uname -a')
    await view.flush(1)
    assert.equal(input.value, 'uname -a', 'the field is controlled')
    keyDown(input, 'Enter')
    await view.flush(1)
    assert.deepEqual(ran, ['uname -a'], 'Enter runs the typed command')
    assert.equal(input.value, '', 'the field is cleared for the next command')
    await view.unmount()

    const runningView = await mount(
      React.createElement(session.components().CommandPanel, {
        sessionId: 's_1',
        history: [],
        running: true,
        onRun: (command) => ran.push(command),
        onCancel: () => {
          cancelled += 1
        },
      }),
    )
    try {
      click(runningView.find('[data-testid="ssh-ws-cmd-cancel"]'))
      assert.equal(cancelled, 1)
      assert.equal(runningView.find('[data-testid="ssh-ws-cmd-run"]'), null, 'Run is replaced by Cancel while running')
      keyDown(runningView.find('[data-testid="ssh-ws-cmd-input"]'), 'c', { ctrlKey: true })
      assert.equal(cancelled, 2, 'Ctrl+C cancels a running command')
    } finally {
      await runningView.unmount()
    }
  } finally {
    restore()
  }
})

test('CommandPanel renders stdout, stderr, exit code, duration and truncation', () => {
  const { restore, session } = boot()
  try {
    const html = renderToStaticMarkup(
      React.createElement(session.components().CommandPanel, {
        sessionId: 's_1',
        history: [],
        running: false,
        result: {
          stdout: 'Linux target 6.1.0\n',
          stderr: 'bash: nope: command not found\n',
          exitCode: 127,
          durationMs: 42,
          truncated: { stdout: true, stderr: false },
          streamId: 'st_exec_1',
        },
        onRun: () => {},
        onClear: () => {},
        onCancel: () => {},
      }),
    )
    assert.match(html, /data-testid="ssh-ws-cmd-stdout"/)
    assert.match(html, /data-testid="ssh-ws-cmd-stderr"/)
    assert.match(html, /data-testid="ssh-ws-cmd-exit"[^>]*>exit 127/)
    assert.match(html, /42 ms/)
    assert.match(html, /data-testid="ssh-ws-cmd-truncated"/)
  } finally {
    restore()
  }
})

// ── file manager ───────────────────────────────────────────────────────────

const LOCAL_ENTRIES = [
  { name: '..', path: '/local/..', type: 'dir', size: 0, mode: '0755', mtime: '2026-01-01T00:00:00.000Z' },
  { name: 'build.log', path: '/local/build.log', type: 'file', size: 2048, mode: '0644', mtime: '2026-01-02T10:00:00.000Z' },
  { name: 'payload.bin', path: '/local/payload.bin', type: 'file', size: 104857600, mode: '0644', mtime: '2026-01-03T10:00:00.000Z' },
]
const REMOTE_ENTRIES = [
  { name: 'etc', path: '/srv/etc', type: 'dir', size: 4096, mode: '0755', mtime: '2026-01-01T00:00:00.000Z' },
  { name: 'payload.bin', path: '/srv/payload.bin', type: 'file', size: 104857600, mode: '0644', mtime: '2026-01-03T10:00:00.000Z' },
  { name: 'link', path: '/srv/link', type: 'symlink', size: 0, mode: '0777', mtime: '2026-01-04T00:00:00.000Z', isSymlink: true },
]

test('FileManager renders both panes with the local and remote listings', () => {
  const { restore, session } = boot()
  try {
    const html = renderToStaticMarkup(
      React.createElement(session.components().FileManager, {
        sessionId: 's_1',
        localRoot: '/local',
        remoteRoot: '/srv',
        localEntries: LOCAL_ENTRIES,
        remoteEntries: REMOTE_ENTRIES,
        transfers: [],
        loadingByPane: { local: false, remote: false },
      }),
    )
    assert.match(html, /data-testid="ssh-ws-pane-local"/)
    assert.match(html, /data-testid="ssh-ws-pane-remote"/)
    assert.match(html, /payload\.bin/)
    assert.match(html, /data-testid="ssh-ws-entry-remote-etc"/)
    assert.match(html, /data-testid="ssh-ws-crumbs-remote"/)
  } finally {
    restore()
  }
})

test('transfer progress renders 0%, 50% and 100%', () => {
  const { restore, session } = boot()
  try {
    const transfers = [
      { opId: 'op_0', direction: 'upload', localPath: '/local/a.bin', remotePath: '/srv/a.bin', transferred: 0, totalBytes: 1000, bytesPerSec: 0, phase: 'transfer', status: 'running' },
      { opId: 'op_50', direction: 'upload', localPath: '/local/b.bin', remotePath: '/srv/b.bin', transferred: 500, totalBytes: 1000, bytesPerSec: 512, etaMs: 1000, phase: 'transfer', status: 'running' },
      { opId: 'op_100', direction: 'download', localPath: '/local/c.bin', remotePath: '/srv/c.bin', transferred: 1000, totalBytes: 1000, bytesPerSec: 2048, phase: 'finalize', status: 'done' },
    ]
    const html = renderToStaticMarkup(
      React.createElement(session.components().FileManager, {
        sessionId: 's_1',
        localRoot: '/local',
        remoteRoot: '/srv',
        localEntries: LOCAL_ENTRIES,
        remoteEntries: REMOTE_ENTRIES,
        transfers,
      }),
    )
    assert.match(html, /data-testid="ssh-ws-transfer-op_0"/)
    assert.match(html, /data-testid="ssh-ws-transfer-op_50"/)
    assert.match(html, /data-testid="ssh-ws-transfer-op_100"/)
    assert.match(html, /data-percent="0"/)
    assert.match(html, /data-percent="50"/)
    assert.match(html, /data-percent="100"/)
    assert.match(html, /data-status="done"/)
    assert.match(html, /512 B\/s/)
  } finally {
    restore()
  }
})

test('the progress element reports a determinate bar with an unknown total', () => {
  const { restore, SSH } = boot()
  try {
    const ui = SSH.require('ssh.session.ui')
    const Progress = ui.ui().Progress
    const indeterminate = renderToStaticMarkup(React.createElement(Progress, { value: 10, total: undefined, indeterminate: true, status: 'running' }))
    assert.match(indeterminate, /data-percent="indeterminate"/)
    const zero = renderToStaticMarkup(React.createElement(Progress, { value: 0, total: 100, status: 'running' }))
    assert.match(zero, /data-percent="0"/)
    assert.match(zero, /width:0%/)
    const half = renderToStaticMarkup(React.createElement(Progress, { value: 50, total: 100, status: 'running' }))
    assert.match(half, /width:50%/)
    const full = renderToStaticMarkup(React.createElement(Progress, { value: 100, total: 100, status: 'done' }))
    assert.match(full, /data-percent="100"/)
    assert.match(full, /width:100%/)
  } finally {
    restore()
  }
})

test('delete asks for confirmation first and passes the recursive flag for directories', async () => {
  const { restore, session } = boot()
  const deleted = []
  const view = await mount(
    React.createElement(session.components().FileManager, {
      sessionId: 's_1',
      localRoot: '/local',
      remoteRoot: '/srv',
      localEntries: LOCAL_ENTRIES,
      remoteEntries: REMOTE_ENTRIES,
      transfers: [],
      onDelete: (pane, path, options) => deleted.push({ pane, path, options }),
    }),
  )
  try {
    // A file deletes after a plain confirmation.
    click(view.find('[data-testid="ssh-ws-entry-remote-payload.bin"]'))
    await view.flush(1)
    click(view.find('[data-testid="ssh-ws-files-delete"]'))
    await view.flush(1)
    assert.match(view.html(), /data-testid="ssh-ws-dialog-delete"/, 'a delete opens a dialog')
    assert.deepEqual(deleted, [], 'nothing is deleted before confirmation')
    const confirmOk = view.find('[data-testid="ssh-ws-confirm-ok"]')
    assert.equal(confirmOk.hasAttribute('disabled'), false, 'a file needs no typed confirmation')
    click(confirmOk)
    await view.flush(1)
    assert.deepEqual(deleted, [{ pane: 'remote', path: '/srv/payload.bin', options: { recursive: false } }])

    // A directory additionally requires typing its name (ICD §8.3 requireType).
    click(view.find('[data-testid="ssh-ws-entry-remote-etc"]'))
    await view.flush(1)
    click(view.find('[data-testid="ssh-ws-files-delete"]'))
    await view.flush(1)
    assert.match(view.html(), /data-testid="ssh-ws-dialog-delete"/)
    const typedConfirm = view.find('[data-testid="ssh-ws-confirm-ok"]')
    assert.ok(typedConfirm.hasAttribute('disabled'), 'the confirm button stays disabled until the name is typed')
    click(typedConfirm)
    await view.flush(1)
    assert.equal(deleted.length, 1, 'clicking a disabled confirm deletes nothing')
    const typeInput = view.find('[data-testid="ssh-ws-confirm-type"]')
    assert.ok(typeInput, 'the typed-confirmation field is rendered for a directory')
    typeInto(typeInput, 'etc')
    await view.flush(1)
    click(view.find('[data-testid="ssh-ws-confirm-ok"]'))
    await view.flush(1)
    assert.deepEqual(deleted[1], { pane: 'remote', path: '/srv/etc', options: { recursive: true } })
  } finally {
    await view.unmount()
    restore()
  }
})

test('dangerous operations fail closed when nothing can confirm them', async () => {
  const { restore, SSH } = boot()
  try {
    const runtime = SSH.require('ssh.session.runtime')
    runtime.setConfirmHandler(null)
    const allowed = await runtime.requestConfirm({ kind: 'delete', path: '/srv/etc' })
    assert.equal(allowed, false, 'an unwired confirmation must not authorise a delete')
  } finally {
    restore()
  }
})

test('uploading over an existing file asks about the overwrite', async () => {
  const { restore, session } = boot()
  const uploaded = []
  const view = await mount(
    React.createElement(session.components().FileManager, {
      sessionId: 's_1',
      localRoot: '/local',
      remoteRoot: '/srv',
      localEntries: LOCAL_ENTRIES,
      remoteEntries: REMOTE_ENTRIES,
      transfers: [],
      onUpload: (localPath, remotePath, options) => uploaded.push({ localPath, remotePath, options }),
    }),
  )
  try {
    click(view.find('[data-testid="ssh-ws-entry-local-payload.bin"]'))
    await view.flush(1)
    click(view.find('[data-testid="ssh-ws-files-upload"]'))
    await view.flush(1)
    assert.match(view.html(), /data-testid="ssh-ws-dialog-overwrite"/)
    assert.deepEqual(uploaded, [], 'the transfer waits for the answer')
    click(view.find('[data-testid="ssh-ws-confirm-ok"]'))
    await view.flush(1)
    assert.deepEqual(uploaded, [{ localPath: '/local/payload.bin', remotePath: '/srv/payload.bin', options: { overwrite: true } }])
  } finally {
    await view.unmount()
    restore()
  }
})

test('a rename asks for the new name and reports the target path', async () => {
  const { restore, session, SSH } = boot()
  const renamed = []
  const view = await mount(
    React.createElement(session.components().FileManager, {
      sessionId: 's_1',
      localRoot: '/local',
      remoteRoot: '/srv',
      localEntries: LOCAL_ENTRIES,
      remoteEntries: REMOTE_ENTRIES,
      transfers: [],
      onRename: (pane, from, to) => renamed.push({ pane, from, to }),
    }),
  )
  try {
    click(view.find('[data-testid="ssh-ws-entry-local-build.log"]'))
    await view.flush(1)
    click(view.find('[data-testid="ssh-ws-files-rename"]'))
    await view.flush(1)
    const dialog = view.find('[data-testid="ssh-ws-dialog-rename"]')
    assert.ok(dialog, 'the rename dialog opens')
    assert.ok(dialog.querySelector('[data-testid="ssh-ws-dialog-input"]'), 'and offers a name field')
    assert.match(view.html(), /data-testid="ssh-ws-dialog-input"/)
    const ui = SSH.require('ssh.session.ui')
    assert.equal(ui.joinPath('/local', 'build.log.1'), '/local/build.log.1')
    assert.equal(ui.basename('/srv/etc/passwd'), 'passwd')
    assert.equal(ui.parentPath('/srv/etc'), '/srv')
    assert.deepEqual(renamed, [])
  } finally {
    await view.unmount()
    restore()
  }
})

test('chmod validates the octal mode before it is applied', () => {
  const { restore, SSH } = boot()
  try {
    const { modeError, sortEntries, hasChild } = SSH.require('ssh.session.files')
    assert.equal(modeError('0644'), '')
    assert.equal(modeError('755'), '')
    assert.notEqual(modeError('99x'), '', 'a non-octal mode is rejected')
    assert.notEqual(modeError(''), '', 'an empty mode is rejected')
    assert.equal(hasChild([{ name: 'a' }], 'a'), true)
    assert.equal(hasChild([{ name: 'a' }], 'b'), false)
    const sorted = sortEntries(
      [
        { name: 'z.txt', type: 'file' },
        { name: 'alpha', type: 'dir' },
        { name: 'beta.txt', type: 'file' },
      ],
      { key: 'name', direction: 'asc' },
    )
    assert.deepEqual(sorted.map((entry) => entry.name), ['alpha', 'beta.txt', 'z.txt'], 'directories lead')
    const bySize = sortEntries(
      [
        { name: 'big', type: 'file', size: 10 },
        { name: 'small', type: 'file', size: 1 },
      ],
      { key: 'size', direction: 'desc' },
    )
    assert.deepEqual(bySize.map((entry) => entry.name), ['big', 'small'])
  } finally {
    restore()
  }
})

// ── logs ───────────────────────────────────────────────────────────────────

test('LogTab renders audit entries and never shows a credential', async () => {
  const { restore, session } = boot()
  const entries = [
    {
      at: '2026-01-04T10:00:00.000Z',
      op: 'connect',
      sessionId: 's_1',
      outcome: 'ok',
      durationMs: 120,
      target: { host: 'target.example', port: 22, user: 'root' },
      detail: { password: 'hunter2', passwordRef: 'cred://x', note: 'ssh://root:hunter2@target.example:22' },
    },
    { at: '2026-01-04T10:00:01.000Z', op: 'remove', sessionId: 's_1', outcome: 'denied', detail: { path: '/srv/etc' } },
    { at: '2026-01-04T10:00:02.000Z', op: 'exec', sessionId: 's_1', outcome: 'error', detail: { message: 'boom' } },
  ]
  const view = await mount(
    React.createElement(session.components().LogTab, {
      sessionId: 's_1',
      entries,
      levelFilter: 'all',
      onClear: () => {},
      onRefresh: () => {},
      onExport: () => {},
    }),
  )
  try {
    assert.match(view.html(), /data-testid="ssh-ws-log-0"/)
    assert.match(view.html(), /data-testid="ssh-ws-logs-redacted"/)
    assert.match(view.html(), /connect/)
    assert.match(view.html(), /target\.example/)
    assert.equal(view.html().includes('hunter2'), false, 'a password must never reach the DOM')
    assert.equal(view.html().includes('cred://x'), false, 'a credential reference is masked too')
    assert.equal(view.find('[data-testid="ssh-ws-log-1"]').getAttribute('data-outcome'), 'denied')
    assert.equal(view.find('[data-testid="ssh-ws-log-2"]').getAttribute('data-outcome'), 'error')

    // Expanding the detail renders the scrubbed copy, mask included.
    click(view.find('[data-testid="ssh-ws-log-0"]'))
    await view.flush(1)
    const detail = view.find('[data-testid="ssh-ws-log-detail-0"]')
    assert.ok(detail, 'the detail block opens')
    assert.match(detail.textContent, /••••••••/)
    assert.equal(detail.textContent.includes('hunter2'), false)
    assert.match(detail.textContent, /"op": "connect"/)
  } finally {
    await view.unmount()
    restore()
  }
})

test('audit redaction is deep, masks whole values and keeps non-secrets intact', () => {
  const { restore, SSH } = boot()
  try {
    const logs = SSH.require('ssh.session.logs')
    const cleaned = logs.redactEntry({
      at: 'now',
      op: 'connect',
      outcome: 'ok',
      detail: {
        password: 'p@ssw0rd',
        nested: { passphrase: 'x', authorization: 'Bearer abc', keep: 'visible' },
        list: [{ token: 'abc' }, 'plain'],
        key: 'ssh-rsa AAAA',
        text: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----',
      },
    })
    assert.equal(cleaned.detail.password, logs.MASK)
    assert.equal(cleaned.detail.nested.passphrase, logs.MASK)
    assert.equal(cleaned.detail.nested.authorization, logs.MASK)
    assert.equal(cleaned.detail.nested.keep, 'visible')
    assert.equal(cleaned.detail.list[0].token, logs.MASK)
    assert.equal(cleaned.detail.list[1], 'plain')
    assert.equal(cleaned.detail.key, logs.MASK)
    assert.equal(cleaned.detail.text.includes('PRIVATE KEY'), false)
    assert.equal(logs.redactText('ssh://root:secret@host:22/x'), `ssh://root:${logs.MASK}@host:22/x`)
    const json = logs.exportEntries([{ at: 'now', op: 'exec', outcome: 'ok', detail: { password: 'no' } }], 'json')
    assert.equal(json.includes('no"'), false)
    const csv = logs.exportEntries([{ at: 'now', op: 'exec', outcome: 'ok', detail: { password: 'no' } }], 'csv')
    assert.match(csv, /^at,op,sessionId/)
    assert.equal(csv.includes('••••••••'), true)
  } finally {
    restore()
  }
})

test('LogTab filters by outcome and by operation text', () => {
  const { restore, session } = boot()
  try {
    const entries = [
      { at: '2026-01-04T10:00:00.000Z', op: 'connect', sessionId: 's_1', outcome: 'ok' },
      { at: '2026-01-04T10:00:01.000Z', op: 'remove', sessionId: 's_1', outcome: 'denied' },
    ]
    const denied = renderToStaticMarkup(
      React.createElement(session.components().LogTab, { sessionId: 's_1', entries, levelFilter: 'denied', onClear: () => {}, onRefresh: () => {}, onExport: () => {} }),
    )
    assert.match(denied, /remove/)
    assert.equal(denied.includes('>connect<'), false, 'the filter hides other outcomes')
    const search = renderToStaticMarkup(
      React.createElement(session.components().LogTab, { sessionId: 's_1', entries, levelFilter: 'all', onClear: () => {}, onRefresh: () => {}, onExport: () => {} }),
    )
    assert.match(search, /data-testid="ssh-ws-logs-search"/)
    assert.match(search, /data-testid="ssh-ws-logs-filter-all"/)
    assert.match(search, /data-testid="ssh-ws-logs-export-json"/)
  } finally {
    restore()
  }
})

test('LogTab export hands the caller redacted text, not the raw entries', async () => {
  const { restore, session } = boot()
  const exported = []
  const view = await mount(
    React.createElement(session.components().LogTab, {
      sessionId: 's_1',
      entries: [{ at: '2026-01-04T10:00:00.000Z', op: 'connect', sessionId: 's_1', outcome: 'ok', detail: { password: 'topsecret' } }],
      levelFilter: 'all',
      onClear: () => {},
      onRefresh: () => {},
      onExport: (text, format, entries) => exported.push({ text, format, entries }),
    }),
  )
  try {
    click(view.find('[data-testid="ssh-ws-logs-export-json"]'))
    await view.flush(1)
    click(view.find('[data-testid="ssh-ws-logs-export-csv"]'))
    await view.flush(1)
    assert.equal(exported.length, 2)
    assert.equal(exported[0].format, 'json')
    assert.equal(exported[1].format, 'csv')
    assert.equal(exported[0].text.includes('topsecret'), false)
    assert.equal(exported[1].text.includes('topsecret'), false)
  } finally {
    await view.unmount()
    restore()
  }
})

test('clearing the log asks first', async () => {
  const { restore, session } = boot()
  let cleared = 0
  const view = await mount(
    React.createElement(session.components().LogTab, {
      sessionId: 's_1',
      entries: [{ at: '2026-01-04T10:00:00.000Z', op: 'connect', sessionId: 's_1', outcome: 'ok' }],
      levelFilter: 'all',
      onClear: () => {
        cleared += 1
      },
      onRefresh: () => {},
      onExport: () => {},
    }),
  )
  try {
    click(view.find('[data-testid="ssh-ws-logs-clear"]'))
    await view.flush(1)
    assert.match(view.html(), /data-testid="ssh-ws-logs-confirm-clear"/)
    assert.equal(cleared, 0, 'clearing the audit log is a dangerous operation')
    click(view.find('[data-testid="ssh-ws-confirm-ok"]'))
    await view.flush(1)
    assert.equal(cleared, 1)
  } finally {
    await view.unmount()
    restore()
  }
})

// ── runtime seams used by the container ────────────────────────────────────

test('the runtime delegates to store actions when SP5 provides them', async () => {
  const { restore, SSH } = boot()
  try {
    const runtime = SSH.require('ssh.session.runtime')
    const seen = []
    const app = {
      actions: {
        listDir: (params) => {
          seen.push(params)
          return Promise.resolve({ entries: [{ name: 'from-store', path: '/srv/from-store', type: 'file', size: 1, mode: '0644', mtime: '' }], cwd: '/srv' })
        },
      },
    }
    runtime.configure({ bridge: null, app })
    const directory = await runtime.actions.listDir({ sessionId: 's_1', path: '/srv' })
    assert.deepEqual(seen, [{ sessionId: 's_1', path: '/srv', showHidden: false }], 'the store action is called with the normalised params')
    assert.equal(directory.entries[0].name, 'from-store')

    let asked = null
    runtime.setConfirmHandler(async (request) => {
      asked = request
      return { confirmed: true }
    })
    assert.equal(await runtime.actions.requestConfirm({ kind: 'delete' }), true)
    assert.deepEqual(asked, { kind: 'delete' })
  } finally {
    restore()
  }
})

test('an unwired runtime explains itself instead of throwing', async () => {
  const { restore, SSH } = boot()
  try {
    const runtime = SSH.require('ssh.session.runtime')
    runtime.configure({ bridge: null, app: null })
    assert.equal(runtime.isWired(), false)
    await assert.rejects(
      () => runtime.actions.shellResize('st_1', 80, 24),
      (error) => {
        assert.equal(error.code, 'SSH_STATE_INVALID')
        assert.match(error.message, /not wired/)
        return true
      },
    )
    const shell = runtime.actions.openShell({ sessionId: 's_1' })
    const ready = await shell.ready
    assert.equal(ready.streamId, null)
    assert.equal(runtime.getStream(shell.localId).status, 'error')
  } finally {
    restore()
  }
})

test('the runtime discovers the plugin runtime when nobody wired it explicitly', async () => {
  const carrier = fakeSshCarrier({ terminalFrames: ['$ '] })
  const { restore, SSH } = boot({
    extras: {
      // The plugin body's published face: `currentRuntime()` is what `introspect`
      // exposes to the bundle's consumers, so reading it is using a public seam.
      'ssh.plugin': (loaded) => {
        const bridge = loaded.require('ssh.bridge').createBridge({ get: (name) => (name === 'remote' ? carrier : undefined) })
        return { currentRuntime: () => ({ bridge, app: null, ctx: null, resolution: null }) }
      },
    },
  })
  try {
    const runtime = SSH.require('ssh.session.runtime')
    assert.equal(runtime.isWired(), true, 'the bridge is discovered without a configure() call')

    const stream = runtime.actions.openShell({ sessionId: 's_1' })
    await waitFor(() => runtime.getStream(stream.localId)?.end, 'the shell stream to finish')
    assert.equal(carrier.calls.filter((call) => call.method === 'openShell').length, 1)

    await runtime.actions.shellWrite(stream.localId, 'uname -a\r')
    const writes = carrier.calls.filter((call) => call.method === 'shellWrite')
    assert.deepEqual(writes.map((call) => call.params.data), ['uname -a\r'], 'typing reaches the host')

    // An explicit configure() still wins over discovery.
    const explicit = fakeSshCarrier({ terminalFrames: [] })
    const explicitBridge = SSH.require('ssh.bridge').createBridge({ get: (name) => (name === 'remote' ? explicit : undefined) })
    runtime.configure({ bridge: explicitBridge, app: null })
    runtime.actions.openShell({ sessionId: 's_1' })
    await waitFor(() => explicit.calls.some((call) => call.method === 'openShell'), 'the explicit bridge to be used')
  } finally {
    restore()
  }
})

test('file entries loaded through the runtime land in the pane', async () => {
  const { restore, session, SSH } = boot()
  const carrier = fakeSshCarrier({ remoteEntries: REMOTE_ENTRIES, localEntries: LOCAL_ENTRIES })
  const runtime = SSH.require('ssh.session.runtime')
  runtime.configure({ bridge: SSH.require('ssh.bridge').createBridge({ get: (name) => (name === 'remote' ? carrier : undefined) }), app: null })
  const loaded = await runtime.actions.listDir({ sessionId: 's_1', path: '/srv' })
  assert.equal(loaded.entries.length, REMOTE_ENTRIES.length)
  const local = await runtime.actions.listLocalDir({ sessionId: 's_1', path: '/local' })
  assert.equal(local.entries.length, LOCAL_ENTRIES.length)

  const view = await mount(
    React.createElement(session.components().FileManager, { sessionId: 's_1', localRoot: '/local', remoteRoot: '/srv' }),
  )
  try {
    await view.flush(3)
    assert.match(view.html(), /data-testid="ssh-ws-entry-remote-etc"/)
    assert.match(view.html(), /data-testid="ssh-ws-entry-local-build\.log"/)
  } finally {
    await view.unmount()
    restore()
  }
})

// ── file panes: every load reaches an end state ────────────────────────────
//
// A pane used to render `Loading…` from the *absence* of a directory record and had
// no deadline, so a request that was accepted and never answered left the tab
// spinning forever with no way out (the reported symptom: nothing in the console,
// no upload, both trees stuck). These cases pin the exit: an unanswered request
// expires into a retryable error, a successful one reports its entry count, the
// retry recovers, and a disabled upload states its reason.

/** Capture the data-plane lifecycle lines instead of letting them reach the reporter. */
function captureConsole() {
  const infos = []
  const warns = []
  const originalInfo = console.info
  const originalWarn = console.warn
  console.info = (...args) => infos.push(args)
  console.warn = (...args) => warns.push(args)
  return {
    infos,
    warns,
    /** Captured lines whose first argument starts with `prefix`. */
    lines: (prefix) => [...infos, ...warns].filter((args) => String(args[0]).startsWith(prefix)),
    restore() {
      console.info = originalInfo
      console.warn = originalWarn
    },
  }
}

/**
 * Poll a mounted view until the selector appears.
 *
 * The wait runs inside `act()` (through `flush`), because the deadline that makes
 * the pane leave `loading` is a real timer: its state update has to be flushed
 * before the DOM can be asserted on.
 */
async function waitForElement(view, selector, attempts = 100) {
  for (let index = 0; index < attempts; index++) {
    const found = view.find(selector)
    if (found) return found
    await view.flush(1)
  }
  return null
}

/**
 * A carrier whose directory listings can be held open on demand.
 *
 * `hang: true` models the reported failure exactly: the call is *accepted* and never
 * answered, so the runtime has already cached a `loading: true` record and no amount
 * of re-rendering will clear it.
 */
function deferredDirCarrier(options = {}) {
  const calls = []
  const state = {
    hang: options.hang !== false,
    failure: null,
    remoteEntries: options.remoteEntries ?? [],
    localEntries: options.localEntries ?? [],
    // The directory the host answers with. Real endpoints report the *resolved*
    // absolute path, which is what a bootstrap request like `.` relies on.
    remoteCwd: options.remoteCwd,
    localCwd: options.localCwd,
    // Per-request-path answers, for a carrier that must model navigation.
    cwds: {},
    entriesByPath: {},
  }
  const answer = (params, scope) => {
    const byPath = state.entriesByPath[params.path]
    const entries = byPath || (scope === 'local' ? state.localEntries : state.remoteEntries)
    const cwd = state.cwds[params.path] || (scope === 'local' ? state.localCwd : state.remoteCwd) || params.path
    return { entries, cwd }
  }
  const face = {
    async ping() {
      return { pong: true, version: '1.0.0', namespace: 'sshPlugin' }
    },
    listDir(params) {
      calls.push({ method: 'listDir', params })
      if (state.failure) return Promise.reject(state.failure)
      if (state.hang) return new Promise(() => {})
      return Promise.resolve(answer(params, 'remote'))
    },
    listLocalDir(params) {
      calls.push({ method: 'listLocalDir', params })
      if (state.hang) return new Promise(() => {})
      return Promise.resolve(answer(params, 'local'))
    },
    // A transfer is a *stream* (`bridge.stream('upload', …)` → `sshPlugin/upload`).
    async *upload(params) {
      calls.push({ method: 'upload', params })
      const streamId = 'st_upload_1'
      yield { t: 'open', streamId, kind: 'upload', meta: { opId: 'op_1' } }
      yield { t: 'progress', streamId, transferred: 10, totalBytes: 100, bytesPerSec: 10, phase: 'transfer' }
      yield { t: 'end', streamId, reason: 'completed' }
    },
  }
  return {
    calls,
    state,
    release() {
      state.hang = false
    },
    fail(error) {
      state.hang = false
      state.failure = error
    },
    carrier: { $mount: async () => {}, sshPlugin: face },
  }
}

/** Point the workspace runtime at a carrier, from a clean registry. */
function wireRuntime(SSH, carrier) {
  const runtime = SSH.require('ssh.session.runtime')
  runtime.reset()
  runtime.configure({
    bridge: SSH.require('ssh.bridge').createBridge({ get: (name) => (name === 'remote' ? carrier : undefined) }),
    app: null,
  })
  return runtime
}

test('a directory request that is never answered leaves the pane in a retryable error, not a spinner', async () => {
  const { restore, session, SSH } = boot()
  const logs = captureConsole()
  const deferred = deferredDirCarrier({ hang: true })
  wireRuntime(SSH, deferred.carrier)
  const view = await mount(
    React.createElement(session.components().FileManager, {
      sessionId: 's_1',
      localRoot: '/local',
      remoteRoot: '/srv',
      timeoutMs: 40,
    }),
  )
  try {
    // The request really did go out; the old code simply never came back from here.
    await view.flush(2)
    assert.equal(deferred.calls.some((call) => call.method === 'listDir'), true, 'the remote listing was requested')
    const entries = view.find('[data-testid="ssh-ws-entries-remote"]')
    assert.ok(entries, 'the remote pane renders while it loads')
    assert.match(entries.textContent, /Loading/, 'the pane starts in the loading state')

    const error = await waitForElement(view, '[data-testid="ssh-ws-error-remote"]')
    assert.ok(error, 'an unanswered request must not stay in the loading state')
    assert.doesNotMatch(
      view.find('[data-testid="ssh-ws-entries-remote"]').textContent,
      /Loading/,
      'the deadline outranks the cached loading flag',
    )
    assert.match(error.textContent, /SSH_NET_TIMEOUT/)
    assert.ok(view.find('[data-testid="ssh-ws-retry-remote"]'), 'a failed pane offers a way out')

    // The lifecycle is diagnosable from the console alone: sent, then expired.
    const loading = logs.lines('[dsh-ssh] files: loading')
    const remoteLoading = loading.find((args) => args[1].scope === 'remote')
    assert.ok(remoteLoading, 'the remote request is announced')
    assert.equal(remoteLoading[1].path, '/srv')
    const timeouts = logs.lines('[dsh-ssh] files: timeout')
    assert.equal(timeouts.filter((args) => args[1].scope === 'remote').length, 1, 'the remote deadline is reported once')
    // Both trees hang in this scenario, so both must find their way out.
    assert.ok(view.find('[data-testid="ssh-ws-error-local"]'), 'the local pane leaves the loading state too')
  } finally {
    logs.restore()
    await view.unmount()
    restore()
  }
})

test('a successful listing reports its entry count and renders the files', async () => {
  const { restore, session, SSH } = boot()
  const logs = captureConsole()
  const deferred = deferredDirCarrier({ hang: false, remoteEntries: REMOTE_ENTRIES, localEntries: LOCAL_ENTRIES })
  wireRuntime(SSH, deferred.carrier)
  const view = await mount(
    React.createElement(session.components().FileManager, {
      sessionId: 's_1',
      localRoot: '/local',
      remoteRoot: '/srv',
      timeoutMs: 40,
    }),
  )
  try {
    assert.ok(await waitForElement(view, '[data-testid="ssh-ws-entry-remote-etc"]'), 'the remote listing renders')
    assert.ok(view.find('[data-testid="ssh-ws-entry-local-build\\.log"]'), 'the local listing renders')
    assert.equal(view.find('[data-testid="ssh-ws-error-remote"]'), null, 'no error on the happy path')

    const loaded = logs.lines('[dsh-ssh] files: loaded')
    const remote = loaded.find((args) => args[1].scope === 'remote')
    assert.ok(remote, 'the remote load is reported')
    assert.equal(remote[1].entries, REMOTE_ENTRIES.length)
    const local = loaded.find((args) => args[1].scope === 'local')
    assert.ok(local, 'the local load is reported')
    assert.equal(local[1].entries, LOCAL_ENTRIES.length)
  } finally {
    logs.restore()
    await view.unmount()
    restore()
  }
})

test('retrying after the deadline loads the directory', async () => {
  const { restore, session, SSH } = boot()
  const logs = captureConsole()
  const deferred = deferredDirCarrier({ hang: true, remoteEntries: REMOTE_ENTRIES, localEntries: LOCAL_ENTRIES })
  wireRuntime(SSH, deferred.carrier)
  const view = await mount(
    React.createElement(session.components().FileManager, {
      sessionId: 's_1',
      localRoot: '/local',
      remoteRoot: '/srv',
      timeoutMs: 40,
    }),
  )
  try {
    assert.ok(await waitForElement(view, '[data-testid="ssh-ws-error-remote"]'), 'the first request expires')
    const before = deferred.calls.filter((call) => call.method === 'listDir').length

    // The link recovers, and the user retries without reloading the tab.
    deferred.release()
    click(view.find('[data-testid="ssh-ws-retry-remote"]'))

    assert.ok(await waitForElement(view, '[data-testid="ssh-ws-entry-remote-etc"]'), 'the retry loads the listing')
    assert.equal(view.find('[data-testid="ssh-ws-error-remote"]'), null, 'the error clears once data arrives')
    assert.equal(deferred.calls.filter((call) => call.method === 'listDir').length, before + 1, 'exactly one retry went out')
  } finally {
    logs.restore()
    await view.unmount()
    restore()
  }
})

test('a disabled upload states its reason', () => {
  const { restore, session } = boot()
  try {
    const FileManager = session.components().FileManager
    // No session yet: nothing can be uploaded, and that is not the user's fault.
    const noSession = renderToStaticMarkup(
      React.createElement(FileManager, {
        localRoot: '/local',
        remoteRoot: '/srv',
        localEntries: LOCAL_ENTRIES,
        remoteEntries: [],
      }),
    )
    assert.match(noSession, /title="err\.SSH_STATE_INVALID"/, 'an unusable session explains itself')
    assert.match(noSession, /data-reason="err\.SSH_STATE_INVALID"/)

    // The remote listing is still in flight: the destination is not known yet.
    const loadingHtml = renderToStaticMarkup(
      React.createElement(FileManager, {
        sessionId: 's_1',
        localRoot: '/local',
        remoteRoot: '/srv',
        localEntries: LOCAL_ENTRIES,
        remoteEntries: [],
        loadingByPane: { local: false, remote: true },
      }),
    )
    assert.match(loadingHtml, /title="Loading\u2026"/, 'a pending listing explains itself')
  } finally {
    restore()
  }
})

test('a denied remote listing explains why upload is unavailable', async () => {
  const { restore, session, SSH } = boot()
  const deferred = deferredDirCarrier({ hang: false })
  deferred.fail(Object.assign(new Error('permission denied by the host'), { code: 'SSH_PERM_DENIED' }))
  wireRuntime(SSH, deferred.carrier)
  const view = await mount(
    React.createElement(session.components().FileManager, {
      sessionId: 's_1',
      localRoot: '/local',
      remoteRoot: '/srv',
      timeoutMs: 40,
    }),
  )
  try {
    assert.ok(await waitForElement(view, '[data-testid="ssh-ws-error-remote"]'), 'the denied listing is reported')
    const upload = view.find('[data-testid="ssh-ws-files-upload"]')
    assert.ok(upload, 'the upload control is present')
    assert.equal(upload.disabled, true, 'upload stays disabled')
    assert.equal(
      upload.getAttribute('title'),
      'permission denied by the host',
      'the disabled control carries the host reason, not a silent no-op',
    )
    // The per-pane control carries the same reason for hover and for tests.
    assert.equal(view.find('[data-testid="ssh-ws-upload-local"]').getAttribute('data-reason'), 'permission denied by the host')
  } finally {
    await view.unmount()
    restore()
  }
})

// ── the mount trigger: a request must actually be issued ───────────────────
//
// The watchdog only helps once a request exists. The reported build printed the
// module marker and then *nothing*: the tab mounted, the trigger never fired, so
// neither pane ever asked the host for anything - and no error appeared either,
// because "no request was sent" is not a failure the UI could see. These cases pin
// the trigger itself: it must fire for the prop shape the GUI actually mounts, and a
// leftover half-loaded record must not silence it.

test('the mount trigger fires even when a leftover half-loaded record exists', async () => {
  const { restore, session, SSH } = boot()
  const logs = captureConsole()
  const deferred = deferredDirCarrier({ hang: true, remoteEntries: REMOTE_ENTRIES, localEntries: LOCAL_ENTRIES })
  const runtime = wireRuntime(SSH, deferred.carrier)

  // What an earlier mount (or an unanswered request) leaves behind: a record that
  // exists, claims to be loading, and holds neither an answer nor an error. The
  // previous trigger compared against exactly this flag (`cached.loading !== true`)
  // and so never fired again for the life of the page.
  runtime.actions.listDir({ sessionId: 's_1', path: '/srv' })
  const stale = runtime.getDirectory('s_1', 'remote', '/srv')
  assert.ok(stale, 'a record exists before the tab is mounted')
  assert.equal(stale.loading, true)
  assert.equal(stale.loadedAt, 0)
  assert.equal(stale.error, null)

  const view = await mount(
    React.createElement(session.components().FileManager, {
      sessionId: 's_1',
      localRoot: '/local',
      remoteRoot: '/srv',
      timeoutMs: 40,
    }),
  )
  try {
    await view.flush(2)

    // The decision is reported with the values it was made from, so "nothing was
    // requested" is diagnosable instead of inferred.
    const remoteTrigger = logs.lines('[dsh-ssh] files: trigger').find((args) => args[1].scope === 'remote')
    assert.ok(remoteTrigger, 'the remote pane reports its trigger decision')
    assert.equal(remoteTrigger[1].reason, 'fire', 'a stale record must not be read as work in progress')
    assert.equal(remoteTrigger[1].hasRecord, true)
    assert.equal(remoteTrigger[1].recordLoading, true, 'the stale flag is visible in the log')
    assert.equal(remoteTrigger[1].path, '/srv')

    // And the request really went out - this is the line the user never saw.
    const loading = logs.lines('[dsh-ssh] files: loading').filter((args) => args[1].scope === 'remote')
    assert.equal(loading.length, 1, 'the stale record must be replaced by a real request')
    assert.equal(loading[0][1].path, '/srv')

    // The watchdog still owns the exit: it hangs, so it expires into a retryable error.
    assert.ok(await waitForElement(view, '[data-testid="ssh-ws-error-remote"]'), 'the fired request leaves loading')
    assert.ok(view.find('[data-testid="ssh-ws-retry-remote"]'))
  } finally {
    logs.restore()
    await view.unmount()
    restore()
  }
})

test('the shape the GUI actually mounts (sessionId only) still loads both panes', async () => {
  const { restore, session, SSH } = boot()
  const logs = captureConsole()
  const deferred = deferredDirCarrier({ hang: false, remoteEntries: REMOTE_ENTRIES, localEntries: LOCAL_ENTRIES })
  const runtime = SSH.require('ssh.session.runtime')
  runtime.reset()
  // The real call site is `FileManager({ sessionId })` with no roots at all
  // (client/src/panel.js). Both panes must still find somewhere to start: the local
  // half resolves `.` against the host's configured root, the remote half falls back
  // to the session profile's `defaultCwd`.
  runtime.configure({
    bridge: SSH.require('ssh.bridge').createBridge({ get: (name) => (name === 'remote' ? deferred.carrier : undefined) }),
    app: {
      store: {
        getState: () => ({
          sessions: { items: [{ id: 's_1', profileId: 'p_1' }] },
          profiles: { items: [{ id: 'p_1', defaultCwd: '/var/www' }] },
        }),
      },
    },
  })
  deferred.state.remoteCwd = '/var/www'
  deferred.state.localCwd = 'C:\\ws'

  const view = await mount(React.createElement(session.components().FileManager, { sessionId: 's_1', timeoutMs: 40 }))
  try {
    await view.flush(2)
    const triggers = logs.lines('[dsh-ssh] files: trigger')
    assert.deepEqual(
      triggers.map((args) => [args[1].scope, args[1].path, args[1].reason]),
      [
        ['local', '.', 'fire'],
        ['remote', '/var/www', 'fire'],
      ],
      'both panes start from a usable root and fire',
    )

    const loading = logs.lines('[dsh-ssh] files: loading')
    assert.deepEqual(
      loading.map((args) => [args[1].scope, args[1].path]),
      [
        ['local', '.'],
        ['remote', '/var/www'],
      ],
      'the request is actually sent for both panes',
    )

    assert.ok(await waitForElement(view, '[data-testid="ssh-ws-entry-local-build\\.log"]'), 'the local pane lists')
    assert.ok(await waitForElement(view, '[data-testid="ssh-ws-entry-remote-etc"]'), 'the remote pane lists')
    assert.equal(view.find('[data-testid="ssh-ws-error-local"]'), null)
    assert.equal(view.find('[data-testid="ssh-ws-error-remote"]'), null)

    // The answered (absolute) directory becomes the pane root, so breadcrumbs and
    // transfer destinations are built from the real path, not the bootstrap.
    assert.match(view.html(), /title="\/var\/www"/, 'the remote pane adopts the answered cwd')
    assert.match(view.html(), /title="C:\\ws"/, 'the local pane adopts the absolute local root')
  } finally {
    logs.restore()
    await view.unmount()
    restore()
  }
})

// ── navigation and upload: the two interactions that were dead ─────────────
//
// The loader was fine: requests went out and the host answered. What was broken was
// that the pane read its cache under a key that never changed, so a navigation stored
// its answer under the new path while the view kept rendering the old one - the listing
// appeared frozen, the pane root never advanced, and the user's repeated clicks
// produced identical requests. Upload was a separate dead end: the handler only called
// an optional prop the GUI never passes.

/** Force re-renders so a trigger that fires per render would show up. */
function Rerender({ times, children }) {
  const [count, setCount] = React.useState(0)
  React.useEffect(() => {
    let index = 0
    const timer = setInterval(() => {
      index += 1
      setCount(index)
      if (index >= times) clearInterval(timer)
    }, 2)
    return () => clearInterval(timer)
  }, [times])
  return children(count)
}

test('re-rendering the pane does not re-issue the same directory load', async () => {
  const { restore, session, SSH } = boot()
  const logs = captureConsole()
  const deferred = deferredDirCarrier({ hang: false, remoteEntries: REMOTE_ENTRIES, localEntries: LOCAL_ENTRIES })
  wireRuntime(SSH, deferred.carrier)
  const FileManager = session.components().FileManager
  const view = await mount(
    React.createElement(Rerender, { times: 8 }, () => React.createElement(FileManager, { sessionId: 's_1', timeoutMs: 40 })),
  )
  try {
    await view.flush(6)
    const loading = logs.lines('[dsh-ssh] files: loading')
    assert.equal(loading.filter((args) => args[1].scope === 'local').length, 1, 'the local pane loads once')
    assert.equal(loading.filter((args) => args[1].scope === 'remote').length, 1, 'the remote pane loads once')
    assert.equal(deferred.calls.filter((call) => call.method === 'listLocalDir').length, 1, 'no duplicate request is sent')
    assert.equal(deferred.calls.filter((call) => call.method === 'listDir').length, 1)
  } finally {
    logs.restore()
    await view.unmount()
    restore()
  }
})

test('opening a directory moves the pane into it and the bootstrap root does not take it back', async () => {
  const { restore, session, SSH } = boot()
  const logs = captureConsole()
  const deferred = deferredDirCarrier({ hang: false, localEntries: LOCAL_ENTRIES, remoteEntries: REMOTE_ENTRIES })
  wireRuntime(SSH, deferred.carrier)
  // Two levels, each answered with its own absolute cwd.
  const SUB_ENTRIES = [{ name: 'inner.txt', path: 'C:\\ws\\sub\\inner.txt', type: 'file', size: 3, mode: '0644', mtime: '2026-01-04T00:00:00.000Z' }]
  const withSub = [
    ...LOCAL_ENTRIES,
    { name: 'sub', path: 'C:\\ws\\sub', type: 'dir', size: 0, mode: '0755', mtime: '2026-01-04T00:00:00.000Z' },
  ]
  deferred.state.cwds = { '.': 'C:\\ws', 'C:\\ws': 'C:\\ws', 'C:\\ws\\sub': 'C:\\ws\\sub' }
  deferred.state.entriesByPath = { '.': withSub, 'C:\\ws': withSub, 'C:\\ws\\sub': SUB_ENTRIES }

  const view = await mount(
    React.createElement(session.components().FileManager, { sessionId: 's_1', timeoutMs: 40, localRoot: '.' }),
  )
  try {
    await view.flush(3)
    assert.ok(await waitForElement(view, '[data-testid="ssh-ws-entry-local-build\\.log"]'), 'the first listing renders')
    // At a filesystem root there is nowhere to go up to, so the control is disabled
    // rather than navigating into a phantom parent. The remote pane starts at `/`.
    assert.ok(view.find('[data-testid="ssh-ws-up-remote"]').hasAttribute('disabled'), 'up is disabled at the remote root')
    // The local pane resolved to `C:\ws`, which does have a parent.
    assert.equal(view.find('[data-testid="ssh-ws-up-local"]').hasAttribute('disabled'), false, 'up is available below a root')

    // A plain click on a directory opens it (the previous build only opened on a
    // double click, and the view never advanced either way).
    click(view.find('[data-testid="ssh-ws-entry-local-sub"]'))
    await view.flush(4)

    const navigations = logs.lines('[dsh-ssh] files: navigate')
    assert.equal(navigations.length, 1, 'the click navigates exactly once')
    assert.equal(navigations[0][1].to, 'C:\\ws\\sub')
    assert.equal(navigations[0][1].via, 'entry')

    // The pane now shows the subdirectory and nothing pulls it back.
    assert.ok(view.find('[data-testid="ssh-ws-entry-local-inner\\.txt"]'), 'the subdirectory listing is displayed')
    assert.equal(view.find('[data-testid="ssh-ws-entry-local-build\\.log"]'), null, 'the old listing is gone')

    const roots = logs.lines('[dsh-ssh] files: root').filter((args) => args[1].scope === 'local')
    assert.equal(roots.at(-1)[1].reason, 'record')
    assert.equal(roots.at(-1)[1].effective, 'C:\\ws\\sub')

    // Re-rendering must not re-request the bootstrap root behind the user's back.
    await view.flush(4)
    const localLoads = logs.lines('[dsh-ssh] files: loading').filter((args) => args[1].scope === 'local')
    assert.deepEqual(localLoads.map((args) => args[1].path), ['.', 'C:\\ws\\sub'], 'only the bootstrap and the opened directory were requested')

    // Inside a subdirectory there is somewhere to go up to, and `..` goes there.
    const up = view.find('[data-testid="ssh-ws-up-local"]')
    assert.equal(up.hasAttribute('disabled'), false, 'up becomes available inside a subdirectory')
    click(up)
    await view.flush(3)
    const lastNav = logs.lines('[dsh-ssh] files: navigate').at(-1)
    assert.equal(lastNav[1].via, 'up')
    assert.equal(lastNav[1].to, 'C:\\ws')
    assert.ok(await waitForElement(view, '[data-testid="ssh-ws-entry-local-build\\.log"]'), 'going up restores the parent listing')
  } finally {
    logs.restore()
    await view.unmount()
    restore()
  }
})

test('the upload control issues an upload stream for the selected local file', async () => {
  const { restore, session, SSH } = boot()
  const logs = captureConsole()
  const deferred = deferredDirCarrier({ hang: false, localEntries: LOCAL_ENTRIES, remoteEntries: [] })
  wireRuntime(SSH, deferred.carrier)
  // The GUI passes no callbacks, so the runtime must issue the transfer itself.
  const view = await mount(
    React.createElement(session.components().FileManager, {
      sessionId: 's_1',
      localRoot: '/local',
      remoteRoot: '/srv',
      localEntries: LOCAL_ENTRIES,
      remoteEntries: [],
      timeoutMs: 40,
    }),
  )
  try {
    click(view.find('[data-testid="ssh-ws-entry-local-build\\.log"]'))
    await view.flush(1)
    const upload = view.find('[data-testid="ssh-ws-files-upload"]')
    assert.equal(upload.hasAttribute('disabled'), false, `upload must be enabled (reason: ${upload.getAttribute('title')})`)

    click(upload)
    await view.flush(3)

    const sent = deferred.calls.filter((call) => call.method === 'upload')
    assert.equal(sent.length, 1, 'an upload stream is issued')
    assert.equal(sent[0].params.sessionId, 's_1')
    assert.equal(sent[0].params.localPath, '/local/build.log')
    assert.equal(sent[0].params.remotePath, '/srv/build.log', 'the destination is the remote pane directory plus the file name')

    // The lifecycle is visible: picked → started → done.
    const uploadLogs = logs.lines('[dsh-ssh] files: upload')
    assert.deepEqual(uploadLogs.map((args) => args[1].state), ['picked', 'started', 'done'])
    assert.equal(uploadLogs[0][1].file, '/local/build.log')
    assert.equal(uploadLogs[0][1].bytes, 2048)
  } finally {
    logs.restore()
    await view.unmount()
    restore()
  }
})

// ── the file list must actually show the file names ────────────────────────
//
// Reported from the running app: sizes and dates were visible in both panes but no
// file name was. The data was fine (a click handler logged the full name), so the
// defect was in presentation - and in a way a "renders without throwing" test cannot
// see, because the name *was* in the DOM, just zero pixels wide.

/** Parse rendered markup and return one record per entry row. */
function entryRows(html) {
  const host = globalThis.document.createElement('div')
  host.innerHTML = html
  return [...host.querySelectorAll('[data-testid^="ssh-ws-entry-"]')].map((row) => ({
    testid: row.getAttribute('data-testid'),
    name: (row.querySelector('.ssh-ws-entry-name') || {}).textContent ?? '',
    metas: [...row.querySelectorAll('.ssh-ws-entry-meta')].map((meta) => meta.textContent),
    text: row.textContent ?? '',
  }))
}

test('every entry row renders its name as text, and each column carries a value', () => {
  const { restore, session } = boot()
  try {
    const html = renderToStaticMarkup(
      React.createElement(session.components().FileManager, {
        sessionId: 's_1',
        localRoot: '/local',
        remoteRoot: '/srv',
        localEntries: LOCAL_ENTRIES,
        remoteEntries: REMOTE_ENTRIES,
        transfers: [],
      }),
    )
    const rows = entryRows(html)
    const visible = (entries) => entries.filter((entry) => !String(entry.name).startsWith('.'))
    assert.equal(
      rows.length,
      visible(LOCAL_ENTRIES).length + visible(REMOTE_ENTRIES).length,
      'every visible entry gets a row',
    )

    // The name column is what a file manager is read by: no row may be nameless, and
    // the text must be the entry's own `name` (not a placeholder or a translation key).
    const names = rows.map((row) => row.name)
    for (const row of rows) assert.notEqual(row.name.trim(), '', `row ${row.testid} has no name text`)
    for (const entry of [...LOCAL_ENTRIES, ...REMOTE_ENTRIES]) {
      if (String(entry.name).startsWith('.')) continue
      assert.ok(names.includes(entry.name), `${entry.name} is rendered as visible text`)
    }
    assert.equal(names.filter((name) => name === 'build.log').length, 1, 'the local file name is shown')

    // Columns: size, mode and mtime must carry values too - a name-only defect is a
    // mapping/content bug, whereas several empty columns would mean the row itself.
    const fileRow = rows.find((row) => row.testid === 'ssh-ws-entry-remote-payload.bin')
    assert.ok(fileRow, 'the remote file row exists')
    assert.equal(fileRow.metas.length, 3, 'size, mode and modified are all rendered')
    assert.ok(
      fileRow.metas.every((value) => value.trim() !== ''),
      `no empty column in ${JSON.stringify(fileRow.metas)}`,
    )
    assert.match(fileRow.metas.join(' '), /100 MiB/, 'the size column formats the byte count')
    assert.match(fileRow.text, /payload\.bin/, 'the row text contains the name')
  } finally {
    restore()
  }
})

test('the row layout cannot squeeze the file name out of the pane', () => {
  const { restore, SSH } = boot()
  try {
    const css = SSH.require('ssh.session.styles').CSS
    const ruleOf = (selector) => new RegExp(`\\${selector} \\{[^}]*\\}`).exec(css)?.[0] ?? ''
    const tracksOf = (rule) => /grid-template-columns:([^;]+);/.exec(rule)?.[1]?.trim() ?? ''

    // The two panes split the sidebar, so a pane is routinely ~200px while the meta
    // columns alone want 76+66+108px plus gaps. With `minmax(0,1fr)` the name was the
    // column that gave way: it collapsed to 0px and `overflow:hidden` hid it, which is
    // exactly "sizes visible, names gone". The name track needs a non-zero minimum.
    const entryTracks = tracksOf(ruleOf('.ssh-ws-entry'))
    const headTracks = tracksOf(ruleOf('.ssh-ws-head-row'))
    assert.match(
      entryTracks,
      /minmax\((?!0(px)?\b)[\d.]+px,\s*1fr\)/,
      `the name track needs a non-zero minimum, saw: ${entryTracks}`,
    )
    assert.equal(headTracks, entryTracks, 'header and rows share one track list, or the columns misalign')

    // A narrow pane needs to be a query container so the layout can shed columns
    // instead of squeezing the name.
    assert.match(ruleOf('.ssh-ws-pane'), /container-type:\s*inline-size/)
    const narrow = /@container \(max-width:\s*380px\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
    assert.ok(narrow, 'a narrow-pane rule exists')
    assert.match(tracksOf(narrow), /minmax\((?!0(px)?\b)[\d.]+px,\s*1fr\)/, 'the narrow layout keeps a name minimum too')
    assert.match(narrow, /:nth-child\(n\+4\)[^{]*\{[^}]*display:\s*none/, 'mode and modified are dropped in the narrow layout')

    // Colour must come from the text family: painting a name with a background token
    // renders same-on-same, which the token-only gate cannot detect.
    const nameRule = ruleOf('.ssh-ws-entry-name')
    assert.match(nameRule, /color:var\(--dsw-alias-label/)
    assert.doesNotMatch(nameRule, /color:var\(--dsw-alias-bg/)
    assert.doesNotMatch(nameRule, /display:\s*none|visibility:\s*hidden|(?:^|[;\s])width:\s*0(?:px)?\s*[;}]/)
  } finally {
    restore()
  }
})

test('an exec stream produces an ExecResult the command panel can render', async () => {
  const { restore, SSH } = boot()
  const carrier = fakeSshCarrier({
    execFrames: [
      { chunk: 'total 4\n', channel: 'stdout' },
      { chunk: 'oops\n', channel: 'stderr' },
    ],
  })
  const runtime = SSH.require('ssh.session.runtime')
  runtime.configure({ bridge: SSH.require('ssh.bridge').createBridge({ get: (name) => (name === 'remote' ? carrier : undefined) }), app: null })
  const started = runtime.actions.exec({ sessionId: 's_1', command: 'ls -la' })
  const result = await started.result
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout, 'total 4\n')
  assert.equal(result.stderr, 'oops\n')
  assert.equal(result.truncated.stdout, false)
  assert.equal(typeof result.durationMs, 'number')
  assert.equal(carrier.calls.some((call) => call.method === 'exec' && call.params.command === 'ls -la'), true)
  restore()
})

// ── host stream ids and call timing ────────────────────────────────────────
//
// `sh_local_*` is an optimistic id that exists only in this client: the host knows a
// stream by the id it reports in the `open` frame (`st_*`). A resize fired from a mount
// effect therefore races that frame — sending the local id produces `unknown stream` on
// the host, plus one console error per attempt.

/**
 * A bridge stub that names streams by hand, so the queue/flush timing is exact and
 * does not depend on the real bridge's carrier-resolution probe (`fakeSshCarrier`
 * plus the real bridge is already covered by the tests above).
 */
function stubStreamBridge(options = {}) {
  const calls = []
  const frames = []
  return {
    calls,
    frames,
    push(frame) {
      for (const onFrame of frames) onFrame(frame)
    },
    call(method, params) {
      calls.push({ method, params })
      if (options.failAdvisory && ['shellResize', 'shellSignal', 'shellClose'].includes(method)) {
        return Promise.reject({ code: 'SSH_UNKNOWN', message: 'unknown or finished stream', retryable: false })
      }
      return Promise.resolve({ ok: true })
    },
    stream(method, params, onFrame) {
      calls.push({ method: `stream:${method}`, params })
      frames.push(onFrame)
      return { streamId: null, cancel() {}, done: new Promise(() => {}) }
    },
    transportState() {
      return { kind: 'stub', status: 'ready', generation: 1 }
    },
    onTransportChange() {
      return () => {}
    },
  }
}

test('a resize issued before the open frame is queued, coalesced and sent with the host stream id', async () => {
  const { restore, SSH } = boot()
  const bridge = stubStreamBridge()
  const runtime = SSH.require('ssh.session.runtime')
  runtime.configure({ bridge, app: null })

  const shell = runtime.actions.openShell({ sessionId: 's_1', cols: 80, rows: 24 })
  const localId = shell.localId
  const hostId = 'st_01M3CVG3Z3Q921TMVTXG97T9A1'
  assert.match(localId, /^sh_local_/, 'the optimistic id is local to this client')
  assert.equal(bridge.calls.filter((call) => call.method === 'stream:openShell').length, 1, 'the stream request goes out')

  // What the terminal's mount effect does: size the PTY before the host has spoken.
  assert.deepEqual(await runtime.actions.shellResize(localId, 100, 30), { queued: true })
  assert.deepEqual(await runtime.actions.shellResize(localId, 120, 40), { queued: true })
  assert.equal(bridge.calls.filter((call) => call.method === 'shellResize').length, 0, 'nothing may be sent under the local id')

  // Keystrokes typed into a PTY that does not exist yet must not be lost either.
  await runtime.actions.shellWrite(localId, 'a')
  await runtime.actions.shellWrite(localId, 'b')
  assert.equal(bridge.calls.filter((call) => call.method === 'shellWrite').length, 0, 'input waits for the host id too')

  // The host names the stream: everything queued is delivered now.
  bridge.push({ t: 'open', streamId: hostId, kind: 'shell', meta: {} })
  const opened = await shell.ready
  assert.equal(opened.streamId, hostId, 'the ready handshake reports the host id')

  const resizes = bridge.calls.filter((call) => call.method === 'shellResize')
  // The geometry waits for the channel: the host announces the stream before it attaches
  // the shell channel, and a resize inside that window is rejected as "has no channel yet".
  assert.equal(resizes.length, 0, 'the resize is held until the stream produces data')

  const writes = bridge.calls.filter((call) => call.method === 'shellWrite')
  assert.deepEqual(
    writes.map((call) => [call.params.streamId, call.params.data]),
    [[hostId, 'a'], [hostId, 'b']],
    'queued input is delivered in order, addressed to the host id',
  )

  // The first byte proves the channel is attached: the held resize goes out now.
  bridge.push({ t: 'data', streamId: hostId, seq: 0, chunk: '$ ', encoding: 'utf8', channel: 'term' })
  const flushed = bridge.calls.filter((call) => call.method === 'shellResize')
  assert.equal(flushed.length, 1, 'only the newest geometry is sent, once the channel is up')
  assert.deepEqual(flushed[0].params, { streamId: hostId, cols: 120, rows: 40 })

  // The record now answers to either id, through the alias map.
  assert.equal(runtime.getStream(localId).streamId, hostId)
  assert.equal(runtime.getStream(hostId).streamId, hostId)

  // Calls made after open go straight out with the host id.
  await runtime.actions.shellResize(localId, 90, 20)
  assert.deepEqual(bridge.calls.filter((call) => call.method === 'shellResize')[1].params, { streamId: hostId, cols: 90, rows: 20 })
  await runtime.actions.shellResize(hostId, 70, 10)
  assert.deepEqual(bridge.calls.filter((call) => call.method === 'shellResize')[2].params, { streamId: hostId, cols: 70, rows: 10 })
  await runtime.actions.shellClose(localId)
  assert.deepEqual(bridge.calls.filter((call) => call.method === 'shellClose')[0].params, { streamId: hostId })
  restore()
})

// ── the fit decision, and the two console defects it prevents ──────────────

test('planFit refuses to size the terminal until the box and the renderer are both real', () => {
  // Pure decision: this is what keeps `rows: 1` and xterm's `dimensions` crash out of the
  // product without depending on a layout engine in the test.
  const { SSH } = boot()
  const { planFit, rendererReady } = SSH.require('ssh.session.fit')

  const base = { attached: true, width: 800, height: 400, rendererReady: true, cols: 100, rows: 25 }
  assert.equal(planFit(base).action, 'fit')

  // A detached element measures 0, which is the same trap as a collapsed container.
  assert.deepEqual(planFit({ ...base, attached: false }), { action: 'wait', reason: 'detached' })
  assert.deepEqual(planFit({ ...base, width: 0 }), { action: 'wait', reason: 'no-size' })
  assert.deepEqual(planFit({ ...base, height: 0 }), { action: 'wait', reason: 'no-size' })
  assert.deepEqual(planFit({ ...base, width: undefined, height: undefined }), { action: 'wait', reason: 'no-size' })

  // xterm creates its renderer during open(): sizing before that throws inside it.
  assert.deepEqual(planFit({ ...base, rendererReady: false }), { action: 'wait', reason: 'renderer-not-ready' })
  assert.equal(planFit({ ...base, rendererReady: false, attempts: 3, maxAttempts: 3 }).action, 'skip')

  // A grid smaller than 2×2 is not worth sending to a host.
  assert.deepEqual(planFit({ ...base, cols: 1, rows: 1 }), { action: 'skip', reason: 'grid-too-small' })

  // Renderer readiness: the built-in screen is plain DOM, the emulator shows its own node.
  assert.equal(rendererReady(null, { mode: 'fallback' }), true)
  assert.equal(rendererReady(document.createElement('div'), { mode: 'fallback' }), true)
  const container = document.createElement('div')
  assert.equal(rendererReady(container, { mode: 'xterm' }), false, 'no .xterm-screen means no renderer yet')
  container.appendChild(document.createElement('div')).className = 'xterm-screen'
  assert.equal(rendererReady(container, { mode: 'xterm' }), true)
  assert.equal(rendererReady(container, null), false)
})

test('a zero-sized container never triggers a resize, and a real one does', async () => {
  const { restore, session, SSH } = boot()
  SSH.require('ssh.session.term').configureHost({ mode: 'fallback' })
  const bridge = stubStreamBridge()
  const runtime = SSH.require('ssh.session.runtime')
  runtime.configure({ bridge, app: null })
  // A stream that the host has named: sizing is only sent once the id is known.
  const shell = runtime.actions.openShell({ sessionId: 's_1', cols: 80, rows: 24 })
  bridge.push({ t: 'open', streamId: 'st_layout_1', kind: 'shell', meta: {} })
  await shell.ready
  const streamId = shell.localId
  const resizes = () => bridge.calls.filter((call) => call.method === 'shellResize')

  const previous = layoutSize
  try {
    // Collapsed / not yet laid out: the terminal must stay silent rather than send rows:1.
    layoutSize = { width: 0, height: 0 }
    const collapsed = await mount(React.createElement(session.components().TerminalTab, { sessionId: 's_1', streamId }))
    try {
      await collapsed.flush(4)
      assert.equal(resizes().length, 0, 'a zero-sized container asks the host for nothing')
    } finally {
      await collapsed.unmount()
    }

    // Laid out: the plumbing from a measurement to a host call, asserted without React
    // scheduling in the way — the mount path is covered by the negative case above and by
    // the browser measurement in the README.
    layoutSize = { width: 820, height: 420 }
    const container = globalThis.document.createElement('div')
    globalThis.document.body.appendChild(container)
    const resized = []
    const host = SSH.require('ssh.session.term').createHost({
      container,
      cols: 80,
      rows: 24,
      onResize: (cols, rows) => resized.push({ cols, rows }),
    })
    try {
      assert.equal(host.mode, 'fallback')
      const measured = host.measure(container)
      assert.equal(measured.cols > 80 || measured.rows > 24, true, `expected the measured grid, saw ${measured.cols}x${measured.rows}`)
      host.setSize(measured.cols, measured.rows)
      assert.deepEqual(resized, [{ cols: measured.cols, rows: measured.rows }], 'a measured grid reaches the host callback exactly once')
    } finally {
      host.dispose()
      container.remove()
    }
  } finally {
    layoutSize = previous
    restore()
  }
})

test('a resize that lands before the channel is attached retries silently, then warns', async () => {
  const { restore, SSH } = boot()
  const runtime = SSH.require('ssh.session.runtime')
  const attempts = []
  let failures = 2
  const bridge = {
    call: async (method) => {
      if (method !== 'shellResize') return { ok: true }
      attempts.push(Date.now())
      if (failures > 0) {
        failures -= 1
        throw { code: 'SSH_UNKNOWN', message: 'shell st_x has no channel yet', retryable: true }
      }
      return { ok: true }
    },
    stream: () => ({ streamId: null, cancel() {}, done: new Promise(() => {}) }),
    transportState: () => ({ kind: 'stub', status: 'ready', generation: 1 }),
    onTransportChange: () => () => {},
  }
  runtime.configure({ bridge, app: null })
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.map((part) => (typeof part === 'object' ? JSON.stringify(part) : String(part))).join(' '))
  try {
    // Transient handshake state: retried, and never reported as a failure.
    await runtime.actions.shellResize('st_x', 120, 33)
    assert.equal(attempts.length, 3, 'two transient failures then a success')
    assert.deepEqual(warnings, [], 'the handshake state is not console noise')

    // A genuine, persistent failure is still visible — exactly once.
    failures = 99
    await runtime.actions.shellResize('st_y', 120, 33)
    assert.equal(warnings.filter((line) => line.includes('shellResize failed')).length, 1, 'a real fault is reported once')
  } finally {
    console.warn = originalWarn
    restore()
  }
})

test('the shell lifecycle is visible in the console', async () => {  // A user's screenshot cannot distinguish "never requested" from "requested but no
  // carrier" without these lines, so they are asserted rather than left to chance.
  const { restore, SSH } = boot()
  const bridge = stubStreamBridge()
  const runtime = SSH.require('ssh.session.runtime')
  runtime.configure({ bridge, app: null })
  const logs = []
  const originalInfo = console.info
  const originalWarn = console.warn
  console.info = (...args) => logs.push(args)
  console.warn = (...args) => logs.push(args)
  try {
    const shell = runtime.actions.openShell({ sessionId: 's_7', cols: 72, rows: 4 })
    const requested = logs.find((args) => String(args[0]).includes('openShell requested'))
    assert.ok(requested, 'the request is logged')
    assert.equal(requested[1].sessionId, 's_7')
    assert.equal(requested[1].cols, 72)

    bridge.push({ t: 'open', streamId: 'st_TRACE', kind: 'shell', meta: {} })
    await shell.ready
    const opened = logs.find((args) => String(args[0]).includes('openShell open'))
    assert.ok(opened, 'the host id is logged once the host names the stream')
    assert.equal(opened[1].hostStreamId, 'st_TRACE')
  } finally {
    console.info = originalInfo
    console.warn = originalWarn
    restore()
  }
})

test('closing a stream the host never named cancels locally instead of asking the host', async () => {
  const { restore, SSH } = boot()
  const bridge = stubStreamBridge()
  const runtime = SSH.require('ssh.session.runtime')
  runtime.configure({ bridge, app: null })

  const shell = runtime.actions.openShell({ sessionId: 's_1' })
  await runtime.actions.shellResize(shell.localId, 100, 30)
  assert.deepEqual(await runtime.actions.shellClose(shell.localId), { cancelled: true })
  assert.equal(bridge.calls.filter((call) => call.method === 'shellClose').length, 0, 'no close for a stream the host never issued')

  // The dropped queue must not replay against the stream after a late open.
  bridge.push({ t: 'open', streamId: 'st_LATE', kind: 'shell', meta: {} })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(bridge.calls.filter((call) => call.method === 'shellResize').length, 0, 'a cancelled stream sends nothing')
  restore()
})

test('a failing advisory shell call is logged, never an unhandled rejection', async () => {
  const { restore, SSH } = boot()
  const bridge = stubStreamBridge({ failAdvisory: true })
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    const runtime = SSH.require('ssh.session.runtime')
    runtime.configure({ bridge, app: null })

    const shell = runtime.actions.openShell({ sessionId: 's_1' })
    await runtime.actions.shellResize(shell.localId, 100, 30)
    // The host names the stream; the resize still waits for the first byte.
    bridge.push({ t: 'open', streamId: 'st_STUB', kind: 'shell', meta: {} })
    await new Promise((resolve) => setTimeout(resolve, 20))
    // That first byte releases the queued resize into a rejection (see `failAdvisory`).
    bridge.push({ t: 'data', streamId: 'st_STUB', seq: 0, chunk: '$ ', encoding: 'utf8', channel: 'term' })
    await new Promise((resolve) => setTimeout(resolve, 20))

    assert.equal(bridge.calls.filter((call) => call.method === 'shellResize').length, 1, 'the queued resize was flushed')
    assert.equal(bridge.calls.find((call) => call.method === 'shellResize').params.streamId, 'st_STUB')
    // Calls on a finished stream fail too, and must stay quiet.
    await runtime.actions.shellClose(shell.localId)
    await runtime.actions.shellSignal(shell.localId, 'INT')
    await new Promise((resolve) => setTimeout(resolve, 20))

    assert.deepEqual(unhandled, [], 'no promise may escape unhandled')
    assert.equal(warnings.some((line) => line.includes('shellResize failed')), true, 'the failure stays visible as a warning')
  } finally {
    console.warn = originalWarn
    process.off('unhandledRejection', onUnhandled)
    restore()
  }
})
