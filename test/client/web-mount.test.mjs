/**
 * The **web half** contract, asserted at the artifact level.
 *
 * Everything else in `test/client/` exercises a module in isolation. This file
 * asks the question a person actually has when the plugin is installed into a
 * browser profile: *does the built bundle mount the SSH panel into the slots the
 * manifest promises, and can it be loaded by a web shell that only provides
 * `react`?*
 *
 * The three claims, all of them regressions that would otherwise only show up in
 * a running GUI:
 *
 *   1. the bundle registers itself under the package name in `dsh.plugin.json`,
 *      and needs exactly one external (`react`) — the "zero external risk" claim;
 *   2. the manifest's `client.tabId` is the key the bundle actually registers for
 *      the tab body, so renaming one side alone fails here;
 *   3. `apply()` reaches the platform's `slots` service and registers a mountable
 *      component for the tab body and its title — the sidebar panel mount.
 *
 * A real browser is deliberately *not* started: CI has no DSH web shell to load
 * the plugin into, and a hand-rolled mock of one would only prove the mock. See
 * README §1.3 for the end-to-end check that runs against a real profile.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

import * as React from 'react'

import { BUNDLE_PATH, fakeContext, fakeLocale, fakeSlots, fakeTabRegistry, installDom } from './harness.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

const manifest = JSON.parse(readFileSync(join(ROOT, 'dsh.plugin.json'), 'utf8'))

/**
 * Evaluate the built bundle with a web shell's module loader and hand back the
 * plugin's `apply`, exactly as the loader would.
 */
async function loadPlugin() {
  installDom()
  const source = readFileSync(BUNDLE_PATH, 'utf8')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-webhalf-'))
  const copy = join(dir, 'client.mjs')
  writeFileSync(copy, source, 'utf8')
  const rows = []
  globalThis.window.__ModuleLoader__ = { load: (row) => rows.push(row) }
  try {
    await import(`${pathToFileURL(copy).href}?v=${Date.now()}`)
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* a locked temp dir must never fail the test */
    }
  }
  assert.equal(rows.length, 1, 'the bundle must register exactly one loader row')
  const requested = []
  const exported = rows[0].factory((specifier) => {
    requested.push(specifier)
    if (specifier === 'react') return React
    throw new Error(`the bundle asked for an unexpected external: ${specifier}`)
  })
  return { row: rows[0], exported, requested, source }
}

test('the bundle registers under the manifest package name and has react as its only external', async () => {
  const { row, source } = await loadPlugin()
  assert.equal(row.id, manifest.packageName, 'the loader id must be the manifest package name')

  // The bundle's internal modules are required by their own ids (`ssh.panel`,
  // `ssh.session.term`, …), and the assembler banners every one of them, so the
  // externals are what is left after subtracting those ids. A web shell provides
  // only `react`; anything else would fail to resolve there.
  const internal = new Set()
  for (const match of source.matchAll(/\/\/ ─── (\S+)\s+\(/g)) internal.add(match[1])
  assert.ok(internal.size > 10, `expected the assembler banners to name the modules, found ${internal.size}`)

  const required = new Set()
  for (const match of source.matchAll(/require\((["'])([^"'.][^"']*)\1\)/g)) required.add(match[2])
  const externals = [...required].filter((specifier) => !internal.has(specifier)).sort()
  assert.deepEqual(externals, ['react'], 'the only external may be react')
})

test('the manifest tabId is the key the bundle registers for the tab body', async () => {
  const { exported } = await loadPlugin()
  const slots = fakeSlots()
  const tabRegistry = fakeTabRegistry()
  const locale = fakeLocale()
  assert.equal(typeof exported.apply, 'function', 'the bundle must export apply()')

  await exported.apply(fakeContext({ slots, locale, sidebarRightTabs: tabRegistry }))

  // The manifest is the contract the platform reads; the bundle is what runs.
  assert.equal(manifest.client.tabId, 'ssh')
  assert.equal(manifest.client.tabKind, 'ssh')

  const body = slots.registered.find((entry) => entry.declaration?.name === 'sidebar.right.pane.tab')
  assert.ok(body, 'apply() must register the tab body slot')
  assert.equal(body.declaration.key, manifest.client.tabId, 'the tab body key must be the manifest tabId')
  assert.equal(typeof body.component, 'function', 'the tab body must be a mountable component')

  const title = slots.registered.find((entry) => entry.declaration?.name === 'sidebar.right.pane.tab.title')
  assert.ok(title, 'apply() must register the tab title slot')
  assert.equal(title.declaration.key, manifest.client.tabId)

  // `panelIcon` is deliberately not asserted here: the manifest tells the
  // platform where to place the plugin's icon in the panel list, and the platform
  // does the placing — apply() never touches that slot. The two slots the plugin
  // itself mounts into are the tab body and its title.
  assert.equal(manifest.client.slots.tabBody, 'sidebar.right.pane.tab')
  assert.equal(manifest.client.slots.tabTitle, 'sidebar.right.pane.tab.title')
})

test('apply() tolerates a web shell whose slots service is absent, and says so', async () => {
  const { exported } = await loadPlugin()
  // The composition may mount the plugin before the UI services exist; the
  // plugin must not throw into the loader in that case (a throwing apply() takes
  // the whole client down, not just this panel).
  await assert.doesNotReject(async () => {
    await exported.apply(fakeContext({ locale: fakeLocale() }))
  })
})
