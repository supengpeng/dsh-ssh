/**
 * Headless harness for the client half.
 *
 * DSH serves `lib/client.js` to a browser, but nothing about the bundle needs a
 * browser to be *verified*: the format is a lazy-CJS factory registration, so the
 * harness plays the part of `window.__ModuleLoader__` and of the platform module
 * table. That keeps the client half testable in CI, and it is the seam SP5–SP7
 * build their component tests on.
 *
 * What this deliberately does NOT fake is the wire: the fake carrier answers with
 * exactly the frame sequence `src/service.ts` produces, so a drift between the two
 * halves shows up here rather than in a browser console.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseHTML } from 'linkedom'

const HERE = dirname(fileURLToPath(import.meta.url))
export const BUNDLE_PATH = join(HERE, '..', '..', 'lib', 'client.js')

/** Install a DOM + window and return a restore function. */
export function installDom() {
  const { window: domWindow, document } = parseHTML('<!doctype html><html><head></head><body></body></html>')
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window')
  const hadDocument = Object.prototype.hasOwnProperty.call(globalThis, 'document')
  const hadNavigator = Object.prototype.hasOwnProperty.call(globalThis, 'navigator')
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const previousNavigator = globalThis.navigator

  const store = new Map()
  const localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
  }

  const win = domWindow
  // `window.localStorage` is what the bundle reads. Node 24 owns a read-only
  // `globalThis.localStorage`, which is deliberately left alone — the client half
  // never touches the bare global.
  try {
    Object.defineProperty(win, 'localStorage', { value: localStorage, configurable: true, writable: true })
  } catch {
    try {
      win.localStorage = localStorage
    } catch {
      /* a window without storage is still a usable harness */
    }
  }

  const define = (name, value) => {
    try {
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
    } catch {
      globalThis[name] = value
    }
  }
  define('window', win)
  define('document', document)

  // react-dom's client entry reads `navigator.userAgent` while it is *evaluated*,
  // and Node only grew a global `navigator` in version 21 — on Node 20 this file's
  // callers died with "ReferenceError: navigator is not defined" inside
  // react-dom before a single case could run, which is exactly how the client
  // suite failed on CI while passing on Node 24.
  //
  // It is supplied only where the runtime has none, and shaped like the one Node
  // 21+ reports, so the newer legs keep their own object and every leg sees the
  // same kind of value.
  if (!hadNavigator) {
    define('navigator', {
      userAgent: `Node.js/${process.versions.node}`,
      language: 'en-US',
      languages: ['en-US'],
    })
  }

  return () => {
    if (hadWindow) define('window', previousWindow)
    else delete globalThis.window
    if (hadDocument) define('document', previousDocument)
    else delete globalThis.document
    if (hadNavigator) define('navigator', previousNavigator)
    else delete globalThis.navigator
  }
}

/**
 * Load the built bundle and capture the package rows it registers.
 * @param modules bare-specifier table handed to the factory's `require`.
 */
export async function loadBundle(modules = {}) {
  const rows = []
  let nextId = 0
  const win = globalThis.window
  win.__ModuleLoader__ = {
    load(row) {
      rows.push({ ...row, id: row.id })
    },
  }

  // A fresh module URL per load keeps Node's ESM cache from returning a
  // previously evaluated copy of the same file. (`copy` is already unique per
  // call because its directory is; the counter only keeps the query distinct.)
  const source = readFileSync(BUNDLE_PATH, 'utf8')
  nextId += 1
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-harness-'))
  const copy = join(dir, 'client.mjs')
  writeFileSync(copy, source, 'utf8')
  try {
    await import(`file://${copy.replace(/\\/g, '/')}?v=${nextId}`)
  } finally {
    // Cleanup here is not optional housekeeping: without it every load leaked a
    // temp directory, and a killed test process leaked one *per load* (this had
    // accumulated 1440 directories on the dev machine). Best-effort, because on
    // Windows a handle may still be open and a failed cleanup must never turn
    // into a test failure.
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* a locked directory is the OS's business, not the test's */
    }
  }

  function materialise(index = 0) {
    const row = rows[index]
    if (!row) throw new Error('the bundle registered no package row')
    const require = (specifier) => {
      if (Object.prototype.hasOwnProperty.call(modules, specifier)) return modules[specifier]
      throw new Error(`harness: unexpected external require(${JSON.stringify(specifier)})`)
    }
    return { row, exports: row.factory(require) }
  }

  return { rows, materialise }
}

/** A Cordis-like client context that records effects instead of owning them. */
export function fakeContext(services = {}) {
  const effects = []
  const missing = []
  return {
    effects,
    missing,
    get(name) {
      const value = services[name]
      if (value === undefined) missing.push(name)
      return value
    },
    on() {
      return () => {}
    },
    provide() {
      return () => {}
    },
    effect(callback, label) {
      const dispose = callback()
      effects.push({ label, dispose })
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
  }
}

/** A slot registry that records what a plugin registers. */
export function fakeSlots() {
  const registered = []
  const injected = []
  return {
    registered,
    injected,
    inject(key, callback) {
      injected.push(key)
      try {
        callback()
      } catch (error) {
        // A real registry surfaces this through the fiber; the harness records it.
        injected.push({ key, error: String(error && error.message) })
      }
      return () => {}
    },
    register(declaration, component) {
      registered.push({ declaration, component })
      return () => {}
    },
  }
}

/** A tab registry matching `sidebarRightTabs`. */
export function fakeTabRegistry() {
  const types = []
  const listeners = new Set()
  return {
    types,
    register(definition) {
      types.push(definition)
      for (const listener of listeners) listener()
      return () => {
        const index = types.indexOf(definition)
        if (index >= 0) types.splice(index, 1)
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    entries: () => types,
  }
}

/** A locale service with a real dictionary lookup. */
export function fakeLocale() {
  const dictionaries = new Map()
  return {
    dictionaries,
    register(namespace, dicts) {
      dictionaries.set(namespace, dicts)
      return () => dictionaries.delete(namespace)
    },
    bind(namespace) {
      return (key) => {
        const dict = dictionaries.get(namespace)
        return (dict && (dict.en?.[key] ?? dict.zh?.[key])) ?? key
      }
    },
    getLocale: () => ({ id: 'en' }),
    getSnapshot: () => ({ id: 'en' }),
    subscribe: () => () => {},
    setLocale: () => {},
  }
}

/**
 * A client-side Remote face matching what the host half produces.
 *
 * `ping` mirrors `SshPluginService.ping`; `probeStream` mirrors the frame order
 * asserted by `test/unit/service.test.mjs`.
 */
export function fakeRemoteCarrier(options = {}) {
  const namespace = options.namespace ?? 'sshPlugin'
  const calls = []
  const face = {
    async ping(params) {
      calls.push({ method: 'ping', params })
      if (options.pingThrows) throw Object.assign(new Error('carrier refused'), { code: 'sshPlugin/nope' })
      return {
        pong: true,
        echo: params?.echo,
        version: '1.0.0',
        namespace,
        node: 'v-harness',
        pluginVersion: '0.1.0',
        at: new Date().toISOString(),
        handlerMs: 0,
      }
    },
    async describe() {
      calls.push({ method: 'describe', params: undefined })
      if (options.describeThrows) throw Object.assign(new Error('describe refused'), { code: 'sshPlugin/nope' })
      return { namespace, version: '0.1.0', config: {} }
    },
    async reportSpike(params) {
      calls.push({ method: 'reportSpike', params })
      return { recorded: true, file: 'harness://client-transport.json' }
    },
    async *probeStream(params) {
      calls.push({ method: 'probeStream', params })
      const count = params?.count ?? 5
      const streamId = 'st_harness'
      yield { t: 'open', streamId, kind: 'exec', meta: {} }
      for (let seq = 0; seq < count; seq++) {
        yield { t: 'data', streamId, seq, chunk: `frame ${seq}\n`, encoding: 'utf8', channel: 'stdout' }
      }
      if (params?.fail) {
        yield { t: 'end', streamId, reason: 'error', error: { code: 'SSH_UNKNOWN', message: 'boom', retryable: false } }
        return
      }
      yield { t: 'end', streamId, reason: 'completed' }
    },
  }
  return {
    calls,
    $mount: async () => {},
    [namespace]: face,
  }
}
