/**
 * Agent-tool registration.
 *
 * The model-facing surface (`ssh_exec`, `ssh_upload`, `ssh_download`,
 * `ssh_list_dir`) is registered here rather than in the plugin shell, because it
 * needs the same object graph the endpoints use — the exec service, the session
 * registry, the SFTP client and the transfer manager.
 *
 * Registration is deliberately **best-effort**, for three separate reasons:
 *
 *   - a composition may not expose a tool registry at all (the plugin row must
 *     still load and still serve the UI);
 *   - `config.allowAgentTools` may be false (an operator who wants the GUI but not
 *     model access) — that is a decision, not a failure;
 *   - a factory listed in `config.tools` may not exist yet. Skipping it with a
 *     warning keeps the remaining tools available; throwing would take the whole
 *     plugin down over an unimplemented tool.
 *
 * Every skip is reported through `skipped`, so the shell can log a truthful
 * "registered 3 of 5 tools, here is why" line instead of a silent subset.
 */
import { SshError } from '../protocol.js';
import { SftpClient } from '../sftp/client.js';
import { sshExecTool } from '../tools/exec.js';
import { filesToolFactories } from '../tools/files.js';
import { sessionsToolFactories } from '../tools/sessions.js';
/** Find the tool registry without assuming the context shape. */
function toolRegistryOf(ctx) {
    try {
        const direct = ctx['tools'];
        if (isRegistry(direct))
            return direct;
        if (typeof ctx.get === 'function') {
            const viaGet = ctx.get('tools');
            if (isRegistry(viaGet))
                return viaGet;
        }
    }
    catch {
        /* opportunistic lookup: never fatal */
    }
    return undefined;
}
function isRegistry(value) {
    if (value === null || typeof value !== 'object')
        return false;
    return typeof value.register === 'function';
}
function disposeOf(value) {
    return typeof value === 'function' ? value : undefined;
}
/**
 * Build the SFTP facade for one session.
 *
 * `followSymlinks` comes from the configuration, never from the model: a tool call
 * must not be able to widen the transfer policy the operator chose.
 */
async function clientFor(options, sessionId, signal) {
    const session = options.pool.get(sessionId);
    if (session === undefined) {
        throw new SshError('SSH_STATE_INVALID', `no live session with id "${sessionId}"; call ssh_sessions first`);
    }
    const handle = await session.sftp(signal);
    return new SftpClient(handle, { followSymlinks: options.config.sftp.followSymlinks, logger: options.log });
}
export function registerAgentTools(options) {
    const { config, log, activity } = options;
    const skipped = [];
    const registered = [];
    const disposers = [];
    if (config.allowAgentTools !== true) {
        return {
            registered,
            skipped: config.tools.map((name) => ({ name, reason: 'allowAgentTools is false' })),
            dispose: () => { },
        };
    }
    const registry = toolRegistryOf(options.ctx);
    if (registry === undefined) {
        return {
            registered,
            skipped: config.tools.map((name) => ({ name, reason: 'this composition exposes no tools registry' })),
            dispose: () => { },
        };
    }
    const deps = {
        log,
        activity,
        defaults: config.sftp,
        getSession: (sessionId) => options.registry.get(sessionId),
        listDir: async ({ sessionId, path, showHidden, signal }) => {
            const client = await clientFor(options, sessionId, signal);
            return client.listDir(path, { showHidden: showHidden === true, ...(signal === undefined ? {} : { signal }) });
        },
        stat: async ({ sessionId, path, signal }) => {
            const client = await clientFor(options, sessionId, signal);
            return client.stat(path, signal);
        },
        // `run` (not `start`): a tool call wants a result, not a stream (see the
        // manager's header), and it rejects with the transfer's structured error.
        transfer: (request) => options.transfers.run({ ...request }),
    };
    const factories = {
        ...sessionsToolFactories({
            activity,
            listSessions: () => options.registry.list(),
            // The tool speaks the same flat `Params` object the wire does, with nested
            // structures JSON-encoded — so a tool call and a browser call exercise one
            // code path, including the `<field>Json` convention.
            //
            // The *field name* matters: `connect` takes `inline` (wire: `inlineJson`),
            // while `testProfile` takes `profile` (wire: `profileJson`). Sending the
            // wrong one is a silent no-op that surfaces as "connect needs a profileId or
            // an inline profile" — exactly the seam bug the first tool-driven acceptance
            // run found (regression-covered by `api-tools.test.mjs`).
            connect: (request) => options.api.sessions.connect({
                ...(request.profileId === undefined ? {} : { profileId: request.profileId }),
                ...(request.inline === undefined ? {} : { inlineJson: JSON.stringify(request.inline) }),
                ...(request.name === undefined ? {} : { name: request.name }),
                ...(request.secrets === undefined ? {} : { secretsJson: JSON.stringify(request.secrets) }),
            }),
            disconnect: (sessionId, force) => options.api.sessions.disconnect({ sessionId, force: force === true }),
            hostKeyPolicy: config.hostKey.policy,
            listProfiles: () => options.api.deps.store.list().map((profile) => ({ id: profile.id, name: profile.name, host: profile.host, user: profile.user })),
        }),
        ssh_exec: () => sshExecTool({
            exec: options.exec,
            activity,
            // The model-facing call is audited like any other operation. `onResult`
            // receives no credential by construction, and the auditor redacts the
            // command line anyway (an inline `-p …` password is masked there).
            onResult: (event) => options.audit.record({
                op: 'ssh_exec',
                outcome: event.outcome === 'success' ? 'ok' : event.outcome === 'refused' ? 'denied' : 'error',
                ...(typeof event.sessionId === 'string' ? { sessionId: event.sessionId } : {}),
                durationMs: event.durationMs,
                detail: {
                    source: 'tool',
                    command: event.command,
                    outcome: event.outcome,
                    exitCode: event.exitCode,
                    truncated: event.truncated,
                    streamId: event.streamId,
                },
            }),
        }),
        ...filesToolFactories(deps),
    };
    for (const name of config.tools) {
        const factory = factories[name];
        if (factory === undefined) {
            skipped.push({ name, reason: 'no implementation is registered for this tool name yet' });
            continue;
        }
        try {
            const registeredTool = registry.register(factory());
            const dispose = disposeOf(registeredTool);
            if (dispose !== undefined)
                disposers.push(dispose);
            registered.push(name);
        }
        catch (error) {
            // A single bad tool must not remove the others, and must not fail activation.
            skipped.push({ name, reason: `registration failed: ${error instanceof Error ? error.message : String(error)}` });
        }
    }
    return {
        registered,
        skipped,
        dispose: () => {
            for (const dispose of disposers.splice(0)) {
                try {
                    dispose();
                }
                catch (error) {
                    log.warn('failed to unregister an agent tool', { reason: error instanceof Error ? error.message : String(error) });
                }
            }
        },
    };
}
//# sourceMappingURL=tools.js.map