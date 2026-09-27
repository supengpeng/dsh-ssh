/**
 * @module ssh.chrome.theme
 * @order 62
 *
 * Theme plumbing for the chrome (ICD §8.6).
 *
 * The stylesheet itself is generated into `ssh.chrome.theme.css` from
 * `client/src/theme.css`. This module installs it exactly once per client run and
 * owns the two things the ICD leaves to the UI half:
 *
 *   - the neutral-shadow / token-only rule, exposed as `findHardcodedColours` so the
 *     tests can assert it over the real CSS instead of a copy of the regex;
 *   - the terminal font size, persisted under `dsh-ssh.termFontSize` and stepped by
 *     the `Ctrl/Cmd+=`, `-` and `0` shortcuts.
 */

SSH.define('ssh.chrome.theme', function (SSH) {
  const { useSyncExternalStore } = SSH.react
  const h = SSH.h
  const sheet = SSH.require('ssh.chrome.theme.css')

  /** ICD §8.6 persistence keys. */
  const TERM_FONT_SIZE_KEY = 'dsh-ssh.termFontSize'
  const DEFAULT_TERM_FONT_SIZE = 13
  const MIN_TERM_FONT_SIZE = 8
  const MAX_TERM_FONT_SIZE = 32
  /** Fixed by the ICD: the terminal keeps a monospace stack of its own. */
  const TERM_FONT_STACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

  /** DSH tokens the chrome may colour with (ICD §8.6). */
  const TOKENS = Object.freeze([
    '--dsw-alias-bg-base',
    '--dsw-alias-bg-layer-1',
    '--dsw-alias-bg-layer-2',
    '--dsw-alias-bg-overlay',
    '--dsw-alias-border-l1',
    '--dsw-alias-border-l2',
    '--dsw-alias-brand-primary',
    '--dsw-alias-label-primary',
    '--dsw-alias-label-secondary',
    '--dsw-alias-state-error-primary',
    '--dsw-alias-state-idle-primary',
    '--dsw-alias-state-success-primary',
    '--dsw-alias-state-warn-primary',
    '--dsw-alias-specific-sidebar-fill',
  ])

  /**
   * Every literal colour in a stylesheet.
   *
   * There is no exception for neutral black/white alpha (ICD v1.0.8): a black shadow is
   * nearly invisible on a dark background, so elevation has to be derived from a token
   * with `color-mix(in srgb, var(--dsw-alias-label-primary) N%, transparent)`.
   */
  function findHardcodedColours(css) {
    return String(css ?? '').match(/#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+[^)]*\)/g) ?? []
  }

  /** Token references used by a stylesheet, so an unknown token is visible in tests. */
  function referencedTokens(css) {
    const found = new Set()
    for (const match of String(css ?? '').matchAll(/var\(\s*(--dsw-[a-z0-9-]+)/g)) found.add(match[1])
    return [...found].sort()
  }

  let disposeSheet = null

  /** Insert the stylesheet once per client run; safe to call from every mount. */
  function ensureTheme() {
    if (disposeSheet) return disposeSheet
    if (typeof document === 'undefined' || !document.head) return null
    disposeSheet = SSH.style.insert(sheet.CSS)
    return disposeSheet
  }

  function readStored(key) {
    try {
      return window.localStorage.getItem(key)
    } catch {
      return null
    }
  }

  function writeStored(key, value) {
    try {
      window.localStorage.setItem(key, String(value))
    } catch {
      /* storage may be unavailable; the in-memory value still applies */
    }
  }

  /** Clamp a user-supplied font size; anything unparsable falls back to `fallback`. */
  function clampTermFontSize(size, fallback = DEFAULT_TERM_FONT_SIZE) {
    const numeric = typeof size === 'number' ? size : Number.parseFloat(String(size ?? ''))
    if (!Number.isFinite(numeric)) return fallback
    return Math.min(MAX_TERM_FONT_SIZE, Math.max(MIN_TERM_FONT_SIZE, Math.round(numeric)))
  }

  function readTermFontSize(fallback = DEFAULT_TERM_FONT_SIZE) {
    const raw = readStored(TERM_FONT_SIZE_KEY)
    return raw === null ? clampTermFontSize(fallback) : clampTermFontSize(raw, clampTermFontSize(fallback))
  }

  function writeTermFontSize(size) {
    const next = clampTermFontSize(size)
    writeStored(TERM_FONT_SIZE_KEY, next)
    return next
  }

  /** Set the CSS variable a terminal subtree reads; returns the clamped size. */
  function applyTermFontSize(node, size) {
    const next = clampTermFontSize(size)
    if (node && node.style && typeof node.style.setProperty === 'function') {
      node.style.setProperty('--dsh-ssh-term-size', `${next}px`)
    }
    return next
  }

  /**
   * A tiny observable font size, shared by the terminal tab and the shortcuts.
   *
   * `subscribe`/`getSize` are shaped for `useSyncExternalStore`.
   */
  function createFontController(initial) {
    let size = readTermFontSize(initial)
    const listeners = new Set()
    const notify = () => {
      for (const listener of [...listeners]) listener()
    }
    return {
      getSize: () => size,
      setSize(next) {
        const clamped = clampTermFontSize(next)
        if (clamped === size) return size
        size = writeTermFontSize(clamped)
        notify()
        return size
      },
      step(delta) {
        return this.setSize(size + delta)
      },
      reset() {
        return this.setSize(DEFAULT_TERM_FONT_SIZE)
      },
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
  }

  /** Subscribe a component to the shared font controller. */
  function useFontSize(controller) {
    return useSyncExternalStore(
      (listener) => controller.subscribe(listener),
      () => controller.getSize(),
      () => controller.getSize(),
    )
  }

  // ── the discoverable light/dark switch ─────────────────────────────────────
  //
  // The panel follows the shell theme already; what was missing is an entry point a
  // user can find. The button reads the shell's `theme` service (documented at
  // `@deepseek-ai/dsh-cordis-client-runner/lib/client.js:1399-1416`):
  //
  //   getTheme(): ThemeSnapshot   // { preference, fontSize, active, themes[], revision }
  //   setTheme(id): void          // a registered id or 'system'; unknown ids throw
  //
  // `themes` is the registry list (`@deepseek-ai/dsh-client-ui-theme/lib/client.js:1487-1499`
  // `buildSnapshot()`), so rotation follows the registry instead of a hardcoded pair —
  // a third-party theme joins the cycle by registering. `theme/change` is the documented
  // continuous-sync channel, which is how the button also follows the Settings page.

  /** Where the shell services are read from; set once by `install()`. */
  let serviceCtx = null
  /** The service once found; a composition's service does not appear twice. */
  let cachedService = null
  /**
   * `null` while still looking, then `'ready'` / `'incomplete'` / `'absent'`.
   *
   * A client service mounting *after* a plugin's `apply()` is normal on this platform
   * (the same race hit `sidebarRightTabs` and the locale service). A one-shot lookup made
   * the theme switch report `absent` on a composition that **does** provide `theme`, which
   * is how the button went missing. `absent` now means "we really waited".
   */
  let availability = null
  const availabilityWaiters = new Set()
  /** Timers: one for the explicit waiter, one for components that mounted too early. */
  let waitTimer = null
  let appearTimer = null
  let appearDeadline = 0

  function configureThemeService(ctx) {
    serviceCtx = ctx && typeof ctx.get === 'function' ? ctx : null
    cachedService = null
    availability = null
  }

  /** Tell subscribers (and any waiting component) that availability changed. */
  function notifyAvailability() {
    for (const waiter of [...availabilityWaiters]) {
      try {
        waiter()
      } catch {
        /* a listener that throws must not stop the others */
      }
    }
  }

  /** Look the service up, caching the first hit. */
  function themeService() {
    if (cachedService !== null) return cachedService
    if (serviceCtx === null) return null
    let found = null
    try {
      found = serviceCtx.get('theme') ?? null
    } catch {
      found = null
    }
    if (found !== null) {
      cachedService = found
      availability = typeof found.setTheme === 'function' ? 'ready' : 'incomplete'
      notifyAvailability()
    }
    return found
  }

  /**
   * Wait for the theme service to mount.
   *
   * Tries immediately first, then polls — so a composition that already has the service
   * is ready within the same tick, and a late one is picked up without a page reload.
   *
   * @param options optional `{timeoutMs, intervalMs}` (tests inject these instead of waiting).
   * @returns `{service, availability}`; `availability === 'absent'` only after the window.
   */
  function waitForThemeService(options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs) : 15000
    const intervalMs = Number.isFinite(options.intervalMs) ? Math.max(1, options.intervalMs) : 250
    const found = themeService()
    if (found !== null) return Promise.resolve({ service: found, availability })
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs
      let settled = false
      const finish = (result) => {
        if (settled) return
        settled = true
        if (waitTimer !== null) {
          clearTimeout(waitTimer)
          waitTimer = null
        }
        resolve(result)
      }
      const tick = () => {
        const service = themeService()
        if (service !== null) {
          finish({ service, availability })
          return
        }
        if (Date.now() >= deadline) {
          availability = 'absent'
          finish({ service: null, availability: 'absent' })
          return
        }
        waitTimer = setTimeout(tick, intervalMs)
        if (waitTimer && typeof waitTimer.unref === 'function') waitTimer.unref()
      }
      waitTimer = setTimeout(tick, intervalMs)
      if (waitTimer && typeof waitTimer.unref === 'function') waitTimer.unref()
    })
  }

  /** A snapshot with no service behind it: stable reference, so React can compare. */
  const NO_THEME = Object.freeze({ preference: null, themes: Object.freeze([]), active: null, unavailable: true })

  /**
   * The last snapshot handed to React.
   *
   * `useSyncExternalStore` requires a referentially stable value between changes, and the
   * real service does return one (`buildSnapshot()` caches `this.snapshot` until a change).
   * A service that builds a fresh object per call / a mock would otherwise spin React to
   * its update-depth limit, so identity is pinned on `revision` — the field the snapshot
   * carries for exactly this comparison — plus the preference and the registry length.
   */
  let lastSnapshot = null

  function readThemeSnapshot() {
    const service = themeService()
    if (service === null || typeof service.getTheme !== 'function') return NO_THEME
    let next
    try {
      next = service.getTheme()
    } catch {
      return NO_THEME
    }
    if (!next || typeof next !== 'object') return NO_THEME
    if (
      lastSnapshot !== null &&
      lastSnapshot.revision === next.revision &&
      lastSnapshot.preference === next.preference &&
      (Array.isArray(lastSnapshot.themes) ? lastSnapshot.themes.length : 0) === (Array.isArray(next.themes) ? next.themes.length : 0)
    ) {
      return lastSnapshot
    }
    lastSnapshot = next
    return next
  }

  function subscribeTheme(listener) {
    // Not available *yet*: keep listening for the service instead of giving up. A
    // component can easily mount before the shell finished mounting its services, and
    // hiding the switch forever is exactly the bug this guards.
    if (themeService() === null) {
      availabilityWaiters.add(listener)
      if (appearTimer === null) {
        if (appearDeadline === 0) appearDeadline = Date.now() + 15000
        const tick = () => {
          appearTimer = null
          if (themeService() !== null) {
            appearDeadline = 0
            return
          }
          if (Date.now() >= appearDeadline) {
            availability = 'absent'
            appearDeadline = 0
            notifyAvailability()
            return
          }
          appearTimer = setTimeout(tick, 250)
          if (appearTimer && typeof appearTimer.unref === 'function') appearTimer.unref()
        }
        appearTimer = setTimeout(tick, 250)
        if (appearTimer && typeof appearTimer.unref === 'function') appearTimer.unref()
      }
      return () => availabilityWaiters.delete(listener)
    }
    if (serviceCtx === null || typeof serviceCtx.on !== 'function') return () => {}
    try {
      const dispose = serviceCtx.on('theme/change', () => listener())
      return typeof dispose === 'function' ? dispose : () => {}
    } catch {
      return () => {}
    }
  }

  function useThemeSnapshot() {
    return useSyncExternalStore(subscribeTheme, readThemeSnapshot, readThemeSnapshot)
  }

  /** The theme actually in force (a `system` preference resolves through `active`). */
  function resolvedThemeId(snapshot) {
    if (!snapshot) return null
    if (typeof snapshot.preference === 'string' && snapshot.preference !== 'system') return snapshot.preference
    return snapshot.active && typeof snapshot.active.id === 'string' ? snapshot.active.id : null
  }

  /**
   * The id one click moves to: the next entry of the registry list, wrapping. Falls back
   * to light↔dark only when the snapshot carries no usable list.
   */
  function nextThemeId(snapshot) {
    const ids = snapshot && Array.isArray(snapshot.themes)
      ? snapshot.themes.map((theme) => theme && theme.id).filter((id) => typeof id === 'string' && id !== '')
      : []
    const current = resolvedThemeId(snapshot)
    if (ids.length === 0) return current === 'dark' ? 'light' : 'dark'
    const index = current === null ? -1 : ids.indexOf(current)
    return ids[(index + 1) % ids.length]
  }

  /** Dictionary key for a built-in id; a registered third-party id shows as itself. */
  function themeLabelKey(id) {
    if (id === 'light') return 'chrome.theme.light'
    if (id === 'dark') return 'chrome.theme.dark'
    if (id === 'system') return 'chrome.theme.system'
    return null
  }

  /**
   * Switch the shell theme; never throws into the click handler.
   * @returns the id that was requested, or null when no service is present.
   */
  function applyTheme(id) {
    const service = themeService()
    if (service === null || typeof service.setTheme !== 'function' || typeof id !== 'string' || id === '') return null
    try {
      service.setTheme(id)
      return id
    } catch (error) {
      console.warn('[dsh-ssh] theme switch was refused', id, error)
      return null
    }
  }

  /**
   * The theme switch.
   *
   * Rendered next to the session toolbar's other chrome controls, *outside* the wrapper
   * that the narrow container query hides (`.dsh-ssh-session-help`), because the sidebar
   * at its narrowest is the width the user actually works at.
   */
  function ThemeToggle(props) {
    const options = props || {}
    const snapshot = useThemeSnapshot()
    const i18n = SSH.require('ssh.i18n')
    const t = (key, params) => i18n.t(key, params)

    if (snapshot.unavailable === true) {
      // Still looking, or genuinely absent. Either way this render shows nothing — but the
      // subscription armed in `subscribeTheme()` re-renders the moment the service appears,
      // so "not there yet" never becomes "gone for good".
      if (availability === 'absent' && typeof options.onUnavailable === 'function') {
        options.onUnavailable('theme service did not appear within 15s')
      }
      return null
    }

    const preference = typeof snapshot.preference === 'string' ? snapshot.preference : resolvedThemeId(snapshot)
    const resolved = resolvedThemeId(snapshot)
    const labelKey = themeLabelKey(preference)
    const label = labelKey === null ? String(preference ?? '') : t(labelKey)
    const next = nextThemeId(snapshot)
    const nextLabelKey = themeLabelKey(next)
    const nextLabel = nextLabelKey === null ? String(next) : t(nextLabelKey)
    const dark = resolved === 'dark'
    const title = `${t('chrome.theme.toggle')}：${label} → ${nextLabel}`

    return h(
      'button',
      {
        type: 'button',
        className: 'dsh-ssh-theme-toggle',
        'data-testid': options.testId || 'ssh-theme-toggle',
        'data-theme': preference === null ? '' : String(preference),
        'data-resolved': resolved === null ? '' : String(resolved),
        // The pressed state mirrors the *resolved* appearance, which is what the user sees.
        'aria-pressed': dark,
        'aria-label': title,
        title,
        onClick: () => applyTheme(next),
      },
      h('span', { className: 'dsh-ssh-theme-toggle-icon', 'aria-hidden': 'true' }, dark ? '☾' : '☀'),
      h('span', { className: 'dsh-ssh-theme-toggle-label' }, label),
    )
  }

  return {
    TERM_FONT_SIZE_KEY,
    DEFAULT_TERM_FONT_SIZE,
    MIN_TERM_FONT_SIZE,
    MAX_TERM_FONT_SIZE,
    TERM_FONT_STACK,
    TOKENS,
    CSS: sheet.CSS,
    PREFIX: sheet.PREFIX,
    ensureTheme,
    findHardcodedColours,
    referencedTokens,
    clampTermFontSize,
    readTermFontSize,
    writeTermFontSize,
    applyTermFontSize,
    createFontController,
    useFontSize,
    ThemeToggle,
    configureThemeService,
    themeService,
    waitForThemeService,
    themeAvailability: () => availability,
    resolvedThemeId,
    nextThemeId,
    themeLabelKey,
    applyTheme,
    NO_THEME,
  }
})
