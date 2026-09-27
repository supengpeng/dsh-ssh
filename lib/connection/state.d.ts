/**
 * Session state machine (ICD §3 `state` frames, docs/DESIGN.md §4).
 *
 * `idle → connecting → authenticating → connected → closing → closed`, with
 * `error` reachable from every live state and `error → connecting` allowed so a
 * retry can reuse the same handle. Illegal transitions raise
 * `SSH_STATE_INVALID` instead of silently corrupting the projection the UI
 * renders.
 */
import type { SessionState } from '../protocol.js';
export declare const SESSION_STATES: readonly SessionState[];
export declare function canTransition(from: SessionState, to: SessionState): boolean;
export declare function assertTransition(from: SessionState, to: SessionState): void;
export interface StateChange {
    from: SessionState;
    to: SessionState;
}
export type StateListener = (change: StateChange) => void;
/** Small observable wrapper used by the session handle to publish transitions. */
export declare class SessionStateMachine {
    private current;
    private readonly listeners;
    constructor(initial?: SessionState);
    get state(): SessionState;
    /** Apply `next`; returns `false` when it was already the current state. */
    set(next: SessionState): boolean;
    subscribe(listener: StateListener): () => void;
}
//# sourceMappingURL=state.d.ts.map