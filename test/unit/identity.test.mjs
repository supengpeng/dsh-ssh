/**
 * Identity contract: the three places that name this plugin must agree.
 *
 * A mismatch here is not cosmetic — `cordis.patch.yml`'s row id addresses the
 * Loader entry, `dsh.plugin.json` is what humans and tooling read, and the
 * exported `name` is what the Host registers. If they drift, the plugin either
 * fails to activate or activates under a key nobody looks for.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const readJson = (rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'))
const readText = (rel) => readFileSync(join(root, rel), 'utf8')

const EXPECTED_ID = 'dsh-ssh'
const EXPECTED_PACKAGE = '@local/dsh-ssh'

test('manifest, patch row and exported name all agree', async () => {
  const manifest = readJson('dsh.plugin.json')
  const patch = readText('cordis.patch.yml')
  const mod = await import('../../lib/index.js')

  assert.equal(manifest.id, EXPECTED_ID)
  assert.equal(manifest.exportName, EXPECTED_ID)
  assert.equal(manifest.packageName, EXPECTED_PACKAGE)
  assert.equal(mod.name, EXPECTED_ID)

  // The insert row id is the Loader entry id the patch contributes.
  const rowId = /-\s*insert:\s*\n\s*-\s*id:\s*(\S+)/.exec(patch)?.[1]
  assert.equal(rowId, EXPECTED_ID, 'cordis.patch.yml insert row id must equal the plugin id')

  // The patch row must name this exact package, not a published stand-in.
  assert.match(patch, new RegExp(`name:\\s*'?${EXPECTED_PACKAGE.replace(/[/@]/g, (c) => `\\${c}`)}'?`))
})

test('package metadata wires the patch and the client half', () => {
  const pkg = readJson('package.json')
  assert.equal(pkg.name, EXPECTED_PACKAGE)
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.equal(pkg.exports?.['.']?.import, './lib/index.js')
  assert.equal(pkg.exports?.['./client'], './lib/client.js')
  // The client bundle must be self-contained: no non-baseline externals.
  assert.equal(pkg.dsh?.client?.external, undefined)
  assert.equal(pkg.type, 'module')
})

test('dsh.plugin.json tool list matches the config default', () => {
  const manifest = readJson('dsh.plugin.json')
  // The patch row is the config default the Loader applies; the manifest
  // advertises the same capability set for humans and tooling. The invariant that
  // matters is that the two halves *agree* — a hardcoded list here would have to be
  // edited on every tool change and would stop being read the moment it is.
  const patch = readText('cordis.patch.yml')
  const toolNames = [...patch.matchAll(/^\s*-\s*(ssh_\w+)\s*$/gm)].map((m) => m[1])

  assert.deepEqual(toolNames, [
    'ssh_connect',
    'ssh_disconnect',
    'ssh_sessions',
    'ssh_exec',
    'ssh_upload',
    'ssh_download',
    'ssh_list_dir',
  ])
  assert.deepEqual(manifest.tools, toolNames, 'manifest and patch must list the same tools')
  // Every advertised name must be namespaced, and connect must come before the
  // tools that need a live session (the list is also the reading order for a model).
  for (const name of toolNames) assert.match(name, /^ssh_[a-z_]+$/)
  assert.ok(toolNames.indexOf('ssh_connect') < toolNames.indexOf('ssh_exec'))
})
