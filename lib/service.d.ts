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
import type { ResolvedConfig, PublicConfig } from './config.js';
import type { LocalApi } from './api/local-api.js';
import { type Frame, type PingParams, type PingResult, type ProbeStreamParams, type SpikeReportReceipt } from './protocol.js';
/** Minimal logger face; the host composition supplies the real one. */
export interface ServiceLogger {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}
/** Plugin version, duplicated from package.json at build time. */
export declare const PLUGIN_VERSION = "0.2.0";
/** Constructor options; `probeWire` exists only for the M0.5 measurement. */
export interface SshPluginServiceOptions {
    /**
     * Record how each call was delivered on the wire.
     *
     * Off by default and enabled only by the plugin entry: a recording that also
     * captures in-process unit-test calls is worse than none at all, because it
     * looks like evidence while measuring the wrong path. (Learned the hard way.)
     */
    probeWire?: boolean;
    /**
     * Endpoint implementations (ICD §4.2-§4.6).
     *
     * Injected rather than constructed here so the wire table stays a thin
     * delegation layer and this class keeps working — for `ping`, `probeStream`,
     * `describe` and `reportSpike` — with no runtime at all (which is what the M0
     * endpoint tests rely on).
     */
    api?: LocalApi;
}
/**
 * Host-side implementation of the SSH plugin.
 *
 * The M0 slice answers the transport spike (`ping` unary + `probeStream`
 * stream). Session, exec, SFTP and audit methods land on this same class in
 * M1-M3; the frozen signatures live in `docs/ICD.md` section 4 and are delegated
 * to the modules under `src/connection`, `src/exec`, `src/sftp` and `src/audit`.
 */
export declare class SshPluginService {
    /** Required by `bindTypertRemote` (it reads the owning Context off the service). */
    readonly ctx: unknown;
    readonly config: ResolvedConfig;
    readonly log: ServiceLogger;
    /** Visible binding consumed by the Gateway's source-mode discovery. */
    readonly typertRemote: unknown;
    /** M0.5 wire measurement switch; see `SshPluginServiceOptions.probeWire`. */
    readonly probeWire: boolean;
    /** Endpoint implementations; `undefined` in the M0-only configuration. */
    readonly api: LocalApi | undefined;
    constructor(ctx: unknown, config: ResolvedConfig, log: ServiceLogger, options?: SshPluginServiceOptions);
    /**
     * ICD §4.1 `getConfig`: the public projection of the effective configuration.
     *
     * Falls back to projecting `this.config` when no runtime is attached, so the
     * answer is identical in both configurations (and never contains a credential).
     */
    getConfig(): Promise<PublicConfig>;
    /** ICD §4.2 `listProfiles`. */
    listProfiles(raw?: unknown): Promise<unknown>;
    /** ICD §4.2 `saveProfile`. */
    saveProfile(raw?: unknown): Promise<unknown>;
    /** ICD §4.2 `deleteProfile`. */
    deleteProfile(raw?: unknown): Promise<unknown>;
    /** ICD §4.2 `duplicateProfile`. */
    duplicateProfile(raw?: unknown): Promise<unknown>;
    /** ICD §4.2 `testProfile`. */
    testProfile(raw?: unknown): Promise<unknown>;
    /**
     * ICD §4.2 `setSecret`.
     *
     * The answer is a superset of the frozen `{ ref, masked }`: `persisted:false`
     * means the value is good for this process only (the launching environment
     * already supplies that reference, and such a value is read-only for the run).
     * That is a documented degradation, not a failure — the UI should say so.
     */
    setSecret(raw?: unknown): Promise<unknown>;
    /** ICD §4.2 `clearSecret`. */
    clearSecret(raw?: unknown): Promise<unknown>;
    /** ICD §4.3 `connect`. */
    connect(raw?: unknown): Promise<unknown>;
    /** ICD §4.3 `disconnect`. */
    disconnect(raw?: unknown): Promise<unknown>;
    /** ICD §4.3 `listSessions`. */
    listSessions(): Promise<unknown>;
    /** ICD §4.3 `getSession`. */
    getSession(raw?: unknown): Promise<unknown>;
    /** ICD §4.3 `pendingHostKey`. */
    pendingHostKey(raw?: unknown): Promise<unknown>;
    /** ICD §4.3 `decideHostKey`. */
    decideHostKey(raw?: unknown): Promise<unknown>;
    /** ICD §4.3 `followSessions` (stream of `state` frames). */
    followSessions(_raw?: unknown): AsyncIterable<Frame>;
    /** ICD §4.4 `exec` (stream). */
    exec(raw?: unknown): AsyncIterable<Frame>;
    /** ICD §4.4 `execWait`. */
    execWait(raw?: unknown): Promise<unknown>;
    /** ICD §4.4 `openShell` (stream). */
    openShell(raw?: unknown): AsyncIterable<Frame>;
    /** ICD §4.4 `shellWrite`. */
    shellWrite(raw?: unknown): Promise<unknown>;
    /** ICD §4.4 `shellResize`. */
    shellResize(raw?: unknown): Promise<unknown>;
    /** ICD §4.4 `shellSignal`. */
    shellSignal(raw?: unknown): Promise<unknown>;
    /** ICD §4.4 `shellClose`. */
    shellClose(raw?: unknown): Promise<unknown>;
    /** ICD §4.4 `listStreams`. */
    listStreams(raw?: unknown): Promise<unknown>;
    /** ICD §4.5 `listDir`. */
    listDir(raw?: unknown): Promise<unknown>;
    /** ICD §4.5 `stat`. */
    stat(raw?: unknown): Promise<unknown>;
    /** ICD §4.5 `mkdir`. */
    mkdir(raw?: unknown): Promise<unknown>;
    /** ICD §4.5 `rename`. */
    rename(raw?: unknown): Promise<unknown>;
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
    removePath(raw?: unknown): Promise<unknown>;
    /** ICD §4.5 `chmod`. */
    chmod(raw?: unknown): Promise<unknown>;
    /** ICD §4.5 `upload` (stream; the handshake rides in `open.meta`). */
    upload(raw?: unknown): AsyncIterable<Frame>;
    /** ICD §4.5 `download` (stream; the handshake rides in `open.meta`). */
    download(raw?: unknown): AsyncIterable<Frame>;
    /** ICD §4.5 `cancelTransfer`. */
    cancelTransfer(raw?: unknown): Promise<unknown>;
    /** ICD §4.5 `listTransfers`. */
    listTransfers(): Promise<unknown>;
    /** Dual-pane local half: list a local directory. */
    listLocalDir(raw?: unknown): Promise<unknown>;
    /** Dual-pane local half: stat a local path. */
    statLocal(raw?: unknown): Promise<unknown>;
    /** ICD §4.6 `queryAudit`. */
    queryAudit(raw?: unknown): Promise<unknown>;
    /** ICD §4.6 `followAudit` (stream of `audit` frames). */
    followAudit(raw?: unknown): AsyncIterable<Frame>;
    /** ICD §4.6 `clearAudit`. */
    clearAudit(): Promise<unknown>;
    /**
     * ICD §4.7 `followActivity` (stream).
     *
     * No parameter object: the mirror is global by design (see `ActivityApi`), so
     * there is nothing for the client to narrow and nothing the host could refuse.
     */
    followActivity(raw?: unknown): AsyncIterable<Frame>;
    /** ICD §4.7 `clearActivity`. */
    clearActivity(): Promise<unknown>;
    /**
     * The runtime, or an honest error when the service was built without one.
     *
     * A thrown `SshError` reaches the client as a structured `ErrorInfo`; silently
     * returning `{}` would look like an empty result and send the UI down a wrong
     * path ("no profiles" instead of "this endpoint is not wired").
     */
    private apiOf;
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
    private wire;
    /**
     * Transport probe: the smallest possible round trip. The browser half renders
     * the answer verbatim, so this is also the spike's user-visible evidence.
     */
    ping(params: PingParams): Promise<PingResult>;
    /**
     * Append one line describing exactly how the carrier delivered a call.
     *
     * M0.5 only: the delivery shape (argument count, per-argument type and raw
     * JSON) is what decides the project-wide parameter convention, and it cannot be
     * inferred from a value that has already been parsed. Best-effort by
     * construction - a diagnostic must never fail a call.
     */
    private recordWireProbe;
    /**
     * Stream probe: proves the downlink path, frame ordering and terminal `end`.
     * Emits `open`, `count` data frames, then either `end: completed` or an error
     * pair, so the client can be exercised against both outcomes.
     */
    probeStream(params: ProbeStreamParams): AsyncIterable<Frame>;
    /** Snapshot consumed by the UI's status header; no secrets are included. */
    describe(): Promise<{
        namespace: string;
        version: string;
        config: Record<string, unknown>;
    }>;
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
    reportSpike(payload: unknown): Promise<SpikeReportReceipt>;
}
//# sourceMappingURL=service.d.ts.map