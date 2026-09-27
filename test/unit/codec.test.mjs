/**
 * The wire codec is the one module that must be right about shapes we did not
 * choose, so it is tested against every delivery form the M0 measurements made
 * plausible - including the two-key-object case that started this work.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  arrayField,
  booleanField,
  decodePayload,
  encodeResult,
  isJsonSafe,
  numberField,
  objectField,
  stringField,
} from '../../lib/api/codec.js'

test('an absent payload decodes to empty params, not a crash', () => {
  assert.deepEqual(decodePayload(undefined), { params: {}, shape: 'absent' })
  assert.deepEqual(decodePayload(null), { params: {}, shape: 'absent' })
  assert.deepEqual(decodePayload(''), { params: {}, shape: 'absent' })
})

test('the JSON-string convention decodes to the original object', () => {
  const params = { sessionId: 's_1', command: 'uname -a', nested: { deep: [1, 2, 3] }, nil: null, flag: true }
  const decoded = decodePayload(JSON.stringify(params))
  assert.deepEqual(decoded.params, params)
  assert.equal(decoded.shape, 'params-json')
})

test('a plain params object passes through unchanged', () => {
  const decoded = decodePayload({ sessionId: 's_1' })
  assert.deepEqual(decoded.params, { sessionId: 's_1' })
  assert.equal(decoded.shape, 'params-object')
})

test('a full envelope is unwrapped, keeping its id and method', () => {
  const decoded = decodePayload({ v: 1, id: 'op_7', method: 'sshPlugin/exec', params: { command: 'ls' } })
  assert.deepEqual(decoded.params, { command: 'ls' })
  assert.equal(decoded.method, 'sshPlugin/exec')
  assert.equal(decoded.id, 'op_7')
  assert.equal(decoded.shape, 'envelope-object')

  const json = decodePayload(JSON.stringify({ v: 1, id: 'op_8', method: 'sshPlugin/ping', params: { echo: 'x' } }))
  assert.deepEqual(json.params, { echo: 'x' })
  assert.equal(json.method, 'sshPlugin/ping')
  assert.equal(json.shape, 'envelope-json')
})

test('an envelope without params yields empty params, never undefined', () => {
  const decoded = decodePayload({ v: 1, method: 'sshPlugin/ping' })
  assert.deepEqual(decoded.params, {})
})

test('a positional carrier that boxed one object is accepted', () => {
  const decoded = decodePayload([{ sessionId: 's_9' }])
  assert.deepEqual(decoded.params, { sessionId: 's_9' })
  assert.equal(decoded.shape, 'positional-single')
})

test('several positional arguments are preserved by index rather than silently truncated', () => {
  const decoded = decodePayload(['s_1', 'uname -a', 5000])
  assert.deepEqual(decoded.params, { args: ['s_1', 'uname -a', 5000] })
  assert.equal(decoded.shape, 'positional-array')
})

test('a bare scalar becomes a named value instead of being dropped', () => {
  assert.deepEqual(decodePayload('PROBE-A'), { params: { value: 'PROBE-A' }, shape: 'scalar' })
  assert.deepEqual(decodePayload(42), { params: { value: 42 }, shape: 'scalar' })
})

test('malformed JSON is reported, not thrown', () => {
  const decoded = decodePayload('{"carrier":null,"ok":false,"tran')
  assert.deepEqual(decoded.params, {})
  assert.equal(decoded.shape, 'unparsable')
  assert.ok(typeof decoded.parseError === 'string' && decoded.parseError.length > 0)
})

test('the M0 two-key delivery is decoded for what it is', () => {
  // This exact object is what the host observed at 22:50 (docs/M0-SPIKE.md 7.2).
  const decoded = decodePayload({ carrier: null, ok: false })
  assert.equal(decoded.shape, 'params-object')
  assert.equal(decoded.params['carrier'], null)
  assert.equal(decoded.params['ok'], false)
  assert.equal('transport' in decoded.params, false)
})

test('typed readers coerce only what is unambiguous and never fabricate', () => {
  const params = { s: 'text', n: 12, nText: '34', b: true, bText: 'false', o: { a: 1 }, a: [1, 2], bad: {} }
  assert.equal(stringField(params, 's'), 'text')
  assert.equal(stringField(params, 'n'), undefined)
  assert.equal(numberField(params, 'n'), 12)
  assert.equal(numberField(params, 'nText'), 34)
  assert.equal(numberField(params, 's'), undefined)
  assert.equal(booleanField(params, 'b'), true)
  assert.equal(booleanField(params, 'bText'), false)
  assert.equal(booleanField(params, 'n'), undefined, 'a number is not a boolean')
  assert.deepEqual(objectField(params, 'o'), { a: 1 })
  assert.equal(objectField(params, 'a'), undefined)
  assert.deepEqual(arrayField(params, 'a'), [1, 2])
  assert.equal(arrayField(params, 'o'), undefined)
})

test('results are encoded JSON-safely, with binary preserved', () => {
  assert.equal(encodeResult(undefined), null)
  assert.equal(encodeResult(Number.NaN), null)
  assert.equal(encodeResult(Number.POSITIVE_INFINITY), null)
  assert.equal(encodeResult(BigInt(7)), '7')
  assert.deepEqual(encodeResult(Buffer.from('hi')), { $bytes: 'aGk=' })
  assert.deepEqual(encodeResult(new Uint8Array([104, 105])), { $bytes: 'aGk=' })
  assert.equal(encodeResult(new Date('2026-01-02T03:04:05.000Z')), '2026-01-02T03:04:05.000Z')
  assert.deepEqual(encodeResult([1, undefined, 'x']), [1, null, 'x'])
  // `undefined` members are omitted entirely so the value survives a real JSON
  // round trip unchanged.
  assert.deepEqual(encodeResult({ keep: 1, drop: undefined }), { keep: 1 })
  // A function member has no wire form at all, so it becomes null rather than
  // disappearing and making the client's shape checks lie.
  assert.deepEqual(encodeResult({ fn: () => {} }), { fn: null })
})

test('encoded results are actually JSON-safe (round trip loses nothing)', () => {
  const value = { at: new Date('2026-01-02T03:04:05.000Z'), bytes: Buffer.from('xy'), list: [1, { deep: true }], nil: null }
  const encoded = encodeResult(value)
  assert.equal(isJsonSafe(encoded), true)
  assert.deepEqual(JSON.parse(JSON.stringify(encoded)), encoded)
})

test('isJsonSafe rejects exactly the values JSON would mangle', () => {
  assert.equal(isJsonSafe({ a: 1, b: 'two', c: [true, null] }), true)
  assert.equal(isJsonSafe(undefined), false)
  assert.equal(isJsonSafe({ a: undefined }), false)
  assert.equal(isJsonSafe({ a: () => {} }), false)
  assert.equal(isJsonSafe(Number.NaN), false)
  assert.equal(isJsonSafe(new Map()), false)
  assert.equal(isJsonSafe([1, 2]), true)
  assert.equal(isJsonSafe('text'), true)
})
