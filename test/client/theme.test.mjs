/**
 * Theme token discipline: the chrome stylesheet may only use names the platform
 * actually registers (ICD §8.6).
 *
 * **Why this file exists.** `client/src/theme.css` referenced
 * `--dsw-alias-specific-sidebar-fill` — a name the platform never registers; the real
 * token is `--dsw-specific-sidebar-fill`. The declaration always fell through to its
 * fallback, so the sidebar header silently painted the wrong surface in both themes.
 *
 * Nothing caught it because every local witness agreed with every other local one:
 *
 *   1. `client/src/chrome/theme.js` keeps its own `TOKENS` whitelist, and that list
 *      contained the *same misspelling*. `chrome.test.mjs` asserts "every referenced
 *      token is in TOKENS", which can only ever catch a used-but-unlisted name — never
 *      a listed-but-nonexistent one.
 *   2. `scripts/shot-files.mjs` fabricated a value for the bogus name in both the light
 *      and the dark fixture, so the screenshot regression rendered as if the token
 *      existed. Visual verification therefore confirmed a stylesheet that was wrong.
 *
 * A whitelist maintained *inside this repository* cannot detect a drift away from the
 * platform's registry, so this test pins the platform's registered alias tokens as an
 * explicit constant instead of importing the repository's own list.
 *
 * Token names below were read from the platform (not from this repo):
 *   - registry: `packages/client/ui-theme/src/client/index.ts:145`
 *   - values:   `packages/client/ui-theme/src/styles/design-platform.css:267` (light),
 *               `:377` (dark)
 * The platform lives outside this checkout, so the list is inlined on purpose: a
 * cross-repository path read would make this test unrunnable in CI.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const THEME_CSS = join(ROOT, 'client', 'src', 'theme.css')
const THEME_JS = join(ROOT, 'client', 'src', 'chrome', 'theme.js')

/**
 * The platform's registered `--dsw-*` alias tokens (14).
 *
 * `--dsw-specific-sidebar-fill` is the one this stylesheet got wrong; it is listed here
 * in its correct spelling so the stylesheet and the platform agree.
 */
const PLATFORM_TOKENS = Object.freeze([
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-brand-primary',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-idle-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
  '--dsw-specific-sidebar-fill',
])

/** The name the platform does not register; kept to fail with a precise message. */
const UNREGISTERED = '--dsw-alias-specific-sidebar-fill'

const css = readFileSync(THEME_CSS, 'utf8')

/** Every distinct `--dsw-*` name the stylesheet references anywhere. */
function referencedTokens(source) {
  return [...new Set([...source.matchAll(/--dsw-[a-z0-9-]+/g)].map((match) => match[0]))].sort()
}

test('the stylesheet never uses the unregistered sidebar-fill name', () => {
  assert.equal(
    css.includes(UNREGISTERED),
    false,
    `${UNREGISTERED} is not registered by the platform; use --dsw-specific-sidebar-fill (ui-theme/src/client/index.ts:145)`,
  )
})

test('every --dsw-* token in theme.css is a registered platform token', () => {
  const used = referencedTokens(css)
  assert.ok(used.length >= 10, `expected the stylesheet to reference the token set, found ${used.length}`)
  for (const token of used) {
    assert.ok(
      PLATFORM_TOKENS.includes(token),
      `${token} is not a registered platform token (packages/client/ui-theme/src/client/index.ts:145)`,
    )
  }
})

test('the header paints the registered sidebar-fill token and keeps its fallback', () => {
  // The defensive second argument must survive the rename: a host theme that does not
  // define the token must still get a usable surface rather than an invalid declaration.
  assert.ok(
    css.includes('var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-layer-1))'),
    'the sidebar-fill declaration must use the registered token with its bg-layer-1 fallback',
  )
})

test('client/src/chrome/theme.js whitelist has no name the platform does not register', () => {
  // The root cause lived here: the local whitelist repeated the typo, which is why the
  // "referenced token is known" assertion in chrome.test.mjs could not fail.
  const source = readFileSync(THEME_JS, 'utf8')
  const block = /const TOKENS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(source)
  assert.ok(block, 'client/src/chrome/theme.js must declare `const TOKENS = Object.freeze([...])`')
  const declared = [...new Set([...block[1].matchAll(/'(--dsw-[a-z0-9-]+)'/g)].map((match) => match[1]))].sort()

  for (const token of declared) {
    assert.ok(
      PLATFORM_TOKENS.includes(token),
      `client/src/chrome/theme.js lists ${token}, which the platform never registers; the stylesheet now uses --dsw-specific-sidebar-fill, so the whitelist must list that name instead`,
    )
  }
  for (const token of ['--dsw-specific-sidebar-fill']) {
    assert.ok(declared.includes(token), `client/src/chrome/theme.js TOKENS must include ${token}`)
  }
})
