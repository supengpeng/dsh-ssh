/**
 * Request-parameter decoding for the Remote endpoints.
 *
 * Every endpoint reads its arguments through this module and never off the raw
 * argument directly, for one measured reason: a source-mode Remote endpoint has
 * no generated parameter codec, and the carrier's delivery of a rich payload is
 * lossy (M0 §7.2 — a six-key object arrived as two keys, dropping even the string
 * *after* the nested object). Reading `raw.sessionId` would therefore work in
 * unit tests and silently return `undefined` in the browser, which the user
 * experiences as "I clicked and nothing happened".
 *
 * The convention (ICD §12 R1.3) is:
 *
 *   - a payload is a **flat object of primitives** (`string|number|boolean|null`);
 *   - a nested structure travels as a JSON string in `<field>Json`
 *     (`envJson`, `profileJson`, `secretsJson`) and is parsed here;
 *   - anything that cannot be decoded is `SSH_CFG_INVALID` — never a silent
 *     `undefined` that surfaces three layers later as an unrelated error.
 *
 * A nested value passed *directly* as an object is still accepted, because
 * in-process callers (the agent tools, the endpoint tests) legitimately do that;
 * it is reported once per field so a browser-side regression is visible in the
 * log instead of invisible.
 */
import { SshError } from '../protocol.js';
import { booleanField, decodePayload, numberField, objectField, stringField } from './codec.js';
/** Normalise whatever the carrier delivered into one params object. */
export function readParams(raw) {
    const decoded = decodePayload(raw);
    if (decoded.shape === 'unparsable') {
        throw new SshError('SSH_CFG_INVALID', `the request payload is not valid JSON: ${decoded.parseError ?? 'unknown error'}`);
    }
    return { params: decoded.params, shape: decoded.shape };
}
// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------
export function requiredString(params, name, hint = '') {
    const value = stringField(params, name);
    if (value === undefined || value.trim() === '') {
        throw new SshError('SSH_CFG_INVALID', `${name} is required${hint === '' ? '' : ` (${hint})`}`);
    }
    return value;
}
export function optionalString(params, name) {
    const value = stringField(params, name);
    return value === undefined || value === '' ? undefined : value;
}
export function optionalNumber(params, name) {
    return numberField(params, name);
}
export function optionalBoolean(params, name) {
    return booleanField(params, name);
}
/** A required enum, validated against the frozen set; an unknown value is a config error. */
export function requiredEnum(params, name, allowed) {
    const value = requiredString(params, name);
    if (!allowed.includes(value)) {
        throw new SshError('SSH_CFG_INVALID', `${name} must be one of ${allowed.join(', ')}`);
    }
    return value;
}
// ---------------------------------------------------------------------------
// Nested structures (the `<field>Json` convention)
// ---------------------------------------------------------------------------
/** Field names already reported as delivered directly, so the warning is once each. */
const reportedDirect = new Set();
/**
 * Forget which fields were already reported.
 *
 * The dedup exists so a chatty client cannot flood the log with one warning per
 * call; tests need to observe the first occurrence, so the state is resettable
 * instead of being unreachable.
 */
export function resetDirectNestedWarnings() {
    reportedDirect.clear();
}
function parseJson(text, name) {
    try {
        return JSON.parse(text);
    }
    catch (error) {
        throw new SshError('SSH_CFG_INVALID', `${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
}
function isPlainRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function directNested(name, onDirect) {
    if (reportedDirect.has(name))
        return;
    reportedDirect.add(name);
    onDirect?.(name);
}
/**
 * A nested object: `<name>Json` on the wire, a plain object in process.
 *
 * Malformed JSON, a JSON value that is not an object, or a field of the wrong
 * type are all `SSH_CFG_INVALID` — the caller asked for a structure and did not
 * supply one, and guessing would hide a client bug.
 */
export function objectJson(params, name, onDirect) {
    const text = stringField(params, `${name}Json`);
    if (text !== undefined && text.trim() !== '') {
        const parsed = parseJson(text, `${name}Json`);
        if (!isPlainRecord(parsed))
            throw new SshError('SSH_CFG_INVALID', `${name}Json must decode to an object`);
        return parsed;
    }
    const direct = objectField(params, name);
    if (direct !== undefined) {
        directNested(name, onDirect);
        return direct;
    }
    if (params[name] !== undefined && params[name] !== null) {
        throw new SshError('SSH_CFG_INVALID', `${name} must be an object (JSON-encoded in ${name}Json)`);
    }
    return undefined;
}
/** A nested array, with the same convention and the same strictness. */
export function arrayJson(params, name, onDirect) {
    const text = stringField(params, `${name}Json`);
    if (text !== undefined && text.trim() !== '') {
        const parsed = parseJson(text, `${name}Json`);
        if (!Array.isArray(parsed))
            throw new SshError('SSH_CFG_INVALID', `${name}Json must decode to an array`);
        return parsed;
    }
    const direct = params[name];
    if (Array.isArray(direct)) {
        directNested(name, onDirect);
        return direct;
    }
    if (direct !== undefined && direct !== null) {
        throw new SshError('SSH_CFG_INVALID', `${name} must be an array (JSON-encoded in ${name}Json)`);
    }
    return undefined;
}
/**
 * A `Record<string, string>` (the `env` parameter).
 *
 * Every value must be a string: a number here would be coerced silently into the
 * remote environment, where the difference between `"1"` and `1` is invisible.
 */
export function stringMapJson(params, name) {
    const source = objectJson(params, name);
    if (source === undefined)
        return undefined;
    const out = {};
    for (const [key, value] of Object.entries(source)) {
        if (key.trim() === '')
            continue;
        if (typeof value !== 'string') {
            throw new SshError('SSH_CFG_INVALID', `${name}.${key} must be a string`);
        }
        out[key] = value;
    }
    return Object.keys(out).length === 0 ? undefined : out;
}
/** A `string[]` (the `kinds` parameter), rejecting non-string members. */
export function stringArrayJson(params, name) {
    const source = arrayJson(params, name);
    if (source === undefined)
        return undefined;
    const out = [];
    for (const value of source) {
        if (typeof value !== 'string')
            throw new SshError('SSH_CFG_INVALID', `${name} must contain only strings`);
        if (value !== '')
            out.push(value);
    }
    return out.length === 0 ? undefined : out;
}
/** Result shape of every endpoint: JSON-safe by construction. */
export { encodeResult } from './codec.js';
//# sourceMappingURL=params.js.map