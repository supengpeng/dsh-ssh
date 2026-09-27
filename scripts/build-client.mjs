/**
 * Client-bundle assembler for @local/dsh-ssh.
 *
 * DSH serves one `lib/client.js` per plugin package, in its own lazy-CJS format:
 *
 *     window.__ModuleLoader__.load({ id, factory: (require) => { ...exports } })
 *
 * The UI is too large to maintain as one file, and eight authors must be able to
 * work in parallel without touching a shared source file, so this script composes
 * many small modules into that single artifact:
 *
 *   - every `client/src/**\/*.js` file declares itself with a `@module` header and
 *     registers a factory through `SSH.define(name, factory)`;
 *   - files are emitted in ascending `@order`, then by path, so a file's position
 *     is owned locally instead of by a central manifest;
 *   - `SSH.require(name)` materialises a module on first use, which keeps
 *     definition order independent of evaluation order.
 *
 * The output is deterministic: the same inputs produce byte-identical output, so
 * `--check` can fail a build that forgot to re-run the assembler.
 *
 * Usage:
 *     node scripts/build-client.mjs           # write lib/client.js
 *     node scripts/build-client.mjs --check   # exit 1 when lib/client.js is stale
 *     node scripts/build-client.mjs --print   # write the bundle to stdout
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(HERE, '..')
const SRC_DIR = join(ROOT, 'client', 'src')
export const OUT_FILE = join(ROOT, 'lib', 'client.js')

/** Package id the browser module loader keys this bundle under. */
const BUNDLE_ID = '@local/dsh-ssh'
/** The only external the bundle is allowed to request: the platform React seed. */
const ALLOWED_EXTERNAL = 'react'

/**
 * Module headers are read from either form, so a file can document itself with
 * JSDoc (`* @module x`) or a plain line comment (`// @module x`);
 * ```
 * /**
 *  * @module ssh.conn.list
 *  * @order 320
 *  *\/
 * ```
 */
const MODULE_HEADER = /^[ \t]*(?:\/\/|\*)[ \t]*@module[ \t]+(\S+)[ \t]*$/m
const ORDER_HEADER = /^[ \t]*(?:\/\/|\*)[ \t]*@order[ \t]+(\d+)[ \t]*$/m

/** Recursively collect `.js` sources, skipping dot-directories. */
export function collectSources(dir = SRC_DIR) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectSources(full))
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

/**
 * Reject a source that lost characters to an encoding round trip.
 *
 * This is a real failure mode, not a theoretical one: on a Windows host with a
 * non-UTF-8 console codepage, `Get-Content | Set-Content` (and similar pipeline
 * edits) silently replaces every non-ASCII character with U+FFFD. The file still
 * looks fine in an editor, the build still "succeeds", and the browser gets a
 * bundle that cannot even be parsed - so the failure surfaces as a blank panel in
 * the user's window rather than as a build error. Detected here, it costs one
 * line and names the file and line to fix.
 */
export function assertNoReplacementCharacters(source) {
  const index = source.text.indexOf('\uFFFD')
  if (index < 0) return
  const line = source.text.slice(0, index).split('\n').length
  const snippet = source.text.split('\n')[line - 1] ?? ''
  throw new Error(
    `${relative(ROOT, source.file)}:${line}: contains ${countOf(source.text, '\uFFFD')} U+FFFD replacement character(s), ` +
      `i.e. non-ASCII characters corrupted by an encoding round trip:\n    ${snippet.trim().slice(0, 120)}\n` +
      '  Fix: rewrite the line with an editor tool (not a PowerShell pipeline). On this host ' +
      '`Get-Content | Set-Content` reads UTF-8 as GBK and silently destroys every non-ASCII character.',
  )
}

function countOf(text, needle) {
  let count = 0
  let index = text.indexOf(needle)
  while (index >= 0) {
    count += 1
    index = text.indexOf(needle, index + 1)
  }
  return count
}

/**
 * Reject a bundle that cannot be parsed.
 *
 * "Assembled successfully" and "loadable by the browser" are different claims:
 * a syntax error anywhere in the composed factory leaves the user with a plugin
 * that never applies. Parsing the exact shipped text here moves that discovery
 * from the browser console to the build.
 */
export function assertParsableBundle(bundle) {
  try {
    // Parsing only — the body is never run. (No `no-new-func` disable directive:
    // the rule is not enabled in eslint.config.js, and an unused directive is
    // itself reported as a warning.)
    new Function(bundle)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`assembled client bundle is not parsable JavaScript: ${message}`)
  }
}

/** Parse one source file's header and validate its shape. Throws on a bad file. */
export function parseSource(file, text) {
  const source = text ?? readFileSync(file, 'utf8')
  const moduleName = MODULE_HEADER.exec(source)?.[1]
  if (!moduleName) {
    throw new Error(`${relative(ROOT, file)}: missing "@module <name>" header`)
  }
  const order = Number(ORDER_HEADER.exec(source)?.[1] ?? '500')
  if (!Number.isInteger(order) || order < 0 || order > 999) {
    throw new Error(`${relative(ROOT, file)}: "@order" must be an integer in 0..999`)
  }
  if (!/^SSH\.define\(\s*['"]/m.test(source)) {
    throw new Error(`${relative(ROOT, file)}: body must call SSH.define('<${moduleName}>', function (SSH) { ... })`)
  }
  if (/^\s*(import|export)\s/m.test(source)) {
    throw new Error(`${relative(ROOT, file)}: ESM syntax is not allowed; use SSH.define/SSH.require`)
  }
  const parsed = { file, moduleName, order, text: source }
  assertNoReplacementCharacters(parsed)
  return parsed
}

/**
 * Reject two files claiming the same `@module` name.
 *
 * Caught at build time rather than at first `require`, so a copy-pasted file can
 * never half-shadow another in a browser where only the symptom is visible.
 */
export function assertUniqueModules(sources) {
  const seen = new Map()
  for (const source of sources) {
    const previous = seen.get(source.moduleName)
    if (previous) {
      throw new Error(
        `duplicate @module "${source.moduleName}" in ${relative(ROOT, previous)} and ${relative(ROOT, source.file)}`,
      )
    }
    seen.set(source.moduleName, source.file)
  }
  return seen
}

/** The bundle preamble: the tiny module registry the sources register into. */
function preamble() {
  return `    // ---- module registry (SSH namespace) ------------------------------------
    var SSH = (function () {
      var react = require(${JSON.stringify(ALLOWED_EXTERNAL)})
      var factories = Object.create(null)
      var cache = Object.create(null)
      var styleNodes = []
      var api = {
        id: ${JSON.stringify(BUNDLE_ID)},
        react: react,
        h: react.createElement,
        Fragment: react.Fragment,
        /** Register one module factory. Duplicate names are a build error. */
        define: function (name, factory) {
          if (typeof name !== 'string' || name === '') throw new Error('SSH.define: module name must be a non-empty string')
          if (typeof factory !== 'function') throw new Error('SSH.define(' + name + '): factory must be a function')
          if (Object.prototype.hasOwnProperty.call(factories, name)) {
            throw new Error('SSH.define: duplicate module "' + name + '"')
          }
          factories[name] = factory
        },
        has: function (name) { return Object.prototype.hasOwnProperty.call(factories, name) },
        names: function () { return Object.keys(factories) },
        /** Materialise a module on first use; cycles are reported, not deadlocked. */
        require: function (name) {
          if (Object.prototype.hasOwnProperty.call(cache, name)) return cache[name]
          if (!Object.prototype.hasOwnProperty.call(factories, name)) {
            throw new Error('SSH.require: unknown module "' + name + '" (did the file declare @module?)')
          }
          var exports = {}
          cache[name] = exports
          try {
            var produced = factories[name](api)
            if (produced !== undefined) cache[name] = produced
          } catch (error) {
            delete cache[name]
            throw error
          }
          return cache[name]
        },
        /** Package-owned stylesheet insertion, removed with the client run. */
        style: {
          insert: function (css) {
            var node = document.createElement('style')
            node.setAttribute('data-dsh-ssh', '1')
            node.textContent = css
            document.head.appendChild(node)
            styleNodes.push(node)
            return function () {
              var index = styleNodes.indexOf(node)
              if (index >= 0) styleNodes.splice(index, 1)
              if (node.parentNode) node.parentNode.removeChild(node)
            }
          },
          disposeAll: function () {
            while (styleNodes.length > 0) {
              var node = styleNodes.pop()
              if (node && node.parentNode) node.parentNode.removeChild(node)
            }
          },
        },
      }
      return api
    })()
`
}

function epilogue() {
  return `    // ---- package exports ----------------------------------------------------
    var plugin = SSH.require('ssh.plugin')
    exports.apply = plugin.apply
    exports.inject = plugin.inject
    /** Diagnostics escape hatch: the live bridge/store of the current run. */
    exports.introspect = plugin.currentRuntime
    exports.describeRegistrations = plugin.describeRegistrations
    /** The components this package registers, for tests and for later seats. */
    exports.components = plugin.components
`
}

/** Compose the whole bundle text from the sources on disk. Deterministic. */
export function buildBundle() {
  const sources = collectSources().map((file) => parseSource(file))
  sources.sort((a, b) => (a.order - b.order) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
  assertUniqueModules(sources)

  const body = sources
    .map((source) => {
      const banner = `    // ─── ${source.moduleName}  (${relative(ROOT, source.file).split(sep).join('/')}, @order ${source.order})`
      const text = source.text.replace(/\r\n/g, '\n').replace(/\s*$/, '')
      return `${banner}\n${text}\n`
    })
    .join('\n')

  const bundle = `// GENERATED by scripts/build-client.mjs — do not edit by hand.
// Sources: client/src/**/*.js (${sources.length} modules, @order ascending).
// The bundle is one lazy-CJS factory: running it only registers factories, and
// module bodies execute at first SSH.require(). Its sole external is "react".
window.__ModuleLoader__.load({
  id: ${JSON.stringify(BUNDLE_ID)},
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
${preamble()}
    // ---- modules ------------------------------------------------------------
${body}
${epilogue()}    return module.exports
  },
})
`

  // "Assembled" must imply "the browser can parse it": the composed factory is
  // the exact text the page evaluates, so a syntax error is caught here.
  assertParsableBundle(bundle)
  return bundle
}

/** CLI entry: only runs when this file is executed, never when it is imported. */
function runCli() {
  const args = new Set(process.argv.slice(2))
  const bundle = buildBundle()

  if (args.has('--print')) {
    process.stdout.write(bundle)
    return
  }

  if (args.has('--check')) {
    let current = ''
    try {
      current = readFileSync(OUT_FILE, 'utf8')
    } catch {
      console.error(`client bundle missing: ${relative(ROOT, OUT_FILE)} (run: node scripts/build-client.mjs)`)
      process.exitCode = 1
      return
    }
    if (current !== bundle) {
      console.error('client bundle is stale: run `node scripts/build-client.mjs` and commit lib/client.js')
      process.exitCode = 1
      return
    }
    console.log('client bundle is up to date')
    return
  }

  mkdirSync(dirname(OUT_FILE), { recursive: true })
  const existed = (() => {
    try {
      return statSync(OUT_FILE).size
    } catch {
      return -1
    }
  })()
  writeFileSync(OUT_FILE, bundle, 'utf8')
  console.log(
    `wrote ${relative(ROOT, OUT_FILE)} (${Buffer.byteLength(bundle)} bytes${existed >= 0 ? `, was ${existed}` : ''})`,
  )
}

const invokedDirectly = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return resolve(entry) === resolve(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (invokedDirectly) runCli()
