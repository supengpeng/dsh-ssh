/**
 * Chrome component, i18n and theme tests (SP7).
 *
 * These run against the **assembled artifact** — the same `lib/client.js` DSH serves —
 * with a one-line, asserted hook (`exports.__ssh = SSH`) that lets the test reach the
 * bundle's own module registry. That is how the ICD's client test layer is described
 * (Node + React + linkedom, loading the assembled bundle under a stub
 * `__ModuleLoader__`), and it means a component is never tested through a private copy
 * of the assembler's semantics.
 *
 * Everything here is deliberately user-visible behaviour: rendered attributes, clicks,
 * typing, and the two acceptance items that are easy to regress — the type-to-confirm
 * gate on dangerous operations, and `pointer-events: auto` on a `shell.overlay`
 * occupant.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { test } from 'node:test'

import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'

import { BUNDLE_PATH, fakeContext, fakeLocale, fakeSlots, fakeTabRegistry, installDom } from './harness.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const CHROME_DIR = join(ROOT, 'client', 'src', 'chrome')

/** linkedom has no MouseEvent/KeyboardEvent; React needs them to build a synthetic event. */
function installEventPolyfills(win) {
  if (typeof win.MouseEvent !== 'function') {
    win.MouseEvent = class MouseEventPolyfill extends win.Event {
      constructor(type, init = {}) {
        super(type, init)
        this.button = init.button ?? 0
        this.buttons = init.buttons ?? 0
        this.detail = init.detail ?? 1
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
  if (typeof win.KeyboardEvent !== 'function') {
    win.KeyboardEvent = class KeyboardEventPolyfill extends win.Event {
      constructor(type, init = {}) {
        super(type, init)
        this.key = init.key ?? ''
        this.code = init.code ?? ''
        this.repeat = !!init.repeat
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
  if (typeof win.getComputedStyle !== 'function') {
    win.getComputedStyle = () => ({ getPropertyValue: () => '' })
  }
  for (const key of ['navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle']) {
    const value = win[key]
    if (value === undefined) continue
    try {
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
    } catch {
      /* a read-only global is not worth failing a test over */
    }
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
}

/**
 * Load the built bundle and expose its module registry.
 *
 * The epilogue is owned by another module, so the hook is a strict assertion: if that
 * line is ever renamed this test fails loudly instead of silently testing nothing.
 */
async function loadChrome() {
  const restore = installDom()
  installEventPolyfills(globalThis.window)

  const source = readFileSync(BUNDLE_PATH, 'utf8')
  const anchor = 'exports.apply = plugin.apply'
  assert.ok(source.includes(anchor), 'bundle epilogue changed: the chrome test needs its registry hook')
  const patched = source.replace(anchor, `${anchor}\n    exports.__ssh = SSH`)

  const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-chrome-'))
  const copy = join(dir, 'client.mjs')
  writeFileSync(copy, patched, 'utf8')

  const rows = []
  globalThis.window.__ModuleLoader__ = { load: (row) => rows.push(row) }
  await import(`${pathToFileURL(copy).href}?v=${Date.now()}`)
  assert.equal(rows.length, 1, 'one package row')
  const exported = rows[0].factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected external require(${specifier})`)
  })
  const ssh = exported.__ssh
  assert.ok(ssh && typeof ssh.require === 'function', 'the bundle registry is reachable')

  return {
    restore,
    exports: exported,
    registry: ssh,
    module: (name) => ssh.require(name),
  }
}

/** Native value setter: React's synthetic `onChange` is not delivered under linkedom. */
function setNativeValue(element, value) {
  let proto = Object.getPrototypeOf(element)
  while (proto) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
    if (descriptor && descriptor.set) {
      descriptor.set.call(element, value)
      return true
    }
    proto = Object.getPrototypeOf(proto)
  }
  element.value = value
  return false
}

/** Mount a tree into the live document and return interaction helpers. */
async function mount(element) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(element)
  })
  return {
    container,
    html: () => container.innerHTML,
    find: (selector) => container.querySelector(selector),
    findAll: (selector) => [...container.querySelectorAll(selector)],
    async click(node) {
      assert.ok(node, 'click target must exist')
      await act(async () => {
        node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      })
    },
    async type(node, value) {
      assert.ok(node, 'type target must exist')
      setNativeValue(node, value)
      await act(async () => {
        node.dispatchEvent(new window.Event('input', { bubbles: true }))
      })
    },
    async key(node, key, init = {}) {
      await act(async () => {
        node.dispatchEvent(
          new window.KeyboardEvent('keydown', { key, code: init.code || key, bubbles: true, ...init }),
        )
      })
    },
    async unmount() {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    },
  }
}

// ── the artifact ────────────────────────────────────────────────────────────

test('the built bundle ships every chrome module', async () => {
  const { restore, registry } = await loadChrome()
  try {
    const names = registry.names()
    for (const name of [
      'ssh.i18n',
      'ssh.i18n.dict',
      'ssh.chrome.theme',
      'ssh.chrome.theme.css',
      'ssh.chrome.toast',
      'ssh.chrome.confirm',
      'ssh.chrome.tabs',
      'ssh.chrome.statusbar',
      'ssh.chrome.shortcuts',
      'ssh.chrome',
    ]) {
      assert.ok(names.includes(name), `${name} missing from the bundle`)
    }
  } finally {
    restore()
  }
})

test('every chrome source declares its own ssh.* module name', () => {
  const files = readdirSync(CHROME_DIR).filter((name) => name.endsWith('.js'))
  assert.ok(files.length >= 8, `expected the chrome modules, saw ${files.length}`)
  const seen = new Set()
  for (const file of files) {
    const source = readFileSync(join(CHROME_DIR, file), 'utf8')
    const match = /^[ \t]*(?:\/\/|\*)[ \t]*@module[ \t]+(\S+)/m.exec(source)
    assert.ok(match, `${file} has no @module header`)
    assert.match(match[1], /^ssh\.[a-z][a-z0-9.]*$/, `${file} must use the ssh.* namespace`)
    assert.ok(source.includes(`SSH.define('${match[1]}'`), `${file} must define ${match[1]}`)
    assert.ok(!seen.has(match[1]), `duplicate module name ${match[1]}`)
    seen.add(match[1])
  }
})

test('every chrome source parses, with no replacement characters', async () => {
  // The assembler now rejects U+FFFD damage and an unparsable bundle (added after an
  // encoding accident put a corrupted module into `lib/client.js`). What this adds is
  // the local half the assembler does not cover: my own scope checked before a build,
  // plus `theme.css` and the locale JSON, which never pass through the assembler at all.
  const vm = await import('node:vm')
  const files = readdirSync(CHROME_DIR).filter((name) => name.endsWith('.js'))
  for (const file of [...files.map((name) => join(CHROME_DIR, name)), join(ROOT, 'client', 'src', 'theme.css')]) {
    const source = readFileSync(file, 'utf8')
    assert.equal((source.match(/\uFFFD/g) ?? []).length, 0, `${file} contains U+FFFD (lossy re-encode)`)
    if (file.endsWith('.js')) new vm.Script(source, { filename: file })
  }
  for (const locale of ['zh', 'en']) {
    const file = join(ROOT, 'locale', `${locale}.json`)
    const source = readFileSync(file, 'utf8')
    assert.equal((source.match(/\uFFFD/g) ?? []).length, 0, `${file} contains U+FFFD`)
    JSON.parse(source)
  }
})

test('no source declares the same function twice in one scope', () => {
  // A second `function t() {}` at the same indentation inside the same factory silently
  // wins over the first (hoisting keeps the last assignment), so an added helper can be
  // shadowed by a stale one and only the *behaviour* regresses — no syntax error, no
  // lint error, no failing unit test. That is exactly how `t()` lost its
  // shell-dictionary fallback while the new code sat right above it.
  const offenders = []
  for (const name of readdirSync(CHROME_DIR).filter((file) => file.endsWith('.js'))) {
    const source = readFileSync(join(CHROME_DIR, name), 'utf8')
    const seen = new Map()
    for (const match of source.matchAll(/^(\s*)function (\w+)\s*\(/gm)) {
      const key = `${match[1].length}:${match[2]}`
      seen.set(key, (seen.get(key) ?? 0) + 1)
    }
    for (const [key, count] of seen) {
      if (count > 1) offenders.push(`${name}: function ${key.split(':')[1]} declared ${count}× at depth ${key.split(':')[0]}`)
    }
  }
  assert.deepEqual(offenders, [])
})

// ── i18n ────────────────────────────────────────────────────────────────────

test('the bundled locale mirror matches locale/{zh,en}.json byte for byte', async () => {
  const { restore, module } = await loadChrome()
  try {
    const zh = JSON.parse(readFileSync(join(ROOT, 'locale', 'zh.json'), 'utf8'))
    const en = JSON.parse(readFileSync(join(ROOT, 'locale', 'en.json'), 'utf8'))
    const dict = module('ssh.i18n.dict')

    assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'ICD §8.5: the key sets must be equal')
    assert.deepEqual(dict.dictionaries.zh, zh)
    assert.deepEqual(dict.dictionaries.en, en)
    assert.deepEqual(dict.KEYS, Object.keys(zh).sort(), 'the mirror keys must be the generated order')
  } finally {
    restore()
  }
})

test('the locale mirror is regenerated from the JSON pair', async () => {
  const generator = await import(pathToFileURL(join(CHROME_DIR, 'gen-locale.mjs')).href)
  const onDisk = readFileSync(join(CHROME_DIR, 'locale.gen.js'), 'utf8')
  assert.equal(onDisk, generator.expectedMirror(), 'run `node client/src/chrome/gen-locale.mjs`')
})

test('every ICD §8.5 key and every §5 error code is present in both locales', () => {
  const zh = JSON.parse(readFileSync(join(ROOT, 'locale', 'zh.json'), 'utf8'))
  const en = JSON.parse(readFileSync(join(ROOT, 'locale', 'en.json'), 'utf8'))
  const required = [
    'tab.title', 'panel.title', 'panel.toggle',
    'conn.list.empty', 'conn.list.search', 'conn.list.group', 'conn.new', 'conn.edit', 'conn.delete',
    'conn.duplicate', 'conn.test', 'conn.connect', 'conn.disconnect',
    'conn.confirm.delete', 'conn.test.ok', 'conn.test.fail',
    'ws.tabs.terminal', 'ws.tabs.command', 'ws.tabs.files', 'ws.tabs.logs',
    'ws.term.clear', 'ws.term.copy', 'ws.term.paste', 'ws.term.fontUp', 'ws.term.fontDown',
    'ws.term.reconnect', 'ws.term.reconnected',
    'ws.cmd.placeholder', 'ws.cmd.run', 'ws.cmd.cancel', 'ws.cmd.clear', 'ws.cmd.exitCode',
    'ws.cmd.stdout', 'ws.cmd.stderr', 'ws.cmd.duration', 'ws.cmd.history',
    'ws.files.local', 'ws.files.remote', 'ws.files.upload', 'ws.files.download', 'ws.files.mkdir',
    'ws.files.rename', 'ws.files.delete', 'ws.files.chmod', 'ws.files.refresh', 'ws.files.hidden',
    'ws.files.overwrite', 'ws.files.progress',
    'ws.logs.level', 'ws.logs.clear', 'ws.logs.export', 'ws.logs.empty',
    'status.rtt', 'status.uptime', 'status.traffic', 'status.disconnected',
    'confirm.danger.title', 'confirm.danger.body', 'confirm.danger.typeToConfirm',
    'toast.copied', 'toast.copiedFailed', 'toast.saved', 'toast.deleted', 'toast.uploaded', 'toast.downloaded',
  ]
  for (const field of ['name', 'host', 'port', 'user', 'auth', 'password', 'privateKey', 'passphrase', 'timeout', 'keepalive', 'group', 'tags']) {
    required.push(`conn.field.${field}`)
  }
  for (const method of ['password', 'privateKey', 'agent']) required.push(`conn.auth.${method}`)
  for (const key of ['show', 'hide', 'present', 'absent', 'fromEnv']) required.push(`conn.secret.${key}`)
  for (const state of ['idle', 'connecting', 'authenticating', 'connected', 'closing', 'closed', 'error']) {
    required.push(`conn.state.${state}`)
  }
  // ICD §5, the complete error-code table.
  const codes = [
    'SSH_NET_UNREACHABLE', 'SSH_NET_REFUSED', 'SSH_NET_DNS', 'SSH_NET_RESET', 'SSH_NET_TIMEOUT',
    'SSH_AUTH_FAILED', 'SSH_AUTH_METHOD_UNSUPPORTED', 'SSH_AUTH_KEY_UNREADABLE',
    'SSH_AUTH_PASSPHRASE_REQUIRED', 'SSH_AUTH_AGENT_UNAVAILABLE', 'SSH_HOSTKEY_UNKNOWN',
    'SSH_HOSTKEY_MISMATCH', 'SSH_TIMEOUT_CONNECT', 'SSH_TIMEOUT_OPERATION', 'SSH_TIMEOUT_IDLE',
    'SSH_CMD_EXIT_NONZERO', 'SSH_SFTP_PROTOCOL', 'SSH_SFTP_NO_SUCH_FILE', 'SSH_SFTP_TARGET_EXISTS',
    'SSH_SFTP_IS_A_DIRECTORY', 'SSH_SFTP_DISK_FULL', 'SSH_SFTP_VERIFY_MISMATCH',
    'SSH_SFTP_TRANSFER_ABORTED', 'SSH_PERM_DENIED', 'SSH_PERM_LOCAL_DENIED',
    'SSH_LIMIT_POOL_EXHAUSTED', 'SSH_LIMIT_QUEUE_FULL', 'SSH_LIMIT_OUTPUT_TRUNCATED',
    'SSH_CFG_INVALID', 'SSH_STATE_INVALID', 'SSH_CANCELLED', 'SSH_UNKNOWN',
  ]
  assert.equal(codes.length, 32, 'the §5 table has 32 codes')
  for (const code of codes) required.push(`err.${code}`)

  const missingZh = required.filter((key) => typeof zh[key] !== 'string')
  const missingEn = required.filter((key) => typeof en[key] !== 'string')
  assert.deepEqual(missingZh, [], 'missing Chinese keys')
  assert.deepEqual(missingEn, [], 'missing English keys')
  // A placeholder used in one language but not the other means a silent render bug.
  for (const key of Object.keys(zh)) {
    const zhParams = [...zh[key].matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
    const enParams = [...en[key].matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
    assert.deepEqual(zhParams, enParams, `placeholder mismatch for ${key}`)
  }
})

test('the translator follows override → service → environment, and interpolates', async () => {
  const { restore, module } = await loadChrome()
  try {
    const i18n = module('ssh.i18n')
    const service = {
      id: 'zh-CN',
      getSnapshot: () => ({ id: 'zh-CN' }),
      subscribe: () => () => {},
    }
    const instance = i18n.createI18n({ service })
    assert.equal(instance.getLocale(), 'zh')
    assert.equal(instance.t('conn.new'), '新建连接')

    instance.setLocale('en')
    assert.equal(instance.getLocale(), 'en')
    assert.equal(instance.t('conn.new'), 'New connection')
    assert.equal(window.localStorage.getItem(i18n.STORAGE_KEY), 'en')

    // Interpolation, and an unknown placeholder left visible rather than blanked.
    assert.equal(instance.t('status.rtt', { ms: 42 }), 'RTT 42 ms')
    assert.equal(instance.t('status.rtt', {}).includes('{ms}'), true)
    // A missing key renders as itself: a typo must be visible in the UI.
    assert.equal(instance.t('nope.not.a.key'), 'nope.not.a.key')
    // Error codes resolve through the §5 table.
    assert.equal(instance.t('err.SSH_AUTH_FAILED'), 'Authentication failed: user, password or key was rejected')

    // 'auto' clears the override and falls back to the service.
    instance.setLocale('auto')
    assert.equal(instance.getLocale(), 'zh')
    assert.equal(window.localStorage.getItem(i18n.STORAGE_KEY), null)
  } finally {
    restore()
  }
})

test('registerLocale hands both dictionaries to the shell and is reversible', async () => {
  const { restore, module } = await loadChrome()
  try {
    const i18n = module('ssh.i18n')
    const registrations = []
    const effects = []
    let disposed = 0
    const ctx = {
      get: (name) => (name === 'locale' ? {
        register(namespace, dict) {
          registrations.push({ namespace, dict })
          return () => {
            disposed += 1
          }
        },
      } : undefined),
      // Cordis owns an effect through the callback's return value.
      effect: (callback, label) => {
        const disposer = callback()
        effects.push({ label, dispose: typeof disposer === 'function' ? disposer : () => {} })
      },
    }
    const result = i18n.registerLocale(ctx)
    assert.equal(result.ok, true)
    assert.equal(registrations.length, 1)
    assert.equal(registrations[0].namespace, 'ssh')
    assert.deepEqual(Object.keys(registrations[0].dict).sort(), ['en', 'zh'])
    assert.equal(effects.length, 1)
    effects[0].dispose()
    assert.equal(disposed, 1, 'unloading the plugin must unregister the dictionaries')
  } finally {
    restore()
  }
})

test('a repeated registration (hot reload) still reports success', async () => {
  // The live panel is hot-reloaded while the previous apply() is still mounted, so the
  // shell refuses a second registration of `ssh` + `zh`. Treating that as a failure is
  // what made the dictionary look absent and every string render as its key name.
  const { restore, module } = await loadChrome()
  try {
    const i18n = module('ssh.i18n')
    let calls = 0
    const ctx = {
      get: (name) => (name === 'locale' ? {
        register() {
          calls += 1
          if (calls > 1) throw new Error('locale namespace "ssh" already has locale "zh"')
          return () => {}
        },
      } : undefined),
      effect: (callback) => {
        callback()
      },
    }
    assert.equal(i18n.registerLocale(ctx).ok, true)
    const second = i18n.registerLocale(ctx)
    assert.equal(second.ok, true, 'a hot reload must not be reported as a locale failure')
    assert.equal(calls, 2)
    // A genuine failure still surfaces.
    const broken = {
      get: () => ({ register() { throw new Error('boom') } }),
      effect: (callback) => callback(),
    }
    assert.throws(() => i18n.registerLocale(broken), /boom/)
  } finally {
    restore()
  }
})

test('the translation surface every other module probes answers', async () => {
  // This is the regression that produced `panel.title` / `conn.new` in the live panel:
  // three lookup conventions exist in this package, and all three have to resolve.
  const { restore, registry, module } = await loadChrome()
  try {
    document.documentElement.setAttribute('lang', 'en')

    // 1. `conn/ui.js` probes `ssh.chrome.i18n.t`; loading it also publishes the
    //    registry-level slot the session kit probes first (the plugin body requires
    //    this module during apply(), before any component renders).
    const chrome = module('ssh.chrome')
    assert.equal(typeof chrome.i18n.t, 'function', 'ssh.chrome.i18n.t must exist')
    assert.equal(typeof registry.i18n, 'function', 'SSH.i18n must be a callable translator')

    // 2. `ssh.i18n.t` is the second convention, and works on its own.
    const i18nModule = module('ssh.i18n')
    assert.equal(typeof i18nModule.t, 'function', 'ssh.i18n.t must exist')
    assert.equal(i18nModule.t('conn.new'), 'New connection')

    // Every key from the broken panel, through all three conventions.
    const keys = ['panel.title', 'status.disconnected', 'conn.new', 'conn.list.search', 'conn.list.empty']
    for (const key of keys) {
      const throughChrome = chrome.i18n.t(key)
      const throughModule = i18nModule.t(key)
      const throughRegistry = registry.i18n(key)
      assert.notEqual(throughChrome, key, `ssh.chrome.i18n.t("${key}") fell back to the key name`)
      assert.equal(throughModule, throughChrome)
      assert.equal(throughRegistry, throughChrome)
    }
    // The keys the panel used that the session kit's local dictionary does not carry.
    assert.equal(chrome.i18n.t('panel.title'), 'SSH sessions')
    assert.equal(chrome.i18n.t('conn.list.empty').startsWith('No connection profiles'), true)

    // Parameters interpolate through every path too.
    assert.equal(chrome.i18n.t('status.rtt', { ms: 12 }), 'RTT 12 ms')
    assert.equal(registry.i18n('status.rtt', { ms: 12 }), 'RTT 12 ms')

    // The self check is what the installer logs; it must tell the truth.
    assert.deepEqual(i18nModule.selfCheck('conn.new').translated, true)
    assert.deepEqual(i18nModule.selfCheck('not.a.key').translated, false)
  } finally {
    restore()
  }
})

test('a key another module registered under `ssh` resolves through the shell', async () => {
  // `plugin.js` registers its own small M0 dictionary with the shell's locale service
  // (it carries `spike.title`). Our table stays the frozen §8.5 set, so the only way
  // that key can render as a sentence is by asking the shell after our own lookup
  // misses — which is exactly what the live panel showed as the bare key `spike.title`.
  const { restore, module } = await loadChrome()
  try {
    const i18n = module('ssh.i18n')
    const dictionaries = new Map([['ssh', {
      zh: { 'spike.title': 'SSH 插件 · 传输探针' },
      en: { 'spike.title': 'SSH plugin · transport spike' },
    }]])
    const service = {
      id: 'en',
      getSnapshot: () => ({ id: 'en' }),
      subscribe: () => () => {},
      bind: (namespace) => (key) => dictionaries.get(namespace)?.['en'][key] ?? key,
      register: () => () => {},
    }
    const instance = i18n.createI18n({ service })

    assert.equal(instance.t('spike.title'), 'SSH plugin · transport spike', 'the shell dictionary must be consulted')
    assert.equal(instance.t('panel.title'), 'SSH sessions', 'our own table still wins')
    // A key nobody registers still surfaces as itself.
    assert.equal(instance.t('nobody.registered.this'), 'nobody.registered.this')
    // A service without `bind` (or one that throws) must not break the lookup.
    const hostile = i18n.createI18n({ service: { getSnapshot: () => ({ id: 'en' }), bind: () => { throw new Error('nope') } } })
    assert.equal(hostile.t('conn.new'), 'New connection')
    assert.equal(hostile.t('spike.title'), 'spike.title')
  } finally {
    restore()
  }
})

// ── theme ───────────────────────────────────────────────────────────────────

test('every chrome colour comes from a --dsw-* token', async () => {
  const { restore, module } = await loadChrome()
  try {
    const theme = module('ssh.chrome.theme')
    const css = readFileSync(join(ROOT, 'client', 'src', 'theme.css'), 'utf8')
    assert.deepEqual(theme.findHardcodedColours(css), [], 'client/src/theme.css has a literal colour')
    assert.deepEqual(theme.findHardcodedColours(theme.CSS), [], 'the bundled stylesheet has a literal colour')

    // Only ICD §8.6 tokens may be referenced.
    for (const token of theme.referencedTokens(css)) {
      assert.ok(theme.TOKENS.includes(token), `${token} is not an ICD §8.6 token`)
    }

    for (const file of readdirSync(CHROME_DIR).filter((name) => name.endsWith('.js'))) {
      const source = readFileSync(join(CHROME_DIR, file), 'utf8')
      assert.deepEqual(theme.findHardcodedColours(source), [], `${file} has a literal colour`)
    }
  } finally {
    restore()
  }
})

test('the bundled stylesheet is regenerated from client/src/theme.css', async () => {
  const generator = await import(pathToFileURL(join(CHROME_DIR, 'gen-theme.mjs')).href)
  const onDisk = readFileSync(join(CHROME_DIR, 'theme.gen.js'), 'utf8')
  assert.equal(onDisk, generator.expectedMirror(), 'run `node client/src/chrome/gen-theme.mjs`')
})

test('the overlay occupants claim pointer events (M0-SPIKE §4 C4)', async () => {
  const { restore, module } = await loadChrome()
  try {
    const css = module('ssh.chrome.theme').CSS
    const rule = (selector) => {
      const match = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css)
      return match ? match[1] : ''
    }
    // The stack itself stays click-through; its cards and the dialogs opt back in.
    assert.match(rule('.dsh-ssh-toasts'), /pointer-events:\s*none/)
    assert.match(rule('.dsh-ssh-toast'), /pointer-events:\s*auto/)
    assert.match(rule('.dsh-ssh-confirm-backdrop'), /pointer-events:\s*auto/)
    assert.match(rule('.dsh-ssh-shortcuts-backdrop'), /pointer-events:\s*auto/)
  } finally {
    restore()
  }
})

test('the terminal font size persists under dsh-ssh.termFontSize and clamps', async () => {
  const { restore, module } = await loadChrome()
  try {
    const theme = module('ssh.chrome.theme')
    assert.equal(theme.TERM_FONT_SIZE_KEY, 'dsh-ssh.termFontSize')
    assert.equal(theme.clampTermFontSize(13), 13)
    assert.equal(theme.clampTermFontSize(1000), theme.MAX_TERM_FONT_SIZE)
    assert.equal(theme.clampTermFontSize(1), theme.MIN_TERM_FONT_SIZE)
    assert.equal(theme.clampTermFontSize('nonsense'), theme.DEFAULT_TERM_FONT_SIZE)

    const controller = theme.createFontController()
    let notifications = 0
    controller.subscribe(() => {
      notifications += 1
    })
    assert.equal(controller.getSize(), theme.DEFAULT_TERM_FONT_SIZE)
    assert.equal(controller.step(2), 15)
    assert.equal(controller.step(-100), theme.MIN_TERM_FONT_SIZE)
    assert.equal(window.localStorage.getItem(theme.TERM_FONT_SIZE_KEY), String(theme.MIN_TERM_FONT_SIZE))
    assert.equal(controller.reset(), theme.DEFAULT_TERM_FONT_SIZE)
    assert.ok(notifications >= 3, 'every size change notifies the terminal')
  } finally {
    restore()
  }
})

// ── toasts ──────────────────────────────────────────────────────────────────

test('ToastStack renders nothing when idle and a pointer-events card per toast', async () => {
  const { restore, module } = await loadChrome()
  try {
    const toast = module('ssh.chrome.toast')
    assert.equal(renderToStaticMarkup(React.createElement(toast.ToastStack, { toasts: [] })), '')

    const toasts = [
      { id: 'toast_1', kind: 'success', text: 'Saved' },
      { id: 'toast_2', kind: 'error', text: 'Boom', detail: 'SSH_NET_REFUSED: connection refused' },
    ]
    const view = await mount(React.createElement(toast.ToastStack, { toasts, onClose: () => {} }))
    try {
      const stack = view.find('[data-testid="ssh-toasts"]')
      assert.ok(stack, 'stack renders')
      assert.equal(stack.className, 'dsh-ssh-toasts')
      const cards = view.findAll('.dsh-ssh-toast')
      assert.equal(cards.length, 2)
      assert.equal(cards[0].getAttribute('data-kind'), 'success')
      assert.equal(cards[1].getAttribute('data-kind'), 'error')
      assert.equal(cards[1].getAttribute('role'), 'alert', 'errors are announced')
      assert.equal(view.find('[data-testid="ssh-toast-expand-toast_2"]') !== null, true, 'details are expandable')
      assert.equal(view.find('[data-testid="ssh-toast-close-toast_1"]') !== null, true)

      // Expanding reveals the technical detail without changing the headline.
      await view.click(view.find('[data-testid="ssh-toast-expand-toast_2"]'))
      assert.match(view.html(), /SSH_NET_REFUSED: connection refused/)
    } finally {
      await view.unmount()
    }
  } finally {
    restore()
  }
})

test('the toast controller caps, de-duplicates by id and reports errors from a code', async () => {
  const { restore, module } = await loadChrome()
  try {
    const toast = module('ssh.chrome.toast')
    const controller = toast.createToastController({ max: 3 })
    controller.push({ id: 'a', kind: 'info', text: 'one', ttlMs: 0 })
    controller.push({ id: 'b', kind: 'info', text: 'two', ttlMs: 0 })
    controller.push({ id: 'c', kind: 'info', text: 'three', ttlMs: 0 })
    controller.push({ id: 'd', kind: 'info', text: 'four', ttlMs: 0 })
    assert.deepEqual(controller.list().map((row) => row.id), ['b', 'c', 'd'], 'oldest is dropped at the cap')

    controller.push({ id: 'c', kind: 'warn', text: 'three again', ttlMs: 0 })
    assert.equal(controller.size(), 3, 'a repeated id replaces instead of appending')
    assert.equal(controller.list().find((row) => row.id === 'c').kind, 'warn')
    assert.deepEqual(controller.list().map((row) => row.id), ['b', 'c', 'd'], 'replacement keeps its position')

    assert.equal(controller.dismiss('b'), true)
    assert.equal(controller.dismiss('nope'), false)
    controller.dispose()

    // A rejected payload is a programming error, not a silent no-op.
    assert.throws(() => controller.push({ kind: 'info' }), /requires \{ text \}/)

    const error = Object.assign(new Error('connect ECONNREFUSED'), { code: 'SSH_NET_REFUSED' })
    const payload = toast.toastFromError(error)
    assert.equal(payload.kind, 'error')
    assert.equal(payload.detail, 'connect ECONNREFUSED')
    assert.ok(payload.text.length > 0 && !payload.text.startsWith('err.'))
  } finally {
    restore()
  }
})

// ── tab strip ───────────────────────────────────────────────────────────────

const TABS = [
  { id: 't1', sessionId: 's1', title: 'prod-web', state: 'connected' },
  { id: 't2', sessionId: 's2', title: 'db-01', state: 'connecting' },
  { id: 't3', sessionId: 's3', title: 'staging', state: 'error' },
]

test('TabStrip renders a state dot per tab and marks the active one', async () => {
  const { restore, module } = await loadChrome()
  try {
    const tabs = module('ssh.chrome.tabs')
    const html = renderToStaticMarkup(
      React.createElement(tabs.TabStrip, { tabs: TABS, activeId: 't2', onChange: () => {} }),
    )
    assert.match(html, /data-testid="ssh-tabstrip"/)
    assert.match(html, /role="tablist"/)
    assert.match(html, /data-state="connected"/)
    assert.match(html, /data-state="connecting"/)
    assert.match(html, /data-state="error"/)
    assert.match(html, /data-active="true"[^>]*data-index="1"|data-index="1"[^>]*data-active="true"/)
    assert.match(html, /aria-selected="true"/)
    assert.match(html, /prod-web/)
    assert.equal(html.includes('#'), false, 'no literal colour may reach the markup')
  } finally {
    restore()
  }
})

test('TabStrip reports selection, reorder and empty state', async () => {
  const { restore, module } = await loadChrome()
  try {
    const tabs = module('ssh.chrome.tabs')
    const selected = []
    const reordered = []
    const view = await mount(
      React.createElement(tabs.TabStrip, {
        tabs: TABS,
        activeId: 't1',
        onChange: (tab) => selected.push(tab.id),
        onReorder: (payload) => reordered.push(payload),
        confirmDanger: false,
      }),
    )
    try {
      await view.click(view.find('[data-testid="ssh-tab-main-t2"]'))
      assert.deepEqual(selected, ['t2'])

      // Alt+→ moves the focused chip one slot and reports the full new order.
      await view.key(view.find('[data-testid="ssh-tab-main-t1"]'), 'ArrowRight', { code: 'ArrowRight', altKey: true })
      assert.equal(reordered.length, 1)
      assert.equal(reordered[0].fromIndex, 0)
      assert.equal(reordered[0].toIndex, 1)
      assert.deepEqual(reordered[0].order, ['t2', 't1', 't3'])

      // Arrow keys move focus without reordering.
      await view.key(view.find('[data-testid="ssh-tab-main-t1"]'), 'ArrowLeft', { code: 'ArrowLeft' })
      assert.equal(reordered.length, 1)
    } finally {
      await view.unmount()
    }

    const empty = renderToStaticMarkup(React.createElement(tabs.TabStrip, { tabs: [], activeId: null }))
    assert.match(empty, /dsh-ssh-tabstrip-empty/)
  } finally {
    restore()
  }
})

test('moveTab is a pure, total reorder over the tab list', async () => {
  const { restore, module } = await loadChrome()
  try {
    const tabs = module('ssh.chrome.tabs')
    const ids = (list) => list.map((tab) => tab.id)
    assert.deepEqual(ids(tabs.moveTab(TABS, 0, 2)), ['t2', 't3', 't1'])
    assert.deepEqual(ids(tabs.moveTab(TABS, 2, 0)), ['t3', 't1', 't2'])
    assert.deepEqual(ids(tabs.moveTab(TABS, 1, 1)), ['t1', 't2', 't3'], 'a no-op move keeps the order')
    assert.deepEqual(ids(tabs.moveTab(TABS, -1, 2)), ['t1', 't2', 't3'], 'out-of-range source is ignored')
    assert.deepEqual(ids(tabs.moveTab(TABS, 0, 99)), ['t2', 't3', 't1'], 'target is clamped')
    assert.deepEqual(ids(TABS), ['t1', 't2', 't3'], 'the input list is never mutated')
    assert.deepEqual(tabs.reorderPayload(TABS, 0, 2).order, ['t2', 't3', 't1'])
  } finally {
    restore()
  }
})

test('a failed tab closes in one click', async () => {
  const { restore, module } = await loadChrome()
  try {
    const tabs = module('ssh.chrome.tabs')
    const closed = []
    const view = await mount(
      React.createElement(tabs.TabStrip, { tabs: TABS, activeId: 't3', onClose: (tab) => closed.push(tab.id) }),
    )
    try {
      await view.click(view.find('[data-testid="ssh-tab-close-t3"]'))
      assert.deepEqual(closed, ['t3'], 'an errored session needs no confirmation')
    } finally {
      await view.unmount()
    }
  } finally {
    restore()
  }
})

test('closing a live session goes through the type-to-confirm dialog', async () => {
  const { restore, module } = await loadChrome()
  try {
    const tabs = module('ssh.chrome.tabs')
    const confirm = module('ssh.chrome.confirm')
    const closed = []
    const service = confirm.createConfirmService()
    const view = await mount(
      React.createElement(
        'div',
        null,
        React.createElement(tabs.TabStrip, { tabs: TABS, activeId: 't1', onClose: (tab) => closed.push(tab.id) }),
        React.createElement(confirm.ConfirmHost, { service }),
      ),
    )
    try {
      // The strip resolves the client-run service through the module singleton, so the
      // dialog has to be driven through that same instance.
      const live = confirm.getConfirmService()
      const pending = live.request
      live.request = (...args) => {
        const promise = pending.apply(live, args)
        return promise
      }

      await view.click(view.find('[data-testid="ssh-tab-close-t1"]'))
      assert.deepEqual(closed, [], 'a live session must not close on one click')
      assert.ok(live.state(), 'a confirmation request is pending')
      assert.equal(live.state().requireType, 'prod-web')

      // The dialog is rendered by the ConfirmHost against the singleton.
      const host = await mount(React.createElement(confirm.ConfirmHost, { service: live }))
      try {
        const accept = host.find('[data-testid="ssh-confirm-accept"]')
        assert.ok(accept, 'the dialog is visible')
        assert.equal(accept.disabled, true, 'accept stays disabled until the name matches')
        await host.type(host.find('[data-testid="ssh-confirm-input"]'), 'prod-web')
        assert.equal(host.find('[data-testid="ssh-confirm-accept"]').disabled, false)
        await host.click(host.find('[data-testid="ssh-confirm-accept"]'))
      } finally {
        await host.unmount()
      }

      await act(async () => {
        await Promise.resolve()
      })
      assert.deepEqual(closed, ['t1'], 'confirming closes exactly the requested session')
    } finally {
      await view.unmount()
      confirm.getConfirmService().dispose()
    }
  } finally {
    restore()
  }
})

test('cancelling the dialog leaves the live session alone', async () => {
  const { restore, module } = await loadChrome()
  try {
    const confirm = module('ssh.chrome.confirm')
    const service = confirm.createConfirmService()
    const closed = []
    const tabs = module('ssh.chrome.tabs')
    const view = await mount(
      React.createElement(tabs.TabStrip, {
        tabs: [TABS[0]],
        activeId: 't1',
        onClose: (tab) => closed.push(tab.id),
      }),
    )
    try {
      const singleton = confirm.getConfirmService()
      const original = singleton.request.bind(singleton)
      singleton.request = (payload) => original(payload)
      await view.click(view.find('[data-testid="ssh-tab-close-t1"]'))
      const dialog = await mount(React.createElement(confirm.ConfirmHost, { service: singleton }))
      try {
        await dialog.click(dialog.find('[data-testid="ssh-confirm-cancel"]'))
      } finally {
        await dialog.unmount()
      }
      await act(async () => {
        await Promise.resolve()
      })
      assert.deepEqual(closed, [])
      assert.equal(singleton.state(), null)
    } finally {
      await view.unmount()
      confirm.getConfirmService().dispose()
    }
    assert.ok(service, 'the service factory is independent of the singleton')
  } finally {
    restore()
  }
})

// ── confirmation ────────────────────────────────────────────────────────────

test('the three dangerous operations demand a typed confirmation', async () => {
  const { restore, module } = await loadChrome()
  try {
    const confirm = module('ssh.chrome.confirm')
    const i18n = module('ssh.i18n').createI18n({})
    i18n.setLocale('en')
    const t = i18n.t

    const close = confirm.dangerRequest('closeSession', { label: 'prod-web' }, t)
    assert.equal(close.danger, true)
    assert.equal(close.requireType, 'prod-web')
    assert.match(close.body, /prod-web/)

    const remove = confirm.dangerRequest('deletePath', { path: '/var/log/nginx/error.log' }, t)
    assert.equal(remove.requireType, 'error.log', 'the typed token is the basename')

    const removeTree = confirm.dangerRequest('deletePath', { path: '/srv/app', recursive: true }, t)
    assert.match(removeTree.body, /everything inside/)

    const overwrite = confirm.dangerRequest('overwrite', { path: '/srv/app/main.js', size: 2048 }, t)
    assert.equal(overwrite.requireType, 'main.js')
    assert.match(overwrite.body, /2\.0 KiB|2048/)

    // A gate that accepts anything is not a gate.
    assert.equal(confirm.isConfirmationSatisfied('', 'main.js'), false)
    assert.equal(confirm.isConfirmationSatisfied(' main.js ', 'main.js'), true)
    assert.equal(confirm.isConfirmationSatisfied('MAIN.JS', 'main.js'), false)
    assert.equal(confirm.isConfirmationSatisfied('', undefined), true)
    assert.equal(confirm.baseName('C:\\Users\\me\\file.txt'), 'file.txt')
  } finally {
    restore()
  }
})

test('the confirmation queue settles a request exactly once', async () => {
  const { restore, module } = await loadChrome()
  try {
    const confirm = module('ssh.chrome.confirm')
    const service = confirm.createConfirmService()
    const first = service.request({ title: 'a', requireType: 'a' })
    const second = service.request({ title: 'b' })
    assert.equal(service.state().title, 'a')
    assert.equal(service.queued(), 1, 'the second request waits for the first to settle')

    service.resolve(true)
    assert.equal(await first, true)
    assert.equal(service.state().title, 'b', 'the queue advances')

    service.resolve(false)
    assert.equal(await second, false)
    assert.equal(service.state(), null)

    // An unload must not leave a caller hanging forever.
    const third = service.request({ title: 'c' })
    service.dispose()
    assert.equal(await third, false)
  } finally {
    restore()
  }
})

test('ConfirmDialog gates the accept button, and Esc cancels', async () => {
  const { restore, module } = await loadChrome()
  try {
    const confirm = module('ssh.chrome.confirm')
    let confirmed = 0
    let cancelled = 0
    const view = await mount(
      React.createElement(confirm.ConfirmDialog, {
        open: true,
        title: 'Delete remote path',
        body: 'This cannot be undone.',
        danger: true,
        requireType: 'error.log',
        confirmText: 'Delete',
        cancelText: 'Cancel',
        onConfirm: () => {
          confirmed += 1
        },
        onCancel: () => {
          cancelled += 1
        },
      }),
    )
    try {
      assert.equal(view.find('[data-testid="ssh-confirm"]').getAttribute('data-danger'), 'true')
      assert.equal(view.find('[data-testid="ssh-confirm-accept"]').disabled, true)

      // A wrong token stays blocked.
      await view.type(view.find('[data-testid="ssh-confirm-input"]'), 'wrong.log')
      assert.equal(view.find('[data-testid="ssh-confirm-accept"]').disabled, true)
      await view.click(view.find('[data-testid="ssh-confirm-accept"]'))
      assert.equal(confirmed, 0)

      await view.type(view.find('[data-testid="ssh-confirm-input"]'), 'error.log')
      await view.click(view.find('[data-testid="ssh-confirm-accept"]'))
      assert.equal(confirmed, 1)

      // Esc cancels through the dialog's own handler.
      await view.key(view.find('[data-testid="ssh-confirm"]'), 'Escape', { code: 'Escape' })
      assert.equal(cancelled, 1)
    } finally {
      await view.unmount()
    }
    assert.equal(renderToStaticMarkup(React.createElement(confirm.ConfirmDialog, { open: false })), '')
  } finally {
    restore()
  }
})

// ── status bar ──────────────────────────────────────────────────────────────

test('the status bar formats latency, uptime, traffic and a running transfer', async () => {
  const { restore, module } = await loadChrome()
  try {
    const statusbar = module('ssh.chrome.statusbar')
    assert.equal(statusbar.formatDuration(0), '0s')
    assert.equal(statusbar.formatDuration(65_000), '1m 05s')
    assert.equal(statusbar.formatDuration(3_725_000), '1h 02m 05s')
    assert.equal(statusbar.formatDuration(-1), null)
    assert.equal(statusbar.formatBytes(0), '0 B')
    assert.equal(statusbar.formatBytes(1536), '1.5 KiB')
    assert.equal(statusbar.formatBytes(20 * 1024 * 1024), '20 MiB')
    assert.equal(statusbar.formatRate(2048), '2.0 KiB/s')
    assert.equal(statusbar.formatPercent(140), '100%')
    assert.equal(statusbar.formatPercent('x'), null)
    assert.equal(statusbar.formatEta(75_000), '01:15')

    const i18n = module('ssh.i18n').createI18n({})
    i18n.setLocale('en')
    const info = {
      host: '10.0.0.5',
      user: 'root',
      port: 22,
      sessionState: 'connected',
      rttMs: 42.4,
      connectedFor: 3_725_000,
      bytesIn: 2048,
      bytesOut: 512,
      transfer: { active: true, direction: 'upload', percent: 37.5, bytesPerSec: 2048, etaMs: 75_000 },
    }
    const view = statusbar.describeStatus(info, i18n)
    assert.equal(view.target, 'root@10.0.0.5:22')
    assert.equal(view.rttText, 'RTT 42 ms')
    assert.equal(view.uptimeText, 'Uptime 1h 02m 05s')
    assert.equal(view.trafficText, '↑ 512 B / ↓ 2.0 KiB')
    assert.equal(view.percentText, '38%')
    assert.equal(view.transfer !== null, true)

    const html = renderToStaticMarkup(React.createElement(statusbar.StatusBar, { info }))
    assert.match(html, /data-testid="ssh-status-rtt"/)
    assert.match(html, /data-testid="ssh-status-uptime"/)
    assert.match(html, /data-testid="ssh-status-traffic"/)
    assert.match(html, /data-testid="ssh-status-transfer"/)
    // An unrounded width is correct for a progress bar; the label stays rounded.
    assert.match(html, /width:37\.5%/)
    assert.match(html, /Upload 38% \(2\.0 KiB\/s, 01:15 left\)/, 'the tooltip carries real values, not placeholders')
    assert.equal(html.includes('{percent}'), false, 'no raw placeholder may reach the markup')

    const idle = renderToStaticMarkup(
      React.createElement(statusbar.StatusBar, {
        info: { host: 'h', user: 'u', port: 22, sessionState: 'connected' },
      }),
    )
    assert.match(idle, /No transfer in progress/)

    const dead = renderToStaticMarkup(
      React.createElement(statusbar.StatusBar, {
        info: { host: 'h', user: 'u', port: 22, sessionState: 'closed' },
        onReconnect: () => {},
      }),
    )
    assert.match(dead, /Disconnected/)
    assert.match(dead, /data-testid="ssh-status-reconnect"/)
  } finally {
    restore()
  }
})

test('disconnecting a live session is confirmed before it happens', async () => {
  const { restore, module } = await loadChrome()
  try {
    const statusbar = module('ssh.chrome.statusbar')
    const confirm = module('ssh.chrome.confirm')
    const disconnects = []
    const service = confirm.createConfirmService()
    const view = await mount(
      React.createElement(
        'div',
        null,
        React.createElement(statusbar.StatusBar, {
          info: { host: '10.0.0.5', user: 'root', port: 22, sessionState: 'connected' },
          onDisconnect: () => disconnects.push('bye'),
        }),
        React.createElement(confirm.ConfirmHost, { service }),
      ),
    )
    try {
      await view.click(view.find('[data-testid="ssh-status-disconnect"]'))
      assert.deepEqual(disconnects, [], 'a live session is not disconnected on one click')

      const dialog = await mount(React.createElement(confirm.ConfirmHost, { service: confirm.getConfirmService() }))
      try {
        await dialog.click(dialog.find('[data-testid="ssh-confirm-cancel"]'))
      } finally {
        await dialog.unmount()
      }
      assert.deepEqual(disconnects, [])

      // A closed session reconnects without any gate.
      const dead = await mount(
        React.createElement(statusbar.StatusBar, {
          info: { host: 'h', user: 'u', port: 22, sessionState: 'closed' },
          onReconnect: () => disconnects.push('reconnect'),
        }),
      )
      try {
        await dead.click(dead.find('[data-testid="ssh-status-reconnect"]'))
        assert.deepEqual(disconnects, ['reconnect'])
      } finally {
        await dead.unmount()
      }
    } finally {
      await view.unmount()
      confirm.getConfirmService().dispose()
      service.dispose()
    }
  } finally {
    restore()
  }
})

// ── install ─────────────────────────────────────────────────────────────────

test('install registers dictionaries, styles, shortcuts and both overlay seats', async () => {
  const { restore, module } = await loadChrome()
  try {
    const chrome = module('ssh.chrome')
    const effects = []
    const registered = []
    const injected = []
    const ctx = {
      get: (name) =>
        name === 'slots'
          ? {
              inject: (key, callback) => {
                injected.push(key)
                callback()
                return () => {}
              },
              register: (declaration, component) => {
                registered.push({ declaration, component })
                return () => {}
              },
            }
          : name === 'locale'
            ? { register: () => () => {} }
            : undefined,
      effect: (callback, label) => {
        effects.push({ label, dispose: callback() })
      },
    }

    const result = chrome.install(ctx, { focusPanel: () => {} })
    assert.equal(result.errors.length, 0, JSON.stringify(result.errors))
    assert.equal(result.shortcuts.ok, false, 'this composition has no shortcuts service')
    assert.deepEqual(result.overlays, ['ssh-toasts', 'ssh-confirm'])
    const ids = registered.map((entry) => entry.declaration.id)
    assert.deepEqual(ids, ['ssh-toasts', 'ssh-confirm'])
    assert.equal(injected.length, 2)
    for (const entry of registered) assert.equal(entry.declaration.name, 'shell.overlay')
    assert.ok(effects.length >= 3, 'locale, shortcuts and overlays are all owned')
    assert.equal(typeof chrome.components().TabStrip, 'function')
    const disposer = result.localKeys.dispose
    disposer()
    assert.equal(typeof result.localKeys.handler, 'function')
  } finally {
    restore()
  }
})

test('a missing slot registry does not break install', async () => {
  const { restore, module } = await loadChrome()
  try {
    const chrome = module('ssh.chrome')
    const result = chrome.install({ get: () => undefined }, {})
    assert.deepEqual(result.overlays, [])
    assert.equal(result.shortcuts.ok, false)
  } finally {
    restore()
  }
})

test('two consecutive apply() runs both succeed and the panel still translates', async () => {
  // The live panel is hot-reloaded by re-running apply() while the previous run is still
  // mounted. That is the shape of the incident: the second run hit
  // 'locale namespace "ssh" already has locale "zh"' and the panel was left rendering
  // key names, so this asserts the whole chain survives a repeat — registration,
  // styles, shortcuts, overlays and the translation surface.
  const { restore, exports, registry } = await loadChrome()
  try {
    document.documentElement.setAttribute('lang', 'en')
    const services = { locale: fakeLocale(), slots: fakeSlots(), sidebarRightTabs: fakeTabRegistry() }
    const ctx = fakeContext(services)

    exports.apply(ctx)
    const firstRuntime = exports.introspect()
    assert.ok(firstRuntime, 'the first run publishes a runtime')

    // Second run, same context: nothing may throw and nothing may be left in a state
    // where translations fall back to key names.
    assert.doesNotThrow(() => exports.apply(ctx), 'a repeat apply() must not throw')

    const i18nModule = registry.require('ssh.i18n')
    assert.equal(i18nModule.t('conn.new'), 'New connection', 'translations survive a repeat apply')
    assert.equal(registry.require('ssh.chrome').i18n.t('panel.title'), 'SSH sessions')
    assert.equal(i18nModule.selfCheck('conn.new').translated, true)
    // Each apply() publishes its own runtime; what matters is that the second one is
    // complete rather than a half-built replacement.
    const secondRuntime = exports.introspect()
    assert.ok(secondRuntime && secondRuntime.ctx === ctx, 'the second run publishes its own runtime')
    assert.notEqual(secondRuntime, firstRuntime, 'a repeat apply() is a fresh run, not a silent no-op')

    // Both runs' registrations are owned: the locale step must not have thrown out of
    // install(), and every effect stays disposable.
    const effects = ctx.effects
    assert.ok(effects.length >= 6, `expected both runs to own effects, saw ${effects.length}`)
    for (const effect of effects) assert.equal(typeof effect.dispose, 'function')
  } finally {
    restore()
  }
})

// ── the designable theme switch (user-reported gap: "no theme toggle button") ──────
//
// The panel followed the shell theme already; what was missing was a control the user
// could operate and therefore *verify*. These four tests pin the contract: it reflects
// the service, it switches through `setTheme`, it degrades without the service, and it is
// never hidden at the narrowest sidebar width.

/**
 * A stand-in for the shell's `theme` service *and* its ctx, faithful to the documented
 * surface (`@deepseek-ai/dsh-cordis-client-runner/lib/client.js:1399-1416`):
 * `getTheme()` returns the snapshot described by
 * `@deepseek-ai/dsh-client-ui-theme/lib/client.js:1487-1499`, `setTheme(id)` throws on an
 * unknown id, and every accepted write emits `theme/change` — which is the only channel a
 * consumer sees, so the fake emits it through the ctx exactly like cordis does.
 */
function fakeThemeComposition(initial = 'dark', ids = ['light', 'dark']) {
  const listeners = new Set()
  const calls = []
  let preference = initial
  const service = {
    getTheme() {
      const resolved = preference === 'system' ? ids[0] : preference
      return Object.freeze({
        preference,
        fontSize: 13,
        active: Object.freeze({ id: resolved }),
        themes: Object.freeze(ids.map((id) => Object.freeze({ id }))),
        revision: calls.length,
      })
    },
    setTheme(id) {
      if (!ids.includes(id) && id !== 'system') throw new Error(`unknown theme ${id}`)
      calls.push(id)
      preference = id
      for (const listener of [...listeners]) listener()
    },
  }
  const ctx = {
    get: (name) => (name === 'theme' ? service : undefined),
    on: (event, handler) => {
      if (event !== 'theme/change') return () => {}
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
  }
  return { ctx, service, calls, listenerCount: () => listeners.size }
}

function chromeCtx(services) {
  const handlers = new Map()
  return {
    get: (name) => services[name],
    on: (event, handler) => {
      const set = handlers.get(event) ?? new Set()
      set.add(handler)
      handlers.set(event, set)
      return () => set.delete(handler)
    },
    handlers,
  }
}

test('the theme switch renders and reflects the current theme', async () => {
  const { restore, module } = await loadChrome()
  try {
    const theme = module('ssh.chrome.theme')
    const dark = fakeThemeComposition('dark')
    theme.configureThemeService(dark.ctx)

    const view = await mount(React.createElement(theme.ThemeToggle, {}))
    try {
      const button = view.find('[data-testid="ssh-theme-toggle"]')
      assert.ok(button, 'the switch must render a real button')
      assert.equal(button.getAttribute('data-theme'), 'dark', 'data-theme reflects getTheme().preference')
      assert.equal(button.getAttribute('aria-pressed'), 'true', 'dark is the pressed state')
      // The wording comes from the dictionary (either locale — the environment decides),
      // never from a raw key.
      const aria = button.getAttribute('aria-label')
      assert.equal(aria.includes('chrome.theme'), false, `the aria label leaked a key: ${aria}`)
      assert.match(aria, /Switch theme|切换主题/, `the aria label is translated: ${aria}`)
      assert.match(button.textContent, /Dark|暗色/, 'the visible label names the active theme')
      assert.equal(view.find('.dsh-ssh-session-help'), null, 'the switch is not inside the hideable wrapper')

      // A change made elsewhere (the Settings page) reaches the button through
      // `theme/change` — the documented continuous-sync channel.
      await act(async () => {
        dark.service.setTheme('light')
      })
      const updated = view.find('[data-testid="ssh-theme-toggle"]')
      assert.equal(updated.getAttribute('data-theme'), 'light', 'the button follows theme/change')
      assert.equal(updated.getAttribute('aria-pressed'), 'false')
      assert.match(updated.textContent, /Light|亮色/)
    } finally {
      await view.unmount()
    }
  } finally {
    restore()
  }
})

test('clicking the theme switch calls setTheme with the next registry id', async () => {
  const { restore, module } = await loadChrome()
  try {
    const theme = module('ssh.chrome.theme')
    const composition = fakeThemeComposition('light')
    theme.configureThemeService(composition.ctx)

    const view = await mount(React.createElement(theme.ThemeToggle, {}))
    try {
      await view.click(view.find('[data-testid="ssh-theme-toggle"]'))
      assert.deepEqual(composition.calls, ['dark'], 'light → dark, the next id in the registry list')
      // Re-query after the click: React replaced the node, and a detached listener would
      // swallow the second click (the assertion below would then read a stale `dark`).
      await view.click(view.find('[data-testid="ssh-theme-toggle"]'))
      assert.deepEqual(composition.calls, ['dark', 'light'], 'and back again')
      assert.equal(view.find('[data-testid="ssh-theme-toggle"]').getAttribute('data-theme'), 'light')
    } finally {
      await view.unmount()
    }

    // No hardcoded pair: a third party theme joins the rotation by registering.
    assert.equal(theme.nextThemeId({ preference: 'dark', themes: [{ id: 'light' }, { id: 'dark' }, { id: 'solar' }] }), 'solar')
    assert.equal(theme.nextThemeId({ preference: 'solar', themes: [{ id: 'light' }, { id: 'dark' }, { id: 'solar' }] }), 'light')
    // A `system` preference switches to a concrete neighbouring theme.
    assert.equal(theme.nextThemeId({ preference: 'system', active: { id: 'dark' }, themes: [{ id: 'light' }, { id: 'dark' }] }), 'light')
    // Without a registry list it still toggles.
    assert.equal(theme.nextThemeId({ preference: 'dark', themes: [] }), 'light')
  } finally {
    restore()
  }
})

test('a theme service that mounts late is picked up and the switch appears', async () => {
  // The live symptom: `theme-service=absent` on a composition that *does* provide `theme`,
  // because install() looked exactly once. A client service mounting after apply() is
  // normal here, so the lookup retries — and the button must appear on its own, without a
  // reload, because the component keeps listening instead of hiding for good.
  const { restore, module } = await loadChrome()
  try {
    const theme = module('ssh.chrome.theme')
    const composition = fakeThemeComposition('dark')
    let mounted = false
    let lookups = 0
    const ctx = {
      get: (name) => {
        if (name !== 'theme') return undefined
        lookups += 1
        return mounted ? composition.service : undefined
      },
      on: composition.ctx.on,
    }
    theme.configureThemeService(ctx)

    const view = await mount(React.createElement(theme.ThemeToggle, {}))
    try {
      assert.equal(view.find('[data-testid="ssh-theme-toggle"]'), null, 'nothing to show while pending')
      const before = lookups
      mounted = true
      await act(async () => {
        await theme.waitForThemeService({ timeoutMs: 500, intervalMs: 5 })
      })
      const button = view.find('[data-testid="ssh-theme-toggle"]')
      assert.ok(button, 'the switch must appear once the service mounts, without a reload')
      assert.ok(lookups > before, 'the lookup was retried')
      assert.equal(button.getAttribute('data-theme'), 'dark')
      assert.equal(theme.themeAvailability(), 'ready', 'availability flips to ready, not absent')
    } finally {
      await view.unmount()
    }
  } finally {
    restore()
  }
})

test('a theme service that never arrives reports absent only after the wait', async () => {
  const { restore, module } = await loadChrome()
  try {
    const theme = module('ssh.chrome.theme')
    let lookups = 0
    theme.configureThemeService({
      get: (name) => {
        if (name === 'theme') lookups += 1
        return undefined
      },
      on: () => () => {},
    })

    // Injected timings: the production window is 15s and must not be waited in a test.
    const result = await theme.waitForThemeService({ timeoutMs: 25, intervalMs: 5 })
    assert.equal(result.service, null)
    assert.equal(result.availability, 'absent', 'absent means the whole window elapsed')
    assert.equal(theme.themeAvailability(), 'absent')
    assert.ok(lookups >= 2, `the lookup was retried, saw ${lookups}`)

    const reasons = []
    const view = await mount(React.createElement(theme.ThemeToggle, { onUnavailable: (reason) => reasons.push(reason) }))
    try {
      assert.equal(view.find('[data-testid="ssh-theme-toggle"]'), null, 'no dead button')
      assert.equal(view.html().trim(), '', 'it renders nothing rather than throwing')
      assert.match(reasons[0] ?? '', /did not appear/, 'the reason names the wait, not "unsupported"')
    } finally {
      await view.unmount()
    }
  } finally {
    restore()
  }
})

test('the theme switch degrades when the composition has no theme service', async () => {
  const { restore, module } = await loadChrome()
  try {
    const theme = module('ssh.chrome.theme')
    const reasons = []
    // No `theme` service at all: pending first, silent, and no dead button.
    theme.configureThemeService(chromeCtx({}))
    const view = await mount(React.createElement(theme.ThemeToggle, { onUnavailable: (reason) => reasons.push(reason) }))
    try {
      assert.equal(view.find('[data-testid="ssh-theme-toggle"]'), null, 'no service → no dead button')
      assert.equal(view.html().trim(), '', 'it renders nothing rather than throwing')
      assert.deepEqual(reasons, [], 'while still looking, nothing is reported as unavailable')
    } finally {
      await view.unmount()
    }

    // …and a service whose contract is incomplete.
    theme.configureThemeService(chromeCtx({ theme: { getTheme: () => ({ preference: 'dark', themes: [] }) } }))
    const view2 = await mount(React.createElement(theme.ThemeToggle, {}))
    try {
      assert.ok(view2.find('[data-testid="ssh-theme-toggle"]'), 'a read-only service still shows the state')
      const button = view2.find('[data-testid="ssh-theme-toggle"]')
      await view2.click(button) // setTheme is absent: must not throw
      assert.ok(true, 'clicking without setTheme is a no-op, not an exception')
    } finally {
      await view2.unmount()
    }
    // A refused id is swallowed too (the service throws on unknown ids).
    theme.configureThemeService(fakeThemeComposition('light').ctx)
    assert.equal(theme.applyTheme('nope'), null, 'a refused switch returns null instead of throwing')
  } finally {
    restore()
  }
})

test('the theme switch stays visible at the narrowest sidebar width', async () => {
  const { restore, module } = await loadChrome()
  try {
    // The hide rule lives on the sibling wrapper, so the switch cannot be inside it: the
    // narrow sidebar is the width the user actually works at.
    const panel = readFileSync(join(ROOT, 'client', 'src', 'panel.js'), 'utf8')
    assert.match(panel, /@container \(max-width: 320px\) \{ \.dsh-ssh-session-help \{ display:none; \} \}/)
    const helpWrapper = panel.slice(panel.indexOf("className: 'dsh-ssh-session-help'"))
    const helpBlock = helpWrapper.slice(0, helpWrapper.indexOf(')),'))
    assert.equal(
      helpBlock.includes('ThemeToggle'),
      false,
      'the theme switch must be a sibling of .dsh-ssh-session-help, never inside it',
    )
    assert.match(panel, /chrome\.ThemeToggle \? h\(chrome\.ThemeToggle, \{\}\) : null/, 'the toolbar renders it')

    // And nothing in this plugin's own stylesheet hides it.
    const css = module('ssh.chrome.theme').CSS
    const rules = css.match(/[^{}]*\.dsh-ssh-theme-toggle[^{}]*\{[^}]*\}/g) ?? []
    assert.ok(rules.length >= 1, 'the switch has styles of its own')
    for (const rule of rules) {
      assert.equal(/display:\s*none/.test(rule), false, `a rule hides the switch: ${rule}`)
      assert.equal(/visibility:\s*hidden/.test(rule), false, `a rule hides the switch: ${rule}`)
    }
  } finally {
    restore()
  }
})
