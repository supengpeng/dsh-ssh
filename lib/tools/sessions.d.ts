/**
 * `ssh_sessions`, `ssh_connect`, `ssh_disconnect` — the tools that make the other
 * four usable.
 *
 * Before this file, every model-facing tool required a `sessionId` that nothing
 * could produce: `ssh_exec`/`ssh_upload` answered "call ssh_sessions first", and a
 * model had no way to connect at all. That is a surface that only *looks*
 * complete, so these three close it:
 *
 *   - `ssh_sessions` lists what is connected (and is the id source for the rest);
 *   - `ssh_connect` establishes a session, preferring a **stored profile** so the
 *     secret stays in `ctx.credentials` and never appears in the call record;
 *   - `ssh_disconnect` closes one.
 *
 * Three rules from the ICD shape every answer here:
 *
 *   - **No credential ever leaves.** The result carries host/port/user/state and
 *     the session id — never a password, passphrase or key, whatever the caller
 *     supplied (an inline password is consumed by the resolver and dropped).
 *   - **Failures are returned, not thrown.** `execute` answers
 *     `{ ok: false, code, message, notes }` so the model reads a structured
 *     refusal it can act on (`SSH_HOSTKEY_UNKNOWN` → ask the user to trust the key,
 *     `SSH_AUTH_FAILED` → the credential is wrong, …) instead of a crashed call.
 *   - **A host-key refusal explains the two ways forward.** "Unknown host key" with
 *     no next step is the least actionable error a tool can return, so the notes
 *     name both remedies: trust it in the UI, or pre-seed `known_hosts`.
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { type SessionInfo } from '../protocol.js';
export declare const SESSIONS_TOOL_NAMES: readonly ["ssh_connect", "ssh_disconnect", "ssh_sessions"];
export type SessionsToolName = (typeof SESSIONS_TOOL_NAMES)[number];
/** What the tools need from the plugin; injected so this file imports no module. */
export interface SessionsToolDeps {
    /** `registry.list()` — the same projection the UI and `sshPlugin/listSessions` read. */
    listSessions(): SessionInfo[];
    /**
     * Establish a session. Receives the *decoded* request shape, so the tool and the
     * `sshPlugin/connect` endpoint take exactly the same path (audit, host-key
     * prompt, pool reuse) instead of two drifting implementations.
     */
    connect(request: {
        profileId?: string;
        inline?: Record<string, unknown>;
        name?: string;
        secrets?: {
            password?: string;
            passphrase?: string;
        };
    }): Promise<{
        session: SessionInfo;
    }>;
    disconnect(sessionId: string, force?: boolean): Promise<{
        session: SessionInfo;
    }>;
    /** Effective host-key policy, used to explain a refusal precisely. */
    hostKeyPolicy: 'strict' | 'accept-new' | 'insecure';
    /** Where the profile list comes from, for the "which profile?" hint. */
    listProfiles?(): Array<{
        id: string;
        name: string;
        host: string;
        user: string;
    }>;
}
/** `ssh_sessions`. */
export declare function sshSessionsTool(deps: SessionsToolDeps, now?: () => number): ToolDefinition;
/** `ssh_connect`. */
export declare function sshConnectTool(deps: SessionsToolDeps): ToolDefinition;
/** `ssh_disconnect`. */
export declare function sshDisconnectTool(deps: SessionsToolDeps): ToolDefinition;
/** Factories keyed by tool name, so the plugin can honour `config.tools`. */
export declare function sessionsToolFactories(deps: SessionsToolDeps): Record<SessionsToolName, () => ToolDefinition>;
/** All three, in registration order. */
export declare function sessionTools(deps: SessionsToolDeps): ToolDefinition[];
//# sourceMappingURL=sessions.d.ts.map