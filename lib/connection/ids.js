/**
 * Identifier generation (docs/DESIGN.md §4): `<prefix>_<ulid>`.
 *
 * Hand-rolled rather than pulled from a dependency: the wire contract only
 * requires an opaque, sortable, collision-free string, and the host half must
 * not grow a runtime dependency for 30 lines of Crockford base32.
 */
import { randomBytes } from 'node:crypto';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Encode `value` as `length` Crockford base32 characters (most significant first). */
function encode(value, length) {
    let out = '';
    let rest = value;
    for (let i = 0; i < length; i++) {
        // `value` stays below Number.MAX_SAFE_INTEGER for the 48-bit timestamp part.
        out = CROCKFORD[rest % 32] + out;
        rest = Math.floor(rest / 32);
    }
    return out;
}
/**
 * 26-character ULID: 48-bit millisecond timestamp + 80 random bits.
 *
 * Two ids minted in the same millisecond are ordered by their random part, which
 * is all the sortability the plugin needs (ids are never used for security).
 */
export function ulid(now = Date.now()) {
    const time = encode(now, 10);
    // 80 random bits / 5 bits per character = exactly 16 characters.
    const bytes = randomBytes(10);
    let accumulator = 0;
    let bits = 0;
    let out = '';
    for (const byte of bytes) {
        accumulator = (accumulator << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            bits -= 5;
            out += CROCKFORD[(accumulator >>> bits) & 31];
        }
        accumulator &= (1 << bits) - 1;
    }
    return time + out;
}
export function newSessionId() {
    return `s_${ulid()}`;
}
export function newStreamId() {
    return `st_${ulid()}`;
}
export function newOpId() {
    return `op_${ulid()}`;
}
export function newProfileId() {
    return `p_${ulid()}`;
}
//# sourceMappingURL=ids.js.map