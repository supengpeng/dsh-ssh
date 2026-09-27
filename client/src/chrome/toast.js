/**
 * @module ssh.chrome.toast
 * @order 64
 *
 * Toast stack for the SSH panel (ICD §8.2 `toast`, §8.3 `Toast` props).
 *
 * Two things about this module are load-bearing:
 *
 *   1. Toasts live in `shell.overlay`, which is **click-through** — an occupant has
 *      to opt back into pointer events or its buttons are inert (M0-SPIKE §4 C4).
 *      `.dsh-ssh-toast`, `.dsh-ssh-toasts` and the confirm dialog therefore set
 *      `pointer-events` explicitly in `client/src/theme.css`, and the tests assert it.
 *   2. Push/dismiss is a controller rather than component state, so the shortcuts,
 *      the bridge and the file manager can raise a toast from outside React.
 */

SSH.define('ssh.chrome.toast', function (SSH) {
  const { useCallback, useState, useSyncExternalStore } = SSH.react
  const h = SSH.h

  const KINDS = Object.freeze(['info', 'success', 'warn', 'error'])
  /** Sticky by default for failures, so an error is never missed. */
  const DEFAULT_TTL_MS = Object.freeze({ info: 4000, success: 4000, warn: 6000, error: 0 })

  function normalizeKind(kind) {
    return KINDS.includes(kind) ? kind : 'info'
  }

  /**
   * Create a toast controller.
   *
   * `ttlMs` follows the kind by default; `0` means "stay until dismissed". Timers are
   * owned by the controller so a test (or an unload) can stop them with `dispose()`.
   */
  function createToastController(options = {}) {
    let counter = 0
    let toasts = []
    const listeners = new Set()
    const timers = new Map()
    const max = typeof options.max === 'number' && options.max > 0 ? options.max : 6

    const notify = () => {
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch (error) {
          console.error('[dsh-ssh] toast listener failed', error)
        }
      }
    }

    const clearTimer = (id) => {
      const timer = timers.get(id)
      if (timer !== undefined) {
        clearTimeout(timer)
        timers.delete(id)
      }
    }

    const dismiss = (id) => {
      clearTimer(id)
      const next = toasts.filter((toast) => toast.id !== id)
      if (next.length === toasts.length) return false
      toasts = next
      notify()
      return true
    }

    /**
     * Raise a toast. Returns its id, so a progress toast can be replaced or closed
     * by the operation that created it.
     */
    const push = (toast) => {
      if (!toast || typeof toast.text !== 'string' || toast.text === '') {
        throw new Error('toast.push requires { text }')
      }
      counter += 1
      const id = toast.id || `toast_${counter}`
      const kind = normalizeKind(toast.kind)
      const entry = {
        id,
        kind,
        text: toast.text,
        ...(toast.detail === undefined || toast.detail === null || toast.detail === '' ? {} : { detail: String(toast.detail) }),
      }
      const previous = toasts.findIndex((row) => row.id === id)
      toasts = previous >= 0 ? toasts.map((row, index) => (index === previous ? entry : row)) : [...toasts, entry].slice(-max)
      const ttl = typeof toast.ttlMs === 'number' ? toast.ttlMs : DEFAULT_TTL_MS[kind]
      clearTimer(id)
      if (ttl > 0) {
        const timer = setTimeout(() => dismiss(id), ttl)
        // Node keeps the process alive for pending timers; the browser ignores this.
        if (timer && typeof timer.unref === 'function') timer.unref()
        timers.set(id, timer)
      }
      notify()
      return id
    }

    return {
      push,
      dismiss,
      clear() {
        for (const id of [...timers.keys()]) clearTimer(id)
        if (toasts.length === 0) return
        toasts = []
        notify()
      },
      list: () => toasts,
      size: () => toasts.length,
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      useToasts() {
        return useSyncExternalStore(
          (listener) => this.subscribe(listener),
          () => toasts,
          () => toasts,
        )
      },
      /** Stop every timer; the client run's disposer calls this. */
      dispose() {
        for (const id of [...timers.keys()]) clearTimer(id)
      },
    }
  }

  let controller = null

  /** The client-run controller. `toast()` from anywhere resolves through this. */
  function getToastController() {
    if (!controller) controller = createToastController()
    return controller
  }

  /** Raise one toast without touching React. */
  function toast(kindOrToast, text, detail) {
    const input = typeof kindOrToast === 'string' ? { kind: kindOrToast, text, detail } : kindOrToast
    return getToastController().push(input)
  }

  /**
   * Turn an ICD §5 `ErrorInfo` into a toast payload.
   *
   * The message is rendered from `err.<CODE>` so the UI never shows a raw host string
   * as the headline, while the technical message stays available in `detail`.
   */
  function toastFromError(error, fallbackKey = 'err.SSH_UNKNOWN') {
    const i18n = SSH.require('ssh.i18n').getI18n()
    const code = error && typeof error.code === 'string' ? error.code : null
    const text = code ? i18n.t(`err.${code}`) : i18n.t(fallbackKey)
    const detail = error && error.message ? String(error.message) : undefined
    return { kind: 'error', text, detail }
  }

  function ToastItem(props) {
    const { toast: entry, onClose, onExpand, expanded } = props
    const i18n = SSH.require('ssh.i18n').getI18n()
    const hasDetail = Boolean(entry.detail)
    return h(
      'div',
      {
        className: 'dsh-ssh-toast',
        'data-kind': normalizeKind(entry.kind),
        'data-toast-id': entry.id,
        role: entry.kind === 'error' ? 'alert' : 'status',
      },
      h(
        'div',
        { className: 'dsh-ssh-toast-body' },
        h('div', { className: 'dsh-ssh-toast-text' }, entry.text),
        hasDetail && expanded ? h('div', { className: 'dsh-ssh-toast-detail' }, entry.detail) : null,
      ),
      h(
        'div',
        { className: 'dsh-ssh-toast-actions' },
        hasDetail && typeof onExpand === 'function'
          ? h(
              'button',
              {
                type: 'button',
                className: 'dsh-ssh-toast-btn',
                'data-testid': `ssh-toast-expand-${entry.id}`,
                title: i18n.t('chrome.toast.detail'),
                onClick: () => onExpand(entry.id),
              },
              expanded ? i18n.t('chrome.toast.expand') : i18n.t('chrome.toast.detail'),
            )
          : null,
        typeof onClose === 'function'
          ? h(
              'button',
              {
                type: 'button',
                className: 'dsh-ssh-toast-btn',
                'data-testid': `ssh-toast-close-${entry.id}`,
                title: i18n.t('chrome.toast.dismiss'),
                'aria-label': i18n.t('chrome.toast.dismiss'),
                onClick: () => onClose(entry.id),
              },
              '×',
            )
          : null,
      ),
    )
  }

  /**
   * The stack itself. Props are `{ toasts, onClose, onExpand }`; it renders nothing
   * when the list is empty so an idle panel adds no overlay node.
   */
  function ToastStack(props) {
    const entries = props.toasts || []
    // Hooks run before any early return: the stack would otherwise change its hook
    // count the moment the first toast appears.
    const [expanded, setExpanded] = useState(null)
    if (entries.length === 0) return null
    const onExpand =
      props.onExpand ||
      ((id) => setExpanded((current) => (current === id ? null : id)))
    return h(
      'div',
      { className: 'dsh-ssh-toasts', 'data-testid': 'ssh-toasts', 'aria-live': 'polite' },
      entries.map((entry) =>
        h(ToastItem, {
          key: entry.id,
          toast: entry,
          expanded: expanded === entry.id,
          onClose: props.onClose,
          onExpand,
        }),
      ),
    )
  }

  /**
   * `shell.overlay` occupant: renders the live toast list from the client-run
   * controller. Registered by `ssh.chrome.install`, and mountable on its own in a test.
   */
  function ToastHost(props) {
    const control = props.controller || getToastController()
    const entries = control.useToasts()
    const onClose = useCallback((id) => control.dismiss(id), [control])
    return h(ToastStack, { toasts: entries, onClose })
  }

  /** Slot declaration for the overlay, kept here so the seat is described once. */
  const SLOT = { name: 'shell.overlay', id: 'ssh-toasts', order: 900 }

  return {
    KINDS,
    DEFAULT_TTL_MS,
    SLOT,
    ToastItem,
    ToastStack,
    ToastHost,
    createToastController,
    getToastController,
    toast,
    toastFromError,
  }
})
