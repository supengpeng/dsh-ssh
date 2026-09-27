/**
 * @module ssh.session.command
 * @order 420
 *
 * `CommandPanel` — one command at a time on the remote host (ICD §8.3 props,
 * frozen).
 *
 * The interesting behaviour is the history: `↑`/`↓` walk the command list the way
 * a shell does, remembering the half-typed line so that stepping back past the
 * newest entry restores it. The list lives in `history` (the container persists it
 * under `dsh-ssh.cmdHistory`, ICD §8.6) and the walk is implemented as a pure
 * function as well, because that is the part worth asserting directly.
 *
 * `result` renders the full command outcome: stdout and stderr kept apart, the exit
 * code, the duration, and the truncation flag the host sets when output hit
 * `maxOutputBytes` (ICD §4.4).
 */

SSH.define('ssh.session.command', function (SSH) {
  const { useState, useRef, useEffect, useCallback } = SSH.react
  const h = SSH.h

  /**
   * One step of history navigation.
   *
   * `history` is chronological (oldest first), which is how the host stores it;
   * `↑` therefore starts at the newest entry. `index === null` means "editing a new
   * line", and `draft` is that line, restored when the user walks past the newest
   * entry again.
   *
   * @returns `{ index, value }` - the new cursor position and the line to show.
   */
  function historyStep(state, direction) {
    const history = Array.isArray(state.history) ? state.history : []
    const index = state.index === null || state.index === undefined ? null : Number(state.index)
    const draft = typeof state.draft === 'string' ? state.draft : ''
    const current = typeof state.value === 'string' ? state.value : ''
    if (history.length === 0) return { index: null, value: current }

    if (direction === 'up') {
      if (index === null) return { index: history.length - 1, value: String(history[history.length - 1]) }
      if (index > 0) return { index: index - 1, value: String(history[index - 1]) }
      return { index, value: current }
    }

    if (index === null) return { index: null, value: current }
    if (index < history.length - 1) return { index: index + 1, value: String(history[index + 1]) }
    return { index: null, value: draft }
  }

  function CommandPanel(props) {
    const settings = props || {}
    const { sessionId, onRun, running, result, onClear, onCancel } = settings
    const history = Array.isArray(settings.history) ? settings.history : []

    const ui = SSH.require('ssh.session.ui')
    const runtime = SSH.require('ssh.session.runtime')
    const primitives = ui.ui()
    const t = ui.t
    const { Button, EmptyState, Mono, Pill } = primitives
    const Input = primitives.Input

    const [value, setValue] = useState('')
    const [index, setIndex] = useState(null)
    const [draft, setDraft] = useState('')
    const [copied, setCopied] = useState(null)
    const inputRef = useRef(null)

    // The runtime keeps an exec stream's output too, so a panel that was handed a
    // streamId instead of a result object still shows something.
    const record = settings.streamId ? runtime.useStream(settings.streamId).record : null
    const stdout = result ? result.stdout ?? '' : record ? record.text.stdout : ''
    const stderr = result ? result.stderr ?? '' : record ? record.text.stderr : ''
    const exitCode = result ? result.exitCode : record && record.exit ? record.exit.exitCode : null
    const durationMs = result ? result.durationMs : record && record.exit ? record.exit.durationMs : null
    const truncated = result
      ? result.truncated === true || (result.truncated && (result.truncated.stdout || result.truncated.stderr)) === true
      : false
    const timedOut = result ? result.timedOut === true : record && record.exit ? record.exit.timedOut === true : false

    useEffect(() => {
      SSH.require('ssh.session.styles').ensureStyles()
    }, [])

    useEffect(() => {
      if (!copied) return undefined
      const timer = setTimeout(() => setCopied(null), 1600)
      return () => clearTimeout(timer)
    }, [copied])

    const submit = useCallback(() => {
      const command = value
      if (command.trim() === '') return
      if (running === true) return
      if (typeof onRun === 'function') onRun(command)
      // The next command starts from a clean line, but the history walk restarts
      // from the newest entry rather than staying where the user left it.
      setIndex(null)
      setDraft('')
      setValue('')
    }, [onRun, running, value])

    const walk = useCallback(
      (direction) => {
        const next = historyStep({ history, index, draft, value }, direction)
        setIndex(next.index)
        if (direction === 'up' && index === null) setDraft(value)
        setValue(next.value)
      },
      [draft, history, index, value],
    )

    const handleKeyDown = useCallback(
      (event) => {
        const meta = event.ctrlKey === true || event.metaKey === true
        const key = typeof event.key === 'string' ? event.key : ''
        if (key === 'ArrowUp') {
          event.preventDefault()
          walk('up')
          return
        }
        if (key === 'ArrowDown') {
          event.preventDefault()
          walk('down')
          return
        }
        if (key === 'Enter') {
          event.preventDefault()
          submit()
          return
        }
        if (meta && key.toLowerCase() === 'c' && running === true) {
          event.preventDefault()
          if (typeof onCancel === 'function') onCancel()
          return
        }
        if (meta && key.toLowerCase() === 'l') {
          event.preventDefault()
          if (typeof onClear === 'function') onClear()
        }
      },
      [onCancel, onClear, running, submit, walk],
    )

    const copySection = useCallback(
      async (label, text) => {
        const ok = await ui.copyText(text)
        setCopied(ok ? label : `${label}?`)
      },
      [ui],
    )

    const exitTone = exitCode === 0 ? 'ok' : exitCode === null || exitCode === undefined ? 'neutral' : 'error'
    const hasOutput = stdout !== '' || stderr !== '' || result !== undefined || record !== null

    return h(
      'div',
      { className: 'ssh-ws', 'data-testid': 'ssh-ws-command' },
      h(
        'div',
        { className: 'ssh-ws-toolbar' },
        h('span', { className: 'ssh-ws-title' }, t('ws.tabs.command')),
        h('span', { className: 'ssh-ws-sub', 'data-testid': 'ssh-ws-cmd-session' }, sessionId || '—'),
        h('span', { className: 'ssh-ws-spacer' }),
        running === true
          ? h(Pill, { state: 'connecting' }, h(primitives.Spinner, { size: 10 }), t('ws.cmd.running'))
          : null,
        exitCode !== null && exitCode !== undefined
          ? h(
              'span',
              { className: 'ssh-ws-badge', 'data-outcome': exitTone, 'data-testid': 'ssh-ws-cmd-exit' },
              `${t('ws.cmd.exitCode')} ${exitCode}`,
            )
          : null,
        durationMs !== null && durationMs !== undefined
          ? h('span', { className: 'ssh-ws-sub', 'data-testid': 'ssh-ws-cmd-duration' }, `${ui.formatDuration(durationMs)}`)
          : null,
        h(
          Button,
          {
            onClick: () => (typeof onClear === 'function' ? onClear() : undefined),
            disabled: !hasOutput,
            dataTestId: 'ssh-ws-cmd-clear',
          },
          t('ws.cmd.clear'),
        ),
      ),

      h(
        'div',
        { style: { padding: '8px' } },
        h(
          'div',
          { className: 'ssh-ws-cmd-input' },
          h('span', { className: 'ssh-ws-cmd-prompt' }, '$'),
          h(Input, {
            value,
            onChange: (next) => {
              setValue(next)
              setIndex(null)
            },
            onKeyDown: handleKeyDown,
            placeholder: t('ws.cmd.placeholder'),
            disabled: running === true,
            autoFocus: settings.autoFocus !== false,
            dataTestId: 'ssh-ws-cmd-input',
            // Used by the history chips below, which put a past command back in the
            // field; the primitive is SP5's and may ignore it (hence the guard).
            inputRef,
          }),
          running === true
            ? h(
                Button,
                {
                  kind: 'danger',
                  onClick: () => (typeof onCancel === 'function' ? onCancel() : undefined),
                  dataTestId: 'ssh-ws-cmd-cancel',
                },
                t('ws.cmd.cancel'),
              )
            : h(Button, { kind: 'primary', onClick: submit, dataTestId: 'ssh-ws-cmd-run', disabled: value.trim() === '' }, t('ws.cmd.run')),
        ),
        history.length > 0
          ? h(
              'div',
              { style: { marginTop: 6 } },
              h('span', { className: 'ssh-ws-hint' }, `${t('ws.cmd.history')} (${history.length})`),
              h(
                'div',
                { className: 'ssh-ws-cmd-history', 'data-testid': 'ssh-ws-cmd-history' },
                history
                  .slice()
                  .reverse()
                  .slice(0, 20)
                  .map((entry, position) =>
                    h(
                      'button',
                      {
                        key: `h-${position}`,
                        type: 'button',
                        className: 'ssh-ws-cmd-history-item',
                        title: String(entry),
                        onClick: () => {
                          setValue(String(entry))
                          setIndex(null)
                          if (inputRef.current && typeof inputRef.current.focus === 'function') inputRef.current.focus()
                        },
                      },
                      String(entry),
                    ),
                  ),
              ),
            )
          : null,
        truncated ? h('div', { className: 'ssh-ws-hint', 'data-testid': 'ssh-ws-cmd-truncated' }, t('ws.cmd.truncated')) : null,
        timedOut ? h('div', { className: 'ssh-ws-hint', 'data-testid': 'ssh-ws-cmd-timeout' }, t('ws.cmd.timedOut')) : null,
      ),

      h(
        'div',
        { className: 'ssh-ws-body', style: { padding: '0 8px 8px', gap: 8 } },
        !hasOutput && running !== true
          ? h(EmptyState, { title: t('ws.cmd.empty'), dataTestId: 'ssh-ws-cmd-empty' })
          : null,
        stdout !== ''
          ? h(
              'div',
              { className: 'ssh-ws-cmd-pane', 'data-testid': 'ssh-ws-cmd-stdout' },
              h(
                'div',
                { className: 'ssh-ws-cmd-pane-head' },
                h('span', null, t('ws.cmd.stdout')),
                h('span', { className: 'ssh-ws-spacer' }),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'ssh-ws-filter',
                    onClick: () => copySection('stdout', stdout),
                  },
                  copied === 'stdout' ? t('toast.copied') : t('ws.term.copy'),
                ),
              ),
              result && result.truncated && result.truncated.stdout ? h('div', { className: 'ssh-ws-hint' }, t('ws.cmd.truncated')) : null,
              h(Mono, null, stdout),
            )
          : null,
        stderr !== ''
          ? h(
              'div',
              { className: 'ssh-ws-cmd-pane', 'data-testid': 'ssh-ws-cmd-stderr' },
              h(
                'div',
                { className: 'ssh-ws-cmd-pane-head' },
                h('span', { 'data-channel': 'stderr' }, t('ws.cmd.stderr')),
                h('span', { className: 'ssh-ws-spacer' }),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'ssh-ws-filter',
                    onClick: () => copySection('stderr', stderr),
                  },
                  copied === 'stderr' ? t('toast.copied') : t('ws.term.copy'),
                ),
              ),
              h('pre', { className: 'ssh-ws-out', 'data-channel': 'stderr' }, stderr),
            )
          : null,
        copied && copied.endsWith('?') ? h('div', { className: 'ssh-ws-hint' }, t('toast.copiedFailed')) : null,
      ),
    )
  }

  return { CommandPanel, historyStep }
})
