/**
 * Session state machine (ICD §3 `state` frames, docs/DESIGN.md §4).
 *
 * `idle → connecting → authenticating → connected → closing → closed`, with
 * `error` reachable from every live state and `error → connecting` allowed so a
 * retry can reuse the same handle. Illegal transitions raise
 * `SSH_STATE_INVALID` instead of silently corrupting the projection the UI
 * renders.
 */
import { SshError } from '../protocol.js';
export const SESSION_STATES = [
    'idle',
    'connecting',
    'authenticating',
    'connected',
    'closing',
    'closed',
    'error',
];
/**
 * Allowed successors per state.
 *
 * `idle → closing/closed` covers a session that is released before it ever
 * dialled; `connected → closed` covers a peer that dropped the connection
 * without a local close request.
 */
const TRANSITIONS = {
    idle: ['connecting', 'closing', 'closed', 'error'],
    connecting: ['authenticating', 'connected', 'error', 'closing', 'closed'],
    authenticating: ['connected', 'error', 'closing', 'closed'],
    // A retry after a failed attempt re-enters `connecting`.
    error: ['connecting', 'closing', 'closed'],
    connected: ['closing', 'closed', 'error'],
    closing: ['closed', 'error'],
    closed: [],
};
export function canTransition(from, to) {
    if (from === to)
        return true;
    return (TRANSITIONS[from] ?? []).includes(to);
}
export function assertTransition(from, to) {
    if (canTransition(from, to))
        return;
    throw new SshError('SSH_STATE_INVALID', `illegal session state transition: ${from} -> ${to}`, {
        details: { from, to },
    });
}
/** Small observable wrapper used by the session handle to publish transitions. */
export class SessionStateMachine {
    current;
    listeners = new Set();
    constructor(initial = 'idle') {
        this.current = initial;
    }
    get state() {
        return this.current;
    }
    /** Apply `next`; returns `false` when it was already the current state. */
    set(next) {
        if (next === this.current)
            return false;
        assertTransition(this.current, next);
        const from = this.current;
        this.current = next;
        for (const listener of [...this.listeners]) {
            try {
                listener({ from, to: next });
            }
            catch {
                // A projection listener must never break the connection lifecycle.
            }
        }
        return true;
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
}
//# sourceMappingURL=state.js.map