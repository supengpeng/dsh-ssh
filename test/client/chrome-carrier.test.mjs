/**
 * Carrier-resolution tests for the client bridge (ICD §1, §12; M0-SPIKE §5, §7).
 *
 * The live failure this covers: the panel opened, the host was healthy, and the client
 * had no working transport — because a carrier may be mounted **after** our `apply()`
 * runs, and because this build's gateway installs a namespace only from a contribution
 * (`@deepseek-ai/dsh-api-remotes/lib/client.js` mounts a fixed, build-time list). A
 * single probe at apply time is therefore a snapshot, not a verdict, and the failure it
 * recorded used to be shown in the panel as a developer note.
 *
 * These tests drive the assembled bundle with fake `remote` services that appear late,
 * mount late, or refuse our contribution, and assert the three behaviours the incident
 * needed: retry until the carrier exists, mount our own contribution when the assembly
 * does not, and report a *retryable* condition instead of a terminal error.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { test } from 'node:test'

import * as React from 'react'

import { BUNDLE_PATH, installDom } from './harness.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

const BOOT_TIMEOUT_MS = 4000
const POLL_MS = 20

async function loadBridge() {
  const restore = installDom()
  const source = readFileSync(BUNDLE_PATH, 'utf8')
  const anchor = 'exports.apply = plugin.apply'
  assert.ok(source.includes(anchor), 'bundle epilogue changed: the carrier test needs its registry hook')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-carrier-'))
  const copy = join(dir, 'client.mjs')
  writeFileSync(copy, source.replace(anchor, `${anchor}\n    exports.__ssh = SSH`), 'utf8')

  const rows = []
  globalThis.window.__ModuleLoader__ = { load: (row) => rows.push(row) }
  await import(`${pathToFileURL(copy).href}?v=${Date.now()}`)
  const exported = rows[0].factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected external require(${specifier})`)
  })
  return { restore, module: (name) => exported.__ssh.require(name), registry: exported.__ssh }
}

/** A `ctx` whose services can change over time, like a late-mounting composition. */
function liveContext(initial = {}) {
  const services = { ...initial }
  return {
    services,
    set(name, value) {
      services[name] = value
    },
    get(name) {
      return services[name]
    },
    on: () => () => {},
    provide: () => () => {},
    effect: (callback) => {
      const dispose = callback()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
  }
}

/** The namespace face a mounted contribution installs, answering the ICD ping. */
function sshFace(calls) {
  return {
    async ping(params) {
      calls.push({ method: 'ping', params })
      return { pong: true, echo: params && params.echo, version: '0.0.0-test', namespace: 'sshPlugin', node: 'test' }
    },
    async listProfiles() {
      calls.push({ method: 'listProfiles' })
      return { profiles: [] }
    },
  }
}

test('a carrier that only appears after apply() is found by retrying', async () => {
  const { restore, module } = await loadBridge()
  try {
    const calls = []
    const ctx = liveContext({})
    const bridge = module('ssh.bridge').createBridge(ctx)
    try {
      // Nothing is mounted at apply time — the exact live situation. An early failed
      // probe must not publish a terminal state: the panel shows "connecting" (and
      // offers a retry) instead of a dead transport.
      assert.equal(await bridge.resolve(), null)
      assert.equal(bridge.transportState().status, 'connecting')

      // A late-mounting composition: the service shows up 60ms later.
      const timer = setTimeout(() => {
        ctx.set('remote', { $mount: async () => () => {}, sshPlugin: sshFace(calls) })
      }, 60)

      const result = await bridge.call('ping', { echo: 'late' }, { resolveTimeoutMs: BOOT_TIMEOUT_MS, resolveIntervalMs: POLL_MS })
      clearTimeout(timer)
      assert.equal(result.pong, true, 'call() must retry resolution instead of trusting the first failure')
      assert.equal(result.echo, 'late')
      assert.equal(bridge.transportState().status, 'ready', 'a successful round trip recovers the published state')
      assert.equal(bridge.diagnostics().resolvedId, 'remote-mount')
    } finally {
      bridge.dispose()
    }
  } finally {
    restore()
  }
})

test('a namespace the assembly never mounted is installed from our own contribution', async () => {
  const { restore, module } = await loadBridge()
  try {
    const calls = []
    const mounts = []
    // The gateway's real shape: `$mount(contribution)` installs the namespace face; the
    // application's own (bare) `$mount()` call does not know about us.
    const remote = {
      async $mount(contribution) {
        mounts.push(contribution)
        if (contribution === undefined) return () => {}
        for (const descriptor of contribution.descriptors) {
          if (descriptor.namespace === 'sshPlugin' && descriptor.method === 'ping') {
            remote.sshPlugin = sshFace(calls)
          }
        }
        return () => {}
      },
    }
    const ctx = liveContext({ remote })
    const bridge = module('ssh.bridge').createBridge(ctx)
    try {
      const result = await bridge.call('ping', { echo: 'mounted' }, { resolveTimeoutMs: BOOT_TIMEOUT_MS, resolveIntervalMs: POLL_MS })
      assert.equal(result.pong, true)
      assert.equal(result.echo, 'mounted')

      // The contribution we hand the gateway must satisfy its validator: our wire
      // convention is one JSON-string argument (ICD §12 R1 form A), so the descriptor
      // declares one strict-codec parameter.
      const ours = mounts.find((entry) => entry !== undefined)
      assert.ok(ours, 'a contribution was offered to $mount()')
      assert.equal(ours.package, '@local/dsh-ssh')
      const ping = ours.descriptors.find((descriptor) => descriptor.method === 'ping')
      assert.equal(ping.namespace, 'sshPlugin')
      assert.deepEqual(ping.invocation, { kind: 'direct' })
      assert.equal(ping.parameters.length, 1)
      assert.equal(ping.parameters[0].codec.mode, 'strict', 'the gateway rejects a non-strict codec')
      // Unary and stream endpoints from ICD §4 are both declared.
      const methods = ours.descriptors.map((descriptor) => descriptor.method)
      for (const method of ['ping', 'listProfiles', 'connect', 'listDir', 'queryAudit']) {
        assert.ok(methods.includes(method), `${method} is missing from the contribution`)
      }
    } finally {
      bridge.dispose()
    }
  } finally {
    restore()
  }
})

test('a refused contribution is reported in the diagnostics, not swallowed', async () => {
  const { restore, module } = await loadBridge()
  try {
    const ctx = liveContext({
      remote: {
        async $mount(contribution) {
          if (contribution !== undefined) throw new Error('client api: generated Remote sshPlugin/ping has no strict codec')
        },
      },
    })
    const bridge = module('ssh.bridge').createBridge(ctx)
    try {
      await assert.rejects(
        () => bridge.call('ping', {}, { resolveTimeoutMs: BOOT_TIMEOUT_MS, resolveIntervalMs: POLL_MS }),
        (error) => {
          assert.equal(error.retryable, true, 'an unreachable transport is a retryable condition, not a terminal one')
          assert.equal(error.code, 'SSH_NET_UNREACHABLE', 'the UI renders a sentence from err.<CODE>')
          assert.equal(error.details.reason, 'transport-not-ready')
          return true
        },
      )
      const reason = bridge.diagnostics().attempts.map((entry) => entry.error && entry.error.message).filter(Boolean).join(' ')
      assert.match(reason, /no strict codec/, 'the gateway’s own wording is preserved for the report')
    } finally {
      bridge.dispose()
    }
  } finally {
    restore()
  }
})

test('a hopeless composition fails fast and stays retryable', async () => {
  const { restore, module } = await loadBridge()
  try {
    const ctx = liveContext({})
    const bridge = module('ssh.bridge').createBridge(ctx)
    try {
      const started = Date.now()
      await assert.rejects(
        () => bridge.call('ping', {}),
        (error) => {
          assert.equal(error.retryable, true)
          assert.equal(error.code, 'SSH_NET_UNREACHABLE')
          assert.ok(Array.isArray(error.details.attempts) && error.details.attempts.length >= 3)
          assert.equal(bridge.transportState().status, 'lost')
          return true
        },
      )
      // No carrier mechanism exists at all, so the panel must not freeze for the full
      // window; the recovery timer keeps looking in the background instead.
      assert.ok(Date.now() - started < 3000, 'a composition with no carrier must fail fast')

      // …and when the carrier finally arrives, a later call succeeds without a reload.
      ctx.set('remote', { $mount: async () => () => {}, sshPlugin: sshFace([]) })
      const result = await bridge.call('ping', { echo: 'recovered' }, { resolveTimeoutMs: 500, resolveIntervalMs: POLL_MS })
      assert.equal(result.pong, true)
      assert.equal(bridge.transportState().status, 'ready')
    } finally {
      bridge.dispose()
    }
  } finally {
    restore()
  }
})

test('the candidate inventory names the service each strategy needs', async () => {
  const { restore, module } = await loadBridge()
  try {
    const ctx = liveContext({ remote: { $mount: async () => () => {} } })
    const bridge = module('ssh.bridge').createBridge(ctx)
    try {
      const inventory = bridge.diagnostics().inventory
      const byId = new Map(inventory.map((row) => [row.id, row]))
      assert.equal(byId.get('remote-mount').service, 'remote')
      assert.equal(byId.get('remote-mount').servicePresent, true)
      assert.equal(byId.get('typert-remotes').servicePresent, false)
      assert.equal(byId.get('connection-rpc').service, 'connection')
      assert.match(byId.get('remote-mount').label, /contribution/)
    } finally {
      bridge.dispose()
    }
  } finally {
    restore()
  }
})

test('the descriptor table covers exactly the ICD §4 endpoints', async () => {
  // The contribution we mount is what makes our namespace callable, so a §4 endpoint
  // missing from this table is an endpoint the panel can never reach — which is how
  // `listLocalDir`/`statLocal` were silently unreachable until this test existed. The
  // expected set is parsed out of the contract, not restated here.
  const { restore, module } = await loadBridge()
  try {
    const bridge = module('ssh.bridge')
    const body = readFileSync(join(ROOT, 'docs', 'ICD.md'), 'utf8')
    const section = body.slice(body.indexOf('## 4.'), body.indexOf('## 5.'))
    const endpoints = new Set()
    for (const match of section.matchAll(/`sshPlugin\/([A-Za-z][A-Za-z0-9]*)`/g)) endpoints.add(match[1])
    const stream = new Set()
    for (const match of section.matchAll(/\|\s*`sshPlugin\/([A-Za-z][A-Za-z0-9]*)`\s*\|\s*S\s*\|/g)) stream.add(match[1])

    assert.ok(endpoints.size >= 30, `expected the §4 method table, parsed ${endpoints.size}`)
    const declared = [...bridge.UNARY_METHODS, ...bridge.STREAM_METHODS]
    assert.deepEqual(
      [...declared].sort(),
      [...endpoints].sort(),
      'the mounted descriptors must be exactly the §4 method table',
    )
    assert.deepEqual([...bridge.STREAM_METHODS].sort(), [...stream].sort(), 'stream endpoints keep their mode')
    assert.equal(new Set(declared).size, declared.length, 'no endpoint is declared twice')
  } finally {
    restore()
  }
})

test('no descriptor uses a name the namespace service reserves', async () => {
  // `client api: method "sshPlugin/remove" conflicts with its namespace service` cost us
  // the whole client→host channel: the Gateway installs each Remote method onto a
  // `RemoteNamespaceService`, which already owns `remove`. This is the guard.
  const { restore, module } = await loadBridge()
  try {
    const bridge = module('ssh.bridge')
    const reserved = new Set(bridge.RESERVED_METHOD_NAMES)
    // The rule is stated in the ICD too, so the next reader finds it where the table is.
    const icd = readFileSync(join(ROOT, 'docs', 'ICD.md'), 'utf8')
    assert.match(icd, /RESERVED_METHOD_NAMES/, 'the reserved-name rule is documented next to the method table')

    const offenders = [...bridge.UNARY_METHODS, ...bridge.STREAM_METHODS].filter((method) => reserved.has(method))
    assert.deepEqual(offenders, [], 'a reserved name would make $mount() refuse the whole contribution')
    // The name the live gateway refused must stay out of the table, while the ICD and
    // the client still describe the same operation.
    assert.equal(bridge.UNARY_METHODS.includes('remove'), false)
    assert.equal(bridge.UNARY_METHODS.includes('removePath'), true)
    assert.match(icd, /`sshPlugin\/removePath`/)
  } finally {
    restore()
  }
})

test('every endpoint sends exactly one wire field holding a JSON string', async () => {
  // ICD §12 R1 form A / R1.3 and `src/api/params.ts`: a rich payload must not cross the
  // carrier as an object — M0 §7.2 measured that it arrives lossy ("six-key object
  // arrived as two keys"), which the host then reports as a bare `SSH_CFG_INVALID`.
  const { restore, module } = await loadBridge()
  try {
    const bridge = module('ssh.bridge')
    const bodies = []
    /** Faithful to `assertExactArguments`: extra keys are refused, zero-arg methods take none. */
    const rpc = {
      async call(channel, endpoint, payload) {
        const method = endpoint.slice('sshPlugin/'.length)
        bodies.push({ endpoint, args: payload.args })
        const keys = Object.keys(payload.args ?? {})
        const expected = bridge.ZERO_ARG_METHODS.includes(method) ? [] : [bridge.WIRE_ARG_BY_METHOD[method] || 'raw']
        const extra = keys.filter((key) => !expected.includes(key))
        if (extra.length > 0) {
          return { ok: false, error: { code: 'gateway/arguments-invalid', message: `unexpected ${extra.join(',')}` } }
        }
        return { ok: true, value: { pong: true } }
      },
      open() {
        return { async *[Symbol.asyncIterator]() {} }
      },
    }
    const ctx = liveContext({ connection: { rpc } })
    const instance = bridge.createBridge(ctx)
    try {
      // Every §4 endpoint, with a nested payload — the exact shape that used to degrade.
      const nested = { sessionId: 's_1', path: '/tmp', profileJson: { host: 'h', port: 22 }, dryRun: true }
      for (const method of bridge.UNARY_METHODS) {
        bodies.length = 0
        await instance.call(method, nested, { resolveTimeoutMs: 800, resolveIntervalMs: POLL_MS })
        // The first call for a method may be the carrier probe; the last one is the call
        // this loop made.
        const call = bodies.filter((entry) => entry.endpoint === `sshPlugin/${method}`).at(-1)
        assert.ok(call, `${method} must reach the transport`)
        const keys = Object.keys(call.args)
        const zeroArg = bridge.ZERO_ARG_METHODS.includes(method)
        assert.deepEqual(keys, zeroArg ? [] : [bridge.WIRE_ARG_BY_METHOD[method] || 'raw'], `${method} body keys`)
        if (!zeroArg) {
          const value = Object.values(call.args)[0]
          assert.equal(typeof value, 'string', `${method} argument must be a JSON string, got ${typeof value}`)
          assert.deepEqual(JSON.parse(value), nested, `${method} payload must survive JSON encoding`)
        }
        if (method === 'ping') {
          // The carrier probe is the first thing that ever crosses the wire; it must obey
          // the same rule (a trace showing an object here means an old bundle is loaded).
          const probe = bodies.find((entry) => entry.endpoint === 'sshPlugin/ping')
          assert.equal(typeof Object.values(probe.args)[0], 'string', 'the ping probe also sends a JSON string')
        }
      }
    } finally {
      instance.dispose()
    }
  } finally {
    restore()
  }
})

test('a backend validation failure keeps the host detail in the message', async () => {
  const { restore, module } = await loadBridge()
  try {
    const rpc = {
      async call(channel, endpoint) {
        if (endpoint === 'sshPlugin/ping') return { ok: true, value: { pong: true } }
        return {
          ok: false,
          error: {
            code: 'SSH_CFG_INVALID',
            message: 'profileId or an inline profile is required',
            details: { field: 'profile' },
          },
        }
      },
      open() {
        return { async *[Symbol.asyncIterator]() {} }
      },
    }
    const ctx = liveContext({ connection: { rpc } })
    const bridge = module('ssh.bridge').createBridge(ctx)
    try {
      const failure = await bridge
        .call('testProfile', { profileJson: { host: 'h' } }, { resolveTimeoutMs: 800, resolveIntervalMs: POLL_MS })
        .then(() => null, (error) => error)
      assert.ok(failure, 'a refused call must reject')
      assert.equal(failure.code, 'SSH_CFG_INVALID')
      assert.equal(
        failure.message,
        'profileId or an inline profile is required',
        'the host sentence must survive normalisation — it is what names the failing field',
      )
      assert.deepEqual(failure.details, { field: 'profile' })

      // …and the connection UI renders the sentence plus the detail, not the bare code.
      const conn = module('ssh.conn.ui')
      const text = conn.errorText(failure)
      assert.match(text, /profileId or an inline profile is required/, `errorText dropped the detail: ${text}`)
      assert.match(text, /：/, 'the dictionary sentence keeps the detail appended after it')
    } finally {
      bridge.dispose()
    }
  } finally {
    restore()
  }
})

test('the diagnostic log never carries a credential', async () => {
  // Regression gate for a real leak: the first version of the `rpc send` line redacted by
  // key name only, and `setSecret` carries its secret under a *generic* key named by a
  // sibling — `{ profileId, field: 'password', value: '<secret>' }` — so the password was
  // printed in clear. Screenshots and pasted logs would have exposed it.
  const { restore, module } = await loadBridge()
  const lines = []
  const capture = (original) => (...args) => {
    lines.push(args.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' '))
    return original(...args)
  }
  const realInfo = console.info
  const realWarn = console.warn
  console.info = capture(() => {})
  console.warn = capture(() => {})
  try {
    const rpc = {
      async call(channel, endpoint) {
        if (endpoint === 'sshPlugin/ping') return { ok: true, value: { pong: true } }
        return { ok: true, value: { ok: true } }
      },
      open() {
        return { async *[Symbol.asyncIterator]() {} }
      },
    }
    const ctx = liveContext({ connection: { rpc } })
    const bridge = module('ssh.bridge').createBridge(ctx)
    const PASSWORD = 'example-not-a-real-secret'
    const PASSPHRASE = 'correct-horse-battery'
    try {
      await bridge.call(
        'setSecret',
        { profileId: 'p_01M3F91', field: 'password', value: PASSWORD, persist: true },
        { resolveTimeoutMs: 800, resolveIntervalMs: POLL_MS },
      )
      await bridge.call(
        'connect',
        { profileId: 'p_01M3F91', secrets: { password: PASSWORD, passphrase: PASSPHRASE } },
        { resolveTimeoutMs: 800, resolveIntervalMs: POLL_MS },
      )
      // A credential literal reaching the log through an entirely different field.
      await bridge.call('saveProfile', { profile: { host: 'h', note: PASSWORD } }, { resolveTimeoutMs: 800, resolveIntervalMs: POLL_MS })
    } finally {
      bridge.dispose()
    }

    assert.ok(lines.length > 0, 'the log lines this test guards must actually be emitted')
    const text = lines.join('\n')
    assert.equal(text.includes(PASSWORD), false, `the password leaked into the log:\n${text}`)
    assert.equal(text.includes(PASSPHRASE), false, `the passphrase leaked into the log:\n${text}`)
    assert.ok(text.includes('«redacted»'), 'credentials are replaced, not dropped silently')
    assert.ok(text.includes('sshPlugin/setSecret'), 'the endpoint is still named, so the line stays useful')
    // The value-level registry is what covers "the secret reached the log by another
    // route", so it must have been populated.
    assert.ok(module('ssh.bridge').loggedSecretValues.has(PASSWORD), 'the secret must be registered for later scrubbing')
  } finally {
    console.info = realInfo
    console.warn = realWarn
    restore()
  }
})

test('the redactor handles every shape a credential can arrive in', async () => {
  const { restore, module } = await loadBridge()
  try {
    const { redactForLog } = module('ssh.bridge')
    const SECRET = 'sup3r-s3cret-value'

    // 1. A nested structure inside the wire JSON string (the shape that leaked).
    const setSecret = redactForLog({ args: { raw: JSON.stringify({ profileId: 'p1', field: 'password', value: SECRET }) } })
    assert.equal(setSecret.includes(SECRET), false, setSecret)
    assert.match(setSecret, /«redacted»/)
    assert.match(setSecret, /p1/, 'non-secret fields survive so the line stays diagnostic')

    // 2. Credentials by key name, at any depth.
    for (const payload of [
      { password: SECRET },
      { passphrase: SECRET },
      { privateKey: SECRET },
      { secrets: { token: SECRET } },
      { nested: { deeper: { api_key: SECRET } } },
      [{ credentials: { password: SECRET } }],
    ]) {
      const text = redactForLog(payload)
      assert.equal(text.includes(SECRET), false, `${JSON.stringify(payload)} leaked: ${text}`)
    }

    // 3. JSON text nested inside a JSON string, twice over.
    const twice = redactForLog({ raw: JSON.stringify({ inline: JSON.stringify({ password: SECRET }) }) })
    assert.equal(twice.includes(SECRET), false, twice)

    // 4. A registered literal is scrubbed even where no key names it.
    assert.equal(redactForLog({ note: `the password is ${SECRET}` }).includes(SECRET), false)
  } finally {
    restore()
  }
})

test('a credential can neither be logged nor rendered in the UI', async () => {
  // Both exits are covered: the log line (bridge) and the error text the user reads
  // (connection panel). A host sentence echoing a submitted value must not reach either.
  const { restore, module } = await loadBridge()
  const lines = []
  const realInfo = console.info
  console.info = (...args) => {
    lines.push(args.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' '))
  }
  try {
    const SECRET = 'Zq7-plaintext-secret'
    const rpc = {
      async call(channel, endpoint) {
        if (endpoint === 'sshPlugin/ping') return { ok: true, value: { pong: true } }
        // A host that echoes the submitted secret back in its failure message.
        return { ok: false, error: { code: 'SSH_AUTH_FAILED', message: `authentication failed for ${SECRET}` } }
      },
      open() {
        return { async *[Symbol.asyncIterator]() {} }
      },
    }
    const ctx = liveContext({ connection: { rpc } })
    const bridge = module('ssh.bridge').createBridge(ctx)
    let failure = null
    try {
      await bridge.call('setSecret', { field: 'password', value: SECRET }, { resolveTimeoutMs: 800, resolveIntervalMs: POLL_MS })
    } catch (error) {
      failure = error
    } finally {
      bridge.dispose()
    }

    assert.equal(lines.join('\n').includes(SECRET), false, 'the log leaked the secret')
    assert.ok(failure, 'the refused call must reject so the UI has something to render')

    const conn = module('ssh.conn.ui')
    const rendered = conn.errorText(failure)
    assert.equal(rendered.includes(SECRET), false, `the UI rendered the secret: ${rendered}`)
    assert.match(rendered, /authentication failed/, 'the readable part of the host sentence survives')
  } finally {
    console.info = realInfo
    restore()
  }
})

test('streams open through the gateway mux and deliver frames in order', async () => {
  // `@deepseek-ai/dsh-api-gateway/lib/client.js:1654-1655` tries
  // `connection.rpc.open?('/api', …)` and otherwise falls back to
  // `remote.streams.open(endpoint, payload, signal, uplink)` — the Gateway's own
  // `RemoteStreamMuxClient` (`:325`), which it starts when `rpc.open` is undefined
  // (`:1600`). A plain web composition has no `rpc.open`, so the mux is the real path.
  const { restore, module } = await loadBridge()
  try {
    const seen = []
    const mux = {
      async *open(endpoint, payload, signal, uplink) {
        seen.push({ endpoint, payload, signal, uplink })
        yield { t: 'open', streamId: 'st_mux_1', kind: 'shell', meta: { cols: 80 } }
        yield { t: 'data', streamId: 'st_mux_1', seq: 0, chunk: '$ ', encoding: 'utf8', channel: 'term' }
        yield { t: 'data', streamId: 'st_mux_1', seq: 1, chunk: 'ls\r\n', encoding: 'utf8', channel: 'term' }
        yield { t: 'exit', streamId: 'st_mux_1', exitCode: 0, durationMs: 5, timedOut: false }
        yield { t: 'end', streamId: 'st_mux_1', reason: 'completed' }
      },
    }
    const rpc = {
      async call(channel, endpoint) {
        if (endpoint === 'sshPlugin/ping') return { ok: true, value: { pong: true } }
        return { ok: true, value: { ok: true } }
      },
      // Deliberately no `open`: this is the build the user is running.
    }
    const ctx = liveContext({ connection: { rpc }, remote: { streams: mux } })
    const bridge = module('ssh.bridge').createBridge(ctx)
    try {
      const frames = []
      const handle = bridge.stream('openShell', { sessionId: 's_1', cols: 80, rows: 24 }, (frame) => frames.push(frame), {
        resolveTimeoutMs: 800,
        resolveIntervalMs: POLL_MS,
      })
      const state = await handle.done
      assert.equal(state.ended, true)
      assert.equal(state.streamId, 'st_mux_1')
      assert.deepEqual(frames.map((frame) => frame.t), ['open', 'data', 'data', 'exit', 'end'])
      assert.equal(state.frames, 2, 'both data frames counted')
      assert.equal(seen.length, 1)
      assert.equal(seen[0].endpoint, 'sshPlugin/openShell')
      // The single-JSON-string rule applies to streams as well.
      assert.equal(typeof seen[0].payload.args.raw, 'string')
      assert.deepEqual(JSON.parse(seen[0].payload.args.raw), { sessionId: 's_1', cols: 80, rows: 24 })
    } finally {
      bridge.dispose()
    }
  } finally {
    restore()
  }
})

test('cancelling a stream releases the mux generator and stops frames', async () => {
  const { restore, module } = await loadBridge()
  try {
    let released = false
    let produced = 0
    const mux = {
      async *open() {
        try {
          yield { t: 'open', streamId: 'st_cancel', kind: 'shell', meta: {} }
          for (let index = 0; index < 50; index += 1) {
            // A real mux yields between frames (they arrive from a socket); without this
            // the generator would drain before `cancel()` could be observed.
            await new Promise((done) => setTimeout(done, 1))
            produced += 1
            yield { t: 'data', streamId: 'st_cancel', seq: index, chunk: 'x', encoding: 'utf8', channel: 'term' }
          }
        } finally {
          // An abandoned generator must run its cleanup — that is what closes the
          // multiplexed WebSocket subscription in the real client.
          released = true
        }
      },
    }
    const rpc = {
      async call(channel, endpoint) {
        if (endpoint === 'sshPlugin/ping') return { ok: true, value: { pong: true } }
        return { ok: true, value: {} }
      },
    }
    const ctx = liveContext({ connection: { rpc }, remote: { streams: mux } })
    const bridge = module('ssh.bridge').createBridge(ctx)
    try {
      const frames = []
      const handle = bridge.stream('exec', { sessionId: 's_1' }, (frame) => frames.push(frame), {
        resolveTimeoutMs: 800,
        resolveIntervalMs: POLL_MS,
      })
      await new Promise((done) => setTimeout(done, 20))
      handle.cancel()
      const state = await handle.done
      assert.equal(released, true, 'the generator must be finalised so the mux releases the stream')
      assert.ok(state.frames < 50, `frame pump stopped early (saw ${String(state.frames)})`)
      assert.ok(produced < 50, 'the producer stopped too')
    } finally {
      bridge.dispose()
    }
  } finally {
    restore()
  }
})

test('a stream that fails mid-flight ends with the normalised error', async () => {
  const { restore, module } = await loadBridge()
  try {
    const mux = {
      async *open() {
        yield { t: 'open', streamId: 'st_boom', kind: 'shell', meta: {} }
        yield { t: 'data', streamId: 'st_boom', seq: 0, chunk: 'partial', encoding: 'utf8', channel: 'term' }
        throw { code: 'SSH_NET_RESET', message: 'link dropped', retryable: true }
      },
    }
    const rpc = {
      async call(channel, endpoint) {
        if (endpoint === 'sshPlugin/ping') return { ok: true, value: { pong: true } }
        return { ok: true, value: {} }
      },
    }
    const ctx = liveContext({ connection: { rpc }, remote: { streams: mux } })
    const bridge = module('ssh.bridge').createBridge(ctx)
    try {
      const frames = []
      const handle = bridge.stream('openShell', { sessionId: 's_1' }, (frame) => frames.push(frame), {
        resolveTimeoutMs: 800,
        resolveIntervalMs: POLL_MS,
      })
      const state = await handle.done
      const end = frames.at(-1)
      assert.equal(end.t, 'end')
      assert.equal(end.reason, 'error')
      assert.equal(state.error.code, 'SSH_NET_RESET')
      assert.equal(state.error.retryable, true, 'retryability survives so the UI can offer a retry')
      assert.equal(frames[0].t, 'open', 'the frames delivered before the failure are kept')
    } finally {
      bridge.dispose()
    }
  } finally {
    restore()
  }
})

test('a build with no stream entry fails with an actionable, non-unknown code', async () => {
  // The reported symptom was `SSH_UNKNOWN: connection.rpc exposes no stream opener`,
  // which tells the user nothing. It is a capability gap on a retryable link, so it
  // reports as ICD §5's `SSH_NET_UNREACHABLE` with the affected views named.
  const { restore, module } = await loadBridge()
  try {
    const rpc = {
      async call(channel, endpoint) {
        if (endpoint === 'sshPlugin/ping') return { ok: true, value: { pong: true } }
        return { ok: true, value: {} }
      },
    }
    const ctx = liveContext({ connection: { rpc } })
    const bridge = module('ssh.bridge').createBridge(ctx)
    try {
      const frames = []
      const handle = bridge.stream('openShell', { sessionId: 's_1' }, (frame) => frames.push(frame), {
        resolveTimeoutMs: 800,
        resolveIntervalMs: POLL_MS,
      })
      const state = await handle.done
      assert.equal(state.error.code, 'SSH_NET_UNREACHABLE', 'not SSH_UNKNOWN: the code names the link')
      assert.equal(state.error.retryable, true)
      assert.equal(state.error.details.reason, 'no-stream-carrier')
      assert.match(state.error.message, /no stream carrier/)
      assert.match(state.error.message, /terminal/, 'the message names what stops working')
      assert.match(state.error.message, /Unary calls .* keep working/, 'and what still works')
      assert.equal(frames.at(-1).t, 'end')
      assert.equal(frames.at(-1).error.code, 'SSH_NET_UNREACHABLE')
    } finally {
      bridge.dispose()
    }
  } finally {
    restore()
  }
})

test('connection.rpc.open wins over the mux when the transport provides one', async () => {
  const { restore, module } = await loadBridge()
  try {
    const used = []
    const rpc = {
      async call(channel, endpoint) {
        if (endpoint === 'sshPlugin/ping') return { ok: true, value: { pong: true } }
        return { ok: true, value: {} }
      },
      open(channel, endpoint, payload) {
        used.push('rpc.open')
        assert.equal(channel, '/api')
        assert.equal(typeof payload.args.raw, 'string')
        return (async function *frames() {
          yield { t: 'open', streamId: 'st_rpc', kind: 'shell', meta: {} }
          yield { t: 'end', streamId: 'st_rpc', reason: 'completed' }
        })()
      },
    }
    const mux = {
      async *open() {
        used.push('remote.streams')
        yield { t: 'end', streamId: 'st_mux', reason: 'completed' }
      },
    }
    const ctx = liveContext({ connection: { rpc }, remote: { streams: mux } })
    const bridge = module('ssh.bridge').createBridge(ctx)
    try {
      const handle = bridge.stream('openShell', { sessionId: 's_1' }, () => {}, { resolveTimeoutMs: 800, resolveIntervalMs: POLL_MS })
      const state = await handle.done
      assert.equal(state.streamId, 'st_rpc')
      assert.deepEqual(used, ['rpc.open'], 'the in-process opener is preferred, as the Gateway does')
    } finally {
      bridge.dispose()
    }
  } finally {
    restore()
  }
})

test('every stream open passes a live AbortSignal in the mux position', async () => {
  // The reported failure was `Cannot read properties of undefined (reading
  // 'throwIfAborted')`: the mux's own first statement is `signal.throwIfAborted()`
  // (`dsh-api-gateway/lib/client.js:375`), and the bridge passed `undefined`. This fake
  // reproduces those first statements exactly, so a missing signal fails here instead of
  // in the user's console.
  const { restore, module } = await loadBridge()
  try {
    const observed = []
    const mux = {
      async *open(endpoint, payload, signal, uplink) {
        signal.throwIfAborted() // the real mux's first line
        assert.ok(signal instanceof AbortSignal, 'a real AbortSignal is required')
        assert.equal(signal.aborted, false, 'the signal must be live when the stream opens')
        signal.addEventListener('abort', () => {}, { once: true })
        observed.push({ endpoint, abortedDuringStream: () => signal.aborted, uplink })
        yield { t: 'open', streamId: 'st_sig', kind: 'shell', meta: {} }
        yield { t: 'data', streamId: 'st_sig', seq: 0, chunk: 'ok', encoding: 'utf8', channel: 'term' }
        yield { t: 'end', streamId: 'st_sig', reason: 'completed' }
      },
    }
    const rpc = {
      async call(channel, endpoint) {
        if (endpoint === 'sshPlugin/ping') return { ok: true, value: { pong: true } }
        return { ok: true, value: {} }
      },
    }
    const ctx = liveContext({ connection: { rpc }, remote: { streams: mux } })
    const bridge = module('ssh.bridge').createBridge(ctx)
    try {
      const handle = bridge.stream('openShell', { sessionId: 's_1' }, () => {}, { resolveTimeoutMs: 800, resolveIntervalMs: POLL_MS })
      const state = await handle.done
      assert.equal(state.error, null, `no failure expected, got ${state.error && state.error.message}`)
      assert.equal(state.ended, true)
      assert.equal(observed.length, 1)
      assert.equal(observed[0].uplink, undefined, 'the uplink stays optional; only the signal is mandatory')
      assert.equal(observed[0].abortedDuringStream(), true, 'the wrapper aborts once the stream is finished')
    } finally {
      bridge.dispose()
    }
  } finally {
    restore()
  }
})

test('cancel() aborts the mux signal and runs the generator cleanup', async () => {
  const { restore, module } = await loadBridge()
  try {
    let signalSeen = null
    let released = false
    const mux = {
      async *open(endpoint, payload, signal) {
        signalSeen = signal
        try {
          yield { t: 'open', streamId: 'st_abort', kind: 'shell', meta: {} }
          for (let index = 0; index < 50; index += 1) {
            await new Promise((done) => setTimeout(done, 1))
            yield { t: 'data', streamId: 'st_abort', seq: index, chunk: 'x', encoding: 'utf8', channel: 'term' }
          }
        } finally {
          released = true
        }
      },
    }
    const rpc = {
      async call(channel, endpoint) {
        if (endpoint === 'sshPlugin/ping') return { ok: true, value: { pong: true } }
        return { ok: true, value: {} }
      },
    }
    const ctx = liveContext({ connection: { rpc }, remote: { streams: mux } })
    const bridge = module('ssh.bridge').createBridge(ctx)
    try {
      const handle = bridge.stream('openShell', { sessionId: 's_1' }, () => {}, { resolveTimeoutMs: 800, resolveIntervalMs: POLL_MS })
      await new Promise((done) => setTimeout(done, 20))
      assert.equal(signalSeen.aborted, false, 'live while streaming')
      handle.cancel()
      await handle.done
      assert.equal(released, true, 'the mux generator was finalised')
      assert.equal(signalSeen.aborted, true, 'cancel() aborts the signal the mux holds')
    } finally {
      bridge.dispose()
    }
  } finally {
    restore()
  }
})

test('an unreadable mux failure becomes a readable, coded error', async () => {
  const { restore, module } = await loadBridge()
  try {
    const facts = module('ssh.bridge').streamTransportFacts()
    assert.ok('streamBaseUrl' in facts && 'baseURI' in facts && 'muxUrl' in facts, 'the facts are always shaped')

    const mux = {
      async *open() {
        // What an unreachable WebSocket looks like, and what a missing signal looked like.
        throw new Error("Cannot read properties of undefined (reading 'throwIfAborted')")
      },
    }
    const rpc = {
      async call(channel, endpoint) {
        if (endpoint === 'sshPlugin/ping') return { ok: true, value: { pong: true } }
        return { ok: true, value: {} }
      },
    }
    const ctx = liveContext({ connection: { rpc }, remote: { streams: mux } })
    const bridge = module('ssh.bridge').createBridge(ctx)
    try {
      const frames = []
      const handle = bridge.stream('openShell', { sessionId: 's_1' }, (frame) => frames.push(frame), {
        resolveTimeoutMs: 800,
        resolveIntervalMs: POLL_MS,
      })
      const state = await handle.done
      const error = state.error
      assert.ok(error instanceof Error, 'a real Error prints inline; a bare object renders as `Object`')
      assert.match(error.message, /throwIfAborted/)
      assert.equal(error.code, 'SSH_NET_UNREACHABLE')
      assert.equal(error.retryable, true)
      assert.equal(error.details.streamCarrier, 'remote.streams')
      assert.ok('muxUrl' in error.details, 'the mux target is reported')
      assert.match(error.details.hint, /AbortSignal/, 'this exact shape is called out as a bridge bug')
      assert.equal(frames.at(-1).error.code, 'SSH_NET_UNREACHABLE')
    } finally {
      bridge.dispose()
    }
  } finally {
    restore()
  }
})

test('a strict codec carries the create() factory the registry validates', async () => {
  // `dsh-typert-registry/lib/client.js:1354-1358` rejects a strict codec without
  // `create()`: "… strict codec has no create() factory". Supplying it completes the
  // descriptor shape our self-mounted contribution needs.
  const { restore, module } = await loadBridge()
  try {
    const bridge = module('ssh.bridge')
    const descriptor = bridge.descriptorFor('ping')
    for (const codec of [descriptor.result, descriptor.parameters[0].codec]) {
      assert.equal(codec.mode, 'strict')
      assert.ok(typeof codec.typeSymbol === 'string' && codec.typeSymbol.length > 0, 'typeSymbol must be nonempty')
      assert.equal(typeof codec.create, 'function', 'the registry requires a create() factory')
      assert.equal(typeof codec.create().parse, 'function', 'decoding calls create().parse(value)')
      assert.equal(codec.create().parse('x'), 'x', 'the pass-through codec is usable')
    }
    assert.deepEqual(bridge.missingContributionFields({ package: '@local/dsh-ssh', descriptors: [descriptor] }), [])
  } finally {
    restore()
  }
})

test('the wire-field table matches the host signatures it describes', async () => {
  // The host builds each Remote parameter from the *source parameter name*
  // (`srcDescriptor()`), so the field a call must use is readable from src/service.ts.
  // Deriving it here keeps the client's table honest instead of aspirational.
  const { restore, module } = await loadBridge()
  try {
    const bridge = module('ssh.bridge')
    const source = readFileSync(join(ROOT, 'src', 'service.ts'), 'utf8')
    const derived = new Map()
    for (const match of source.matchAll(/^\s+(?:async\s+)?\*?(\w+)\(([^)]*)\)\s*:/gm)) {
      const [, method, rawParameters] = match
      if (!bridge.UNARY_METHODS.includes(method) && !bridge.STREAM_METHODS.includes(method)) continue
      const first = rawParameters.split(',')[0].trim()
      derived.set(method, first === '' ? null : first.split(/[?:]/)[0].trim())
    }
    assert.ok(derived.size >= 30, `expected the host signatures, parsed ${derived.size}`)

    for (const [method, parameter] of derived) {
      const declared = bridge.WIRE_ARG_BY_METHOD[method]
      if (parameter === null) {
        assert.equal(declared, undefined, `${method}() takes no argument, so args must be {}`)
        assert.equal(bridge.ZERO_ARG_METHODS.includes(method), true, `${method}() must be listed as zero-argument`)
      } else {
        assert.equal(declared ?? 'raw', parameter, `${method}(${parameter}) must use the "${parameter}" wire field`)
      }
    }
  } finally {
    restore()
  }
})

test('the /api RPC carrier speaks the platform signature and probes the wire field', async () => {
  // `@deepseek-ai/dsh-api-gateway/lib/client.js` calls
  //     connection.rpc.call('/api', '<ns>/<method>', { args }, signal)
  // and the host derives the wire field from the method's source parameter name, so
  // `ping` wants `params` while `listDir` wants `raw` and `listSessions` wants `{}`.
  // A wrong guess is answered with `gateway/arguments-invalid`, which is what makes the
  // probe safe. This fake reproduces both rules.
  const { restore, module } = await loadBridge()
  try {
    // `listDir` deliberately wants a field the client would not try first (`payload`),
    // so this fixture exercises the probe loop as well as the mapped fast path.
    const expectedWire = { ping: 'params', reportSpike: 'payload', listSessions: null, listDir: 'payload' }
    const seen = []
    const rpc = {
      async call(channel, endpoint, payload, signal) {
        seen.push({ channel, endpoint, payload, signal })
        assert.equal(channel, '/api', 'the transport channel is the authenticated fence')
        const method = endpoint.slice('sshPlugin/'.length)
        // `null` means "this method declares no parameter at all"; `??` cannot express
        // that (null is nullish), so the fixture is read with an explicit lookup.
        const wire = Object.prototype.hasOwnProperty.call(expectedWire, method) ? expectedWire[method] : 'raw'
        const args = payload && payload.args
        const keys = Object.keys(args ?? {})
        if (wire === null) {
          // A zero-argument endpoint declares no wire field, so ANY key is "unexpected"
          // (`assertExactArguments`). The client must fall back to `{}`.
          if (keys.length > 0) return { ok: false, error: { code: 'gateway/arguments-invalid', message: 'unexpected ' + keys.join(',') } }
        } else if (!Object.prototype.hasOwnProperty.call(args ?? {}, wire)) {
          return { ok: false, error: { code: 'gateway/arguments-invalid', message: 'args fields do not match the descriptor' } }
        }
        // The host parses the single JSON-string argument (`decodePayload`), so the fake
        // does the same: that is the contract the client must satisfy.
        const value = wire === null ? null : JSON.parse(args[wire])
        return { ok: true, value: { pong: true, echo: value, method } }
      },
      open() {
        return { async *[Symbol.asyncIterator]() {} }
      },
    }
    const ctx = liveContext({ connection: { rpc } })
    const bridge = module('ssh.bridge').createBridge(ctx)
    try {
      // ping: the table knows the host field, so no probe round-trip is needed at all.
      const ping = await bridge.call('ping', { echo: 'probe' }, { resolveTimeoutMs: 500, resolveIntervalMs: POLL_MS })
      assert.equal(ping.pong, true)
      assert.equal(ping.echo.echo, 'probe', 'the envelope value is unwrapped')
      const pingCalls = seen.filter((entry) => entry.endpoint === 'sshPlugin/ping')
      assert.ok(
        pingCalls.every((entry) => Object.keys(entry.payload.args).join() === 'params'),
        `every ping must use the mapped "params" field, saw ${pingCalls.map((entry) => Object.keys(entry.payload.args).join()).join(' | ')}`,
      )
      assert.deepEqual(pingCalls.at(-1).payload.args, { params: JSON.stringify({ echo: 'probe' }) })

      // A zero-argument endpoint sends `{}` on the first try.
      const sessions = await bridge.call('listSessions', undefined, { resolveTimeoutMs: 500, resolveIntervalMs: POLL_MS })
      assert.equal(sessions.method, 'listSessions')

      // …and a method whose real field is not the default still finds it by probing.
      const dir = await bridge.call('listDir', { path: '/' }, { resolveTimeoutMs: 500, resolveIntervalMs: POLL_MS })
      assert.deepEqual(dir.echo, { path: '/' })
      const dirCalls = seen.filter((entry) => entry.endpoint === 'sshPlugin/listDir')
      assert.deepEqual(Object.keys(dirCalls[0].payload.args), ['raw'], 'the default field is tried first')
      assert.deepEqual(dirCalls.at(-1).payload.args, { payload: JSON.stringify({ path: '/' }) }, 'the probe settles on the accepted field')
      assert.ok(seen.every((entry) => entry.endpoint.startsWith('sshPlugin/')), 'endpoints stay namespaced')
    } finally {
      bridge.dispose()
    }
  } finally {
    restore()
  }
})

test('a failed remote result is thrown with its code, not returned as a success', async () => {
  const { restore, module } = await loadBridge()
  try {
    // The probe must succeed (the carrier is usable) and only the business call fail,
    // otherwise this would test the transport's absence instead of the error mapping.
    const rpc = {
      async call(channel, endpoint) {
        if (endpoint === 'sshPlugin/ping') return { ok: true, value: { pong: true } }
        return { ok: false, error: { code: 'SSH_SFTP_NO_SUCH_FILE', message: '/nope does not exist', details: { path: '/nope' } } }
      },
      open() {
        return { async *[Symbol.asyncIterator]() {} }
      },
    }
    const ctx = liveContext({ connection: { rpc } })
    const bridge = module('ssh.bridge').createBridge(ctx)
    try {
      await assert.rejects(
        () => bridge.call('stat', { path: '/nope' }, { resolveTimeoutMs: 500, resolveIntervalMs: POLL_MS }),
        (error) => {
          assert.equal(error.code, 'SSH_SFTP_NO_SUCH_FILE')
          assert.match(error.message, /does not exist/)
          assert.deepEqual(error.details, { path: '/nope' }, 'details survive for the UI')
          return true
        },
      )
    } finally {
      bridge.dispose()
    }
  } finally {
    restore()
  }
})

test('the contribution shape check names every missing field', async () => {
  // The live failure surfaced as `Cannot read properties of undefined (reading 'length')`
  // from the typert registry validator. The check turns that into field names.
  const { restore, module } = await loadBridge()
  try {
    const bridge = module('ssh.bridge')

    const good = {
      package: '@local/dsh-ssh',
      descriptors: [bridge.descriptorFor('ping')],
    }
    assert.deepEqual(bridge.missingContributionFields(good), [])

    const empty = bridge.missingContributionFields({ package: '@local/dsh-ssh' })
    assert.deepEqual(empty, ['descriptors[]'])

    const bare = bridge.missingContributionFields({
      package: '@local/dsh-ssh',
      descriptors: [{ namespace: 'sshPlugin', method: 'ping', invocation: { kind: 'direct' }, parameters: [] }],
    })
    for (const field of ['descriptors[0].id', 'descriptors[0].service', 'descriptors[0].result (codec)']) {
      assert.ok(bare.includes(field), `${field} must be reported; saw ${bare.join(', ')}`)
    }

    const weakCodec = bridge.missingContributionFields({
      package: '@local/dsh-ssh',
      descriptors: [{
        id: 'x', service: 'sshPlugin', namespace: 'sshPlugin', method: 'ping',
        invocation: { kind: 'direct' }, result: { mode: 'strict' },
        parameters: [{ wire: 'raw', codec: { mode: 'src-json' } }],
      }],
    })
    assert.deepEqual(weakCodec, ["descriptors[0].parameters[0].codec{mode:'strict'}"])

    // Our real descriptors pass the check, and carry the strict codec the Gateway demands.
    const descriptor = bridge.descriptorFor('ping')
    assert.equal(descriptor.id, '@local/dsh-ssh#sshPlugin.ping')
    assert.equal(descriptor.service, 'sshPlugin')
    assert.equal(descriptor.result.mode, 'strict')
    assert.equal(descriptor.parameters[0].codec.mode, 'strict')
    assert.equal(typeof descriptor.parameters[0].codec.schema.parse, 'function')
    assert.equal(descriptor.parameters[0].codec.schema.parse('x'), 'x', 'the pass-through codec is usable')
  } finally {
    restore()
  }
})
