/**
 * Vendor `@xterm/xterm` (+ `@xterm/addon-fit`) into `client/src/vendor/`.
 *
 * Why vendor instead of depending: the client bundle is loaded by DSH's browser
 * module loader with exactly one allowed external (`react`), so every byte of the
 * terminal emulator has to travel inside `lib/client.js`. The registry tarball is
 * downloaded once, its UMD build is wrapped as an ordinary `@module` source, and
 * the result is committed - the build therefore stays reproducible offline and
 * `--check` can detect a hand-edited vendor file.
 *
 * The script is dependency-free on purpose (no `tar` package): a USTAR reader is
 * ~40 lines and keeps the supply chain to `node:` modules only.
 *
 * Usage:
 *   node scripts/vendor-xterm.mjs            # download (or reuse cache) + write
 *   node scripts/vendor-xterm.mjs --check    # verify vendored files against VENDOR.json
 *   node scripts/vendor-xterm.mjs --offline  # never hit the network (cache only)
 */

import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(HERE, '..')
const VENDOR_DIR = join(ROOT, 'client', 'src', 'vendor')
const CACHE_DIR = join(ROOT, '.vendor-cache')
const MANIFEST = join(VENDOR_DIR, 'VENDOR.json')

/** Pinned versions: a vendor refresh is a deliberate, reviewed change. */
export const PACKAGES = [
  {
    name: '@xterm/xterm',
    version: '5.5.0',
    tarball: 'https://registry.npmjs.org/@xterm/xterm/-/xterm-5.5.0.tgz',
    license: 'MIT',
    homepage: 'https://github.com/xtermjs/xterm.js',
    files: [{ entry: 'package/lib/xterm.js', as: 'xterm.umd.js' }],
    css: [{ entry: 'package/css/xterm.css', as: 'xterm.css' }],
  },
  {
    name: '@xterm/addon-fit',
    version: '0.10.0',
    tarball: 'https://registry.npmjs.org/@xterm/addon-fit/-/addon-fit-0.10.0.tgz',
    license: 'MIT',
    homepage: 'https://github.com/xtermjs/xterm.js',
    files: [{ entry: 'package/lib/addon-fit.js', as: 'addon-fit.umd.js' }],
  },
]

/**
 * Output file names inside `client/src/vendor/`.
 *
 * Every one of them is an ordinary `@module` source, so the assembler needs no
 * special case for vendor code: it is collected, ordered and emitted exactly like
 * a hand-written file, and the assembler's own unit tests keep passing.
 */
export const OUTPUT_FILES = {
  xterm: 'xterm.module.js',
  fit: 'addon-fit.module.js',
  css: 'xterm.css.module.js',
  manifest: 'VENDOR.json',
}

/** Export names of the generated modules, keyed by output file. */
export const OUTPUT_MODULES = {
  [OUTPUT_FILES.xterm]: 'ssh.vendor.xterm',
  [OUTPUT_FILES.fit]: 'ssh.vendor.fit',
  [OUTPUT_FILES.css]: 'ssh.vendor.xterm.css',
}

const GENERATED_BY = 'scripts/vendor-xterm.mjs'
const BEGIN_MARKER = '/* ---- begin verbatim vendor ('
const END_MARKER = '/* ---- end verbatim vendor ---- */'

/** Minimal USTAR reader: enough for npm tarballs (regular files only). */
export function readTarEntries(buffer) {
  const entries = new Map()
  let offset = 0
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    if (name === '') break
    const sizeField = header
      .subarray(124, 136)
      .toString('utf8')
      .replace(/\0.*$/, '')
      .trim()
    const size = parseInt(sizeField || '0', 8)
    const typeFlag = String.fromCharCode(header[156])
    const body = buffer.subarray(offset + 512, offset + 512 + size)
    if (typeFlag === '0' || typeFlag === '\0') entries.set(name.replace(/^\.\//, ''), Buffer.from(body))
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return entries
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

async function fetchTarball(pkg, { offline }) {
  mkdirSync(CACHE_DIR, { recursive: true })
  const cacheFile = join(CACHE_DIR, `${pkg.name.replace(/[@/]/g, '_')}-${pkg.version}.tgz`)
  if (existsSync(cacheFile)) return { buffer: readFileSync(cacheFile), cached: true }
  if (offline) throw new Error(`--offline but ${cacheFile} is not cached`)
  const response = await fetch(pkg.tarball)
  if (!response.ok) throw new Error(`GET ${pkg.tarball} -> HTTP ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  writeFileSync(cacheFile, buffer)
  return { buffer, cached: false }
}

/** Prefix every line so the payload nests inside the factory, losslessly. */
function indent(text, spaces) {
  const pad = ' '.repeat(spaces)
  return text
    .split('\n')
    .map((line) => (line === '' ? '' : pad + line))
    .join('\n')
}

/** Undo `indent()` for a marked region (used by `--check`). */
function deindent(text, spaces) {
  const pad = ' '.repeat(spaces)
  return text
    .split('\n')
    .map((line) => (line.startsWith(pad) ? line.slice(pad.length) : line))
    .join('\n')
}

/**
 * Wrap a UMD build as an ordinary `@module` source.
 *
 * The local `module`/`exports` shim is load-bearing, not decoration: the upstream
 * UMD prologue tests `typeof exports === 'object' && typeof module === 'object'`
 * and takes its CommonJS branch when both are visible. Without the shim it would
 * see the *bundle's own* `exports` object, assign the emulator onto it and lose
 * the plugin's exports. The payload between the markers is byte-identical to the
 * tarball; `--check` re-derives its sha256 from the file on disk.
 */
function wrapUmd({ moduleName, order, title, file, umd, payloadSha256, exportsExpression }) {
  return `/**
 * @module ${moduleName}
 * @order ${order}
 *
 * ${title}
 *
 * VENDORED CODE - do not edit by hand. Generated by ${GENERATED_BY};
 * regenerate with \`node scripts/vendor-xterm.mjs\`. The bundle's only external is
 * "react", so third-party sources travel inside lib/client.js.
 *
 * The upstream build is embedded verbatim between the markers below; the local
 * module/exports shim keeps its UMD prologue on the CommonJS branch, and the local
 * self alias keeps it evaluating when no browser global exists (headless tests).
 * Payload sha256: ${payloadSha256}
 */
SSH.define('${moduleName}', function (SSH) {
  var module = { exports: {} }
  var exports = module.exports
  var self = typeof globalThis !== 'undefined' ? globalThis : this
  var window = self && self.window ? self.window : undefined
  var document = self && self.document ? self.document : undefined
  /* eslint-disable */
  /* ---- begin verbatim vendor (${file}) ---- */
${indent(umd, 2)}
  /* ---- end verbatim vendor ---- */
  /* eslint-enable */
  return ${exportsExpression}
})
`
}

/**
 * Embed a stylesheet as a module that installs it once and hands back the text.
 *
 * The payload is carried as one JSON string per line rather than as raw text: a
 * stylesheet may legitimately contain a comment terminator, and a raw embed would
 * close this wrapper's own doc comment.
 */
function wrapCss({ moduleName, order, title, file, css }) {
  const lines = css
    .split('\n')
    .map((line) => `    ${JSON.stringify(line)},`)
    .join('\n')
  return `/**
 * @module ${moduleName}
 * @order ${order}
 *
 * ${title}
 *
 * VENDORED CODE - do not edit by hand. Generated by ${GENERATED_BY}.
 * Exposed as a module rather than as a plain stylesheet because the assembler only
 * collects JavaScript sources; install() inserts it exactly once per client run,
 * so a hot reload cannot stack duplicate stylesheets.
 *
 * Upstream file embedded verbatim between the markers below (${file}).
 */
SSH.define('${moduleName}', function (SSH) {
  var CSS = [
    /* ---- begin verbatim vendor (${file}) ---- */
${lines}
    /* ---- end verbatim vendor ---- */
  ].join('\\n')
  var inserted = null
  function install() {
    if (inserted) return inserted
    inserted = SSH.style.insert(CSS)
    return inserted
  }
  return { css: CSS, install: install }
})
`
}

/**
 * Recover the upstream bytes a generated module carries.
 *
 * The payload sits between two markers; `--check` re-hashes it against
 * `VENDOR.json`, so "embedded verbatim" is verified rather than asserted.
 * `kind` selects the envelope: `umd` is indented source, `css` is one JSON string
 * per line.
 */
export function extractPayload(generated, kind) {
  const start = generated.indexOf(BEGIN_MARKER)
  const end = generated.indexOf(END_MARKER)
  if (start < 0 || end < 0 || end < start) return null
  const afterBegin = generated.indexOf('\n', start)
  if (afterBegin < 0) return null
  const body = generated.slice(afterBegin + 1, end)
  // The slice ends on the indentation in front of the end marker; drop it.
  const trimmed = body.slice(0, body.lastIndexOf('\n') + 1).replace(/\n$/, '')
  if (kind === 'css') {
    return trimmed
      .split('\n')
      .map((line) => JSON.parse(line.trim().replace(/,$/, '')))
      .join('\n')
  }
  return deindent(trimmed, 2)
}

/**
 * Guard the wrapper against the two things the assembler rejects: an `import`/
 * `export` statement at the start of a line, and a second `@module` header that
 * could win over ours. Vendored UMD code should trip neither; if a future version
 * does, this fails loudly instead of producing a bundle DSH cannot load.
 */
export function assertVendorable(label, source) {
  const esm = source.split('\n').findIndex((line) => /^\s*(import|export)\s/.test(line))
  if (esm >= 0) throw new Error(`${label}: line ${esm + 1} looks like an ESM statement; the assembler rejects it`)
  const header = source
    .split('\n')
    .findIndex((line) => /^[ \t]*(?:\/\/|\*)[ \t]*@module[ \t]+\S+[ \t]*$/.test(line))
  if (header >= 0) throw new Error(`${label}: line ${header + 1} declares an @module header`)
}

/** Compose all vendored files from the tarballs (deterministic bytes). */
export async function generate({ offline = false } = {}) {
  const assets = new Map()
  const manifest = { generatedBy: GENERATED_BY, packages: [] }

  for (const pkg of PACKAGES) {
    const { buffer } = await fetchTarball(pkg, { offline })
    const entries = readTarEntries(gunzipSync(buffer))
    const record = {
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      homepage: pkg.homepage,
      tarball: pkg.tarball,
      tarballSha256: sha256(buffer),
      files: [],
    }
    for (const file of [...pkg.files, ...(pkg.css ?? [])]) {
      const source = entries.get(file.entry)
      if (!source) throw new Error(`${pkg.name}@${pkg.version}: ${file.entry} is missing from the tarball`)
      const text = source.toString('utf8')
      assertVendorable(`${pkg.name}:${file.entry}`, text)
      const hash = sha256(Buffer.from(text, 'utf8'))
      assets.set(file.as, { text, entry: file.entry, sha256: hash })
      record.files.push({ entry: file.entry, as: file.as, sha256: hash })
    }
    manifest.packages.push(record)
  }

  const xterm = assets.get('xterm.umd.js')
  const fit = assets.get('addon-fit.umd.js')
  const css = assets.get('xterm.css')

  const modules = new Map()
  modules.set(
    OUTPUT_FILES.xterm,
    wrapUmd({
      moduleName: OUTPUT_MODULES[OUTPUT_FILES.xterm],
      order: 5,
      title: `xterm.js terminal emulator (${PACKAGES[0].name}@${PACKAGES[0].version}).`,
      file: xterm.entry,
      umd: xterm.text,
      payloadSha256: xterm.sha256,
      exportsExpression: 'module.exports',
    }),
  )
  modules.set(
    OUTPUT_FILES.fit,
    wrapUmd({
      moduleName: OUTPUT_MODULES[OUTPUT_FILES.fit],
      order: 6,
      title: `xterm fit addon (${PACKAGES[1].name}@${PACKAGES[1].version}) - sizes the grid to its container.`,
      file: fit.entry,
      umd: fit.text,
      payloadSha256: fit.sha256,
      exportsExpression: 'module.exports',
    }),
  )
  modules.set(
    OUTPUT_FILES.css,
    wrapCss({
      moduleName: OUTPUT_MODULES[OUTPUT_FILES.css],
      order: 7,
      title: `xterm.js stylesheet (${PACKAGES[0].name}@${PACKAGES[0].version}).`,
      file: css.entry,
      css: css.text,
    }),
  )

  const kinds = {
    [OUTPUT_FILES.xterm]: { asset: 'xterm.umd.js', kind: 'umd' },
    [OUTPUT_FILES.fit]: { asset: 'addon-fit.umd.js', kind: 'umd' },
    [OUTPUT_FILES.css]: { asset: 'xterm.css', kind: 'css' },
  }
  manifest.modules = [...modules.entries()].map(([file, text]) => ({
    file,
    module: OUTPUT_MODULES[file],
    kind: kinds[file].kind,
    sha256: sha256(Buffer.from(text, 'utf8')),
    // The payload's own digest, so a hand edit that keeps the envelope intact is
    // still caught: `--check` re-extracts the marked region and re-hashes it.
    upstreamSha256: assets.get(kinds[file].asset).sha256,
  }))
  return { modules, manifest, assets }
}

/** Verify the committed vendor files against the recorded digests (no network). */
export function checkVendored() {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  } catch {
    console.error(`missing ${MANIFEST} - run: node scripts/vendor-xterm.mjs`)
    return 1
  }
  let stale = 0
  for (const entry of manifest.modules ?? []) {
    const file = join(VENDOR_DIR, entry.file)
    if (!existsSync(file)) {
      console.error(`missing vendored file: client/src/vendor/${entry.file}`)
      stale += 1
      continue
    }
    const text = readFileSync(file, 'utf8')
    if (sha256(Buffer.from(text, 'utf8')) !== entry.sha256) {
      console.error(`vendored file was modified: client/src/vendor/${entry.file}`)
      stale += 1
      continue
    }
    const payload = extractPayload(text, entry.kind)
    if (payload === null) {
      console.error(`cannot recover the upstream payload from client/src/vendor/${entry.file}`)
      stale += 1
      continue
    }
    if (sha256(Buffer.from(payload, 'utf8')) !== entry.upstreamSha256) {
      console.error(`upstream payload inside client/src/vendor/${entry.file} no longer matches the tarball`)
      stale += 1
    }
  }
  if (stale > 0) {
    console.error('vendored xterm is out of sync - regenerate with `node scripts/vendor-xterm.mjs`')
    return 1
  }
  const names = (manifest.packages ?? []).map((pkg) => `${pkg.name}@${pkg.version}`).join(', ')
  console.log(`vendored xterm is intact (${names})`)
  return 0
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

if (invokedDirectly) {
  const args = new Set(process.argv.slice(2))
  if (args.has('--check')) {
    process.exitCode = checkVendored()
  } else {
    generate({ offline: args.has('--offline') })
      .then(({ modules, manifest }) => {
        mkdirSync(VENDOR_DIR, { recursive: true })
        for (const [file, text] of modules) writeFileSync(join(VENDOR_DIR, file), text, 'utf8')
        writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
        const names = manifest.packages.map((pkg) => `${pkg.name}@${pkg.version}`).join(', ')
        console.log(`vendored ${names} into client/src/vendor/`)
        for (const [file, text] of modules) console.log(`  ${file}  ${Buffer.byteLength(text)} bytes`)
      })
      .catch((error) => {
        console.error(String(error && error.message ? error.message : error))
        process.exitCode = 1
      })
  }
}
