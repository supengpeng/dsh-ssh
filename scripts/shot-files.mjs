/**
 * Screenshot the file tab at the width it really gets.
 *
 * The reported defect was a *layout* failure - the file names stayed in the DOM but the
 * row's fixed columns squeezed them to zero width - so a screenshot at the real pane
 * width is the only evidence that settles it. There is no browser test runner in this
 * project, so this script borrows the system Edge in headless mode:
 *
 *   1. boot the real client sources (same registry contract as the bundle),
 *   2. server-render the real `FileManager` with both panes populated,
 *   3. embed the real `ssh.session.styles` stylesheet and representative `--dsw-*`
 *      token values for one theme,
 *   4. hand the page to Edge and let it lay out and rasterise.
 *
 * The sidebar width is the production default (config `ui.defaultWidthPx` = 420px), and
 * `FileManager` splits it into two panes, so a pane is ~207px - narrower than the meta
 * columns alone, which is exactly the condition that used to erase the names.
 *
 * Usage: node scripts/shot-files.mjs
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const OUT_DIR = join(ROOT, 'docs', 'img')
const SRC_DIR = join(ROOT, 'client', 'src')

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]

/** Sidebar width from the plugin config default. */
const SIDEBAR_WIDTH = 420
/** Right-sidebar tab body height: enough for a dozen rows. */
const PANEL_HEIGHT = 560

/**
 * Representative token values.
 *
 * DSH supplies these at runtime; the screenshot only needs one faithful light and one
 * faithful dark set, and every colour below is a DSH token name (never a literal in the
 * component sources).
 */
const THEMES = {
  light: {
    '--dsw-alias-bg-base': '#ffffff',
    '--dsw-alias-bg-layer-1': '#f7f8fa',
    '--dsw-alias-bg-layer-2': '#eef0f4',
    '--dsw-alias-bg-overlay': '#ffffff',
    '--dsw-alias-border-l1': '#e3e6ec',
    '--dsw-alias-border-l2': '#d3d8e0',
    '--dsw-alias-brand-primary': '#4c6ef5',
    '--dsw-alias-label-primary': '#1f2430',
    '--dsw-alias-label-secondary': '#6b7280',
    '--dsw-alias-state-error-primary': '#e5484d',
    '--dsw-alias-state-idle-primary': '#9aa1ad',
    '--dsw-alias-state-success-primary': '#30a46c',
    '--dsw-alias-state-warn-primary': '#f5a524',
    '--dsw-alias-specific-sidebar-fill': '#f7f8fa',
  },
  dark: {
    '--dsw-alias-bg-base': '#1b1d22',
    '--dsw-alias-bg-layer-1': '#212429',
    '--dsw-alias-bg-layer-2': '#2a2e35',
    '--dsw-alias-bg-overlay': '#212429',
    '--dsw-alias-border-l1': '#33383f',
    '--dsw-alias-border-l2': '#414751',
    '--dsw-alias-brand-primary': '#7c93f8',
    '--dsw-alias-label-primary': '#e8eaed',
    '--dsw-alias-label-secondary': '#9aa1ad',
    '--dsw-alias-state-error-primary': '#ff6369',
    '--dsw-alias-state-idle-primary': '#6b7280',
    '--dsw-alias-state-success-primary': '#3dd68c',
    '--dsw-alias-state-warn-primary': '#ffb224',
    '--dsw-alias-specific-sidebar-fill': '#212429',
  },
}

/** Collect client sources in assembler order (@order, then path). */
function collectSources(dir, filter) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectSources(full, filter))
    else if (entry.isFile() && entry.name.endsWith('.js') && filter(full)) out.push(full)
  }
  const orderOf = (file) => Number(/@order[ \t]+(\d+)/.exec(readFileSync(file, 'utf8'))?.[1] ?? 500)
  return out.sort((a, b) => orderOf(a) - orderOf(b) || (a < b ? -1 : a > b ? 1 : 0))
}

/** Materialise the session workspace modules into a registry, as the bundle does. */
async function loadRegistry(react, reactDomServer) {
  const factories = Object.create(null)
  const cache = Object.create(null)
  const SSH = {
    id: '@local/dsh-ssh',
    react,
    h: react.createElement,
    Fragment: react.Fragment,
    define(name, factory) {
      factories[name] = factory
    },
    has: (name) => Object.prototype.hasOwnProperty.call(factories, name),
    names: () => Object.keys(factories),
    require(name) {
      if (Object.prototype.hasOwnProperty.call(cache, name)) return cache[name]
      if (!Object.prototype.hasOwnProperty.call(factories, name)) throw new Error(`unknown module "${name}"`)
      cache[name] = {}
      const produced = factories[name](SSH)
      if (produced !== undefined) cache[name] = produced
      return cache[name]
    },
    style: { insert: () => () => {}, disposeAll: () => {} },
    __reactDomServer: reactDomServer,
  }
  const wanted = [/client[\\/]src[\\/]session[\\/]/, /client[\\/]src[\\/]core\.js$/, /client[\\/]src[\\/]bridge\.js$/]
  for (const file of collectSources(SRC_DIR, (full) => wanted.some((pattern) => pattern.test(full)))) {
    new Function('SSH', readFileSync(file, 'utf8'))(SSH)
  }
  return SSH
}

const ENTRIES = {
  local: [
    { name: 'build.log', path: 'C:\\ws\\build.log', type: 'file', size: 2048, mode: '0644', mtime: '2026-01-02T10:00:00.000Z' },
    { name: 'cordis.patch.yml.bak-preset-standard-20260925-222753', path: 'C:\\ws\\cordis.patch.yml.bak-preset-standard-20260925-222753', type: 'file', size: 12800, mode: '0644', mtime: '2026-01-03T09:12:00.000Z' },
    { name: 'payload.bin', path: 'C:\\ws\\payload.bin', type: 'file', size: 104857600, mode: '0644', mtime: '2026-01-04T18:30:00.000Z' },
    { name: 'scripts', path: 'C:\\ws\\scripts', type: 'dir', size: 0, mode: '0755', mtime: '2026-01-05T08:00:00.000Z' },
  ],
  remote: [
    { name: 'etc', path: '/srv/etc', type: 'dir', size: 4096, mode: '0755', mtime: '2026-01-01T00:00:00.000Z' },
    { name: 'www', path: '/srv/www', type: 'dir', size: 4096, mode: '0755', mtime: '2026-01-02T00:00:00.000Z' },
    { name: 'deploy-2026-01-05.tar.gz', path: '/srv/deploy-2026-01-05.tar.gz', type: 'file', size: 31457280, mode: '0644', mtime: '2026-01-05T11:45:00.000Z' },
    { name: 'run.sh', path: '/srv/run.sh', type: 'file', size: 512, mode: '0755', mtime: '2026-01-05T12:00:00.000Z' },
    { name: 'current', path: '/srv/current', type: 'symlink', size: 0, mode: '0777', mtime: '2026-01-05T12:05:00.000Z', isSymlink: true, target: '/srv/releases/2026-01-05' },
  ],
}

function page(theme, markup, css) {
  const tokens = Object.entries(THEMES[theme])
    .map(([name, value]) => `      ${name}: ${value};`)
    .join('\n')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>ssh files · ${theme}</title>
<style>
  :root {
${tokens}
    color-scheme: ${theme};
  }
  html, body { margin:0; padding:0; background:var(--dsw-alias-bg-base); }
  /* The right sidebar at its configured default width, with the tab body height. */
  .shell { width:${SIDEBAR_WIDTH}px; height:${PANEL_HEIGHT}px; overflow:hidden;
    background:var(--dsw-alias-specific-sidebar-fill); border-right:1px solid var(--dsw-alias-border-l1); }
  .shell > div { height:100%; }
${css}
</style></head>
<body><div class="shell">${markup}</div></body></html>
`
}

async function main() {
  const browser = EDGE_CANDIDATES.find((candidate) => {
    try {
      readFileSync(candidate)
      return true
    } catch {
      return false
    }
  })
  if (!browser) {
    console.error('no Edge/Chrome found; cannot rasterise. DOM/CSS assertions in test/client cover the invariant.')
    process.exitCode = 1
    return
  }

  const React = await import('react')
  const ReactDomServer = await import('react-dom/server')
  const SSH = await loadRegistry(React, ReactDomServer)
  const styles = SSH.require('ssh.session.styles')
  const session = SSH.require('ssh.session')
  const FileManager = session.components().FileManager

  const markup = ReactDomServer.renderToStaticMarkup(
    React.createElement(FileManager, {
      sessionId: 's_1',
      localRoot: 'C:\\ws',
      remoteRoot: '/srv',
      localEntries: ENTRIES.local,
      remoteEntries: ENTRIES.remote,
      transfers: [],
      loadingByPane: { local: false, remote: false },
    }),
  )

  mkdirSync(OUT_DIR, { recursive: true })
  const work = mkdtempSync(join(tmpdir(), 'dsh-ssh-shot-'))
  for (const theme of ['light', 'dark']) {
    const htmlPath = join(work, `files-${theme}.html`)
    writeFileSync(htmlPath, page(theme, markup, styles.CSS), 'utf8')
    const out = join(OUT_DIR, `session-files-${theme}.png`)
    execFileSync(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=2',
        `--window-size=${SIDEBAR_WIDTH},${PANEL_HEIGHT}`,
        `--screenshot=${out}`,
        `file:///${htmlPath.replace(/\\/g, '/')}`,
      ],
      { stdio: 'inherit', timeout: 120000 },
    )
    console.log(`wrote ${out.replace(`${ROOT}\\`, '')}`)
  }
}

await main()
