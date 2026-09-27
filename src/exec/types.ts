/**
 * The exec layer's view of the connection layer, declared structurally.
 *
 * These interfaces mirror `docs/ICD.md` §7.1 (`SessionHandle`, `ExecHandle`,
 * `ShellHandle`, `ExecRequest`, `ShellRequest`) *field for field* on purpose:
 * SP1 owns the real declarations in `src/connection/types.ts`, and this module
 * deliberately does not import them. Two reasons, both practical:
 *
 *   1. mock-first development — every test in this folder drives a fake
 *      session, so the exec layer never blocks on the connection layer landing;
 *   2. structural typing means SP1's `SessionHandle` is assignable to
 *      {@link SessionHandleLike} without either side importing the other, so
 *      there is exactly one implementation and no adapter to drift.
 *
 * If SP1's published shape ever stops being assignable to these types, that is
 * an ICD violation to report — not something to paper over with a cast here.
 */

import type { StreamKind } from '../protocol.js'

/** Signals the ssh2 transport can deliver to a remote process. */
export type SshSignal = 'INT' | 'TERM' | 'KILL' | 'QUIT' | 'HUP'

/** Channels a non-PTY command produces. */
export type ExecChannel = 'stdout' | 'stderr'

/** Channels a frame may carry (ICD §3 adds the PTY channel `term`). */
export type TerminalChannel = 'stdout' | 'stderr' | 'term'

/** Wire encodings of a `data` frame chunk. */
export type ChunkEncoding = 'utf8' | 'base64'

/** Terminal notification every exec/shell channel eventually produces. */
export interface ExecExitEvent {
  code: number | null
  signal?: string
  durationMs: number
  timedOut: boolean
}

/**
 * A started command channel (ICD §7.1 `ExecHandle`).
 *
 * `onData`/`onExit` return their own unsubscribe function; the exec layer always
 * calls them so a cancelled command cannot keep pushing frames into a stream
 * that already ended.
 */
export interface ExecHandleLike {
  readonly streamId: string
  onData(cb: (channel: ExecChannel, chunk: Buffer) => void): () => void
  onExit(cb: (event: ExecExitEvent) => void): () => void
  write(stdin: string | Buffer): void
  /**
   * Close the channel's stdin (ICD v1.0.4 §7.1): without it a command that reads
   * until EOF (`cat`, `wc -l`, `tar`) could only finish when its deadline fired.
   */
  endInput(): void
  signal(sig: SshSignal): void
  cancel(): void
}

/** An interactive PTY channel (ICD §7.1 `ShellHandle`). */
export interface ShellHandleLike extends ExecHandleLike {
  resize(cols: number, rows: number): void
}

/** Non-PTY command request (ICD §7.1 `ExecRequest`). */
export interface ExecRequestLike {
  command: string
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  maxOutputBytes?: number
  pty?: boolean
  cols?: number
  rows?: number
  term?: string
}

/** PTY request (ICD §7.1 `ShellRequest`). */
export interface ShellRequestLike {
  cols: number
  rows: number
  term?: string
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  maxOutputBytes?: number
}

/** The slice of `SessionInfo` the exec layer reads. */
export interface SessionInfoLike {
  id?: string
  label?: string
  host?: string
  user?: string
  port?: number
  state?: string
  capabilities?: { shell?: boolean; sftp?: boolean }
}

/** A live session the exec layer can start channels on. */
export interface SessionHandleLike {
  readonly id: string
  readonly info?: SessionInfoLike
  readonly state?: string
  exec(req: ExecRequestLike): Promise<ExecHandleLike>
  shell(req: ShellRequestLike): Promise<ShellHandleLike>
}

/** Session states from which a new channel may be started. */
const USABLE_STATES = new Set(['connected', 'idle', 'authenticating', 'connecting'])

/**
 * Whether a session is worth trying to start a channel on.
 *
 * `state` is optional in the structural mirror because a pool implementation
 * may expose it only through `info.state`; both are consulted. An unknown state
 * string is accepted (forward compatibility), while the explicitly closed
 * states are refused before a channel is even attempted.
 */
export function sessionStateOf(session: SessionHandleLike): string | undefined {
  const direct = session.state
  if (typeof direct === 'string' && direct.length > 0) return direct
  const nested = session.info?.state
  return typeof nested === 'string' && nested.length > 0 ? nested : undefined
}

export function isClosedState(state: string | undefined): boolean {
  if (state === undefined) return false
  return !USABLE_STATES.has(state)
}

/**
 * Duck-type a value as an exec-capable session.
 *
 * Used at the integration seam (`resolveSession` may be fed anything) so a
 * wiring mistake surfaces as `SSH_STATE_INVALID` on the call instead of a
 * `TypeError` deep inside the frame pump.
 */
export function isSessionHandle(value: unknown): value is SessionHandleLike {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as { id?: unknown; exec?: unknown; shell?: unknown }
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.exec === 'function' &&
    typeof candidate.shell === 'function'
  )
}

/** Convenience alias used by the frame layer for the kind of a stream. */
export type { StreamKind }
