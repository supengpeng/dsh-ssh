#!/usr/bin/env node
/**
 * Run a test directory portably.
 *
 * `node --test "test/unit/*.test.mjs"` does not mean one thing everywhere: the
 * quotes keep the shell from expanding the pattern, so the glob is left for
 * Node — and glob support in `--test` only exists from Node 22 on. On Node 20
 * the pattern arrives as a literal path and the runner reports
 *
 *     Could not find '/…/test/unit/*.test.mjs'
 *
 * so the step fails having executed **nothing**. On Windows the same command
 * looks fine locally (PowerShell does not expand globs either, but Node 24
 * expands them), which is exactly how this reached CI.
 *
 * This wrapper removes the shell and the Node version from the question: it
 * discovers the files itself and passes them as explicit paths, which every
 * version of `--test` understands.
 *
 * usage: node scripts/run-tests.mjs <dir> [--test-* flags…]
 *        node scripts/run-tests.mjs <dir> --list
 */

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const listOnly = argv.includes('--list')
const positional = argv.filter((arg) => !arg.startsWith('--'))
const flags = argv.filter((arg) => arg.startsWith('--') && arg !== '--list')

if (positional.length === 0) {
  console.error('usage: node scripts/run-tests.mjs <dir> [--test-* flags…] [--list]')
  process.exit(2)
}

/** Every `*.test.mjs` under `dir`, sorted, as paths relative to the repo root. */
function discover(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...discover(full))
    else if (entry.isFile() && entry.name.endsWith('.test.mjs')) found.push(full)
  }
  return found
}

// `import.meta.dirname` is only Node 20.11+, and this script's whole reason to
// exist is not depending on a Node version being recent enough.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const files = []
for (const dir of positional) {
  const absolute = resolve(root, dir)
  let discovered
  try {
    discovered = discover(absolute)
  } catch (error) {
    console.error(`run-tests: cannot read ${dir}: ${error.message}`)
    process.exit(2)
  }
  if (discovered.length === 0) {
    // An empty directory is a failure, not a pass: a suite that silently runs
    // nothing is the defect this script exists to prevent.
    console.error(`run-tests: no *.test.mjs under ${dir}`)
    process.exit(1)
  }
  files.push(...discovered)
}

const relativeFiles = files.map((file) => relative(root, file).split('\\').join('/')).sort()
console.log(`run-tests: ${relativeFiles.length} file(s) ${positional.length === 1 ? `under ${positional[0]}` : ''}`)

if (listOnly) {
  for (const file of relativeFiles) console.log(`  ${file}`)
  process.exit(0)
}

const result = spawnSync(process.execPath, ['--test', ...flags, ...relativeFiles], { cwd: root, stdio: 'inherit' })
if (result.error) {
  console.error(`run-tests: could not start the runner: ${result.error.message}`)
  process.exit(2)
}
process.exit(result.status ?? 1)
