/**
 * Shortcut tests for the chrome (ICD §8.4).
 *
 * Two things make these worth their weight:
 *
 *   1. The shell's `shortcuts` service is strict — `register()` throws on a duplicate id,
 *      a combination that overlaps another command, or a Web binding it does not admit.
 *      The fake service below reimplements **exactly** those rules, taken from
 *      `@deepseek-ai/dsh-client-shortcuts/lib/client.js`, so a default that would be
 *      rejected in the real shell fails here instead of in the user's window.
 *   2. The shipped combinations of this build are pinned. `browser.new` already owns
 *      `Mod+T` on `desktop:*`, which is why §8.4's "new connection" row registers a
 *      substitute on desktop; if a future build frees that combination, the pinned
 *      table makes someone look at it deliberately.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'

import { BUNDLE_PATH, installDom } from './harness.mjs'

function installEventPolyfills(win) {
  if (typeof win.KeyboardEvent !== 'function') {
    win.KeyboardEvent = class KeyboardEventPolyfill extends win.Event {
      constructor(type, init = {}) {
        super(type, init)
        this.key = init.key ?? ''
        this.code = init.code ?? ''
        this.ctrlKey = !!init.ctrlKey
        this.shiftKey = !!init.shiftKey
        this.altKey = !!init.altKey
        this.metaKey = !!init.metaKey
        this.defaultPrevented = false
      }
      preventDefault() {
        this.defaultPrevented = true
      }
    }
  }
  if (typeof win.MouseEvent !== 'function') {
    win.MouseEvent = class MouseEventPolyfill extends win.Event {
      constructor(type, init = {}) {
        super(type, init)
        this.button = init.button ?? 0
        this.ctrlKey = !!init.ctrlKey
        this.shiftKey = !!init.shiftKey
        this.altKey = !!init.altKey
        this.metaKey = !!init.metaKey
      }
    }
  }
  if (typeof win.getComputedStyle !== 'function') win.getComputedStyle = () => ({ getPropertyValue: () => '' })
  for (const key of ['navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle']) {
    if (win[key] === undefined) continue
    try {
      Object.defineProperty(globalThis, key, { value: win[key], configurable: true, writable: true })
    } catch {
      /* ignore */
    }
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
}

async function loadChrome() {
  const restore = installDom()
  installEventPolyfills(globalThis.window)
  const source = readFileSync(BUNDLE_PATH, 'utf8')
  const anchor = 'exports.apply = plugin.apply'
  assert.ok(source.includes(anchor), 'bundle epilogue changed: the shortcuts test needs its registry hook')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-shortcuts-'))
  const copy = join(dir, 'client.mjs')
  writeFileSync(copy, source.replace(anchor, `${anchor}\n    exports.__ssh = SSH`), 'utf8')

  const rows = []
  globalThis.window.__ModuleLoader__ = { load: (row) => rows.push(row) }
  await import(`${pathToFileURL(copy).href}?v=${Date.now()}`)
  const exported = rows[0].factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected external require(${specifier})`)
  })
  return { restore, module: (name) => exported.__ssh.require(name) }
}

// ── a faithful stand-in for the shell's service ─────────────────────────────

const PROFILE_KEYS = ['desktop:macos', 'desktop:windows', 'desktop:linux', 'web:macos', 'web:windows', 'web:linux']
const MODIFIER_ORDER = ['control', 'alt', 'shift', 'meta']
const CODES = /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4]))$/
const NAMED_CODES = ['Slash', 'Comma', 'Period', 'Backslash', 'Backquote', 'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Semicolon', 'Quote', 'Enter', 'Escape', 'Space', 'Tab', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']

/** `normalizeBinding` from the shipped bundle. Throws on an unusable code. */
function normalizeBinding(binding, platform) {
  const codes = [binding.code, ...(binding.secondCode === undefined ? [] : [binding.secondCode])].sort()
  for (const code of codes) {
    if (!CODES.test(code) && !NAMED_CODES.includes(code)) throw new Error(`Unsupported shortcut code: ${code}`)
  }
  if (codes.length === 2 && codes[0] === codes[1]) throw new Error('Shortcut keys must be distinct')
  const modifiers = new Set(binding.modifiers.map((value) => (value === 'primary' ? (platform === 'macos' ? 'meta' : 'control') : value)))
  return { code: codes[0], modifiers: MODIFIER_ORDER.filter((value) => modifiers.has(value)) }
}

function bindingKey(binding) {
  const codes = binding.secondCode === undefined ? [binding.code] : [binding.code, binding.secondCode].sort()
  return [...binding.modifiers, ...codes].join('+')
}

/** `isWebBindingAllowed` from the shipped bundle. */
function isWebBindingAllowed(binding, platform) {
  if (binding.secondCode !== undefined) return false
  if (platform === 'windows' || platform === 'macos') {
    if (binding.modifiers.length >= 3) return true
    const primary = platform === 'macos' ? 'meta' : 'control'
    if (binding.modifiers.length === 1 && (['Comma', 'Backslash'].includes(binding.code) && binding.modifiers[0] === primary) ) return true
    if (binding.modifiers.length === 2 && binding.modifiers.includes(primary) && (binding.modifiers.includes('alt') || binding.modifiers.includes('shift'))) return true
  }
  const fixed = [
    { code: 'Slash', modifiers: ['primary'] },
    { code: 'Comma', modifiers: ['primary', 'shift'] },
    { code: 'Period', modifiers: ['primary', 'shift'] },
  ]
  return fixed.some((candidate) => bindingKey(binding) === bindingKey(normalizeBinding(candidate, platform)))
}

/**
 * A `shortcuts` service with the shipped registration rules.
 *
 * `shipped` carries the combinations this DSH build already owns, so an overlap is
 * rejected exactly as the real service would reject it.
 */
function fakeShortcutsService(options = {}) {
  const commands = new Map()
  const calls = []
  const shipped = new Map()
  for (const row of options.shipped ?? []) {
    for (const key of row.keys) shipped.set(key, row.id)
  }

  const service = {
    platform: options.platform ?? 'windows',
    runtime: options.runtime ?? 'desktop',
    catalog: { getSnapshot: () => [], subscribe: () => () => {} },
    fixedCatalog: { getSnapshot: () => [], subscribe: () => () => {} },
    calls,
    registered: () => [...commands.keys()],
    resolveFor(id, context, consume = () => {}) {
      return commands.get(id).dispatch(context, consume)
    },
    register(command) {
      calls.push(command)
      if (options.throwFor && options.throwFor(command)) throw new Error(`Reserved shortcut default: ${command.id}`)
      if (commands.has(command.id)) throw new Error(`Duplicate shortcut command: ${command.id}`)
      const resolved = new Map()
      for (const profile of PROFILE_KEYS) {
        const candidate = command.defaults[profile]
        if (candidate === undefined) continue
        const [runtime, platform] = profile.split(':')
        const binding = normalizeBinding(candidate, platform)
        if (runtime === 'web' && !isWebBindingAllowed(binding, platform)) {
          throw new Error(`Unsupported Web shortcut: ${command.id}`)
        }
        const key = `${runtime}:${platform}:${bindingKey(binding)}`
        if (shipped.has(`${runtime}:${platform}:${bindingKey(binding)}`)) {
          throw new Error(`Reserved shortcut default: ${command.id}`)
        }
        for (const [otherKey, otherId] of resolved) {
          if (otherKey === key && otherId !== command.id) throw new Error(`Overlapping shortcut default: ${command.id}`)
        }
        resolved.set(key, command.id)
      }
      commands.set(command.id, {
        ...command,
        dispatch(context, consume) {
          const result = command.resolve(context)
          if (result.status === 'pass') return result
          consume()
          if (result.status === 'blocked') return { ...result, commandId: command.id }
          result.run()
          return { status: 'handled', commandId: command.id }
        },
      })
      return () => commands.delete(command.id)
    },
    registerFixed() {
      return () => {}
    },
    describeBinding(binding) {
      return { binding, keys: [] }
    },
  }
  return service
}

/** Combinations owned by the shipped packages of this DSH build (read from app.asar). */
const SHIPPED_BINDINGS = [
  { id: 'browser.new', keys: ['desktop:macos:control+KeyT', 'desktop:windows:control+KeyT', 'desktop:linux:control+KeyT', 'web:macos:meta+alt+KeyT', 'web:windows:control+alt+KeyT'] },
  { id: 'sidebar-left.toggle', keys: ['desktop:windows:control+KeyB', 'web:windows:control+alt+KeyB'] },
  { id: 'sidebar-right.toggle', keys: ['desktop:windows:control+alt+KeyB', 'web:windows:control+shift+KeyB'] },
  { id: 'workspace.files', keys: ['desktop:windows:control+KeyP', 'web:windows:control+alt+KeyP'] },
  { id: 'terminal.new', keys: ['desktop:windows:control+Backquote', 'web:windows:control+Backquote'] },
  { id: 'settings.open', keys: ['desktop:windows:control+Comma'] },
  { id: 'shortcuts.open', keys: ['desktop:windows:control+Slash'] },
  { id: 'workspace.session.new', keys: ['desktop:windows:control+KeyN', 'web:windows:control+alt+KeyN'] },
  { id: 'workspace.session.search', keys: ['desktop:windows:control+KeyK', 'web:windows:control+alt+KeyK'] },
  { id: 'workspace.add', keys: ['desktop:windows:control+KeyO', 'web:windows:control+alt+KeyO'] },
  { id: 'workspace.session.rename', keys: ['desktop:windows:control+alt+KeyR', 'web:windows:control+shift+KeyR'] },
  { id: 'workspace.session.fork', keys: ['desktop:windows:control+alt+KeyF', 'web:windows:control+shift+KeyF'] },
  { id: 'workspace.session.archive', keys: ['desktop:windows:control+shift+KeyA', 'web:windows:control+alt+KeyA'] },
]

function spyTargets() {
  const calls = []
  const names = [
    'focusPanel', 'newConnection', 'closeTab', 'nextTab', 'prevTab', 'jumpTab',
    'clearTerminal', 'fontUp', 'fontDown', 'fontReset', 'historyPrev', 'historyNext', 'escape',
  ]
  const targets = { calls }
  for (const name of names) targets[name] = (arg) => calls.push({ name, arg })
  return targets
}

// ── the table ───────────────────────────────────────────────────────────────

test('the table covers every row of ICD §8.4', async () => {
  const { restore, module } = await loadChrome()
  try {
    const shortcuts = module('ssh.chrome.shortcuts')
    const ids = shortcuts.ALL.map((row) => row.id)
    for (const id of [
      'ssh.panel.focus', 'ssh.conn.new', 'ssh.tab.close', 'ssh.tab.next', 'ssh.tab.prev',
      'ssh.terminal.clear', 'ssh.font.up', 'ssh.font.down', 'ssh.font.reset',
      'ssh.history.prev', 'ssh.history.next', 'ssh.overlay.escape',
    ]) {
      assert.ok(ids.includes(id), `${id} is missing from the §8.4 table`)
    }
    // Ctrl/Cmd+1..9, one command per digit.
    for (let index = 1; index <= 9; index += 1) {
      assert.ok(ids.includes(`ssh.tab.jump${index}`), `jump-to-tab ${index} is missing`)
    }
    assert.equal(new Set(ids).size, ids.length, 'command ids must be unique')
    // Every shell-registered row declares a label the shell can localize.
    for (const row of shortcuts.ALL.filter((entry) => !entry.local)) {
      assert.match(row.labelKey, /^chrome\.cmd\./, `${row.id} needs a label key`)
      assert.ok(Array.isArray(row.regions) && row.regions.length > 0, `${row.id} needs regions`)
    }
  } finally {
    restore()
  }
})

test('every default is a code the shell accepts, and Web defaults are admissible', async () => {
  const { restore, module } = await loadChrome()
  try {
    const shortcuts = module('ssh.chrome.shortcuts')
    for (const row of shortcuts.ALL) {
      if (row.local) {
        assert.deepEqual(row.keys.modifiers, [], `${row.id} is a bare key`)
        continue
      }
      for (const [profile, binding] of Object.entries(row.defaults)) {
        const [runtime, platform] = profile.split(':')
        assert.ok(PROFILE_KEYS.includes(profile), `${row.id}: unknown profile ${profile}`)
        const normalized = normalizeBinding(binding, platform)
        if (runtime === 'web') {
          assert.equal(
            isWebBindingAllowed(normalized, platform),
            true,
            `${row.id}: ${profile} would be refused by the shell's Web rules`,
          )
          // A Web binding is delivered by a browser, so a single primary+letter never
          // reaches the page — that is exactly why the service refuses it.
          assert.ok(normalized.modifiers.length >= 2, `${row.id}: ${profile} needs two modifiers`)
        }
        assert.ok(binding.modifiers.length <= 4, `${row.id}: too many modifiers`)
      }
      // `web:linux` only admits the three fixed combinations, so nothing is bound there.
      assert.equal(Object.prototype.hasOwnProperty.call(row.defaults, 'web:linux'), false, `${row.id}: web:linux must stay unbound`)
    }
  } finally {
    restore()
  }
})

test('no default collides with a combination this DSH build already owns', async () => {
  const { restore, module } = await loadChrome()
  try {
    const shortcuts = module('ssh.chrome.shortcuts')
    const shipped = new Map()
    for (const row of SHIPPED_BINDINGS) for (const key of row.keys) shipped.set(key, row.id)

    const mine = new Map()
    for (const row of shortcuts.ALL) {
      if (row.local) continue
      for (const [profile, binding] of Object.entries(row.defaults)) {
        const [runtime, platform] = profile.split(':')
        const normalized = normalizeBinding(binding, platform)
        const key = `${runtime}:${platform}:${bindingKey(normalized)}`
        assert.equal(
          shipped.has(key),
          false,
          `${row.id} uses ${key}, which the shipped command ${shipped.get(key)} already owns`,
        )
        assert.equal(mine.has(key), false, `${row.id} overlaps ${mine.get(key)} on ${key}`)
        mine.set(key, row.id)
      }
    }
    // Asserting the substitute explicitly keeps the ICD deviation visible.
    const connNew = shortcuts.ALL.find((row) => row.id === 'ssh.conn.new')
    assert.equal(connNew.substituted, 'desktop:*')
    assert.equal(connNew.substitutionReason, 'browser.new')
    assert.deepEqual(connNew.defaults['desktop:windows'], { code: 'KeyT', modifiers: ['primary', 'shift'] })
  } finally {
    restore()
  }
})

// ── registration ────────────────────────────────────────────────────────────

test('commands are registered with the shell service, with regions and modals', async () => {
  const { restore, module } = await loadChrome()
  try {
    // The dictionary default follows the environment; state it instead of relying on it.
    document.documentElement.setAttribute('lang', 'en')
    const shortcuts = module('ssh.chrome.shortcuts')
    const service = fakeShortcutsService({ shipped: SHIPPED_BINDINGS })
    const targets = spyTargets()
    const result = shortcuts.registerShortcuts({ get: () => service }, targets, { service })

    assert.equal(result.ok, true)
    const byId = new Map(result.registrations.map((row) => [row.id, row]))
    for (const row of shortcuts.ALL.filter((entry) => !entry.local)) {
      assert.equal(byId.get(row.id).status, 'shell', `${row.id} should be registered by the shell`)
    }
    assert.equal(result.conflicts.length, 0)

    // The shell receives the localized label, the regions and an empty modal policy.
    const panel = service.calls.find((call) => call.id === 'ssh.panel.focus')
    assert.equal(typeof panel.label, 'function')
    assert.equal(panel.label(), 'Open or focus the SSH panel')
    assert.deepEqual(panel.regions, ['page', 'editable'])
    assert.deepEqual(panel.modals, [])
    assert.ok(panel.aliases.length > 0)

    // The terminal clear command is limited to the terminal region.
    const clear = service.calls.find((call) => call.id === 'ssh.terminal.clear')
    assert.deepEqual(clear.regions, ['terminal'])
  } finally {
    restore()
  }
})

test('resolve() runs the target action, and passes keys pressed outside our pane', async () => {
  const { restore, module } = await loadChrome()
  try {
    const shortcuts = module('ssh.chrome.shortcuts')
    const service = fakeShortcutsService({ shipped: SHIPPED_BINDINGS })
    const targets = spyTargets()
    shortcuts.registerShortcuts({ get: () => service }, targets, { service })

    const own = document.createElement('div')
    own.setAttribute('data-dsh-ssh-root', '1')
    document.body.appendChild(own)
    const foreign = document.createElement('div')
    foreign.className = 'xterm'
    document.body.appendChild(foreign)

    // "Focus the SSH panel" is global: it fires from anywhere.
    const focused = service.resolveFor('ssh.panel.focus', { target: foreign, region: 'page' })
    assert.equal(focused.status, 'handled')
    assert.deepEqual(targets.calls.at(-1), { name: 'focusPanel', arg: undefined })

    // "Clear the terminal" is pane-scoped: a shipped terminal keeps its own Ctrl+L.
    const passed = service.resolveFor('ssh.terminal.clear', { target: foreign, region: 'terminal' })
    assert.equal(passed.status, 'pass', 'a foreign terminal must not lose Ctrl+L')
    const handled = service.resolveFor('ssh.terminal.clear', { target: own, region: 'terminal' })
    assert.equal(handled.status, 'handled')
    assert.deepEqual(targets.calls.at(-1), { name: 'clearTerminal', arg: undefined })

    // Jump commands carry their index, so `Mod+3` selects the third tab.
    service.resolveFor('ssh.tab.jump3', { target: own, region: 'page' })
    assert.deepEqual(targets.calls.at(-1), { name: 'jumpTab', arg: 2 })

    // A target the host did not wire stays a no-op instead of an error.
    const empty = shortcuts.registerShortcuts({ get: () => service }, {}, { service })
    assert.equal(empty.ok, true)
    own.remove()
    foreign.remove()
  } finally {
    restore()
  }
})

test('a combination the shell refuses falls back to the documented alternative', async () => {
  const { restore, module } = await loadChrome()
  try {
    const shortcuts = module('ssh.chrome.shortcuts')
    const service = fakeShortcutsService({
      shipped: SHIPPED_BINDINGS,
      throwFor: (command) =>
        command.id === 'ssh.panel.focus' && command.defaults['desktop:windows'].modifiers.length === 2,
    })
    const result = shortcuts.registerShortcuts({ get: () => service }, spyTargets(), { service })
    const row = result.registrations.find((entry) => entry.id === 'ssh.panel.focus')
    assert.equal(row.status, 'shell')
    assert.equal(row.substituted, true)
    const call = service.calls.filter((entry) => entry.id === 'ssh.panel.focus').at(-1)
    assert.deepEqual(call.defaults['desktop:windows'].modifiers, ['primary', 'shift', 'alt'])
  } finally {
    restore()
  }
})

test('a command the shell refuses twice degrades to the scoped local listener', async () => {
  const { restore, module } = await loadChrome()
  try {
    const shortcuts = module('ssh.chrome.shortcuts')
    const service = fakeShortcutsService({ throwFor: (command) => command.id === 'ssh.tab.close' })
    const targets = spyTargets()
    const result = shortcuts.registerShortcuts({ get: () => service }, targets, { service })

    const row = result.registrations.find((entry) => entry.id === 'ssh.tab.close')
    assert.equal(row.status, 'conflict')
    assert.deepEqual(result.conflicts, ['ssh.tab.close'])

    const handler = shortcuts.createLocalKeyHandler(targets, { conflictIds: result.conflicts })
    const pane = document.createElement('div')
    pane.className = 'dsh-ssh-root'
    const outside = document.createElement('div')
    document.body.append(pane, outside)

    // Inside the pane the ICD combination still works; outside it does not.
    const inside = new window.KeyboardEvent('keydown', { key: 'w', code: 'KeyW', ctrlKey: true, bubbles: true })
    Object.defineProperty(inside, 'target', { value: pane })
    assert.equal(handler(inside), true)
    assert.deepEqual(targets.calls.at(-1), { name: 'closeTab', arg: undefined })

    const outsideEvent = new window.KeyboardEvent('keydown', { key: 'w', code: 'KeyW', ctrlKey: true, bubbles: true })
    Object.defineProperty(outsideEvent, 'target', { value: outside })
    assert.equal(handler(outsideEvent), false, 'the local fallback never steals a global key')
    pane.remove()
    outside.remove()
  } finally {
    restore()
  }
})

test('the bare keys are local: history inside an editable, Esc never inside a dialog', async () => {
  const { restore, module } = await loadChrome()
  try {
    const shortcuts = module('ssh.chrome.shortcuts')
    const targets = spyTargets()
    const handler = shortcuts.createLocalKeyHandler(targets, {})

    const pane = document.createElement('div')
    pane.className = 'dsh-ssh-root'
    const input = document.createElement('input')
    pane.appendChild(input)
    const terminal = document.createElement('div')
    terminal.className = 'xterm'
    const terminalInput = document.createElement('textarea')
    terminal.appendChild(terminalInput)
    const dialog = document.createElement('div')
    dialog.className = 'dsh-ssh-root dsh-ssh-confirm'
    const dialogInput = document.createElement('input')
    dialog.appendChild(dialogInput)
    document.body.append(pane, terminal, dialog)

    const fire = (node, key, code, extra = {}) => {
      const event = new window.KeyboardEvent('keydown', { key, code, bubbles: true, ...extra })
      Object.defineProperty(event, 'target', { value: node })
      return handler(event)
    }

    assert.equal(fire(input, 'ArrowUp', 'ArrowUp'), true)
    assert.deepEqual(targets.calls.at(-1), { name: 'historyPrev', arg: undefined })
    assert.equal(fire(input, 'ArrowDown', 'ArrowDown'), true)
    assert.deepEqual(targets.calls.at(-1), { name: 'historyNext', arg: undefined })

    // History belongs to the command input, not to a terminal.
    assert.equal(fire(terminalInput, 'ArrowUp', 'ArrowUp'), false)
    // The dialog owns its own Esc; the panel listener must not double-fire.
    assert.equal(fire(dialogInput, 'Escape', 'Escape'), false)
    assert.equal(fire(input, 'Escape', 'Escape'), true)
    assert.deepEqual(targets.calls.at(-1), { name: 'escape', arg: undefined })
    // A key nobody claimed is left alone.
    assert.equal(fire(input, 'a', 'KeyA'), false)

    pane.remove()
    terminal.remove()
    dialog.remove()
  } finally {
    restore()
  }
})

test('with no shortcuts service the chrome still installs and keeps its local keys', async () => {
  const { restore, module } = await loadChrome()
  try {
    const shortcuts = module('ssh.chrome.shortcuts')
    const result = shortcuts.registerShortcuts({ get: () => undefined }, spyTargets(), {})
    assert.equal(result.ok, false)
    assert.equal(result.service, null)
    assert.ok(result.registrations.length > 0)
    for (const row of result.registrations) assert.equal(row.status, 'unavailable')
    assert.equal(result.conflicts.length, result.registrations.length, 'the local listener takes them all')
    assert.equal(typeof result.dispose, 'function')
    result.dispose()
  } finally {
    restore()
  }
})

// ── reference & matching ────────────────────────────────────────────────────

test('describeShortcuts renders keycaps, groups and the substitution note', async () => {
  const { restore, module } = await loadChrome()
  try {
    document.documentElement.setAttribute('lang', 'en')
    const shortcuts = module('ssh.chrome.shortcuts')
    const i18n = module('ssh.i18n').createI18n({})
    i18n.setLocale('en')
    const service = fakeShortcutsService({ shipped: SHIPPED_BINDINGS })
    const result = shortcuts.registerShortcuts({ get: () => service }, spyTargets(), { service, i18n })

    const rows = shortcuts.describeShortcuts({ i18n, service, registrations: result.registrations })
    const byId = new Map(rows.map((row) => [row.id, row]))
    assert.deepEqual(byId.get('ssh.tab.close').keys, ['Ctrl', 'W'])
    assert.deepEqual(byId.get('ssh.panel.focus').keys, ['Ctrl', 'Shift', 'S'])
    assert.deepEqual(byId.get('ssh.tab.next').keys, ['Ctrl', 'Tab'])
    assert.equal(byId.get('ssh.history.prev').keys[0], '\u2191')
    assert.equal(byId.get('ssh.history.prev').source, 'local')
    assert.match(byId.get('ssh.conn.new').note, /browser\.new/, 'the ICD deviation is advertised, not hidden')
    assert.equal(byId.get('ssh.tab.close').source, 'shell')
    assert.equal(byId.get('ssh.tab.jump3').label, 'Jump to tab 3')

    // macOS uses glyphs, and the platform comes from the shell rather than a guess.
    const mac = shortcuts.describeShortcuts({
      i18n,
      service: { ...service, platform: 'macos' },
      registrations: result.registrations,
    })
    assert.deepEqual(mac.find((row) => row.id === 'ssh.tab.close').keys, ['\u2318', 'W'])

    const html = renderToStaticMarkup(React.createElement(shortcuts.ShortcutHelp, { open: true, onClose: () => {}, bindings: rows }))
    assert.match(html, /data-testid="ssh-shortcut-help"/)
    assert.match(html, /data-testid="ssh-shortcut-group-session"/)
    assert.match(html, /<kbd class="dsh-ssh-shortcuts-key">Ctrl<\/kbd>/)
    assert.match(html, /data-source="local"/)
    assert.equal(renderToStaticMarkup(React.createElement(shortcuts.ShortcutHelp, { open: false, bindings: rows })), '')
  } finally {
    restore()
  }
})

test('ShortcutHelp closes on Escape and on its close button', async () => {
  const { restore, module } = await loadChrome()
  try {
    const shortcuts = module('ssh.chrome.shortcuts')
    let closes = 0
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const rows = shortcuts.describeShortcuts()
    await act(async () => {
      root.render(React.createElement(shortcuts.ShortcutHelp, { open: true, onClose: () => { closes += 1 }, bindings: rows }))
    })
    try {
      const dialog = container.querySelector('.dsh-ssh-shortcuts')
      await act(async () => {
        dialog.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))
      })
      assert.equal(closes, 1)
      await act(async () => {
        container.querySelector('[data-testid="ssh-shortcut-close"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      })
      assert.equal(closes, 2)
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  } finally {
    restore()
  }
})

test('matchesBinding requires the physical code and exactly the declared modifiers', async () => {
  const { restore, module } = await loadChrome()
  try {
    const shortcuts = module('ssh.chrome.shortcuts')
    const binding = { code: 'KeyW', modifiers: ['primary'] }
    assert.equal(shortcuts.matchesBinding({ code: 'KeyW', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }, binding), true)
    assert.equal(shortcuts.matchesBinding({ code: 'KeyW', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false }, binding), false)
    assert.equal(shortcuts.matchesBinding({ code: 'KeyT', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }, binding), false)
    assert.equal(shortcuts.matchesBinding({ code: 'KeyW' }, binding), false)
    assert.equal(shortcuts.matchesBinding({ code: 'KeyW', ctrlKey: true }, null), false)
  } finally {
    restore()
  }
})

test('isInsideSsh recognises only our own chrome', async () => {
  const { restore, module } = await loadChrome()
  try {
    const shortcuts = module('ssh.chrome.shortcuts')
    const pane = document.createElement('div')
    pane.setAttribute('data-dsh-ssh-root', '1')
    const chip = document.createElement('span')
    pane.appendChild(chip)
    const marked = document.createElement('div')
    marked.className = 'dsh-ssh-chrome'
    const inside = document.createElement('button')
    marked.appendChild(inside)
    const foreign = document.createElement('div')
    document.body.append(pane, marked, foreign)

    assert.equal(shortcuts.isInsideSsh(chip), true)
    assert.equal(shortcuts.isInsideSsh(inside), true)
    assert.equal(shortcuts.isInsideSsh(foreign), false)
    assert.equal(shortcuts.isInsideSsh(null), false)
    pane.remove()
    marked.remove()
    foreign.remove()
  } finally {
    restore()
  }
})
