#!/usr/bin/env node
/**
 * One-button verification for @local/dsh-ssh.
 *
 * Layers run in a fixed order so the cheapest, most-likely-to-fail gate fails
 * first (a single tsc project means one type error blocks every artifact):
 *
 *   1. typecheck      tsc -p tsconfig.json --noEmit          (hard gate, fast)
 *   2. lint           eslint  (or the built-in structural linter when eslint
 *                     is not installed — see docs/TESTING.md)
 *   3. build:host     tsc -p tsconfig.json
 *   4. build:client   node scripts/build-client.mjs
 *   5. bundle:check   node scripts/build-client.mjs --check   (determinism)
 *   6. test:unit      node --test test/unit/*.test.mjs
 *   7. test:client    node --test test/client/*.test.mjs
 *   8. test:integration  node --test test/integration/*.test.mjs
 *   9. test:e2e       node test/e2e/run.mjs
 *  10. test:perf      node --test test/perf/*.test.mjs        (--skip-perf to omit)
 *  11. test:real      node --test test/integration/real-target.test.mjs
 *                     (only with --real, needs DSH_SSH_TEST_REAL_* credentials)
 *
 * Every layer has a hard wall-clock timeout: a hung test process is reported as
 * `TIMEOUT` for that layer and the whole run exits non-zero. Without that, a
 * single leaked handle turns CI into "never finishes" instead of "failed".
 *
 * Options:
 *   --only <id[,id]>   run just these layers (repeatable)
 *   --skip-perf        omit the perf layer (fast iteration)
 *   --real             add the real-target layer (env vars required)
 *   --coverage         add the optional coverage layer (never part of the main flow)
 *   --timeout-factor N multiply every layer timeout (slow machines)
 *   --list             print the layer table and exit
 *   --json             write the machine-readable summary to <tmp>/dsh-ssh-verify.json
 *   --no-build         skip build layers (assume artifacts are current)
 *   --allow-concurrent run even when another `node --test` is already running
 *
 * ICD §12 R9: run exactly one full-suite verification at a time. This script
 * scrubs injected environment variables (`NODE_OPTIONS`, `NODE_V8_COVERAGE`, …)
 * before every layer and refuses to start next to another test run, because that
 * (not a leaked handle) is what makes a file look hung.
 */

import { spawn, spawnSync } from 'node:child_process'
import { readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const NODE = process.execPath
const TSC = join('node_modules', 'typescript', 'bin', 'tsc')

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const valueOf = (name) => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

const timeoutFactor = Number(valueOf('--timeout-factor') ?? 1) || 1
const only = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--only') only.push(...String(argv[i + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean))
}
const skipPerf = flag('--skip-perf')
const withReal = flag('--real')
const withCoverage = flag('--coverage')
const noBuild = flag('--no-build')
const emitJson = flag('--json')

// ---------------------------------------------------------------------------
// Layer definitions
// ---------------------------------------------------------------------------

/**
 * The integration layer runs every `test/integration/*.test.mjs` **except** the
 * real-target one: that file is gated by `DSH_SSH_TEST_REAL_*` and must only run
 * under `--real`, so a configured developer machine cannot accidentally turn the
 * default path into a real-server test run.
 */
const integrationFiles = (() => {
  const dir = join(ROOT, 'test', 'integration')
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.test.mjs') && name !== 'real-target.test.mjs')
      .sort()
      .map((name) => join('test', 'integration', name))
  } catch {
    return [join('test', 'integration', '*.test.mjs')]
  }
})()

/** @typedef {{ id: string, title: string, cmd: string, args: string[], timeoutMs: number, kind?: 'test'|'build'|'lint' }} Layer */

/** @type {Layer[]} */
const layers = [
  {
    id: 'typecheck',
    title: 'typecheck (tsc --noEmit)',
    cmd: NODE,
    args: [TSC, '-p', 'tsconfig.json', '--noEmit'],
    timeoutMs: 180_000,
    kind: 'build',
  },
  {
    id: 'lint',
    title: 'lint (eslint, else built-in structural linter)',
    cmd: NODE,
    args: [join('scripts', 'lint.mjs')],
    timeoutMs: 180_000,
    kind: 'lint',
  },
  {
    id: 'build:host',
    title: 'build host (tsc)',
    cmd: NODE,
    args: [TSC, '-p', 'tsconfig.json'],
    timeoutMs: 240_000,
    kind: 'build',
  },
  {
    id: 'build:client',
    title: 'build client bundle (scripts/build-client.mjs)',
    cmd: NODE,
    args: [join('scripts', 'build-client.mjs')],
    timeoutMs: 180_000,
    kind: 'build',
  },
  {
    id: 'bundle:check',
    title: 'bundle determinism (build-client.mjs --check)',
    cmd: NODE,
    args: [join('scripts', 'build-client.mjs'), '--check'],
    timeoutMs: 180_000,
    kind: 'build',
  },
  {
    id: 'test:unit',
    title: 'host unit tests',
    cmd: NODE,
    args: ['--test', '--test-concurrency=1', '--test-force-exit', '--test-timeout=60000', 'test/unit/*.test.mjs'],
    timeoutMs: 300_000,
    kind: 'test',
  },
  {
    id: 'test:client',
    title: 'client component tests',
    cmd: NODE,
    args: ['--test', '--test-concurrency=1', '--test-force-exit', '--test-timeout=60000', 'test/client/*.test.mjs'],
    timeoutMs: 300_000,
    kind: 'test',
  },
  {
    id: 'test:integration',
    title: 'integration tests (sshd double + OpenSSH interop)',
    cmd: NODE,
    args: ['--test', '--test-concurrency=1', '--test-force-exit', '--test-timeout=120000', ...integrationFiles],
    timeoutMs: 600_000,
    kind: 'test',
  },
  {
    id: 'test:e2e',
    title: 'end-to-end walkthrough (headless)',
    cmd: NODE,
    args: [join('test', 'e2e', 'run.mjs')],
    timeoutMs: 300_000,
    kind: 'test',
  },
  {
    id: 'test:perf',
    title: 'performance (10 sessions, 100MB transfers)',
    cmd: NODE,
    args: ['--test', '--test-concurrency=1', '--test-force-exit', '--test-timeout=600000', 'test/perf/*.test.mjs'],
    timeoutMs: 900_000,
    kind: 'test',
    optional: true,
  },
  {
    id: 'test:real',
    title: 'real target (env-gated, skipped without DSH_SSH_TEST_REAL_*)',
    cmd: NODE,
    args: ['--test', '--test-concurrency=1', '--test-force-exit', '--test-timeout=180000', 'test/integration/real-target.test.mjs'],
    timeoutMs: 300_000,
    kind: 'test',
    realOnly: true,
  },
  {
    id: 'coverage',
    title: 'coverage report (optional; never part of the acceptance run)',
    cmd: NODE,
    args: ['--test', '--test-concurrency=1', '--test-force-exit', '--experimental-test-coverage', 'test/unit/*.test.mjs'],
    timeoutMs: 600_000,
    kind: 'test',
    coverageOnly: true,
  },
]

function selectLayers() {
  let selected = layers
  if (only.length) selected = selected.filter((layer) => only.includes(layer.id))
  if (skipPerf || noBuild) selected = selected.filter((layer) => layer.id !== 'test:perf' || !skipPerf).filter((layer) => !noBuild || layer.kind !== 'build')
  if (!withReal) selected = selected.filter((layer) => !layer.realOnly)
  if (!withCoverage) selected = selected.filter((layer) => !layer.coverageOnly)
  return selected
}

if (flag('--list')) {
  for (const layer of layers) {
    const tags = [layer.optional ? 'optional' : null, layer.realOnly ? 'real-only' : null].filter(Boolean).join(',')
    console.log(`${layer.id.padEnd(18)} ${String(Math.round(layer.timeoutMs / 1000)).padStart(4)}s  ${layer.title}${tags ? `  [${tags}]` : ''}`)
  }
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const OUTPUT_TAIL_LINES = 40

/**
 * Spawn a command, stream its output, and enforce a hard timeout.
 *
 * Piped stdio is used so the tail can be reproduced in the summary; some sandboxed
 * environments refuse pipes (`EPERM` on the spawn), in which case the layer is
 * retried with `inherit` and the tail is reported as unavailable.
 */
function runLayer(layer) {
  const timeoutMs = Math.round(layer.timeoutMs * timeoutFactor)
  const started = Date.now()
  return new Promise((resolve) => {
    let child
    let usedPipes = true
    const spawnWith = (stdio) =>
      spawn(layer.cmd, layer.args, {
        cwd: ROOT,
        stdio,
        windowsHide: true,
        env: scrubbedEnv(),
        // A process group lets us kill `node --test` children as a tree.
        detached: process.platform !== 'win32',
      })
    child = spawnWith(['ignore', 'pipe', 'pipe'])

    const tail = []
    const collect = (chunk) => {
      const text = chunk.toString('utf8')
      process.stdout.write(text)
      for (const line of text.split(/\r?\n/)) {
        if (line.length) tail.push(line)
      }
      while (tail.length > OUTPUT_TAIL_LINES * 3) tail.shift()
    }

    const finish = (status, extra = {}) => {
      clearTimeout(timer)
      resolve({
        ...layer,
        status,
        durationMs: Date.now() - started,
        tail: tail.slice(-OUTPUT_TAIL_LINES),
        ...extra,
      })
    }

    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killTree(child.pid)
      finish('timeout', { note: `exceeded ${Math.round(timeoutMs / 1000)}s hard timeout and was killed` })
    }, timeoutMs)

    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', (error) => {
      if (settled) return
      if (error && error.code === 'EPERM' && usedPipes) {
        // Sandbox refused the pipe: rerun inheriting stdio so the user still sees it.
        usedPipes = false
        clearTimeout(timer)
        try {
          child = spawnWith('inherit')
        } catch (spawnError) {
          settled = true
          killTree(child?.pid)
          finish('fail', { note: `spawn failed: ${spawnError.message}` })
          return
        }
        const retryTimer = setTimeout(() => {
          if (settled) return
          settled = true
          killTree(child.pid)
          finish('timeout', { note: `exceeded ${Math.round(timeoutMs / 1000)}s hard timeout (stdio inherited)` })
        }, Math.max(1000, timeoutMs - (Date.now() - started)))
        child.on('close', (code, signal) => {
          if (settled) return
          settled = true
          clearTimeout(retryTimer)
          finish(code === 0 ? 'pass' : 'fail', { exitCode: code, signal, note: 'stdio inherited; output not captured' })
        })
        return
      }
      settled = true
      finish('fail', { note: `spawn failed: ${error && error.message}` })
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      finish(code === 0 ? 'pass' : 'fail', { exitCode: code, signal })
    })
  })
}

/** Kill a process and its children (node --test spawns one per test file). */
function killTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
  }
}

const STATUS_ICON = { pass: 'PASS', fail: 'FAIL', timeout: 'TIMEOUT', skipped: 'SKIP' }

/**
 * Environment hygiene (ICD §12 R9).
 *
 * The suite is fast (449 unit tests in ~34s) *when it is the only one running*.
 * Injected profiling/coverage variables and a second concurrent `node --test`
 * are what make a file look hung, so every layer runs with a scrubbed
 * environment and the run refuses to start next to another test run.
 */
const ENV_SCRUB = ['NODE_OPTIONS', 'NODE_V8_COVERAGE', 'NODE_DEBUG', 'DSH_SSH_PROFILE_WIRE']

function scrubbedEnv() {
  const env = { ...process.env }
  for (const key of ENV_SCRUB) delete env[key]
  for (const key of Object.keys(env)) {
    if (key.startsWith('NODE_TEST_COVERAGE') || key.startsWith('NODE_COVERAGE')) delete env[key]
  }
  // Keep the run to one file at a time regardless of the caller's shell.
  env.NODE_OPTIONS = ''
  delete env.NODE_OPTIONS
  return env
}

/** Detect a second full-suite run (the documented cause of "a test file hangs"). */
function detectConcurrentTestRuns() {
  if (process.platform !== 'win32') {
    const result = spawnSync('pgrep', ['-fa', 'node --test'], { encoding: 'utf8' })
    return result.status === 0 ? result.stdout.trim().split('\n').filter(Boolean) : []
  }
  const result = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match '--test' } | Select-Object -ExpandProperty CommandLine"],
    { encoding: 'utf8', windowsHide: true },
  )
  const output = (result.stdout ?? '').trim()
  return output ? output.split(/\r?\n/).filter(Boolean) : []
}

function checkConcurrency() {
  const running = detectConcurrentTestRuns()
  if (!running.length) return true
  console.error('\nverify-all: another `node --test` run is already in flight:')
  for (const line of running.slice(0, 5)) console.error(`  ${line.slice(0, 160)}`)
  console.error('\nICD §12 R9: run one full-suite verification at a time. Concurrent runs are the')
  console.error('documented cause of "a test file hangs for 20 minutes" (shared temp dirs, port')
  console.error('pressure, and injected NODE_OPTIONS from another agent). Wait for it to finish,')
  console.error('or pass --allow-concurrent if you deliberately want two runs.')
  return false
}

async function main() {
  const selected = selectLayers()
  if (!selected.length) {
    console.error('verify-all: no layers selected')
    process.exit(2)
  }

  if (!flag('--allow-concurrent') && !checkConcurrency()) process.exit(3)

  console.log('='.repeat(78))
  console.log('@local/dsh-ssh · verify-all')
  console.log(`  layers: ${selected.map((layer) => layer.id).join(' → ')}`)
  if (timeoutFactor !== 1) console.log(`  timeout factor: ${timeoutFactor}`)
  console.log(`  env scrubbed: ${ENV_SCRUB.join(', ')}`)
  console.log('='.repeat(78))

  const results = []
  const startedAt = Date.now()
  for (const layer of selected) {
    console.log(`\n----- [${layer.id}] ${layer.title} (timeout ${Math.round((layer.timeoutMs * timeoutFactor) / 1000)}s)`)
    const result = await runLayer(layer)
    results.push(result)
    console.log(`----- [${layer.id}] ${STATUS_ICON[result.status]} in ${(result.durationMs / 1000).toFixed(1)}s${result.note ? ` · ${result.note}` : ''}`)
  }

  const failed = results.filter((result) => result.status !== 'pass')
  console.log(`\n${'='.repeat(78)}`)
  console.log('summary')
  for (const result of results) {
    const seconds = (result.durationMs / 1000).toFixed(1).padStart(7)
    console.log(`  ${STATUS_ICON[result.status].padEnd(7)} ${result.id.padEnd(18)} ${seconds}s${result.note ? `  ${result.note}` : ''}`)
  }
  const total = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log(`  total ${total}s · ${results.length - failed.length}/${results.length} layers green`)

  if (failed.length) {
    console.log('\nfailed layers:')
    for (const result of failed) {
      console.log(`\n### ${result.id} (${result.status})${result.note ? ` — ${result.note}` : ''}`)
      for (const line of result.tail) console.log(`    ${line}`)
    }
    console.log('\nverify-all: FAILED')
  } else {
    console.log('\nverify-all: OK')
  }

  if (emitJson) {
    const out = join(tmpdir(), 'dsh-ssh-verify.json')
    writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), totalSeconds: Number(total), results: results.map(({ tail, ...rest }) => ({ ...rest, tail: tail.slice(-10) })) }, null, 2), 'utf8')
    console.log(`json: ${out}`)
  }

  process.exit(failed.length ? 1 : 0)
}

void main()
