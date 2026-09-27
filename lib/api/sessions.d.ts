/**
 * §4.3 sessions: connect, disconnect, list, get, follow, and the host-key
 * accept/reject flow.
 *
 * ## `connect` never silently changes trust
 *
 * `accept-new` trusts a first-seen key and records it (OpenSSH's semantics). A
 * *changed* key is never accepted by any policy, and `strict` never accepts an
 * unknown one: both raise a **pending question** that the user answers through
 * `decideHostKey`, which is what makes `pendingHostKey` meaningful instead of
 * decorative. Until the answer arrives the connect call is parked, not failed —
 * and it gives up after `connectTimeoutMs`, because a prompt nobody answers must
 * not hold a connection attempt forever.
 *
 * ## `inline` versus `profileId`
 *
 * The ICD requires exactly one of them. An inline profile is validated through the
 * same `normalizeProfile` as a stored one (so a plaintext cannot ride in), but it
 * is **not persisted**: `connect` is not `saveProfile`, and writing a profile the
 * user did not ask to keep would be a side effect they cannot see.
 */
import { type Frame, type SessionInfo } from '../protocol.js';
import { type Params } from './params.js';
import { ApiGroup, type ApiDeps } from './deps.js';
export declare class SessionsApi extends ApiGroup {
    private readonly pending;
    /** Connect attempts and their pending prompts, keyed by the attempt handle. */
    private attemptSeq;
    /** ICD §4.3 `connect`. */
    connect(params: Params): Promise<{
        session: SessionInfo;
    }>;
    /** ICD §4.3 `disconnect`. */
    disconnect(params: Params): Promise<{
        session: SessionInfo;
    }>;
    /** ICD §4.3 `listSessions`. */
    listSessions(): {
        sessions: SessionInfo[];
    };
    /** ICD §4.3 `getSession`. */
    getSession(params: Params): {
        session: SessionInfo;
    };
    /**
     * ICD §4.3 `followSessions` (stream `state` frames).
     *
     * The current snapshot is emitted first: the client subscribes and *then* calls
     * `listSessions` would otherwise open a window in which a session that appeared
     * between the two calls is never announced.
     */
    follow(): AsyncGenerator<Frame, void, undefined>;
    /**
     * ICD §4.3 `pendingHostKey`: every question currently waiting for an answer.
     *
     * `sessionId` is the handle the caller must pass to `decideHostKey`. While the
     * connection is still being established there is no session id yet, so the
     * attempt's own handle is reported — the field is a decision token, and the
     * ICD's `SessionId` type is a string.
     */
    pendingHostKey(params: Params): {
        pending: Array<{
            sessionId: string;
            host: string;
            port: number;
            keyType: string;
            fingerprint: string;
            knownHostsMatch: 'unknown' | 'changed';
        }>;
    };
    /** ICD §4.3 `decideHostKey`. */
    decideHostKey(params: Params): Promise<{
        decided: true;
    }>;
    /**
     * Park a connect attempt on a user decision.
     *
     * The waiting promise is raced against `connectTimeoutMs`: an unanswered prompt
     * must not hold the connection attempt (and the pool slot) forever, and a
     * timeout is reported as `SSH_TIMEOUT_CONNECT` — the same code the user would
     * see if the handshake itself had stalled.
     */
    private askHostKey;
    /**
     * A rejected accept/reject prompt is reported by the transport with its own
     * structured `SSH_HOSTKEY_*` error, so this module does not synthesise one.
     */
    private forgetAttempt;
    private infoOf;
    private placeholderInfo;
    private oneShot;
    private warnDirect;
}
export type { ApiDeps };
//# sourceMappingURL=sessions.d.ts.map