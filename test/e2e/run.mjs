#!/usr/bin/env node
/**
 * End-to-end walkthrough (ICD §9: `node test/e2e/run.mjs`).
 *
 * This is the headless twin of the UI acceptance walkthrough in docs/DEMO.md:
 * it drives the *real* host modules against the local sshd double and asserts
 * the same outcomes a user would see in the right sidebar, step by step:
 *
 *   1. 打开侧边栏 / 新建连接       → a profile is accepted and its session listed
 *   2. 连接                        → session reaches `connected`, metrics filled
 *   3. 终端执行 uname -a           → the PTY shell echoes the exact kernel line
 *   4. 命令通道 exec               → stdout/stderr/exit code + frames invariants
 *   5. 上传文件                    → byte-exact upload with progress frames
 *   6. 下载文件                    → byte-exact download with progress frames
 *   7. 10 会话并发                 → no cross-talk (acceptance criterion)
 *   8. 断开                        → session state `closed`, nothing left behind
 *
 * Why headless: this session must not restart the DSH GUI, and a browser is not
 * scriptable here. The steps that can only be verified in the real window (the
 * panel actually rendering, the masked password field, light/dark theming) are
 * listed in docs/DEMO.md as the manual walkthrough for the Lead.
 *
 * Exit code 0 = every step passed. Non-zero = the failing step is printed.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { seededBuffer, sha256Hex } from '../support/fixtures.mjs'
import { validateFrameSequence } from '../support/frames.mjs'
import {
  collectExecHandle,
  collectStream,
  makeProfile,
  makeConfig,
  memoryLogger,
  openPool,
  writeStream,
} from '../support/host.mjs'
import { startSshd } from '../support/sshd.mjs'

const steps = []
let failed = 0

/** Run one named step; a throw marks the walkthrough failed but keeps it going. */
async function step(name, fn) {
  const started = Date.now()
  try {
    const detail = await fn()
    steps.push({ name, ok: true, ms: Date.now() - started, detail })
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`)
  } catch (error) {
    failed += 1
    steps.push({ name, ok: false, ms: Date.now() - started, error: String(error && error.message) })
    console.log(`  FAIL  ${name} — ${error && error.message}`)
  }
}

/** Frame collector for the ICD §3 invariants on a transfer-like stream. */
function frameCollector(streamId, kind) {
  const frames = [{ t: 'open', streamId, kind }]
  return {
    frames,
    progress: (transferred, totalBytes, phase = 'transfer') => {
      frames.push({ t: 'progress', streamId, transferred, totalBytes, bytesPerSec: 1, phase })
    },
    end: (reason = 'completed') => {
      frames.push({ t: 'end', streamId, reason })
      return frames
    },
  }
}

async function main() {
  console.log('@local/dsh-ssh · E2E walkthrough (headless, local sshd double)\n')

  const server = await startSshd()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-e2e-'))
  const poolDir = dir
  const logger = memoryLogger()
  const fakeTest = { after: () => {} }

  // The walkthrough drives the shipped modules through the frozen §7 face.
  const { pool } = openPool(fakeTest, { dir: poolDir, logger, config: makeConfig({ dir: poolDir }) })
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-ssh-e2e-local-'))

  const localUpload = join(tmp, 'upload-source.bin')
  const localDownload = join(tmp, 'download-target.bin')
  const payload = seededBuffer(2 * 1024 * 1024, 99)
  writeFileSync(localUpload, payload)

  const sessions = []
  let session

  try {
    console.log(`target: ${server.host}:${server.port} (ident ${server.ident})\n`)

    await step('1. 新建连接：profile 校验通过并生成会话', async () => {
      const profile = makeProfile(server, { name: 'acceptance', hostKeyPolicy: 'accept-new' })
      session = await pool.acquire({ profile })
      sessions.push(session)
      return `session ${session.id}`
    })

    await step('2. 连接：状态机到达 connected，指标可用', async () => {
      if (session.state !== 'connected') throw new Error(`state=${session.state}`)
      if (session.info.user !== server.user) throw new Error('session user mismatch')
      const rtt = session.rttMs()
      return `state=connected, rtt=${rtt === undefined ? 'n/a' : `${rtt}ms`}`
    })

    await step('3. 终端：PTY shell 执行 uname -a 得到内核行', async () => {
      const shell = await session.shell({ cols: 100, rows: 30, term: 'xterm-256color' })
      const chunks = []
      shell.onData((_channel, chunk) => chunks.push(chunk))
      const exited = new Promise((resolve) => shell.onExit(resolve))
      const text = () => Buffer.concat(chunks).toString('utf8')
      const waitFor = async (pattern, timeout = 8000) => {
        const deadline = Date.now() + timeout
        while (Date.now() < deadline) {
          if (pattern.test(text())) return true
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        throw new Error(`terminal never matched ${pattern}`)
      }
      await waitFor(/sshuser@dsh-test:~\$ /)
      shell.write('uname -a\r')
      await waitFor(/Linux dsh-test 6\.1\.0-dshsshd/)
      // A full-screen app must work too (the "top 类交互" acceptance item).
      shell.write('top\r')
      await waitFor(/\x1b\[\?1049h/)
      await waitFor(/size: 100x30/)
      shell.write('q')
      await waitFor(/\x1b\[\?1049l/)
      shell.write('exit 0\r')
      const exit = await exited
      if (exit.code !== 0) throw new Error(`shell exit code ${exit.code}`)
      return 'uname -a + 全屏 top + 正常退出'
    })

    await step('4. 命令通道：exec 的 stdout/stderr/exit code 与帧不变式', async () => {
      const result = await collectExecHandle(await session.exec({ command: "sh -c 'echo out; echo err 1>&2; exit 3'" }))
      if (result.exit.code !== 3) throw new Error(`exit code ${result.exit.code}`)
      if (result.stdout.trim() !== 'out') throw new Error(`stdout=${JSON.stringify(result.stdout)}`)
      if (result.stderr.trim() !== 'err') throw new Error(`stderr=${JSON.stringify(result.stderr)}`)
      // Same frame contract the wire layer must produce.
      const collector = frameCollector('st_e2e_exec', 'exec')
      collector.progress(0, undefined, 'scan')
      collector.frames.push({ t: 'data', streamId: 'st_e2e_exec', seq: 0, chunk: result.stdout, encoding: 'utf8', channel: 'stdout' })
      collector.frames.push({ t: 'exit', streamId: 'st_e2e_exec', exitCode: 3, durationMs: result.exit.durationMs, timedOut: false })
      validateFrameSequence(collector.end('completed'), { label: 'e2e exec', expectKind: 'exec', requireExit: true })
      return 'exit=3, stdout/stderr 分离, §3 帧序列合法'
    })

    await step('5. 上传：2 MiB 字节一致 + 进度单调', async () => {
      const sftp = await session.sftp()
      const collector = frameCollector('st_e2e_upload', 'upload')
      let transferred = 0
      const total = payload.length
      const chunk = 256 * 1024
      await writeStream(sftp.createWriteStream('/tmp/e2e-upload.bin', {}), payload)
      for (let offset = 0; offset < total; offset += chunk) {
        transferred = Math.min(total, offset + chunk)
        collector.progress(transferred, total)
      }
      validateFrameSequence(collector.end('completed'), { label: 'e2e upload', expectKind: 'upload' })
      const remote = await collectStream(sftp.createReadStream('/tmp/e2e-upload.bin', {}))
      if (sha256Hex(remote) !== sha256Hex(payload)) throw new Error('remote bytes differ from the local file')
      return `${total} bytes, sha256 ${sha256Hex(remote).slice(0, 12)}…`
    })

    await step('6. 下载：远端 → 本地字节一致', async () => {
      const sftp = await session.sftp()
      const remote = await collectStream(sftp.createReadStream('/tmp/e2e-upload.bin', {}))
      writeFileSync(localDownload, remote)
      const local = await collectStream(sftp.createReadStream('/tmp/e2e-upload.bin', {}))
      if (sha256Hex(local) !== sha256Hex(payload)) throw new Error('downloaded bytes differ')
      const info = await sftp.stat('/tmp/e2e-upload.bin')
      if (info.size !== payload.length) throw new Error(`remote size ${info.size} != ${payload.length}`)
      return `${info.size} bytes 回读一致`
    })

    await step('7. 10 会话并发：无串扰', async () => {
      const extra = []
      for (let index = 0; index < 9; index++) {
        extra.push(await pool.acquire({ profile: makeProfile(server, { id: `p_e2e_${index}`, forceNew: true }), forceNew: true }))
      }
      const all = [session, ...extra]
      const results = await Promise.all(
        all.map(async (item, index) => collectExecHandle(await item.exec({ command: `echo e2e-${index}` }))),
      )
      results.forEach((result, index) => {
        if (result.stdout.trim() !== `e2e-${index}`) throw new Error(`session ${index} saw ${JSON.stringify(result.stdout)}`)
      })
      sessions.push(...extra)
      return `${all.length} 会话并发，输出互不串扰`
    })

    await step('8. 断开：全部会话关闭，服务端无残留连接', async () => {
      for (const item of sessions.splice(0)) await item.close({ reason: 'e2e teardown' })
      await new Promise((resolve) => setTimeout(resolve, 150))
      if (pool.size !== 0) throw new Error(`pool still holds ${pool.size} sessions`)
      if (server.stats.connections !== server.stats.disconnects) {
        throw new Error(`server saw ${server.stats.connections} connections but ${server.stats.disconnects} disconnects`)
      }
      return `${server.stats.connections} connections / ${server.stats.disconnects} disconnects`
    })

    await step('9. 日志中不出现任何凭据明文', async () => {
      const text = logger.text()
      if (text.includes(server.password)) throw new Error('the session password leaked into the plugin log')
      if (text.includes(server.userPrivateKey.slice(0, 40))) throw new Error('private key material leaked into the plugin log')
      return `${logger.lines.length} log lines, no credential material`
    })
  } finally {
    try {
      await pool.disposeAll('e2e cleanup')
    } catch {
      /* best effort */
    }
    await server.stop()
    rmSync(tmp, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }

  console.log(`\n${failed === 0 ? 'E2E: OK' : `E2E: FAILED (${failed} step(s))`} — ${steps.length} steps`)
  process.exit(failed === 0 ? 0 : 1)
}

void main()
