/**
 * @local/dsh-ssh — SSH connectivity, command execution and file transfer for DSH,
 * with a right-sidebar session workspace.
 *
 *     name       'dsh-ssh'      (must equal the cordis.patch.yml row id and
 *                                dsh.plugin.json's id — asserted by test/unit/identity.test.mjs)
 *     inject     ['tools']      the only required service
 *     Config     Schemastery schema; the Loader validates the row's config with it
 *     apply      builds the host runtime and owns every resource through ctx.effect
 *
 * This file is deliberately only a *shell*: it names the plugin, validates its
 * config, and hands the object graph to `createHostRuntime`, which owns who is
 * constructed with what. Keeping the graph on the other side of one function is
 * what lets the endpoints, the connection pool and the security modules evolve
 * without this file turning into a second composition root.
 *
 * Activation is non-fatal by design: a missing optional service or an unwritable
 * store must produce a plugin that *reports* the problem through structured error
 * codes, because a row that fails to load tells the user nothing actionable.
 *
 * Measured reload behaviour (M4): the live host re-imports this module when the
 * emitted bytes under `lib/` change (HMR watches content, not mtime), which is why
 * `apply()` leaves its diagnostics on disk — the host's own logger is not readable
 * from a file, so an on-disk marker is the only way to tell "apply never ran" from
 * "apply ran and the runtime failed to compose".
 *
 * HMR only watches module roots that are explicitly opted in (the shipped `hmr` row
 * defaults to `root: []`), so this package adds its own directory to that row in the
 * live profile patch; without it a rebuilt host half stays invisible until restart.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol';
import { createHostRuntime } from './api/runtime.js';
import { Config, resolveConfig, resolveDshHome } from './config.js';
import { SERVICE_KEY } from './protocol.js';
import { PLUGIN_VERSION } from './service.js';
export const name = 'dsh-ssh';
/** The tool registry is the only hard dependency; everything else is opportunistic. */
export const inject = ['tools'];
export { Config };
export * from './protocol.js';
// M0 diagnostic (removed in M2): a module-scope marker distinguishes "this file was
// imported again" from "the plugin's fiber re-ran apply()". Best-effort, and it must
// never be able to break the import.
//
// `argv`/`ppid` are recorded deliberately: a marker alone cannot tell whether the
// *live host* imported this module or a short-lived child process did (a test run, a
// config dump). That distinction is what decides whether a missing service means
// "apply() failed" or "apply() was never called", so the importing process's
// identity belongs in the evidence.
try {
    const moduleDir = join(resolveDshHome(), 'logs', 'dsh-ssh');
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(join(moduleDir, 'module-eval.json'), `${JSON.stringify({
        at: new Date().toISOString(),
        pid: process.pid,
        ppid: process.ppid,
        argv: process.argv.slice(0, 4),
        execArgv: process.execArgv,
        node: process.version,
    }, null, 2)}\n`, 'utf8');
}
catch {
    /* ignore */
}
/**
 * Publish one value as a Cordis service and return its disposer.
 *
 * `ctx.provide()` is the reflect-layer API; older trees expose `ctx.set()`.
 * Both are probed rather than assumed so the plugin loads on either.
 */
function registerService(ctx, key, value) {
    const target = ctx;
    if (typeof target.provide === 'function') {
        const dispose = target.provide(key, value);
        return typeof dispose === 'function' ? dispose : () => { };
    }
    if (typeof target.set === 'function') {
        target.set(key, value);
        return () => { };
    }
    throw new Error(`dsh-ssh: this Context exposes neither provide() nor set(); cannot register "${key}"`);
}
/** Last-resort logger for failures that happen before the runtime exists. */
function fallbackLogger(ctx) {
    try {
        const candidate = ctx.logger;
        if (typeof candidate === 'function') {
            const named = candidate.call(ctx, name);
            if (named !== null && typeof named === 'object' && typeof named.info === 'function') {
                return named;
            }
        }
        if (candidate !== null && typeof candidate === 'object' && typeof candidate.info === 'function') {
            return candidate;
        }
    }
    catch {
        /* a logger must never be the reason a plugin fails to load */
    }
    return console;
}
/**
 * M0 diagnostic breadcrumb (removed in M2).
 *
 * Records which Remote methods the live service instance actually declares, so
 * "the browser cannot reach endpoint X" can be told apart from "the host never
 * registered X" without guessing. Written separately from the runtime's own
 * startup so a failure here can never affect activation.
 */
function recordHostReady(service, auditFile, log) {
    let methods = [];
    let probeError = null;
    try {
        methods = remoteMethods(service).map((marker) => marker.method);
    }
    catch (error) {
        probeError = error instanceof Error ? error.message : String(error);
    }
    try {
        const markerDir = dirname(auditFile);
        mkdirSync(markerDir, { recursive: true });
        writeFileSync(join(markerDir, 'host-ready.json'), `${JSON.stringify({
            at: new Date().toISOString(),
            pluginVersion: PLUGIN_VERSION,
            node: process.version,
            pid: process.pid,
            remoteMethods: methods,
            probeError,
        }, null, 2)}\n`, 'utf8');
    }
    catch {
        /* a diagnostic must never be the reason a plugin fails to load */
    }
    if (probeError !== null)
        log.warn(`dsh-ssh: could not read Remote markers: ${probeError}`);
}
/**
 * Write a diagnostic next to the other markers, never throwing.
 *
 * The live host's own logger is not readable from disk, so a composition failure
 * that only went to `ctx.logger.error` left *no* trace: the row stayed active, no
 * service appeared, and there was nothing to debug with. Reading the failure back
 * is worth one small file.
 */
function writeMarker(auditFile, name, payload) {
    try {
        const markerDir = dirname(auditFile);
        mkdirSync(markerDir, { recursive: true });
        writeFileSync(join(markerDir, name), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    }
    catch {
        /* a diagnostic must never be the reason a plugin fails to load */
    }
}
export async function apply(ctx, config) {
    const resolved = resolveConfig(config);
    const bootstrapLog = fallbackLogger(ctx);
    // Records that apply() started at all — the difference between "apply never ran"
    // and "apply ran and failed" is otherwise unobservable from outside the host.
    writeMarker(resolved.auditFile, 'apply-start.json', {
        at: new Date().toISOString(),
        pid: process.pid,
        node: process.version,
        pluginVersion: PLUGIN_VERSION,
    });
    let runtime;
    try {
        runtime = await createHostRuntime({ ctx, config: resolved });
    }
    catch (error) {
        // Non-fatal by contract: report with the facts needed to act, and leave the
        // row loaded so the failure is visible in the plugin list rather than absent.
        const message = error instanceof Error ? error.message : String(error);
        bootstrapLog.error(`dsh-ssh ${PLUGIN_VERSION} failed to compose its host runtime: ${message}`);
        writeMarker(resolved.auditFile, 'host-error.json', {
            at: new Date().toISOString(),
            pid: process.pid,
            pluginVersion: PLUGIN_VERSION,
            phase: 'createHostRuntime',
            message,
            stack: error instanceof Error ? (error.stack ?? null) : null,
        });
        return;
    }
    const { service, log } = runtime;
    try {
        ctx.effect(() => registerService(ctx, SERVICE_KEY, service), 'dsh-ssh: service face');
        ctx.effect(() => () => {
            // Teardown is best-effort: an unload must not throw because, for example, a
            // connection was already gone.
            void runtime.dispose().catch((error) => {
                log.warn(`dsh-ssh: dispose failed: ${error instanceof Error ? error.message : String(error)}`);
            });
        }, 'dsh-ssh: runtime teardown');
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error(`dsh-ssh: failed to publish the service face: ${message}`);
        writeMarker(resolved.auditFile, 'host-error.json', {
            at: new Date().toISOString(),
            pid: process.pid,
            pluginVersion: PLUGIN_VERSION,
            phase: 'registerService',
            message,
            stack: error instanceof Error ? (error.stack ?? null) : null,
        });
        return;
    }
    recordHostReady(service, resolved.auditFile, log);
    log.info(`dsh-ssh ${PLUGIN_VERSION} ready (service "${SERVICE_KEY}", maxSessions=${resolved.maxSessions}, ` +
        `hostKey=${resolved.hostKey.policy}, profiles="${resolved.profilesFile}")`);
}
//# sourceMappingURL=index.js.map