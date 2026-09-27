#!/usr/bin/env node
/**
 * Lint entry point used by scripts/verify-all.mjs.
 *
 * Two modes, in this order:
 *   1. `eslint` — when the package is resolvable (flat config in eslint.config.js).
 *   2. built-in structural linter — used when eslint is not installed. It is not
 *      a replacement for eslint: it enforces exactly the *house rules* the
 *      compiler and the test suite cannot see, so "lint" never silently becomes
 *      a no-op.
 *
 * Both modes exit non-zero with a `file:line: message` list on any violation.
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

/** Directories that are upstream code or build output, never first-party. */
const EXCLUDED_DIRS = new Set(['node_modules', 'lib', '.git', 'docs', 'img', 'vendor', 'coverage'])

function walk(dir, filter, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue
    if (EXCLUDED_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, filter, out)
    else if (filter(full)) out.push(full)
  }
  return out
}

const rel = (path) => relative(ROOT, path).replace(/\\/g, '/')

// ---------------------------------------------------------------------------
// built-in structural linter
// ---------------------------------------------------------------------------

const violations = []

function report(file, line, message) {
  violations.push(`${rel(file)}:${line}: ${message}`)
}

// Mirrors scripts/build-client.mjs: a `@module` header may be a JSDoc line
// (`* @module x`) or a plain line comment (`// @module x`), on any line.
const MODULE_HEADER = /^[ \t]*(?:\/\/|\*)[ \t]*@module[ \t]+(\S+)[ \t]*$/
const ORDER_HEADER = /^[ \t]*(?:\/\/|\*)[ \t]*@order[ \t]+(\d+)[ \t]*$/
const ESM_SYNTAX = /^\s*(import\s[\s{*'"]|import\s*\(|export\s+(default|const|let|var|function|class|{|\[))/
const HARDCODED_COLOR = /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(/
const FOCUSED_TEST = /\b(?:test|it|describe)\.only\s*\(/
const SKIP_WITHOUT_REASON = /\b(?:t|test|it)\.skip\(\s*\)/
const COMMENT_LINE = /^\s*(?:\*|\/\/|\/\*)/

function lintClientSources() {
  const files = walk(join(ROOT, 'client', 'src'), (path) => extname(path) === '.js')
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    const moduleLine = lines.findIndex((line) => MODULE_HEADER.test(line))
    if (moduleLine === -1) {
      report(file, 1, 'missing `@module <namespace.name>` header (ICD §0.4)')
    } else {
      const name = MODULE_HEADER.exec(lines[moduleLine])[1]
      if (!name.startsWith('ssh.')) {
        report(file, moduleLine + 1, `@module "${name}" must be namespaced (expected the \`ssh.\` prefix, ICD §0.4)`)
      }
    }
    const orderLine = lines.findIndex((line) => ORDER_HEADER.test(line))
    if (orderLine === -1) {
      report(file, 1, 'missing `@order <0-999>` header (ICD §0.4)')
    } else {
      const value = Number(ORDER_HEADER.exec(lines[orderLine])[1])
      if (value > 999) report(file, orderLine + 1, `@order ${value} out of range (0-999)`)
    }
    lines.forEach((line, index) => {
      if (ESM_SYNTAX.test(line)) {
        report(file, index + 1, 'no ESM syntax in client bundle sources; use SSH.define/SSH.require (ICD §0.4)')
      }
      if (COMMENT_LINE.test(line)) return
      const code = line.replace(/\/\/.*$/, '')
      const color = HARDCODED_COLOR.exec(code)
      if (color) {
        report(file, index + 1, `hardcoded color ${JSON.stringify(color[0])}: use a --dsw-* theme token (ICD §8.6)`)
      }
    })
  }
  return files.length
}

function lintTests() {
  const files = walk(join(ROOT, 'test'), (path) => extname(path) === '.mjs')
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    lines.forEach((line, index) => {
      if (FOCUSED_TEST.test(line)) report(file, index + 1, 'focused test left behind (.only)')
      if (SKIP_WITHOUT_REASON.test(line)) report(file, index + 1, 'skip without a reason: a skipped test must say why')
    })
  }
  return files.length
}

function lintTextIntegrity() {
  // A U+FFFD anywhere means a tool (typically a PowerShell pipeline) damaged the
  // file; the client assembler hard-fails on it, and the same rule applies to
  // every first-party source file.
  const files = [
    ...walk(join(ROOT, 'src'), (path) => ['.ts', '.mts', '.js'].includes(extname(path))),
    ...walk(join(ROOT, 'test'), (path) => extname(path) === '.mjs'),
    ...walk(join(ROOT, 'scripts'), (path) => extname(path) === '.mjs'),
    ...walk(join(ROOT, 'client', 'src'), (path) => extname(path) === '.js'),
    ...walk(join(ROOT, 'locale'), (path) => extname(path) === '.json'),
  ]
  let scanned = 0
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    scanned += 1
    const index = text.indexOf('\uFFFD')
    if (index >= 0) {
      const line = text.slice(0, index).split('\n').length
      report(file, line, 'file contains U+FFFD (encoding damage); rewrite it as UTF-8')
    }
  }
  return scanned
}

function lintBundleHeader() {
  const bundle = join(ROOT, 'lib', 'client.js')
  if (!existsSync(bundle)) return 0
  const head = readFileSync(bundle, 'utf8').slice(0, 200)
  if (!head.startsWith('// GENERATED by scripts/build-client.mjs')) {
    report(bundle, 1, 'bundle must start with the GENERATED header (ICD §0.3)')
  }
  return 1
}

function runStructuralLint() {
  const clientFiles = lintClientSources()
  const testFiles = lintTests()
  const textFiles = lintTextIntegrity()
  lintBundleHeader()
  console.log(`structural lint: client sources ${clientFiles}, tests ${testFiles}, text files ${textFiles}`)
  if (!violations.length) {
    console.log('structural lint: no violations')
    return 0
  }
  for (const line of violations) console.log(`  ${line}`)
  console.log(`structural lint: ${violations.length} violation(s)`)
  return 1
}

// ---------------------------------------------------------------------------
// eslint (preferred when installed)
// ---------------------------------------------------------------------------

function resolveEslint() {
  const bundled = join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js')
  if (existsSync(bundled)) return bundled
  try {
    return require.resolve('eslint/bin/eslint.js')
  } catch {
    return null
  }
}

function runEslint(bin) {
  const targets = ['client/src', 'scripts', 'test', 'eslint.config.js'].filter((target) => existsSync(join(ROOT, target)))
  console.log(`eslint: ${bin}`)
  console.log(`eslint: targets ${targets.join(' ')}`)
  // Errors fail the layer, warnings are reported but do not (M4 acceptance is
  // "lint 零错误"; the surviving warnings are style-only).
  const result = spawnSync(process.execPath, [bin, ...targets], {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error) {
    console.error(`eslint: failed to run (${result.error.message})`)
    return null
  }
  return result.status ?? 1
}

const eslintBin = resolveEslint()
if (eslintBin) {
  const status = runEslint(eslintBin)
  if (status === null) {
    console.log('eslint: unavailable, falling back to the built-in structural linter')
    process.exit(runStructuralLint())
  }
  process.exit(status)
}

console.log('eslint: not installed in this package; running the built-in structural linter')
console.log('        (see docs/TESTING.md — install eslint to enable the full rule set)')
process.exit(runStructuralLint())
