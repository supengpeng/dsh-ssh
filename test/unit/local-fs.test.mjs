/**
 * Local-side listing tests.
 *
 * The dual pane's local half is the only place the plugin reads the operator's
 * own filesystem, so the tests cover the boring-but-load-bearing parts: the
 * resolved `cwd` is absolute and honest, hidden entries are opt-in, symlinks stay
 * symlinks, one unreadable entry cannot fail a whole listing, and the error codes
 * are the frozen ones (a wrong code here shows the user a misleading message).
 */

import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { test } from 'node:test'

import { listLocalDir, resolveLocalPath, statLocal } from '../../lib/api/local-fs.js'

/** Build a disposable tree: two files, a hidden file, a subdirectory, a symlink. */
function makeTree() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ssh-local-'))
  mkdirSync(join(root, 'sub'))
  writeFileSync(join(root, 'beta.txt'), 'beta')
  writeFileSync(join(root, 'alpha.txt'), 'alpha-content')
  writeFileSync(join(root, '.hidden'), 'shh')
  try {
    symlinkSync(join(root, 'alpha.txt'), join(root, 'link-to-alpha'))
  } catch {
    /* symlink creation may need privileges; the tree is still usable */
  }
  return root
}

test('a relative request resolves against the configured root', () => {
  const root = makeTree()
  try {
    assert.equal(resolveLocalPath(undefined, { root }), root)
    assert.equal(resolveLocalPath('sub', { root }), join(root, 'sub'))
    assert.equal(resolveLocalPath('sub/../sub', { root }), join(root, 'sub'))
    assert.equal(resolveLocalPath(root, { root }), root, 'an absolute path wins')
    assert.equal(isAbsolute(resolveLocalPath(undefined, {})), true, 'defaults to an absolute cwd')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('listing reports an absolute cwd and sorts directories first', async () => {
  const root = makeTree()
  try {
    const { entries, cwd } = await listLocalDir({}, { root })
    assert.equal(cwd, root)
    assert.equal(isAbsolute(cwd), true)

    const names = entries.map((entry) => entry.name)
    assert.ok(names.includes('alpha.txt') && names.includes('beta.txt'))
    assert.equal(names.includes('.hidden'), false, 'dot-entries are opt-in')

    const firstDir = entries.findIndex((entry) => entry.type === 'dir')
    const firstFile = entries.findIndex((entry) => entry.type === 'file')
    assert.ok(firstDir >= 0 && firstFile >= 0)
    assert.ok(firstDir < firstFile, 'directories sort before files')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('entry metadata is real: size, mode string and an ISO mtime', async () => {
  const root = makeTree()
  try {
    const { entries } = await listLocalDir({}, { root })
    const alpha = entries.find((entry) => entry.name === 'alpha.txt')
    assert.ok(alpha)
    assert.equal(alpha.size, 'alpha-content'.length)
    assert.match(alpha.mode, /^[0-7]{4}$/, 'mode is an octal string from the shared formatter')
    assert.ok(!Number.isNaN(Date.parse(alpha.mtime)), 'mtime parses as a date')
    assert.equal(alpha.path, join(root, 'alpha.txt'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('hidden entries appear when explicitly requested', async () => {
  const root = makeTree()
  try {
    const { entries } = await listLocalDir({ showHidden: true }, { root })
    assert.ok(entries.some((entry) => entry.name === '.hidden'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a symlink stays a symlink instead of becoming its target', async () => {
  const root = makeTree()
  try {
    const { entries } = await listLocalDir({}, { root })
    const link = entries.find((entry) => entry.name === 'link-to-alpha')
    if (!link) return // symlink creation was not permitted on this machine
    assert.equal(link.type, 'symlink')
    assert.equal(link.isSymlink, true)
    assert.notEqual(link.size, 'alpha-content'.length, 'lstat, not stat: the target size is not borrowed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a missing directory fails with the frozen code, not a raw Node error', async () => {
  const root = makeTree()
  try {
    await assert.rejects(
      () => listLocalDir({ path: 'nope' }, { root }),
      (error) => {
        assert.equal(error.code, 'SSH_SFTP_NO_SUCH_FILE')
        assert.equal(error.retryable, false)
        assert.deepEqual(error.details, { path: join(root, 'nope') })
        return true
      },
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('listing a file as a directory reports SSH_SFTP_IS_A_DIRECTORY', async () => {
  const root = makeTree()
  try {
    await assert.rejects(
      () => listLocalDir({ path: 'alpha.txt' }, { root }),
      (error) => {
        assert.equal(error.code, 'SSH_SFTP_IS_A_DIRECTORY')
        return true
      },
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an unreadable single entry degrades to an unknown row instead of failing the list', async () => {
  const root = makeTree()
  const warnings = []
  try {
    // Inject the failure rather than relying on filesystem permissions, which are
    // not portable: exactly one entry cannot be stat'ed.
    const { entries } = await listLocalDir(
      {},
      {
        root,
        logger: { warn: (message) => warnings.push(message) },
        statEntry: async (target) => {
          if (target.endsWith('beta.txt')) {
            const error = new Error('EACCES: simulated')
            error.code = 'EACCES'
            throw error
          }
          return lstatSync(target)
        },
      },
    )

    const beta = entries.find((entry) => entry.name === 'beta.txt')
    assert.ok(beta, 'the row survives so the user can still see the file')
    assert.equal(beta.size, 0, 'unknown metadata rather than a fabricated value')
    assert.ok(entries.some((entry) => entry.name === 'alpha.txt'), 'siblings are unaffected')
    assert.equal(warnings.length, 1, 'the failure is reported, not swallowed')
    assert.match(warnings[0], /beta\.txt/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a dangling symlink is still listed as a link (lstat does not follow it)', async () => {
  const root = makeTree()
  try {
    try {
      symlinkSync(join(root, 'does-not-exist'), join(root, 'dangling'))
    } catch {
      return // symlink creation was not permitted on this machine
    }
    const { entries } = await listLocalDir({}, { root })
    const dangling = entries.find((entry) => entry.name === 'dangling')
    assert.ok(dangling, 'a broken link is a fact the user needs to see')
    assert.equal(dangling.type, 'symlink')
    assert.equal(dangling.isSymlink, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('statLocal reports presence with real metadata', async () => {
  const root = makeTree()
  try {
    const { info } = await statLocal({ path: 'alpha.txt' }, { root })
    assert.equal(info.exists, true)
    assert.equal(info.name, 'alpha.txt')
    assert.equal(info.type, 'file')
    assert.equal(info.size, 'alpha-content'.length)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('statLocal reports absence as exists:false rather than throwing', async () => {
  const root = makeTree()
  try {
    const { info } = await statLocal({ path: 'ghost.txt' }, { root })
    assert.equal(info.exists, false)
    assert.equal(info.name, 'ghost.txt')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('statLocal requires a path', async () => {
  await assert.rejects(
    () => statLocal({ path: '   ' }),
    (error) => {
      assert.equal(error.code, 'SSH_CFG_INVALID')
      return true
    },
  )
})
