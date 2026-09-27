/**
 * Self-test for the sshd double (`test/support/sshd.mjs`).
 *
 * Everything the plugin's integration tests rely on is asserted here: real
 * password/publickey auth over a real socket, exec with env/cwd/exit codes,
 * an interactive PTY shell (including a full-screen app and signalling), the
 * full SFTP operation set, and the failure-injection helpers.
 *
 * If this file is red, no other integration layer can be trusted.
 */

import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import test from 'node:test'

import ssh2 from 'ssh2'

import { fingerprint, seededBuffer, sha256Hex, waitFor } from '../support/fixtures.mjs'
import { UNAME_LINE } from '../support/minish.mjs'
import { collectExec, startSshd, withSftp, withSshd } from '../support/sshd.mjs'

const { Client } = ssh2

/** Connect and collect the client error (if any) instead of throwing. */
function connectRaw(config) {
  const client = new Client()
  return new Promise((resolve) => {
    let settled = false
    client.once('ready', () => {
      if (!settled) {
        settled = true
        resolve({ client, error: null })
      }
    })
    // `on` (not `once`): a later reset must not become an unhandled 'error'.
    client.on('error', (error) => {
      if (!settled) {
        settled = true
        resolve({ client, error })
      }
    })
    try {
      client.connect(config)
    } catch (error) {
      // ssh2 throws synchronously for an unreadable / bad-passphrase key.
      settled = true
      resolve({ client, error })
    }
  })
}

/** Drive an interactive shell: collect output, wait for patterns, type input. */
function openShell(client, options = {}) {
  const chunks = []
  let closed = false
  let exitCode = null
  const waiters = new Set()
  const notify = () => {
    for (const waiter of waiters) waiter()
  }
  return new Promise((resolve, reject) => {
    client.shell({ term: 'xterm-256color', cols: 80, rows: 24, ...options }, (error, stream) => {
      if (error) return reject(error)
      stream.on('data', (data) => {
        chunks.push(data)
        notify()
      })
      stream.stderr.on('data', (data) => {
        chunks.push(data)
        notify()
      })
      stream.on('exit', (code) => {
        exitCode = code
      })
      stream.on('close', () => {
        closed = true
        notify()
      })
      const handle = {
        stream,
        text: () => Buffer.concat(chunks).toString('utf8'),
        get closed() {
          return closed
        },
        get exitCode() {
          return exitCode
        },
        write: (data) => stream.write(data),
        signal: (name) => stream.signal(name),
        setWindow: (rows, cols) => stream.setWindow(rows, cols),
        /** Byte offset used to ignore output produced earlier in the session. */
        mark: () => Buffer.concat(chunks).length,
        async waitFor(pattern, timeout = 5000) {
          return waitForText(handle, pattern, timeout, 0)
        },
        /** Wait for `pattern` in output produced *after* `from` (no stale matches). */
        async waitForNew(pattern, timeout = 5000, from = Buffer.concat(chunks).length) {
          return waitForText(handle, pattern, timeout, from)
        },
      }

      async function waitForText(handle, pattern, timeout, from) {
        const deadline = Date.now() + timeout
        for (;;) {
          const text = handle.text().slice(from)
          if (pattern.test(text)) return true
          if (Date.now() > deadline) {
            throw new Error(`shell output never matched ${pattern}\n--- new output ---\n${text}\n--- full output ---\n${handle.text()}`)
          }
          await new Promise((res) => {
            const timer = setTimeout(() => {
              waiters.delete(finish)
              res()
            }, 25)
            const finish = () => {
              clearTimeout(timer)
              waiters.delete(finish)
              res()
            }
            waiters.add(finish)
          })
        }
      }

      resolve(handle)
    })
  })
}

test('sshd double: password authentication over a real socket', async (t) => {
  const server = await startSshd()
  t.after(() => server.stop())

  assert.equal(typeof server.port, 'number')
  assert.ok(server.port > 0, 'ephemeral port assigned')
  assert.match(server.hostKeyFingerprint, /^SHA256:[A-Za-z0-9+/]+$/)
  assert.equal(server.hostKeyFingerprint, fingerprint(server.hostKeyType, server.hostKeyBlob))

  const { client, error } = await connectRaw(server.config)
  assert.equal(error, null, `password auth should succeed: ${error && error.message}`)
  assert.ok(server.stats.connections >= 1)
  assert.ok(server.stats.authSuccesses >= 1)
  client.end()
})

test('sshd double: publickey authentication (inline key and key file)', async (t) => {
  await withSshd(async (server) => {
    const inline = await connectRaw(server.keyConfig)
    assert.equal(inline.error, null, `inline publickey auth should succeed: ${inline.error && inline.error.message}`)
    inline.client.end()

    // What `privateKeyPath`-based profiles do: read the key from disk.
    assert.ok(existsSync(server.identityFile), 'identity file written into the fixture root')
    const fromDisk = await connectRaw({
      host: server.host,
      port: server.port,
      username: server.user,
      privateKey: readFileSync(server.identityFile),
    })
    assert.equal(fromDisk.error, null, `file-based publickey auth should succeed: ${fromDisk.error && fromDisk.error.message}`)
    fromDisk.client.end()

    // Encrypted key without passphrase must be refused, with passphrase accepted.
    const missingPassphrase = await connectRaw({
      host: server.host,
      port: server.port,
      username: server.user,
      privateKey: readFileSync(server.identityFileEncrypted),
      passphrase: 'wrong',
    })
    assert.ok(missingPassphrase.error, 'encrypted key with a wrong passphrase must fail')

    const withPassphrase = await connectRaw({
      host: server.host,
      port: server.port,
      username: server.user,
      privateKey: readFileSync(server.identityFileEncrypted),
      passphrase: server.keyPassphrase,
    })
    assert.equal(withPassphrase.error, null, 'encrypted key with the right passphrase should succeed')
    withPassphrase.client.end()
  })
})

test('sshd double: rejects wrong credentials and unsupported methods', async (t) => {
  await withSshd(async (server) => {
    const wrongPassword = await connectRaw({ ...server.config, password: 'nope' })
    assert.ok(wrongPassword.error, 'wrong password must fail')
    assert.ok(server.stats.authFailures >= 1)

    const wrongUser = await connectRaw({ ...server.config, username: 'root' })
    assert.ok(wrongUser.error, 'unknown user must fail')

    // Only password left: a key-only client cannot authenticate.
    server.setAllowedMethods(['password'])
    const keyOnly = await connectRaw(server.keyConfig)
    assert.ok(keyOnly.error, 'publickey must be refused when the server only offers password')
    assert.deepEqual(server.getAllowedMethods(), ['password'])
  })
})

test('sshd double: exec returns stdout, stderr, exit code, env and cwd', async (t) => {
  await withSshd(async (server) => {
    const client = await server.connect()

    const uname = await collectExec(client, 'uname -a')
    assert.equal(uname.code, 0)
    assert.equal(uname.stdout.trim(), UNAME_LINE)

    const mixed = await collectExec(client, "sh -c 'echo out; echo err 1>&2; exit 3'")
    assert.equal(mixed.code, 3)
    assert.equal(mixed.stdout.trim(), 'out')
    assert.equal(mixed.stderr.trim(), 'err')

    const envRequest = await collectExec(client, 'echo $DSH_SSH_PROBE', { env: { DSH_SSH_PROBE: 'value-42' } })
    assert.equal(envRequest.stdout.trim(), 'value-42')
    assert.equal(server.stats.lastEnv?.DSH_SSH_PROBE, 'value-42')

    const cwd = await collectExec(client, 'cd /etc && pwd')
    assert.equal(cwd.stdout.trim(), '/etc')

    const piped = await collectExec(client, 'printf "a\\nb\\nc\\n" | wc -l')
    assert.equal(piped.stdout.trim(), '3')

    const missing = await collectExec(client, 'definitely-not-a-command')
    assert.equal(missing.code, 127)
    assert.match(missing.stderr, /command not found/)

    const fileHash = await collectExec(client, `sha256sum ${server.home}/readme.txt`)
    assert.match(fileHash.stdout, /^[0-9a-f]{64} {2}\/home\//)

    client.end()
    assert.ok(server.stats.execs >= 6)
    assert.ok(server.stats.bytesOut > 0)
  })
})

test('sshd double: exec streams stdin through a channel', async (t) => {
  await withSshd(async (server) => {
    const client = await server.connect()
    const result = await new Promise((resolve, reject) => {
      client.exec('cat', (error, stream) => {
        if (error) return reject(error)
        const chunks = []
        stream.on('data', (chunk) => chunks.push(chunk))
        stream.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')))
        stream.write('line one\n')
        stream.write('line two\n')
        stream.end()
      })
    })
    assert.equal(result, 'line one\nline two\n')
    client.end()
  })
})

test('sshd double: interactive PTY shell, resize and full-screen app', async (t) => {
  await withSshd(async (server) => {
    const client = await server.connect()
    const shell = await openShell(client)
    t.after(() => client.end())

    await shell.waitFor(/Welcome to dsh-test/)
    await shell.waitFor(/sshuser@dsh-test:~\$ /)

    shell.write('echo hello-pty\r')
    await shell.waitFor(/hello-pty\r\n/)

    shell.write('pwd\r')
    await shell.waitFor(/\/home\/sshuser\r\n/)

    // line editing: backspace is echoed and applied
    shell.write('echo abx\x7f\r')
    await shell.waitFor(/^ab\r\n/m)

    // history recall via the up arrow
    shell.write('\x1b[A')
    await shell.waitFor(/echo ab\r/)
    shell.write('\r')
    await shell.waitFor(/^ab\r\n/m)

    assert.equal(server.stats.ptys >= 1, true)

    // Full-screen app: alternate screen + terminal size + quit
    shell.write('top\r')
    await shell.waitFor(/\x1b\[\?1049h/)
    await shell.waitFor(/size: 80x24/)

    shell.stream.setWindow(30, 100)
    await shell.waitFor(/size: 100x30/)

    shell.write('q')
    await shell.waitFor(/\x1b\[\?1049l/)
    await shell.waitFor(/sshuser@dsh-test:~\$ /)

    // Two full frames were rendered (plus the initial one).
    const frames = server.events.filter((event) => event.event === 'top-frame').length
    assert.ok(frames >= 2, `expected at least 2 top frames, saw ${frames}`)

    // Exit through Ctrl+D ends the channel with the last exit code.
    shell.write('exit 7\r')
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(shell.closed, true)
    assert.equal(shell.exitCode, 7)
  })
})

test('sshd double: shell signal interrupts a running command', async (t) => {
  await withSshd(async (server) => {
    const client = await server.connect()
    const shell = await openShell(client)
    t.after(() => client.end())

    await shell.waitFor(/sshuser@dsh-test:~\$ /)
    const mark = shell.mark()
    shell.write('sleep 30\r')
    await new Promise((resolve) => setTimeout(resolve, 150))
    shell.signal('INT')

    await waitFor(
      () => server.events.some((event) => event.event === 'signal' && event.name === 'INT'),
      { timeout: 3000, label: 'server-side signal event' },
    )

    // The shell must be back in line-editing mode: a command typed now has to
    // execute, which can only happen if `sleep 30` was actually interrupted.
    const started = Date.now()
    shell.write('echo after-signal\r')
    await shell.waitForNew(/after-signal/, 4000, mark)
    assert.ok(Date.now() - started < 4000, 'the interrupt must not wait for sleep 30 to finish')
  })
})

test('sshd double: SFTP full operation set', async (t) => {
  await withSshd(async (server) => {
    const client = await server.connect()
    t.after(() => client.end())

    await withSftp(client, async (sftp) => {
      const home = server.home
      const entries = await new Promise((resolve, reject) => {
        sftp.readdir(home, (error, list) => (error ? reject(error) : resolve(list)))
      })
      const names = entries.map((entry) => entry.filename).sort()
      assert.ok(names.includes('readme.txt'), `expected fixture files, saw ${names.join(',')}`)
      assert.ok(names.includes('docs'))

      const stats = await new Promise((resolve, reject) => sftp.stat(`${home}/readme.txt`, (e, s) => (e ? reject(e) : resolve(s))))
      assert.equal(stats.isFile(), true)
      assert.ok(stats.size > 0)
      assert.equal(typeof stats.mode, 'number')
      // The double emulates Linux umask semantics so this holds on Windows too.
      assert.equal(stats.mode & 0o777, 0o644)

      // write → read → rename → stat → chmod → remove
      const target = '/tmp/sftp-roundtrip.bin'
      const payload = seededBuffer(256 * 1024, 7)
      await new Promise((resolve, reject) => {
        const out = sftp.createWriteStream(target)
        out.on('close', resolve)
        out.on('error', reject)
        out.end(payload)
      })
      const readBack = await new Promise((resolve, reject) => {
        const input = sftp.createReadStream(target)
        const chunks = []
        input.on('data', (chunk) => chunks.push(chunk))
        input.on('end', () => resolve(Buffer.concat(chunks)))
        input.on('error', reject)
      })
      assert.equal(sha256Hex(readBack), sha256Hex(payload), 'streamed round trip must be byte exact')

      await new Promise((resolve, reject) => sftp.rename(target, '/tmp/sftp-renamed.bin', (e) => (e ? reject(e) : resolve())))
      await new Promise((resolve, reject) => sftp.chmod('/tmp/sftp-renamed.bin', 0o600, (e) => (e ? reject(e) : resolve())))
      const afterChmod = await new Promise((resolve, reject) => sftp.stat('/tmp/sftp-renamed.bin', (e, s) => (e ? reject(e) : resolve(s))))
      assert.equal(afterChmod.mode & 0o777, 0o600)

      await new Promise((resolve, reject) => sftp.mkdir('/tmp/sftp-dir', (e) => (e ? reject(e) : resolve())))
      await new Promise((resolve, reject) => sftp.rmdir('/tmp/sftp-dir', (e) => (e ? reject(e) : resolve())))
      await new Promise((resolve, reject) => sftp.unlink('/tmp/sftp-renamed.bin', (e) => (e ? reject(e) : resolve())))

      const missing = await new Promise((resolve) => sftp.stat('/tmp/does-not-exist', (error) => resolve(error)))
      assert.equal(missing.code, 2, 'SFTP v3 NO_SUCH_FILE')

      // Positioned writes are what resume/offset uploads use.
      const resumed = '/tmp/sftp-resume.bin'
      await new Promise((resolve, reject) => {
        const out = sftp.createWriteStream(resumed)
        out.on('close', resolve)
        out.on('error', reject)
        out.end(Buffer.from('0123456789'))
      })
      await new Promise((resolve, reject) => {
        const out = sftp.createWriteStream(resumed, { flags: 'r+', start: 5 })
        out.on('close', resolve)
        out.on('error', reject)
        out.end(Buffer.from('ABCDE'))
      })
      const resumedContent = await new Promise((resolve, reject) => {
        const input = sftp.createReadStream(resumed)
        const chunks = []
        input.on('data', (chunk) => chunks.push(chunk))
        input.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        input.on('error', reject)
      })
      assert.equal(resumedContent, '01234ABCDE')
    })

    assert.ok(server.stats.sftpSessions >= 1)
    assert.ok(server.stats.sftpRequests > 5)
  })
})

test('sshd double: denyPath produces deterministic permission errors', async (t) => {
  await withSshd(async (server) => {
    server.denyPath(`${server.home}/readme.txt`, 'r')
    const client = await server.connect()
    t.after(() => client.end())

    const denied = await withSftp(client, (sftp) =>
      new Promise((resolve) => sftp.stat(`${server.home}/readme.txt`, (error) => resolve(error))))
    assert.ok(denied, 'denied path must fail')
    assert.equal(denied.code, 3, 'SFTP v3 PERMISSION_DENIED')

    const allowed = await withSftp(client, (sftp) =>
      new Promise((resolve, reject) => sftp.stat(`${server.home}/docs/notes.md`, (error, s) => (error ? reject(error) : resolve(s)))))
    assert.equal(allowed.isFile(), true)

    await Promise.all([denied, allowed]).catch(() => {})
  })
})

test('sshd double: freeze() black-holes the link and trips the client keepalive', async (t) => {
  await withSshd(async (server) => {
    const client = await server.connect({ keepaliveInterval: 100, keepaliveCountMax: 2 })
    // The client's keepalive timer would keep the test process alive; always end it.
    t.after(() => client.end())
    // ssh2 answers a global request with a reply, so a live link responds instantly;
    // `freeze()` pauses the socket, which is the deterministic "dead link" that
    // SSH_TIMEOUT_IDLE is about.
    const timedOut = new Promise((resolve) => client.once('error', (error) => resolve(error)))
    server.freeze()
    const error = await Promise.race([
      timedOut,
      new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
    ])
    assert.ok(error, 'client should report a keepalive timeout on a frozen link')
    assert.match(String(error.message), /Keepalive timeout/)
    assert.equal(error.level, 'client-timeout')
    server.unfreeze()
    client.end()
  })
})

test('sshd double: dropAll resets live connections', async (t) => {
  await withSshd(async (server) => {
    const client = await server.connect({ readyTimeout: 3000 })
    const closed = new Promise((resolve) => client.once('close', () => resolve('close')))
    const errored = new Promise((resolve) => client.once('error', (error) => resolve(error)))
    server.dropAll()
    const outcome = await Promise.race([closed, errored])
    assert.ok(outcome, 'client should observe the reset')
  })
})

test('sshd double: one-shot helpers and fixture root lifecycle', async () => {
  let seenRoot
  await withSshd(async (server) => {
    seenRoot = server.root
    const result = await server.execOnce('echo one-shot')
    assert.equal(result.stdout.trim(), 'one-shot')
    assert.equal(result.code, 0)
    assert.ok(existsSync(server.root))
  })
  assert.equal(existsSync(seenRoot), false, 'withSshd removes the fixture root on stop')
})

test('sshd double: identical fixture bytes are reproducible', () => {
  assert.equal(sha256Hex(seededBuffer(64 * 1024, 11)), sha256Hex(seededBuffer(64 * 1024, 11)))
  assert.notEqual(sha256Hex(seededBuffer(64 * 1024, 11)), sha256Hex(seededBuffer(64 * 1024, 12)))
})
