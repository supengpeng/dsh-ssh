/**
 * Fixture helpers for the protocol-level sshd double (see `sshd.mjs`).
 *
 * Everything here is deterministic on purpose: the whole test suite runs against
 * this double instead of a real Linux host (this machine has neither Docker nor
 * WSL), so "random" payloads are seeded and every timestamp is injectable.
 */

import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'

/** Create a throwaway root directory that the sshd double chroots into. */
export function createTempRoot(prefix = 'dsh-sshd-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Best-effort recursive removal (Windows keeps handles a little longer). */
export function removeTempRoot(dir, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return true
    } catch {
      if (i === attempts - 1) return false
      // Busy FS: spin briefly, the caller only wants best effort cleanup.
      const until = Date.now() + 50 * (i + 1)
      while (Date.now() < until) { /* wait */ }
    }
  }
  return false
}

/** Normalise a POSIX path that is always absolute (`..` can never escape `/`). */
export function normalizeVirtual(path) {
  if (typeof path !== 'string' || path === '') return '/'
  let out = posix.normalize(path.startsWith('/') ? path : `/${path}`)
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1)
  return out
}

/**
 * A chroot-like view over a real directory.
 *
 * The double exposes *virtual* absolute paths (`/home/sshuser/docs`) to both the
 * shell and SFTP, and maps them onto the real temp directory. That mirrors how a
 * chrooted sshd behaves, keeps Windows path separators out of the wire, and lets
 * tests assert on stable paths.
 */
export function createSandbox(root, home = '/home/user') {
  const real = (vpath) => {
    const parts = normalizeVirtual(vpath).split('/').filter(Boolean)
    return parts.length ? join(root, ...parts) : root
  }
  const virtual = (realPath) => {
    const rel = realPath.slice(root.length).split(/[\\/]/).filter(Boolean)
    return rel.length ? `/${rel.join('/')}` : '/'
  }
  return {
    root,
    home: normalizeVirtual(home),
    normalize: normalizeVirtual,
    /** Resolve `arg` (relative or absolute or `~`) against `cwd`. */
    resolve(cwd, arg = '') {
      if (arg === '' || arg === undefined || arg === null) return normalizeVirtual(cwd)
      if (arg === '~') return normalizeVirtual(home)
      if (arg.startsWith('~/') || arg.startsWith('~\\')) return normalizeVirtual(`${home}/${arg.slice(2)}`)
      if (arg.startsWith('/')) return normalizeVirtual(arg)
      return normalizeVirtual(`${normalizeVirtual(cwd)}/${arg}`)
    },
    real,
    virtual,
    exists(vpath) {
      return existsSync(real(vpath))
    },
    /** `~/sub` form used by the shell prompt. */
    display(vpath) {
      const p = normalizeVirtual(vpath)
      if (p === home) return '~'
      if (p.startsWith(`${home}/`)) return `~${p.slice(home.length)}`
      return p
    },
  }
}

/**
 * Materialise a tree of files.
 *
 * Keys are relative to `root` (or absolute virtual paths). Values:
 *   - string | Buffer     → file content
 *   - { content, mode }   → file content with an explicit permission bits
 *   - { symlinkTo }       → symlink
 *   - null                → directory
 */
export function writeTree(root, tree) {
  for (const [key, value] of Object.entries(tree)) {
    const target = key.startsWith('/') ? join(root, ...key.split('/').filter(Boolean)) : join(root, key)
    if (value === null) {
      mkdirSync(target, { recursive: true })
      continue
    }
    if (typeof value === 'object' && value !== null && 'symlinkTo' in value) {
      mkdirSync(dirname(target), { recursive: true })
      try {
        symlinkSync(value.symlinkTo, target, 'file')
      } catch {
        /* symlinks may need elevation on Windows; callers opt in explicitly */
      }
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    const content = typeof value === 'object' && value !== null && 'content' in value ? value.content : value
    writeFileSync(target, content)
    if (typeof value === 'object' && value !== null && typeof value.mode === 'number') {
      chmodSync(target, value.mode)
    }
  }
}

/** The default fixture tree: a plausible Linux-ish home plus /etc and /tmp. */
export function defaultFixtureTree(home = '/home/user', options = {}) {
  const user = options.user ?? 'user'
  const tree = {
    [home]: null,
    [`${home}/docs`]: null,
    [`${home}/docs/notes.md`]: '# notes\n\n- fixture file for the dsh-ssh test double\n',
    [`${home}/docs/todo.txt`]: 'one\ntwo\nthree\n',
    [`${home}/readme.txt`]: 'hello from the dsh-ssh fixture tree\n',
    [`${home}/.hidden`]: 'dotfiles are filtered by default\n',
    [`${home}/uploads`]: null,
    [`${home}/downloads`]: null,
    '/etc/hostname': `${options.hostname ?? 'dsh-test'}\n`,
    '/etc/motd': 'fixture sshd — protocol-level double, not a real shell\n',
    '/tmp': null,
    '/var/log': null,
    '/var/log/app.log': '[info] boot\n[info] ready\n[warn] nothing to warn about\n',
    [`/home/${user}`]: null,
  }
  return tree
}

/** Recursive listing of a real directory as `virtualPath -> { size, mode }`. */
export function snapshotTree(root, dir = root, out = {}) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    const rel = `/${full.slice(root.length).split(/[\\/]/).filter(Boolean).join('/')}`
    if (entry.isDirectory()) {
      out[rel] = { type: 'dir' }
      snapshotTree(root, full, out)
    } else if (entry.isSymbolicLink()) {
      out[rel] = { type: 'symlink', target: safeReadlink(full) }
    } else {
      const st = statSync(full)
      out[rel] = { type: 'file', size: st.size, mode: st.mode & 0o7777 }
    }
  }
  return out
}

function safeReadlink(path) {
  try {
    return readlinkSync(path)
  } catch {
    return undefined
  }
}

/** Sizes/modes of one file, tolerating symlinks that Windows refuses to follow. */
export function statOf(path) {
  const ls = lstatSync(path)
  return {
    size: ls.size,
    mode: ls.mode & 0o7777,
    isDirectory: ls.isDirectory(),
    isSymbolicLink: ls.isSymbolicLink(),
    mtimeMs: ls.mtimeMs,
  }
}

/** Read a file that must exist (test helper with a clearer failure message). */
export function readFixture(path) {
  if (!existsSync(path)) throw new Error(`fixture missing: ${path}`)
  return readFileSync(path)
}

/**
 * Deterministic pseudo-random bytes (xorshift32). Used for large transfer
 * payloads so a byte mismatch is reproducible across runs.
 */
export function seededBuffer(size, seed = 0x2f6e2b1) {
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError(`seededBuffer: bad size ${size}`)
  const words = new Uint32Array(Math.floor(size / 4))
  let s = seed >>> 0 || 1
  for (let i = 0; i < words.length; i++) {
    s ^= s << 13; s >>>= 0
    s ^= s >>> 17
    s ^= s << 5; s >>>= 0
    words[i] = s
  }
  const out = Buffer.allocUnsafe(size)
  if (words.length) Buffer.from(words.buffer, 0, words.length * 4).copy(out, 0)
  const tail = size - words.length * 4
  for (let i = 0; i < tail; i++) out[words.length * 4 + i] = (s >>> (8 * (i % 4))) & 0xff
  return out
}

/** `SHA256:base64` with padding stripped — byte-for-byte the ICD §7 fingerprint. */
export function fingerprint(keyType, keyBlob) {
  const digest = createHash('sha256').update(keyBlob).digest('base64').replace(/=+$/, '')
  return `SHA256:${digest}`
}

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex')
}

/** One `known_hosts` line, hashed-host format not used (readable on purpose). */
export function knownHostsLine(host, port, keyType, keyBlob) {
  const name = Number(port) === 22 ? host : `[${host}]:${port}`
  return `${name} ${keyType} ${keyBlob.toString('base64')}`
}

export function delay(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer)
        resolve()
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/** Poll `predicate` until it is truthy or the budget runs out. */
export async function waitFor(predicate, { timeout = 5000, interval = 25, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`waitFor: timed out after ${timeout}ms waiting for ${label}`)
    await delay(interval)
  }
}

export function isWindows() {
  return process.platform === 'win32'
}

/** Human readable byte count, handy in test failure messages. */
export function humanBytes(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)}${units[unit]}`
}
