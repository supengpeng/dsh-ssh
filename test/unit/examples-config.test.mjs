/**
 * `examples/config/default.yml` is documented as the full mirror of the schema defaults
 * ("全量默认值镜像 … 每一行的值 = src/config.ts 里 Schemastery schema 的 .default()"),
 * and `examples/config/README.md` tells the reader to copy it into a profile.
 *
 * That claim was unchecked: no test read the file, and it had drifted in two ways —
 * `tools` listed 5 of the 7 tools in a different order (so a copy-paste silently removed
 * `ssh_connect`/`ssh_disconnect`, leaving the model unable to open a session), and the
 * whole `activity.*` section was missing. These tests make the claim checkable.
 *
 * The example is plain YAML, so it is read with the small reader below rather than by
 * adding a dependency. The reader understands exactly the subset this file uses (nested
 * mappings, block sequences of scalars, inline `# comments`) and **throws** on anything
 * else, so a future edit that introduces richer YAML fails loudly instead of silently
 * parsing to the wrong value.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { Config } from '../../lib/config.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const EXAMPLE = join(ROOT, 'examples', 'config', 'default.yml')

/** Drop an inline comment; values in this file never contain a quoted `#`. */
function stripComment(text) {
  return text.replace(/\s+#.*$/, '')
}

/** Scalar coercion for the subset: '', booleans, integers, otherwise the raw string. */
function scalar(raw) {
  const value = stripComment(raw).trim()
  if (value === "''" || value === '""') return ''
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+$/.test(value)) return Number(value)
  return value
}

/** Parse the YAML subset described in this file's header. Throws on anything else. */
function parseExampleYaml(text) {
  const lines = text
    .split(/\r?\n/)
    .map((raw, index) => ({ indent: raw.length - raw.trimStart().length, body: raw.trim(), line: index + 1 }))
    .filter((entry) => entry.body !== '' && !entry.body.startsWith('#'))
  let cursor = 0

  function parseSequence(indent) {
    const items = []
    while (cursor < lines.length && lines[cursor].indent === indent && lines[cursor].body.startsWith('- ')) {
      const item = lines[cursor].body.slice(2).trim()
      if (item === '') throw new Error(`examples/config/default.yml:${lines[cursor].line}: nested sequences are not supported`)
      items.push(scalar(item))
      cursor += 1
    }
    return items
  }

  function parseMapping(indent) {
    const out = {}
    while (cursor < lines.length && lines[cursor].indent === indent && !lines[cursor].body.startsWith('- ')) {
      const entry = lines[cursor]
      const match = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(stripComment(entry.body))
      if (!match) throw new Error(`examples/config/default.yml:${entry.line}: unsupported syntax "${entry.body}"`)
      const [, key, rest] = match
      cursor += 1
      const value = rest.trim()
      if (value !== '') out[key] = scalar(value)
      else if (cursor < lines.length && lines[cursor].indent > indent) out[key] = parseBlock(lines[cursor].indent)
      else out[key] = null
    }
    return out
  }

  function parseBlock(indent) {
    if (cursor >= lines.length) throw new Error('examples/config/default.yml: unexpected end of file')
    return lines[cursor].body.startsWith('- ') ? parseSequence(indent) : parseMapping(indent)
  }

  const parsed = parseBlock(0)
  if (cursor !== lines.length) {
    throw new Error(`examples/config/default.yml:${lines[cursor].line}: trailing content was not consumed`)
  }
  return parsed
}

/** Flatten to leaf paths; arrays are leaves so their order is compared. */
function flatten(value, prefix = '') {
  const out = new Map()
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      for (const [path, leaf] of flatten(child, prefix === '' ? key : `${prefix}.${key}`)) out.set(path, leaf)
    }
  } else {
    out.set(prefix, value)
  }
  return out
}

const example = parseExampleYaml(readFileSync(EXAMPLE, 'utf8'))
const defaults = Config({})

test('the example parses into the shape the reader supports', () => {
  assert.equal(typeof example, 'object')
  assert.ok(example.tools.length > 0, 'tools must be a non-empty sequence')
  assert.equal(Array.isArray(example.logging.redactKeys), true)
})

test('tools mirrors the schema default list, in the same order', () => {
  assert.equal(example.tools.length, 7)
  assert.deepEqual(example.tools, defaults.tools)
  // The two the file used to be missing: without them the model cannot open a session.
  assert.ok(example.tools.includes('ssh_connect'), 'ssh_connect must be registered')
  assert.ok(example.tools.includes('ssh_disconnect'), 'ssh_disconnect must be registered')
})

test('the activity section is present and equals the schema defaults', () => {
  assert.deepEqual(example.activity, defaults.activity)
  assert.deepEqual(Object.keys(example.activity).sort(), ['enabled', 'maxRecordBytes', 'maxRecords', 'maxTotalBytes'])
})

test('every schema default appears in the example with an equal value, and nothing extra', () => {
  const expected = flatten(defaults)
  const actual = flatten(example)

  const missing = [...expected.keys()].filter((path) => !actual.has(path))
  const extra = [...actual.keys()].filter((path) => !expected.has(path))
  assert.deepEqual(missing, [], 'the example omits schema defaults')
  assert.deepEqual(extra, [], 'the example declares keys the schema does not have')

  for (const [path, value] of expected) {
    assert.deepEqual(actual.get(path), value, `${path} disagrees with the schema default`)
  }
})
