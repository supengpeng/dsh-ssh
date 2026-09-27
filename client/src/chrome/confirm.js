/**
 * @module ssh.chrome.confirm
 * @order 66
 *
 * Confirmation for dangerous operations (ICD §8.3 `ConfirmDialog`, §4.5 conflict
 * rules, §12 acceptance).
 *
 * Three operations are security-relevant and must never happen on a single click:
 *
 *   - closing a **live** session (`closing a live session`),
 *   - deleting a remote path,
 *   - overwriting an existing remote file (`SSH_SFTP_TARGET_EXISTS` requires a second
 *     confirmation before the request is retried with `overwrite: true`).
 *
 * This module owns both halves of that: the dialog itself (frozen props, so it can be
 * swapped for `SSH.ui.ConfirmDialog` without touching the callers) and the *policy*
 * (`dangerRequest` → a promise the caller awaits). `TabStrip` and `StatusBar` already
 * route through it; the file manager reaches it through `ssh.chrome.danger`.
 *
 * The type-to-confirm field binds its `input` event natively instead of through
 * React's synthetic `onChange`: the headless linkedom harness does not deliver
 * synthetic change events for text inputs, and a confirmation gate that cannot be
 * tested is a gate that will regress.
 */

SSH.define('ssh.chrome.confirm', function (SSH) {
  const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = SSH.react
  const h = SSH.h

  /** Basename of a POSIX or Windows remote path, used as the typed token. */
  function baseName(path) {
    const text = String(path ?? '').replace(/[/\\]+/, '')
    const index = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
    return index >= 0 ? text.slice(index + 1) : text
  }

  /** `requireType` gate. Exact match after trimming, so a stray space cannot pass. */
  function isConfirmationSatisfied(typed, requireType) {
    if (requireType === undefined || requireType === null || requireType === '') return true
    return String(typed ?? '').trim() === String(requireType)
  }

  /** Human-readable byte size for the overwrite body. */
  function humanSize(bytes) {
    const value = Number(bytes)
    if (!Number.isFinite(value) || value < 0) return '—'
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
    let size = value
    let unit = 0
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024
      unit += 1
    }
    return `${unit === 0 ? size : size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`
  }

  /**
   * The confirmation payloads, as pure functions of the operation.
   *
   * Separate from the dialog so the *policy* ("what must be confirmed, and what does
   * the user have to type") is testable without a DOM.
   */
  function dangerRequest(kind, details = {}, t) {
    const translate = typeof t === 'function' ? t : (key) => key
    switch (kind) {
      case 'closeSession': {
        const label = details.label || details.sessionId || '—'
        return {
          kind,
          danger: true,
          title: translate('chrome.confirm.closeSession.title'),
          body: translate('chrome.confirm.closeSession.body', { label }),
          requireType: label,
          confirmText: translate('conn.disconnect'),
          cancelText: translate('chrome.confirm.cancel'),
        }
      }
      case 'deletePath': {
        const path = details.path || '—'
        const recursive = details.recursive === true || (typeof details.count === 'number' && details.count > 1)
        return {
          kind,
          danger: true,
          title: translate('chrome.confirm.deletePath.title'),
          body: translate(recursive ? 'chrome.confirm.deletePath.bodyRecursive' : 'chrome.confirm.deletePath.body', { path }),
          requireType: baseName(path),
          confirmText: translate('ws.files.delete'),
          cancelText: translate('chrome.confirm.cancel'),
        }
      }
      case 'overwrite': {
        const path = details.path || '—'
        return {
          kind,
          danger: true,
          title: translate('chrome.confirm.overwrite.title'),
          body: translate('chrome.confirm.overwrite.body', { path, size: humanSize(details.size) }),
          requireType: baseName(path),
          confirmText: translate('ws.files.overwrite'),
          cancelText: translate('chrome.confirm.cancel'),
        }
      }
      default:
        return {
          kind: kind || 'danger',
          danger: true,
          title: details.title || translate('confirm.danger.title'),
          body: details.body || translate('confirm.danger.body'),
          requireType: details.requireType,
          confirmText: details.confirmText || translate('chrome.confirm.confirm'),
          cancelText: details.cancelText || translate('chrome.confirm.cancel'),
        }
    }
  }

  /**
   * The frozen `ConfirmDialog` props (ICD §8.3).
   *
   * Renders nothing while `open` is false. `requireType` blocks the accept button
   * until the typed token matches; `Esc` cancels, `Enter` accepts once satisfied.
   */
  function ConfirmDialog(props) {
    const { open, title, body, danger, confirmText, cancelText, onConfirm, onCancel, requireType } = props
    const [typed, setTyped] = useState('')
    const inputRef = useRef(null)
    const dialogRef = useRef(null)
    const satisfied = isConfirmationSatisfied(typed, requireType)

    // Reset the gate every time the dialog opens and move focus into the dialog, so a
    // plain `Esc` reaches it. The type-to-confirm field is focused when it exists,
    // rather than the destructive button.
    useEffect(() => {
      if (!open) return undefined
      setTyped('')
      const target = requireType ? inputRef.current : dialogRef.current
      if (target && typeof target.focus === 'function') {
        try {
          target.focus()
        } catch {
          /* focus is best-effort in a headless DOM */
        }
      }
      return undefined
    }, [open, requireType])

    // Native listener: React's synthetic change event is not delivered for text
    // inputs in the linkedom harness (see the module note).
    const onInput = useCallback((event) => setTyped(event.target.value), [])
    useEffect(() => {
      const node = inputRef.current
      if (!node || typeof node.addEventListener !== 'function') return undefined
      node.addEventListener('input', onInput)
      return () => node.removeEventListener('input', onInput)
    }, [onInput, open])

    if (!open) return null
    const t = SSH.require('ssh.i18n').getI18n().t

    const accept = () => {
      if (!satisfied) return
      if (typeof onConfirm === 'function') onConfirm()
    }
    const cancel = () => {
      if (typeof onCancel === 'function') onCancel()
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        cancel()
        return
      }
      if (event.key === 'Enter') {
        event.stopPropagation()
        accept()
      }
    }

    return h(
      'div',
      {
        className: 'dsh-ssh-confirm-backdrop',
        'data-testid': 'ssh-confirm-backdrop',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) cancel()
        },
      },
      h(
        'div',
        {
          className: 'dsh-ssh-confirm',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': title,
          'data-testid': 'ssh-confirm',
          'data-danger': danger === true ? 'true' : 'false',
          'data-kind': props.kind || 'danger',
          ref: dialogRef,
          tabIndex: -1,
          onKeyDown,
        },
        h('div', { className: 'dsh-ssh-confirm-title', 'data-testid': 'ssh-confirm-title' }, title),
        body ? h('div', { className: 'dsh-ssh-confirm-body', 'data-testid': 'ssh-confirm-body' }, body) : null,
        requireType
          ? h(
              'label',
              { className: 'dsh-ssh-confirm-type' },
              h('span', { className: 'dsh-ssh-confirm-hint' }, t('confirm.danger.typeToConfirm', { name: requireType })),
              h('input', {
                ref: inputRef,
                type: 'text',
                className: 'dsh-ssh-input',
                'data-testid': 'ssh-confirm-input',
                'data-invalid': satisfied ? 'false' : 'true',
                autoComplete: 'off',
                spellCheck: false,
                defaultValue: '',
              }),
            )
          : null,
        h(
          'div',
          { className: 'dsh-ssh-confirm-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-ssh-confirm-btn',
              'data-kind': 'secondary',
              'data-testid': 'ssh-confirm-cancel',
              onClick: cancel,
            },
            cancelText || t('chrome.confirm.cancel'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-ssh-confirm-btn',
              'data-kind': danger === true ? 'danger' : 'primary',
              'data-testid': 'ssh-confirm-accept',
              disabled: !satisfied,
              onClick: accept,
            },
            confirmText || t('chrome.confirm.confirm'),
          ),
        ),
      ),
    )
  }

  /**
   * A single-slot confirmation queue: one dialog at a time, promise-based.
   *
   * `request(payload)` resolves `true` when the user confirms and `false` on cancel /
   * `Esc` / backdrop click, so callers can `if (!(await confirm.request(…))) return`.
   */
  function createConfirmService(options = {}) {
    let current = null
    let pending = null
    const listeners = new Set()
    const queue = []

    const notify = () => {
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch (error) {
          console.error('[dsh-ssh] confirm listener failed', error)
        }
      }
    }

    const settle = (value) => {
      const request = pending
      current = null
      pending = null
      if (request) request.resolve(value)
      const next = queue.shift()
      if (next) open(next)
      else notify()
    }

    const open = (request) => {
      current = request
      pending = request
      notify()
    }

    const service = {
      /** Ask for confirmation; `true` only when the user actually confirmed. */
      request(payload) {
        if (!payload) return Promise.resolve(false)
        return new Promise((resolve) => {
          const request = { ...payload, resolve }
          if (current) {
            queue.push(request)
            return
          }
          open(request)
        })
      },
      state: () => current,
      /** Number of requests waiting behind the open dialog. */
      queued: () => queue.length,
      resolve: settle,
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      useRequest() {
        return useSyncExternalStore(
          (listener) => service.subscribe(listener),
          () => current,
          () => current,
        )
      },
      /** Drop everything; used by the unload disposer. */
      dispose() {
        for (const request of [...queue]) request.resolve(false)
        queue.length = 0
        const request = pending
        current = null
        pending = null
        if (request) request.resolve(false)
      },
    }
    return service
  }

  let singleton = null

  /** The client-run confirmation service. */
  function getConfirmService() {
    if (!singleton) singleton = createConfirmService()
    return singleton
  }

  /**
   * Ask for one of the security-relevant confirmations.
   *
   * ```js
   * const ok = await danger('closeSession', { label: tab.title })
   * ```
   */
  function danger(kind, details, options = {}) {
    const service = options.service || getConfirmService()
    const t = options.t || SSH.require('ssh.i18n').getI18n().t
    return service.request(dangerRequest(kind, details, t))
  }

  /** Dialog component the queue renders through; injectable for a single UI language. */
  let DialogComponent = ConfirmDialog

  function getDialogComponent() {
    return DialogComponent
  }

  function setDialogComponent(Component) {
    DialogComponent = typeof Component === 'function' ? Component : ConfirmDialog
    return DialogComponent
  }

  /**
   * `shell.overlay` occupant: renders whatever the queue is currently asking.
   * Always mounted by `ssh.chrome.install`, so a confirmation can appear regardless
   * of which panel raised it.
   */
  function ConfirmHost(props) {
    const service = props.service || getConfirmService()
    const request = service.useRequest()
    const Dialog = getDialogComponent()
    const resolve = useMemo(() => (value) => service.resolve(value), [service])
    if (!request) return null
    return h(Dialog, {
      open: true,
      kind: request.kind,
      title: request.title,
      body: request.body,
      danger: request.danger,
      confirmText: request.confirmText,
      cancelText: request.cancelText,
      requireType: request.requireType,
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
    })
  }

  /** Slot declarations for the overlay: toasts and the dialog never fight for an id. */
  const SLOT = { name: 'shell.overlay', id: 'ssh-confirm', order: 901 }

  return {
    SLOT,
    ConfirmDialog,
    ConfirmHost,
    /**
     * Alias for `ConfirmHost`.
     *
     * The workspace half mounts the confirmation surface as "the confirm element", and
     * a stable short name keeps that call site readable: `SSH.require('ssh.chrome.confirm').Confirm`.
     */
    Confirm: ConfirmHost,
    baseName,
    humanSize,
    isConfirmationSatisfied,
    dangerRequest,
    createConfirmService,
    getConfirmService,
    danger,
    setDialogComponent,
    getDialogComponent,
  }
})
