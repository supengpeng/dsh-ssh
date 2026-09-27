/**
 * Stream identifiers.
 *
 * ICD §0 fixes the shape: `StreamId = 'st_' + ulid`. The ULID body is the
 * canonical 48-bit timestamp + 80-bit randomness form (26 Crockford base32
 * characters), so ids sort by creation time and cannot collide across sessions
 * or restarts.
 */

import { randomBytes } from 'node:crypto'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function encodeTime(milliseconds: number): string {
  let remaining = Math.max(0, Math.trunc(milliseconds))
  let out = ''
  for (let index = 0; index < 10; index += 1) {
    out = CROCKFORD[remaining % 32]! + out
    remaining = Math.floor(remaining / 32)
  }
  return out
}

function encodeRandom(bytes: Buffer): string {
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  let out = ''
  for (let index = 0; index < 16; index += 1) {
    out = CROCKFORD[Number(value % 32n)]! + out
    value /= 32n
  }
  return out
}

/** A fresh, time-sortable stream id. */
export function newStreamId(now: number = Date.now()): string {
  return `st_${encodeTime(now)}${encodeRandom(randomBytes(10))}`
}
