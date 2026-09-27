/**
 * `ssh_exec` conversation card (`client/src/session/toolview.js`).
 *
 * The property under test is the one the card exists for: an `ssh_exec` tool call in
 * the conversation renders as a terminal row — `$ <command>`, the captured output,
 * an exit/status pill — instead of the generic "Tool call · ssh_exec · <first arg>"
 * row with an Input/Output dump.
 *
 * **The occupant comes from the built bundle.** `loadBundle` materialises
 * `lib/client.js` the way the browser module loader does, `apply()` runs against a
 * fake client context, and the component is taken from the keyed registration the
 * bundle actually made. Nothing here reconstructs the registration under test.
 *
 * **Rendering is static markup.** linkedom has no layout engine, so every assertion
 * is on text, structure and `data-*` hooks — never on measured boxes.
 *
 * **Language is the shipped dictionary.** After `apply()`, `ssh.chrome` has published
 * `SSH.i18n` (compiled from `locale/{zh,en}.json`), so the copy in this markup is the
 * real English string; a key that existed only in this test would render as its own
 * name here.
 *
 * **The Host seam.** The card parses the Host's projection — `src/tools/exec.ts`
 * `envelopePresentation()` returns one `output` string whose stderr section is marked
 * `[stderr]`. `projection()` below reproduces that string literally rather than
 * importing the Host build (`lib/`, which another workstream owns), and the last test
 * pins the seam by reading the Host source.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { parseHTML } from 'linkedom'

import {
  BUNDLE_PATH,
  fakeContext,
  fakeLocale,
  fakeRemoteCarrier,
  fakeSlots,
  fakeTabRegistry,
  installDom,
  loadBundle,
} from './harness.mjs'

// The DOM must exist *before* react-dom is evaluated (the reason is documented in
// activity.test.mjs): without a document React installs legacy input polyfills whose
// handlers dereference a null instance under linkedom.
const restoreDom = installDom()
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.window.IS_REACT_ACT_ENVIRONMENT = true
// Pin the language: the labels below come from the compiled dictionary.
globalThis.document.documentElement.setAttribute('lang', 'en')

const React = await import('react')
const { renderToStaticMarkup } = await import('react-dom/server')

process.on('exit', () => {
  try {
    restoreDom()
  } catch {
    /* nothing left to restore */
  }
})

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const MODULE_PATH = join(ROOT, 'client', 'src', 'session', 'toolview.js')

// ── the built bundle, once ───────────────────────────────────────────────────

let booted = null

/** Materialise the built bundle, apply it, and keep the slots face it registered on. */
async function boot() {
  if (booted !== null) return booted
  const { rows, materialise } = await loadBundle({ react: React })
  assert.equal(rows.length, 1, 'the bundle registers one package row')
  assert.equal(rows[0].id, '@local/dsh-ssh')
  const { exports } = materialise()
  const slots = fakeSlots()
  const ctx = fakeContext({
    locale: fakeLocale(),
    slots,
    sidebarRightTabs: fakeTabRegistry(),
    remote: fakeRemoteCarrier(),
  })
  assert.doesNotThrow(() => exports.apply(ctx), 'the plugin body applies against a fake client context')
  booted = { exports, slots, ctx }
  return booted
}

/** The keyed `ssh_exec` occupant, or a failure that names what was registered instead. */
async function occupant() {
  const { slots } = await boot()
  const entry = slots.registered.find(
    (row) => row.declaration?.name === 'tool.call.toolview' && row.declaration?.key === 'ssh_exec',
  )
  assert.ok(
    entry,
    `no tool.call.toolview entry for "ssh_exec"; registered: ${slots.registered
      .map((row) => `${row.declaration?.name}:${row.declaration?.key ?? row.declaration?.id ?? ''}`)
      .join(', ')}`,
  )
  assert.equal(typeof entry.component, 'function', 'a keyed entry carries a component')
  return entry
}

// ── fixtures ─────────────────────────────────────────────────────────────────

/**
 * `envelopePresentation()`'s projection, reproduced from `src/tools/exec.ts`:
 *
 *     const output = [
 *       `$ ${command}`,
 *       envelope.stdout.trimEnd(),
 *       envelope.stderr.trimEnd() ? `[stderr]\n${envelope.stderr.trimEnd()}` : '',
 *       envelope.notes.join('\n'),
 *     ].filter((part) => part.length > 0).join('\n')
 *     return { title, output, exitCode, ...(signal ? { signal } : {}), outcome,
 *              sessionId, streamId, durationMs }
 *
 * @param input - the envelope fields this card reads.
 * @returns the `meta` object the tool/result event carries to the client.
 */
function projection(input) {
  const stdout = (input.stdout ?? '').trimEnd()
  const stderr = (input.stderr ?? '').trimEnd()
  const notes = input.notes ?? []
  const output = [
    `$ ${input.command ?? ''}`,
    stdout,
    stderr ? `[stderr]\n${stderr}` : '',
    notes.join('\n'),
  ]
    .filter((part) => part.length > 0)
    .join('\n')
  return {
    title: input.sessionId ? `ssh ${input.sessionId}` : 'ssh',
    output,
    exitCode: input.exitCode ?? null,
    ...(input.signal ? { signal: input.signal } : {}),
    outcome: input.outcome ?? 'success',
    sessionId: input.sessionId ?? null,
    streamId: input.streamId ?? null,
    durationMs: input.durationMs ?? 0,
  }
}

/** A dispatched call with complete arguments and no result yet (`StartedToolCall`). */
function started(args) {
  return {
    phase: 'start',
    callId: 'call-1',
    name: 'ssh_exec',
    turn: 1,
    step: 1,
    time: 1,
    subCalls: [],
    argsRaw: JSON.stringify(args),
  }
}

/** A call whose arguments are not available yet (`PreparingToolCall`). */
function preparing() {
  return { phase: 'preparing', callId: 'call-1', name: 'ssh_exec', turn: 1, step: 1, time: 1, subCalls: [] }
}

/**
 * A settled result node (`ToolResultNode`), as the chat builder emits it.
 *
 * `result()` carries no `meta` property at all; pass `undefined` explicitly for the
 * same case, or any other value to exercise the card's tolerance.
 */
function result(meta, overrides = {}) {
  const { args, ...rest } = overrides
  return {
    kind: 'tool-result',
    seq: 2,
    time: 2,
    callId: 'call-1',
    call: { name: 'ssh_exec', argsRaw: JSON.stringify(args ?? { command: 'ls -la' }) },
    callTime: 1,
    content: [],
    isError: false,
    subCalls: [],
    ...(meta === undefined ? {} : { meta }),
    ...rest,
  }
}

/** One owner-props payload, as `ToolCallTree`'s dispatch composes it. */
function ownerProps(block, extra = {}) {
  return {
    callId: 'call-1',
    toolName: 'ssh_exec',
    phase: block.kind === 'tool-result' ? 'result' : block.phase,
    block,
    cwd: '/srv/app',
    home: '/home/deploy',
    openFile: () => {},
    loadImage: () => {},
    useDisclosure: () => ({ expanded: false, toggle: () => {} }),
    ...extra,
  }
}

/** Render one block through the registered occupant and hand back the card root. */
async function render(block, extra = {}) {
  const { component } = await occupant()
  const markup = renderToStaticMarkup(React.createElement(component, ownerProps(block, extra)))
  // A keyed entry REPLACES the generic row: an empty render would be an empty row.
  assert.notEqual(markup, '', 'the card must always render something')
  const { document } = parseHTML(`<!doctype html><html><body><div id="card">${markup}</div></body></html>`)
  const root = document.getElementById('card').firstElementChild
  assert.ok(root, 'the occupant rendered an element')
  return { markup, root }
}

const at = (root, testid) => root.querySelector(`[data-testid="${testid}"]`)

// ── registration ─────────────────────────────────────────────────────────────

test('the built bundle registers the ssh_exec keyed entry through the slots face', async () => {
  const entry = await occupant()
  assert.equal(entry.declaration.name, 'tool.call.toolview')
  assert.equal(entry.declaration.key, 'ssh_exec', 'the wire tool name is the dispatch key')

  const { slots } = await boot()
  assert.ok(slots.injected.includes('tool.call.toolview'), 'the seat is injected, so a late registry still lands')
  // Registering beside the existing seats, not instead of them.
  const names = slots.registered.map((row) => row.declaration?.name)
  for (const name of ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title', 'sidebar.footer.action', 'shell.overlay']) {
    assert.ok(names.includes(name), `${name} is still registered`)
  }

  const { root } = await render(result(projection({ command: 'uptime' })))
  assert.equal(root.getAttribute('data-tool'), 'ssh_exec')
})

test('a composition whose slot registry lacks the seat still applies, and says why', async () => {
  const { rows, materialise } = await loadBundle({ react: React })
  assert.equal(rows.length, 1)
  const { exports } = materialise()
  const slots = {
    registered: [],
    injected: [],
    inject(key, callback) {
      this.injected.push(key)
      if (key === 'tool.call.toolview') throw new Error(`slot "${key}" is not declared`)
      try {
        callback()
      } catch (error) {
        this.injected.push({ key, error: String(error && error.message) })
      }
      return () => {}
    },
    register(declaration, component) {
      this.registered.push({ declaration, component })
      return () => {}
    },
  }
  const ctx = fakeContext({
    locale: fakeLocale(),
    slots,
    sidebarRightTabs: fakeTabRegistry(),
    remote: fakeRemoteCarrier(),
  })

  assert.doesNotThrow(() => exports.apply(ctx))
  assert.ok(slots.injected.includes('tool.call.toolview'), 'the seat was attempted')
  assert.equal(
    slots.registered.some((row) => row.declaration?.name === 'tool.call.toolview'),
    false,
    'nothing was registered into a seat this composition does not have',
  )
  assert.ok(
    slots.registered.some((row) => row.declaration?.name === 'sidebar.right.pane.tab'),
    'and the other seats still registered',
  )
  const errors = exports.introspect().app.store.getState().spike.registrationErrors
  assert.ok(
    errors.some((entry) => entry.what === 'tool view'),
    `the missing seat is reported as a problem, saw ${JSON.stringify(errors)}`,
  )
})

// ── the five required outcomes ───────────────────────────────────────────────

test('a successful command renders its command, its stdout and an exit 0 pill', async () => {
  const block = result(
    projection({
      command: 'ls -la',
      stdout: 'total 4\n-rw-r--r-- 1 app app 12 a.txt\n',
      exitCode: 0,
      outcome: 'success',
      sessionId: 's_1',
      streamId: 'st_42',
      durationMs: 42,
    }),
  )
  const { root } = await render(block)

  assert.equal(root.getAttribute('data-phase'), 'result')
  assert.equal(root.getAttribute('data-state'), 'ok')
  assert.equal(root.getAttribute('data-meta'), 'record')
  assert.equal(root.getAttribute('data-outcome'), 'success')
  assert.equal(root.getAttribute('data-exit-code'), '0')
  assert.equal(root.getAttribute('data-command-available'), 'true')
  assert.equal(root.getAttribute('data-truncated'), null)

  assert.equal(at(root, 'ssh-toolview-command').textContent, 'ls -la')
  const stdout = at(root, 'ssh-toolview-stdout')
  assert.equal(stdout.getAttribute('data-channel'), 'stdout')
  assert.equal(stdout.textContent, 'total 4\n-rw-r--r-- 1 app app 12 a.txt', 'the projection’s `$ …` line is not repeated')
  assert.equal(at(root, 'ssh-toolview-stderr'), null)
  assert.equal(at(root, 'ssh-toolview-stdout-label'), null, 'a single channel needs no label')

  const exit = at(root, 'ssh-toolview-exit')
  assert.equal(exit.textContent, 'exit 0')
  assert.equal(exit.getAttribute('data-outcome'), 'ok')
  assert.equal(at(root, 'ssh-toolview-status'), null, 'a clean exit needs no second word')
  assert.equal(at(root, 'ssh-toolview-signal'), null)

  assert.match(at(root, 'ssh-toolview-duration').textContent, /took 42 ms/)
  assert.equal(at(root, 'ssh-toolview-session').textContent, 'session s_1')
  assert.equal(at(root, 'ssh-toolview-stream').textContent, 'stream st_42')
  assert.equal(at(root, 'ssh-toolview-outcome').textContent, 'success')
  assert.equal(at(root, 'ssh-toolview-inspect'), null, 'no inspect callback, no inspect button')
})

test('a failed command keeps stderr apart from stdout and states an exit 1', async () => {
  const block = result(
    projection({
      command: 'ls /nope',
      stdout: '',
      stderr: "ls: cannot access '/nope': No such file or directory\n",
      exitCode: 1,
      outcome: 'success',
      sessionId: 's_1',
      notes: ['host: s_1 (deploy@web-01)'],
    }),
  )
  const { root } = await render(block)

  assert.equal(root.getAttribute('data-state'), 'error')
  assert.equal(root.getAttribute('data-exit-code'), '1')
  const exit = at(root, 'ssh-toolview-exit')
  assert.equal(exit.textContent, 'exit 1')
  assert.equal(exit.getAttribute('data-outcome'), 'error')

  const stderr = at(root, 'ssh-toolview-stderr')
  assert.equal(stderr.getAttribute('data-channel'), 'stderr')
  assert.match(stderr.textContent, /cannot access '\/nope'/)
  assert.equal(stderr.getAttribute('aria-label'), 'stderr', 'the channel is stated, not only coloured')
  assert.equal(at(root, 'ssh-toolview-stderr-label').textContent, 'stderr')
  assert.equal(at(root, 'ssh-toolview-stdout'), null, 'an empty stdout is not drawn as an empty box')
  // The Host appends its notes after the stderr marker; the card does not pretend a
  // delimiter exists where the projection has none (documented in the module header).
  assert.match(stderr.textContent, /host: s_1 \(deploy@web-01\)/)

  const status = at(root, 'ssh-toolview-status')
  assert.equal(status.textContent, 'Failed')
  assert.equal(status.getAttribute('data-outcome'), 'error')
})

test('a signalled call carries its signal and no exit pill', async () => {
  const timedOut = await render(
    result(
      projection({
        command: 'sleep 600',
        exitCode: null,
        signal: 'SIGTERM',
        outcome: 'timeout',
        notes: ['terminated after the 1000 ms deadline'],
        durationMs: 1000,
      }),
    ),
  )

  assert.equal(timedOut.root.hasAttribute('data-exit-code'), false, 'a null exit code is not an exit code')
  assert.equal(at(timedOut.root, 'ssh-toolview-exit'), null, 'a non-number exit code is not a pill')
  const signal = at(timedOut.root, 'ssh-toolview-signal')
  assert.equal(signal.textContent, 'signal SIGTERM')
  assert.equal(signal.getAttribute('data-outcome'), 'error')
  assert.equal(timedOut.root.getAttribute('data-signal'), 'SIGTERM')
  assert.equal(timedOut.root.getAttribute('data-state'), 'timeout')
  assert.equal(timedOut.root.getAttribute('data-outcome'), 'timeout')
  assert.equal(at(timedOut.root, 'ssh-toolview-status').textContent, 'Timed out')
  assert.match(at(timedOut.root, 'ssh-toolview-stdout').textContent, /1000 ms deadline/, 'the notes are still shown')

  // A signal with no Host outcome at all is still a failure, not a silent success.
  const killed = await render(result({ output: '$ kill -9 $$', exitCode: null, signal: 'SIGKILL' }))
  assert.equal(killed.root.getAttribute('data-state'), 'error')
  assert.equal(at(killed.root, 'ssh-toolview-signal').textContent, 'signal SIGKILL')
  assert.equal(at(killed.root, 'ssh-toolview-exit'), null)
})

test('a refusal with an empty command still renders its own row and code', async () => {
  // The tool refused the call before it reached the host: a complete envelope whose
  // `command` is empty because the arguments themselves were the problem.
  const refused = await render(
    result(projection({ command: '', exitCode: null, outcome: 'refused', notes: [] }), {
      args: { command: '' },
    }),
  )
  assert.equal(refused.root.getAttribute('data-state'), 'refused')
  assert.equal(refused.root.getAttribute('data-command-available'), 'false')
  assert.equal(refused.root.getAttribute('data-meta'), 'record')
  assert.equal(at(refused.root, 'ssh-toolview-command').textContent, '(no command)')
  assert.equal(at(refused.root, 'ssh-toolview-exit'), null)
  assert.equal(at(refused.root, 'ssh-toolview-status').textContent, 'Refused')
  assert.equal(at(refused.root, 'ssh-toolview-status').getAttribute('data-outcome'), 'refused')
  assert.ok(at(refused.root, 'ssh-toolview-empty'), 'the row states that nothing was captured')

  // And a refused call the harness settled as a tool error carries its code.
  const failed = await render(
    result(undefined, {
      args: { command: 'rm -rf /srv/old' },
      isError: true,
      error: { name: 'SshToolError', code: 'SSH_CFG_INVALID' },
      content: [
        {
          type: 'text',
          text: [
            'ssh: FAILED (refused: SSH_CFG_INVALID) — exit=n/a',
            'command: rm -rf /srv/old',
            'reason: invalid arguments: "timeoutMs" must be an integer',
            '',
            '(no output)',
            '--- notes ---',
            'host: s_1 (deploy@web-01)',
          ].join('\n'),
        },
      ],
    }),
  )
  assert.equal(failed.root.getAttribute('data-state'), 'error')
  assert.equal(failed.root.getAttribute('data-meta'), 'absent')
  assert.equal(at(failed.root, 'ssh-toolview-code').textContent, 'SSH_CFG_INVALID')
  assert.equal(at(failed.root, 'ssh-toolview-status').textContent, 'Failed')
  assert.equal(
    at(failed.root, 'ssh-toolview-error').textContent,
    'SSH_CFG_INVALID: invalid arguments: "timeoutMs" must be an integer',
    'the failure says why, from the render the Host already composed',
  )
  assert.equal(at(failed.root, 'ssh-toolview-command').textContent, 'rm -rf /srv/old')
  // `block.content` is the fallback channel source: it delimits stdout from notes.
  assert.equal(at(failed.root, 'ssh-toolview-stdout').textContent, '(no output)')
  assert.equal(at(failed.root, 'ssh-toolview-notes').textContent, 'host: s_1 (deploy@web-01)')
})

test('a pending call renders its command and a running state instead of nothing', async () => {
  const running = await render(started({ command: 'systemctl restart app', sessionId: 's_1' }))
  assert.equal(running.root.getAttribute('data-phase'), 'start')
  assert.equal(running.root.getAttribute('data-state'), 'running')
  assert.equal(running.root.getAttribute('data-meta'), 'pending')
  assert.equal(at(running.root, 'ssh-toolview-command').textContent, 'systemctl restart app')
  const status = at(running.root, 'ssh-toolview-status')
  assert.equal(status.getAttribute('data-outcome'), 'running')
  assert.equal(status.textContent.trim(), 'Running…', 'the compiled dictionary is live, not a key name')
  assert.ok(at(running.root, 'ssh-toolview-running'))
  assert.equal(at(running.root, 'ssh-toolview-exit'), null)
  assert.equal(at(running.root, 'ssh-toolview-stdout'), null, 'nothing is invented before the result')

  // A preparing call has no arguments at all: the row says so rather than guessing.
  const preparingCall = await render(preparing())
  assert.equal(preparingCall.root.getAttribute('data-phase'), 'preparing')
  assert.equal(preparingCall.root.getAttribute('data-command-available'), 'false')
  assert.equal(at(preparingCall.root, 'ssh-toolview-command').textContent, 'Waiting for the command…')
  assert.ok(at(preparingCall.root, 'ssh-toolview-running'))
})

// ── tolerance ────────────────────────────────────────────────────────────────

test('an odd, scalar or absent meta degrades to facts the card can state', async () => {
  // A tool may project a scalar — `terminal_send` projects a boolean.
  const scalar = await render(result('true'))
  assert.equal(scalar.root.getAttribute('data-meta'), 'unusable')
  assert.ok(at(scalar.root, 'ssh-toolview-empty'))

  // Fields of the wrong type are treated as absent: no pill is invented from `"0"`.
  const strings = await render(
    result({ output: '$ echo 0\n0', exitCode: '0', signal: null, outcome: 'success', durationMs: Number.NaN, streamId: 7 }),
  )
  assert.equal(strings.root.hasAttribute('data-exit-code'), false)
  assert.equal(at(strings.root, 'ssh-toolview-exit'), null)
  assert.equal(at(strings.root, 'ssh-toolview-stream'), null)
  assert.equal(at(strings.root, 'ssh-toolview-duration'), null)
  assert.equal(strings.root.getAttribute('data-state'), 'ok')
  assert.equal(at(strings.root, 'ssh-toolview-stdout').textContent, '0')

  // No `meta` property at all: the settled row still exists and says it has nothing.
  const absent = await render(result(undefined))
  assert.equal(absent.root.getAttribute('data-meta'), 'absent')
  assert.equal(at(absent.root, 'ssh-toolview-empty').textContent, 'No output')

  // A null output with no content behind it is not an exception either.
  const empty = await render(result({ output: null, exitCode: null, outcome: 'success' }))
  assert.ok(at(empty.root, 'ssh-toolview-empty'))

  // And a hand-driven occupant with no props at all is still a card.
  const { component } = await occupant()
  const bare = renderToStaticMarkup(React.createElement(component))
  assert.match(bare, /data-testid="ssh-toolview"/)
})

test('the facts row states the outcome, duration, label, cwd and the truncation flag', async () => {
  const block = result(
    projection({
      command: 'cat big.log',
      stdout: 'head\n…\ntail\n',
      exitCode: 0,
      outcome: 'output-limit',
      sessionId: 's_2',
      streamId: 'st_9',
      durationMs: 1200,
      notes: ['output truncated at maxOutputBytes=262144: 1048576 bytes produced, head+tail kept'],
    }),
    { args: { command: 'cat big.log', cwd: '/srv/app', label: 'read the log' } },
  )
  const { root } = await render(block)

  assert.equal(root.getAttribute('data-outcome'), 'output-limit')
  assert.equal(root.getAttribute('data-truncated'), '1')
  assert.equal(at(root, 'ssh-toolview-exit').getAttribute('data-outcome'), 'ok', 'a clean exit is still clean')
  assert.equal(
    at(root, 'ssh-toolview-status').textContent,
    'Output truncated',
    'a head+tail capture keeps its warning even with exit 0',
  )
  assert.match(at(root, 'ssh-toolview-duration').textContent, /took 1 s/)
  assert.equal(at(root, 'ssh-toolview-label').textContent, 'read the log')
  assert.equal(at(root, 'ssh-toolview-cwd').textContent, 'cwd /srv/app')
  assert.equal(at(root, 'ssh-toolview-outcome').textContent, 'output-limit')
  assert.match(at(root, 'ssh-toolview-stdout').textContent, /output truncated at maxOutputBytes/)

  // The inspect affordance appears only when the owner supplied the callback.
  const inspecting = await render(block, { inspect: () => {} })
  assert.equal(at(inspecting.root, 'ssh-toolview-inspect').textContent, 'Inspect')
})

// ── the module, its dictionaries and the Host seam ───────────────────────────

test('the card module obeys the assembler contract and stays token-only', () => {
  const source = readFileSync(MODULE_PATH, 'utf8')
  assert.match(source, /@module ssh\.toolview/)
  assert.match(source, /@order 485/)
  assert.match(source, /SSH\.define\('ssh\.toolview'/)
  assert.doesNotMatch(source, /^\s*(import|export)\s/m, 'ESM syntax is not allowed in a bundle source')
  assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+/, 'no colour literals (ICD §8.6)')
  assert.match(source, /--dsw-|ssh-ws-|dsh-ssh-|ssh-ws-cmd-pane/, 'the card addresses the plugin’s own classes')
})

test('every key the card asks for exists in both locales, translated and in step', () => {
  const zh = JSON.parse(readFileSync(join(ROOT, 'locale', 'zh.json'), 'utf8'))
  const en = JSON.parse(readFileSync(join(ROOT, 'locale', 'en.json'), 'utf8'))
  const source = readFileSync(MODULE_PATH, 'utf8')
  // The keys the module asks for, including the STATUS table's dynamic lookups. The
  // lookbehind keeps `text.split('\n')` from looking like a `t('…')` call.
  const asked = [
    ...new Set([
      ...[...source.matchAll(/(?<![\w.])t\('([^']+)'/g)].map((match) => match[1]),
      ...[...source.matchAll(/key: '(tool\.[^']+)'/g)].map((match) => match[1]),
    ]),
  ].sort()
  assert.deepEqual(asked, [
    'tool.cancelled',
    'tool.cwd',
    'tool.duration',
    'tool.emptyCommand',
    'tool.exit',
    'tool.failed',
    'tool.inspect',
    'tool.noOutput',
    'tool.ok',
    'tool.outputLimit',
    'tool.pendingCommand',
    'tool.refused',
    'tool.running',
    'tool.session',
    'tool.signal',
    'tool.stderr',
    'tool.stdout',
    'tool.stream',
    'tool.timeout',
    'tool.title',
  ])

  for (const key of asked) {
    assert.equal(typeof en[key], 'string', `en.${key}`)
    assert.equal(typeof zh[key], 'string', `zh.${key}`)
    assert.notEqual(en[key].trim(), '', `en.${key} must not be empty`)
    assert.notEqual(zh[key].trim(), '', `zh.${key} must not be empty`)
    assert.notEqual(zh[key], en[key], `${key} is untranslated`)
    assert.match(zh[key], /[\u4e00-\u9fff]/, `${key} is Chinese in zh`)
    // A placeholder in one language only is a silent render bug (chrome.test.mjs
    // checks this globally; this keeps the card's own keys honest locally).
    const zhParams = [...zh[key].matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
    const enParams = [...en[key].matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
    assert.deepEqual(zhParams, enParams, `placeholder mismatch for ${key}`)
  }
})

test('the shipped artifact carries the card, its order and its locale keys', async () => {
  const { Script } = await import('node:vm')
  const source = readFileSync(BUNDLE_PATH, 'utf8')
  // A parse gate first: the assembler does not check syntax, and a bundle that cannot
  // parse takes the whole plugin off the live page.
  new Script(source)

  assert.match(source, /SSH\.define\('ssh\.toolview'/)
  assert.match(source, /TOOL_NAME = 'ssh_exec'/)
  assert.match(source, /key: toolview\.TOOL_NAME/, 'the registration key comes from the card module')
  assert.ok(
    source.indexOf("SSH.define('ssh.session'") < source.indexOf("SSH.define('ssh.toolview'"),
    'assembled after the session module it borrows from',
  )
  assert.ok(
    source.indexOf("SSH.define('ssh.toolview'") < source.indexOf("SSH.define('ssh.plugin'"),
    'and before the plugin body that registers it',
  )
  // The regenerated dictionary is inside the bundle, the only way the browser reads
  // `locale/*.json` (ICD §8.5).
  assert.match(source, /"tool\.running":/)
  assert.match(source, /"tool\.outputLimit":/)
})

test('the Host projection this card parses still carries its fields and its marker', () => {
  const source = readFileSync(join(ROOT, 'src', 'tools', 'exec.ts'), 'utf8')
  const start = source.indexOf('export function envelopePresentation')
  assert.ok(start > 0, 'envelopePresentation is still the projection this card reads')
  const body = source.slice(start, source.indexOf('\n}', start))
  for (const field of ['title', 'output', 'exitCode', 'signal', 'outcome', 'sessionId', 'streamId', 'durationMs']) {
    assert.match(body, new RegExp(`\\b${field}\\b`), `the projection still carries "${field}"`)
  }
  assert.match(body, /\[stderr\]/, 'the stderr marker the card splits on')
  assert.match(body, /\$\{command\}/, 'the `$ <command>` line the card strips')
})
