/**
 * Terminal tests: the VT screen model, key encoding, the host adapter against the
 * real vendored xterm.js, and the frame-ingestion invariants of the runtime.
 *
 * The emulator assertions run against the *actual* vendored build (not a mock), with
 * a handful of DOM shims that linkedom does not provide (layout metrics, `matchMedia`,
 * animation frames). That is what makes the acceptance-critical behaviour provable
 * here rather than only in a browser: `uname -a` output landing on the screen, and a
 * full-screen application repainting lines in place.
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import * as React from 'react'

import { installDom } from './harness.mjs'

// Installed for its side effect: every case below needs the global window/document.
// Deliberately not assigned — the suite runs in one DOM for its whole lifetime.
installDom()
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.window.IS_REACT_ACT_ENVIRONMENT = true

// ── DOM shims the emulator needs ───────────────────────────────────────────
//
// linkedom is a DOM without a layout engine: it has no `matchMedia`, no animation
// frames and every element measures zero. xterm.js reads all three, so they are
// provided here with fixed, plausible values. Nothing about the emulator's parsing
// or buffer behaviour depends on them - only its renderer setup does.

globalThis.window.matchMedia = (query) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
})
globalThis.matchMedia = globalThis.window.matchMedia
globalThis.window.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0)
globalThis.window.cancelAnimationFrame = (id) => clearTimeout(id)
globalThis.requestAnimationFrame = globalThis.window.requestAnimationFrame
globalThis.cancelAnimationFrame = globalThis.window.cancelAnimationFrame

/** Token values the host shell would resolve from CSS variables. */
const TOKENS = {
  '--dsw-alias-bg-base': 'var(--dsw-alias-bg-base)',
  '--dsw-alias-label-primary': 'var(--dsw-alias-label-primary)',
  '--dsw-alias-brand-primary': 'var(--dsw-alias-brand-primary)',
  '--dsw-alias-state-error-primary': 'var(--dsw-alias-state-error-primary)',
  '--dsw-alias-state-warn-primary': 'var(--dsw-alias-state-warn-primary)',
  '--dsw-alias-state-success-primary': 'var(--dsw-alias-state-success-primary)',
}

globalThis.window.getComputedStyle = () => ({
  getPropertyValue(name) {
    if (Object.prototype.hasOwnProperty.call(TOKENS, name)) return TOKENS[name]
    if (name === 'font-family') return 'ui-monospace, monospace'
    if (name === 'font-size') return '13px'
    return ''
  },
})
globalThis.getComputedStyle = globalThis.window.getComputedStyle

const elementPrototype = globalThis.window.HTMLElement.prototype
elementPrototype.getBoundingClientRect = function getBoundingClientRect() {
  return { width: 640, height: 240, top: 0, left: 0, right: 640, bottom: 240, x: 0, y: 0, toJSON: () => ({}) }
}
for (const [name, value] of [
  ['clientWidth', 640],
  ['clientHeight', 240],
  ['offsetWidth', 640],
  ['offsetHeight', 240],
]) {
  try {
    Object.defineProperty(elementPrototype, name, { get: () => value, configurable: true })
  } catch {
    /* a read-only shim on some linkedom builds is not fatal */
  }
}

// ── module loader (workspace dependency set) ───────────────────────────────

const SRC_DIR = fileURLToPath(new URL('../../client/src', import.meta.url))
const WORKSPACE_SOURCES = [
  /client[\\/]src[\\/]session[\\/]/,
  /client[\\/]src[\\/]vendor[\\/]/,
  /client[\\/]src[\\/]core\.js$/,
  /client[\\/]src[\\/]bridge\.js$/,
]

function loadSources() {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.js') && WORKSPACE_SOURCES.some((pattern) => pattern.test(full))) files.push(full)
    }
  }
  walk(SRC_DIR)
  const orderOf = (file) => Number(/@order[ \t]+(\d+)/.exec(readFileSync(file, 'utf8'))?.[1] ?? 500)
  files.sort((a, b) => orderOf(a) - orderOf(b) || (a < b ? -1 : a > b ? 1 : 0))

  const factories = Object.create(null)
  const cache = Object.create(null)
  const SSH = {
    id: '@local/dsh-ssh',
    react: React,
    h: React.createElement,
    Fragment: React.Fragment,
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
    style: { insert: () => () => {}, disposeAll: () => {} },
  }
  for (const file of files) new Function('SSH', readFileSync(file, 'utf8'))(SSH)
  return SSH
}

const SSH = loadSources()

/** A container element inside the test document. */
function makeContainer() {
  const element = globalThis.document.createElement('div')
  globalThis.document.body.appendChild(element)
  return element
}

/** Let the emulator's internal write/render queue drain. */
async function settle(times = 4) {
  for (let index = 0; index < times; index++) await new Promise((resolve) => setTimeout(resolve, 5))
}

// ── the VT screen model ────────────────────────────────────────────────────

test('the screen model lays out text, wraps long lines and scrolls', () => {
  const vt = SSH.require('ssh.session.vt')
  const screen = vt.createScreen({ cols: 10, rows: 3, scrollback: 10 })
  screen.feed('hello\r\nworld')
  assert.deepEqual(screen.lines(), ['hello', 'world', ''])
  screen.feed('\r\n0123456789ABC')
  // 12 characters into a 10-column screen: the last column arms the wrap, so the
  // tail continues on a fresh line while the first line scrolls off.
  assert.deepEqual(screen.lines().slice(0, 3), ['world', '0123456789', 'ABC'])
  assert.ok(screen.history().includes('hello'), 'the scrolled-off line is kept')
  assert.match(screen.allText(), /hello/)
})

test('the screen model honours cursor addressing and erasing', () => {
  const vt = SSH.require('ssh.session.vt')
  const screen = vt.createScreen({ cols: 20, rows: 5 })
  screen.feed('\x1b[2J\x1b[Htop - 12:00:00')
  assert.equal(screen.lines()[0], 'top - 12:00:00')
  screen.feed('\x1b[3;5Hstatus: 42')
  assert.equal(screen.lines()[2], '    status: 42')
  // Erase to end of line (what `top` does when a value shrinks).
  screen.feed('\x1b[3;1H\x1b[Kdone')
  assert.equal(screen.lines()[2], 'done')
  // Erase display 2 + home.
  screen.feed('\x1b[2J\x1b[H')
  assert.deepEqual(screen.lines(), ['', '', '', '', ''])
  // Erase in place, not the whole line.
  screen.feed('abcdef\x1b[1;4H\x1b[K')
  assert.equal(screen.lines()[0], 'abc')
})

test('the screen model tracks attribute runs without inventing colours', () => {
  const vt = SSH.require('ssh.session.vt')
  const screen = vt.createScreen({ cols: 40, rows: 3 })
  screen.feed('plain \x1b[1mbold\x1b[0m \x1b[4munder\x1b[0m')
  const runs = screen.runs()[0].runs
  assert.equal(runs.map((run) => run.text).join(''), 'plain bold under')
  const bold = runs.find((run) => run.text === 'bold')
  assert.ok(bold.attrs & vt.BOLD, 'the bold run carries the bold bit')
  const under = runs.find((run) => run.text === 'under')
  assert.ok(under.attrs & vt.UNDERLINE)
  // A colour request must not become an attribute: colour stays a token decision.
  screen.feed('\r\n\x1b[31mred\x1b[0m \x1b[38;5;196mx')
  const coloured = screen.runs()[1].runs.flatMap((run) => run.text).join('')
  assert.equal(coloured, 'red x')
  for (const run of screen.runs()[1].runs) assert.equal(run.attrs & vt.BOLD, 0)
})

test('the screen model switches to the alternate screen and back', () => {
  const vt = SSH.require('ssh.session.vt')
  const screen = vt.createScreen({ cols: 20, rows: 3 })
  screen.feed('shell prompt\r\n$ ')
  screen.feed('\x1b[?1049h\x1b[2J\x1b[HTOP')
  assert.equal(screen.altScreen, true)
  assert.equal(screen.lines()[0], 'TOP')
  screen.feed('\x1b[?1049l')
  assert.equal(screen.altScreen, false)
  assert.equal(screen.lines()[0], 'shell prompt', 'the normal buffer is restored')
})

test('the screen model survives an escape sequence split across chunks', () => {
  const vt = SSH.require('ssh.session.vt')
  const screen = vt.createScreen({ cols: 20, rows: 2 })
  screen.feed('ab\x1b[2;')
  screen.feed('1Hcd')
  assert.equal(screen.lines()[1], 'cd')
})

test('the screen model resizes without losing the visible content', () => {
  const vt = SSH.require('ssh.session.vt')
  const screen = vt.createScreen({ cols: 10, rows: 2 })
  screen.feed('hello')
  screen.resize(20, 4)
  assert.equal(screen.cols, 20)
  assert.equal(screen.rows, 4)
  assert.equal(screen.lines()[0], 'hello')
  screen.resize(5, 2)
  assert.equal(screen.lines()[0], 'hello')
})

// ── key encoding ───────────────────────────────────────────────────────────

test('key encoding produces the sequences a PTY expects', () => {
  const term = SSH.require('ssh.session.term')
  const encode = (key, extra) => term.encodeKey({ key, ...extra })
  assert.equal(encode('a'), 'a')
  assert.equal(encode(' '), ' ')
  assert.equal(encode('Enter'), '\r')
  assert.equal(encode('Backspace'), '\x7f')
  assert.equal(encode('Tab'), '\t')
  assert.equal(encode('Escape'), '\x1b')
  assert.equal(encode('ArrowUp'), '\x1b[A')
  assert.equal(encode('ArrowDown'), '\x1b[B')
  assert.equal(encode('ArrowRight'), '\x1b[C')
  assert.equal(encode('ArrowLeft'), '\x1b[D')
  assert.equal(encode('PageUp'), '\x1b[5~')
  assert.equal(encode('Delete'), '\x1b[3~')
  assert.equal(encode('F5'), '\x1b[15~')
  assert.equal(encode('c', { ctrlKey: true }), '\x03')
  assert.equal(encode('d', { ctrlKey: true }), '\x04')
  assert.equal(encode('x', { altKey: true }), '\x1bx')
  // Reserved workspace shortcuts must not reach the remote shell (ICD §8.4).
  assert.equal(encode('l', { ctrlKey: true }), '')
  assert.equal(encode('=', { ctrlKey: true }), '')
  assert.equal(encode('-', { metaKey: true }), '')
  assert.equal(encode('0', { ctrlKey: true }), '')
  assert.equal(encode('Shift'), '')
})

// ── the host adapter: vendored xterm ───────────────────────────────────────

test('the vendored emulator loads from the bundle', () => {
  const term = SSH.require('ssh.session.term')
  const vendor = term.loadXterm()
  assert.ok(vendor, 'the vendored xterm module is available in-bundle')
  assert.equal(typeof vendor.Terminal, 'function')
  assert.equal(typeof vendor.Terminal.prototype.write, 'function')
  assert.equal(typeof vendor.FitAddon, 'function', 'the fit addon is vendored too')
  assert.equal(term.xtermAvailable(), true)
  const css = SSH.require('ssh.vendor.xterm.css')
  assert.match(css.css, /\.xterm/)
})

test('the emulator renders streamed output and repaints full-screen updates', async () => {
  const term = SSH.require('ssh.session.term')
  term.configureHost({ mode: 'auto' })
  const container = makeContainer()
  const host = term.createHost({ container, cols: 80, rows: 24, fontSize: 13 })
  try {
    assert.equal(host.mode, 'xterm', 'the real emulator is used when it can attach')
    host.write({ text: 'uname -a\r\n' })
    host.write({ text: 'Linux target 6.1.0-13-amd64 #1 SMP x86_64 GNU/Linux\r\n' })
    await settle()
    const lineAt = (row) => host.term.buffer.active.getLine(row).translateToString(true)
    assert.equal(lineAt(0), 'uname -a')
    assert.match(lineAt(1), /Linux target 6\.1\.0-13-amd64/)

    // A full-screen application: clear, home, draw, then update one field in place.
    host.write({ text: '\x1b[2J\x1b[Htop - 12:00:00 up 3 days\r\nTasks: 120 total' })
    await settle()
    assert.equal(lineAt(0), 'top - 12:00:00 up 3 days')
    assert.equal(lineAt(1), 'Tasks: 120 total')
    host.write({ text: '\x1b[2;1H\x1b[KTasks: 137 total' })
    await settle()
    assert.equal(lineAt(1), 'Tasks: 137 total', 'the line was repainted in place')
    assert.equal(lineAt(0), 'top - 12:00:00 up 3 days', 'the rest of the screen is untouched')

    // Alternate screen (what `vim`/`less` use).
    host.write({ text: '\x1b[?1049h\x1b[2J\x1b[HALT SCREEN' })
    await settle()
    assert.equal(host.term.buffer.active.type, 'alternate')
    assert.equal(lineAt(0), 'ALT SCREEN')
    host.write({ text: '\x1b[?1049l' })
    await settle()
    assert.equal(host.term.buffer.active.type, 'normal')
    assert.equal(lineAt(0), 'top - 12:00:00 up 3 days', 'the normal buffer survived the detour')
  } finally {
    host.dispose()
    container.remove()
  }
})

test('emulator input, sizing, font size and clear all reach the emulator', async () => {
  const term = SSH.require('ssh.session.term')
  term.configureHost({ mode: 'auto' })
  const container = makeContainer()
  const typed = []
  const resized = []
  const host = term.createHost({
    container,
    cols: 80,
    rows: 24,
    fontSize: 13,
    onData: (data) => typed.push(data),
    onResize: (cols, rows) => resized.push({ cols, rows }),
  })
  try {
    assert.equal(host.mode, 'xterm')
    // `paste` goes through the emulator's own input path, which is what `onData`
    // observes for real keystrokes as well.
    host.term.paste('uname -a\r')
    assert.deepEqual(typed, ['uname -a\r'])

    host.setSize(100, 30)
    await settle(2)
    assert.equal(host.getSize().cols, 100)
    assert.equal(host.getSize().rows, 30)
    assert.ok(resized.length >= 1, 'a resize is reported to the caller')

    host.setFontSize(18)
    assert.equal(host.term.options.fontSize, 18)
    host.setFontSize(13)

    host.write({ text: 'to be cleared\r\nsecond line\r\n' })
    await settle(2)
    assert.match(host.term.buffer.active.getLine(0).translateToString(true), /to be cleared/)
    assert.match(host.term.buffer.active.getLine(1).translateToString(true), /second line/)
    host.clear()
    // The emulator implements clear() as a queued escape sequence, so the buffer
    // catches up asynchronously - the same ordering a user sees. (It is also a
    // deliberate no-op when the whole screen is still the prompt line.)
    await settle(2)
    assert.equal(host.term.buffer.active.getLine(0).translateToString(true), '', 'clear empties the screen')
    assert.equal(host.term.buffer.active.getLine(1).translateToString(true), '')

    assert.equal(typeof host.getSelection(), 'string')
    host.focus()
    host.refreshTheme()
  } finally {
    host.dispose()
    assert.equal(host.disposed, true)
    container.remove()
  }
})

test('the emulator theme comes from DSH tokens, never from a literal palette', () => {
  const term = SSH.require('ssh.session.term')
  const container = makeContainer()
  try {
    const theme = term.themeFromTokens(container)
    assert.ok(theme, 'the token read succeeded')
    assert.equal(theme.background, TOKENS['--dsw-alias-bg-base'])
    assert.equal(theme.foreground, TOKENS['--dsw-alias-label-primary'])
    assert.equal(theme.selectionBackground, TOKENS['--dsw-alias-brand-primary'])
    for (const value of Object.values(theme)) {
      assert.equal(typeof value, 'string')
      assert.equal(/#[0-9a-fA-F]{3,8}/.test(String(value)), false, 'no hardcoded colour may appear in the theme')
    }
  } finally {
    container.remove()
  }
})

// ── the host adapter: built-in screen ──────────────────────────────────────

test('the built-in screen drives the fallback renderer when xterm is forced off', async () => {
  const term = SSH.require('ssh.session.term')
  term.configureHost({ mode: 'fallback' })
  const container = makeContainer()
  const host = term.createHost({ container, cols: 12, rows: 3, fontSize: 13 })
  try {
    assert.equal(host.mode, 'fallback')
    assert.equal(host.term, null)
    host.write({ text: 'uname -a\r\nLinux target\r\n' })
    assert.deepEqual(host.screen.lines().slice(0, 2), ['uname -a', 'Linux target'])
    host.clear()
    assert.deepEqual(host.screen.lines(), ['', '', ''])
    host.write({ text: 'again' })
    host.reset()
    assert.deepEqual(host.screen.lines(), ['', '', ''])

    const size = host.measure(container)
    assert.ok(size.cols >= 20 && size.rows >= 4, 'the built-in screen estimates a grid from the box')
    host.setSize(40, 10)
    assert.deepEqual(host.getSize(), { cols: 40, rows: 10 })
    assert.equal(host.screen.cols, 40)
    assert.equal(host.getSize().rows, 10)

    // Bytes that the host could not decode as UTF-8 still render.
    const bytes = new TextEncoder().encode('binary-ish')
    host.write({ bytes })
    assert.match(host.screen.allText(), /binary-ish/)
  } finally {
    host.dispose()
    container.remove()
    term.configureHost({ mode: 'auto' })
  }
})

test('an emulator that cannot attach degrades to the built-in screen', () => {
  const term = SSH.require('ssh.session.term')
  term.configureHost({ mode: 'auto' })
  const container = makeContainer()
  // A container without a document view is exactly the case that makes xterm's
  // renderer setup throw; the host must fall back instead of propagating it.
  const brokenContainer = {
    ownerDocument: null,
    appendChild() {
      throw new Error('no renderer available here')
    },
    addEventListener() {},
    removeEventListener() {},
    clientWidth: 0,
    clientHeight: 0,
  }
  const host = term.createHost({ container: brokenContainer, cols: 80, rows: 24, fontSize: 13 })
  try {
    assert.equal(host.mode, 'fallback')
    assert.match(String(host.modeReason), /xterm failed|unavailable/)
    host.write({ text: 'still works' })
    assert.match(host.screen.allText(), /still works/)
  } finally {
    host.dispose()
    container.remove()
  }
})

// ── frame ingestion invariants ─────────────────────────────────────────────

test('the runtime de-duplicates a replayed data sequence after a reconnect', () => {
  const runtime = SSH.require('ssh.session.runtime')
  runtime.reset()
  runtime.ingest({ t: 'open', streamId: 'st_1', kind: 'shell', meta: {} })
  runtime.ingest({ t: 'data', streamId: 'st_1', seq: 0, chunk: 'one', encoding: 'utf8', channel: 'term' })
  runtime.ingest({ t: 'data', streamId: 'st_1', seq: 1, chunk: 'two', encoding: 'utf8', channel: 'term' })
  // The same frames again: `sinceSeq` resumption replays the tail.
  runtime.ingest({ t: 'data', streamId: 'st_1', seq: 0, chunk: 'one', encoding: 'utf8', channel: 'term' })
  runtime.ingest({ t: 'data', streamId: 'st_1', seq: 1, chunk: 'two', encoding: 'utf8', channel: 'term' })
  const record = runtime.getStream('st_1')
  assert.equal(record.chunks.length, 2, 'duplicates are dropped')
  assert.equal(runtime.streamText('st_1', 'term'), 'onetwo')
  assert.equal(record.lastSeq, 1)
})

test('a stream reaches exactly one terminal state', () => {
  const runtime = SSH.require('ssh.session.runtime')
  runtime.reset()
  runtime.ingest({ t: 'open', streamId: 'st_2', kind: 'exec', meta: {} })
  runtime.ingest({ t: 'exit', streamId: 'st_2', exitCode: 3, durationMs: 10, timedOut: false })
  runtime.ingest({ t: 'end', streamId: 'st_2', reason: 'completed' })
  runtime.ingest({ t: 'end', streamId: 'st_2', reason: 'error', error: { code: 'SSH_UNKNOWN', message: 'late', retryable: false } })
  const record = runtime.getStream('st_2')
  assert.equal(record.end.reason, 'completed')
  assert.equal(record.status, 'ended')
  assert.equal(record.error, null, 'a repeated end frame cannot rewrite the outcome')
  assert.equal(record.exit.exitCode, 3)
})

test('progress never moves backwards', () => {
  const runtime = SSH.require('ssh.session.runtime')
  runtime.reset()
  runtime.ingest({ t: 'open', streamId: 'st_3', kind: 'upload', meta: { opId: 'op_1', localPath: '/local/a', remotePath: '/srv/a' } })
  runtime.ingest({ t: 'progress', streamId: 'st_3', transferred: 100, totalBytes: 1000, bytesPerSec: 10, phase: 'transfer' })
  runtime.ingest({ t: 'progress', streamId: 'st_3', transferred: 40, totalBytes: 1000, bytesPerSec: 10, phase: 'transfer' })
  const task = runtime.listTransfers().find((entry) => entry.opId === 'op_1')
  assert.ok(task, 'the transfer is tracked by opId')
  assert.equal(task.transferred, 100, 'a stale progress frame cannot rewind the bar')
  assert.equal(task.totalBytes, 1000)
})

test('base64 chunks decode to both text and bytes', () => {
  const runtime = SSH.require('ssh.session.runtime')
  runtime.reset()
  const payload = Buffer.from('über\n').toString('base64')
  runtime.ingest({ t: 'open', streamId: 'st_4', kind: 'shell', meta: {} })
  runtime.ingest({ t: 'data', streamId: 'st_4', seq: 0, chunk: payload, encoding: 'base64', channel: 'term' })
  const chunk = runtime.getStream('st_4').chunks[0]
  assert.equal(chunk.text, 'über\n')
  assert.ok(chunk.bytes instanceof Uint8Array)
  assert.equal(chunk.bytes.length, 6)
  assert.equal(runtime.streamText('st_4', 'term'), 'über\n')
})

test('state and audit frames land in their own registries', () => {
  const runtime = SSH.require('ssh.session.runtime')
  runtime.reset()
  runtime.ingest({ t: 'state', sessionId: 's_9', state: 'connected' })
  assert.equal(runtime.sessionState('s_9').state, 'connected')
  runtime.ingest({ t: 'state', sessionId: 's_9', state: 'error', error: { code: 'SSH_NET_RESET', message: 'dropped', retryable: true } })
  assert.equal(runtime.sessionState('s_9').state, 'error')
  assert.equal(runtime.sessionState('s_9').error.code, 'SSH_NET_RESET')
  runtime.ingest({ t: 'audit', entry: { at: 'now', op: 'connect', outcome: 'ok' } })
  assert.equal(runtime.stats().auditEntries, 1)
  runtime.ingest({ t: 'audit', entry: { at: 'now2', op: 'exec', outcome: 'ok' } })
  assert.equal(runtime.stats().auditEntries, 2)
})

// ── vendored payload integrity ─────────────────────────────────────────────

test('the vendored emulator is intact and its upstream bytes are verbatim', async () => {
  const vendor = await import('../../scripts/vendor-xterm.mjs')
  const { createHash } = await import('node:crypto')
  const digest = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
  const vendorDir = fileURLToPath(new URL('../../client/src/vendor', import.meta.url))
  const manifest = JSON.parse(readFileSync(join(vendorDir, vendor.OUTPUT_FILES.manifest), 'utf8'))

  assert.deepEqual(
    manifest.packages.map((pkg) => `${pkg.name}@${pkg.version}`),
    ['@xterm/xterm@5.5.0', '@xterm/addon-fit@0.10.0'],
    'the vendored versions are pinned',
  )
  const upstream = new Map()
  for (const pkg of manifest.packages) for (const file of pkg.files) upstream.set(file.as, file.sha256)

  const assetByModule = {
    [vendor.OUTPUT_FILES.xterm]: 'xterm.umd.js',
    [vendor.OUTPUT_FILES.fit]: 'addon-fit.umd.js',
    [vendor.OUTPUT_FILES.css]: 'xterm.css',
  }
  for (const entry of manifest.modules) {
    const text = readFileSync(join(vendorDir, entry.file), 'utf8')
    assert.equal(digest(text), entry.sha256, `${entry.file} matches its recorded digest`)
    const payload = vendor.extractPayload(text, entry.kind)
    assert.ok(payload !== null, `${entry.file} carries a marked payload`)
    assert.equal(digest(payload), upstream.get(assetByModule[entry.file]), `${entry.file} embeds the tarball bytes verbatim`)
  }
})
