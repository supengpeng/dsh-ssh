/**
 * Install or remove the SSH plugin in a live DSH profile.
 *
 * DSH activates a local plugin through two files in the profile directory:
 * `package.json` (a `link:` dependency puts the package on the profile's module
 * path) and `cordis.patch.yml` (an insert row adds the Loader entry). This script
 * owns exactly those two edits, so they are reviewable, repeatable and reversible
 * instead of being remembered as manual steps.
 *
 * It deliberately does NOT add the package to `dsh.profile.bundles`: the bundle
 * list and the patch layer would then both contribute a row with the same id,
 * and a duplicate Loader entry is a load error. The plugin ships its own
 * `cordis.patch.yml` so the bundle path stays available for a clean profile.
 *
 * Usage (from the plugin package):
 *     node scripts/profile-install.mjs --profile <dir> [--dry-run]
 *     node scripts/profile-install.mjs --profile <dir> --uninstall
 *     node scripts/profile-install.mjs --profile <dir> --status
 *
 * Every write is preceded by a timestamped backup of the file it changes.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = resolve(HERE, '..')
const PACKAGE_NAME = '@local/dsh-ssh'
/** The Loader row id; must equal `name` in src/index.ts and `id` in dsh.plugin.json. */
const ENTRY_ID = 'dsh-ssh'

const MARKER_BEGIN = `# >>> dsh-ssh (managed by scripts/profile-install.mjs) >>>`
const MARKER_END = `# <<< dsh-ssh <<<`

function parseArgs(argv) {
  const args = { profile: null, dryRun: false, uninstall: false, status: false, step: 'both' }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--profile') args.profile = argv[++index]
    else if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--uninstall') args.uninstall = true
    else if (arg === '--status') args.status = true
    else if (arg === '--step') args.step = argv[++index]
    else if (arg === '--help' || arg === '-h') args.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!['both', 'deps', 'patch'].includes(args.step)) throw new Error(`--step must be both|deps|patch, saw "${args.step}"`)
  return args
}

function usage() {
  console.log(`usage: node scripts/profile-install.mjs --profile <dir> [--dry-run|--uninstall|--status] [--step both|deps|patch]`)
  console.log('')
  console.log('  --step deps   edit package.json only (then run pnpm install in the profile)')
  console.log('  --step patch  edit cordis.patch.yml only (the Loader row)')
  console.log('')
  console.log('  On a live profile, use --step deps + pnpm install FIRST, then --step patch:')
  console.log('  the patch layer reloads immediately, and a row whose module is not yet')
  console.log('  linked would fail its import.')
}

function timestamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  )
}

function backup(file, dryRun) {
  if (!existsSync(file)) return null
  const target = `${file}.bak-dsh-ssh-${timestamp()}`
  if (!dryRun) copyFileSync(file, target)
  return target
}

/** The plugin's link specifier, using forward slashes as the profile does. */
function linkSpecifier() {
  return `link:${PACKAGE_DIR.split('\\').join('/')}`
}

/** Insert `name` into the JSON object at `key`, keeping it sorted by key. */
function withDependency(json, name, specifier) {
  const parsed = JSON.parse(json)
  parsed.dependencies = parsed.dependencies ?? {}
  parsed.dependencies[name] = specifier
  parsed.dependencies = Object.fromEntries(Object.entries(parsed.dependencies).sort(([a], [b]) => a.localeCompare(b)))
  return `${JSON.stringify(parsed, null, 2)}\n`
}

function withoutDependency(json, name) {
  const parsed = JSON.parse(json)
  if (parsed.dependencies && name in parsed.dependencies) {
    delete parsed.dependencies[name]
    parsed.dependencies = Object.fromEntries(Object.entries(parsed.dependencies).sort(([a], [b]) => a.localeCompare(b)))
  }
  return `${JSON.stringify(parsed, null, 2)}\n`
}

/** The managed block appended to the profile's patch layer. */
function managedBlock() {
  return [
    MARKER_BEGIN,
    '# Insert the SSH plugin as a Loader entry. Values equal the schema defaults in',
    "# the plugin's src/config.ts, so deleting any line changes nothing.",
    '- insert:',
    `    - id: ${ENTRY_ID}`,
    `      name: '${PACKAGE_NAME}'`,
    '      config:',
    "        hostKey:",
    "          policy: accept-new",
    '        ui:',
    '          defaultWidthPx: 420',
    '          locale: auto',
    MARKER_END,
    '',
  ].join('\n')
}

function applyBlock(text) {
  const start = text.indexOf(MARKER_BEGIN)
  if (start >= 0) {
    const end = text.indexOf(MARKER_END, start)
    const after = end >= 0 ? text.indexOf('\n', end) + 1 : text.length
    return text.slice(0, start) + managedBlock() + text.slice(after)
  }
  const separator = text.endsWith('\n') ? '' : '\n'
  return `${text}${separator}${managedBlock()}`
}

function removeBlock(text) {
  const start = text.indexOf(MARKER_BEGIN)
  if (start < 0) return text
  const end = text.indexOf(MARKER_END, start)
  const after = end >= 0 ? text.indexOf('\n', end) + 1 : text.length
  return (text.slice(0, start) + text.slice(after)).replace(/\n{3,}/g, '\n\n')
}

function report(status, profileDir) {
  const packageFile = join(profileDir, 'package.json')
  const patchFile = join(profileDir, 'cordis.patch.yml')
  const hasDep = existsSync(packageFile) && readFileSync(packageFile, 'utf8').includes(PACKAGE_NAME)
  const hasRow = existsSync(patchFile) && readFileSync(patchFile, 'utf8').includes(MARKER_BEGIN)
  const linked = existsSync(join(profileDir, 'node_modules', '@local', 'dsh-ssh'))
  console.log(`${status} — profile: ${profileDir}`)
  console.log(`  package.json dependency : ${hasDep ? 'present' : 'absent'}`)
  console.log(`  cordis.patch.yml row    : ${hasRow ? 'present' : 'absent'}`)
  console.log(`  node_modules link       : ${linked ? 'present' : 'absent'}`)
  console.log(`  package dir             : ${PACKAGE_DIR}`)
  return { hasDep, hasRow, linked }
}

const args = parseArgs(process.argv.slice(2))
if (args.help || !args.profile) {
  usage()
  process.exit(args.help ? 0 : 2)
}

const profileDir = resolve(args.profile)
if (!existsSync(join(profileDir, 'package.json'))) {
  console.error(`not a DSH profile (no package.json): ${profileDir}`)
  process.exit(2)
}

if (args.status) {
  report('STATUS', profileDir)
  process.exit(0)
}

const packageFile = join(profileDir, 'package.json')
const patchFile = join(profileDir, 'cordis.patch.yml')
const changes = []

if (args.uninstall) {
  if (args.step !== 'patch') {
    const packageBackup = backup(packageFile, args.dryRun)
    const next = withoutDependency(readFileSync(packageFile, 'utf8'), PACKAGE_NAME)
    changes.push({ file: packageFile, next, backup: packageBackup })
  }
  if (args.step !== 'deps' && existsSync(patchFile)) {
    const patchBackup = backup(patchFile, args.dryRun)
    changes.push({ file: patchFile, next: removeBlock(readFileSync(patchFile, 'utf8')), backup: patchBackup })
  }
} else {
  if (args.step !== 'patch') {
    const packageBackup = backup(packageFile, args.dryRun)
    const next = withDependency(readFileSync(packageFile, 'utf8'), PACKAGE_NAME, linkSpecifier())
    changes.push({ file: packageFile, next, backup: packageBackup })
  }
  if (args.step !== 'deps' && existsSync(patchFile)) {
    const patchBackup = backup(patchFile, args.dryRun)
    changes.push({ file: patchFile, next: applyBlock(readFileSync(patchFile, 'utf8')), backup: patchBackup })
  }
}

for (const change of changes) {
  const before = readFileSync(change.file, 'utf8')
  if (before === change.next) {
    console.log(`unchanged ${change.file}`)
    continue
  }
  if (args.dryRun) {
    console.log(`would write ${change.file}${change.backup ? ` (backup: ${change.backup})` : ''}`)
    continue
  }
  writeFileSync(change.file, change.next, 'utf8')
  console.log(`wrote ${change.file}${change.backup ? ` (backup: ${change.backup})` : ''}`)
}

report(args.uninstall ? 'UNINSTALLED' : 'INSTALLED', profileDir)
console.log('')
console.log('Next steps:')
console.log('  1. pnpm install in the profile directory, so the link appears in node_modules.')
console.log('  2. Reload the DSH window. A live profile applies the patch layer without a restart;')
console.log('     if the row does not appear, DSH must be restarted once.')
console.log(args.uninstall ? '  3. Run pnpm install again to prune the stale link.' : '  3. The SSH icon appears in the sidebar panel list.')
