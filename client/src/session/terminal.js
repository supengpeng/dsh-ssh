/**
 * @module ssh.session.terminal
 * @order 400
 *
 * `TerminalTab` — the interactive shell tab (ICD §8.3 props, frozen).
 *
 * It is a pure function of its props plus the session runtime: output comes from
 * the stream buffer keyed by `streamId`, and typing goes through the runtime's
 * `shellWrite`/`shellResize` actions (never the transport directly). Everything a
 * user expects from a terminal tab is here: live streaming, copy and paste, font
 * zoom, clear, and reconnect that resumes from the last rendered sequence number
 * instead of replaying the session from byte zero.
 *
 * Rendering is delegated to `ssh.session.term`, which prefers the vendored
 * emulator and falls back to the built-in screen, so a full-screen application
 * (`top`, `vim`, `less`) redraws in place either way.
 */

SSH.define('ssh.session.terminal', function (SSH) {
  const { useState, useEffect, useRef, useCallback } = SSH.react
  const h = SSH.h

  function TerminalTab(props) {
    const settings = props || {}
    const { sessionId, streamId, onFontSizeChange, onReconnect, onDirtyChange, onExit } = settings
    const session = settings.session || null

    const ui = SSH.require('ssh.session.ui')
    const runtime = SSH.require('ssh.session.runtime')
    const termModule = SSH.require('ssh.session.term')
    const fitModule = SSH.require('ssh.session.fit')
    // `requestAnimationFrame` is not guaranteed (a stripped webview, a headless render):
    // deferring the first fit must not depend on it existing.
    const raf =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (callback) => setTimeout(() => callback(Date.now()), 16)
    const cancelRaf = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout
    const primitives = ui.ui()
    const t = ui.t
    const { IconButton, EmptyState, Button } = primitives

    const { record } = runtime.useStream(streamId)
    const containerRef = useRef(null)
    const hostRef = useRef(null)
    const cursorRef = useRef(-1)
    const exitReportedRef = useRef(null)
    const [fontSize, setFontSize] = useState(() => {
      const provided = Number(settings.fontSize)
      if (Number.isFinite(provided) && provided > 0) return ui.clamp(provided, ui.FONT_MIN, ui.FONT_MAX)
      return ui.readStoredFontSize() ?? 13
    })
    const [mode, setMode] = useState('fallback')
    const [modeReason, setModeReason] = useState(null)
    const [screenVersion, setScreenVersion] = useState(0)
    const [notice, setNotice] = useState(null)
    const [focused, setFocused] = useState(false)

    // The font size is controlled when the owner supplies one, local otherwise.
    const effectiveFontSize = (() => {
      const provided = Number(settings.fontSize)
      return Number.isFinite(provided) && provided > 0 ? ui.clamp(provided, ui.FONT_MIN, ui.FONT_MAX) : fontSize
    })()

    useEffect(() => {
      SSH.require('ssh.session.styles').ensureStyles()
    }, [])

    const flash = useCallback((text) => {
      setNotice(text)
      const timer = setTimeout(() => setNotice(null), 1800)
      return () => clearTimeout(timer)
    }, [])

    // ── renderer lifecycle ──
    useEffect(() => {
      const container = containerRef.current
      if (!container) return undefined
      const host = termModule.createHost({
        container,
        cols: record ? 80 : 80,
        rows: record ? 24 : 24,
        fontSize: effectiveFontSize,
        onData: (data) => {
          if (!streamId) return
          const promise = runtime.actions.shellWrite(streamId, data)
          if (promise && typeof promise.catch === 'function') {
            promise.catch((error) => {
              console.warn('[dsh-ssh] shellWrite failed', error)
            })
          }
        },
        onResize: (cols, rows) => {
          if (!streamId) return
          const promise = runtime.actions.shellResize(streamId, cols, rows)
          if (promise && typeof promise.catch === 'function') promise.catch(() => {})
        },
        onScreenChange: () => setScreenVersion((value) => value + 1),
        onMode: (nextMode, reason) => {
          setMode(nextMode)
          setModeReason(reason)
        },
      })
      hostRef.current = host
      setMode(host.mode)
      setModeReason(host.modeReason)
      /**
       * Size the grid to the box the sidebar gave us — but only once it is safe.
       *
       * Two defects came from doing this eagerly. A zero-height container produced
       * `rows: 1` (a PTY nobody can use), and sizing before xterm's renderer existed threw
       * out of `Viewport.syncScrollArea` (`… reading 'dimensions'`), an uncaught error
       * that stays red in the console. So the decision is delegated to
       * `ssh.session.fit.planFit` (pure, unit-tested), the unsafe moments are retried on
       * the next frame, and any throw from the emulator is contained instead of bubbling.
       */
      let fitFrame = 0
      let fitAttempts = 0
      const fitToContainer = () => {
        const decision = fitModule.planFit({
          attached: container.isConnected !== false,
          width: container.clientWidth,
          height: container.clientHeight,
          rendererReady: fitModule.rendererReady(container, host),
          attempts: fitAttempts,
          maxAttempts: 3,
        })
        if (decision.action === 'wait') {
          fitAttempts += 1
          fitFrame = raf(fitToContainer)
          return false
        }
        if (decision.action !== 'fit') return false
        try {
          const measured = host.measure(container)
          if (!(measured.rows >= 2 && measured.cols >= 2)) return false
          host.setSize(measured.cols, measured.rows)
          return true
        } catch (error) {
          // One more frame, then stay quiet: a broken renderer must not throw into the page.
          if (fitAttempts < 3) {
            fitAttempts += 1
            fitFrame = raf(fitToContainer)
          } else {
            console.warn('[dsh-ssh] terminal fit skipped', error)
          }
          return false
        }
      }
      fitFrame = raf(fitToContainer)
      host.focus()

      // Collapsing the sidebar, switching tabs, revealing the panel and resizing the
      // window all change the box without remounting this component: without an observer
      // the emulator would keep its old grid and only part of the screen would be usable.
      let observer = null
      const ResizeObserverCtor = typeof globalThis.ResizeObserver === 'function' ? globalThis.ResizeObserver : null
      if (ResizeObserverCtor) {
        observer = new ResizeObserverCtor(() => {
          fitAttempts = 0
          fitFrame = raf(fitToContainer)
        })
        observer.observe(container)
      }

      return () => {
        if (fitFrame) cancelRaf(fitFrame)
        if (observer) observer.disconnect()
        hostRef.current = null
        cursorRef.current = -1
        host.dispose()
      }
      // A new stream means a new grid: the old buffer belongs to the old session.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [streamId])

    // ── font size ──
    useEffect(() => {
      const host = hostRef.current
      if (host) host.setFontSize(effectiveFontSize)
    }, [effectiveFontSize])

    const applyFontSize = useCallback(
      (next) => {
        const value = ui.clamp(next, ui.FONT_MIN, ui.FONT_MAX)
        ui.writeStoredFontSize(value)
        setFontSize(value)
        if (typeof onFontSizeChange === 'function') onFontSizeChange(value)
      },
      [onFontSizeChange, ui],
    )

    // ── stream → renderer ──
    useEffect(() => {
      const host = hostRef.current
      if (!host || !record) return
      let wrote = false
      for (const chunk of record.chunks) {
        const seq = typeof chunk.seq === 'number' ? chunk.seq : cursorRef.current + 1
        if (seq <= cursorRef.current) continue
        cursorRef.current = seq
        host.write(chunk)
        wrote = true
      }
      if (wrote && !focused && typeof onDirtyChange === 'function') onDirtyChange(true)
      if (record.exit && exitReportedRef.current !== record.streamId) {
        exitReportedRef.current = record.streamId
        if (typeof onExit === 'function') {
          onExit({
            exitCode: record.exit.exitCode,
            signal: record.exit.signal,
            durationMs: record.exit.durationMs,
            timedOut: record.exit.timedOut,
          })
        }
      }
    }, [record, record && record.version, onExit, onDirtyChange, focused])

    // Re-attaching to a stream that already has output must repaint it: switching
    // tabs is not a reason to lose the session's history.
    useEffect(() => {
      const host = hostRef.current
      if (!host || !record || record.chunks.length === 0) return
      if (cursorRef.current < 0) {
        for (const chunk of record.chunks) {
          cursorRef.current = typeof chunk.seq === 'number' ? chunk.seq : cursorRef.current + 1
          host.write(chunk)
        }
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode])

    // ── clipboard ──
    const handleCopy = useCallback(async () => {
      const host = hostRef.current
      const text = host ? host.getSelection() : ''
      const value = text !== '' ? text : runtime.streamText(streamId, 'term')
      const ok = await ui.copyText(value)
      flash(ok ? t('toast.copied') : t('toast.copiedFailed'))
    }, [flash, runtime, streamId, t, ui])

    const handlePaste = useCallback(async () => {
      let text = ''
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
          text = await navigator.clipboard.readText()
        }
      } catch {
        flash(t('toast.copiedFailed'))
        return
      }
      if (typeof text !== 'string' || text === '') return
      const host = hostRef.current
      if (host) host.paste(text)
      // The remote PTY echoes; writing locally as well would double the output.
      const promise = runtime.actions.shellWrite(streamId, text)
      if (promise && typeof promise.catch === 'function') promise.catch(() => {})
    }, [flash, runtime, streamId, t])

    const handleClear = useCallback(() => {
      const host = hostRef.current
      if (host) host.clear()
    }, [])

    const handleReconnect = useCallback(() => {
      if (typeof onReconnect === 'function') {
        onReconnect()
        return
      }
      const host = hostRef.current
      const size = host ? host.getSize() : { cols: 80, rows: 24 }
      const attempt = runtime.actions.reconnectShell({
        sessionId,
        streamId,
        cols: size.cols,
        rows: size.rows,
      })
      if (attempt && attempt.ready && typeof attempt.ready.then === 'function') {
        attempt.ready.then(
          () => flash(t('ws.term.reconnected')),
          () => flash(t('ws.term.disconnected')),
        )
      }
    }, [flash, onReconnect, runtime, sessionId, streamId, t])

    // ── keyboard shortcuts owned by the terminal tab (ICD §8.4) ──
    const handleKeyDown = useCallback(
      (event) => {
        const meta = event.ctrlKey === true || event.metaKey === true
        const key = typeof event.key === 'string' ? event.key : ''
        const host = hostRef.current
        if (meta && key.toLowerCase() === 'l') {
          event.preventDefault()
          handleClear()
          return
        }
        if (meta && (key === '=' || key === '+')) {
          event.preventDefault()
          applyFontSize(effectiveFontSize + 1)
          return
        }
        if (meta && (key === '-' || key === '_')) {
          event.preventDefault()
          applyFontSize(effectiveFontSize - 1)
          return
        }
        if (meta && key === '0') {
          event.preventDefault()
          applyFontSize(13)
          return
        }
        if (typeof onDirtyChange === 'function') onDirtyChange(false)
        // In fallback mode the emulator is not listening, so the tab encodes keys
        // itself; in xterm mode `onData` already owns them.
        if (host && host.mode !== 'xterm') host.sendKey(event)
      },
      [applyFontSize, effectiveFontSize, handleClear, onDirtyChange],
    )

    const status = (() => {
      if (!streamId) return { state: 'idle', label: t('ws.term.noStream') }
      if (!record) return { state: 'connecting', label: t('ws.term.connecting') }
      if (record.end) {
        if (record.end.reason === 'completed') return { state: 'connected', label: t('ws.term.exited') }
        if (record.end.reason === 'timeout') return { state: 'error', label: t('ws.term.ended') }
        if (record.end.reason === 'cancelled') return { state: 'idle', label: t('ws.term.disconnected') }
        return { state: 'error', label: t('ws.term.disconnected') }
      }
      if (record.status === 'error') return { state: 'error', label: t('ws.term.disconnected') }
      if (record.status === 'opening') return { state: 'connecting', label: t('ws.term.connecting') }
      return { state: 'connected', label: t('ws.term.live') }
    })()

    const header = h(
      'div',
      { className: 'ssh-ws-toolbar', 'data-testid': 'ssh-ws-term-toolbar' },
      h('span', { className: 'ssh-ws-dot', 'data-state': status.state }),
      h(
        'span',
        { className: 'ssh-ws-title' },
        session && session.host ? `${session.user ? `${session.user}@` : ''}${session.host}` : t('ws.tabs.terminal'),
      ),
      h('span', { className: 'ssh-ws-sub', 'data-testid': 'ssh-ws-term-status' }, status.label),
      notice ? h('span', { className: 'ssh-ws-copied', 'data-testid': 'ssh-ws-term-notice' }, notice) : null,
      h('span', { className: 'ssh-ws-spacer' }),
      h(IconButton, { name: 'eraser', title: t('ws.term.clear'), onClick: handleClear, dataTestId: 'ssh-ws-term-clear' }),
      h(IconButton, { name: 'copy', title: t('ws.term.copy'), onClick: handleCopy, dataTestId: 'ssh-ws-term-copy' }),
      h(IconButton, { name: 'alignLeft', title: t('ws.term.paste'), onClick: handlePaste, dataTestId: 'ssh-ws-term-paste' }),
      h(IconButton, {
        name: 'zoomOut',
        title: t('ws.term.fontDown'),
        onClick: () => applyFontSize(effectiveFontSize - 1),
        dataTestId: 'ssh-ws-term-font-down',
      }),
      h('span', { className: 'ssh-ws-sub', 'data-testid': 'ssh-ws-term-font' }, `${effectiveFontSize}px`),
      h(IconButton, {
        name: 'zoomIn',
        title: t('ws.term.fontUp'),
        onClick: () => applyFontSize(effectiveFontSize + 1),
        dataTestId: 'ssh-ws-term-font-up',
      }),
      h(IconButton, { name: 'plug', title: t('ws.term.reconnect'), onClick: handleReconnect, dataTestId: 'ssh-ws-term-reconnect' }),
      h(
        'span',
        { className: 'ssh-ws-hint', 'data-testid': 'ssh-ws-term-renderer', title: modeReason || '' },
        `${t('ws.term.renderer')}: ${mode}`,
      ),
    )

    if (!streamId) {
      return h(
        'div',
        { className: 'ssh-ws', 'data-testid': 'ssh-ws-terminal' },
        header,
        h(EmptyState, { title: t('ws.term.noStream'), hint: t('ws.term.noStreamHint'), dataTestId: 'ssh-ws-term-empty' }),
        runtime.isWired() ? null : h('div', { className: 'ssh-ws-hint', style: { padding: '0 10px 10px' } }, t('ws.term.notWired')),
      )
    }

    const showFallbackScreen = mode !== 'xterm'
    const host = hostRef.current
    const rendered = showFallbackScreen && host ? host.screen.runs() : []
    const cursor = host ? host.screen.cursor : null

    return h(
      'div',
      {
        className: 'ssh-ws',
        'data-testid': 'ssh-ws-terminal',
        'data-renderer': mode,
        // The screen re-renders on this counter; exposing it also makes a stalled
        // renderer visible in a DOM dump during diagnosis.
        'data-screen-version': screenVersion,
      },
      header,
      h(
        'div',
        {
          className: 'ssh-ws-term',
          style: { '--ssh-ws-term-font-size': `${effectiveFontSize}px` },
          tabIndex: 0,
          onKeyDown: handleKeyDown,
          onFocus: () => {
            setFocused(true)
            if (typeof onDirtyChange === 'function') onDirtyChange(false)
          },
          onBlur: () => setFocused(false),
          onClick: () => {
            const current = hostRef.current
            if (current) current.focus()
            setFocused(true)
            if (typeof onDirtyChange === 'function') onDirtyChange(false)
          },
        },
        h('div', { className: 'ssh-ws-term-host', ref: containerRef, 'data-testid': 'ssh-ws-term-host' }),
        showFallbackScreen
          ? h(
              'div',
              { className: 'ssh-ws-screen', 'data-testid': 'ssh-ws-term-screen' },
              rendered.map((line) =>
                h(
                  'div',
                  { className: 'ssh-ws-screen-row', key: `row-${line.row}`, 'data-row': line.row },
                  line.runs.length === 0
                    ? '\u00a0'
                    : line.runs.map((run, index) =>
                        h(
                          'span',
                          {
                            key: `run-${index}`,
                            className:
                              (run.attrs & 1 ? 'ssh-ws-screen-bold ' : '') +
                              (run.attrs & 2 ? 'ssh-ws-screen-dim ' : '') +
                              (run.attrs & 4 ? 'ssh-ws-screen-underline ' : '') +
                              (run.attrs & 8 ? 'ssh-ws-screen-reverse' : ''),
                          },
                          run.text,
                        ),
                      ),
                  cursor && cursor.visible && cursor.y === line.row
                    ? h('span', { className: 'ssh-ws-cursor', key: 'cursor', 'data-testid': 'ssh-ws-term-cursor' })
                    : null,
                ),
              ),
            )
          : null,
        record && record.error
          ? h(
              'div',
              { className: 'ssh-ws-hint', style: { padding: '4px 8px' } },
              `${record.error.code}: ${record.error.message} `,
              h(Button, { onClick: handleReconnect }, t('ws.term.reconnect')),
            )
          : null,
      ),
      mode === 'fallback' && modeReason && modeReason !== 'forced'
        ? h('div', { className: 'ssh-ws-hint', style: { padding: '2px 8px' } }, t('ws.term.xtermUnavailable'))
        : null,
    )
  }

  return { TerminalTab }
})
