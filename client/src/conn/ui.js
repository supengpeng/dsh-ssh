/**
 * @module ssh.conn.ui
 * @order 105
 *
 * Shared layer of the connection manager: translation, the UI primitives, the
 * (token-only) stylesheet, and the pure helpers the list and the form both need.
 *
 * **Why it borrows from `ssh.session.ui`.** That module is the project's UI kit —
 * primitives, formatters, path helpers — and both surfaces live in the same panel
 * with the same ICD §8.6 token discipline. Re-exporting it keeps one button style,
 * one input style and one icon set instead of two that drift. Nothing in
 * `ssh.session/**` is modified by this module; it is read-only reuse.
 *
 * Every helper here is pure, so the policies worth getting right — what "matches
 * the search box", how profiles group, and how a credential's state is described —
 * are testable without a DOM.
 */

SSH.define('ssh.conn.ui', function (SSH) {
  const sessionUi = () => SSH.require('ssh.session.ui')

  let rt = { app: null, api: null, chrome: null }

  /** Wire the container's store, endpoint client and chrome (called by the plugin). */
  function configure(next) {
    rt = { ...rt, ...next }
    return rt
  }

  function app() {
    return rt.app
  }

  function api() {
    return rt.api
  }

  /** The chrome module when it loaded, without making it a hard dependency. */
  function chrome() {
    if (rt.chrome) return rt.chrome
    try {
      return SSH.require('ssh.chrome')
    } catch {
      return null
    }
  }

  /**
   * Translate a key.
   *
   * Order matters: the chrome registers the full `conn.*`/`err.*`/`ws.*` dictionaries
   * with the shell's locale service, so it is asked first; the session UI kit's
   * translator is the fallback (it carries the `ws.*` strings and an identity
   * fallback), and a missing key surfaces as the key itself — which is exactly what
   * `errorText()` reads to decide between a dictionary message and a raw one.
   */
  function t(key, params) {
    const module = chrome()
    const translate = module && module.i18n && typeof module.i18n.t === 'function' ? module.i18n.t : null
    if (translate) {
      try {
        const text = translate(key, params)
        if (typeof text === 'string' && text !== '' && text !== key) return text
      } catch {
        /* fall through to the session translator */
      }
    }
    return sessionUi().t(key, params)
  }

  /** The primitive set (frozen props from ICD §8.3, resolved to whatever is installed). */
  function ui() {
    return sessionUi().ui()
  }

  /**
   * Stylesheet for the connection surfaces.
   *
   * Token-only, like every other sheet in this plugin: no literal colour, and the
   * one elevation cue derives from `--dsw-alias-label-primary` through `color-mix`
   * so it stays visible in dark mode (ICD v1.0.8).
   */
  const CSS = `
.dsh-ssh-conn { display:flex; flex-direction:column; height:100%; min-height:0; }
.dsh-ssh-conn-toolbar { display:flex; align-items:center; gap:6px; padding:6px 8px; border-bottom:1px solid var(--dsw-alias-border-l1); }
.dsh-ssh-conn-search { flex:1 1 auto; min-width:0; }
.dsh-ssh-conn-scroll { flex:1 1 auto; min-height:0; overflow:auto; padding:6px 8px 10px; }
.dsh-ssh-conn-group { display:flex; align-items:center; gap:6px; margin:8px 2px 4px; }
.dsh-ssh-conn-group-name { font-size:11px; letter-spacing:.04em; text-transform:uppercase; color:var(--dsw-alias-label-secondary); }
.dsh-ssh-conn-group-count { font-size:11px; color:var(--dsw-alias-label-secondary); }
.dsh-ssh-conn-row { display:flex; align-items:flex-start; gap:8px; padding:6px 8px; border:1px solid var(--dsw-alias-border-l1);
  border-radius:8px; background:var(--dsw-alias-bg-layer-1); margin-bottom:4px; }
.dsh-ssh-conn-row:hover { border-color:var(--dsw-alias-border-l2); }
.dsh-ssh-conn-row[data-active="true"] { border-color:var(--dsw-alias-brand-primary); }
.dsh-ssh-conn-main { flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:2px; }
.dsh-ssh-conn-name { font-weight:600; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsh-ssh-conn-target { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:11px;
  color:var(--dsw-alias-label-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsh-ssh-conn-badges { display:flex; flex-wrap:wrap; gap:4px; margin-top:2px; }
.dsh-ssh-conn-actions { display:flex; flex-wrap:wrap; gap:4px; justify-content:flex-end; }
.dsh-ssh-conn-form { display:flex; flex-direction:column; gap:8px; }
.dsh-ssh-conn-grid { display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:8px; }
.dsh-ssh-conn-grid > [data-span="2"] { grid-column:1 / -1; }
.dsh-ssh-conn-secret { display:flex; align-items:center; gap:6px; }
.dsh-ssh-conn-secret > :first-child { flex:1 1 auto; min-width:0; }
.dsh-ssh-conn-notice { display:flex; align-items:flex-start; gap:6px; border:1px solid var(--dsw-alias-border-l1);
  border-radius:8px; padding:6px 8px; background:var(--dsw-alias-bg-layer-1); font-size:11px; }
.dsh-ssh-conn-notice[data-tone="ok"] { border-color:var(--dsw-alias-state-success-primary); }
.dsh-ssh-conn-notice[data-tone="warn"] { border-color:var(--dsw-alias-state-warn-primary); }
.dsh-ssh-conn-notice[data-tone="error"] { border-color:var(--dsw-alias-state-error-primary); }
.dsh-ssh-conn-empty { display:flex; flex-direction:column; align-items:center; gap:6px; padding:24px 12px; text-align:center; }
.dsh-ssh-conn-footer { display:flex; align-items:center; gap:6px; padding:8px; border-top:1px solid var(--dsw-alias-border-l1); }
.dsh-ssh-conn-kicker { font-size:11px; color:var(--dsw-alias-label-secondary); }
`

  let disposeCss = null
  /** Install the connection stylesheet once per client run. */
  function ensureStyles() {
    // The primitives this module re-exports are styled by the session sheet.
    try {
      SSH.require('ssh.session.styles').ensureStyles()
    } catch {
      /* the session workspace is optional for a connection-only surface */
    }
    if (disposeCss) return
    disposeCss = SSH.style.insert(CSS)
  }

  // ── Pure helpers ─────────────────────────────────────────────────────────

  /** Case-insensitive, trimmed; `null` when there is nothing to match. */
  function normalizeQuery(query) {
    const text = typeof query === 'string' ? query.trim().toLowerCase() : ''
    return text === '' ? null : text
  }

  /** Does a profile match the search box? Host, user, name, group and tags count. */
  function matchesQuery(profile, query) {
    const needle = normalizeQuery(query)
    if (!needle) return true
    if (!profile) return false
    const haystack = [
      profile.name,
      profile.host,
      profile.user,
      profile.group,
      Array.isArray(profile.tags) ? profile.tags.join(' ') : profile.tags,
      typeof profile.port === 'number' ? String(profile.port) : '',
    ]
      .filter((value) => value !== undefined && value !== null)
      .join(' ')
      .toLowerCase()
    return haystack.includes(needle)
  }

  /**
   * Group profiles for display.
   *
   * Named groups come first, alphabetically; profiles without a group follow under
   * an empty label so the caller can render them without a header. Order inside a
   * group is the host's (it is already the user's order of creation).
   */
  function groupProfiles(profiles, query) {
    const buckets = new Map()
    for (const profile of profiles || []) {
      if (!matchesQuery(profile, query)) continue
      const key = typeof profile.group === 'string' ? profile.group.trim() : ''
      if (!buckets.has(key)) buckets.set(key, [])
      buckets.get(key).push(profile)
    }
    const named = [...buckets.keys()].filter((key) => key !== '').sort((a, b) => a.localeCompare(b))
    const order = buckets.has('') ? [...named, ''] : named
    return order.map((key) => ({ group: key, items: buckets.get(key) }))
  }

  /**
   * How a credential should be described: present (stored), from the environment, or
   * absent. `masked` is the host's fixed-width mask — never a length, never plaintext.
   */
  function secretSummary(profile, field) {
    const secrets = profile && profile.secrets ? profile.secrets : null
    const entry = secrets && secrets[field] ? secrets[field] : null
    const source = entry && typeof entry.source === 'string' ? entry.source : 'none'
    const present = Boolean(entry && entry.present)
    const labelKey = source === 'env' ? 'conn.secret.fromEnv' : present ? 'conn.secret.present' : 'conn.secret.absent'
    return {
      present,
      source,
      masked: entry && typeof entry.masked === 'string' ? entry.masked : '',
      labelKey,
    }
  }

  /** `conn.state.*` for a session state; unknown values read as "not connected". */
  function stateLabelKey(state) {
    const known = ['idle', 'connecting', 'authenticating', 'connected', 'closing', 'closed', 'error']
    return `conn.state.${known.includes(state) ? state : 'idle'}`
  }

  /**
   * A displayable message for a structured error.
   *
   * The dictionary is preferred so the user reads `err.SSH_AUTH_FAILED`'s sentence
   * rather than a host-side string; the raw message is the fallback for a code the
   * dictionaries do not carry (which is visible instead of silent).
   *
   * A *known* code keeps its sentence **and gains the host's message** when that message
   * carries information the sentence does not: `err.SSH_CFG_INVALID` alone reads
   * "参数校验失败", which names neither the field nor the rule, while the host's message
   * does ("profileId or an inline profile is required"). Dropping it is what made this
   * class of bug undiagnosable from the UI.
   */
  function errorText(error) {
    if (!error) return ''
    const raw = typeof error.message === 'string' ? error.message.trim() : ''
    const code = typeof error.code === 'string' ? error.code : null
    let text = ''
    if (code) {
      const key = `err.${code}`
      const translated = t(key)
      if (translated && translated !== key) {
        text = raw === '' || translated.includes(raw) ? translated : `${translated}：${raw}`
      }
    }
    if (text === '') text = raw !== '' ? raw : String(error)
    return scrubForDisplay(text)
  }

  /**
   * Belt and braces for the acceptance rule "no credential in the UI or the log": the same
   * values the bridge refuses to log are removed from any text we are about to render. A
   * host sentence could echo a submitted value back, and this is the last place before the
   * user reads it. The bridge may not be loaded (the connection panel works without a
   * carrier), so a missing scrubber is not an error — it just means nothing is registered.
   */
  function scrubForDisplay(text) {
    try {
      const bridge = SSH.require('ssh.bridge')
      if (bridge && typeof bridge.redactForLog === 'function') return bridge.redactForLog(text)
    } catch {
      /* no bridge module loaded: the text is already a dictionary sentence */
    }
    return text
  }

  /** `user@host:port` for a profile or a session (they agree on these three fields). */
  function targetOf(entity) {
    if (!entity) return '—'
    const user = entity.user ? `${entity.user}@` : ''
    const port = entity.port ? `:${entity.port}` : ''
    return `${user}${entity.host || '—'}${port}`
  }

  /** The live session for a profile, if the host reports one. */
  function sessionForProfile(sessions, profileId) {
    if (!profileId) return null
    return (sessions || []).find((session) => session.profileId === profileId) || null
  }

  /** Blank draft for the "new connection" form (ICD defaults: port 22, password auth). */
  const EMPTY_DRAFT = Object.freeze({
    name: '',
    host: '',
    port: 22,
    user: '',
    auth: 'password',
    privateKeyPath: '',
    group: '',
    tags: '',
    connectTimeoutMs: 15000,
    keepaliveIntervalMs: 15000,
  })

  /**
   * Build the `ConnProfileInput` a save sends.
   *
   * Only non-secret fields: `password`/`passphrase` never appear in a profile
   * payload (they travel through `setSecret` or a one-shot `connect`). An empty
   * optional field is omitted rather than sent as `''`, because the host merges a
   * patch and an empty string would overwrite a stored value with nothing.
   */
  function toProfileInput(draft, previous) {
    /** A number field that was cleared in the UI (`''`) is not the number 0. */
    const numeric = (value, fallback) => {
      if (value === '' || value === null || value === undefined) return fallback
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : fallback
    }
    const port = numeric(draft.port, NaN)
    const input = {
      name: String(draft.name || '').trim(),
      host: String(draft.host || '').trim(),
      port: Number.isFinite(port) && port > 0 && port <= 65535 ? port : 22,
      user: String(draft.user || '').trim(),
      auth: draft.auth || 'password',
    }
    if (draft.group && String(draft.group).trim() !== '') input.group = String(draft.group).trim()
    if (draft.tags && String(draft.tags).trim() !== '') {
      input.tags = String(draft.tags)
        .split(',')
        .map((tag) => tag.trim())
        .filter((tag) => tag !== '')
    }
    if (draft.privateKeyPath && String(draft.privateKeyPath).trim() !== '') {
      input.privateKeyPath = String(draft.privateKeyPath).trim()
    }
    const timeout = numeric(draft.connectTimeoutMs, undefined)
    if (timeout !== undefined) input.connectTimeoutMs = timeout
    const keepalive = numeric(draft.keepaliveIntervalMs, undefined)
    if (keepalive !== undefined) input.keepaliveIntervalMs = keepalive
    // Identity + references, so an edit updates instead of duplicating and does not
    // silently drop stored credentials (ICD §4.2 merge semantics).
    if (previous && previous.id) input.id = previous.id
    if (previous && previous.secretRefs) input.secretRefs = previous.secretRefs
    return input
  }

  return {
    configure,
    app,
    api,
    chrome,
    t,
    ui,
    ensureStyles,
    CSS,
    // Pure helpers.
    normalizeQuery,
    matchesQuery,
    groupProfiles,
    secretSummary,
    stateLabelKey,
    errorText,
    targetOf,
    sessionForProfile,
    EMPTY_DRAFT,
    toProfileInput,
  }
})
