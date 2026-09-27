/**
 * @module ssh.chrome.shortcuts
 * @order 72
 *
 * Keyboard shortcuts (ICD §8.4) and the shortcut reference (ICD §8.3 `ShortcutHelp`).
 *
 * **How they are registered, and why.** The shell owns a real shortcut service
 * (`ctx.shortcuts`, `@deepseek-ai/dsh-client-shortcuts`), so the commands in §8.4 are
 * registered through it rather than stolen with a document-level key listener: that is
 * what makes them appear in the user's Settings -> Shortcuts list, survive rebinding and
 * respect the shell's modal/region policy. Two facts about that service shaped the
 * table below, both read out of the shipped bundle rather than guessed:
 *
 *   1. `register()` **throws** on a duplicate id, a default that overlaps another
 *      command, or a Web combination the service does not admit (`web:linux` only
 *      accepts the three fixed combinations, and a Web binding may not be a bare
 *      `primary`+letter). So every row declares a Web default with two modifiers and
 *      `web:linux` is left unbound, and registration is per-command try/catch so one
 *      rejection can never take out the rest.
 *   2. `resolve({ target, region })` is where ownership is decided. Returning
 *      `{ status: 'blocked' }` **consumes** the key, so a command that only applies to
 *      our own pane returns `{ status: 'pass' }` when the focus is elsewhere, and the
 *      shell's terminals keep their own `Ctrl+L`, `Ctrl+W` and `Ctrl+R`.
 *
 * One row of §8.4 cannot be honoured as written: `Ctrl/Cmd+T` is already
 * `browser.new` on `desktop:*` in the shipped build. The desktop default is therefore
 * `Ctrl/Cmd+Shift+T` (Web keeps the letter, where `browser.new` uses `Mod+Alt+T`), the
 * substitution is reported by `describe()` and rendered in the shortcut reference,
 * and reported to the Lead rather than silently diverging from the ICD.
 *
 * `↑`, `↓` and `Esc` are *local* input: they are bare keys (Web refuses them) and only
 * mean anything while our own panel has focus, so they are handled by the scoped local
 * listener below. The same listener is the fallback for any command the shell rejects.
 */

SSH.define('ssh.chrome.shortcuts', function (SSH) {
  const { useMemo } = SSH.react
  const h = SSH.h

  /** Marker attributes/classes that mean "this event belongs to the SSH pane". */
  const OWN_SELECTOR = '[data-dsh-ssh-root],[class*="dsh-ssh-"]'
  /** The confirmation dialog handles its own Esc; the local handler must not double-fire. */
  const DIALOG_SELECTOR = '.dsh-ssh-confirm,.dsh-ssh-shortcuts-backdrop'

  const EDITABLE = 'input, textarea, select, [contenteditable="true"], [contenteditable=""]'

  /** A physical key plus modifiers, in the shell's own vocabulary. */
  function desktop(code, modifiers) {
    return { code, modifiers }
  }

  /** Web defaults need two modifiers; `web:linux` accepts none of these, so it stays unbound. */
  function web(code, modifiers) {
    return { code, modifiers }
  }

  /**
   * The §8.4 table, as data.
   *
   * `action` names a callback on the targets object; `local: true` means the row is
   * handled by the scoped listener instead of the shell service.
   */
  const SHORTCUTS = Object.freeze([
    {
      id: 'ssh.panel.focus',
      group: 'navigation',
      labelKey: 'chrome.cmd.panelFocus',
      aliases: ['ssh', 'ssh panel', 'open ssh'],
      action: 'focusPanel',
      regions: ['page', 'editable'],
      onBareKeys: false,
      defaults: {
        'desktop:macos': desktop('KeyS', ['primary', 'shift']),
        'desktop:windows': desktop('KeyS', ['primary', 'shift']),
        'desktop:linux': desktop('KeyS', ['primary', 'shift']),
        'web:macos': web('KeyS', ['primary', 'alt']),
        'web:windows': web('KeyS', ['primary', 'alt']),
      },
      fallbackDefaults: {
        'desktop:macos': desktop('KeyS', ['primary', 'shift', 'alt']),
        'desktop:windows': desktop('KeyS', ['primary', 'shift', 'alt']),
        'desktop:linux': desktop('KeyS', ['primary', 'shift', 'alt']),
        'web:macos': web('KeyS', ['primary', 'shift', 'alt']),
        'web:windows': web('KeyS', ['primary', 'shift', 'alt']),
      },
    },
    {
      id: 'ssh.conn.new',
      group: 'navigation',
      labelKey: 'chrome.cmd.connNew',
      aliases: ['new ssh connection', 'new host'],
      action: 'newConnection',
      regions: ['page', 'editable'],
      onBareKeys: false,
      // ICD §8.4 says Ctrl/Cmd+T; `browser.new` already owns that on desktop:*.
      defaults: {
        'desktop:macos': desktop('KeyT', ['primary', 'shift']),
        'desktop:windows': desktop('KeyT', ['primary', 'shift']),
        'desktop:linux': desktop('KeyT', ['primary', 'shift']),
        'web:macos': web('KeyT', ['primary', 'shift']),
        'web:windows': web('KeyT', ['primary', 'shift']),
      },
      fallbackDefaults: {
        'desktop:macos': desktop('KeyT', ['primary', 'shift', 'alt']),
        'desktop:windows': desktop('KeyT', ['primary', 'shift', 'alt']),
        'desktop:linux': desktop('KeyT', ['primary', 'shift', 'alt']),
        'web:macos': web('KeyT', ['primary', 'shift', 'alt']),
        'web:windows': web('KeyT', ['primary', 'shift', 'alt']),
      },
      substituted: 'desktop:*',
      substitutionReason: 'browser.new',
    },
    {
      id: 'ssh.tab.close',
      group: 'session',
      labelKey: 'chrome.cmd.tabClose',
      aliases: ['close ssh session', 'close tab'],
      action: 'closeTab',
      regions: ['page', 'editable'],
      onBareKeys: false,
      defaults: {
        'desktop:macos': desktop('KeyW', ['primary']),
        'desktop:windows': desktop('KeyW', ['primary']),
        'desktop:linux': desktop('KeyW', ['primary']),
        'web:macos': web('KeyW', ['primary', 'alt']),
        'web:windows': web('KeyW', ['primary', 'alt']),
      },
    },
    {
      id: 'ssh.tab.next',
      group: 'session',
      labelKey: 'chrome.cmd.tabNext',
      aliases: ['next ssh tab'],
      action: 'nextTab',
      regions: ['page', 'editable'],
      onBareKeys: false,
      defaults: {
        'desktop:macos': desktop('Tab', ['primary']),
        'desktop:windows': desktop('Tab', ['primary']),
        'desktop:linux': desktop('Tab', ['primary']),
        'web:macos': web('Tab', ['primary', 'alt']),
        'web:windows': web('Tab', ['primary', 'alt']),
      },
    },
    {
      id: 'ssh.tab.prev',
      group: 'session',
      labelKey: 'chrome.cmd.tabPrev',
      aliases: ['previous ssh tab'],
      action: 'prevTab',
      regions: ['page', 'editable'],
      onBareKeys: false,
      defaults: {
        'desktop:macos': desktop('Tab', ['primary', 'shift']),
        'desktop:windows': desktop('Tab', ['primary', 'shift']),
        'desktop:linux': desktop('Tab', ['primary', 'shift']),
        'web:macos': web('Tab', ['primary', 'shift']),
        'web:windows': web('Tab', ['primary', 'shift']),
      },
    },
    {
      id: 'ssh.terminal.clear',
      group: 'terminal',
      labelKey: 'chrome.cmd.termClear',
      aliases: ['clear ssh terminal'],
      action: 'clearTerminal',
      // Terminal region only, and `resolve` narrows it to our own pane: a shipped
      // terminal keeps its local Ctrl+L (M0-SPIKE §4 C5).
      regions: ['terminal'],
      ownPaneOnly: true,
      onBareKeys: false,
      defaults: {
        'desktop:macos': desktop('KeyL', ['primary']),
        'desktop:windows': desktop('KeyL', ['primary']),
        'desktop:linux': desktop('KeyL', ['primary']),
        'web:macos': web('KeyL', ['primary', 'alt']),
        'web:windows': web('KeyL', ['primary', 'alt']),
      },
    },
    {
      id: 'ssh.font.up',
      group: 'terminal',
      labelKey: 'chrome.cmd.fontUp',
      aliases: ['terminal font bigger'],
      action: 'fontUp',
      regions: ['terminal'],
      ownPaneOnly: true,
      onBareKeys: false,
      defaults: {
        'desktop:macos': desktop('Equal', ['primary']),
        'desktop:windows': desktop('Equal', ['primary']),
        'desktop:linux': desktop('Equal', ['primary']),
        'web:macos': web('Equal', ['primary', 'alt']),
        'web:windows': web('Equal', ['primary', 'alt']),
      },
    },
    {
      id: 'ssh.font.down',
      group: 'terminal',
      labelKey: 'chrome.cmd.fontDown',
      aliases: ['terminal font smaller'],
      action: 'fontDown',
      regions: ['terminal'],
      ownPaneOnly: true,
      onBareKeys: false,
      defaults: {
        'desktop:macos': desktop('Minus', ['primary']),
        'desktop:windows': desktop('Minus', ['primary']),
        'desktop:linux': desktop('Minus', ['primary']),
        'web:macos': web('Minus', ['primary', 'alt']),
        'web:windows': web('Minus', ['primary', 'alt']),
      },
    },
    {
      id: 'ssh.font.reset',
      group: 'terminal',
      labelKey: 'chrome.cmd.fontReset',
      aliases: ['terminal font default'],
      action: 'fontReset',
      regions: ['terminal'],
      ownPaneOnly: true,
      onBareKeys: false,
      defaults: {
        'desktop:macos': desktop('Digit0', ['primary']),
        'desktop:windows': desktop('Digit0', ['primary']),
        'desktop:linux': desktop('Digit0', ['primary']),
        'web:macos': web('Digit0', ['primary', 'alt']),
        'web:windows': web('Digit0', ['primary', 'alt']),
      },
    },
    // Bare keys: local input, never a global command.
    {
      id: 'ssh.history.prev',
      group: 'input',
      labelKey: 'chrome.cmd.historyPrev',
      action: 'historyPrev',
      local: true,
      keys: { code: 'ArrowUp', modifiers: [] },
    },
    {
      id: 'ssh.history.next',
      group: 'input',
      labelKey: 'chrome.cmd.historyNext',
      action: 'historyNext',
      local: true,
      keys: { code: 'ArrowDown', modifiers: [] },
    },
    {
      id: 'ssh.overlay.escape',
      group: 'input',
      labelKey: 'chrome.cmd.escape',
      action: 'escape',
      local: true,
      keys: { code: 'Escape', modifiers: [] },
    },
  ])

  /** Jump-to-tab commands are generated, one per digit, because §8.4 spans 1..9. */
  function jumpShortcuts() {
    const rows = []
    for (let index = 1; index <= 9; index += 1) {
      rows.push({
        id: `ssh.tab.jump${index}`,
        group: 'session',
        labelKey: 'chrome.cmd.tabJump',
        labelParams: { index },
        aliases: [`ssh tab ${index}`],
        action: 'jumpTab',
        actionParam: index - 1,
        regions: ['page', 'editable'],
        onBareKeys: false,
        defaults: {
          'desktop:macos': desktop(`Digit${index}`, ['primary']),
          'desktop:windows': desktop(`Digit${index}`, ['primary']),
          'desktop:linux': desktop(`Digit${index}`, ['primary']),
          'web:macos': web(`Digit${index}`, ['primary', 'alt']),
          'web:windows': web(`Digit${index}`, ['primary', 'alt']),
        },
      })
    }
    return rows
  }

  /** Every row, shell-registered ones first. */
  const ALL = Object.freeze([...SHORTCUTS, ...jumpShortcuts()])

  /** Keycap glyphs per platform, matching the shell's own presentation. */
  const MODIFIER_LABELS = {
    macos: { primary: '\u2318', control: '\u2303', alt: '\u2325', shift: '\u21e7', meta: '\u2318' },
    windows: { primary: 'Ctrl', control: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Meta' },
    linux: { primary: 'Ctrl', control: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Meta' },
  }

  /** Best-effort runtime/platform detection; the shell service overrides it when present. */
  function detectEnvironment(service) {
    let platform = null
    let runtime = null
    try {
      if (service && typeof service.platform === 'string') platform = service.platform
      if (service && typeof service.runtime === 'string') runtime = service.runtime
    } catch {
      /* a foreign service must never break rendering */
    }
    const ua = typeof navigator !== 'undefined' ? String(navigator.userAgent || '') : ''
    if (!platform) {
      if (/Mac|iPhone|iPad/i.test(ua)) platform = 'macos'
      else if (/Linux/i.test(ua) && !/Android/i.test(ua)) platform = 'linux'
      else platform = 'windows'
    }
    if (!runtime) runtime = /Electron/i.test(ua) ? 'desktop' : 'web'
    return { platform, runtime }
  }

  /** The binding a row uses on one profile, or undefined when unbound there. */
  function bindingFor(row, runtime, platform) {
    if (row.local) return row.keys
    if (!row.defaults) return undefined
    return row.defaults[`${runtime}:${platform}`]
  }

  const KEY_LABELS = {
    Slash: '/',
    Comma: ',',
    Period: '.',
    Backslash: '\\',
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Semicolon: ';',
    Quote: "'",
    Enter: 'Enter',
    Escape: 'Esc',
    Space: 'Space',
    Tab: 'Tab',
    ArrowUp: '\u2191',
    ArrowDown: '\u2193',
    ArrowLeft: '\u2190',
    ArrowRight: '\u2192',
  }

  /** Keycap labels for a binding, e.g. `['Ctrl', 'Shift', 'S']`. */
  function comboLabels(binding, platform) {
    if (!binding) return []
    const symbols = MODIFIER_LABELS[platform] || MODIFIER_LABELS.windows
    const key = KEY_LABELS[binding.code] || String(binding.code).replace(/^(Key|Digit)/, '')
    return [...(binding.modifiers || []).map((modifier) => symbols[modifier] || modifier), key]
  }

  /**
   * Rows for `ShortcutHelp`, with the source that actually won.
   *
   * `registrations` is what `registerShortcuts` returned; a row the shell rejected is
   * reported as `conflict` so the reference never claims a combination that is not
   * live.
   */
  function describeShortcuts(options = {}) {
    const i18n = options.i18n || SSH.require('ssh.i18n').getI18n()
    const environment = options.environment || detectEnvironment(options.service)
    const registrations = options.registrations || []
    const statusOf = (id) => {
      const row = registrations.find((entry) => entry.id === id)
      return row ? row.status : options.defaultStatus || 'local'
    }
    /**
     * Prefer the shell's own keycaps: the user may have rebound the command, and a
     * reference that shows the default would then be wrong.
     */
    const keysFromService = (binding) => {
      const service = options.service
      if (!binding || !service || typeof service.describeBinding !== 'function') return null
      try {
        const described = service.describeBinding(binding)
        return Array.isArray(described && described.keys) && described.keys.length > 0 ? described.keys : null
      } catch {
        return null
      }
    }
    return ALL.map((row) => {
      const binding = bindingFor(row, environment.runtime, environment.platform)
      const status = row.local ? 'local' : statusOf(row.id)
      const substituted = row.substituted
        ? i18n.t('chrome.shortcut.substituted', { name: row.substitutionReason || 'DSH' })
        : null
      return {
        id: row.id,
        group: row.group,
        label: i18n.t(row.labelKey, row.labelParams),
        keys: keysFromService(binding) || comboLabels(binding, environment.platform),
        source: status,
        note: status === 'conflict' ? i18n.t('chrome.shortcut.conflict') : substituted,
        region: Array.isArray(row.regions) ? row.regions.join('+') : 'local',
      }
    })
  }

  const HELP_TITLE_KEY = 'chrome.shortcut.title'

  /** Own-pane test used by `resolve` and by the local listener. */
  function isInsideSsh(target) {
    if (!target || typeof target.closest !== 'function') return false
    try {
      return target.closest(OWN_SELECTOR) !== null
    } catch {
      return false
    }
  }

  function isEditable(target) {
    if (!target || typeof target.closest !== 'function') return false
    try {
      return target.closest(EDITABLE) !== null
    } catch {
      return false
    }
  }

  function isTerminal(target) {
    if (!target || typeof target.closest !== 'function') return false
    try {
      return target.closest('.xterm') !== null
    } catch {
      return false
    }
  }

  /**
   * Register every §8.4 command with the shell's shortcut service.
   *
   * `targets` is a plain object of callbacks (`focusPanel`, `newConnection`,
   * `closeTab`, `nextTab`, `prevTab`, `jumpTab`, `clearTerminal`, `fontUp`, ...). Keeping
   * it a plain object is what lets the store owner wire it without importing this
   * module, and lets the tests drive it with spies.
   */
  function registerShortcuts(ctx, targets = {}, options = {}) {
    const i18n = options.i18n || SSH.require('ssh.i18n').getI18n()
    const service = options.service || safeGet(ctx, 'shortcuts')
    const registrations = []
    const disposers = []

    if (!service || typeof service.register !== 'function') {
      for (const row of ALL) {
        if (!row.local) registrations.push({ id: row.id, status: 'unavailable', reason: 'shortcuts service is absent' })
      }
      // Same shape as the success path: the caller reads `conflicts` without checking
      // whether the service existed, and a missing field would silently mean "none".
      return {
        ok: false,
        service: null,
        registrations,
        conflicts: registrations.map((entry) => entry.id),
        dispose() {},
      }
    }

    const environment = detectEnvironment(service)
    const isOwned = typeof options.isOwned === 'function' ? options.isOwned : isInsideSsh

    const resolveFor = (row) => (context) => {
      const target = context ? context.target : undefined
      const run = targets[row.action]
      if (typeof run !== 'function') return { status: 'pass' }
      // A pane-scoped command (our terminal, our font) must not consume a key pressed
      // elsewhere: `blocked` would preventDefault, so the only safe answer is `pass`.
      // Panel-wide commands such as "focus the SSH panel" are deliberately global.
      if (row.ownPaneOnly === true && !isOwned(target)) return { status: 'pass' }
      return {
        status: 'handled',
        run: () => {
          try {
            run(row.actionParam)
          } catch (error) {
            console.error(`[dsh-ssh] shortcut ${row.id} failed`, error)
          }
        },
      }
    }

    const attempt = (row, defaults) =>
      service.register({
        id: row.id,
        label: () => i18n.t(row.labelKey, row.labelParams),
        aliases: row.aliases || [],
        defaults,
        regions: row.regions || ['page'],
        modals: [],
        resolve: resolveFor(row),
      })

    for (const row of ALL) {
      if (row.local) {
        registrations.push({ id: row.id, status: 'local' })
        continue
      }
      let dispose = null
      try {
        dispose = attempt(row, row.defaults)
      } catch (error) {
        // The combination is taken or refused by this shell build: try the documented
        // alternative before falling back to the local listener.
        if (row.fallbackDefaults) {
          try {
            dispose = attempt(row, row.fallbackDefaults)
            registrations.push({ id: row.id, status: 'shell', substituted: true, reason: messageOf(error) })
          } catch (second) {
            registrations.push({ id: row.id, status: 'conflict', reason: messageOf(second) })
          }
        } else {
          registrations.push({ id: row.id, status: 'conflict', reason: messageOf(error) })
        }
      }
      if (dispose) {
        if (registrations.every((entry) => entry.id !== row.id)) registrations.push({ id: row.id, status: 'shell' })
        disposers.push(dispose)
        if (typeof ctx.effect === 'function') ctx.effect(() => dispose, `dsh-ssh: shortcut ${row.id}`)
      }
    }

    return {
      ok: true,
      service,
      environment,
      registrations,
      /** Rows the local listener has to serve instead of the shell. */
      conflicts: registrations.filter((entry) => entry.status === 'conflict' || entry.status === 'unavailable').map((entry) => entry.id),
      dispose() {
        for (const dispose of disposers.splice(0)) {
          try {
            dispose()
          } catch {
            /* already gone */
          }
        }
      },
    }
  }

  function messageOf(error) {
    return error && error.message ? String(error.message) : String(error)
  }

  function safeGet(ctx, name) {
    try {
      return ctx && typeof ctx.get === 'function' ? ctx.get(name) ?? undefined : undefined
    } catch {
      return undefined
    }
  }

  /** Does an event match a binding from this table? Physical `code` + modifiers. */
  function matchesBinding(event, binding) {
    if (!binding) return false
    if (event.code !== binding.code) return false
    const modifiers = binding.modifiers || []
    const want = {
      control: modifiers.includes('control') || modifiers.includes('primary'),
      alt: modifiers.includes('alt'),
      shift: modifiers.includes('shift'),
      meta: modifiers.includes('meta'),
    }
    return (
      event.ctrlKey === want.control &&
      event.altKey === want.alt &&
      event.shiftKey === want.shift &&
      event.metaKey === want.meta
    )
  }

  /**
   * The scoped local listener: bare keys plus any command the shell refused.
   *
   * Returns a DOM handler; `true` means the event was consumed. It never runs outside
   * our own pane, so the shell's global keys stay the shell's.
   */
  function createLocalKeyHandler(targets = {}, options = {}) {
    const conflictIds = options.conflictIds || []
    const isOwned = typeof options.isOwned === 'function' ? options.isOwned : isInsideSsh
    const rows = ALL.filter((row) => row.local || conflictIds.includes(row.id))

    return function onKeyDown(event) {
      const target = event.target
      if (options.force !== true && !isOwned(target)) return false
      if (target && typeof target.closest === 'function' && target.closest(DIALOG_SELECTOR)) return false

      for (const row of rows) {
        const binding = row.local ? row.keys : bindingFor(row, options.runtime || 'desktop', options.platform || 'windows')
        if (!matchesBinding(event, binding)) continue
        // History keys belong to the command input, not to a terminal.
        if (row.id === 'ssh.history.prev' || row.id === 'ssh.history.next') {
          if (!isEditable(target) || isTerminal(target)) continue
        }
        const run = targets[row.action]
        if (typeof run !== 'function') continue
        if (typeof event.preventDefault === 'function') event.preventDefault()
        run(row.actionParam)
        return true
      }
      return false
    }
  }

  /**
   * The frozen `ShortcutHelp` props (ICD §8.3): `{ open, onClose, bindings }`.
   *
   * `bindings` rows come from `describeShortcuts()`; the reference groups them and
   * marks which ones the shell registered and which only apply inside the panel.
   */
  function ShortcutHelp(props) {
    const { open, onClose, bindings = [] } = props
    const i18n = SSH.require('ssh.i18n').getI18n()

    const groups = useMemo(() => {
      const order = []
      const byGroup = new Map()
      for (const row of bindings) {
        const key = row.group || 'navigation'
        if (!byGroup.has(key)) {
          byGroup.set(key, [])
          order.push(key)
        }
        byGroup.get(key).push(row)
      }
      return order.map((key) => ({ key, rows: byGroup.get(key) }))
    }, [bindings])

    if (!open) return null

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        if (typeof onClose === 'function') onClose()
      }
    }

    return h(
      'div',
      {
        className: 'dsh-ssh-shortcuts-backdrop',
        'data-testid': 'ssh-shortcut-help',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget && typeof onClose === 'function') onClose()
        },
      },
      h(
        'div',
        { className: 'dsh-ssh-shortcuts', role: 'dialog', 'aria-modal': 'true', 'aria-label': i18n.t(HELP_TITLE_KEY), onKeyDown },
        h(
          'div',
          { className: 'dsh-ssh-shortcuts-head' },
          h('span', { className: 'dsh-ssh-shortcuts-title' }, i18n.t(HELP_TITLE_KEY)),
          typeof onClose === 'function'
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-ssh-tab-tool',
                  style: { marginLeft: 'auto' },
                  'data-testid': 'ssh-shortcut-close',
                  'aria-label': i18n.t('chrome.shortcut.close'),
                  onClick: () => onClose(),
                },
                '×',
              )
            : null,
        ),
        h('div', { className: 'dsh-ssh-shortcuts-note' }, i18n.t('chrome.shortcut.note')),
        groups.length === 0
          ? h('div', { className: 'dsh-ssh-shortcuts-empty' }, i18n.t('chrome.tabs.empty'))
          : groups.map((group) =>
              h(
                'div',
                { className: 'dsh-ssh-shortcuts-group', key: group.key, 'data-testid': `ssh-shortcut-group-${group.key}` },
                h('div', { className: 'dsh-ssh-shortcuts-group-title' }, i18n.t(`chrome.group.${group.key}`)),
                group.rows.map((row) =>
                  h(
                    'div',
                    {
                      className: 'dsh-ssh-shortcuts-row',
                      key: row.id,
                      'data-testid': `ssh-shortcut-row-${row.id}`,
                      'data-source': row.source,
                    },
                    h(
                      'span',
                      { className: 'dsh-ssh-shortcuts-label' },
                      row.label,
                      row.note ? h('span', { className: 'dsh-ssh-shortcuts-source' }, ` · ${row.note}`) : null,
                    ),
                    h(
                      'span',
                      { className: 'dsh-ssh-shortcuts-keys' },
                      row.keys.length === 0
                        ? h('span', { className: 'dsh-ssh-shortcuts-source' }, i18n.t('chrome.shortcut.local'))
                        : row.keys.map((label, index) =>
                            h('kbd', { className: 'dsh-ssh-shortcuts-key', key: `${row.id}-${index}` }, label),
                          ),
                    ),
                  ),
                ),
              ),
            ),
      ),
    )
  }

  return {
    SHORTCUTS,
    ALL,
    EDITABLE,
    OWN_SELECTOR,
    detectEnvironment,
    bindingFor,
    comboLabels,
    describeShortcuts,
    registerShortcuts,
    createLocalKeyHandler,
    matchesBinding,
    isInsideSsh,
    isEditable,
    isTerminal,
    ShortcutHelp,
  }
})
