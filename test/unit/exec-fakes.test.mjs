/**
 * Shared test doubles for the `exec*`/`shell*` unit tests.
 *
 * This module contains **no test cases** — it is a fixture library loaded by
 * `test/unit/exec*.test.mjs` and `test/unit/shell*.test.mjs`. It lives under the
 * `exec*.test.mjs` name because that is this owner's declared write scope in the
 * shared task; the file itself asserts nothing.
 *
 * Everything here is deliberately dependency-free so the exec layer can be
 * driven deterministically: no sockets, no real timers, no ssh2.
 */

/** A manual clock, so timeout escalation is asserted instead of slept through. */
export class ManualTimers {
  constructor(start = 0) {
    this.now = start
    this.handles = []
    this.nextId = 1
  }

  setTimeout(fn, ms) {
    const handle = { id: this.nextId++, fn, at: this.now + Math.max(0, ms), cancelled: false, fired: false }
    this.handles.push(handle)
    return handle
  }

  clearTimeout(handle) {
    if (handle !== null && typeof handle === 'object') handle.cancelled = true
  }

  /** Timers still armed. */
  get pending() {
    return this.handles.filter((handle) => !handle.cancelled && !handle.fired).length
  }

  /** Fire every timer due within `ms` of virtual time, in due order. */
  async advance(ms) {
    const target = this.now + ms
    for (;;) {
      const due = this.handles
        .filter((handle) => !handle.cancelled && !handle.fired && handle.at <= target)
        .sort((left, right) => left.at - right.at)[0]
      if (due === undefined) break
      due.fired = true
      this.now = due.at
      due.fn()
      // Give the promise chains the callback started a chance to settle.
      await Promise.resolve()
      await Promise.resolve()
    }
    this.now = Math.max(this.now, target)
  }
}

/** One fake channel, recording everything the exec layer does to it. */
export class FakeExecHandle {
  constructor(streamId = 'st_fake') {
    this.streamId = streamId
    this.dataListeners = new Set()
    this.exitListeners = new Set()
    this.writes = []
    this.signals = []
    this.cancelled = 0
    this.endedInput = 0
    this.resizes = []
    this.exitEvent = null
  }

  onData(cb) {
    this.dataListeners.add(cb)
    return () => this.dataListeners.delete(cb)
  }

  onExit(cb) {
    this.exitListeners.add(cb)
    return () => this.exitListeners.delete(cb)
  }

  write(data) {
    this.writes.push(data)
  }

  signal(sig) {
    this.signals.push(sig)
  }

  cancel() {
    this.cancelled += 1
  }

  /** ICD §7.1 has no EOF method yet; present one to prove the duck-typed path. */
  endInput() {
    this.endedInput += 1
  }

  resize(cols, rows) {
    this.resizes.push({ cols, rows })
  }

  /** Push output as the remote channel would. */
  emit(channel, chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')
    for (const listener of [...this.dataListeners]) listener(channel, bytes)
  }

  /** Report the terminal event. */
  exit(event) {
    const normalised = { durationMs: 5, timedOut: false, ...event }
    this.exitEvent = normalised
    for (const listener of [...this.exitListeners]) listener(normalised)
  }

  get listeners() {
    return this.dataListeners.size + this.exitListeners.size
  }
}

/** A session handle that hands out {@link FakeExecHandle} instances. */
export class FakeSession {
  constructor(options = {}) {
    this.id = options.id ?? 's_test'
    this.state = options.state ?? 'connected'
    this.info = {
      id: this.id,
      label: options.label ?? 'test',
      host: options.host ?? 'example.test',
      user: options.user ?? 'tester',
      capabilities: options.capabilities ?? { shell: true, sftp: true },
      state: this.state,
    }
    this.execRequests = []
    this.shellRequests = []
    this.execError = options.execError
    this.shellError = options.shellError
    this.handle = null
    this.shellHandle = null
  }

  async exec(request) {
    this.execRequests.push(request)
    if (this.execError !== undefined) throw this.execError
    this.handle = new FakeExecHandle(`st_fake_exec_${this.execRequests.length}`)
    return this.handle
  }

  async shell(request) {
    this.shellRequests.push(request)
    if (this.shellError !== undefined) throw this.shellError
    this.shellHandle = new FakeExecHandle(`st_fake_shell_${this.shellRequests.length}`)
    return this.shellHandle
  }

  async sftp() {
    throw new Error('not used by exec tests')
  }

  rttMs() {
    return 12
  }

  async close() {}
}

/** Let the runner's async channel-open continuation run. */
export async function flush() {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

/**
 * Wait until `predicate()` holds, flushing in between.
 *
 * Used instead of bare sleep so a slow machine cannot turn a race into a
 * flake: the predicate is the condition, the iteration cap is the failure.
 */
export async function waitFor(predicate, attempts = 200) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return true
    await flush()
  }
  throw new Error('waitFor: condition never became true')
}

/** Subscribe a collector to a stream; replayed frames are included. */
export function collect(hub, streamId, options = {}) {
  const frames = []
  const subscription = hub.subscribe(streamId, (frame) => frames.push(frame), options)
  return { frames, subscription }
}

/** All data frames of one stream, concatenated per channel. */
export function dataByChannel(frames, encoding = 'utf8') {
  const out = {}
  for (const frame of frames) {
    if (frame.t !== 'data') continue
    const bucket = (out[frame.channel] ??= [])
    bucket.push(frame.encoding === 'base64' ? Buffer.from(frame.chunk, 'base64') : Buffer.from(frame.chunk, 'utf8'))
  }
  const text = {}
  for (const [channel, pieces] of Object.entries(out)) text[channel] = Buffer.concat(pieces).toString(encoding)
  return { buffers: out, text }
}

/** Every frame type in order, for compact assertions. */
export function kinds(frames) {
  return frames.map((frame) => (frame.t === 'data' ? `data:${frame.channel}` : frame.t))
}

/** A Promise that never resolves, used to keep an assertion from hanging. */
export function withTimeout(promise, ms, label = 'promise') {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms} ms`)), ms)
      timer.unref?.()
    }),
  ])
}
