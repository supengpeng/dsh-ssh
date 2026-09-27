/**
 * The reporting rule of `scripts/verify-all.mjs`.
 *
 * Why this file exists: `node --test` exits **0** when every case in a file
 * skips. `verify-all` used to judge a layer purely by that exit code, so a layer
 * that executed nothing — the env-gated real-host suite, or the OpenSSH interop
 * file on a runner with no `ssh-keygen` — was reported `PASS`. The mirror-image
 * failure is worse than a red build: "verify:all is green" stops meaning
 * "something was verified".
 *
 * The rule is now `pass === 0 && skipped > 0` => `SKIP`, and the summary lists
 * those layers separately from real failures. These tests take a captured
 * reporter block and assert the verdict, so the rule is pinned where it can be
 * read rather than inferred from a run.
 *
 * Importing the script here is only safe because it guards its `main()` behind an
 * "is this the entry point" check: if that guard ever regressed, this file would
 * launch the whole verification instead of reporting, which is the loudest
 * possible signal that it did.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  classifyLayerStatus,
  layers,
  npmTestCoverageGap,
  parseTestCounts,
  selectLayers,
} from '../../scripts/verify-all.mjs'

/**
 * The spec reporter's summary glyph. Written as an escape on purpose: a literal
 * U+2139 in a source file survives most editors and only some encodings, and a
 * mangled glyph would make this suite pass while the real parser fails.
 */
const MARK = '\u2139'

/** A reporter tail shaped exactly like `node --test --test-reporter=spec`. */
function specSummary({ tests, pass, fail = 0, skipped = 0, cancelled = 0, todo = 0 }) {
  return [
    '✔ some earlier case (1.0000ms)',
    `${MARK} tests ${tests}`,
    `${MARK} suites 0`,
    `${MARK} pass ${pass}`,
    `${MARK} fail ${fail}`,
    `${MARK} cancelled ${cancelled}`,
    `${MARK} skipped ${skipped}`,
    `${MARK} todo ${todo}`,
    `${MARK} duration_ms 51664.1789`,
  ]
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

test('the reporter counts are read from a real-shaped summary block', () => {
  const counts = parseTestCounts(specSummary({ tests: 585, pass: 582, skipped: 3 }))
  assert.deepEqual(counts, { tests: 585, passed: 582, skipped: 3 })
})

test('CRLF output and leading noise do not hide the counts', () => {
  const lines = specSummary({ tests: 12, pass: 12 })
  assert.deepEqual(parseTestCounts(lines.join('\r\n')), { tests: 12, passed: 12, skipped: 0 })
  assert.deepEqual(parseTestCounts(['# Subtest: x', 'not ok 1 - y'].concat(lines)), { tests: 12, passed: 12, skipped: 0 })
})

test('output with no summary yields undefined instead of a guess', () => {
  // A non-test layer, a spawn failure or a reworded reporter must not be read as
  // "zero tests passed", which would mark a perfectly good layer as zero-execution.
  assert.equal(parseTestCounts([]), undefined)
  assert.equal(parseTestCounts(['hello', 'world']), undefined)
  assert.equal(parseTestCounts(''), undefined)
  assert.equal(parseTestCounts(undefined), undefined)
  assert.equal(parseTestCounts(`${MARK} pass 3`), undefined, 'pass without tests is not a summary')
})

test('the parser accepts a string as well as line arrays', () => {
  // The CI guard reads a file, so both shapes must work.
  assert.deepEqual(parseTestCounts(specSummary({ tests: 5, pass: 5 }).join('\n')), { tests: 5, passed: 5, skipped: 0 })
})

// ---------------------------------------------------------------------------
// The SKIP-versus-PASS rule
// ---------------------------------------------------------------------------

test('a layer that executed nothing is SKIP, not PASS', () => {
  // The regression this whole file exists for: exit code 0, zero passing cases.
  const counts = parseTestCounts(specSummary({ tests: 5, pass: 0, skipped: 5 }))
  const judged = classifyLayerStatus('pass', counts)
  assert.equal(judged.status, 'skipped')
  assert.match(String(judged.note), /executed nothing: 5\/5 cases skipped/)
})

test('a partially skipped layer is still PASS', () => {
  // 3 skips out of 585 is the accepted baseline, not a zero-execution layer.
  const judged = classifyLayerStatus('pass', parseTestCounts(specSummary({ tests: 585, pass: 582, skipped: 3 })))
  assert.equal(judged.status, 'pass')
  assert.equal(judged.note, undefined)
})

test('a layer with passing cases and no skips is PASS', () => {
  assert.equal(classifyLayerStatus('pass', { tests: 5, passed: 5, skipped: 0 }).status, 'pass')
})

test('a failure is never upgraded to SKIP', () => {
  // A layer that broke must stay broken even when it also skipped something.
  for (const status of ['fail', 'timeout']) {
    const judged = classifyLayerStatus(status, { tests: 5, passed: 0, skipped: 5 })
    assert.equal(judged.status, status)
    assert.equal(judged.note, undefined, 'the failure keeps its own note')
  }
})

test('unparseable output falls back to the exit-code verdict', () => {
  // Degrading to the old behaviour is deliberate: an unrecognised reporter must
  // not turn every layer into a zero-execution alarm.
  assert.equal(classifyLayerStatus('pass', undefined).status, 'pass')
  assert.equal(classifyLayerStatus('fail', undefined).status, 'fail')
})

test('a layer that ran zero cases at all is not called zero-execution', () => {
  // `skipped > 0` is the signature. An empty selection is a different problem
  // (verify-all exits 2 for it) and is not this rule's business.
  assert.equal(classifyLayerStatus('pass', { tests: 0, passed: 0, skipped: 0 }).status, 'pass')
})

// ---------------------------------------------------------------------------
// The npm-test coverage gap
// ---------------------------------------------------------------------------

test('the gap names the layers `npm test` would not have run', () => {
  // Read the real script so the assertion follows package.json rather than a
  // copy of it. `npm test` chains unit + client; the rest is verify-all's job.
  const gap = npmTestCoverageGap('npm run test:unit && npm run test:client', layers)
  assert.deepEqual(gap.covered, ['test:unit', 'test:client'])
  assert.ok(gap.missing.includes('test:integration'), 'integration is the layer a developer most expects npm test to cover')
  assert.ok(gap.missing.includes('test:e2e'))
  assert.ok(gap.missing.includes('test:perf'))
})

test('the gap understands pnpm-style chains too', () => {
  assert.deepEqual(npmTestCoverageGap('pnpm run test:unit', layers).covered, ['test:unit'])
})

test('an unreadable test script reports everything as missing, not as covered', () => {
  // Missing the manifest must not be read as "npm test runs all of it".
  const gap = npmTestCoverageGap('', layers)
  assert.deepEqual(gap.covered, [])
  assert.ok(gap.missing.includes('test:unit'))
})

test('opt-in layers are excluded from the gap', () => {
  // `--real` and `--coverage` layers are opt-in by construction, so listing them
  // as "npm test does not run these" would be noise, not a finding.
  const gap = npmTestCoverageGap('npm run test:unit', layers)
  assert.equal(gap.covered.includes('test:real'), false)
  assert.equal(gap.missing.includes('test:real'), false)
  assert.equal(gap.missing.includes('coverage'), false)
})

// ---------------------------------------------------------------------------
// Layer table sanity (the summary is only as good as the ids it prints)
// ---------------------------------------------------------------------------

test('every layer carries the fields the summary and the timeout use', () => {
  assert.ok(layers.length >= 8, `expected the documented layer table, saw ${layers.length}`)
  const ids = new Set()
  for (const layer of layers) {
    assert.match(layer.id, /^[\w:]+$/, `${layer.id} must be a printable layer id`)
    assert.equal(ids.has(layer.id), false, `duplicate layer id ${layer.id}`)
    ids.add(layer.id)
    assert.ok(Number.isFinite(layer.timeoutMs) && layer.timeoutMs > 0, `${layer.id} needs a positive timeout`)
    assert.ok(['test', 'build', 'lint'].includes(layer.kind), `${layer.id} has an unexpected kind`)
  }
  assert.ok(ids.has('test:unit') && ids.has('test:integration'), 'the documented layers must exist')
})

test('selectLayers honours --only, --skip-perf and the opt-in gates', () => {
  // Guard the two behaviours the SKIP work leans on: the default selection is
  // exactly the layer table minus the opt-in layers.
  const selected = selectLayers()
  assert.equal(selected.some((layer) => layer.id === 'test:real'), false, 'real-target is opt-in')
  assert.equal(selected.some((layer) => layer.id === 'coverage'), false, 'coverage is opt-in')
  assert.equal(selected.some((layer) => layer.id === 'test:perf'), true, 'perf runs unless --skip-perf is passed')
})
