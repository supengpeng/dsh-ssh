/**
 * The exec layer's view of the connection layer, declared structurally.
 *
 * These interfaces mirror `docs/ICD.md` §7.1 (`SessionHandle`, `ExecHandle`,
 * `ShellHandle`, `ExecRequest`, `ShellRequest`) *field for field* on purpose:
 * SP1 owns the real declarations in `src/connection/types.ts`, and this module
 * deliberately does not import them. Two reasons, both practical:
 *
 *   1. mock-first development — every test in this folder drives a fake
 *      session, so the exec layer never blocks on the connection layer landing;
 *   2. structural typing means SP1's `SessionHandle` is assignable to
 *      {@link SessionHandleLike} without either side importing the other, so
 *      there is exactly one implementation and no adapter to drift.
 *
 * If SP1's published shape ever stops being assignable to these types, that is
 * an ICD violation to report — not something to paper over with a cast here.
 */
/** Session states from which a new channel may be started. */
const USABLE_STATES = new Set(['connected', 'idle', 'authenticating', 'connecting']);
/**
 * Whether a session is worth trying to start a channel on.
 *
 * `state` is optional in the structural mirror because a pool implementation
 * may expose it only through `info.state`; both are consulted. An unknown state
 * string is accepted (forward compatibility), while the explicitly closed
 * states are refused before a channel is even attempted.
 */
export function sessionStateOf(session) {
    const direct = session.state;
    if (typeof direct === 'string' && direct.length > 0)
        return direct;
    const nested = session.info?.state;
    return typeof nested === 'string' && nested.length > 0 ? nested : undefined;
}
export function isClosedState(state) {
    if (state === undefined)
        return false;
    return !USABLE_STATES.has(state);
}
/**
 * Duck-type a value as an exec-capable session.
 *
 * Used at the integration seam (`resolveSession` may be fed anything) so a
 * wiring mistake surfaces as `SSH_STATE_INVALID` on the call instead of a
 * `TypeError` deep inside the frame pump.
 */
export function isSessionHandle(value) {
    if (value === null || typeof value !== 'object')
        return false;
    const candidate = value;
    return (typeof candidate.id === 'string' &&
        typeof candidate.exec === 'function' &&
        typeof candidate.shell === 'function');
}
//# sourceMappingURL=types.js.map