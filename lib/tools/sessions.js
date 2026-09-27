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
import { toErrorInfo } from '../protocol.js';
import { booleanNode, integerNode, lines, objectNode, parameterRoot, stringNode, text, toLossless } from '../exec/schema.js';
export const SESSIONS_TOOL_NAMES = ['ssh_connect', 'ssh_disconnect', 'ssh_sessions'];
const ENVELOPE_SCHEMA = objectNode({
    ok: { type: 'boolean', description: 'Whether the call succeeded.' },
    code: { type: 'string', description: 'Frozen ICD §5 error code when ok is false.' },
    message: { type: 'string', description: 'Human-readable explanation when ok is false.' },
    notes: { type: 'array', items: { type: 'string' }, description: 'Extra context lines; never contains a credential.' },
    sessionId: { type: 'string', description: 'Session handle for the other ssh_* tools.' },
    host: { type: 'string', description: 'Remote host.' },
    port: { type: 'integer', description: 'Remote port.' },
    user: { type: 'string', description: 'Remote user.' },
    state: { type: 'string', description: 'Session state.' },
    capabilities: objectNode({
        shell: { type: 'boolean' },
        sftp: { type: 'boolean' },
    }),
    sessions: { type: 'array', items: objectNode({}) },
}, ['ok']);
function renderEnvelope(_args, value) {
    const envelope = value;
    if (!envelope.ok) {
        const head = `${envelope.code ?? 'SSH_UNKNOWN'}: ${envelope.message ?? 'the call failed'}`;
        return [text(lines(head, ...envelope.notes.map((note) => `- ${note}`)) ?? head)];
    }
    if (envelope.sessions !== undefined) {
        const rows = envelope.sessions.map((session) => `- ${session.sessionId}  ${session.user}@${session.host}:${session.port}  ${session.state}` +
            `  up ${Math.round(session.connectedForMs / 1000)}s${session.rttMs === undefined ? '' : `  rtt ${Math.round(session.rttMs)}ms`}`);
        return [text(lines(`connected sessions: ${envelope.sessions.length}`, ...rows) ?? 'no sessions')];
    }
    return [
        text(lines(`connected: ${envelope.sessionId ?? '?'}  ${envelope.user ?? '?'}@${envelope.host ?? '?'}:${envelope.port ?? 0}  ${envelope.state ?? ''}`, ...envelope.notes.map((note) => `- ${note}`)) ?? 'ok'),
    ];
}
function sessionsPresentation(_args, value) {
    const envelope = value;
    return toLossless({
        ok: envelope.ok,
        code: envelope.code ?? null,
        sessionId: envelope.sessionId ?? null,
        host: envelope.host ?? null,
        port: envelope.port ?? null,
        user: envelope.user ?? null,
        state: envelope.state ?? null,
        count: envelope.sessions?.length ?? null,
    });
}
/** One session, projected for the model: facts only, never a credential. */
function sessionSummary(info, now) {
    const since = Date.parse(info.since);
    return {
        sessionId: info.id,
        label: info.label,
        host: info.host,
        port: info.port,
        user: info.user,
        state: info.state,
        since: info.since,
        connectedForMs: Number.isFinite(since) ? Math.max(0, now - since) : 0,
        ...(info.metrics.rttMs === undefined ? {} : { rttMs: info.metrics.rttMs }),
        bytesIn: info.metrics.bytesIn,
        bytesOut: info.metrics.bytesOut,
        capabilities: { shell: info.capabilities.shell, sftp: info.capabilities.sftp },
    };
}
/** Turn any thrown value into the canonical refusal, with actionable notes. */
function refusal(error, deps, extraNotes = []) {
    const info = toErrorInfo(error);
    const notes = [...extraNotes];
    if (info.code === 'SSH_HOSTKEY_UNKNOWN') {
        notes.push(deps.hostKeyPolicy === 'strict'
            ? 'the host key is not in known_hosts and the policy is "strict": trust it once in the SSH panel, or add it with ssh-keyscan'
            : 'the host key could not be recorded; check that the known_hosts file is writable');
    }
    if (info.code === 'SSH_HOSTKEY_MISMATCH') {
        notes.push('the presented host key differs from the stored one: verify the fingerprint with the user before trusting it again');
    }
    if (info.code === 'SSH_AUTH_FAILED') {
        notes.push('the stored credential was rejected: update it in the SSH panel (setSecret) or pass the value inline');
    }
    if (info.code === 'SSH_AUTH_PASSPHRASE_REQUIRED') {
        notes.push('the private key is encrypted: supply the passphrase (stored, or inline)');
    }
    if (info.code === 'SSH_CFG_INVALID')
        notes.push('provide either profileId or an inline host');
    return { ok: false, code: info.code, message: info.message, notes };
}
function readString(args, name) {
    const value = args[name];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
function readNumber(args, name) {
    const value = args[name];
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
        return Number(value);
    return undefined;
}
function asRecord(value) {
    return value !== null && typeof value === 'object' ? value : {};
}
/** `ssh_sessions`. */
export function sshSessionsTool(deps, now = Date.now) {
    return {
        name: 'ssh_sessions',
        description: lines('List the SSH sessions currently connected, with the session id, host, user, state and uptime.', '', 'Use this first: `ssh_exec`, `ssh_upload`, `ssh_download` and `ssh_list_dir` all need a `sessionId`,', 'and this is where the ids come from. Omit `sessionId` in those tools only when exactly one session', 'is connected.'),
        parameters: parameterRoot({}),
        output: { schema: ENVELOPE_SCHEMA, render: renderEnvelope, presentationMeta: sessionsPresentation },
        isConcurrencySafe: () => true,
        async execute() {
            const sessions = deps.listSessions().map((info) => sessionSummary(info, now()));
            const envelope = {
                ok: true,
                notes: sessions.length === 0
                    ? ['no session is connected; call ssh_connect (or the SSH panel) first']
                    : sessions.map((session) => `${session.sessionId}: ${session.user}@${session.host}:${session.port} (${session.state})`),
                sessions,
            };
            return toLossless(envelope);
        },
    };
}
/** `ssh_connect`. */
export function sshConnectTool(deps) {
    return {
        name: 'ssh_connect',
        description: lines('Connect to an SSH host and return a session id for the other ssh_* tools.', '', 'Prefer `profileId`: a stored profile keeps its secret in the credential store, so the password never', 'appears in this call or in any transcript. Supply `host` (plus `user`/`auth`) only for a host that has', 'no profile yet; an inline connection is not saved.', '', 'A host key that is neither known nor trusted is refused with SSH_HOSTKEY_UNKNOWN / SSH_HOSTKEY_MISMATCH:', 'ask the user to verify the fingerprint in the SSH panel rather than retrying, because accepting a changed', 'key is a security decision, not a retry.'),
        parameters: parameterRoot({
            profileId: stringNode('Stored connection profile id (preferred: its secret stays in the credential store).'),
            name: stringNode('Display name for an inline connection.'),
            host: stringNode('Remote host name or address (inline connection).'),
            port: integerNode('Remote port (inline connection, default 22).'),
            user: stringNode('Remote user (inline connection).'),
            auth: stringNode('Authentication method for an inline connection.', { enum: ['password', 'privateKey', 'agent'] }),
            password: stringNode('Password for an inline connection. Prefer a stored profile or a credential reference.'),
            privateKeyPath: stringNode('Local path to the private key (inline connection, auth=privateKey).'),
            passphrase: stringNode('Passphrase for an encrypted private key (inline connection).'),
            viaEnv: booleanNode('Use the DSH_SSH_<SLUG>_PASSWORD / _PASSPHRASE environment override for this profile.'),
        }),
        output: { schema: ENVELOPE_SCHEMA, render: renderEnvelope, presentationMeta: sessionsPresentation },
        async execute(rawArgs) {
            const args = asRecord(rawArgs);
            const profileId = readString(args, 'profileId');
            const host = readString(args, 'host');
            const notes = [];
            if (profileId === undefined && host === undefined) {
                return toLossless({
                    ok: false,
                    code: 'SSH_CFG_INVALID',
                    message: 'provide profileId, or a host for an inline connection',
                    notes: profilesHint(deps),
                });
            }
            const inline = {};
            if (host !== undefined)
                inline['host'] = host;
            const port = readNumber(args, 'port');
            if (port !== undefined)
                inline['port'] = port;
            const user = readString(args, 'user');
            if (user !== undefined)
                inline['user'] = user;
            const auth = readString(args, 'auth');
            if (auth !== undefined)
                inline['auth'] = auth;
            const privateKeyPath = readString(args, 'privateKeyPath');
            if (privateKeyPath !== undefined)
                inline['secretRefs'] = { privateKeyPath };
            // The inline password/passphrase are passed as one-shot secrets, never as
            // profile fields: `normalizeProfile` would (correctly) refuse a plaintext
            // there, and a one-shot value is not persisted anywhere by construction.
            const secrets = {};
            const password = readString(args, 'password');
            if (password !== undefined)
                secrets.password = password;
            const passphrase = readString(args, 'passphrase');
            if (passphrase !== undefined)
                secrets.passphrase = passphrase;
            try {
                const result = await deps.connect({
                    ...(profileId === undefined ? {} : { profileId }),
                    ...(Object.keys(inline).length === 0 ? {} : { inline }),
                    ...(readString(args, 'name') === undefined ? {} : { name: readString(args, 'name') }),
                    ...(Object.keys(secrets).length === 0 ? {} : { secrets }),
                });
                const session = result.session;
                if (profileId !== undefined)
                    notes.push(`profile: ${profileId}`);
                notes.push(`host key policy: ${deps.hostKeyPolicy}`);
                return toLossless({
                    ok: true,
                    notes,
                    sessionId: session.id,
                    host: session.host,
                    port: session.port,
                    user: session.user,
                    state: session.state,
                    capabilities: { shell: session.capabilities.shell, sftp: session.capabilities.sftp },
                });
            }
            catch (error) {
                return toLossless(refusal(error, deps, notes));
            }
        },
    };
}
/** `ssh_disconnect`. */
export function sshDisconnectTool(deps) {
    return {
        name: 'ssh_disconnect',
        description: lines('Close one SSH session and release its connection.', '', 'Closing a session cancels its running commands and transfers; a partially transferred file keeps a', 'durable offset, so re-running the transfer resumes instead of restarting.'),
        parameters: parameterRoot({
            sessionId: stringNode('Session to close (from ssh_sessions).'),
            force: booleanNode('Destroy the connection immediately instead of closing gracefully.'),
        }),
        output: { schema: ENVELOPE_SCHEMA, render: renderEnvelope, presentationMeta: sessionsPresentation },
        async execute(rawArgs) {
            const args = asRecord(rawArgs);
            const sessionId = readString(args, 'sessionId');
            if (sessionId === undefined) {
                return toLossless({
                    ok: false,
                    code: 'SSH_CFG_INVALID',
                    message: 'sessionId is required',
                    notes: deps.listSessions().map((info) => `${info.id}: ${info.user}@${info.host}`),
                });
            }
            try {
                const force = args['force'] === true;
                const result = await deps.disconnect(sessionId, force);
                return toLossless({
                    ok: true,
                    notes: [`closed ${sessionId}${force ? ' (forced)' : ''}`],
                    sessionId,
                    host: result.session.host,
                    port: result.session.port,
                    user: result.session.user,
                    state: 'closed',
                });
            }
            catch (error) {
                return toLossless(refusal(error, deps));
            }
        },
    };
}
/** Factories keyed by tool name, so the plugin can honour `config.tools`. */
export function sessionsToolFactories(deps) {
    return {
        ssh_connect: () => sshConnectTool(deps),
        ssh_disconnect: () => sshDisconnectTool(deps),
        ssh_sessions: () => sshSessionsTool(deps),
    };
}
/** All three, in registration order. */
export function sessionTools(deps) {
    const factories = sessionsToolFactories(deps);
    return SESSIONS_TOOL_NAMES.map((name) => factories[name]());
}
/** The "which profile did you mean?" hint, without ever listing a secret. */
function profilesHint(deps) {
    const profiles = deps.listProfiles?.() ?? [];
    if (profiles.length === 0)
        return ['no stored profile exists yet; create one in the SSH panel, or pass host/user/auth'];
    return profiles.slice(0, 10).map((profile) => `${profile.id}: ${profile.name} (${profile.user}@${profile.host})`);
}
//# sourceMappingURL=sessions.js.map