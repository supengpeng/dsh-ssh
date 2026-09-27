/**
 * @module ssh.chrome
 * @order 74
 *
 * The chrome's single entry point: everything SP5/SP6 needs, plus the one call that
 * turns the chrome on (ICD §8.3 component props, §8.4 shortcuts, §8.6 theme).
 *
 * `install(ctx, targets)` does exactly four things, each independently reversible and
 * each wrapped so one missing seat cannot take the rest of the client half down:
 *
 *   1. registers the full `ssh` dictionaries (`ssh.i18n`),
 *   2. inserts the stylesheet (`ssh.chrome.theme`),
 *   3. registers the §8.4 commands with the shell's shortcut service (`ssh.chrome.shortcuts`),
 *      and installs the scoped local listener for the bare keys and refused commands,
 *   4. registers the toast stack and the confirmation host on `shell.overlay` — the
 *      click-through layer that M0-SPIKE §4 C4 warns about — plus `ShortcutHelp` as a
 *      component any host can mount.
 *
 * The components are re-exported here so a caller never has to know which file a
 * component lives in, and `danger` is re-exported because the dangerous-operation
 * policy is a security acceptance item rather than an implementation detail.
 */

SSH.define('ssh.chrome', function (SSH) {
  /**
   * Proof-of-load marker for the chrome half, following the plugin body's
   * `ssh-client-…` convention. Printed on `install()` together with the theme service
   * state, because "can the theme switch actually operate?" is the question a
   * user-reported "no theme button" turns on.
   */
  const BUILD_MARKER = 'ssh-chrome-2026-09-27.2-theme-late-mount'
  const i18n = SSH.require('ssh.i18n')
  const theme = SSH.require('ssh.chrome.theme')
  const toast = SSH.require('ssh.chrome.toast')
  const confirm = SSH.require('ssh.chrome.confirm')
  const tabs = SSH.require('ssh.chrome.tabs')
  const statusbar = SSH.require('ssh.chrome.statusbar')
  const shortcuts = SSH.require('ssh.chrome.shortcuts')

  // Publish the registry-level translator slot as early as possible.
  //
  // `session/ui.js` checks `SSH.i18n` before it falls back to the module registry, and
  // the connection UI reaches translations through `ssh.chrome.i18n.t`. The plugin body
  // requires this module during `apply()`, i.e. before any component renders, so
  // assigning here means both conventions answer on the very first render — the miss
  // that produced `panel.title` / `conn.new` in the live panel.
  try {
    SSH.i18n = i18n.t
  } catch {
    /* a frozen registry is not worth failing the module over */
  }

  /** Every component this module owns, for `ssh.plugin.components()` and the tests. */
  function components() {
    return {
      TabStrip: tabs.TabStrip,
      StatusBar: statusbar.StatusBar,
      ShortcutHelp: shortcuts.ShortcutHelp,
      ConfirmDialog: confirm.ConfirmDialog,
      ConfirmHost: confirm.ConfirmHost,
      ToastStack: toast.ToastStack,
      ToastItem: toast.ToastItem,
      ToastHost: toast.ToastHost,
      // The discoverable light/dark switch: the panel already followed the shell theme,
      // but a user had no control to operate (and therefore no way to verify it).
      ThemeToggle: theme.ThemeToggle,
    }
  }

  /**
   * Turn the chrome on.
   *
   * `targets` is the §8.4 action table (`focusPanel`, `newConnection`, `closeTab`,
   * `nextTab`, `prevTab`, `jumpTab`, `clearTerminal`, `fontUp`, `fontDown`,
   * `fontReset`, `historyPrev`, `historyNext`, `escape`). Anything left out simply
   * makes that command a no-op instead of an error.
   */
  function install(ctx, targets = {}, options = {}) {
    const report = typeof options.report === 'function' ? options.report : () => {}
    const result = {
      locale: null,
      theme: null,
      shortcuts: null,
      localKeys: null,
      overlays: [],
      errors: [],
    }

    try {
      result.locale = i18n.registerLocale(ctx)
      if (!result.locale.ok) report('chrome locale', new Error(result.locale.reason))
    } catch (error) {
      result.errors.push({ what: 'locale', message: String(error && error.message) })
      report('chrome locale', error)
    }

    // Observable proof that the dictionary answers, not just that registration returned
    // `ok`. Without this line a broken lookup chain is invisible in the console while
    // every string in the panel silently renders as its key name (`panel.title`).
    try {
      const check = i18n.selfCheck('conn.new')
      const translation = i18n.selfCheck('panel.title')
      result.localeCheck = { check, translation }
      const line = {
        namespace: i18n.NS,
        locale: check.locale,
        keys: check.keys,
        registered: result.locale ? result.locale.ok : false,
        reason: result.locale && result.locale.ok === false ? result.locale.reason : undefined,
        't("conn.new")': check.value,
        't("panel.title")': translation.value,
      }
      if (check.translated && translation.translated) console.info('[dsh-ssh] locale ok', line)
      else {
        // Loud on purpose: this is the failure that made the whole panel unreadable.
        console.error('[dsh-ssh] locale NOT translating — strings will render as key names', line)
        result.errors.push({ what: 'locale lookup', message: `t("${check.key}") returned "${check.value}"` })
      }
    } catch (error) {
      result.errors.push({ what: 'locale self check', message: String(error && error.message) })
      report('chrome locale self check', error)
    }

    try {
      result.theme = theme.ensureTheme()
      // The theme switch reads the shell service through this ctx. A client service can
      // mount *after* apply() (the same race that hit `sidebarRightTabs` and locale), so a
      // one-shot lookup is not evidence of absence: try now, then keep looking, and report
      // `absent` only once the window really elapsed.
      theme.configureThemeService(ctx)
      const immediate = theme.themeService()
      result.themeService = immediate === null ? 'pending' : typeof immediate.setTheme === 'function' ? 'ready' : 'incomplete'
      console.info(`[dsh-ssh] ${BUILD_MARKER} theme-service=${result.themeService}`)
      if (immediate === null) {
        const timeoutMs = Number.isFinite(options.themeTimeoutMs) ? options.themeTimeoutMs : undefined
        const intervalMs = Number.isFinite(options.themeIntervalMs) ? options.themeIntervalMs : undefined
        void theme.waitForThemeService({ timeoutMs, intervalMs }).then((resolved) => {
          result.themeService = resolved.availability
          if (resolved.availability === 'ready') {
            console.info(`[dsh-ssh] ${BUILD_MARKER} theme-service=ready (late mount, switch enabled)`)
          } else if (resolved.availability === 'incomplete') {
            console.warn(`[dsh-ssh] ${BUILD_MARKER} theme-service=incomplete — the theme service has no setTheme(), so the switch shows state only`)
          } else {
            console.warn(
              `[dsh-ssh] ${BUILD_MARKER} theme-service=absent — waited ${timeoutMs ?? 15000}ms for ctx.get('theme') and it never appeared; ` +
                'the theme switch stays hidden. Every other panel feature is unaffected.',
            )
          }
        })
      }
    } catch (error) {
      result.errors.push({ what: 'theme', message: String(error && error.message) })
      report('chrome theme', error)
    }

    try {
      result.shortcuts = shortcuts.registerShortcuts(ctx, targets, options)
    } catch (error) {
      result.errors.push({ what: 'shortcuts', message: String(error && error.message) })
      report('chrome shortcuts', error)
    }

    // The scoped listener covers the bare keys and any command the shell refused.
    try {
      const conflictIds = result.shortcuts ? result.shortcuts.conflicts : []
      const handler = shortcuts.createLocalKeyHandler(targets, {
        conflictIds,
        isOwned: options.isOwned,
        runtime: result.shortcuts && result.shortcuts.environment ? result.shortcuts.environment.runtime : undefined,
        platform: result.shortcuts && result.shortcuts.environment ? result.shortcuts.environment.platform : undefined,
      })
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('keydown', handler)
        const dispose = () => document.removeEventListener('keydown', handler)
        if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'dsh-ssh: local shortcut keys')
        result.localKeys = { handler, dispose }
      }
    } catch (error) {
      result.errors.push({ what: 'local keys', message: String(error && error.message) })
      report('chrome local keys', error)
    }

    const slots = safeGet(ctx, 'slots')
    if (slots && typeof slots.inject === 'function' && typeof slots.register === 'function') {
      const seats = [
        { what: 'toasts', declaration: toast.SLOT, component: toast.ToastHost },
        { what: 'confirm', declaration: confirm.SLOT, component: confirm.ConfirmHost },
      ]
      for (const seat of seats) {
        try {
          const dispose = slots.inject('shell.overlay', () =>
            slots.register(
              { name: 'shell.overlay', id: seat.declaration.id, order: seat.declaration.order, label: seat.what },
              seat.component,
            ),
          )
          if (typeof ctx.effect === 'function') ctx.effect(() => dispose, `dsh-ssh: chrome ${seat.what}`)
          result.overlays.push(seat.declaration.id)
        } catch (error) {
          result.errors.push({ what: seat.what, message: String(error && error.message) })
          report(`chrome ${seat.what}`, error)
        }
      }
    }

    return result
  }

  function safeGet(ctx, name) {
    try {
      return ctx && typeof ctx.get === 'function' ? ctx.get(name) ?? undefined : undefined
    } catch {
      return undefined
    }
  }

  return {
    install,
    components,
    i18n,
    theme,
    toast,
    confirm,
    tabs,
    statusbar,
    shortcuts,
    // Direct re-exports for the common call sites.
    TabStrip: tabs.TabStrip,
    StatusBar: statusbar.StatusBar,
    ShortcutHelp: shortcuts.ShortcutHelp,
    ConfirmDialog: confirm.ConfirmDialog,
    ConfirmHost: confirm.ConfirmHost,
    ToastStack: toast.ToastStack,
    ToastHost: toast.ToastHost,
    /** The discoverable light/dark switch (see `chrome/README.md` §4.3). */
    ThemeToggle: theme.ThemeToggle,
    /** `danger(kind, details)` → Promise<boolean>; the three security-relevant flows. */
    danger: confirm.danger,
    describeShortcuts: shortcuts.describeShortcuts,
    /** Proof-of-load string, also printed by `install()`. */
    BUILD_MARKER,
  }
})
