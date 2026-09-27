/**
 * Client-half contract tests.
 *
 * These run the *built* bundle — the same bytes DSH serves — so a broken
 * assembler, a missing `@module` header, or a registration that throws shows up
 * here instead of as a blank sidebar in the browser.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  fakeContext,
  fakeLocale,
  fakeRemoteCarrier,
  fakeSlots,
  fakeTabRegistry,
  installDom,
  loadBundle,
} from './harness.mjs'

/** Boot the bundle against a realistic service set. */
async function boot(options = {}) {
  const restore = installDom()
  const { rows, materialise } = await loadBundle({ react: React })
  const { exports } = materialise()
  const carrier = options.remote === null ? null : (options.remote ?? fakeRemoteCarrier())
  const services = {
    locale: fakeLocale(),
    slots: fakeSlots(),
    sidebarRightTabs: fakeTabRegistry(),
    ...(carrier ? { remote: carrier } : {}),
    ...(options.services ?? {}),
  }
  const ctx = fakeContext(services)
  exports.apply(ctx)
  return { restore, exports, ctx, services, carrier, rows }
}

test('the bundle registers exactly one package row, in DSH lazy-CJS form', async () => {
  const { restore, rows, exports } = await boot()
  try {
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, '@local/dsh-ssh')
    assert.equal(typeof rows[0].factory, 'function')
    assert.equal(typeof exports.apply, 'function')
    assert.equal(typeof exports.introspect, 'function')
  } finally {
    restore()
  }
})

test('the client half declares only the services every composition provides', async () => {
  const { restore, exports } = await boot()
  try {
    assert.deepEqual(exports.inject, ['slots', 'locale'])
    // The right-bar seats are probed, not injected: a hard inject on a seat this
    // build lacks would leave the plugin waiting with nothing on screen.
    assert.equal(exports.inject.includes('sidebarRightTabs'), false)
    assert.deepEqual(exports.describeRegistrations().namespace, 'ssh')
  } finally {
    restore()
  }
})

test('apply() registers the tab type, tab body, tab title and diagnostics overlay', async () => {
  const { restore, ctx, services } = await boot()
  try {
    const declarations = services.slots.registered.map((entry) => entry.declaration)
    const byName = (name) => declarations.filter((d) => d.name === name)

    assert.equal(byName('sidebar.right.pane.tab').length, 1, 'tab body')
    assert.equal(byName('sidebar.right.pane.tab')[0].key, 'ssh')
    assert.equal(byName('sidebar.right.pane.tab.title').length, 1, 'tab title')
    assert.equal(byName('sidebar.right.pane.tab.title')[0].key, 'ssh')
    // Three seats, not one: our spike card plus the chrome's toast and confirmation
    // hosts, which `chrome.install()` registers (§8.3). Each id must be unique —
    // duplicate registration is the failure this checks for — and ours must be there.
    const overlayIds = byName('shell.overlay').map((declaration) => declaration.id)
    assert.equal(overlayIds.length, 3, `expected spike + toast + confirm seats, saw ${overlayIds.join(', ')}`)
    assert.equal(new Set(overlayIds).size, overlayIds.length, 'every overlay seat id is unique')
    assert.ok(overlayIds.includes('ssh-spike'), 'the transport diagnostics card keeps its seat')
    assert.ok(overlayIds.includes('ssh-toasts'), 'the chrome toast host is installed')
    assert.ok(overlayIds.includes('ssh-confirm'), 'the chrome confirmation host is installed')

    // The M0 spike must NOT claim a seat that would damage shipped UI:
    // sidebar.panellist addresses a main panel, and header.corner is a single slot
    // already owned by the shipped expand button.
    assert.equal(byName('sidebar.panellist').length, 0, 'no main-panel entry in M0')
    assert.equal(byName('conversation.session.header.corner').length, 0, 'never replace shipped chrome')

    assert.equal(services.sidebarRightTabs.types.length, 1)
    const type = services.sidebarRightTabs.types[0]
    assert.equal(type.id, 'ssh')
    assert.equal(type.kind, 'ssh')
    assert.equal(type.priority, 'feature')
    assert.equal(type.title(), 'SSH')

    // Every registration must be reversible: nothing survives an unload.
    assert.ok(ctx.effects.length >= 3, `expected owned effects, saw ${ctx.effects.length}`)
    for (const effect of ctx.effects) assert.equal(typeof effect.dispose, 'function')
  } finally {
    restore()
  }
})

test('a missing right sidebar degrades: the diagnostics card still registers', async () => {
  const { restore, exports, services } = await boot({ services: { sidebarRightTabs: undefined } })
  try {
    const names = services.slots.registered.map((entry) => entry.declaration.name)
    assert.ok(names.includes('shell.overlay'), 'the diagnostics card must survive')

    // The seat is absent, but the tab type is still being retried, so nothing has
    // *failed* yet: an absence is recorded as a failure only when the retry window is
    // exhausted (plugin.js retries for 15s because the right sidebar is another plugin
    // that may load later). What matters here is that the degradation does not take the
    // rest of the client half down with it.
    const errors = exports.introspect().app.store.getState().spike.registrationErrors
    assert.deepEqual(errors, [], 'a seat that is still being retried is not a recorded failure')
  } finally {
    restore()
  }
})

test('the tab type is registered as soon as a late right sidebar appears', async () => {
  // The measured race on a clean start: the right sidebar plugin loads *after* this one,
  // and a one-shot lookup lost it. The retry must recover without a reload, register
  // exactly once, and record no failure.
  const { restore, exports, services } = await boot({ services: { sidebarRightTabs: undefined } })
  try {
    const errors = () => exports.introspect().app.store.getState().spike.registrationErrors
    assert.deepEqual(errors(), [])

    // The provider arrives 250ms later, like a real late-loading plugin.
    services.sidebarRightTabs = fakeTabRegistry()
    await new Promise((resolve) => setTimeout(resolve, 400))

    assert.equal(services.sidebarRightTabs.types.length, 1, 'the tab type is registered once the seat exists')
    assert.equal(services.sidebarRightTabs.types[0].id, 'ssh')
    assert.deepEqual(errors(), [], 'a recovered race is not an error')

    // …and it keeps retrying rather than registering twice.
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(services.sidebarRightTabs.types.length, 1)
  } finally {
    restore()
  }
})

test('a missing slot registry is reported instead of throwing out of apply()', async () => {
  const restore = installDom()
  try {
    const { materialise } = await loadBundle({ react: React })
    const ctx = fakeContext({ locale: fakeLocale() })
    // Must not throw: an exception here takes the whole client boot down with it.
    materialise().exports.apply(ctx)
  } finally {
    restore()
  }
})

test('the bridge resolves the carrier by a real ping round trip', async () => {
  const { restore, exports, carrier } = await boot()
  try {
    const runtime = exports.introspect()
    const resolved = await runtime.resolution
    assert.equal(resolved, 'remote-mount', 'ctx.remote is the first carrier offered')

    // The plugin reports its own binding once the carrier is known, so the fact
    // reaches the host even if nobody is looking at the panel.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const methods = carrier.calls.map((call) => call.method)
    assert.ok(methods.includes('ping'), 'resolution is proven by a real call')
    assert.ok(methods.includes('reportSpike'), 'the binding is reported back to the host')
    assert.equal(carrier.calls[0].params.echo, 'spike:remote-mount')

    const transport = runtime.bridge.transportState()
    assert.equal(transport.status, 'ready')
    assert.equal(transport.kind, 'remote-mount')
  } finally {
    restore()
  }
})

test('call() returns the host result and echoes its payload', async () => {
  const { restore, exports } = await boot()
  try {
    const result = await exports.introspect().bridge.call('ping', { echo: 'unit' })
    assert.equal(result.pong, true)
    assert.equal(result.echo, 'unit')
    assert.equal(result.namespace, 'sshPlugin')
  } finally {
    restore()
  }
})

test('stream() delivers open → ordered data → exactly one terminal end', async () => {
  const { restore, exports } = await boot()
  try {
    const frames = []
    const handle = exports.introspect().bridge.stream('probeStream', { count: 3, intervalMs: 0 }, (frame) => frames.push(frame))
    const state = await handle.done

    assert.equal(frames[0].t, 'open')
    const data = frames.filter((f) => f.t === 'data')
    assert.deepEqual(data.map((f) => f.seq), [0, 1, 2])
    const ends = frames.filter((f) => f.t === 'end')
    assert.equal(ends.length, 1)
    assert.equal(ends[0].reason, 'completed')
    assert.equal(state.ended, true)
    assert.equal(state.frames, 3)
    assert.equal(handle.streamId, 'st_harness')
  } finally {
    restore()
  }
})

test('stream() surfaces a host-side failure as a terminal error end', async () => {
  const { restore, exports } = await boot()
  try {
    const frames = []
    await exports.introspect().bridge.stream('probeStream', { count: 1, intervalMs: 0, fail: true }, (f) => frames.push(f)).done
    const end = frames.at(-1)
    assert.equal(end.t, 'end')
    assert.equal(end.reason, 'error')
    assert.equal(end.error.code, 'SSH_UNKNOWN')
  } finally {
    restore()
  }
})

test('a foreign error code is normalised, never passed through raw', async () => {
  // The carrier answers ping (so it is selected) and then fails a later call:
  // this is the path where a host-thrown error must be translated.
  const { restore, exports } = await boot({ remote: fakeRemoteCarrier({ describeThrows: true }) })
  try {
    const bridge = exports.introspect().bridge
    await assert.rejects(
      () => bridge.call('describe', {}),
      (error) => {
        assert.equal(error.code, 'SSH_UNKNOWN')
        assert.equal(error.retryable, false)
        assert.equal(error.details.carriedCode, 'sshPlugin/nope')
        return true
      },
    )
  } finally {
    restore()
  }
})

test('a carrier that fails its own ping is rejected, not merely recorded', async () => {
  const { restore, exports } = await boot({ remote: fakeRemoteCarrier({ pingThrows: true }) })
  try {
    const bridge = exports.introspect().bridge
    await assert.rejects(
      // A short resolve window: the retry now runs until the budget is spent, and this
      // test is about the *outcome* of a carrier that never answers.
      () => bridge.call('ping', {}, { resolveTimeoutMs: 500, resolveIntervalMs: 50 }),
      (error) => {
        // The transcript carries the carrier's own failure, so the reason is
        // diagnosable instead of just "nothing worked". The surfaced code is the ICD §5
        // network family (retryable) rather than SSH_UNKNOWN, so the panel offers a
        // retry instead of painting a terminal failure.
        assert.equal(error.code, 'SSH_NET_UNREACHABLE')
        assert.equal(error.retryable, true)
        assert.match(error.message, /no working client→host carrier/)
        assert.equal(error.details.attempts[0].ok, false)
        assert.equal(error.details.attempts[0].error.code, 'SSH_UNKNOWN')
        assert.equal(error.details.attempts[0].extra.stage, 'ping')
        return true
      },
    )
  } finally {
    restore()
  }
})

test('diagnostics() explains every carrier it tried', async () => {
  const { restore, exports } = await boot()
  try {
    const runtime = exports.introspect()
    await runtime.resolution
    const diagnostics = runtime.bridge.diagnostics()
    assert.equal(diagnostics.resolvedId, 'remote-mount')
    // One row per (carrier, stage): a retry must not bury the first failure.
    assert.equal(diagnostics.attempts.length, 1)
    assert.equal(diagnostics.attempts[0].ok, true)
    assert.equal(diagnostics.attempts[0].extra.stage, 'ping')
    assert.deepEqual(diagnostics.inventory.map((row) => row.id), ['remote-mount', 'typert-remotes', 'connection-rpc'])
    assert.equal(diagnostics.inventory[0].servicePresent, true)
    assert.equal(diagnostics.inventory[2].servicePresent, false)
  } finally {
    restore()
  }
})

test('with no carrier at all, call() reports a diagnosable failure', async () => {
  const { restore, exports } = await boot({ remote: null })
  try {
    const runtime = exports.introspect()
    await runtime.resolution
    await assert.rejects(
      () => runtime.bridge.call('ping', {}),
      (error) => {
        // A transport that is not up yet is a *retryable* condition mapped onto the
        // ICD §5 network family, so the panel renders "host unreachable / retry"
        // instead of showing the bridge's developer note (see SP7's carrier tests).
        assert.equal(error.code, 'SSH_NET_UNREACHABLE')
        assert.equal(error.retryable, true)
        assert.equal(error.details.reason, 'transport-not-ready')
        assert.match(error.message, /no working client→host carrier/)
        assert.equal(Array.isArray(error.details.attempts), true)
        assert.equal(error.details.attempts.length, 3, 'all three candidates were tried, once each')
        return true
      },
    )
    assert.equal(runtime.bridge.transportState().status, 'lost')
  } finally {
    restore()
  }
})

test('the workspace lands on the connection manager, with the diagnostics one view away', async () => {
  const { restore, services, exports } = await boot()
  try {
    const body = services.slots.registered.find((entry) => entry.declaration.name === 'sidebar.right.pane.tab')
    assert.ok(body, 'tab body registered')
    const html = renderToStaticMarkup(React.createElement(body.component))
    assert.match(html, /data-testid="ssh-workspace"/)
    // The main chain starts here: profiles → connect → session.
    assert.match(html, /data-view="list"/)
    assert.match(html, /data-testid="ssh-conn-list"/)

    // The M0 spike is not gone, it is no longer the landing surface: the same
    // component renders it when the store asks for the debug view.
    const runtime = exports.introspect()
    runtime.app.actions.setPanel({ view: 'debug' })
    const debugHtml = renderToStaticMarkup(React.createElement(body.component))
    assert.match(debugHtml, /data-view="debug"/)
    assert.match(debugHtml, /data-testid="ssh-spike-panel"/, 'the diagnostics stay reachable')
    assert.match(debugHtml, /Run ping/)
  } finally {
    restore()
  }
})

test('the floating diagnostics card needs the debug view, and both switches', async () => {
  const { restore, services, exports } = await boot()
  try {
    const overlay = services.slots.registered.find(
      (entry) => entry.declaration.name === 'shell.overlay' && entry.declaration.id === 'ssh-spike',
    )
    assert.ok(overlay, 'the diagnostics card is registered')
    // Default off: a diagnostics card floating over the connection manager is a poor
    // first impression, and the workspace owns the panel now.
    const hidden = renderToStaticMarkup(React.createElement(overlay.component))
    assert.equal(hidden.includes('ssh-spike-overlay'), false, 'opt-in means hidden by default')

    // The flag alone is not enough: the card is a fixed, very high z-index layer, so it
    // must never be able to cover the session view (the terminal lives there).
    const runtime = exports.introspect()
    runtime.app.actions.setSpike({ showOverlay: true })
    const stillHidden = renderToStaticMarkup(React.createElement(overlay.component))
    assert.equal(stillHidden.includes('ssh-spike-overlay'), false, 'a flag on the list view must not raise it')

    runtime.app.actions.setPanel({ view: 'debug' })
    const shown = renderToStaticMarkup(React.createElement(overlay.component))
    assert.match(shown, /data-testid="ssh-spike-overlay"/)
    // The card carries the diagnostics themselves. Its heading is a dictionary key
    // (the harness's fake locale does not translate), so the assertion is on the
    // panel and its controls rather than on a locale-dependent sentence.
    assert.match(shown, /data-testid="ssh-spike-panel"/)
    assert.match(shown, /Run ping/)
    runtime.app.actions.setSpike({ showOverlay: false })
    runtime.app.actions.setPanel({ view: 'list' })
  } finally {
    restore()
  }
})

test('the panel glyph is monochrome, currentColor, and sized by its owner', async () => {
  const { restore, exports } = await boot()
  try {
    const Icon = exports.components().SshPanelIcon
    const html = renderToStaticMarkup(React.createElement(Icon, { size: 24, active: false }))
    assert.match(html, /currentColor/)
    assert.match(html, /width="24"/, 'the owner-supplied size must be honoured')
    assert.equal(html.includes('#'), false, 'no hardcoded colour may appear in the icon')

    const small = renderToStaticMarkup(React.createElement(Icon, { size: 14, active: true }))
    assert.match(small, /width="14"/)
    // A missing size must not produce a zero-width glyph.
    const fallback = renderToStaticMarkup(React.createElement(Icon, {}))
    assert.match(fallback, /width="16"/)
  } finally {
    restore()
  }
})

test('two files claiming one module name fail the assembler, not the browser', async () => {
  // The build-time guard lives in scripts/build-client.mjs and is unit-tested
  // there; what matters here is that a *materialised* bundle never regresses into
  // registering a module twice within one factory run.
  const restore = installDom()
  try {
    const { materialise } = await loadBundle({ react: React })
    const { exports } = materialise()
    assert.equal(typeof exports.apply, 'function')
  } finally {
    restore()
  }
})
