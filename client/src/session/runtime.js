/**
 * @module ssh.session.runtime
 * @order 310
 *
 * The session workspace data plane: stream buffers, directory caches, transfer
 * progress and the audit feed, plus every host call the four session components
 * need.
 *
 * **Why it exists.** The frozen component props (ICD §8.3) carry identity
 * (`sessionId`, `streamId`, roots) but not payloads: nothing in them says where
 * terminal bytes, directory listings or transfer progress come from, and the frozen
 * store (§8.2) has no stream buffers either. Rather than change the contract, the
 * workspace keeps its own feed here and components read it. A container that
 * already holds the data simply passes it through the optional props and this
 * module stays out of the way.
 *
 * **Layering.** Components never touch the transport. This module owns the only
 * host calls, and even here the store wins: every action first looks for
 * `app.actions.<sameName>` (SP5 owns connection/session policy) and only falls back
 * to the bridge injected through `configure({ bridge, app })`. If nothing is wired
 * yet the call rejects with a structured `SSH_STATE_INVALID` instead of throwing,
 * so a half-installed plugin renders an explained empty state rather than a blank
 * tab.
 *
 * **Frame discipline.** Frames arrive in the ICD §3 shape. Ingestion is the one
 * place that enforces the client-side half of the scheduling invariants: `data.seq`
 * is de-duplicated (a reconnect re-subscribes with `sinceSeq`), a stream reaches a
 * terminal state exactly once, and `progress.transferred` never moves backwards.
 */

SSH.define('ssh.session.runtime', function (SSH) {
  const { useSyncExternalStore } = SSH.react

  /** Buffered chunks per stream; the emulator holds the real scrollback. */
  const MAX_CHUNKS = 4000
  /** Per-channel text kept for copy/export, capped like the host's maxOutputBytes. */
  const MAX_TEXT = 262144
  /** Directory listings are cached per (session, pane, path). */
  const MAX_DIRECTORY_ENTRIES = 20000

  // ── wiring ────────────────────────────────────────────────────────────────

  let wiring = { bridge: null, app: null }
  let wiringRevision = 0
  const wiringListeners = new Set()

  /**
   * Hand the workspace its transport. Called once by the plugin body with
   * `{ bridge, app }`; safe to call again after a reconnect or in tests.
   */
  function configure(next) {
    if (!next) return wiring
    wiring = {
      bridge: next.bridge ?? wiring.bridge,
      app: next.app ?? wiring.app,
    }
    wiringRevision += 1
    for (const listener of [...wiringListeners]) {
      try {
        listener(wiring)
      } catch (error) {
        console.error('[dsh-ssh] runtime wiring listener failed', error)
      }
    }
    emit()
    return wiring
  }

  function isWired() {
    discover()
    return Boolean(wiring.bridge && typeof wiring.bridge.call === 'function')
  }

  function app() {
    discover()
    return wiring.app ?? null
  }

  /**
   * Opportunistic wiring.
   *
   * The plugin body owns the bridge and the store and hands them over through
   * `configure()`. Until that call exists (or if a composition forgets it), the
   * *published* plugin runtime is read once through the module registry: that keeps a
   * mounted workspace usable - a terminal you cannot type into is worse than a
   * documented fallback - without reaching into anyone else's module internals.
   *
   * An explicit `configure()` always wins, this never throws, and it is a no-op once
   * a bridge is known.
   */
  function discover() {
    if (wiring.bridge && typeof wiring.bridge.call === 'function') return wiring
    try {
      const plugin = SSH.require('ssh.plugin')
      const face = plugin && typeof plugin.currentRuntime === 'function' ? plugin.currentRuntime() : null
      if (face && (face.bridge || face.app)) {
        wiring = { bridge: face.bridge ?? wiring.bridge, app: face.app ?? wiring.app }
      }
    } catch {
      /* a partial bundle may not carry the plugin body; that is not an error here */
    }
    return wiring
  }

  /** The store action of this name, when SP5 published one. */
  function delegate(name) {
    const actions = wiring.app && wiring.app.actions
    const candidate = actions ? actions[name] : null
    return typeof candidate === 'function' ? candidate : null
  }

  function wiringError(method) {
    return {
      code: 'SSH_STATE_INVALID',
      message: `session runtime is not wired to the host (${method}); call ssh.session.runtime.configure({ bridge, app })`,
      retryable: false,
    }
  }

  /** Call a unary host method: the store action first, then the bridge. */
  function callHost(method, params, opts) {
    const storeAction = delegate(method)
    if (storeAction) return Promise.resolve(storeAction(params, opts))
    if (!isWired()) return Promise.reject(wiringError(method))
    return wiring.bridge.call(method, params, opts)
  }

  /**
   * Lifecycle logging for the data plane.
   *
   * "The terminal shows nothing" has three very different causes — the shell was never
   * requested, it was requested but no carrier could be resolved, or it opened and the
   * frames never arrived — and the console is the only place that distinguishes them.
   * Same idea as the chrome's `rpc send/recv` lines.
   */
  function trace(message, details) {
    if (details === undefined) console.info(`[dsh-ssh] ${message}`)
    else console.info(`[dsh-ssh] ${message}`, details)
  }

  function traceError(message, error) {
    console.warn(`[dsh-ssh] ${message}`, {
      code: error && error.code ? error.code : undefined,
      message: error && error.message ? error.message : String(error),
    })
  }

  // ── change notification ───────────────────────────────────────────────────

  const listeners = new Set()
  let revision = 0

  function emit() {
    revision += 1
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[dsh-ssh] session runtime listener failed', error)
      }
    }
  }

  function subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  /** Re-render on any workspace change (used by the containers in tests). */
  function useRevision() {
    return useSyncExternalStore(subscribe, () => revision, () => revision)
  }

  /** Re-render when the wiring changes (bridge becomes available, or is replaced). */
  function useWiringRevision() {
    return useSyncExternalStore(
      (listener) => {
        wiringListeners.add(listener)
        return () => wiringListeners.delete(listener)
      },
      () => wiringRevision,
      () => wiringRevision,
    )
  }

  // ── chunk decoding ────────────────────────────────────────────────────────

  function base64ToBytes(chunk) {
    try {
      const decode = typeof atob === 'function' ? atob : null
      if (!decode) return null
      const binary = decode(String(chunk))
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index) & 0xff
      return bytes
    } catch {
      return null
    }
  }

  function bytesToText(bytes) {
    if (!bytes) return ''
    try {
      if (typeof TextDecoder === 'function') return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    } catch {
      /* fall through to a latin1 projection */
    }
    let text = ''
    for (const byte of bytes) text += String.fromCharCode(byte)
    return text
  }

  /** Decode a `data` frame chunk into text (for reading) and bytes (for xterm). */
  function decodeChunk(chunk, encoding) {
    if (encoding === 'base64') {
      const bytes = base64ToBytes(chunk)
      return { text: bytesToText(bytes), bytes }
    }
    return { text: typeof chunk === 'string' ? chunk : String(chunk ?? ''), bytes: null }
  }

  // ── stream registry ───────────────────────────────────────────────────────

  const streams = new Map()
  /** Local placeholder id → the stream id the host reported on `open`. */
  const aliases = new Map()
  /** streamId → the live transport handle, for cancel/reconnect. */
  const handles = new Map()

  function resolveId(streamId) {
    let current = streamId
    const seen = new Set()
    while (aliases.has(current) && !seen.has(current)) {
      seen.add(current)
      current = aliases.get(current)
    }
    return current
  }

  /**
   * An id this client invented for a stream the host has not named yet.
   *
   * `attachStream` mints one per request (`<prefix>_local_<n>_<rand>`), so the marker
   * is how the runtime tells "we are still waiting for the host's name" apart from
   * "this id is already the host's".
   */
  function isOptimisticId(streamId) {
    return typeof streamId === 'string' && streamId.includes('_local_')
  }

  /**
   * The host's *own* id for a stream, once it has named it.
   *
   * `sh_local_*` is an optimistic, UI-internal id: the host knows nothing about it
   * until the `open` frame (or the stream result) hands over its `st_*`. A host call
   * made with the local id is rejected with "unknown stream" — which is exactly what
   * a resize fired from a mount effect used to do. Returns null while unknown, and
   * answers for both the local id (through the alias) and an id that is already the
   * host's (the record itself).
   */
  function hostStreamId(streamId) {
    if (typeof streamId !== 'string' || streamId === '') return null
    const resolved = resolveId(streamId)
    if (resolved !== streamId) return resolved
    const record = streams.get(streamId)
    if (!record) return null
    if (typeof record.streamId === 'string' && record.streamId !== '' && !isOptimisticId(record.streamId)) {
      return record.streamId
    }
    return null
  }

  /** A stream this client created whose host id has not arrived yet. */
  function isPendingLocal(streamId) {
    if (typeof streamId !== 'string' || streamId === '' || aliases.has(streamId)) return false
    const record = streams.get(streamId)
    return Boolean(record) && record.status === 'opening' && isOptimisticId(streamId)
  }

  /**
   * Host calls made before the stream had a host id.
   *
   * Writes and signals keep their order (bytes are not idempotent); resizes coalesce,
   * because the PTY wants the final geometry, not the history of a resizing sidebar.
   */
  const pendingCalls = new Map()

  /**
   * How long a coalesced resize waits for the stream's first byte before being sent anyway.
   *
   * The host attaches the shell channel slightly after it announces the stream, and a
   * resize inside that window comes back as "has no channel yet" — console noise for a
   * call that succeeds a moment later. A shell that prints nothing must still be sized,
   * so the wait is bounded rather than indefinite.
   */
  const RESIZE_GRACE_MS = 1500
  const resizeTimers = new Map()

  /** Hold the resize until data proves the channel is attached (or the grace expires). */
  function armResizeGrace(localId) {
    if (resizeTimers.has(localId)) return
    const timer = setTimeout(() => {
      resizeTimers.delete(localId)
      flushCalls(localId, { includeResize: true })
    }, RESIZE_GRACE_MS)
    resizeTimers.set(localId, timer)
  }

  function clearResizeGrace(localId) {
    const timer = resizeTimers.get(localId)
    if (timer) clearTimeout(timer)
    resizeTimers.delete(localId)
  }

  function queueCall(localId, entry) {
    const queue = pendingCalls.get(localId) ?? { resize: null, writes: [], signals: [], close: false, dataSeen: false }
    if (entry.kind === 'resize') queue.resize = entry.payload
    else if (entry.kind === 'write') queue.writes.push(entry.payload)
    else if (entry.kind === 'signal') queue.signals.push(entry.payload)
    else if (entry.kind === 'close') queue.close = true
    pendingCalls.set(localId, queue)
    return queue
  }

  function dropPending(localId) {
    pendingCalls.delete(localId)
  }

  function warnHostCall(method, error) {
    console.warn(`[dsh-ssh] ${method} failed`, error)
  }

  /**
   * A host call whose failure is not worth an error path.
   *
   * Resize/signal/close are advisory: if the stream already ended they fail, and an
   * unhandled rejection here surfaces in the page console (it polluted the console
   * and hid the real errors). Failures are logged, never thrown.
   */
  function callHostQuiet(method, params) {
    // An unwired runtime is a programming error, not an advisory failure: it must still
    // reject so callers and tests see the structured SSH_STATE_INVALID.
    if (!isWired()) return callHost(method, params)
    return callHostSettled(method, params).then((value) => {
      if (value && value.ok === false) warnHostCall(method, value.error)
      return value
    })
  }

  /** `callHostQuiet` without the warning: the caller decides when a failure is worth noise. */
  function callHostSettled(method, params) {
    if (!isWired()) return callHost(method, params)
    let result
    try {
      result = callHost(method, params)
    } catch (error) {
      return Promise.resolve({ ok: false, error })
    }
    // Resolve with the failure rather than handing the rejection back: the caller is often
    // a cleanup path with no catch of its own, and returning the rejecting promise is what
    // made it an unhandled rejection in the page console.
    return Promise.resolve(result).then(
      (value) => (value === undefined ? { ok: true } : value),
      (error) => ({ ok: false, error }),
    )
  }

  /** Delays for the "the stream's channel is not attached yet" retry. */
  const RESIZE_RETRY_DELAYS = [100, 200, 400]

  /**
   * Is this the transient handshake state rather than a real failure?
   *
   * The host announces a stream a moment before it attaches the shell channel, so an early
   * resize comes back as "has no channel yet": a state to wait out, not an error to shout
   * about.
   */
  function isTransientChannelError(error) {
    const message = error && error.message ? String(error.message) : ''
    return /has no channel yet|no channel yet|channel not attached/i.test(message)
  }

  /**
   * Resize with a silent backoff (100/200/400 ms) while the failure is that handshake
   * state, warning only when it keeps failing: the console stays clean for the normal
   * handshake while a genuine fault is still visible.
   */
  function callResize(params, attempt = 0) {
    return callHostSettled('shellResize', params).then((value) => {
      if (!value || value.ok !== false) return value
      if (isTransientChannelError(value.error) && attempt < RESIZE_RETRY_DELAYS.length) {
        const delay = RESIZE_RETRY_DELAYS[attempt]
        return new Promise((resolve) => setTimeout(resolve, delay)).then(() => callResize(params, attempt + 1))
      }
      warnHostCall('shellResize', value.error)
      return value
    })
  }

  /** Send everything that waited for the host id. Safe to call repeatedly. */
  function flushCalls(localId, options = {}) {
    const queue = pendingCalls.get(localId)
    if (!queue) return false
    const hostId = hostStreamId(localId)
    if (!hostId) return false
    // A resize waits for the stream's first byte (the host's shell channel attaches a
    // moment after it announces the stream), unless the grace period already expired.
    const includeResize = options.includeResize === true || queue.dataSeen === true
    const heldResize = includeResize ? null : queue.resize

    pendingCalls.delete(localId)
    if (!heldResize) clearResizeGrace(localId)
    trace('flushing queued shell calls', {
      streamId: hostId,
      writes: queue.writes.length,
      resize: includeResize ? queue.resize || null : null,
      signals: queue.signals.length,
    })
    if (queue.resize && !heldResize) callResize({ streamId: hostId, cols: queue.resize.cols, rows: queue.resize.rows })
    for (const payload of queue.signals) callHostQuiet('shellSignal', { streamId: hostId, signal: payload.signal })
    for (const payload of queue.writes) {
      try {
        const result = callHost('shellWrite', { streamId: hostId, data: payload.data, encoding: payload.encoding })
        if (result && typeof result.catch === 'function') result.catch((error) => warnHostCall('shellWrite', error))
      } catch (error) {
        warnHostCall('shellWrite', error)
      }
    }
    if (queue.close) callHostQuiet('shellClose', { streamId: hostId })
    if (heldResize) {
      // Only the newest geometry survives the wait: the channel is about to attach.
      pendingCalls.set(localId, { resize: heldResize, writes: [], signals: [], close: false, dataSeen: false })
      armResizeGrace(localId)
    }
    return true
  }

  /**
   * The stream produced its first byte: its channel is attached, so a resize is safe.
   * Called from `ingest`, which is the only place that sees data frames.
   */
  function markDataSeen(streamId) {
    if (pendingCalls.size === 0) return
    const hostId = resolveId(streamId)
    for (const localId of [...pendingCalls.keys()]) {
      if (hostStreamId(localId) !== hostId) continue
      const queue = pendingCalls.get(localId)
      if (!queue) continue
      queue.dataSeen = true
      flushCalls(localId)
    }
  }

  /** Adopt the host id a stream result reported, when the `open` frame did not. */
  function adoptHostId(localId, hostId) {
    if (typeof hostId !== 'string' || hostId === '' || hostId === localId) return false
    if (aliases.has(localId)) return false
    aliases.set(localId, hostId)
    const record = streams.get(localId)
    if (record) {
      record.streamId = hostId
      if (streams.has(localId)) {
        streams.delete(localId)
        streams.set(hostId, record)
      }
      record.version += 1
    }
    return true
  }

  function emptyStream(streamId, init) {
    return {
      streamId,
      kind: (init && init.kind) || 'shell',
      meta: (init && init.meta) || null,
      status: 'opening',
      channels: { stdout: [], stderr: [], term: [] },
      chunks: [],
      text: { stdout: '', stderr: '', term: '' },
      bytes: 0,
      lastSeq: typeof (init && init.sinceSeq) === 'number' ? init.sinceSeq - 1 : -1,
      exit: null,
      end: null,
      error: null,
      progress: null,
      startedAt: Date.now(),
      version: 0,
    }
  }

  function ensureStream(streamId, init) {
    if (typeof streamId !== 'string' || streamId === '') return null
    const id = resolveId(streamId)
    const existing = streams.get(id)
    if (existing) {
      if (init && init.kind && existing.kind !== init.kind) existing.kind = init.kind
      if (init && init.meta && !existing.meta) existing.meta = init.meta
      return existing
    }
    const created = emptyStream(id, init)
    streams.set(id, created)
    return created
  }

  function getStream(streamId) {
    if (typeof streamId !== 'string') return null
    return streams.get(resolveId(streamId)) ?? null
  }

  function trimChunks(list) {
    if (list.length > MAX_CHUNKS) list.splice(0, list.length - MAX_CHUNKS)
  }

  function appendText(previous, addition) {
    const next = previous + addition
    return next.length > MAX_TEXT ? next.slice(next.length - MAX_TEXT) : next
  }

  /**
   * Merge one frame into the registry.
   *
   * Returns the affected stream record, or null for frames this module does not
   * own (`state`/`audit`, which are handled by their own registries).
   */
  function ingest(frame) {
    if (!frame || typeof frame.t !== 'string') return null
    const streamId = typeof frame.streamId === 'string' ? frame.streamId : null

    if (frame.t === 'open') {
      const record = ensureStream(streamId, { kind: frame.kind, meta: frame.meta })
      if (record) {
        record.status = 'open'
        record.version += 1
      }
      emit()
      return record
    }

    if (frame.t === 'data') {
      const record = ensureStream(streamId, { kind: frame.channel === 'term' ? 'shell' : 'exec' })
      if (!record) return null
      if (typeof frame.seq === 'number') {
        // A reconnect resumes with `sinceSeq`, so the same bytes may arrive twice.
        if (frame.seq <= record.lastSeq) return record
        record.lastSeq = frame.seq
      }
      const decoded = decodeChunk(frame.chunk, frame.encoding)
      const channel = frame.channel === 'stderr' || frame.channel === 'stdout' ? frame.channel : 'term'
      const entry = { seq: frame.seq, channel, text: decoded.text, bytes: decoded.bytes }
      record.channels[channel].push(entry)
      // One chronological view across channels: a consumer that renders the stream
      // (the terminal) must see stdout/stderr in the order the host emitted them.
      record.chunks.push(entry)
      trimChunks(record.channels[channel])
      trimChunks(record.chunks)
      record.text[channel] = appendText(record.text[channel], decoded.text)
      record.bytes += decoded.bytes ? decoded.bytes.length : decoded.text.length
      if (record.status === 'opening') record.status = 'open'
      record.version += 1
      // The first byte means the host attached the stream's channel: a resize is now
      // safe (see `RESIZE_GRACE_MS`).
      if (record.bytes > 0) markDataSeen(frame.streamId)
      emit()
      return record
    }

    if (frame.t === 'progress') {
      const record = ensureStream(streamId, {})
      if (!record) return null
      const transferred = Math.max(record.progress ? record.progress.transferred : 0, Number(frame.transferred) || 0)
      record.progress = {
        transferred,
        totalBytes: typeof frame.totalBytes === 'number' ? frame.totalBytes : record.progress ? record.progress.totalBytes : undefined,
        bytesPerSec: Number(frame.bytesPerSec) || 0,
        etaMs: typeof frame.etaMs === 'number' ? frame.etaMs : undefined,
        phase: frame.phase || 'transfer',
      }
      ingestTransferProgress(record, frame)
      record.version += 1
      emit()
      return record
    }

    if (frame.t === 'exit') {
      const record = ensureStream(streamId, {})
      if (!record) return null
      record.exit = {
        exitCode: typeof frame.exitCode === 'number' ? frame.exitCode : null,
        signal: frame.signal,
        durationMs: Number(frame.durationMs) || 0,
        timedOut: frame.timedOut === true,
      }
      record.version += 1
      emit()
      return record
    }

    if (frame.t === 'end') {
      const record = ensureStream(streamId, {})
      if (!record) return null
      // Exactly one terminal transition per stream, whatever the transport repeats.
      if (record.end === null) {
        record.end = { reason: frame.reason, error: frame.error }
        record.error = frame.error || null
        record.status =
          frame.reason === 'completed' ? 'ended' : frame.reason === 'cancelled' ? 'cancelled' : frame.reason === 'timeout' ? 'timeout' : 'error'
        finishTransfer(record, frame.reason)
      }
      record.version += 1
      emit()
      return record
    }

    if (frame.t === 'state') {
      ingestState(frame)
      return null
    }

    if (frame.t === 'audit') {
      ingestAudit(frame.entry)
      return null
    }

    return null
  }

  /** Plain text collected for one channel of one stream ('' when unknown). */
  function streamText(streamId, channel) {
    const record = getStream(streamId)
    if (!record) return ''
    return record.text[channel ?? 'term'] ?? ''
  }

  /** Open a transport stream and route its frames through `ingest`. */
  function attachStream(method, params, localId, init) {
    const record = ensureStream(localId, init)
    if (!isWired()) {
      const error = wiringError(method)
      traceError(`${method} not requested: the runtime is not wired`, error)
      if (record) {
        record.status = 'error'
        record.error = error
        record.end = { reason: 'error', error }
        record.version += 1
      }
      emit()
      return { streamId: null, localId, ready: Promise.resolve({ streamId: null, error }), cancel() {}, record }
    }
    let settled = false
    let resolveReady = () => {}
    const ready = new Promise((resolve) => {
      resolveReady = resolve
    })
    const handle = wiring.bridge.stream(
      method,
      params,
      (frame) => {
        if (frame && frame.t === 'open' && typeof frame.streamId === 'string') {
          const openId = frame.streamId
          aliases.set(localId, openId)
          if (openId !== localId && record && streams.has(localId)) {
            streams.delete(localId)
            streams.set(openId, record)
            record.streamId = openId
          }
          handles.set(openId, handle)
          trace(`${method} open`, { hostStreamId: openId, localId })
          // The host just named the stream: everything that waited for that name
          // (the mount-effect resize, keystrokes typed before the PTY existed) goes
          // out now, addressed to the host id.
          flushCalls(localId)
          if (!settled) {
            settled = true
            resolveReady({ streamId: openId, record })
          }
        }
        if (frame && frame.t === 'end' && frame.error) {
          traceError(`${method} ended with an error`, frame.error)
        }
        ingest(frame)
      },
      params && params.signal ? { signal: params.signal } : undefined,
    )
    handles.set(localId, handle)

    // The handle resolves its own stream id once the host's result lands.
    Promise.resolve(handle.done)
      .then((state) => {
        // Some carriers report the stream id only in the result, without an `open`
        // frame: adopt it so queued calls still reach the right stream.
        if (adoptHostId(localId, handle.streamId)) {
          emit()
          flushCalls(localId)
        }
        // A stream that never produced an `open` frame usually means no carrier could
        // be resolved; say so instead of leaving the terminal blank.
        if (state && state.error) traceError(`${method} could not be opened`, state.error)
        if (!settled) {
          settled = true
          resolveReady({ streamId: handle.streamId ?? null, record })
        }
      })
      .catch((error) => {
        // A stream that never opened cannot receive the queued calls: drop them
        // rather than replaying them against a name the host never issued.
        dropPending(localId)
        traceError(`${method} failed`, error)
        if (!settled) {
          settled = true
          resolveReady({ streamId: handle.streamId ?? null, record, error: wiringError(method) })
        }
      })

    return {
      streamId: null,
      localId,
      record,
      ready,
      cancel() {
        try {
          handle.cancel()
        } catch (error) {
          console.error('[dsh-ssh] stream cancel failed', error)
        }
      },
      handle,
    }
  }

  function cancelStream(streamId) {
    const id = resolveId(streamId)
    const handle = handles.get(id) ?? handles.get(streamId)
    if (handle && typeof handle.cancel === 'function') {
      handle.cancel()
      return true
    }
    return false
  }

  let localCounter = 0
  function nextLocalId(prefix) {
    localCounter += 1
    return `${prefix}_local_${localCounter}_${Math.random().toString(36).slice(2, 8)}`
  }

  // ── session states ────────────────────────────────────────────────────────

  const sessionStates = new Map()

  function ingestState(frame) {
    if (typeof frame.sessionId !== 'string') return
    sessionStates.set(frame.sessionId, {
      sessionId: frame.sessionId,
      state: frame.state,
      error: frame.error || null,
      at: Date.now(),
    })
    emit()
  }

  function sessionState(sessionId) {
    return sessionStates.get(sessionId) ?? null
  }

  // ── transfers ─────────────────────────────────────────────────────────────

  const transfers = new Map()
  let transfersRevision = 0

  function emptyTransfer(opId, params) {
    return {
      opId,
      streamId: null,
      direction: params.direction,
      localPath: params.localPath,
      remotePath: params.remotePath,
      totalBytes: undefined,
      transferred: 0,
      phase: 'scan',
      bytesPerSec: 0,
      etaMs: undefined,
      resumeFrom: params.resumeFrom ?? 0,
      status: 'running',
      error: null,
      startedAt: Date.now(),
      version: 0,
    }
  }

  function ingestTransferProgress(record, frame) {
    const opId = (record.meta && record.meta.opId) || record.localOpId || record.streamId
    if (!opId) return
    const task = transfers.get(opId) ?? {
      ...emptyTransfer(opId, {
        direction: record.kind === 'download' ? 'download' : 'upload',
        localPath: record.meta?.localPath ?? '',
        remotePath: record.meta?.remotePath ?? '',
      }),
      streamId: record.streamId,
    }
    task.transferred = record.progress.transferred
    task.totalBytes = record.progress.totalBytes
    task.bytesPerSec = record.progress.bytesPerSec
    task.etaMs = record.progress.etaMs
    task.phase = record.progress.phase
    task.streamId = record.streamId
    task.version += 1
    transfers.set(opId, task)
    transfersRevision += 1
  }

  function finishTransfer(record, reason) {
    const opId = (record.meta && record.meta.opId) || record.localOpId || record.streamId
    const task = opId ? transfers.get(opId) : null
    if (!task) return
    task.phase = reason === 'completed' ? 'done' : reason === 'cancelled' ? 'cancelled' : 'error'
    task.status = reason === 'completed' ? 'done' : reason === 'cancelled' ? 'cancelled' : 'error'
    if (record.error) task.error = record.error
    if (typeof task.totalBytes === 'number' && task.status === 'done') task.transferred = task.totalBytes
    task.version += 1
    transfersRevision += 1
  }

  function listTransfers() {
    return [...transfers.values()].sort((a, b) => a.startedAt - b.startedAt)
  }

  function startTransfer(direction, params) {
    const opId = params.opId || nextLocalId('op')
    const task = emptyTransfer(opId, { ...params, direction })
    transfers.set(opId, task)
    transfersRevision += 1
    const stream = attachStream(direction, { ...params }, nextLocalId(direction), {
      kind: direction,
      meta: { ...params, opId },
    })
    if (stream.record) stream.record.localOpId = opId
    task.streamId = stream.localId
    return { opId, streamId: stream.streamId, localId: stream.localId, stream, ready: stream.ready }
  }

  // ── directories ───────────────────────────────────────────────────────────

  const directories = new Map()

  function directoryKey(sessionId, pane, path) {
    return `${sessionId ?? '-'}|${pane}|${path ?? ''}`
  }

  function getDirectory(sessionId, pane, path) {
    return directories.get(directoryKey(sessionId, pane, path)) ?? null
  }

  function setDirectory(sessionId, pane, path, patch) {
    const key = directoryKey(sessionId, pane, path)
    const current = directories.get(key) ?? {
      key,
      sessionId,
      pane,
      path,
      cwd: path,
      entries: [],
      loading: false,
      error: null,
      loadedAt: 0,
      version: 0,
    }
    const next = { ...current, ...patch, version: current.version + 1 }
    directories.set(key, next)
    emit()
    return next
  }

  /** Load a remote directory through `listDir` (store action wins over bridge). */
  async function loadRemoteDir(options) {
    const { sessionId, path, showHidden } = options || {}
    if (!sessionId || !path) return null
    setDirectory(sessionId, 'remote', path, { loading: true, error: null })
    try {
      const result = await callHost('listDir', { sessionId, path, showHidden: showHidden === true })
      const entries = Array.isArray(result && result.entries) ? result.entries.slice(0, MAX_DIRECTORY_ENTRIES) : []
      return setDirectory(sessionId, 'remote', path, {
        entries,
        cwd: (result && result.cwd) || path,
        loading: false,
        error: null,
        loadedAt: Date.now(),
      })
    } catch (error) {
      return setDirectory(sessionId, 'remote', path, { loading: false, error, loadedAt: Date.now() })
    }
  }

  /**
   * Load a local directory through `listLocalDir` (ICD v1.0.2 §4.5).
   *
   * The browser cannot read the filesystem, so this endpoint is host-side; until
   * the host answers, the pane shows an explained empty state instead of pretending
   * the folder is empty.
   */
  async function loadLocalDir(options) {
    const { sessionId, path, showHidden } = options || {}
    if (!path) return null
    setDirectory(sessionId ?? 'local', 'local', path, { loading: true, error: null })
    try {
      const result = await callHost('listLocalDir', { path, showHidden: showHidden === true })
      const entries = Array.isArray(result && result.entries) ? result.entries.slice(0, MAX_DIRECTORY_ENTRIES) : []
      return setDirectory(sessionId ?? 'local', 'local', path, {
        entries,
        cwd: (result && result.cwd) || path,
        loading: false,
        error: null,
        loadedAt: Date.now(),
      })
    } catch (error) {
      return setDirectory(sessionId ?? 'local', 'local', path, { loading: false, error, loadedAt: Date.now() })
    }
  }

  // ── audit ─────────────────────────────────────────────────────────────────

  let audit = { entries: [], total: 0, loading: false, error: null, follow: null }
  let auditRevision = 0

  function ingestAudit(entry) {
    if (!entry || typeof entry !== 'object') return
    const existing = audit.entries
    // Newest first, matching what the logs tab renders.
    audit = { ...audit, entries: [entry, ...existing].slice(0, 2000), total: audit.total + 1 }
    auditRevision += 1
    emit()
  }

  async function refreshAudit(query) {
    const params = query || {}
    audit = { ...audit, loading: true, error: null }
    auditRevision += 1
    emit()
    try {
      const result = await callHost('queryAudit', {
        limit: params.limit ?? 200,
        offset: params.offset ?? 0,
        sessionId: params.sessionId,
        since: params.since,
        kinds: params.kinds,
      })
      const entries = Array.isArray(result && result.entries) ? result.entries : []
      audit = { ...audit, entries, total: (result && result.total) ?? entries.length, loading: false, error: null }
      auditRevision += 1
      emit()
      return audit
    } catch (error) {
      audit = { ...audit, loading: false, error }
      auditRevision += 1
      emit()
      return audit
    }
  }

  /** Subscribe to `followAudit`; returns a cancel function. */
  function followAudit(sessionId) {
    const storeAction = delegate('followAudit')
    if (storeAction) {
      const dispose = storeAction({ sessionId })
      audit = { ...audit, follow: typeof dispose === 'function' ? dispose : null }
      auditRevision += 1
      emit()
      return typeof dispose === 'function' ? dispose : () => {}
    }
    if (!isWired()) return () => {}
    const handle = wiring.bridge.stream('followAudit', { sessionId }, (frame) => ingest(frame))
    audit = { ...audit, follow: () => handle.cancel() }
    auditRevision += 1
    emit()
    return () => handle.cancel()
  }

  // ── directories: props/registry helpers ───────────────────────────────────

  function useStream(streamId) {
    const version = useSyncExternalStore(
      subscribe,
      () => {
        const record = getStream(streamId)
        return record ? record.version : -1
      },
      () => {
        const record = getStream(streamId)
        return record ? record.version : -1
      },
    )
    return { record: getStream(streamId), version }
  }

  function useTransfers() {
    const version = useSyncExternalStore(subscribe, () => transfersRevision, () => transfersRevision)
    return { transfers: listTransfers(), version }
  }

  function useAudit() {
    const version = useSyncExternalStore(subscribe, () => auditRevision, () => auditRevision)
    return { audit, version }
  }

  function useDirectory(sessionId, pane, path) {
    const version = useSyncExternalStore(
      subscribe,
      () => {
        const record = getDirectory(sessionId, pane, path)
        return record ? record.version : -1
      },
      () => {
        const record = getDirectory(sessionId, pane, path)
        return record ? record.version : -1
      },
    )
    return { directory: getDirectory(sessionId, pane, path), version }
  }

  function useSessionState(sessionId) {
    const version = useSyncExternalStore(subscribe, () => revision, () => revision)
    return { state: sessionState(sessionId), version }
  }

  // ── dangerous-operation confirmation ──────────────────────────────────────

  let confirmHandler = null

  /** Inject a programmatic confirmer (tests, or a container that owns a dialog). */
  function setConfirmHandler(handler) {
    confirmHandler = typeof handler === 'function' ? handler : null
    return () => {
      confirmHandler = null
    }
  }

  /**
   * Ask for confirmation before a dangerous operation.
   *
   * Resolution order: an injected handler, then SP7's confirm module when it
   * exposes a programmatic entry point, then a refusal. **Failing closed is the
   * point**: an unwired confirmation must not silently authorise a delete.
   */
  async function requestConfirm(request) {
    const ask = request || {}
    if (confirmHandler) {
      const answer = await confirmHandler(ask)
      return answer === true || (answer && answer.confirmed === true)
    }
    try {
      const chrome = SSH.require('ssh.chrome.confirm')
      const candidate = chrome && (chrome.confirm || chrome.requestConfirm || chrome.prompt)
      if (typeof candidate === 'function') {
        const answer = await candidate(ask)
        return answer === true || (answer && answer.confirmed === true)
      }
    } catch {
      /* the chrome module is optional and may not exist yet */
    }
    return false
  }

  // ── actions ───────────────────────────────────────────────────────────────

  const actions = {
    // ── interactive shell ──
    openShell(params) {
      const storeAction = delegate('openShell')
      if (storeAction) return storeAction(params)
      const localId = nextLocalId('sh')
      trace('openShell requested', {
        sessionId: params && params.sessionId,
        cols: params && params.cols,
        rows: params && params.rows,
        localId,
      })
      return attachStream('openShell', { ...params }, localId, { kind: 'shell', sinceSeq: params && params.sinceSeq })
    },
    shellWrite(streamId, data, encoding) {
      const storeAction = delegate('shellWrite')
      if (storeAction) return Promise.resolve(storeAction(streamId, data, encoding))
      const payload = { data, encoding: encoding || 'utf8' }
      const hostId = hostStreamId(streamId)
      if (hostId) return callHost('shellWrite', { streamId: hostId, ...payload })
      if (isPendingLocal(streamId)) {
        // Typed before the PTY was named: keep the bytes and their order, and deliver
        // them the moment the host names the stream.
        queueCall(streamId, { kind: 'write', payload })
        return Promise.resolve({ queued: true })
      }
      // An id this runtime does not own: forward it untouched and let the host answer,
      // rather than dropping the call silently.
      return callHost('shellWrite', { streamId: resolveId(streamId), ...payload })
    },
    shellResize(streamId, cols, rows) {
      const storeAction = delegate('shellResize')
      if (storeAction) return Promise.resolve(storeAction(resolveId(streamId), cols, rows))
      const hostId = hostStreamId(streamId)
      if (hostId) return callResize({ streamId: hostId, cols, rows })
      if (isPendingLocal(streamId)) {
        // Fired by a mount effect, usually before `open`: remember the newest size.
        queueCall(streamId, { kind: 'resize', payload: { cols, rows } })
        return Promise.resolve({ queued: true })
      }
      return callResize({ streamId: resolveId(streamId), cols, rows })
    },
    shellSignal(streamId, signal) {
      const storeAction = delegate('shellSignal')
      if (storeAction) return Promise.resolve(storeAction(resolveId(streamId), signal))
      const hostId = hostStreamId(streamId)
      if (hostId) return callHostQuiet('shellSignal', { streamId: hostId, signal })
      if (isPendingLocal(streamId)) {
        queueCall(streamId, { kind: 'signal', payload: { signal } })
        return Promise.resolve({ queued: true })
      }
      return callHostQuiet('shellSignal', { streamId: resolveId(streamId), signal })
    },
    shellClose(streamId) {
      const storeAction = delegate('shellClose')
      if (storeAction) return Promise.resolve(storeAction(resolveId(streamId)))
      const hostId = hostStreamId(streamId)
      if (hostId) return callHostQuiet('shellClose', { streamId: hostId })
      if (isPendingLocal(streamId)) {
        // Nothing was ever opened on the host under this id: cancel the local request
        // instead of asking the host to close a stream it never named.
        dropPending(streamId)
        cancelStream(streamId)
        return Promise.resolve({ cancelled: true })
      }
      return callHostQuiet('shellClose', { streamId: resolveId(streamId) })
    },
    cancel: cancelStream,
    /**
     * Re-open the shell stream, resuming from the last sequence number that was
     * rendered. The buffer is kept under the same local id, so the tab does not
     * lose its scrollback when the transport drops.
     */
    reconnectShell(options) {
      const params = options || {}
      const storeAction = delegate('reconnectShell')
      if (storeAction) return storeAction(params)
      const previous = getStream(params.streamId)
      const localId = previous ? previous.streamId : nextLocalId('sh')
      if (previous) {
        previous.status = 'opening'
        previous.end = null
        previous.error = null
        previous.version += 1
      }
      const stream = attachStream(
        'openShell',
        {
          sessionId: params.sessionId,
          cols: params.cols,
          rows: params.rows,
          term: params.term,
          cwd: params.cwd,
          env: params.env,
          sinceSeq: previous && previous.lastSeq >= 0 ? previous.lastSeq + 1 : undefined,
        },
        localId,
        { kind: 'shell' },
      )
      return { ...stream, localId }
    },

    // ── command execution ──
    exec(params) {
      const storeAction = delegate('exec')
      if (storeAction) return storeAction(params)
      const localId = nextLocalId('ex')
      const stream = attachStream('exec', { ...params }, localId, { kind: 'exec' })
      const result = new Promise((resolve) => {
        const unsubscribe = subscribe(() => {
          const record = getStream(localId)
          if (!record || !record.end) return
          unsubscribe()
          resolve({
            streamId: record.streamId,
            exitCode: record.exit ? record.exit.exitCode : null,
            signal: record.exit ? record.exit.signal : undefined,
            durationMs: record.exit ? record.exit.durationMs : 0,
            timedOut: record.exit ? record.exit.timedOut === true : false,
            stdout: record.text.stdout,
            stderr: record.text.stderr,
            truncated: {
              stdout: record.error ? record.error.code === 'SSH_LIMIT_OUTPUT_TRUNCATED' : false,
              stderr: record.error ? record.error.code === 'SSH_LIMIT_OUTPUT_TRUNCATED' : false,
            },
          })
        })
      })
      return { ...stream, result }
    },

    // ── files ──
    listDir(params) {
      return loadRemoteDir(params)
    },
    listLocalDir(params) {
      return loadLocalDir(params)
    },
    stat(params) {
      return callHost('stat', params)
    },
    statLocal(params) {
      return callHost('statLocal', params)
    },
    mkdir(params) {
      return callHost('mkdir', params)
    },
    rename(params) {
      return callHost('rename', params)
    },
    removePath(params) {
      // `removePath`, not `remove`: the Gateway's namespace service owns `remove`
      // itself, so a Remote method with that name is refused when the client mounts
      // our contribution (see client/src/bridge.js).
      return callHost('removePath', params)
    },
    chmod(params) {
      return callHost('chmod', params)
    },
    upload(params) {
      const storeAction = delegate('upload')
      if (storeAction) return storeAction(params)
      return startTransfer('upload', params)
    },
    download(params) {
      const storeAction = delegate('download')
      if (storeAction) return storeAction(params)
      return startTransfer('download', params)
    },
    cancelTransfer(opId) {
      const storeAction = delegate('cancelTransfer')
      if (storeAction) return Promise.resolve(storeAction(opId))
      const task = transfers.get(opId)
      if (task && task.streamId && cancelStream(task.streamId)) {
        task.status = 'cancelled'
        task.phase = 'cancelled'
        task.version += 1
        transfersRevision += 1
        emit()
        return Promise.resolve({ cancelled: true })
      }
      return callHost('cancelTransfer', { opId })
    },

    // ── audit ──
    refreshAudit,
    followAudit,
    clearAudit() {
      const storeAction = delegate('clearAudit')
      const request = storeAction ? Promise.resolve(storeAction({})) : callHost('clearAudit', {})
      return request.then((result) => {
        audit = { ...audit, entries: [], total: 0, error: null }
        auditRevision += 1
        emit()
        return result
      })
    },

    // ── meta ──
    requestConfirm,
    /** Ping the host; used by the workspace header to show transport health. */
    ping() {
      return callHost('ping', { echo: 'workspace' })
    },
  }

  /** Test seam: drop every buffer (a fresh session list, or between test cases). */
  function reset() {
    streams.clear()
    aliases.clear()
    handles.clear()
    pendingCalls.clear()
    transfers.clear()
    directories.clear()
    sessionStates.clear()
    audit = { entries: [], total: 0, loading: false, error: null, follow: null }
    revision += 1
    transfersRevision += 1
    auditRevision += 1
    emit()
  }

  return {
    configure,
    isWired,
    app,
    discover,
    actions,
    ingest,
    reset,
    getStream,
    streamText,
    listTransfers,
    getDirectory,
    sessionState,
    subscribe,
    useRevision,
    useWiringRevision,
    useStream,
    useTransfers,
    useAudit,
    useDirectory,
    useSessionState,
    setConfirmHandler,
    requestConfirm,
    /** For tests and diagnostics: current registry sizes. */
    stats: () => ({
      streams: streams.size,
      transfers: transfers.size,
      directories: directories.size,
      auditEntries: audit.entries.length,
      wired: isWired(),
    }),
  }
})
