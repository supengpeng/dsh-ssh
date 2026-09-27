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

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { bindTypertRemote, Remote } from '@deepseek-ai/dsh-typert-protocol'

import type { ResolvedConfig, PublicConfig } from './config.js'
import { toPublicConfig } from './config.js'
import { encodeResult, readParams } from './api/params.js'
import type { LocalApi } from './api/local-api.js'
import {
  SshError,
  type Frame,
  type PingParams,
  type PingResult,
  PROTOCOL_VERSION,
  type ProbeStreamParams,
  REMOTE_NAMESPACE,
  SERVICE_KEY,
  type SpikeReport,
  type SpikeReportReceipt,
  isRetryable,
  toErrorInfo,
} from './protocol.js'

/** Minimal logger face; the host composition supplies the real one. */
export interface ServiceLogger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** Plugin version, duplicated from package.json at build time. */
export const PLUGIN_VERSION = '0.1.0'

const MAX_PROBE_FRAMES = 200

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
function asWireError(error: unknown, raw: unknown, probe: boolean, config: ResolvedConfig, log: ServiceLogger): Error {
  const info = toErrorInfo(error)
  const wrapped = error instanceof Error ? error : new Error(info.message)
  try {
    Object.defineProperty(wrapped, 'code', { value: info.code, enumerable: true, configurable: true })
    Object.defineProperty(wrapped, 'retryable', { value: isRetryable(info.code), enumerable: true, configurable: true })
    if (info.details !== undefined) Object.defineProperty(wrapped, 'details', { value: info.details, enumerable: true, configurable: true })
    if (info.retryAfterMs !== undefined) {
      Object.defineProperty(wrapped, 'retryAfterMs', { value: info.retryAfterMs, enumerable: true, configurable: true })
    }
  } catch {
    /* a frozen error object still carries its message */
  }
  if (probe) {
    // M0.5: record the *failure* path too, because "the call arrived but its
    // parameters did not" looks exactly like this from the host side.
    try {
      const file = join(dirname(config.auditFile), 'wire-probe.jsonl')
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(
        file,
        `${JSON.stringify({ at: new Date().toISOString(), method: 'error', rawType: typeof raw, code: info.code, message: info.message })}\n`,
        'utf8',
      )
    } catch {
      /* diagnostics never fail a call */
    }
  }
  log.debug(`endpoint failed with ${info.code}: ${info.message}`)
  return wrapped
}

/** Constructor options; `probeWire` exists only for the M0.5 measurement. */
export interface SshPluginServiceOptions {
  /**
   * Record how each call was delivered on the wire.
   *
   * Off by default and enabled only by the plugin entry: a recording that also
   * captures in-process unit-test calls is worse than none at all, because it
   * looks like evidence while measuring the wrong path. (Learned the hard way.)
   */
  probeWire?: boolean
  /**
   * Endpoint implementations (ICD §4.2-§4.6).
   *
   * Injected rather than constructed here so the wire table stays a thin
   * delegation layer and this class keeps working — for `ping`, `probeStream`,
   * `describe` and `reportSpike` — with no runtime at all (which is what the M0
   * endpoint tests rely on).
   */
  api?: LocalApi
}

/**
 * Host-side implementation of the SSH plugin.
 *
 * The M0 slice answers the transport spike (`ping` unary + `probeStream`
 * stream). Session, exec, SFTP and audit methods land on this same class in
 * M1-M3; the frozen signatures live in `docs/ICD.md` section 4 and are delegated
 * to the modules under `src/connection`, `src/exec`, `src/sftp` and `src/audit`.
 */
export class SshPluginService {
  /** Required by `bindTypertRemote` (it reads the owning Context off the service). */
  readonly ctx: unknown
  readonly config: ResolvedConfig
  readonly log: ServiceLogger
  /** Visible binding consumed by the Gateway's source-mode discovery. */
  readonly typertRemote: unknown
  /** M0.5 wire measurement switch; see `SshPluginServiceOptions.probeWire`. */
  readonly probeWire: boolean
  /** Endpoint implementations; `undefined` in the M0-only configuration. */
  readonly api: LocalApi | undefined

  constructor(
    ctx: unknown,
    config: ResolvedConfig,
    log: ServiceLogger,
    options: SshPluginServiceOptions = {},
  ) {
    this.ctx = ctx
    this.config = config
    this.log = log
    this.probeWire = options.probeWire === true
    this.api = options.api
    this.typertRemote = bindTypertRemote(this, SERVICE_KEY, { namespace: REMOTE_NAMESPACE })
  }

  /**
   * ICD §4.1 `getConfig`: the public projection of the effective configuration.
   *
   * Falls back to projecting `this.config` when no runtime is attached, so the
   * answer is identical in both configurations (and never contains a credential).
   */
  @Remote
  async getConfig(): Promise<PublicConfig> {
    if (this.api === undefined) return toPublicConfig(this.config)
    return this.api.getConfig()
  }

  // =========================================================================
  // §4.2 Connection profiles
  // =========================================================================

  /** ICD §4.2 `listProfiles`. */
  @Remote
  async listProfiles(raw?: unknown): Promise<unknown> {
    return this.wire(() => this.apiOf().profiles.list(), raw)
  }

  /** ICD §4.2 `saveProfile`. */
  @Remote
  async saveProfile(raw?: unknown): Promise<unknown> {
    return this.wire(() => this.apiOf().profiles.save(readParams(raw).params), raw)
  }

  /** ICD §4.2 `deleteProfile`. */
  @Remote
  async deleteProfile(raw?: unknown): Promise<unknown> {
    return this.wire(() => this.apiOf().profiles.remove(readParams(raw).params), raw)
  }

  /** ICD §4.2 `duplicateProfile`. */
  @Remote
  async duplicateProfile(raw?: unknown): Promise<unknown> {
    return this.wire(() => this.apiOf().profiles.duplicate(readParams(raw).params), raw)
  }

  /** ICD §4.2 `testProfile`. */
  @Remote
  async testProfile(raw?: unknown): Promise<unknown> {
    return this.wire(() => this.apiOf().profiles.test(readParams(raw).params), raw)
  }

  /**
   * ICD §4.2 `setSecret`.
   *
   * The answer is a superset of the frozen `{ ref, masked }`: `persisted:false`
   * means the value is good for this process only (the launching environment
   * already supplies that reference, and such a value is read-only for the run).
   * That is a documented degradation, not a failure — the UI should say so.
   */
  @Remote
  async setSecret(raw?: unknown): Promise<unknown> {
    return this.wire(() => this.apiOf().profiles.setSecret(readParams(raw).params), raw)
  }

  /** ICD §4.2 `clearSecret`. */
  @Remote
  async clearSecret(raw?: unknown): Promise<unknown> {
    return this.wire(() => this.apiOf().profiles.clearSecret(readParams(raw).params), raw)
  }

  // =========================================================================
  // §4.3 Sessions
  // =========================================================================

  /** ICD §4.3 `connect`. */
  @Remote
  async connect(raw?: unknown): Promise<unknown> {
    return this.wire(() => this.apiOf().sessions.connect(readParams(raw).params), raw)
  }

  /** ICD §4.3 `disconnect`. */
  @Remote
  async disconnect(raw?: unknown): Promise<unknown> {
    return this.wire(() => this.apiOf().sessions.disconnect(readParams(raw).params), raw)
  }

  /** ICD §4.3 `listSessions`. */
  @Remote
  async listSessions(): Promise<unknown> {
    return this.wire(() => this.apiOf().sessions.listSessions())
  }

  /** ICD §4.3 `getSession`. */
  @Remote
  async getSession(raw?: unknown): Promise<unknown> {
    return this.wire(() => this.apiOf().sessions.getSession(readParams(raw).params), raw)
  }

  /** ICD §4.3 `pendingHostKey`. */
  @Remote
  async pendingHostKey(raw?: unknown): Promise<unknown> {
    return this.wire(() => this.apiOf().sessions.pendingHostKey(readParams(raw).params), raw)
  }

  /** ICD §4.3 `decideHostKey`. */
  @Remote
  async decideHostKey(raw?: unknown): Promise<unknown> {
    return this.wire(() => this.apiOf().sessions.decideHostKey(readParams(raw).params), raw)
  }

  /** ICD §4.3 `followSessions` (stream of `state` frames). */
  @Remote({ mode: 'stream' })
  async *followSessions(_raw?: unknown): AsyncIterable<Frame> {
    yield* this.apiOf().sessions.follow()
  }

  // =========================================================================
  // §4.4 Commands and shells
  // =========================================================================

  /** ICD §4.4 `exec` (stream). */
  @Remote({ mode: 'stream' })
  async *exec(raw?: unknown): AsyncIterable<Frame> {
    yield* this.apiOf().exec.exec(raw)
  }

  /** ICD §4.4 `execWait`. */
  @Remote
  async execWait(raw?: unknown): Promise<unknown> {
    return this.wire(() => this.apiOf().exec.execWait(raw), raw)
  }

  /** ICD §4.4 `openShell` (stream). */
  @Remote({ mode: 'stream' })
  async *openShell(raw?: unknown): AsyncIterable<Frame> {
    yield* this.apiOf().exec.openShell(raw)
  }

  /** ICD §4.4 `shellWrite`. */
  @Remote
  async shellWrite(raw?: unknown): Promise<unknown> {
    return this.wire(() => this.apiOf().exec.shellWrite(raw), raw)
  }

  /** ICD §4.4 `shellResize`. */
  @Remote
  async shellResize(raw?: unknown): Promise<unknown> {
    return this.wire(() => this.apiOf().exec.shellResize(raw), raw)
  }

  /** ICD §4.4 `shellSignal`. */
  @Remote
  async shellSignal(raw?: unknown): Promise<unknown> {
    return this.wire(() => this.apiOf().exec.shellSignal(raw), raw)
  }

  /** ICD §4.4 `shellClose`. */
  @Remote
  async shellClose(raw?: unknown): Promise<unknown> {
    return this.wire(() => this.apiOf().exec.shellClose(raw), raw)
  }

  /** ICD §4.4 `listStreams`. */
  @Remote
  async listStreams(raw?: unknown): Promise<unknown> {
    return this.wire(() => this.apiOf().exec.listStreams(raw), raw)
  }

  // =========================================================================
  // §4.5 SFTP
  // =========================================================================

  /** ICD §4.5 `listDir`. */
  @Remote
  async listDir(raw?: unknown): Promise<unknown> {
    return this.wire(() => this.apiOf().files.listDir(raw), raw)
  }

  /** ICD §4.5 `stat`. */
  @Remote
  async stat(raw?: unknown): Promise<unknown> {
    return this.wire(() => this.apiOf().files.stat(raw), raw)
  }

  /** ICD §4.5 `mkdir`. */
  @Remote
  async mkdir(raw?: unknown): Promise<unknown> {
    return this.wire(() => this.apiOf().files.mkdir(raw), raw)
  }

  /** ICD §4.5 `rename`. */
  @Remote
  async rename(raw?: unknown): Promise<unknown> {
    return this.wire(() => this.apiOf().files.rename(raw), raw)
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
  @Remote
  async removePath(raw?: unknown): Promise<unknown> {
    return this.wire(() => this.apiOf().files.remove(raw), raw)
  }

  /** ICD §4.5 `chmod`. */
  @Remote
  async chmod(raw?: unknown): Promise<unknown> {
    return this.wire(() => this.apiOf().files.chmod(raw), raw)
  }

  /** ICD §4.5 `upload` (stream; the handshake rides in `open.meta`). */
  @Remote({ mode: 'stream' })
  async *upload(raw?: unknown): AsyncIterable<Frame> {
    yield* this.apiOf().files.upload(raw)
  }

  /** ICD §4.5 `download` (stream; the handshake rides in `open.meta`). */
  @Remote({ mode: 'stream' })
  async *download(raw?: unknown): AsyncIterable<Frame> {
    yield* this.apiOf().files.download(raw)
  }

  /** ICD §4.5 `cancelTransfer`. */
  @Remote
  async cancelTransfer(raw?: unknown): Promise<unknown> {
    return this.wire(() => this.apiOf().files.cancelTransfer(raw), raw)
  }

  /** ICD §4.5 `listTransfers`. */
  @Remote
  async listTransfers(): Promise<unknown> {
    return this.wire(() => this.apiOf().files.listTransfers())
  }

  /** Dual-pane local half: list a local directory. */
  @Remote
  async listLocalDir(raw?: unknown): Promise<unknown> {
    return this.wire(() => this.apiOf().files.listLocalDir(raw), raw)
  }

  /** Dual-pane local half: stat a local path. */
  @Remote
  async statLocal(raw?: unknown): Promise<unknown> {
    return this.wire(() => this.apiOf().files.statLocal(raw), raw)
  }

  // =========================================================================
  // §4.6 Audit
  // =========================================================================

  /** ICD §4.6 `queryAudit`. */
  @Remote
  async queryAudit(raw?: unknown): Promise<unknown> {
    return this.wire(() => this.apiOf().audit.query(raw), raw)
  }

  /** ICD §4.6 `followAudit` (stream of `audit` frames). */
  @Remote({ mode: 'stream' })
  async *followAudit(raw?: unknown): AsyncIterable<Frame> {
    yield* this.apiOf().audit.follow(raw)
  }

  /** ICD §4.6 `clearAudit`. */
  @Remote
  async clearAudit(): Promise<unknown> {
    return this.wire(() => this.apiOf().audit.clear())
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
  private apiOf(): LocalApi {
    if (this.api === undefined) {
      throw new SshError('SSH_STATE_INVALID', 'this endpoint is not available: the plugin runtime was not attached')
    }
    return this.api
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
  private async wire<T>(run: () => T | Promise<T>, raw?: unknown): Promise<unknown> {
    try {
      const value = await run()
      return encodeResult(value)
    } catch (error) {
      throw asWireError(error, raw, this.probeWire, this.config, this.log)
    }
  }

  /**
   * Transport probe: the smallest possible round trip. The browser half renders
   * the answer verbatim, so this is also the spike's user-visible evidence.
   */
  @Remote
  async ping(params: PingParams): Promise<PingResult> {
    // M0.5 wire measurement. `ping` is called by the client on every apply (it is
    // how the bridge verifies a carrier), which makes it the one probe that needs
    // no cooperation from the UI: whatever a *simple* one-key object does on this
    // wire is recorded here, next to the richer reportSpike payload.
    this.recordWireProbe('ping', arguments as unknown as ArrayLike<unknown>)

    const started = Date.now()
    const result: PingResult = {
      pong: true,
      version: PROTOCOL_VERSION,
      namespace: REMOTE_NAMESPACE,
      node: process.version,
      pluginVersion: PLUGIN_VERSION,
      at: new Date().toISOString(),
      handlerMs: 0,
    }
    if (typeof params?.echo === 'string') result.echo = params.echo
    return { ...result, handlerMs: Date.now() - started }
  }

  /**
   * Append one line describing exactly how the carrier delivered a call.
   *
   * M0.5 only: the delivery shape (argument count, per-argument type and raw
   * JSON) is what decides the project-wide parameter convention, and it cannot be
   * inferred from a value that has already been parsed. Best-effort by
   * construction - a diagnostic must never fail a call.
   */
  private recordWireProbe(method: string, args: ArrayLike<unknown>): void {
    if (!this.probeWire) return
    try {
      const file = join(dirname(this.config.auditFile), 'wire-probe.jsonl')
      mkdirSync(dirname(file), { recursive: true })
      const values = Array.from(args)
      const line = JSON.stringify({
        at: new Date().toISOString(),
        method,
        argCount: values.length,
        args: values.map((value) => {
          let raw: string | null = null
          try {
            raw = JSON.stringify(value)?.slice(0, 500) ?? null
          } catch {
            raw = '<unserialisable>'
          }
          return { type: typeof value, isNull: value === null || value === undefined, raw }
        }),
      })
      writeFileSync(file, `${line}\n`, { encoding: 'utf8', flag: 'a' })
    } catch {
      /* diagnostics never fail a call */
    }
  }

  /**
   * Stream probe: proves the downlink path, frame ordering and terminal `end`.
   * Emits `open`, `count` data frames, then either `end: completed` or an error
   * pair, so the client can be exercised against both outcomes.
   */
  @Remote({ mode: 'stream' })
  async *probeStream(params: ProbeStreamParams): AsyncIterable<Frame> {
    const count = Math.max(1, Math.min(MAX_PROBE_FRAMES, Math.trunc(params?.count ?? 5)))
    const intervalMs = Math.max(0, Math.min(2000, Math.trunc(params?.intervalMs ?? 250)))
    const streamId = `st_probe_${Date.now().toString(36)}`
    const fail = params?.fail === true

    yield { t: 'open', streamId, kind: 'exec', meta: { probe: true, count, intervalMs } }
    for (let seq = 0; seq < count; seq++) {
      if (intervalMs > 0) await new Promise((resolve) => setTimeout(resolve, intervalMs))
      yield {
        t: 'data',
        streamId,
        seq,
        chunk: `frame ${seq + 1}/${count} @ ${new Date().toISOString()}\n`,
        encoding: 'utf8',
        channel: 'stdout',
      }
    }
    if (fail) {
      yield {
        t: 'end',
        streamId,
        reason: 'error',
        error: { code: 'SSH_UNKNOWN', message: 'probe requested a failing stream', retryable: false },
      }
      return
    }
    yield { t: 'end', streamId, reason: 'completed' }
  }

  /** Snapshot consumed by the UI's status header; no secrets are included. */
  @Remote
  async describe(): Promise<{ namespace: string; version: string; config: Record<string, unknown> }> {
    const { profilesFile, auditFile, knownHostsFile, maxSessions, hostKey, sftp, ui, secrets } = this.config
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
    }
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
  @Remote
  async reportSpike(payload: unknown): Promise<SpikeReportReceipt> {
    const allArgs: unknown[] = Array.from(arguments as unknown as ArrayLike<unknown>)
    const raw = payload
    let parsed: SpikeReport | null = null
    if (typeof payload === 'string') {
      try {
        parsed = JSON.parse(payload) as SpikeReport
      } catch {
        parsed = null
      }
    } else if (payload !== null && typeof payload === 'object') {
      parsed = payload as SpikeReport
    }

    const file = join(dirname(this.config.auditFile), 'client-transport.json')
    const record = {
      at: new Date().toISOString(),
      pluginVersion: PLUGIN_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      argCount: allArgs.length,
      args: allArgs.map((value) => {
        let rawText: string | null = null
        try {
          rawText = JSON.stringify(value)?.slice(0, 400) ?? null
        } catch {
          rawText = '<unserialisable>'
        }
        return { type: typeof value, isNull: value === null || value === undefined, raw: rawText }
      }),
      receivedType: typeof raw,
      receivedIsNull: raw === null || raw === undefined,
      receivedKeys:
        raw !== null && typeof raw === 'object' ? Object.keys(raw as Record<string, unknown>).slice(0, 24) : null,
      parsedOk: parsed !== null,
      carrier: parsed && typeof parsed.carrier === 'string' ? parsed.carrier : null,
      ok: parsed?.ok === true,
      transport: parsed?.transport ?? null,
      attempts: parsed && Array.isArray(parsed.attempts) ? parsed.attempts : [],
      serviceShapes: parsed?.serviceShapes ?? null,
      userAgent: parsed && typeof parsed.userAgent === 'string' ? parsed.userAgent : null,
    }
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    } catch (error) {
      // Diagnostics must never fail the caller: the client is already talking to
      // us successfully by the time this is called.
      this.log.warn(`dsh-ssh: could not record the client transport report: ${String(error)}`)
      return { recorded: false, file }
    }
    this.log.info(`dsh-ssh: client transport reported as ${record.carrier ?? 'unresolved'} - recorded in ${file}`)
    return { recorded: true, file }
  }
}