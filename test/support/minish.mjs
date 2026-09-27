/**
 * A tiny, deterministic POSIX-ish shell used by the sshd double.
 *
 * The double must answer `exec` requests and drive an interactive PTY without
 * depending on a real `/bin/sh` (this machine is Windows-only and has no WSL),
 * so commands are interpreted in-process. That is a feature, not a shortcut:
 * output, exit codes, cwd and env handling are byte-for-byte reproducible, which
 * is what the integration tests need.
 *
 * Supported grammar (documented because the plugin's tests rely on it):
 *   - pipelines            `cat a | wc -c`
 *   - lists                `a; b`, `a && b`, `a || b` (also `&` → sequential)
 *   - redirections         `>`, `>>`, `<`, `2>`, `2>>`, `2>&1`, `1>&2`, `&>`
 *   - quoting              'single' (literal), "double" (with $VAR), \escapes
 *   - expansion            $VAR, ${VAR}, $?, $#, $$, ~, globs (* ?)
 *   - builtins             see BUILTIN_NAMES below, plus `sh -c '<script>'`
 *   - interactive only     line editing, history, tab completion, `top`
 *
 * Deliberately unsupported: job control, subshells `$(...)`, heredocs, `&&`-chained
 * background jobs, functions, arithmetic expansion.
 */

import { createHash } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'

/** Deterministic fixed clock: every shell command reports the same instant. */
export const FIXED_NOW = Date.UTC(2026, 0, 1, 0, 0, 0)
export const FIXED_DATE_LINE = 'Thu Jan  1 00:00:00 UTC 2026'
export const UNAME_LINE = 'Linux dsh-test 6.1.0-dshsshd #1 SMP PREEMPT_DYNAMIC x86_64 GNU/Linux'
export const SHELL_PID = 4242
/** `yes`/`seq` safety valve; callers that test truncation set `outputCap` higher. */
export const DEFAULT_OUTPUT_CAP = 16 * 1024 * 1024

// ---------------------------------------------------------------------------
// primitives: abort tokens, input sources, output sinks
// ---------------------------------------------------------------------------

export function createAbort() {
  const listeners = new Set()
  let cancelled = false
  let reason = null
  return {
    get cancelled() {
      return cancelled
    },
    get reason() {
      return reason
    },
    cancel(why = 'TERM') {
      if (cancelled) return
      cancelled = true
      reason = why
      for (const listener of listeners) {
        try {
          listener(reason)
        } catch {
          /* a listener must not break the abort path */
        }
      }
      listeners.clear()
    },
    onCancel(callback) {
      if (cancelled) {
        callback(reason)
        return () => {}
      }
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
  }
}

/** A one-shot input source over an in-memory buffer. */
export function memoryInput(data) {
  let used = false
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data ?? '', 'utf8')
  return {
    live: false,
    async read() {
      if (used || buffer.length === 0) return null
      used = true
      return buffer
    },
    async all() {
      used = true
      return buffer
    },
  }
}

/** A live input source fed by an SSH channel (used by `cat` and friends). */
export function queueInput() {
  const chunks = []
  let waiter = null
  let eof = false
  const wake = () => {
    if (!waiter) return
    const resolve = waiter
    waiter = null
    if (chunks.length) resolve({ value: chunks.shift(), done: false })
    else if (eof) resolve({ value: null, done: true })
    else resolve(null) // spurious wake; caller re-reads
  }
  return {
    live: true,
    push(chunk) {
      if (eof) return
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      wake()
    },
    end() {
      eof = true
      wake()
    },
    get ended() {
      return eof
    },
    async read() {
      for (;;) {
        if (chunks.length) return chunks.shift()
        if (eof) return null
        const next = await new Promise((resolve) => {
          waiter = resolve
        })
        if (next === null) continue
        return next.done ? null : next.value
      }
    },
    async all() {
      const parts = []
      for (;;) {
        const chunk = await this.read()
        if (chunk === null) break
        parts.push(chunk)
      }
      return Buffer.concat(parts)
    },
  }
}

export function memorySink() {
  const chunks = []
  return {
    kind: 'memory',
    async write(chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'))
    },
    async close() {},
    buffer: () => Buffer.concat(chunks),
    text: () => Buffer.concat(chunks).toString('utf8'),
    get size() {
      return chunks.reduce((total, chunk) => total + chunk.length, 0)
    },
  }
}

export function callbackSink(callback) {
  return {
    kind: 'callback',
    async write(chunk) {
      await callback(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'))
    },
    async close() {},
  }
}

export function fileSink(path, { append = false, mode = 0o644 } = {}) {
  const fd = openSync(path, append ? 'a' : 'w', mode)
  return {
    kind: 'file',
    path,
    async write(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
      let offset = 0
      while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset)
    },
    async close() {
      try {
        closeSync(fd)
      } catch {
        /* already closed */
      }
    },
  }
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

const REDIRECT_CHARS = new Set(['<', '>'])
const OPERATOR_CHARS = new Set(['|', ';', '&'])

function expandVars(text, env, lastCode) {
  // Compatibility alias: `tokenize` and the pipeline both expand, and an unknown
  // name must survive the first pass (see `expandVarsWithUnknowns`).
  return expandVarsWithUnknowns(text, env, lastCode)
}

function lookup(name, env, lastCode) {
  if (name === '?') return String(lastCode)
  return env[name]
}

/**
 * Expand `$VAR` / `${VAR}` / `$?` / `$$` / `$#`.
 *
 * An *undefined* variable is left verbatim rather than expanding to the empty
 * string: the reference implementation sends `FOO=bar some-cmd $FOO` style
 * command lines, where the assignment is a prefix of the very command that
 * references it. Keeping the literal lets the pipeline re-expand with the
 * per-command environment once the prefix assignments are known.
 */
function expandVarsWithUnknowns(text, env, lastCode) {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch !== '$') {
      out += ch
      continue
    }
    const next = text[i + 1]
    if (next === '{') {
      const end = text.indexOf('}', i + 2)
      if (end === -1) {
        out += ch
        continue
      }
      const name = text.slice(i + 2, end)
      const value = lookup(name, env, lastCode)
      out += value === undefined ? text.slice(i, end + 1) : String(value)
      i = end
      continue
    }
    if (next === '?') {
      out += String(lastCode)
      i += 1
      continue
    }
    if (next === '$') {
      out += String(SHELL_PID)
      i += 1
      continue
    }
    if (next === '#') {
      out += '0'
      i += 1
      continue
    }
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i + 1))
    if (!match) {
      out += ch
      continue
    }
    const value = lookup(match[0], env, lastCode)
    out += value === undefined ? `$${match[0]}` : String(value)
    i += match[0].length
  }
  return out
}

/**
 * Tokenise one command line into words and control operators.
 * @returns array of `{ t:'word', value, quoted }` / `{ t:'op', value, at }`
 */
function tokenize(line, env, lastCode) {
  const tokens = []
  let i = 0
  while (i < line.length) {
    const ch = line[i]
    if (ch === ' ' || ch === '\t') {
      i += 1
      continue
    }
    if (OPERATOR_CHARS.has(ch) || REDIRECT_CHARS.has(ch)) {
      const op = readOperator(line, i)
      tokens.push({ t: 'op', value: op, at: i })
      i += op.length
      continue
    }
    const start = i
    let value = ''
    let quoted = false
    while (i < line.length) {
      const c = line[i]
      if (c === ' ' || c === '\t') break
      if (OPERATOR_CHARS.has(c) || REDIRECT_CHARS.has(c)) break
      if (c === "'") {
        quoted = true
        i += 1
        while (i < line.length && line[i] !== "'") {
          value += line[i]
          i += 1
        }
        i += 1
        continue
      }
      if (c === '"') {
        quoted = true
        i += 1
        let inner = ''
        while (i < line.length && line[i] !== '"') {
          if (line[i] === '\\' && i + 1 < line.length && '"\\$`'.includes(line[i + 1])) {
            inner += line[i + 1]
            i += 2
            continue
          }
          inner += line[i]
          i += 1
        }
        i += 1
        value += expandVars(inner, env, lastCode)
        continue
      }
      if (c === '\\' && i + 1 < line.length) {
        quoted = true
        value += line[i + 1]
        i += 2
        continue
      }
      if (c === '$') {
        const rest = line.slice(i)
        const match = /^\$(?:\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*|\?|\$|#)/.exec(rest)
        if (match) {
          value += expandVars(match[0], env, lastCode)
          i += match[0].length
          continue
        }
      }
      value += c
      i += 1
    }
    tokens.push({ t: 'word', value, quoted, start })
  }
  return tokens
}

function readOperator(line, index) {
  const two = line.slice(index, index + 2)
  if (two === '>>' || two === '&&' || two === '||' || two === '>&' || two === '<&' || two === '&>') return two
  return line[index]
}

/** Parse a script into `[{ sep, stages: [{argv, redirs}] }]`. */
export function parseScript(script, { env = {}, lastCode = 0 } = {}) {
  const tokens = tokenize(String(script), env, lastCode)
  const program = []
  let stages = []
  let current = { argv: [], redirs: [] }
  let pendingSep = ';'
  let expectSeparator = false

  const pushStage = () => {
    if (current.argv.length || current.redirs.length) stages.push(current)
    current = { argv: [], redirs: [] }
  }
  const pushPipeline = () => {
    pushStage()
    if (stages.length) {
      program.push({ sep: pendingSep, stages })
      stages = []
    }
    pendingSep = ';'
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.t === 'op') {
      const op = token.value
      if (op === '|') {
        pushStage()
        continue
      }
      if (op === ';' || op === '&&' || op === '||' || op === '&') {
        pushPipeline()
        pendingSep = op === '&' ? ';' : op
        expectSeparator = false
        continue
      }
      // redirection
      let fd = 1
      const previous = tokens[i - 1]
      if (
        previous &&
        previous.t === 'word' &&
        /^[12]$/.test(previous.value) &&
        !previous.quoted &&
        previous.start + previous.value.length === token.at
      ) {
        fd = Number(previous.value)
        current.argv.pop()
      }
      if (op === '&>') {
        current.redirs.push({ fd: 1, dup: 2, kind: 'dup' })
        // fallthrough: still needs a target
        const target = tokens[++i]
        if (target && target.t === 'word') {
          current.redirs.push({ fd: 1, kind: 'file', path: target.value, append: false })
          current.redirs.push({ fd: 2, kind: 'file', path: target.value, append: false })
        }
        continue
      }
      if (op === '>' || op === '>>') {
        const target = tokens[++i]
        current.redirs.push({
          fd,
          kind: 'file',
          path: target && target.t === 'word' ? target.value : '',
          append: op === '>>',
        })
        continue
      }
      if (op === '<') {
        const target = tokens[++i]
        current.redirs.push({ fd: 0, kind: 'in', path: target && target.t === 'word' ? target.value : '' })
        continue
      }
      if (op === '>&' || op === '<&') {
        const target = tokens[++i]
        const dupTo = target && target.t === 'word' && /^[012]$/.test(target.value) ? Number(target.value) : null
        if (dupTo === null) {
          current.redirs.push({ fd, kind: 'file', path: target ? target.value : '', append: false })
        } else {
          current.redirs.push({ fd, dup: dupTo, kind: 'dup' })
        }
        continue
      }
    }
    if (expectSeparator) pushPipeline()
    expectSeparator = false
    current.argv.push(token.value)
    // A word followed by another word means a new command in practice only when
    // the previous one was already terminated; nothing to do here.
  }
  pushPipeline()
  return program.filter((entry) => entry.stages.length > 0)
}

function globToRegExp(pattern) {
  let out = '^'
  for (const ch of pattern) {
    if (ch === '*') out += '[^/]*'
    else if (ch === '?') out += '[^/]'
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`${out}$`)
}

function expandGlobs(words, { sandbox, cwd }) {
  const out = []
  for (const word of words) {
    if (typeof word !== 'string' || (!word.includes('*') && !word.includes('?'))) {
      out.push(word)
      continue
    }
    const slash = word.lastIndexOf('/')
    const dirPart = slash === -1 ? '.' : word.slice(0, slash) || '/'
    const base = slash === -1 ? word : word.slice(slash + 1)
    const dirVirtual = sandbox.resolve(cwd, dirPart)
    let matches = []
    try {
      const entries = readdirSync(sandbox.real(dirVirtual))
      const re = globToRegExp(base)
      matches = entries.filter((name) => re.test(name)).sort()
    } catch {
      matches = []
    }
    if (!matches.length) out.push(word)
    else for (const m of matches) out.push(slash === -1 ? m : `${dirPart}/${m}`)
  }
  return out
}

// ---------------------------------------------------------------------------
// interpreter
// ---------------------------------------------------------------------------

export class Interpreter {
  /**
   * @param {object} options
   * @param {object} options.sandbox       chroot-ish path mapper (fixtures.mjs)
   * @param {string} [options.cwd]         virtual working directory
   * @param {object} [options.env]         environment (copied)
   * @param {object} options.stdout        sink for stdout
   * @param {object} options.stderr        sink for stderr
   * @param {object} [options.stdin]       input source
   * @param {object} [options.abort]       abort token
   * @param {boolean} [options.tty]        tty semantics (\\r\\n, echo)
   * @param {() => object} [options.keys]  raw keystroke iterator factory (tty)
   * @param {Function} [options.deny]      `(vpath, mode) => 'r'|'w'|null`
   */
  constructor(options) {
    this.sandbox = options.sandbox
    this.cwd = options.sandbox.normalize(options.cwd ?? options.sandbox.home)
    this.env = { ...(options.env ?? {}) }
    this.stdout = options.stdout
    this.stderr = options.stderr
    this.stdin = options.stdin ?? memoryInput('')
    this.abort = options.abort ?? createAbort()
    this.tty = Boolean(options.tty)
    this.keys = options.keys ?? null
    this.user = options.user ?? 'user'
    this.host = options.host ?? 'dsh-test'
    this.home = this.sandbox.home
    this.cols = options.cols ?? 80
    this.rows = options.rows ?? 24
    /** Live size source (the PTY reporter); falls back to the static values. */
    this.getSize = options.getSize ?? null
    this.term = options.term ?? 'xterm-256color'
    this.log = options.log ?? (() => {})
    this.deny = options.deny ?? (() => null)
    /** Virtual POSIX mode lookup `(realPath, st) => number` (owned by sshd.mjs). */
    this.modeOf = options.modeOf ?? ((realPath, st) => (st ?? lstatSync(realPath)).mode)
    /** Apply a mode change `(realPath, mode) => number`. */
    this.chmodHook = options.chmod ?? null
    this.outputCap = options.outputCap ?? DEFAULT_OUTPUT_CAP
    this.extraBuiltins = options.builtins ?? {}
    this.lastCode = 0
    this.exitRequested = false
    this.exitCode = 0
    this.commands = []
  }

  get builtins() {
    return { ...BUILTINS, ...this.extraBuiltins }
  }

  async run(script) {
    const program = parseScript(script, { env: this.env, lastCode: this.lastCode })
    let code = this.lastCode
    for (const entry of program) {
      if (entry.sep === '&&' && code !== 0) continue
      if (entry.sep === '||' && code === 0) continue
      code = await this.runPipeline(entry.stages)
      this.lastCode = code
      if (this.exitRequested) break
    }
    return code
  }

  async runPipeline(stages) {
    let piped = null
    let lastCode = 0
    for (let index = 0; index < stages.length; index++) {
      const stage = stages[index]
      const isLast = index === stages.length - 1
      if (!stage.argv.length) {
        lastCode = 0
        continue
      }
      // `VAR=value cmd …` prefix assignments (the reference implementation sends
      // env this way) and bare `VAR=value` persistent assignments.
      const assignments = []
      while (stage.argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(stage.argv[0])) {
        const [key, ...rest] = stage.argv.shift().split('=')
        assignments.push([key, rest.join('=')])
      }
      if (assignments.length) {
        const target = stage.argv.length ? { ...this.env } : this.env
        for (const [key, value] of assignments) target[key] = value
        if (stage.argv.length) stage.envOverride = target
        else {
          this.env = target
          lastCode = 0
          continue
        }
      }
      const name = stage.argv[0]
      const builtin = this.builtins[name]
      if (typeof builtin !== 'function') {
        await this.stderr.write(`${name}: command not found\n`)
        return 127
      }
      let redirs
      try {
        redirs = this.applyRedirs(stage.redirs)
      } catch (error) {
        await this.stderr.write(`sh: ${error && error.path ? error.path : error.message}: ${error && error.code === 'ENOENT' ? 'No such file or directory' : error && error.message}\n`)
        return 1
      }
      const stdout = isLast ? redirs.stdout ?? this.stdout : memorySink()
      const stderr = redirs.stderr ?? (isLast ? this.stderr : memorySink())
      // Intermediate stages drop their stderr into the shared sink to keep the
      // diagnostics visible (like a real shell without `2>&1`).
      const effectiveErr = isLast ? stderr : this.stderr
      let input
      if (index === 0) {
        input = redirs.stdinFile ? memoryInput(readFileSync(redirs.stdinFile)) : this.stdin
      } else {
        input = memoryInput(piped ? piped.buffer() : Buffer.alloc(0))
      }
      const ctx = this.makeContext(stage, { stdout, stderr: effectiveErr, input, redirs })
      let code
      try {
        code = await builtin(ctx)
      } catch (error) {
        if (this.abort.cancelled) {
          code = this.abort.reason === 'INT' ? 130 : 143
        } else {
          await effectiveErr.write(`${name}: ${error && error.message ? error.message : String(error)}\n`)
          code = 1
        }
      }
      await flushSink(effectiveErr)
      await flushSink(stdout)
      await closeSink(redirs.stdout)
      await closeSink(redirs.stderr)
      this.log('command', { argv: stage.argv, code, cwd: this.cwd })
      this.commands.push({ argv: [...stage.argv], code })
      lastCode = code
      if (this.exitRequested) return this.exitCode
      if (this.abort.cancelled) return code
      if (!isLast) piped = stdout
    }
    return lastCode
  }

  applyRedirs(redirs) {
    const out = { stdout: null, stderr: null, stdinFile: null, files: [] }
    for (const redir of redirs) {
      if (redir.kind === 'in') {
        const vpath = this.sandbox.resolve(this.cwd, redir.path)
        out.stdinFile = this.sandbox.real(vpath)
        continue
      }
      if (redir.kind === 'dup') {
        // `1>&2` sends stdout to the stderr sink (and the other way round).
        if (redir.fd === 1) out.stdout = out.stderr ?? this.stderr
        else out.stderr = out.stdout ?? this.stdout
        continue
      }
      const vpath = this.sandbox.resolve(this.cwd, redir.path)
      const sink = fileSink(this.sandbox.real(vpath), { append: Boolean(redir.append) })
      out.files.push(sink)
      if (redir.fd === 1 || redir.fd === 3) out.stdout = sink
      if (redir.fd === 2) out.stderr = sink
    }
    return out
  }

  makeContext(stage, io) {
    const interp = this
    const stageEnv = stage.envOverride ?? this.env
    // Second expansion pass: unknown names survived tokenization so that a
    // `VAR=value cmd $VAR` prefix can resolve here, where the assignment is known.
    const expanded = stage.argv.slice(1).map((word) => expandVarsWithUnknowns(word, stageEnv, this.lastCode))
    const argv = expandGlobs(expanded, { sandbox: this.sandbox, cwd: this.cwd })
    const ctx = {
      argv,
      get name() {
        return stage.argv[0]
      },
      env: stageEnv,
      get cwd() {
        return interp.cwd
      },
      setCwd(next) {
        interp.cwd = interp.sandbox.normalize(next)
      },
      home: interp.home,
      user: interp.user,
      host: interp.host,
      sandbox: interp.sandbox,
      tty: interp.tty,
      get cols() {
        return interp.getSize ? interp.getSize().cols : interp.cols
      },
      get rows() {
        return interp.getSize ? interp.getSize().rows : interp.rows
      },
      term: interp.term,
      abort: interp.abort,
      interp,
      stdin: io.input,
      out: (chunk) => io.stdout.write(chunk),
      err: (chunk) => io.stderr.write(chunk),
      write: (chunk) => io.stdout.write(chunk),
      writeErr: (chunk) => io.stderr.write(chunk),
      log: interp.log,
      keys: () => (interp.keys ? interp.keys() : emptyKeys()),
      outputCap: interp.outputCap,
      exit(code = 0) {
        interp.exitRequested = true
        interp.exitCode = code
      },
      sleep: (ms) => abortableSleep(ms, interp.abort),
      modeOf: (realPath, st) => interp.modeOf(realPath, st),
      chmod: (realPath, mode) => {
        if (interp.chmodHook) return interp.chmodHook(realPath, mode)
        chmodSync(realPath, mode)
        return mode
      },
      resolve: (path) => interp.sandbox.resolve(interp.cwd, path),
      real: (path) => interp.sandbox.real(interp.sandbox.resolve(interp.cwd, path)),
      // Permission gate: lets tests force EACCES deterministically on Windows
      // (where chmod is not enforced by the OS).
      checkAccess(path, mode) {
        const vpath = interp.sandbox.resolve(interp.cwd, path)
        const denial = interp.deny(vpath, mode)
        if (!denial) return null
        return Object.assign(new Error(`${vpath}: Permission denied`), { code: 'EACCES' })
      },
      pathArgv: argv,
      allArgv: stage.argv,
    }
    return ctx
  }
}

function emptyKeys() {
  return {
    [Symbol.asyncIterator]() {
      return { next: async () => ({ value: undefined, done: true }) }
    },
  }
}

export function abortableSleep(ms, abort) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (abort) {
      abort.onCancel(() => {
        clearTimeout(timer)
        resolve()
      })
    }
  })
}

async function flushSink(sink) {
  if (sink && typeof sink.flush === 'function') await sink.flush()
}

async function closeSink(sink) {
  if (sink && typeof sink.close === 'function' && sink.kind === 'file') await sink.close()
}

// ---------------------------------------------------------------------------
// helpers shared by builtins
// ---------------------------------------------------------------------------

function ctxText(ctx, value) {
  const text = String(value ?? '')
  return ctx.tty ? text.replace(/\n/g, '\r\n') : text
}

function statVirtual(ctx, vpath) {
  const real = ctx.sandbox.real(vpath)
  return lstatSync(real)
}

function resolveExisting(ctx, arg, { mode = 'r' } = {}) {
  const denial = ctx.checkAccess(arg, mode)
  if (denial) throw denial
  const vpath = ctx.resolve(arg)
  if (!existsSync(ctx.sandbox.real(vpath))) {
    const error = new Error(`${arg}: No such file or directory`)
    error.code = 'ENOENT'
    throw error
  }
  return vpath
}

async function readInputBuffer(ctx) {
  return ctx.stdin.all()
}

async function readInputText(ctx) {
  return (await readInputBuffer(ctx)).toString('utf8')
}

async function writeCapped(ctx, chunk) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
  const written = ctx.interp.outputWritten ?? 0
  if (written >= ctx.outputCap) return false
  const room = ctx.outputCap - written
  if (buffer.length > room) {
    await ctx.write(buffer.subarray(0, room))
    ctx.interp.outputWritten = ctx.outputCap
    return false
  }
  await ctx.write(buffer)
  ctx.interp.outputWritten = written + buffer.length
  return true
}

function pad(value, width) {
  return String(value).padStart(width, ' ')
}

function formatMode(mode, type) {
  const bits = mode & 0o7777
  const chars = ['-', '-', '-', '-', '-', '-', '-', '-', '-']
  const flags = [0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001]
  for (let i = 0; i < 9; i++) if (bits & flags[i]) chars[i] = 'rwxrwxrwx'[i]
  if (bits & 0o4000) chars[2] = bits & 0o100 ? 's' : 'S'
  if (bits & 0o2000) chars[5] = bits & 0o010 ? 's' : 'S'
  if (bits & 0o1000) chars[8] = bits & 0o001 ? 't' : 'T'
  if (type === 'dir') chars[0] = 'd'
  else if (type === 'symlink') chars[0] = 'l'
  return chars.join('')
}

function typeOf(st) {
  if (st.isDirectory()) return 'dir'
  if (st.isSymbolicLink()) return 'symlink'
  return 'file'
}

function formatLsDate(ms) {
  const date = new Date(ms)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const hh = String(date.getUTCHours()).padStart(2, '0')
  const mm = String(date.getUTCMinutes()).padStart(2, '0')
  return `${months[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, ' ')} ${hh}:${mm}`
}

function isoUtc(ms) {
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', ' +0000')
}

async function copyStreamTo(ctx, from, to) {
  for (;;) {
    const chunk = await from.read()
    if (chunk === null) break
    await to.write(chunk)
  }
}

// ---------------------------------------------------------------------------
// builtins
// ---------------------------------------------------------------------------

export const BUILTINS = {
  async echo(ctx) {
    let newline = '\n'
    let escapes = false
    let index = 0
    while (index < ctx.argv.length && ctx.argv[index].startsWith('-') && ctx.argv[index].length > 1) {
      const flag = ctx.argv[index]
      if (flag === '-n') newline = ''
      else if (flag === '-e') escapes = true
      else if (flag === '-en' || flag === '-ne') {
        newline = ''
        escapes = true
      } else break
      index += 1
    }
    let text = ctx.argv.slice(index).join(' ')
    if (escapes) text = text.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\')
    await ctx.write(ctxText(ctx, text + newline))
    return 0
  },

  async printf(ctx) {
    if (!ctx.argv.length) {
      await ctx.write('usage: printf FORMAT [ARG...]\n')
      return 2
    }
    const format = ctx.argv[0]
    const args = ctx.argv.slice(1)
    let argIndex = 0
    const rendered = format.replace(/%[sdix%]/g, (match) => {
      if (match === '%%') return '%'
      const value = args[argIndex++]
      if (match === '%d' || match === '%i') return String(Number.parseInt(value ?? '0', 10) || 0)
      if (match === '%x') return (Number.parseInt(value ?? '0', 10) || 0).toString(16)
      return value ?? ''
    }).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\')
    await ctx.write(ctxText(ctx, rendered))
    return 0
  },

  async pwd(ctx) {
    await ctx.write(`${ctx.cwd}\n`)
    return 0
  },

  async cd(ctx) {
    // `cd -- <path>` is how the reference implementation quotes the target path.
    const args = ctx.argv.filter((arg, index) => !(index === 0 && arg === '--'))
    const target = args.length ? args[0] : ctx.home
    const vpath = ctx.resolve(target)
    const denial = ctx.checkAccess(target, 'r')
    if (denial) {
      await ctx.err(`cd: ${target}: Permission denied\n`)
      return 1
    }
    if (!existsSync(ctx.sandbox.real(vpath))) {
      await ctx.err(`cd: ${target}: No such file or directory\n`)
      return 1
    }
    if (!lstatSync(ctx.sandbox.real(vpath)).isDirectory()) {
      await ctx.err(`cd: ${target}: Not a directory\n`)
      return 1
    }
    ctx.setCwd(vpath)
    ctx.env.PWD = vpath
    return 0
  },

  async env(ctx) {
    for (const [key, value] of Object.entries(ctx.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      await ctx.write(`${key}=${value}\n`)
    }
    return 0
  },

  async printenv(ctx) {
    if (!ctx.argv.length) return BUILTINS.env(ctx)
    let code = 0
    for (const name of ctx.argv) {
      if (ctx.env[name] === undefined) code = 1
      else await ctx.write(`${ctx.env[name]}\n`)
    }
    return code
  },

  async export(ctx) {
    for (const assignment of ctx.argv) {
      const eq = assignment.indexOf('=')
      if (eq === -1) {
        if (ctx.env[assignment] === undefined) ctx.env[assignment] = ''
        continue
      }
      ctx.env[assignment.slice(0, eq)] = assignment.slice(eq + 1)
    }
    return 0
  },

  async unset(ctx) {
    for (const name of ctx.argv) delete ctx.env[name]
    return 0
  },

  async whoami(ctx) {
    await ctx.write(`${ctx.user}\n`)
    return 0
  },

  async id(ctx) {
    await ctx.write(`uid=1000(${ctx.user}) gid=1000(${ctx.user}) groups=1000(${ctx.user})\n`)
    return 0
  },

  async hostname(ctx) {
    await ctx.write(`${ctx.host}\n`)
    return 0
  },

  async uname(ctx) {
    const all = ctx.argv.includes('-a')
    if (all || !ctx.argv.length) {
      await ctx.write(`${UNAME_LINE}\n`)
      return 0
    }
    const parts = []
    for (const flag of ctx.argv.join('')) {
      if (flag === 's') parts.push('Linux')
      if (flag === 'n') parts.push(ctx.host)
      if (flag === 'r') parts.push('6.1.0-dshsshd')
      if (flag === 'm') parts.push('x86_64')
      if (flag === 'o') parts.push('GNU/Linux')
    }
    await ctx.write(`${parts.join(' ')}\n`)
    return 0
  },

  async date(ctx) {
    await ctx.write(`${FIXED_DATE_LINE}\n`)
    return 0
  },

  async true() {
    return 0
  },

  async false() {
    return 1
  },

  async exit(ctx) {
    const code = ctx.argv.length ? Number.parseInt(ctx.argv[0], 10) : ctx.interp.lastCode
    ctx.exit(Number.isFinite(code) ? code : 0)
    return Number.isFinite(code) ? code : 0
  },

  async sleep(ctx) {
    const seconds = Number.parseFloat(ctx.argv[0] ?? '0')
    if (!Number.isFinite(seconds) || seconds < 0) {
      await ctx.err(`sleep: invalid time interval '${ctx.argv[0]}'\n`)
      return 1
    }
    await ctx.sleep(Math.round(seconds * 1000))
    if (ctx.abort.cancelled) return ctx.abort.reason === 'INT' ? 130 : 143
    return 0
  },

  async cat(ctx) {
    const paths = ctx.argv.filter((arg) => arg !== '-')
    if (!paths.length) {
      await copyStreamTo(ctx, ctx.stdin, { write: (chunk) => writeCapped(ctx, chunk) })
      return 0
    }
    let code = 0
    for (const path of paths) {
      try {
        const vpath = resolveExisting(ctx, path)
        const buffer = readFileSync(ctx.sandbox.real(vpath))
        if (!(await writeCapped(ctx, buffer))) break
      } catch (error) {
        await ctx.err(`cat: ${path}: ${error.code === 'ENOENT' ? 'No such file or directory' : error.message}\n`)
        code = 1
      }
    }
    return code
  },

  async head(ctx) {
    let count = 10
    let bytes = null
    let index = 0
    while (index < ctx.argv.length && ctx.argv[index].startsWith('-')) {
      const flag = ctx.argv[index]
      if (flag === '-n') count = Number.parseInt(ctx.argv[++index], 10)
      else if (flag === '-c') bytes = Number.parseInt(ctx.argv[++index], 10)
      else if (/^-\d+$/.test(flag)) count = Number.parseInt(flag.slice(1), 10)
      else break
      index += 1
    }
    const source = index < ctx.argv.length ? readFileSync(ctx.sandbox.real(resolveExisting(ctx, ctx.argv[index]))) : await readInputBuffer(ctx)
    if (bytes !== null) {
      await ctx.write(source.subarray(0, bytes))
      return 0
    }
    const lines = source.toString('utf8').split('\n')
    const selected = lines.slice(0, count)
    await ctx.write(selected.join('\n') + (lines.length > count ? '\n' : ''))
    return 0
  },

  async tail(ctx) {
    let count = 10
    let index = 0
    while (index < ctx.argv.length && ctx.argv[index].startsWith('-')) {
      const flag = ctx.argv[index]
      if (flag === '-n') count = Number.parseInt(ctx.argv[++index], 10)
      else if (/^-\d+$/.test(flag)) count = Number.parseInt(flag.slice(1), 10)
      else break
      index += 1
    }
    const source = index < ctx.argv.length ? readFileSync(ctx.sandbox.real(resolveExisting(ctx, ctx.argv[index]))) : await readInputBuffer(ctx)
    const text = source.toString('utf8')
    const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
    await ctx.write(lines.slice(Math.max(0, lines.length - count)).join('\n') + '\n')
    return 0
  },

  async wc(ctx) {
    const flags = ctx.argv.filter((arg) => arg.startsWith('-'))
    const paths = ctx.argv.filter((arg) => !arg.startsWith('-'))
    const sources = []
    if (paths.length) for (const path of paths) sources.push({ name: path, buffer: readFileSync(ctx.sandbox.real(resolveExisting(ctx, path))) })
    else sources.push({ name: null, buffer: await readInputBuffer(ctx) })
    for (const source of sources) {
      const text = source.buffer.toString('utf8')
      const columns = []
      if (flags.includes('-l') || !flags.length) columns.push(pad(text.split('\n').length - (text.endsWith('\n') ? 1 : 0), 7))
      if (flags.includes('-w') || !flags.length) columns.push(pad(text.split(/\s+/).filter(Boolean).length, 7))
      if (flags.includes('-c') || !flags.length) columns.push(pad(source.buffer.length, 7))
      await ctx.write(`${columns.join('')}${source.name ? ` ${source.name}` : ''}\n`)
    }
    return 0
  },

  async ls(ctx) {
    const flags = ctx.argv.filter((arg) => arg.startsWith('-')).join('')
    const paths = ctx.argv.filter((arg) => !arg.startsWith('-'))
    const all = flags.includes('a')
    const long = flags.includes('l')
    const targets = paths.length ? paths : ['.']
    let code = 0
    for (const target of targets) {
      let vpath
      try {
        vpath = resolveExisting(ctx, target)
      } catch (error) {
        await ctx.err(`ls: ${target}: ${error.code === 'ENOENT' ? 'No such file or directory' : error.message}\n`)
        code = 2
        continue
      }
      const st = statVirtual(ctx, vpath)
      if (!st.isDirectory()) {
        const mode = ctx.modeOf(ctx.sandbox.real(vpath), st)
        await ctx.write(long ? `${formatMode(mode, typeOf(st))} 1 ${ctx.user} ${ctx.user} ${pad(st.size, 6)} ${formatLsDate(st.mtimeMs)} ${target}\n` : `${target}\n`)
        continue
      }
      let entries = readdirSync(ctx.sandbox.real(vpath), { withFileTypes: true }).map((entry) => entry.name)
      if (!all) entries = entries.filter((name) => !name.startsWith('.'))
      entries.sort()
      if (targets.length > 1) await ctx.write(`${target}:\n`)
      if (long) {
        for (const name of entries) {
          const child = `${vpath === '/' ? '' : vpath}/${name}`
          const cst = lstatSync(ctx.sandbox.real(child))
          const link = cst.isSymbolicLink() ? ` -> ${readlinkSync(ctx.sandbox.real(child))}` : ''
          await ctx.write(
            `${formatMode(ctx.modeOf(ctx.sandbox.real(child), cst), typeOf(cst))} 1 ${ctx.user} ${ctx.user} ${pad(cst.size, 6)} ${formatLsDate(cst.mtimeMs)} ${name}${link}\n`,
          )
        }
      } else if (entries.length) {
        await ctx.write(`${entries.join('  ')}\n`)
      }
    }
    return code
  },

  async mkdir(ctx) {
    const parents = ctx.argv.some((arg) => arg.startsWith('-') && arg.includes('p'))
    const paths = ctx.argv.filter((arg) => !arg.startsWith('-'))
    if (!paths.length) {
      await ctx.err('mkdir: missing operand\n')
      return 1
    }
    for (const path of paths) {
      const vpath = ctx.resolve(path)
      if (ctx.checkAccess(path, 'w')) {
        await ctx.err(`mkdir: cannot create directory '${path}': Permission denied\n`)
        return 1
      }
      if (existsSync(ctx.sandbox.real(vpath)) && !parents) {
        await ctx.err(`mkdir: cannot create directory '${path}': File exists\n`)
        return 1
      }
      mkdirSync(ctx.sandbox.real(vpath), { recursive: parents || true })
    }
    return 0
  },

  async rmdir(ctx) {
    let code = 0
    for (const path of ctx.argv) {
      const vpath = ctx.resolve(path)
      if (ctx.checkAccess(path, 'w')) {
        await ctx.err(`rmdir: failed to remove '${path}': Permission denied\n`)
        code = 1
        continue
      }
      try {
        const entries = readdirSync(ctx.sandbox.real(vpath))
        if (entries.length) {
          await ctx.err(`rmdir: failed to remove '${path}': Directory not empty\n`)
          code = 1
          continue
        }
        rmSync(ctx.sandbox.real(vpath))
      } catch (error) {
        await ctx.err(`rmdir: failed to remove '${path}': ${error.code === 'ENOENT' ? 'No such file or directory' : error.message}\n`)
        code = 1
      }
    }
    return code
  },

  async rm(ctx) {
    const flags = ctx.argv.filter((arg) => arg.startsWith('-')).join('')
    const paths = ctx.argv.filter((arg) => !arg.startsWith('-'))
    if (!paths.length) {
      await ctx.err('rm: missing operand\n')
      return 1
    }
    let code = 0
    for (const path of paths) {
      const vpath = ctx.resolve(path)
      if (ctx.checkAccess(path, 'w')) {
        await ctx.err(`rm: cannot remove '${path}': Permission denied\n`)
        code = 1
        continue
      }
      if (!existsSync(ctx.sandbox.real(vpath))) {
        if (!flags.includes('f')) {
          await ctx.err(`rm: cannot remove '${path}': No such file or directory\n`)
          code = 1
        }
        continue
      }
      rmSync(ctx.sandbox.real(vpath), { recursive: flags.includes('r') || flags.includes('R'), force: flags.includes('f') })
    }
    return code
  },

  async touch(ctx) {
    let code = 0
    for (const path of ctx.argv) {
      const vpath = ctx.resolve(path)
      try {
        if (existsSync(ctx.sandbox.real(vpath))) appendFileSync(ctx.sandbox.real(vpath), '')
        else writeFileSync(ctx.sandbox.real(vpath), '')
      } catch (error) {
        await ctx.err(`touch: cannot touch '${path}': ${error.message}\n`)
        code = 1
      }
    }
    return code
  },

  async mv(ctx) {
    if (ctx.argv.length < 2) {
      await ctx.err('mv: missing destination file operand\n')
      return 1
    }
    const [from, to] = [ctx.argv[0], ctx.argv[1]]
    const target = ctx.resolve(to)
    const final = existsSync(ctx.sandbox.real(target)) && lstatSync(ctx.sandbox.real(target)).isDirectory()
      ? `${target}/${from.split('/').pop()}`
      : target
    try {
      renameSync(ctx.sandbox.real(ctx.resolve(from)), ctx.sandbox.real(final))
      return 0
    } catch (error) {
      await ctx.err(`mv: cannot move '${from}' to '${to}': ${error.message}\n`)
      return 1
    }
  },

  async cp(ctx) {
    if (ctx.argv.length < 2) {
      await ctx.err('cp: missing destination file operand\n')
      return 1
    }
    try {
      copyFileSync(ctx.sandbox.real(ctx.resolve(ctx.argv[0])), ctx.sandbox.real(ctx.resolve(ctx.argv[1])))
      return 0
    } catch (error) {
      await ctx.err(`cp: cannot stat '${ctx.argv[0]}': ${error.message}\n`)
      return 1
    }
  },

  async ln(ctx) {
    const symbolic = ctx.argv[0] === '-s'
    const args = symbolic ? ctx.argv.slice(1) : ctx.argv
    if (args.length < 2) {
      await ctx.err('ln: missing file operand\n')
      return 1
    }
    try {
      symlinkSync(args[0], ctx.sandbox.real(ctx.resolve(args[1])), 'file')
      return 0
    } catch (error) {
      await ctx.err(`ln: failed to create symbolic link '${args[1]}': ${error.message}\n`)
      return 1
    }
  },

  async chmod(ctx) {
    if (ctx.argv.length < 2) {
      await ctx.err('chmod: missing operand\n')
      return 1
    }
    const [spec, path] = ctx.argv
    const vpath = ctx.resolve(path)
    let mode
    if (/^[0-7]{3,4}$/.test(spec)) mode = Number.parseInt(spec, 8)
    else {
      const current = lstatSync(ctx.sandbox.real(vpath)).mode & 0o7777
      mode = current
      const match = /^([ugoa]*)([+-=])([rwx]+)$/.exec(spec)
      if (!match) {
        await ctx.err(`chmod: invalid mode: '${spec}'\n`)
        return 1
      }
      const bits = { r: 4, w: 2, x: 1 }
      const add = match[2] === '-'
      for (const who of match[1] || 'a') {
        for (const perm of match[3]) {
          const shift = who === 'u' ? 6 : who === 'g' ? 3 : who === 'o' ? 0 : 0
          const value = bits[perm] << shift
          mode = add ? mode & ~value : mode | value
        }
      }
    }
    ctx.chmod(ctx.sandbox.real(vpath), mode)
    return 0
  },
  async stat(ctx) {
    const formatIndex = ctx.argv.findIndex((arg) => arg === '-c')
    const format = formatIndex >= 0 ? ctx.argv[formatIndex + 1] : null
    const path = ctx.argv.find((arg) => !arg.startsWith('-') && arg !== format)
    if (!path) {
      await ctx.err('stat: missing operand\n')
      return 1
    }
    const vpath = resolveExisting(ctx, path)
    const st = lstatSync(ctx.sandbox.real(vpath))
    const mode = ctx.modeOf(ctx.sandbox.real(vpath), st)
    if (format) {
      const rendered = format
        .replace(/%n/g, vpath)
        .replace(/%s/g, String(st.size))
        .replace(/%a/g, (mode & 0o7777).toString(8))
        .replace(/%F/g, st.isDirectory() ? 'directory' : st.isSymbolicLink() ? 'symbolic link' : 'regular file')
        .replace(/%Y/g, String(Math.floor(st.mtimeMs / 1000)))
      await ctx.write(`${rendered}\n`)
      return 0
    }
    await ctx.write(`  File: ${vpath}\n`)
    await ctx.write(`  Size: ${pad(st.size, 8)}        Blocks: ${pad(Math.ceil(st.size / 512), 6)}   IO Block: 4096   ${st.isDirectory() ? 'directory' : 'regular file'}\n`)
    await ctx.write(`Access: (${(mode & 0o7777).toString(8).padStart(4, '0')}/${formatMode(mode, typeOf(st))})  Uid: ( 1000/${pad(ctx.user, 8)})   Gid: ( 1000/${pad(ctx.user, 8)})\n`)
    await ctx.write(`Access: ${isoUtc(st.atimeMs)}\n`)
    await ctx.write(`Modify: ${isoUtc(st.mtimeMs)}\n`)
    await ctx.write(`Change: ${isoUtc(st.ctimeMs)}\n`)
    return 0
  },

  async readlink(ctx) {
    const path = ctx.argv[0]
    if (!path) {
      await ctx.err('readlink: missing operand\n')
      return 1
    }
    try {
      await ctx.write(`${readlinkSync(ctx.sandbox.real(ctx.resolve(path)))}\n`)
      return 0
    } catch (error) {
      await ctx.err(`readlink: ${path}: ${error.message}\n`)
      return 1
    }
  },

  async realpath(ctx) {
    const path = ctx.argv[0]
    if (!path) {
      await ctx.err('realpath: missing operand\n')
      return 1
    }
    try {
      const real = realpathSync(ctx.sandbox.real(ctx.resolve(path)))
      await ctx.write(`${ctx.sandbox.virtual(real)}\n`)
      return 0
    } catch (error) {
      await ctx.err(`realpath: ${path}: ${error.message}\n`)
      return 1
    }
  },

  async find(ctx) {
    const root = ctx.resolve(ctx.argv[0] ?? '.')
    const nameIndex = ctx.argv.indexOf('-name')
    const typeIndex = ctx.argv.indexOf('-type')
    const pattern = nameIndex >= 0 ? globToRegExp(ctx.argv[nameIndex + 1]) : null
    const wanted = typeIndex >= 0 ? ctx.argv[typeIndex + 1] : null
    const results = []
    const walk = (vpath) => {
      const st = lstatSync(ctx.sandbox.real(vpath))
      const type = st.isDirectory() ? 'd' : st.isSymbolicLink() ? 'l' : 'f'
      const base = vpath.split('/').pop() || vpath
      const nameOk = !pattern || pattern.test(base)
      const typeOk = !wanted || wanted === type
      if (nameOk && typeOk) results.push(vpath)
      if (st.isDirectory() && !st.isSymbolicLink()) {
        for (const entry of readdirSync(ctx.sandbox.real(vpath)).sort()) {
          walk(`${vpath === '/' ? '' : vpath}/${entry}`)
        }
      }
    }
    try {
      walk(root)
    } catch (error) {
      await ctx.err(`find: '${ctx.argv[0]}': ${error.message}\n`)
      return 1
    }
    if (results.length) await ctx.write(`${results.join('\n')}\n`)
    return 0
  },

  async grep(ctx) {
    const flags = ctx.argv.filter((arg) => arg.startsWith('-')).join('')
    const rest = ctx.argv.filter((arg) => !arg.startsWith('-'))
    const pattern = rest[0]
    if (!pattern) {
      await ctx.err('grep: missing pattern\n')
      return 2
    }
    const ignoreCase = flags.includes('i')
    const invert = flags.includes('v')
    const countOnly = flags.includes('c')
    const re = new RegExp(pattern, ignoreCase ? 'i' : '')
    const files = rest.slice(1)
    const sources = files.length
      ? files.map((path) => ({ name: path, text: readFileSync(ctx.sandbox.real(resolveExisting(ctx, path))).toString('utf8') }))
      : [{ name: null, text: await readInputText(ctx) }]
    let matched = 0
    for (const source of sources) {
      const lines = source.text.split('\n')
      for (const line of lines) {
        const hit = re.test(line)
        if (hit !== invert && line !== '') {
          matched += 1
          if (!countOnly) await ctx.write(`${source.name && sources.length > 1 ? `${source.name}:` : ''}${line}\n`)
        }
      }
      if (countOnly) await ctx.write(`${source.name ? `${source.name}:` : ''}${matched}\n`)
    }
    return matched > 0 ? 0 : 1
  },

  async sort(ctx) {
    const flags = ctx.argv.filter((arg) => arg.startsWith('-')).join('')
    const files = ctx.argv.filter((arg) => !arg.startsWith('-'))
    const text = files.length ? readFileSync(ctx.sandbox.real(resolveExisting(ctx, files[0]))).toString('utf8') : await readInputText(ctx)
    let lines = text.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    lines.sort((a, b) => (flags.includes('n') ? Number(a) - Number(b) : a < b ? -1 : a > b ? 1 : 0))
    if (flags.includes('r')) lines.reverse()
    if (flags.includes('u')) lines = [...new Set(lines)]
    if (lines.length) await ctx.write(`${lines.join('\n')}\n`)
    return 0
  },

  async uniq(ctx) {
    const count = ctx.argv.includes('-c')
    const text = await readInputText(ctx)
    const lines = text.split('\n').filter((line, index, all) => !(index === all.length - 1 && line === ''))
    const result = []
    for (const line of lines) {
      const last = result[result.length - 1]
      if (last && last.line === line) last.count += 1
      else result.push({ line, count: 1 })
    }
    for (const entry of result) await ctx.write(count ? `${pad(entry.count, 7)} ${entry.line}\n` : `${entry.line}\n`)
    return 0
  },

  async seq(ctx) {
    const numbers = ctx.argv.filter((arg) => !arg.startsWith('-')).map(Number)
    const [first, step, last] = numbers.length === 1
      ? [1, 1, numbers[0]]
      : numbers.length === 2
        ? [numbers[0], 1, numbers[1]]
        : [numbers[0], numbers[1], numbers[2]]
    const lines = []
    for (let value = first; step > 0 ? value <= last : value >= last; value += step) lines.push(String(value))
    if (lines.length) await ctx.write(`${lines.join('\n')}\n`)
    return 0
  },

  async yes(ctx) {
    const text = `${ctx.argv.length ? ctx.argv.join(' ') : 'y'}\n`
    for (;;) {
      if (!(await writeCapped(ctx, text))) break
      if (ctx.abort.cancelled) break
    }
    return ctx.abort.cancelled ? 130 : 0
  },

  async sha256sum(ctx) {
    const files = ctx.argv.filter((arg) => arg !== '-')
    const sources = files.length
      ? files.map((path) => ({ name: path, buffer: readFileSync(ctx.sandbox.real(resolveExisting(ctx, path))) }))
      : [{ name: '-', buffer: await readInputBuffer(ctx) }]
    for (const source of sources) {
      await ctx.write(`${createHash('sha256').update(source.buffer).digest('hex')}  ${source.name}\n`)
    }
    return 0
  },

  async md5sum(ctx) {
    const files = ctx.argv.filter((arg) => arg !== '-')
    const sources = files.length
      ? files.map((path) => ({ name: path, buffer: readFileSync(ctx.sandbox.real(resolveExisting(ctx, path))) }))
      : [{ name: '-', buffer: await readInputBuffer(ctx) }]
    for (const source of sources) {
      await ctx.write(`${createHash('md5').update(source.buffer).digest('hex')}  ${source.name}\n`)
    }
    return 0
  },

  async clear(ctx) {
    await ctx.write('\x1b[2J\x1b[H')
    return 0
  },

  async which(ctx) {
    let code = 0
    for (const name of ctx.argv) {
      if (BUILTINS[name] || ctx.interp.extraBuiltins[name]) {
        await ctx.write(`/usr/bin/${name}\n`)
      } else {
        code = 1
      }
    }
    return code
  },

  async dirname(ctx) {
    for (const path of ctx.argv) {
      const parts = ctx.sandbox.normalize(path).split('/')
      parts.pop()
      await ctx.write(`${parts.length ? parts.join('/') || '/' : '.'}\n`)
    }
    return 0
  },

  async basename(ctx) {
    for (const path of ctx.argv) {
      const parts = ctx.sandbox.normalize(path).split('/').filter(Boolean)
      await ctx.write(`${parts.length ? parts[parts.length - 1] : '/'}\n`)
    }
    return 0
  },

  async test(ctx) {
    const args = ctx.argv[0] === '[' ? ctx.argv.slice(0, ctx.argv[ctx.argv.length - 1] === ']' ? -1 : undefined) : ctx.argv
    if (args.length === 1) return args[0] === '' ? 1 : 0
    const [left, operator, right] = args
    switch (operator) {
      case '-e':
        return existsSync(ctx.sandbox.real(ctx.resolve(left))) ? 0 : 1
      case '-f':
        return existsSync(ctx.sandbox.real(ctx.resolve(left))) && lstatSync(ctx.sandbox.real(ctx.resolve(left))).isFile() ? 0 : 1
      case '-d':
        return existsSync(ctx.sandbox.real(ctx.resolve(left))) && lstatSync(ctx.sandbox.real(ctx.resolve(left))).isDirectory() ? 0 : 1
      case '-L':
      case '-h':
        return existsSync(ctx.sandbox.real(ctx.resolve(left))) && lstatSync(ctx.sandbox.real(ctx.resolve(left))).isSymbolicLink() ? 0 : 1
      case '=':
      case '==':
        return left === right ? 0 : 1
      case '!=':
        return left === right ? 1 : 0
      case '-n':
        return (left ?? '').length > 0 ? 0 : 1
      case '-z':
        return (left ?? '').length === 0 ? 0 : 1
      default:
        return 1
    }
  },

  async sh(ctx) {
    let script
    const dashC = ctx.argv.indexOf('-c')
    if (dashC >= 0) script = ctx.argv[dashC + 1]
    else if (ctx.argv.length) script = readFileSync(ctx.sandbox.real(resolveExisting(ctx, ctx.argv[0]))).toString('utf8')
    else script = await readInputText(ctx)
    if (!script) return 0
    return ctx.interp.run(script)
  },

  /**
   * Fake full-screen application used by the interactive tests.
   *
   * It takes over the alternate screen (like `top` does), redraws on a timer and
   * on resize, and leaves on `q` / Ctrl+C. Every frame carries the terminal size
   * and a frame counter so assertions are exact instead of timing-based.
   */
  async top(ctx) {
    const renderFrame = async (frame) => {
      const cols = ctx.cols
      const rows = ctx.rows
      const header = `top - frame ${frame} - ${FIXED_DATE_LINE.split(' ')[3]} up 1 day,  1 user,  load average: 0.00, 0.01, 0.05`
      const size = `term: ${ctx.term} size: ${cols}x${rows}`
      const tasks = 'Tasks:   4 total,   1 running,   3 sleeping,   0 stopped,   0 zombie'
      const columns = '  PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND'
      const processes = [
        '    1 root      20   0  169m   12m    9m S   0.0   0.3   0:01.23 systemd',
        `  100 ${pad(ctx.user, 8)} 20   0   22m    4m    3m S   0.0   0.1   0:00.41 sshd`,
        `  200 ${pad(ctx.user, 8)} 20   0   28m    5m    4m R   0.3   0.1   0:00.02 top`,
        '  300 nobody    20   0   11m    2m    1m S   0.0   0.0   0:00.07 cron',
      ]
      const footer = '[q] quit   [r] redraw'
      const body = [header, size, tasks, columns, ...processes, footer]
      await ctx.write(`\x1b[H\x1b[2J${body.map((line) => line.slice(0, cols)).join('\r\n')}\x1b[K`)
      ctx.log('top-frame', { frame, cols, rows })
    }

    if (!ctx.tty) {
      await renderFrame(1)
      await ctx.write('\n')
      return 0
    }

    await ctx.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H')
    let frame = 0
    let closed = false
    const paint = async () => {
      frame += 1
      if (!closed) await renderFrame(frame)
    }
    await paint()
    const timer = setInterval(() => {
      void paint()
    }, 250)
    // The loop must end on a channel close / signal too, otherwise the interval
    // keeps the test process alive forever.
    const iterator = ctx.keys()[Symbol.asyncIterator]()
    let aborted = false
    const abortWait = new Promise((resolve) => {
      ctx.abort.onCancel(() => {
        aborted = true
        resolve('abort')
      })
    })
    try {
      for (;;) {
        const chunk = await Promise.race([iterator.next(), abortWait])
        if (aborted || chunk === 'abort') break
        if (chunk.done) break
        const text = Buffer.isBuffer(chunk.value) ? chunk.value.toString('utf8') : String(chunk.value)
        if (text.includes('q') || text.includes('\x03')) break
        if (text.includes('r')) await paint()
      }
    } finally {
      clearInterval(timer)
      closed = true
      await ctx.write('\x1b[?25h\x1b[?1049l')
    }
    const total = frame
    ctx.log('top-exit', { frames: total })
    return 0
  },
}

// `[` is an alias of `test`.
BUILTINS['['] = BUILTINS.test

export const BUILTIN_NAMES = Object.keys(BUILTINS).sort()

// ---------------------------------------------------------------------------
// interactive shell (PTY)
// ---------------------------------------------------------------------------

/**
 * A line-editing interactive shell backing `openShell`.
 *
 * `input()` is called with raw channel bytes; output goes through the `out`
 * callback (which the sshd double wires to the channel). Keystroke handling is
 * intentionally close to a real shell so the plugin's terminal tests exercise
 * real escape sequences: arrow keys, Ctrl+C/D/L/U/K/W, backspace, tab
 * completion and full-screen alternate-screen apps (`top`).
 */
export class InteractiveShell {
  constructor(options) {
    this.sandbox = options.sandbox
    this.user = options.user ?? 'user'
    this.host = options.host ?? 'dsh-test'
    this.home = this.sandbox.home
    this.env = { ...(options.env ?? {}) }
    this.out = options.out
    this.log = options.log ?? (() => {})
    this.motd = options.motd ?? ''
    this.deny = options.deny ?? (() => null)
    this.cols = options.cols ?? 80
    this.rows = options.rows ?? 24
    this.term = options.term ?? 'xterm-256color'
    this.cwd = this.sandbox.normalize(options.cwd ?? this.home)
    this.line = ''
    this.cursor = 0
    this.history = []
    this.historyIndex = 0
    this.savedLine = ''
    this.esc = ''
    this.mode = 'idle'
    this.abort = null
    this.stdin = queueInput()
    this.keyListeners = new Set()
    this.keyIterators = new Set()
    this.lastCode = 0
    this.closed = false
    this.exitCode = 0
    this.frames = 0
    /** Serialises keystroke handling so chunk 2 cannot interleave with chunk 1. */
    this.inputChain = Promise.resolve()
    this.notified = false
    /** Invoked once when the shell decides to end (Ctrl+D, `exit`, close()). */
    this.onClose = options.onClose ?? null
  }

  /** Mark the shell closed and notify the owner exactly once. */
  finish(code) {
    if (this.closed && this.notified) return
    this.closed = true
    this.exitCode = typeof code === 'number' ? code : this.exitCode
    if (this.notified) return
    this.notified = true
    if (typeof this.onClose === 'function') this.onClose(this.exitCode)
  }

  get promptText() {
    return `${this.user}@${this.host}:${this.sandbox.display(this.cwd)}$ `
  }

  async start() {
    const banner = [
      `Welcome to ${this.host} (dsh-ssh protocol test double)`,
      `Last login: ${FIXED_DATE_LINE} from 127.0.0.1`,
      ...(this.motd ? [this.motd] : []),
    ].join('\r\n')
    await this.out(`${banner}\r\n`)
    await this.prompt()
  }

  async write(text) {
    await this.out(text)
  }

  async prompt() {
    if (this.closed) return
    await this.out(`\r${this.promptText}${this.line}`)
    if (this.cursor < this.line.length) await this.out(`\x1b[${this.line.length - this.cursor}D`)
  }

  async renderLine() {
    await this.out(`\r\x1b[K${this.promptText}${this.line}`)
    if (this.cursor < this.line.length) await this.out(`\x1b[${this.line.length - this.cursor}D`)
  }

  /** Feed raw bytes from the channel. */
  input(chunk) {
    const text = (Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))).toString('latin1')
    if (this.closed) return
    if (this.mode === 'running') {
      if (text.includes('\x03')) {
        // Interrupt: do not forward the byte; the running command is cancelled.
        this.abort?.cancel('INT')
        return
      }
      if (text.includes('\x04')) this.stdin.end()
      for (const listener of this.keyListeners) listener(Buffer.from(text, 'latin1'))
      this.stdin.push(Buffer.from(text, 'latin1'))
      return
    }
    this.inputChain = this.inputChain.then(() => this.handleLineInput(text)).catch(() => {})
  }

  async handleLineInput(text) {
    for (const ch of text) {
      if (this.esc) {
        this.esc += ch
        // CSI (`ESC [ ... final`) / SS3 (`ESC O x`) or a bare two-char escape.
        // The fallback must NOT swallow `[` or `O`, otherwise `ESC [ A` would be
        // completed as `ESC [` and the arrow key would leak an "A" keystroke.
        if (/^\x1b(\[[0-9;?]*[A-Za-z~]|O[A-Za-z]|[^[O])$/.test(this.esc)) {
          const sequence = this.esc
          this.esc = ''
          await this.handleEscape(sequence)
        } else if (this.esc.length > 16) {
          this.esc = ''
        }
        continue
      }
      if (ch === '\x1b') {
        this.esc = ch
        continue
      }
      if (ch === '\r' || ch === '\n') {
        await this.submit()
        continue
      }
      if (ch === '\x7f' || ch === '\b') {
        if (this.cursor > 0) {
          this.line = this.line.slice(0, this.cursor - 1) + this.line.slice(this.cursor)
          this.cursor -= 1
          await this.renderLine()
        }
        continue
      }
      if (ch === '\x03') {
        await this.out('^C\r\n')
        this.line = ''
        this.cursor = 0
        await this.prompt()
        continue
      }
      if (ch === '\x04') {
        if (!this.line.length) {
          await this.out('exit\r\n')
          this.finish(this.lastCode)
        }
        continue
      }
      if (ch === '\t') {
        await this.complete()
        continue
      }
      if (ch === '\x0c') {
        await this.out('\x1b[2J\x1b[H')
        await this.renderLine()
        continue
      }
      if (ch === '\x01') {
        this.cursor = 0
        await this.renderLine()
        continue
      }
      if (ch === '\x05') {
        this.cursor = this.line.length
        await this.renderLine()
        continue
      }
      if (ch === '\x15') {
        this.line = this.line.slice(this.cursor)
        this.cursor = 0
        await this.renderLine()
        continue
      }
      if (ch === '\x0b') {
        this.line = this.line.slice(0, this.cursor)
        await this.renderLine()
        continue
      }
      if (ch === '\x17') {
        const head = this.line.slice(0, this.cursor).replace(/\S+\s*$/, '')
        this.line = head + this.line.slice(this.cursor)
        this.cursor = head.length
        await this.renderLine()
        continue
      }
      if (ch < ' ') continue
      this.line = this.line.slice(0, this.cursor) + ch + this.line.slice(this.cursor)
      this.cursor += 1
      await this.renderLine()
    }
  }

  async handleEscape(sequence) {
    if (sequence === '\x1b[A') {
      if (this.historyIndex === this.history.length) this.savedLine = this.line
      if (this.historyIndex > 0) {
        this.historyIndex -= 1
        this.line = this.history[this.historyIndex]
        this.cursor = this.line.length
        await this.renderLine()
      }
      return
    }
    if (sequence === '\x1b[B') {
      if (this.historyIndex < this.history.length) {
        this.historyIndex += 1
        this.line = this.historyIndex === this.history.length ? this.savedLine : this.history[this.historyIndex]
        this.cursor = this.line.length
        await this.renderLine()
      }
      return
    }
    if (sequence === '\x1b[C') {
      if (this.cursor < this.line.length) {
        this.cursor += 1
        await this.out('\x1b[C')
      }
      return
    }
    if (sequence === '\x1b[D') {
      if (this.cursor > 0) {
        this.cursor -= 1
        await this.out('\x1b[D')
      }
      return
    }
    if (sequence === '\x1b[H' || sequence === '\x1b[1~') {
      this.cursor = 0
      await this.renderLine()
      return
    }
    if (sequence === '\x1b[F' || sequence === '\x1b[4~') {
      this.cursor = this.line.length
      await this.renderLine()
      return
    }
    if (sequence === '\x1b[3~') {
      if (this.cursor < this.line.length) {
        this.line = this.line.slice(0, this.cursor) + this.line.slice(this.cursor + 1)
        await this.renderLine()
      }
    }
  }

  async complete() {
    const head = this.line.slice(0, this.cursor)
    const word = /[^\s]*$/.exec(head)[0]
    const wordStart = this.cursor - word.length
    const isCommandPosition = !head.slice(0, wordStart).trim()
    let candidates = []
    if (isCommandPosition) {
      candidates = [...BUILTIN_NAMES].filter((name) => name.startsWith(word))
    } else {
      const slash = word.lastIndexOf('/')
      const dirPart = slash === -1 ? '.' : word.slice(0, slash) || '/'
      const base = slash === -1 ? word : word.slice(slash + 1)
      try {
        const entries = readdirSync(this.sandbox.real(this.sandbox.resolve(this.cwd, dirPart)))
        candidates = entries.filter((name) => name.startsWith(base)).map((name) => (slash === -1 ? name : `${dirPart}/${name}`))
      } catch {
        candidates = []
      }
    }
    if (!candidates.length) return
    if (candidates.length === 1) {
      const completion = `${candidates[0]}`
      this.line = this.line.slice(0, wordStart) + completion + this.line.slice(this.cursor)
      this.cursor = wordStart + completion.length
      await this.renderLine()
      return
    }
    await this.out(`\r\n${candidates.join('  ')}\r\n`)
    await this.renderLine()
  }

  async submit() {
    const text = this.line
    await this.out('\r\n')
    this.line = ''
    this.cursor = 0
    this.esc = ''
    if (text.trim()) {
      this.history.push(text)
      this.historyIndex = this.history.length
    }
    await this.run(text)
  }

  makeKeyIterator() {
    const queue = []
    let resolveNext = null
    let done = false
    const listener = (chunk) => {
      if (done) return
      if (resolveNext) {
        const resolve = resolveNext
        resolveNext = null
        resolve({ value: chunk, done: false })
      } else {
        queue.push(chunk)
      }
    }
    this.keyListeners.add(listener)
    const finish = () => {
      done = true
      this.keyListeners.delete(listener)
      this.keyIterators.delete(finish)
      if (resolveNext) {
        const resolve = resolveNext
        resolveNext = null
        resolve({ value: undefined, done: true })
      }
    }
    this.keyIterators.add(finish)
    return {
      finish,
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            if (queue.length) return Promise.resolve({ value: queue.shift(), done: false })
            if (done) return Promise.resolve({ value: undefined, done: true })
            return new Promise((resolve) => {
              resolveNext = resolve
            })
          },
          return: () => {
            finish()
            return Promise.resolve({ value: undefined, done: true })
          },
        }
      },
    }
  }

  async run(script) {
    this.mode = 'running'
    this.abort = createAbort()
    this.stdin = queueInput()
    const keyIterator = this.makeKeyIterator()
    // A real PTY applies ONLCR, so a bare "\n" reaches the client as "\r\n".
    // Terminal emulators need that translation to render columns correctly.
    const ttyWrite = (chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      return this.out(text.replace(/\r?\n/g, '\r\n'))
    }
    const interp = new Interpreter({
      sandbox: this.sandbox,
      cwd: this.cwd,
      env: this.env,
      user: this.user,
      host: this.host,
      stdout: { kind: 'shell', write: ttyWrite },
      stderr: { kind: 'shell', write: ttyWrite },
      stdin: this.stdin,
      abort: this.abort,
      tty: true,
      cols: this.cols,
      rows: this.rows,
      getSize: () => ({ cols: this.cols, rows: this.rows }),
      term: this.term,
      keys: () => keyIterator,
      deny: this.deny,
      log: this.log,
    })
    try {
      this.lastCode = await interp.run(script)
    } catch (error) {
      await this.out(`sh: ${error && error.message ? error.message : error}\r\n`)
      this.lastCode = 1
    }
    keyIterator.finish()
    this.cwd = interp.cwd
    this.env = interp.env
    this.mode = 'idle'
    if (interp.exitRequested) {
      this.finish(interp.exitCode)
      return
    }
    await this.prompt()
  }

  resize(cols, rows) {
    this.cols = cols
    this.rows = rows
    this.log('resize', { cols, rows })
  }

  signal(name) {
    if (this.mode === 'running') this.abort?.cancel(name)
    else if (name === 'INT') void this.out('^C\r\n').then(() => this.prompt())
  }

  close() {
    // The channel is gone: mark closed without notifying the (dead) stream.
    this.notified = true
    this.closed = true
    if (this.mode === 'running') this.abort?.cancel('HUP')
    this.stdin.end()
    for (const finish of [...this.keyIterators]) finish()
  }
}

/** Convenience: run a script against buffers (used by unit tests of the double). */
export async function runScript(script, options) {
  const stdout = memorySink()
  const stderr = memorySink()
  const interp = new Interpreter({ ...options, stdout, stderr, stdin: options.stdin ?? memoryInput(options.input ?? '') })
  const code = await interp.run(script)
  return { code, stdout: stdout.text(), stderr: stderr.text(), cwd: interp.cwd, env: interp.env, commands: interp.commands }
}
