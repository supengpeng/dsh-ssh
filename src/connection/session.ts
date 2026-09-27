/**
 * `SessionHandle` implementation (ICD §7.1).
 *
 * One instance owns one live connection: its state machine, its `SessionInfo`
 * projection, the channels opened on it, and its SFTP subsystem. It is also the
 * `SftpChannelSource` SP3's adapter consumes, so the SFTP session is created
 * lazily on *this* transport and the raw `SFTPWrapper` is handed over untouched
 * (ICD v1.0.3: the adapter must forward `opts` verbatim to
 * `createWriteStream`, including `start`).
 */

import type { NegotiatedAlgorithms, SFTPWrapper } from 'ssh2'

import type { ResolvedConfig } from '../config.js'
import { SshError } from '../protocol.js'
import type { ErrorInfo, SessionInfo, SessionState } from '../protocol.js'
import type { SessionRegistry } from '../sessions.js'
import { ChannelHandle } from './channel.js'
import { newStreamId } from './ids.js'
import { SessionStateMachine } from './state.js'
import type { AuthPlan } from './auth.js'
import {
  closeReason,
  composeRemoteCommand,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  DEFAULT_TERM,
  openTransport,
  shellQuote,
  type Transport,
} from './transport.js'
import type {
  ClientChannelPort,
  ExecHandle,
  ExecRequest,
  HostKeyQuestion,
  KnownHostsVerifierPort,
  LoggerPort,
  RedactorPort,
  ResolvedProfile,
  SftpChannelSource,
  SftpHandle,
  SftpProvider,
  SessionHandle,
  SessionId,
  ShellHandle,
  ShellRequest,
  SshClientPort,
} from './types.js'

export interface SessionDeps {
  config: ResolvedConfig
  logger: LoggerPort
  redactor?: RedactorPort | undefined
  /** SP3's SFTP adapter; absent = `sftp()` reports `SSH_SFTP_PROTOCOL`. */
  sftp?: SftpProvider | undefined
  /** SP1 registry kept in sync with this session's projection. */
  registry?: SessionRegistry | undefined
  now: () => number
}

export interface SessionDialOptions {
  auth: AuthPlan
  createClient: () => SshClientPort
  knownHosts?: KnownHostsVerifierPort | undefined
  onHostKeyPrompt?: ((q: HostKeyQuestion) => Promise<'accept' | 'reject'>) | undefined
  signal?: AbortSignal | undefined
}

export interface SessionOptions {
  id: SessionId
  profile: ResolvedProfile
  label: string
  deps: SessionDeps
  /** Notified on every state transition (wire `state` frames). */
  onStateChange?: ((state: SessionState, error?: ErrorInfo) => void) | undefined
}

/** Weight of a new round-trip sample in the moving average. */
const RTT_SMOOTHING = 0.3

export class SshSession implements SessionHandle, SftpChannelSource {
  readonly id: SessionId

  private readonly profile: ResolvedProfile
  private readonly label: string
  private readonly deps: SessionDeps
  private readonly machine = new SessionStateMachine('idle')
  private readonly infoValue: SessionInfo
  private readonly channels = new Set<ChannelHandle>()
  private readonly onStateChange: ((state: SessionState, error?: ErrorInfo) => void) | undefined

  private transportValue: Transport | undefined
  private sftpHandleValue: SftpHandle | undefined
  private sftpPending: Promise<SftpHandle> | undefined
  private sftpWrapperValue: SFTPWrapper | undefined
  private sftpWrapperPending: Promise<SFTPWrapper> | undefined
  private rttEma: number | undefined
  private closing: Promise<void> | undefined
  private knownHostFingerprint: string | undefined
  private serverBannerValue: string | undefined
  private negotiatedValue: NegotiatedAlgorithms | undefined

  constructor(options: SessionOptions) {
    this.id = options.id
    this.profile = options.profile
    this.label = options.label
    this.deps = options.deps
    this.onStateChange = options.onStateChange
    const info: SessionInfo = {
      id: this.id,
      label: this.label,
      host: options.profile.host,
      port: options.profile.port,
      user: options.profile.user,
      state: 'idle',
      since: new Date(this.deps.now()).toISOString(),
      metrics: { bytesIn: 0, bytesOut: 0 },
      capabilities: { shell: true, sftp: true },
    }
    if (options.profile.id !== '') info.profileId = options.profile.id
    this.infoValue = info
  }

  // -- frozen surface ------------------------------------------------------

  get info(): SessionInfo {
    return this.infoValue
  }

  get state(): SessionState {
    return this.machine.state
  }

  /** Extra, non-frozen: the profile this session was created from. */
  get resolvedProfile(): ResolvedProfile {
    return this.profile
  }

  /** Extra, non-frozen: server identification banner, when the server sent one. */
  get banner(): string | undefined {
    return this.serverBannerValue
  }

  /** Extra, non-frozen: negotiated algorithms (diagnostics). */
  get negotiated(): NegotiatedAlgorithms | undefined {
    return this.negotiatedValue
  }

  /** Extra, non-frozen: `SHA256:` fingerprint of the accepted host key. */
  get hostKeyFingerprint(): string | undefined {
    return this.knownHostFingerprint
  }

  async exec(req: ExecRequest): Promise<ExecHandle> {
    const transport = this.requireConnected('exec')
    const command = typeof req.command === 'string' ? req.command : ''
    if (command.trim() === '') {
      throw new SshError('SSH_CFG_INVALID', 'exec requires a non-empty command', { details: { field: 'command' } })
    }
    const cwd = req.cwd ?? this.profile.defaultCwd
    const env = mergeEnv(this.profile.defaultEnv, req.env)
    const composed = composeRemoteCommand(command, cwd, env)
    // `env` travels as leading assignments in the command string: sshd commonly
    // refuses `env` channel requests (AcceptEnv), and the ICD promises `env`
    // support for `exec`, not a particular mechanism.
    const pty =
      req.pty === true
        ? {
            term: req.term ?? DEFAULT_TERM,
            cols: positiveInt(req.cols, DEFAULT_COLS),
            rows: positiveInt(req.rows, DEFAULT_ROWS),
            width: 0,
            height: 0,
          }
        : undefined
    const channel = await transport.exec(composed.command, pty === undefined ? {} : { pty })
    return this.attachChannel('exec', channel, {
      label: abbreviate(command),
      timeoutMs: req.timeoutMs,
    })
  }

  async shell(req: ShellRequest): Promise<ShellHandle> {
    const transport = this.requireConnected('shell')
    const cols = positiveInt(req.cols, NaN)
    const rows = positiveInt(req.rows, NaN)
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
      throw new SshError('SSH_CFG_INVALID', 'openShell requires positive cols/rows', {
        details: { field: 'cols/rows', cols: req.cols, rows: req.rows },
      })
    }
    const env = mergeEnv(this.profile.defaultEnv, req.env)
    const channel = await transport.shell({
      term: req.term ?? DEFAULT_TERM,
      cols,
      rows,
      ...(env === undefined ? {} : { env }),
    })
    const handle = this.attachChannel('shell', channel, {
      label: `pty(${req.term ?? DEFAULT_TERM})`,
      // Long-lived by nature: only an explicit timeout may kill a shell.
      timeoutMs: req.timeoutMs,
    })
    const cwd = req.cwd ?? this.profile.defaultCwd
    if (cwd !== undefined && cwd !== '') {
      // ssh2 offers no `cwd` for shell channels; typing `cd` is what a user
      // would do and the echo is visible in the terminal (documented).
      handle.write(`cd -- ${shellQuote(cwd)}\n`)
    }
    return handle
  }

  async sftp(signal?: AbortSignal): Promise<SftpHandle> {
    if (this.sftpHandleValue !== undefined) return this.sftpHandleValue
    if (this.sftpPending !== undefined) return this.sftpPending
    this.requireConnected('open an SFTP channel')
    const provider = this.deps.sftp
    if (provider === undefined) {
      throw new SshError('SSH_SFTP_PROTOCOL', 'the SFTP subsystem is not wired in this plugin instance', {
        details: { sessionId: this.id },
      })
    }
    if (signal?.aborted === true) throw new SshError('SSH_CANCELLED', 'SFTP session request was cancelled')

    const pending = provider(this, signal)
      .then((handle) => {
        this.sftpHandleValue = handle
        this.infoValue.capabilities.sftp = true
        this.publish()
        return handle
      })
      .catch((error: unknown) => {
        // A server without the SFTP subsystem must not keep advertising it.
        if (error instanceof SshError && error.code === 'SSH_SFTP_PROTOCOL') {
          this.infoValue.capabilities.sftp = false
          this.publish()
        }
        throw error
      })
      .finally(() => {
        this.sftpPending = undefined
      })
    this.sftpPending = pending
    return pending
  }

  rttMs(): number | undefined {
    return this.rttEma
  }

  async close(options?: { force?: boolean; reason?: string }): Promise<void> {
    if (this.machine.state === 'closed') return
    if (this.closing !== undefined) return this.closing
    this.closing = this.doClose(options)
    return this.closing
  }

  // -- SftpChannelSource (SP3) --------------------------------------------

  get handle(): SessionHandle {
    return this
  }

  /**
   * The connection's raw SFTP subsystem.
   *
   * Returned unmodified on purpose: SP3's adapter forwards the caller's `opts`
   * object straight to `createWriteStream`, and a wrapper here would be the
   * easiest place to silently drop `start` (ICD v1.0.3).
   */
  async openSftpChannel(signal?: AbortSignal): Promise<SFTPWrapper> {
    if (this.sftpWrapperValue !== undefined) return this.sftpWrapperValue
    if (this.sftpWrapperPending !== undefined) return this.sftpWrapperPending
    const transport = this.requireConnected('open an SFTP channel')
    if (signal?.aborted === true) throw new SshError('SSH_CANCELLED', 'SFTP channel request was cancelled')
    const pending = transport
      .sftp()
      .then((wrapper) => {
        this.sftpWrapperValue = wrapper
        return wrapper
      })
      .finally(() => {
        this.sftpWrapperPending = undefined
      })
    this.sftpWrapperPending = pending
    return pending
  }

  // -- lifecycle (called by the pool) -------------------------------------

  /** Dial, authenticate and become usable. Retried by the pool. */
  async dial(options: SessionDialOptions): Promise<void> {
    this.setState('connecting')
    this.transportValue = await openTransport({
      profile: this.profile,
      config: this.deps.config,
      auth: options.auth,
      logger: this.deps.logger,
      createClient: options.createClient,
      knownHosts: options.knownHosts,
      onHostKeyPrompt: options.onHostKeyPrompt,
      signal: options.signal,
      now: this.deps.now,
      onHandshake: () => this.setState('authenticating'),
      onReady: () => this.setState('connected'),
      onHostKeyDecision: (info) => {
        if (info.accepted) this.knownHostFingerprint = info.fingerprint
        else delete this.knownHostFingerprint
      },
      onRttSample: (ms) => this.noteRtt(ms),
      onClosed: (error) => this.handleLinkDeath(error),
    })
    const transport = this.transportValue
    this.serverBannerValue = transport.banner
    this.negotiatedValue = transport.negotiated
    this.knownHostFingerprint = transport.hostKeyFingerprint ?? this.knownHostFingerprint
    this.infoValue.metrics.connectMs = transport.connectMs
    if (this.machine.state !== 'connected') this.setState('connected')
    this.publish()
    this.deps.logger.info(
      `session ${this.id} ready for ${this.profile.user}@${this.profile.host}:${this.profile.port} ` +
        `(connectMs=${transport.connectMs}, rtt=${this.rttEma ?? 'n/a'})`,
    )
  }

  /** The connection died outside a local `close()`. */
  handleLinkDeath(error?: SshError): void {
    if (this.machine.state === 'closing' || this.machine.state === 'closed') return
    const info: ErrorInfo | undefined =
      error?.toErrorInfo() ??
      new SshError('SSH_NET_RESET', 'the SSH connection was lost', {
        details: { sessionId: this.id },
      }).toErrorInfo()
    this.deps.logger.warn(`session ${this.id} lost its connection (${info.code})`)
    this.setState('error', info)
  }

  /** Terminal bookkeeping after a failed dial. */
  markFailed(error: ErrorInfo): void {
    if (this.machine.state === 'closed' || this.machine.state === 'error') {
      this.infoValue.error = error
      this.publish()
      return
    }
    this.setState('error', error)
  }

  // -- internals ----------------------------------------------------------

  private async doClose(options?: { force?: boolean; reason?: string }): Promise<void> {
    const reason = closeReason(options)
    this.setState('closing')
    this.deps.logger.info(`closing session ${this.id} (${reason})`)
    for (const channel of [...this.channels]) channel.cancel()
    const transport = this.transportValue
    this.transportValue = undefined
    if (transport !== undefined) await transport.close({ force: options?.force, reason })
    try {
      this.sftpWrapperValue?.end()
    } catch {
      /* the channel is gone with the transport */
    }
    this.sftpWrapperValue = undefined
    this.sftpWrapperPending = undefined
    this.sftpHandleValue = undefined
    this.sftpPending = undefined
    this.setState('closed')
  }

  private attachChannel(
    kind: 'exec' | 'shell',
    channel: ClientChannelPort,
    options: { label: string; timeoutMs?: number | undefined },
  ): ChannelHandle {
    let handle: ChannelHandle | undefined
    handle = new ChannelHandle({
      streamId: newStreamId(),
      channel,
      logger: this.deps.logger,
      now: this.deps.now,
      kind,
      label: options.label,
      timeoutMs: options.timeoutMs,
      graceKillMs: this.deps.config.graceKillMs,
      onBytesIn: (bytes) => {
        this.infoValue.metrics.bytesIn += bytes
      },
      onBytesOut: (bytes) => {
        this.infoValue.metrics.bytesOut += bytes
      },
      onFinished: () => {
        if (handle !== undefined) this.channels.delete(handle)
      },
    })
    this.channels.add(handle)
    return handle
  }

  private requireConnected(op: string): Transport {
    if (this.machine.state !== 'connected' || this.transportValue === undefined) {
      throw new SshError('SSH_STATE_INVALID', `session ${this.id} is ${this.machine.state}; cannot ${op}`, {
        details: { sessionId: this.id, state: this.machine.state, op },
      })
    }
    return this.transportValue
  }

  private noteRtt(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return
    this.rttEma = this.rttEma === undefined ? Math.round(ms) : Math.round(this.rttEma * (1 - RTT_SMOOTHING) + ms * RTT_SMOOTHING)
    this.infoValue.metrics.rttMs = this.rttEma
    this.publish()
  }

  private setState(next: SessionState, error?: ErrorInfo): void {
    const changed = this.machine.set(next)
    this.infoValue.state = this.machine.state
    if (error !== undefined) this.infoValue.error = error
    else if (next === 'connected' || next === 'closed') delete this.infoValue.error
    if (changed) this.onStateChange?.(this.machine.state, error)
    this.publish()
  }

  /** Mirror the projection into the registry, when one is wired. */
  private publish(): void {
    this.deps.registry?.update(this.id, {
      state: this.infoValue.state,
      metrics: { ...this.infoValue.metrics },
      capabilities: { ...this.infoValue.capabilities },
      ...(this.infoValue.error === undefined ? {} : { error: this.infoValue.error }),
    })
  }
}

function mergeEnv(
  defaults: Record<string, string> | undefined,
  requested: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (defaults === undefined && requested === undefined) return undefined
  const merged = { ...(defaults ?? {}), ...(requested ?? {}) }
  return Object.keys(merged).length === 0 ? undefined : merged
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const truncated = Math.trunc(value)
  return truncated > 0 ? truncated : fallback
}

/** Short, log-safe label for a command. */
function abbreviate(command: string, max = 48): string {
  const single = command.replaceAll(/\s+/g, ' ').trim()
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`
}
