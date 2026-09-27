/**
 * The plugin's Host service face: a Typert Remote Service bound to the
 * `sshPlugin` namespace.
 *
 * The class deliberately *does not* extend `TypertRemoteService`: that base
 * class extends the Cordis `Service` class from whichever copy of
 * `@deepseek-ai/cordis` this package installed, while the host tree runs the
 * composition's own copy. `bindTypertRemote()` is the documented alternative
 * ("declares a `typertRemote` binding"), carries no class identity across the
 * boundary, and is what the Gateway's source-mode discovery reads.
 */
var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { bindTypertRemote, Remote } from '@deepseek-ai/dsh-typert-protocol';
import { toPublicConfig } from './config.js';
import { encodeResult, readParams } from './api/params.js';
import { SshError, PROTOCOL_VERSION, REMOTE_NAMESPACE, SERVICE_KEY, isRetryable, toErrorInfo, } from './protocol.js';
/** Plugin version, duplicated from package.json at build time. */
export const PLUGIN_VERSION = '0.2.0';
const MAX_PROBE_FRAMES = 200;
/**
 * Rebuild any thrown value as an error whose `ErrorInfo` fields are **own
 * enumerable properties**.
 *
 * `SshError` already carries `code`/`details`, but `retryable` is a prototype
 * getter — so a carrier that serialises an error by copying its own keys (which
 * the source-mode Remote path effectively does) would deliver `{ message }` and
 * lose the code the UI branches on. Defining an own property shadows the getter
 * without touching the class.
 */
function asWireError(error, raw, probe, config, log) {
    const info = toErrorInfo(error);
    const wrapped = error instanceof Error ? error : new Error(info.message);
    try {
        Object.defineProperty(wrapped, 'code', { value: info.code, enumerable: true, configurable: true });
        Object.defineProperty(wrapped, 'retryable', { value: isRetryable(info.code), enumerable: true, configurable: true });
        if (info.details !== undefined)
            Object.defineProperty(wrapped, 'details', { value: info.details, enumerable: true, configurable: true });
        if (info.retryAfterMs !== undefined) {
            Object.defineProperty(wrapped, 'retryAfterMs', { value: info.retryAfterMs, enumerable: true, configurable: true });
        }
    }
    catch {
        /* a frozen error object still carries its message */
    }
    if (probe) {
        // M0.5: record the *failure* path too, because "the call arrived but its
        // parameters did not" looks exactly like this from the host side.
        try {
            const file = join(dirname(config.auditFile), 'wire-probe.jsonl');
            mkdirSync(dirname(file), { recursive: true });
            appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), method: 'error', rawType: typeof raw, code: info.code, message: info.message })}\n`, 'utf8');
        }
        catch {
            /* diagnostics never fail a call */
        }
    }
    log.debug(`endpoint failed with ${info.code}: ${info.message}`);
    return wrapped;
}
/**
 * Host-side implementation of the SSH plugin.
 *
 * The M0 slice answers the transport spike (`ping` unary + `probeStream`
 * stream). Session, exec, SFTP and audit methods land on this same class in
 * M1-M3; the frozen signatures live in `docs/ICD.md` section 4 and are delegated
 * to the modules under `src/connection`, `src/exec`, `src/sftp` and `src/audit`.
 */
let SshPluginService = (() => {
    let _instanceExtraInitializers = [];
    let _getConfig_decorators;
    let _listProfiles_decorators;
    let _saveProfile_decorators;
    let _deleteProfile_decorators;
    let _duplicateProfile_decorators;
    let _testProfile_decorators;
    let _setSecret_decorators;
    let _clearSecret_decorators;
    let _connect_decorators;
    let _disconnect_decorators;
    let _listSessions_decorators;
    let _getSession_decorators;
    let _pendingHostKey_decorators;
    let _decideHostKey_decorators;
    let _followSessions_decorators;
    let _exec_decorators;
    let _execWait_decorators;
    let _openShell_decorators;
    let _shellWrite_decorators;
    let _shellResize_decorators;
    let _shellSignal_decorators;
    let _shellClose_decorators;
    let _listStreams_decorators;
    let _listDir_decorators;
    let _stat_decorators;
    let _mkdir_decorators;
    let _rename_decorators;
    let _removePath_decorators;
    let _chmod_decorators;
    let _upload_decorators;
    let _download_decorators;
    let _cancelTransfer_decorators;
    let _listTransfers_decorators;
    let _listLocalDir_decorators;
    let _statLocal_decorators;
    let _queryAudit_decorators;
    let _followAudit_decorators;
    let _clearAudit_decorators;
    let _followActivity_decorators;
    let _clearActivity_decorators;
    let _ping_decorators;
    let _probeStream_decorators;
    let _describe_decorators;
    let _reportSpike_decorators;
    return class SshPluginService {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            _getConfig_decorators = [Remote];
            _listProfiles_decorators = [Remote];
            _saveProfile_decorators = [Remote];
            _deleteProfile_decorators = [Remote];
            _duplicateProfile_decorators = [Remote];
            _testProfile_decorators = [Remote];
            _setSecret_decorators = [Remote];
            _clearSecret_decorators = [Remote];
            _connect_decorators = [Remote];
            _disconnect_decorators = [Remote];
            _listSessions_decorators = [Remote];
            _getSession_decorators = [Remote];
            _pendingHostKey_decorators = [Remote];
            _decideHostKey_decorators = [Remote];
            _followSessions_decorators = [Remote({ mode: 'stream' })];
            _exec_decorators = [Remote({ mode: 'stream' })];
            _execWait_decorators = [Remote];
            _openShell_decorators = [Remote({ mode: 'stream' })];
            _shellWrite_decorators = [Remote];
            _shellResize_decorators = [Remote];
            _shellSignal_decorators = [Remote];
            _shellClose_decorators = [Remote];
            _listStreams_decorators = [Remote];
            _listDir_decorators = [Remote];
            _stat_decorators = [Remote];
            _mkdir_decorators = [Remote];
            _rename_decorators = [Remote];
            _removePath_decorators = [Remote];
            _chmod_decorators = [Remote];
            _upload_decorators = [Remote({ mode: 'stream' })];
            _download_decorators = [Remote({ mode: 'stream' })];
            _cancelTransfer_decorators = [Remote];
            _listTransfers_decorators = [Remote];
            _listLocalDir_decorators = [Remote];
            _statLocal_decorators = [Remote];
            _queryAudit_decorators = [Remote];
            _followAudit_decorators = [Remote({ mode: 'stream' })];
            _clearAudit_decorators = [Remote];
            _followActivity_decorators = [Remote({ mode: 'stream' })];
            _clearActivity_decorators = [Remote];
            _ping_decorators = [Remote];
            _probeStream_decorators = [Remote({ mode: 'stream' })];
            _describe_decorators = [Remote];
            _reportSpike_decorators = [Remote];
            __esDecorate(this, null, _getConfig_decorators, { kind: "method", name: "getConfig", static: false, private: false, access: { has: obj => "getConfig" in obj, get: obj => obj.getConfig }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _listProfiles_decorators, { kind: "method", name: "listProfiles", static: false, private: false, access: { has: obj => "listProfiles" in obj, get: obj => obj.listProfiles }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _saveProfile_decorators, { kind: "method", name: "saveProfile", static: false, private: false, access: { has: obj => "saveProfile" in obj, get: obj => obj.saveProfile }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _deleteProfile_decorators, { kind: "method", name: "deleteProfile", static: false, private: false, access: { has: obj => "deleteProfile" in obj, get: obj => obj.deleteProfile }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _duplicateProfile_decorators, { kind: "method", name: "duplicateProfile", static: false, private: false, access: { has: obj => "duplicateProfile" in obj, get: obj => obj.duplicateProfile }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _testProfile_decorators, { kind: "method", name: "testProfile", static: false, private: false, access: { has: obj => "testProfile" in obj, get: obj => obj.testProfile }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _setSecret_decorators, { kind: "method", name: "setSecret", static: false, private: false, access: { has: obj => "setSecret" in obj, get: obj => obj.setSecret }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _clearSecret_decorators, { kind: "method", name: "clearSecret", static: false, private: false, access: { has: obj => "clearSecret" in obj, get: obj => obj.clearSecret }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _connect_decorators, { kind: "method", name: "connect", static: false, private: false, access: { has: obj => "connect" in obj, get: obj => obj.connect }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _disconnect_decorators, { kind: "method", name: "disconnect", static: false, private: false, access: { has: obj => "disconnect" in obj, get: obj => obj.disconnect }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _listSessions_decorators, { kind: "method", name: "listSessions", static: false, private: false, access: { has: obj => "listSessions" in obj, get: obj => obj.listSessions }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getSession_decorators, { kind: "method", name: "getSession", static: false, private: false, access: { has: obj => "getSession" in obj, get: obj => obj.getSession }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _pendingHostKey_decorators, { kind: "method", name: "pendingHostKey", static: false, private: false, access: { has: obj => "pendingHostKey" in obj, get: obj => obj.pendingHostKey }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _decideHostKey_decorators, { kind: "method", name: "decideHostKey", static: false, private: false, access: { has: obj => "decideHostKey" in obj, get: obj => obj.decideHostKey }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _followSessions_decorators, { kind: "method", name: "followSessions", static: false, private: false, access: { has: obj => "followSessions" in obj, get: obj => obj.followSessions }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _exec_decorators, { kind: "method", name: "exec", static: false, private: false, access: { has: obj => "exec" in obj, get: obj => obj.exec }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _execWait_decorators, { kind: "method", name: "execWait", static: false, private: false, access: { has: obj => "execWait" in obj, get: obj => obj.execWait }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _openShell_decorators, { kind: "method", name: "openShell", static: false, private: false, access: { has: obj => "openShell" in obj, get: obj => obj.openShell }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _shellWrite_decorators, { kind: "method", name: "shellWrite", static: false, private: false, access: { has: obj => "shellWrite" in obj, get: obj => obj.shellWrite }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _shellResize_decorators, { kind: "method", name: "shellResize", static: false, private: false, access: { has: obj => "shellResize" in obj, get: obj => obj.shellResize }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _shellSignal_decorators, { kind: "method", name: "shellSignal", static: false, private: false, access: { has: obj => "shellSignal" in obj, get: obj => obj.shellSignal }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _shellClose_decorators, { kind: "method", name: "shellClose", static: false, private: false, access: { has: obj => "shellClose" in obj, get: obj => obj.shellClose }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _listStreams_decorators, { kind: "method", name: "listStreams", static: false, private: false, access: { has: obj => "listStreams" in obj, get: obj => obj.listStreams }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _listDir_decorators, { kind: "method", name: "listDir", static: false, private: false, access: { has: obj => "listDir" in obj, get: obj => obj.listDir }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _stat_decorators, { kind: "method", name: "stat", static: false, private: false, access: { has: obj => "stat" in obj, get: obj => obj.stat }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _mkdir_decorators, { kind: "method", name: "mkdir", static: false, private: false, access: { has: obj => "mkdir" in obj, get: obj => obj.mkdir }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _rename_decorators, { kind: "method", name: "rename", static: false, private: false, access: { has: obj => "rename" in obj, get: obj => obj.rename }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _removePath_decorators, { kind: "method", name: "removePath", static: false, private: false, access: { has: obj => "removePath" in obj, get: obj => obj.removePath }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _chmod_decorators, { kind: "method", name: "chmod", static: false, private: false, access: { has: obj => "chmod" in obj, get: obj => obj.chmod }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _upload_decorators, { kind: "method", name: "upload", static: false, private: false, access: { has: obj => "upload" in obj, get: obj => obj.upload }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _download_decorators, { kind: "method", name: "download", static: false, private: false, access: { has: obj => "download" in obj, get: obj => obj.download }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _cancelTransfer_decorators, { kind: "method", name: "cancelTransfer", static: false, private: false, access: { has: obj => "cancelTransfer" in obj, get: obj => obj.cancelTransfer }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _listTransfers_decorators, { kind: "method", name: "listTransfers", static: false, private: false, access: { has: obj => "listTransfers" in obj, get: obj => obj.listTransfers }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _listLocalDir_decorators, { kind: "method", name: "listLocalDir", static: false, private: false, access: { has: obj => "listLocalDir" in obj, get: obj => obj.listLocalDir }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _statLocal_decorators, { kind: "method", name: "statLocal", static: false, private: false, access: { has: obj => "statLocal" in obj, get: obj => obj.statLocal }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _queryAudit_decorators, { kind: "method", name: "queryAudit", static: false, private: false, access: { has: obj => "queryAudit" in obj, get: obj => obj.queryAudit }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _followAudit_decorators, { kind: "method", name: "followAudit", static: false, private: false, access: { has: obj => "followAudit" in obj, get: obj => obj.followAudit }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _clearAudit_decorators, { kind: "method", name: "clearAudit", static: false, private: false, access: { has: obj => "clearAudit" in obj, get: obj => obj.clearAudit }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _followActivity_decorators, { kind: "method", name: "followActivity", static: false, private: false, access: { has: obj => "followActivity" in obj, get: obj => obj.followActivity }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _clearActivity_decorators, { kind: "method", name: "clearActivity", static: false, private: false, access: { has: obj => "clearActivity" in obj, get: obj => obj.clearActivity }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _ping_decorators, { kind: "method", name: "ping", static: false, private: false, access: { has: obj => "ping" in obj, get: obj => obj.ping }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _probeStream_decorators, { kind: "method", name: "probeStream", static: false, private: false, access: { has: obj => "probeStream" in obj, get: obj => obj.probeStream }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _describe_decorators, { kind: "method", name: "describe", static: false, private: false, access: { has: obj => "describe" in obj, get: obj => obj.describe }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _reportSpike_decorators, { kind: "method", name: "reportSpike", static: false, private: false, access: { has: obj => "reportSpike" in obj, get: obj => obj.reportSpike }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        /** Required by `bindTypertRemote` (it reads the owning Context off the service). */
        ctx = __runInitializers(this, _instanceExtraInitializers);
        config;
        log;
        /** Visible binding consumed by the Gateway's source-mode discovery. */
        typertRemote;
        /** M0.5 wire measurement switch; see `SshPluginServiceOptions.probeWire`. */
        probeWire;
        /** Endpoint implementations; `undefined` in the M0-only configuration. */
        api;
        constructor(ctx, config, log, options = {}) {
            this.ctx = ctx;
            this.config = config;
            this.log = log;
            this.probeWire = options.probeWire === true;
            this.api = options.api;
            this.typertRemote = bindTypertRemote(this, SERVICE_KEY, { namespace: REMOTE_NAMESPACE });
        }
        /**
         * ICD §4.1 `getConfig`: the public projection of the effective configuration.
         *
         * Falls back to projecting `this.config` when no runtime is attached, so the
         * answer is identical in both configurations (and never contains a credential).
         */
        async getConfig() {
            if (this.api === undefined)
                return toPublicConfig(this.config);
            return this.api.getConfig();
        }
        // =========================================================================
        // §4.2 Connection profiles
        // =========================================================================
        /** ICD §4.2 `listProfiles`. */
        async listProfiles(raw) {
            return this.wire(() => this.apiOf().profiles.list(), raw);
        }
        /** ICD §4.2 `saveProfile`. */
        async saveProfile(raw) {
            return this.wire(() => this.apiOf().profiles.save(readParams(raw).params), raw);
        }
        /** ICD §4.2 `deleteProfile`. */
        async deleteProfile(raw) {
            return this.wire(() => this.apiOf().profiles.remove(readParams(raw).params), raw);
        }
        /** ICD §4.2 `duplicateProfile`. */
        async duplicateProfile(raw) {
            return this.wire(() => this.apiOf().profiles.duplicate(readParams(raw).params), raw);
        }
        /** ICD §4.2 `testProfile`. */
        async testProfile(raw) {
            return this.wire(() => this.apiOf().profiles.test(readParams(raw).params), raw);
        }
        /**
         * ICD §4.2 `setSecret`.
         *
         * The answer is a superset of the frozen `{ ref, masked }`: `persisted:false`
         * means the value is good for this process only (the launching environment
         * already supplies that reference, and such a value is read-only for the run).
         * That is a documented degradation, not a failure — the UI should say so.
         */
        async setSecret(raw) {
            return this.wire(() => this.apiOf().profiles.setSecret(readParams(raw).params), raw);
        }
        /** ICD §4.2 `clearSecret`. */
        async clearSecret(raw) {
            return this.wire(() => this.apiOf().profiles.clearSecret(readParams(raw).params), raw);
        }
        // =========================================================================
        // §4.3 Sessions
        // =========================================================================
        /** ICD §4.3 `connect`. */
        async connect(raw) {
            return this.wire(() => this.apiOf().sessions.connect(readParams(raw).params), raw);
        }
        /** ICD §4.3 `disconnect`. */
        async disconnect(raw) {
            return this.wire(() => this.apiOf().sessions.disconnect(readParams(raw).params), raw);
        }
        /** ICD §4.3 `listSessions`. */
        async listSessions() {
            return this.wire(() => this.apiOf().sessions.listSessions());
        }
        /** ICD §4.3 `getSession`. */
        async getSession(raw) {
            return this.wire(() => this.apiOf().sessions.getSession(readParams(raw).params), raw);
        }
        /** ICD §4.3 `pendingHostKey`. */
        async pendingHostKey(raw) {
            return this.wire(() => this.apiOf().sessions.pendingHostKey(readParams(raw).params), raw);
        }
        /** ICD §4.3 `decideHostKey`. */
        async decideHostKey(raw) {
            return this.wire(() => this.apiOf().sessions.decideHostKey(readParams(raw).params), raw);
        }
        /** ICD §4.3 `followSessions` (stream of `state` frames). */
        async *followSessions(_raw) {
            yield* this.apiOf().sessions.follow();
        }
        // =========================================================================
        // §4.4 Commands and shells
        // =========================================================================
        /** ICD §4.4 `exec` (stream). */
        async *exec(raw) {
            yield* this.apiOf().exec.exec(raw);
        }
        /** ICD §4.4 `execWait`. */
        async execWait(raw) {
            return this.wire(() => this.apiOf().exec.execWait(raw), raw);
        }
        /** ICD §4.4 `openShell` (stream). */
        async *openShell(raw) {
            yield* this.apiOf().exec.openShell(raw);
        }
        /** ICD §4.4 `shellWrite`. */
        async shellWrite(raw) {
            return this.wire(() => this.apiOf().exec.shellWrite(raw), raw);
        }
        /** ICD §4.4 `shellResize`. */
        async shellResize(raw) {
            return this.wire(() => this.apiOf().exec.shellResize(raw), raw);
        }
        /** ICD §4.4 `shellSignal`. */
        async shellSignal(raw) {
            return this.wire(() => this.apiOf().exec.shellSignal(raw), raw);
        }
        /** ICD §4.4 `shellClose`. */
        async shellClose(raw) {
            return this.wire(() => this.apiOf().exec.shellClose(raw), raw);
        }
        /** ICD §4.4 `listStreams`. */
        async listStreams(raw) {
            return this.wire(() => this.apiOf().exec.listStreams(raw), raw);
        }
        // =========================================================================
        // §4.5 SFTP
        // =========================================================================
        /** ICD §4.5 `listDir`. */
        async listDir(raw) {
            return this.wire(() => this.apiOf().files.listDir(raw), raw);
        }
        /** ICD §4.5 `stat`. */
        async stat(raw) {
            return this.wire(() => this.apiOf().files.stat(raw), raw);
        }
        /** ICD §4.5 `mkdir`. */
        async mkdir(raw) {
            return this.wire(() => this.apiOf().files.mkdir(raw), raw);
        }
        /** ICD §4.5 `rename`. */
        async rename(raw) {
            return this.wire(() => this.apiOf().files.rename(raw), raw);
        }
        /**
         * ICD §4.5 `removePath`.
         *
         * Named `removePath`, not `remove`: the Gateway installs each Remote method **onto a
         * namespace service object**, and `RemoteNamespaceService` already owns a
         * `remove(kind, method, token)` used to withdraw installed methods. A remote method
         * called `remove` is refused at mount time with
         * `client api: method "sshPlugin/remove" conflicts with its namespace service`,
         * which took the whole client→host channel down. See `client/src/bridge.js` for the
         * full reserved-name list.
         */
        async removePath(raw) {
            return this.wire(() => this.apiOf().files.remove(raw), raw);
        }
        /** ICD §4.5 `chmod`. */
        async chmod(raw) {
            return this.wire(() => this.apiOf().files.chmod(raw), raw);
        }
        /** ICD §4.5 `upload` (stream; the handshake rides in `open.meta`). */
        async *upload(raw) {
            yield* this.apiOf().files.upload(raw);
        }
        /** ICD §4.5 `download` (stream; the handshake rides in `open.meta`). */
        async *download(raw) {
            yield* this.apiOf().files.download(raw);
        }
        /** ICD §4.5 `cancelTransfer`. */
        async cancelTransfer(raw) {
            return this.wire(() => this.apiOf().files.cancelTransfer(raw), raw);
        }
        /** ICD §4.5 `listTransfers`. */
        async listTransfers() {
            return this.wire(() => this.apiOf().files.listTransfers());
        }
        /** Dual-pane local half: list a local directory. */
        async listLocalDir(raw) {
            return this.wire(() => this.apiOf().files.listLocalDir(raw), raw);
        }
        /** Dual-pane local half: stat a local path. */
        async statLocal(raw) {
            return this.wire(() => this.apiOf().files.statLocal(raw), raw);
        }
        // =========================================================================
        // §4.6 Audit
        // =========================================================================
        /** ICD §4.6 `queryAudit`. */
        async queryAudit(raw) {
            return this.wire(() => this.apiOf().audit.query(raw), raw);
        }
        /** ICD §4.6 `followAudit` (stream of `audit` frames). */
        async *followAudit(raw) {
            yield* this.apiOf().audit.follow(raw);
        }
        /** ICD §4.6 `clearAudit`. */
        async clearAudit() {
            return this.wire(() => this.apiOf().audit.clear());
        }
        // =========================================================================
        // §4.7 Agent activity
        // =========================================================================
        /**
         * ICD §4.7 `followActivity` (stream).
         *
         * No parameter object: the mirror is global by design (see `ActivityApi`), so
         * there is nothing for the client to narrow and nothing the host could refuse.
         */
        async *followActivity(raw) {
            return yield* this.apiOf().activity.follow();
        }
        /** ICD §4.7 `clearActivity`. */
        async clearActivity() {
            return this.wire(() => this.apiOf().activity.clear());
        }
        // =========================================================================
        // Endpoint plumbing
        // =========================================================================
        /**
         * The runtime, or an honest error when the service was built without one.
         *
         * A thrown `SshError` reaches the client as a structured `ErrorInfo`; silently
         * returning `{}` would look like an empty result and send the UI down a wrong
         * path ("no profiles" instead of "this endpoint is not wired").
         */
        apiOf() {
            if (this.api === undefined) {
                throw new SshError('SSH_STATE_INVALID', 'this endpoint is not available: the plugin runtime was not attached');
            }
            return this.api;
        }
        /**
         * Run one endpoint body and normalise its failure.
         *
         * The result is passed through `encodeResult` (JSON-safe by construction: no
         * `undefined`, Buffers as `{ $bytes }`, Dates as ISO strings), and a thrown
         * error is rebuilt so `code`, `retryable`, `details` and `retryAfterMs` are all
         * **own enumerable properties** — a carrier that serialises an error by copying
         * its own keys then still delivers the frozen `ErrorInfo` shape instead of a
         * bare message.
         */
        async wire(run, raw) {
            try {
                const value = await run();
                return encodeResult(value);
            }
            catch (error) {
                throw asWireError(error, raw, this.probeWire, this.config, this.log);
            }
        }
        /**
         * Transport probe: the smallest possible round trip. The browser half renders
         * the answer verbatim, so this is also the spike's user-visible evidence.
         */
        async ping(params) {
            // M0.5 wire measurement. `ping` is called by the client on every apply (it is
            // how the bridge verifies a carrier), which makes it the one probe that needs
            // no cooperation from the UI: whatever a *simple* one-key object does on this
            // wire is recorded here, next to the richer reportSpike payload.
            this.recordWireProbe('ping', arguments);
            const started = Date.now();
            const result = {
                pong: true,
                version: PROTOCOL_VERSION,
                namespace: REMOTE_NAMESPACE,
                node: process.version,
                pluginVersion: PLUGIN_VERSION,
                at: new Date().toISOString(),
                handlerMs: 0,
            };
            if (typeof params?.echo === 'string')
                result.echo = params.echo;
            return { ...result, handlerMs: Date.now() - started };
        }
        /**
         * Append one line describing exactly how the carrier delivered a call.
         *
         * M0.5 only: the delivery shape (argument count, per-argument type and raw
         * JSON) is what decides the project-wide parameter convention, and it cannot be
         * inferred from a value that has already been parsed. Best-effort by
         * construction - a diagnostic must never fail a call.
         */
        recordWireProbe(method, args) {
            if (!this.probeWire)
                return;
            try {
                const file = join(dirname(this.config.auditFile), 'wire-probe.jsonl');
                mkdirSync(dirname(file), { recursive: true });
                const values = Array.from(args);
                const line = JSON.stringify({
                    at: new Date().toISOString(),
                    method,
                    argCount: values.length,
                    args: values.map((value) => {
                        let raw = null;
                        try {
                            raw = JSON.stringify(value)?.slice(0, 500) ?? null;
                        }
                        catch {
                            raw = '<unserialisable>';
                        }
                        return { type: typeof value, isNull: value === null || value === undefined, raw };
                    }),
                });
                writeFileSync(file, `${line}\n`, { encoding: 'utf8', flag: 'a' });
            }
            catch {
                /* diagnostics never fail a call */
            }
        }
        /**
         * Stream probe: proves the downlink path, frame ordering and terminal `end`.
         * Emits `open`, `count` data frames, then either `end: completed` or an error
         * pair, so the client can be exercised against both outcomes.
         */
        async *probeStream(params) {
            const count = Math.max(1, Math.min(MAX_PROBE_FRAMES, Math.trunc(params?.count ?? 5)));
            const intervalMs = Math.max(0, Math.min(2000, Math.trunc(params?.intervalMs ?? 250)));
            const streamId = `st_probe_${Date.now().toString(36)}`;
            const fail = params?.fail === true;
            yield { t: 'open', streamId, kind: 'exec', meta: { probe: true, count, intervalMs } };
            for (let seq = 0; seq < count; seq++) {
                if (intervalMs > 0)
                    await new Promise((resolve) => setTimeout(resolve, intervalMs));
                yield {
                    t: 'data',
                    streamId,
                    seq,
                    chunk: `frame ${seq + 1}/${count} @ ${new Date().toISOString()}\n`,
                    encoding: 'utf8',
                    channel: 'stdout',
                };
            }
            if (fail) {
                yield {
                    t: 'end',
                    streamId,
                    reason: 'error',
                    error: { code: 'SSH_UNKNOWN', message: 'probe requested a failing stream', retryable: false },
                };
                return;
            }
            yield { t: 'end', streamId, reason: 'completed' };
        }
        /** Snapshot consumed by the UI's status header; no secrets are included. */
        async describe() {
            const { profilesFile, auditFile, knownHostsFile, maxSessions, hostKey, sftp, ui, secrets } = this.config;
            return {
                namespace: REMOTE_NAMESPACE,
                version: PLUGIN_VERSION,
                config: {
                    profilesFile,
                    auditFile,
                    knownHostsFile,
                    maxSessions,
                    hostKeyPolicy: hostKey.policy,
                    chunkBytes: sftp.chunkBytes,
                    resume: sftp.resume,
                    verify: sftp.verify,
                    secretsProvider: secrets.provider,
                    ui,
                },
            };
        }
        /**
         * Record which client-to-host carrier the browser resolved, next to the
         * plugin's own diagnostic files.
         *
         * This exists because the binding is chosen inside the page: when a user
         * reports "the panel is empty", the first question is which carrier their
         * browser picked, and this answer survives the page that produced it. It is
         * called once per client run and is safe to call repeatedly.
         *
         * M0.5 wire measurement: `arguments` is read deliberately. A source-mode
         * endpoint has no generated parameter codec, so *how* the carrier delivered
         * the call (argument count and types) is the fact worth recording, not just
         * the value that survived parsing.
         */
        async reportSpike(payload) {
            const allArgs = Array.from(arguments);
            const raw = payload;
            let parsed = null;
            if (typeof payload === 'string') {
                try {
                    parsed = JSON.parse(payload);
                }
                catch {
                    parsed = null;
                }
            }
            else if (payload !== null && typeof payload === 'object') {
                parsed = payload;
            }
            const file = join(dirname(this.config.auditFile), 'client-transport.json');
            const record = {
                at: new Date().toISOString(),
                pluginVersion: PLUGIN_VERSION,
                protocolVersion: PROTOCOL_VERSION,
                argCount: allArgs.length,
                args: allArgs.map((value) => {
                    let rawText = null;
                    try {
                        rawText = JSON.stringify(value)?.slice(0, 400) ?? null;
                    }
                    catch {
                        rawText = '<unserialisable>';
                    }
                    return { type: typeof value, isNull: value === null || value === undefined, raw: rawText };
                }),
                receivedType: typeof raw,
                receivedIsNull: raw === null || raw === undefined,
                receivedKeys: raw !== null && typeof raw === 'object' ? Object.keys(raw).slice(0, 24) : null,
                parsedOk: parsed !== null,
                carrier: parsed && typeof parsed.carrier === 'string' ? parsed.carrier : null,
                ok: parsed?.ok === true,
                transport: parsed?.transport ?? null,
                attempts: parsed && Array.isArray(parsed.attempts) ? parsed.attempts : [],
                serviceShapes: parsed?.serviceShapes ?? null,
                userAgent: parsed && typeof parsed.userAgent === 'string' ? parsed.userAgent : null,
            };
            try {
                mkdirSync(dirname(file), { recursive: true });
                writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
            }
            catch (error) {
                // Diagnostics must never fail the caller: the client is already talking to
                // us successfully by the time this is called.
                this.log.warn(`dsh-ssh: could not record the client transport report: ${String(error)}`);
                return { recorded: false, file };
            }
            this.log.info(`dsh-ssh: client transport reported as ${record.carrier ?? 'unresolved'} - recorded in ${file}`);
            return { recorded: true, file };
        }
    };
})();
export { SshPluginService };
//# sourceMappingURL=service.js.map