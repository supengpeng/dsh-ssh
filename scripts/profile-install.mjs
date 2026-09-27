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
 * It writes TWO managed blocks into the patch layer: the plugin row, and an `hmr`
 * row that watches this package's source trees so a rebuilt host half is picked up
 * without an app restart. The second block carries the Windows caveat that made the
 * obvious configuration (`root: [<package>]` plus the shipped ignore list) silently
 * useless — see `hmrBlock()`.
 *
 * Usage (from the plugin package):
 *     node scripts/profile-install.mjs --profile <dir> [--dry-run]
 *     node scripts/profile-install.mjs --profile <dir> --uninstall
 *     node scripts/profile-install.mjs --profile <dir> --status
 *
 * Every write is preceded by a timestamped backup of the file it changes.
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = resolve(HERE, '..')
const PACKAGE_NAME = '@local/dsh-ssh'
/** The Loader row id; must equal `name` in src/index.ts and `id` in dsh.plugin.json. */
const ENTRY_ID = 'dsh-ssh'

const MARKER_BEGIN = `# >>> dsh-ssh (managed by scripts/profile-install.mjs) >>>`
const MARKER_END = `# <<< dsh-ssh <<<`
/** The hot-reload watch row; a separate block because a hand-edited one existed first. */
const HMR_MARKER_BEGIN = `# >>> dsh-ssh hmr watch (managed by dsh-ssh) >>>`
const HMR_MARKER_END = `# <<< dsh-ssh hmr watch <<<`
/**
 * The bundles route's companion block.
 *
 * A profile that declares the package in `dsh.profile.bundles` still carries a
 * materialised `dsh-ssh` row with `disabled: true`, so the row has to be enabled
 * by id. This replaces the insert row rather than joining it: two rows with the
 * same id are not what either route means.
 */
const ENABLE_MARKER_BEGIN = `# >>> dsh-ssh enable (managed by scripts/profile-install.mjs) >>>`
const ENABLE_MARKER_END = `# <<< dsh-ssh enable <<<`

function parseArgs(argv) {
  const args = { profile: null, dryRun: false, uninstall: false, status: false, check: false, installDeps: false, useBundles: false, step: 'both' }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--profile') args.profile = argv[++index]
    else if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--uninstall') args.uninstall = true
    else if (arg === '--status') args.status = true
    else if (arg === '--check') args.check = true
    else if (arg === '--install-deps') args.installDeps = true
    else if (arg === '--use-bundles') args.useBundles = true
    else if (arg === '--step') args.step = argv[++index]
    else if (arg === '--help' || arg === '-h') args.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!['both', 'deps', 'patch'].includes(args.step)) throw new Error(`--step must be both|deps|patch, saw "${args.step}"`)
  return args
}

/**
 * Resolve `--profile` to a directory.
 *
 * A bare name is what people actually type (`--profile web`, `--profile
 * desktop`), and the profiles live under `$DSH_HOME/profiles/<name>`; a path is
 * still accepted so a throwaway profile outside DSH_HOME keeps working.
 */
function resolveProfileDir(value) {
  if (value === null) return null
  const candidate = resolve(value)
  if (existsSync(join(candidate, 'package.json'))) return candidate
  const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  const named = join(dshHome, 'profiles', value)
  if (existsSync(join(named, 'package.json'))) return named
  return candidate
}

function usage() {
  console.log(`usage: node scripts/profile-install.mjs --profile <name|dir> [options]`)
  console.log('')
  console.log('  --step both|deps|patch  limit the edit to package.json or the patch layer')
  console.log('  --use-bundles           declare the plugin in dsh.profile.bundles instead of')
  console.log('                          inserting a Loader row (the route the web profile uses);')
  console.log('                          adds the enable override and drops the insert block')
  console.log('  --install-deps          run `pnpm install` in the profile afterwards, so the')
  console.log('                          link: dependency actually appears in node_modules')
  console.log('  --status                report what is installed, which route is in use, and')
  console.log('                          whether the profile still composes')
  console.log('  --check                 same report, but exit non-zero when something is wrong')
  console.log('  --dry-run               print the files that would change, write nothing')
  console.log('  --uninstall             remove the dependency, the managed blocks and the bundle entry')
  console.log('')
  console.log('  On a live profile, use --step deps + --install-deps FIRST, then --step patch:')
  console.log('  the patch layer reloads immediately, and a row whose module is not yet')
  console.log('  linked would fail its import.')
  console.log('')
  console.log('  Two routes exist, and mixing them is what the check warns about:')
  console.log('    patch   (default)      a managed insert row in the profile patch layer')
  console.log('    bundles (--use-bundles) a dsh.profile.bundles entry + an enable override;')
  console.log('                            this is how the web profile declares the plugin')
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

/**
 * Add `name` to `dsh.profile.bundles`.
 *
 * The other route: a bundle's own `cordis.patch.yml` supplies its Loader row, so
 * the profile only has to declare the package. This is how the `web` profile
 * declares the plugin, while `desktop` uses the insert-row route.
 */
function withBundle(json, name) {
  const parsed = JSON.parse(json)
  parsed.dsh = parsed.dsh ?? {}
  parsed.dsh.profile = parsed.dsh.profile ?? {}
  const bundles = Array.isArray(parsed.dsh.profile.bundles) ? parsed.dsh.profile.bundles : []
  if (!bundles.includes(name)) bundles.push(name)
  parsed.dsh.profile.bundles = bundles
  return `${JSON.stringify(parsed, null, 2)}\n`
}

function withoutBundle(json, name) {
  const parsed = JSON.parse(json)
  const bundles = parsed.dsh?.profile?.bundles
  if (Array.isArray(bundles)) parsed.dsh.profile.bundles = bundles.filter((entry) => entry !== name)
  return `${JSON.stringify(parsed, null, 2)}\n`
}

function bundleDeclared(json, name) {
  try {
    const bundles = JSON.parse(json)?.dsh?.profile?.bundles
    return Array.isArray(bundles) && bundles.includes(name)
  } catch {
    return false
  }
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

/** The enable override that accompanies the bundles route. */
function enableBlock() {
  return [
    ENABLE_MARKER_BEGIN,
    '# The plugin comes from `dsh.profile.bundles` above; its own cordis.patch.yml',
    '# supplies the Loader row (with the full config), and the materialised row is',
    '# disabled, so it has to be enabled by id here.',
    `- id: ${ENTRY_ID}`,
    '  disabled: false',
    ENABLE_MARKER_END,
    '',
  ].join('\n')
}

/**
 * The managed HMR block.
 *
 * A rebuilt host half reaches a running GUI only through hot reload, and the
 * shipped `hmr` row watches nothing until roots are named. The roots are the three
 * source trees rather than the package directory, and `ignored` is emptied, because
 * of a measured Windows defect (2026-09-27): the watcher matches `ignored` against
 * `relative(baseDir, path)`, where `baseDir` is the *profile* directory — a sibling
 * of this package. On Windows that path is `..\plugins\dsh-ssh\lib\service.js`:
 * picomatch does not treat `\` as a separator, so the whole string is one segment
 * beginning with `.` and the shipped dot-segment pattern ignores **every** file
 * under the root. A rebuilt `lib/` tree then produced no reload event at all — a
 * rebuilt host stayed invisible, and re-enabling the row only re-ran `apply()` on
 * the already-cached module (observed: the same method count before and after).
 * None of these three roots contains `node_modules` or a dot-directory, so watching
 * them directly is both correct and cheaper than the whole package.
 */
function hmrBlock() {
  const root = PACKAGE_DIR.split('\\').join('/')
  return [
    HMR_MARKER_BEGIN,
    '# Opt this package into module hot-reload so a rebuilt host half is picked up',
    '# without an app restart. The shipped default is `root: []` — module roots are',
    '# opt-in — so an install has to name them.',
    '#',
    '# The roots are the source trees (not the package directory) and `ignored` is',
    '# empty on purpose: on Windows the watch predicate is matched against a path',
    '# relative to the *profile* directory, which makes the package tree look like a',
    '# dot-directory and the shipped ignore patterns swallow every event. See',
    "# src/index.ts's header for the measurement.",
    '- id: hmr',
    '  config:',
    '    root:',
    `      - ${root}/lib`,
    `      - ${root}/src`,
    `      - ${root}/client/src`,
    '    ignored: []',
    HMR_MARKER_END,
    '',
  ].join('\n')
}

/** Replace the block between `begin` and `end`, or append it when absent. */
function applyManaged(text, begin, end, block) {
  const start = text.indexOf(begin)
  if (start >= 0) {
    const endIndex = text.indexOf(end, start)
    const after = endIndex >= 0 ? text.indexOf('\n', endIndex) + 1 : text.length
    return text.slice(0, start) + block + text.slice(after)
  }
  const separator = text.endsWith('\n') ? '' : '\n'
  return `${text}${separator}${block}`
}

/** Remove the block between `begin` and `end`. */
function removeManaged(text, begin, end) {
  const start = text.indexOf(begin)
  if (start < 0) return text
  const endIndex = text.indexOf(end, start)
  const after = endIndex >= 0 ? text.indexOf('\n', endIndex) + 1 : text.length
  return (text.slice(0, start) + text.slice(after)).replace(/\n{3,}/g, '\n\n')
}

/**
 * Write the patch layer for the chosen route.
 *
 * `bundles` route: the enable override plus the HMR block, and no insert row.
 * `patch` route: the insert row plus the HMR block, and no enable override —
 * each route owns exactly one way of introducing the row.
 */
function applyBlock(text, route) {
  const withHmr = applyManaged(text, HMR_MARKER_BEGIN, HMR_MARKER_END, hmrBlock())
  if (route === 'bundles') {
    return applyManaged(removeManaged(withHmr, MARKER_BEGIN, MARKER_END), ENABLE_MARKER_BEGIN, ENABLE_MARKER_END, enableBlock())
  }
  return applyManaged(removeManaged(withHmr, ENABLE_MARKER_BEGIN, ENABLE_MARKER_END), MARKER_BEGIN, MARKER_END, managedBlock())
}

function removeBlock(text) {
  return removeManaged(
    removeManaged(removeManaged(text, MARKER_BEGIN, MARKER_END), HMR_MARKER_BEGIN, HMR_MARKER_END),
    ENABLE_MARKER_BEGIN,
    ENABLE_MARKER_END,
  )
}

/**
 * Ask DSH to compose the profile and report what it says.
 *
 * This is the only check that answers the question a person actually has
 * ("does it load?"), and it catches the failure this script cannot see on its
 * own: a profile whose `dsh.profile.bundles` names a package that resolves
 * neither from the installation nor from the profile. `--dump-config` prints
 * the composed tree and exits.
 */
function compositionCheck(profileDir) {
  const name = basename(profileDir)
  const result = spawnSync('dsh', ['--profile', name, '--dump-config'], { encoding: 'utf8', timeout: 120_000, shell: false })
  if (result.error !== undefined && result.error !== null) {
    return { ran: false, ok: false, detail: `could not run \`dsh\` (${result.error.code ?? result.error.message})` }
  }
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  // The Electron application owns its profile and refuses CLI introspection. That
  // is a limitation of *this check*, not a defect in the profile: reporting it as
  // a failure would make the check cry wolf on the profile that works.
  if (/managed exclusively by the Electron application/i.test(output)) {
    return { ran: false, ok: true, detail: 'the Electron app owns this profile; compose it from the app' }
  }
  const rows = (output.match(new RegExp(`^- id: ${ENTRY_ID}$`, 'gm')) ?? []).length
  if (result.status !== 0) {
    const firstError = output.split('\n').find((line) => /error|cannot resolve/i.test(line)) ?? output.split('\n')[0] ?? ''
    return { ran: true, ok: false, rows, detail: firstError.trim().slice(0, 160) }
  }
  return { ran: true, ok: rows === 1, rows, detail: rows === 1 ? `1 row for ${ENTRY_ID}` : `${rows} rows for ${ENTRY_ID}` }
}

/** Run the profile's own install so the `link:` dependency reaches node_modules. */
function installProfileDeps(profileDir, dryRun) {
  if (dryRun) {
    console.log(`would run: pnpm install (in ${profileDir})`)
    return true
  }
  // A single command string with `shell: true` on Windows (pnpm is a .cmd shim),
  // and no argument array: passing args *and* a shell is what raises DEP0190.
  const result =
    process.platform === 'win32'
      ? spawnSync('pnpm install', { cwd: profileDir, stdio: 'inherit', shell: true })
      : spawnSync('pnpm', ['install'], { cwd: profileDir, stdio: 'inherit' })
  return result.status === 0
}

function report(status, profileDir, { compose = false } = {}) {
  const packageFile = join(profileDir, 'package.json')
  const patchFile = join(profileDir, 'cordis.patch.yml')
  const packageJson = existsSync(packageFile) ? readFileSync(packageFile, 'utf8') : ''
  const patchYml = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
  const hasDep = packageJson.includes(PACKAGE_NAME)
  const hasBundled = bundleDeclared(packageJson, PACKAGE_NAME)
  const hasRow = patchYml.includes(MARKER_BEGIN)
  const hasEnable = patchYml.includes(ENABLE_MARKER_BEGIN)
  const hasHmr = patchYml.includes(HMR_MARKER_BEGIN)
  const linked = existsSync(join(profileDir, 'node_modules', '@local', 'dsh-ssh'))
  const routes = [hasRow ? 'patch' : null, hasBundled ? 'bundles' : null].filter(Boolean)
  const composition = compose ? compositionCheck(profileDir) : null
  // `problems` fail `--check`; `warnings` are printed but do not. The split is
  // deliberate: a check that fails on a working profile trains people to ignore
  // it, so only conditions with a demonstrated failure count.
  const problems = []
  const warnings = []
  if (!hasDep) problems.push('the profile does not depend on the package')
  if (routes.length === 0) problems.push('no route declares the plugin (neither an insert row nor a bundle entry)')
  if (routes.length > 1) warnings.push('both routes are in use (an insert row and a bundle entry each add a row); one route is the intended shape')
  if (hasEnable && !hasBundled) problems.push('an enable override exists without the bundle entry it belongs to')
  if (composition !== null && composition.ran && !composition.ok) problems.push(`the profile does not compose: ${composition.detail}`)
  if (composition !== null && !composition.ran) warnings.push(`composition not checked here: ${composition.detail}`)

  console.log(`${status} — profile: ${profileDir}`)
  console.log(`  package.json dependency : ${hasDep ? 'present' : 'absent'}`)
  console.log(`  route                   : ${routes.length === 0 ? 'none' : routes.join(' + ')}`)
  console.log(`  cordis.patch.yml row    : ${hasRow ? 'present' : 'absent'}`)
  console.log(`  enable override         : ${hasEnable ? 'present' : 'absent'}`)
  console.log(`  hmr watch block         : ${hasHmr ? 'present' : 'absent'}`)
  console.log(`  node_modules link       : ${linked ? 'present' : 'absent'}`)
  if (composition !== null) {
    console.log(`  composition             : ${composition.ran ? (composition.ok ? 'ok' : 'FAILED') : 'not checked'}`)
    if (!composition.ok || !composition.ran) console.log(`    ${composition.detail}`)
  }
  console.log(`  package dir             : ${PACKAGE_DIR}`)
  console.log(`  verdict                 : ${problems.length === 0 ? 'ok' : `${problems.length} problem(s)`}`)
  for (const problem of problems) console.log(`    ! ${problem}`)
  for (const warning of warnings) console.log(`    - ${warning}`)
  return { hasDep, hasBundled, hasRow, hasEnable, hasHmr, linked, routes, composition, problems, warnings }
}

const args = parseArgs(process.argv.slice(2))
if (args.help || !args.profile) {
  usage()
  process.exit(args.help ? 0 : 2)
}

const profileDir = resolveProfileDir(args.profile)
if (!existsSync(join(profileDir, 'package.json'))) {
  console.error(`not a DSH profile (no package.json): ${profileDir}`)
  process.exit(2)
}

if (args.status || args.check) {
  const state = report(args.check ? 'CHECK' : 'STATUS', profileDir, { compose: true })
  process.exit(args.check && state.problems.length > 0 ? 1 : 0)
}

const packageFile = join(profileDir, 'package.json')
const patchFile = join(profileDir, 'cordis.patch.yml')
const route = args.useBundles ? 'bundles' : 'patch'
const changes = []

if (args.uninstall) {
  if (args.step !== 'patch') {
    const packageBackup = backup(packageFile, args.dryRun)
    const next = withoutBundle(withoutDependency(readFileSync(packageFile, 'utf8'), PACKAGE_NAME), PACKAGE_NAME)
    changes.push({ file: packageFile, next, backup: packageBackup })
  }
  if (args.step !== 'deps' && existsSync(patchFile)) {
    const patchBackup = backup(patchFile, args.dryRun)
    changes.push({ file: patchFile, next: removeBlock(readFileSync(patchFile, 'utf8')), backup: patchBackup })
  }
} else {
  if (args.step !== 'patch') {
    const packageBackup = backup(packageFile, args.dryRun)
    const withLink = withDependency(readFileSync(packageFile, 'utf8'), PACKAGE_NAME, linkSpecifier())
    const next = route === 'bundles' ? withBundle(withLink, PACKAGE_NAME) : withLink
    changes.push({ file: packageFile, next, backup: packageBackup })
  }
  if (args.step !== 'deps' && existsSync(patchFile)) {
    const patchBackup = backup(patchFile, args.dryRun)
    changes.push({ file: patchFile, next: applyBlock(readFileSync(patchFile, 'utf8'), route), backup: patchBackup })
  }
}

let wrote = false
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
  wrote = true
  console.log(`wrote ${change.file}${change.backup ? ` (backup: ${change.backup})` : ''}`)
}

if (args.installDeps && args.step !== 'patch') {
  // The link: dependency is inert until the profile resolves it, which is the
  // step the README used to ask the operator to remember.
  console.log('')
  console.log(`running pnpm install in ${profileDir} …`)
  const installed = installProfileDeps(profileDir, args.dryRun)
  if (!installed) {
    console.error('pnpm install failed; the profile still does not link the package')
    process.exitCode = 1
  }
} else if (wrote && args.step !== 'patch') {
  console.log('')
  console.log('Next: run `pnpm install` in the profile (or re-run this script with --install-deps).')
}

report(args.uninstall ? 'UNINSTALLED' : 'INSTALLED', profileDir, { compose: true })
console.log('')
console.log('Next steps:')
console.log('  1. Composition is checked above: `composition: ok` means DSH resolved the profile')
console.log('     and found exactly one row for the plugin.')
console.log('  2. Reload the DSH window. A live profile applies the patch layer without a restart;')
console.log('     if the row does not appear, DSH must be restarted once.')
console.log(args.uninstall ? '  3. Run pnpm install again to prune the stale link.' : '  3. The SSH icon appears in the sidebar panel list.')
console.log('')
console.log('Profiles differ: `desktop` (the Electron app) uses the patch route, and `web`')
console.log('(`dsh web`) declares the plugin through dsh.profile.bundles — pass --use-bundles')
console.log('for that shape. A profile whose bundles name a package that resolves neither from')
console.log('the installation nor from the profile fails to compose; the check above says so.')
