/**
 * @module ssh.session.term
 * @order 330
 *
 * Terminal host: the adapter between a live stream and whatever can render it.
 *
 * Two implementations sit behind one interface, and the choice is made by trying,
 * not by configuration:
 *
 * - **xterm.js** (vendored, `ssh.vendor.xterm` + `ssh.vendor.fit`) is the real
 *   emulator: it owns the byte stream, ANSI parsing, selection and the keyboard.
 * - **A built-in screen** (`ssh.session.vt`) paints the same stream with plain DOM
 *   when the emulator cannot attach — no layout engine, a stripped webview, or a
 *   headless render. The props and behaviour stay identical, so the fallback is a
 *   renderer downgrade and never a feature loss for the caller
 *   (docs/DESIGN.md D4/R4).
 *
 * Theme is a token override, never a palette: the vendored emulator's own default
 * colours are replaced with the values of the DSH `--dsw-*` variables at mount, so
 * light and dark follow the host shell (ICD §8.6).
 */

SSH.define('ssh.session.term', function (SSH) {
  const FONT_STACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

  /** 'auto' tries xterm first; 'fallback' forces the built-in screen (tests). */
  let preference = 'auto'

  /** Test/maintenance seam: force a renderer without touching component props. */
  function configureHost(next) {
    if (next && typeof next.mode === 'string') preference = next.mode
    return preference
  }

  function hostPreference() {
    return preference
  }

  // ── vendored emulator loading ─────────────────────────────────────────────

  let vendorCache = null

  /** The vendored emulator, or null when it cannot be loaded at all. */
  function loadXterm() {
    if (vendorCache !== null) return vendorCache
    let Terminal = null
    let FitAddon = null
    try {
      const module = SSH.require('ssh.vendor.xterm')
      Terminal = module && (module.Terminal || module.default || module)
    } catch (error) {
      console.warn('[dsh-ssh] xterm.js could not be loaded from the bundle', error)
    }
    try {
      const module = SSH.require('ssh.vendor.fit')
      FitAddon = module && (module.FitAddon || module.default || module)
    } catch {
      /* the fit addon is optional: grid size can still be driven by props */
    }
    try {
      SSH.require('ssh.vendor.xterm.css').install()
    } catch {
      /* styling is cosmetic; the emulator still renders without it */
    }
    vendorCache = typeof Terminal === 'function' ? { Terminal, FitAddon: typeof FitAddon === 'function' ? FitAddon : null } : null
    return vendorCache
  }

  function xtermAvailable() {
    return loadXterm() !== null
  }

  // ── theme from tokens ─────────────────────────────────────────────────────

  /**
   * Read the DSH theme tokens for the emulator's own palette.
   *
   * This is the documented override point for the vendored default theme: nothing
   * here is a literal colour, and an unreadable token is simply not set, leaving
   * the emulator's built-in value in place.
   */
  function themeFromTokens(element) {
    const theme = {}
    try {
      const view = element && element.ownerDocument ? element.ownerDocument.defaultView : typeof window !== 'undefined' ? window : null
      const style = view && typeof view.getComputedStyle === 'function' ? view.getComputedStyle(element) : null
      if (!style) return undefined
      const read = (name) => {
        try {
          return String(style.getPropertyValue(name) || '').trim()
        } catch {
          return ''
        }
      }
      const background = read('--dsw-alias-bg-base')
      const foreground = read('--dsw-alias-label-primary')
      const brand = read('--dsw-alias-brand-primary')
      const error = read('--dsw-alias-state-error-primary')
      const warn = read('--dsw-alias-state-warn-primary')
      const success = read('--dsw-alias-state-success-primary')
      if (background) theme.background = background
      if (foreground) {
        theme.foreground = foreground
        theme.cursor = foreground
        theme.cursorAccent = background || undefined
      }
      if (brand) theme.selectionBackground = brand
      if (error) theme.red = error
      if (warn) theme.yellow = warn
      if (success) theme.green = success
    } catch {
      return undefined
    }
    return Object.keys(theme).length > 0 ? theme : undefined
  }

  // ── keyboard encoding (built-in screen mode) ──────────────────────────────

  /** Escape sequences a VT expects for the non-printable keys. */
  const KEY_SEQUENCES = {
    Enter: '\r',
    Backspace: '\x7f',
    Tab: '\t',
    Escape: '\x1b',
    ArrowUp: '\x1b[A',
    ArrowDown: '\x1b[B',
    ArrowRight: '\x1b[C',
    ArrowLeft: '\x1b[D',
    Home: '\x1b[H',
    End: '\x1b[F',
    PageUp: '\x1b[5~',
    PageDown: '\x1b[6~',
    Insert: '\x1b[2~',
    Delete: '\x1b[3~',
    F1: '\x1bOP',
    F2: '\x1bOQ',
    F3: '\x1bOR',
    F4: '\x1bOS',
    F5: '\x1b[15~',
    F6: '\x1b[17~',
    F7: '\x1b[18~',
    F8: '\x1b[19~',
    F9: '\x1b[20~',
    F10: '\x1b[21~',
    F11: '\x1b[23~',
    F12: '\x1b[24~',
  }

  /**
   * Encode a keydown into the bytes a PTY expects.
   *
   * Returns '' when the key carries no input (pure modifier, or a combination the
   * caller should handle itself, such as Ctrl/Cmd+L for clear).
   */
  function encodeKey(event, options) {
    const settings = options || {}
    if (!event || typeof event.key !== 'string') return ''
    const key = event.key
    const ctrl = event.ctrlKey === true || event.metaKey === true
    const alt = event.altKey === true

    // Ctrl/Cmd+L, Ctrl/Cmd+=/-/0 are workspace shortcuts and must not be typed
    // into the remote shell (ICD §8.4).
    if (settings.reserveShortcuts !== false && ctrl) {
      const reserved = ['l', '=', '+', '-', '_', '0']
      if (reserved.includes(key.toLowerCase())) return ''
    }

    if (KEY_SEQUENCES[key]) return alt ? `\x1b${KEY_SEQUENCES[key]}` : KEY_SEQUENCES[key]
    if (key === ' ') return ' '
    if (key.length === 1) {
      if (ctrl) {
        const code = key.toUpperCase().charCodeAt(0)
        if (code >= 64 && code < 128) return String.fromCharCode(code - 64)
        if (key === ' ') return '\x00'
        return ''
      }
      return alt ? `\x1b${key}` : key
    }
    return ''
  }

  // ── host factory ──────────────────────────────────────────────────────────

  /**
   * Attach a renderer to `container`.
   *
   * @param {object} options
   *   container, cols, rows, fontSize, allowProposedApi,
   *   onData(string), onResize(cols, rows), onScreenChange(), onMode(mode, reason)
   * @returns a host object; `mode` says which renderer won.
   */
  function createHost(options) {
    const settings = options || {}
    const container = settings.container || null
    let cols = Math.max(1, Number(settings.cols) || 80)
    let rows = Math.max(1, Number(settings.rows) || 24)
    let fontSize = Number(settings.fontSize) || 13
    let disposed = false

    const screen = SSH.require('ssh.session.vt').createScreen({ cols, rows, scrollback: 1000 })
    let term = null
    let fitAddon = null
    let mode = 'fallback'
    let modeReason = preference === 'fallback' ? 'forced' : null
    const cleanups = []

    function reportMode(reason) {
      modeReason = reason || modeReason
      if (typeof settings.onMode === 'function') settings.onMode(mode, modeReason)
    }

    const vendor = preference === 'fallback' ? null : loadXterm()
    if (preference !== 'fallback' && vendor && container) {
      try {
        term = new vendor.Terminal({
          cols,
          rows,
          fontSize,
          fontFamily: FONT_STACK,
          scrollback: 2000,
          cursorBlink: true,
          allowProposedApi: settings.allowProposedApi === true,
          theme: themeFromTokens(container),
        })
        if (vendor.FitAddon) {
          try {
            fitAddon = new vendor.FitAddon()
            term.loadAddon(fitAddon)
          } catch (error) {
            fitAddon = null
            console.warn('[dsh-ssh] fit addon unavailable', error)
          }
        }
        term.onData((data) => {
          if (typeof settings.onData === 'function') settings.onData(data)
        })
        term.onResize((size) => {
          if (!size) return
          cols = size.cols
          rows = size.rows
          if (typeof settings.onResize === 'function') settings.onResize(size.cols, size.rows)
        })
        term.open(container)
        mode = 'xterm'
        reportMode('xterm-attached')
      } catch (error) {
        // A renderer that failed half-way must not leave a broken instance behind.
        try {
          if (term && typeof term.dispose === 'function') term.dispose()
        } catch {
          /* ignore */
        }
        term = null
        fitAddon = null
        mode = 'fallback'
        reportMode(`xterm failed: ${error && error.message ? error.message : error}`)
      }
    } else if (preference !== 'fallback' && !vendor) {
      reportMode('vendor module unavailable')
    }

    function write(entry) {
      if (disposed) return
      const payload = entry || {}
      if (mode === 'xterm' && term) {
        try {
          // Bytes are passed through untouched when the host could not decode the
          // chunk as UTF-8 (ICD §4.4: encoding:'base64' fallback), so the emulator
          // sees exactly what the remote sent.
          if (payload.bytes && payload.bytes.length > 0) term.write(payload.bytes)
          else if (typeof payload.text === 'string' && payload.text !== '') term.write(payload.text)
          return
        } catch (error) {
          console.error('[dsh-ssh] terminal write failed', error)
          return
        }
      }
      if (typeof payload.text === 'string' && payload.text !== '') screen.feed(payload.text)
      else if (payload.bytes && payload.bytes.length > 0) screen.feed(decodeBytes(payload.bytes))
      if (typeof settings.onScreenChange === 'function') settings.onScreenChange()
    }

    /** UTF-8 projection of raw bytes for the built-in screen (latin1 as fallback). */
    function decodeBytes(bytes) {
      try {
        if (typeof TextDecoder === 'function') return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
      } catch {
        /* fall through */
      }
      let text = ''
      for (const byte of bytes) text += String.fromCharCode(byte)
      return text
    }

    function fit() {
      if (mode === 'xterm' && fitAddon) {
        try {
          fitAddon.fit()
          return { cols: term.cols, rows: term.rows }
        } catch (error) {
          console.warn('[dsh-ssh] fit failed', error)
        }
      }
      return { cols, rows }
    }

    /** Approximate grid for the built-in screen: the DOM has no cell metrics. */
    function measure(element) {
      if (!element) return { cols, rows }
      const width = Number(element.clientWidth) || 0
      const height = Number(element.clientHeight) || 0
      if (width <= 0 || height <= 0) return { cols, rows }
      const charWidth = Math.max(4, fontSize * 0.6)
      const lineHeight = Math.max(8, fontSize * 1.25)
      const nextCols = Math.max(20, Math.floor((width - 12) / charWidth))
      const nextRows = Math.max(4, Math.floor((height - 8) / lineHeight))
      return { cols: nextCols, rows: nextRows }
    }

    const host = {
      get mode() {
        return mode
      },
      get modeReason() {
        return modeReason
      },
      get term() {
        return term
      },
      screen,
      write,
      fit,
      measure,
      getSize: () => ({ cols, rows }),
      setSize(nextCols, nextRows) {
        cols = Math.max(1, Math.floor(Number(nextCols) || cols))
        rows = Math.max(1, Math.floor(Number(nextRows) || rows))
        if (mode === 'xterm' && term) {
          try {
            term.resize(cols, rows)
          } catch (error) {
            console.warn('[dsh-ssh] resize failed', error)
          }
        } else {
          screen.resize(cols, rows)
          if (typeof settings.onScreenChange === 'function') settings.onScreenChange()
          // xterm signals its own resize (the host listens for it); the built-in screen does
          // not, so without this the PTY never learns its grid under the degraded renderer —
          // full-screen applications would garble exactly when the fallback is what keeps
          // the terminal usable at all.
          if (typeof settings.onResize === 'function') settings.onResize(cols, rows)
        }
      },
      setFontSize(next) {
        fontSize = Number(next) || fontSize
        if (mode === 'xterm' && term) {
          try {
            term.options.fontSize = fontSize
            if (fitAddon) fitAddon.fit()
          } catch (error) {
            console.warn('[dsh-ssh] font resize failed', error)
          }
        }
        if (typeof settings.onScreenChange === 'function') settings.onScreenChange()
      },
      /** Re-read the theme tokens (light/dark switch) without recreating the grid. */
      refreshTheme() {
        if (mode === 'xterm' && term && container) {
          try {
            const theme = themeFromTokens(container)
            if (theme) term.options.theme = theme
          } catch {
            /* a theme refresh is best-effort */
          }
        }
      },
      /** Text the user could copy: the emulator's selection, or the whole screen. */
      getSelection() {
        if (mode === 'xterm' && term) {
          try {
            return term.getSelection() || ''
          } catch {
            return ''
          }
        }
        return screen.allText()
      },
      sendKey(event, options) {
        const data = encodeKey(event, options)
        if (data !== '' && typeof settings.onData === 'function') settings.onData(data)
        return data
      },
      paste(text) {
        if (typeof text !== 'string' || text === '') return
        if (typeof settings.onData === 'function') settings.onData(text)
      },
      clear() {
        if (mode === 'xterm' && term) {
          try {
            term.clear()
            return
          } catch {
            /* fall through to the screen model */
          }
        }
        screen.clearScreen()
        if (typeof settings.onScreenChange === 'function') settings.onScreenChange()
      },
      reset() {
        if (mode === 'xterm' && term) {
          try {
            term.reset()
            return
          } catch {
            /* fall through */
          }
        }
        screen.reset()
        if (typeof settings.onScreenChange === 'function') settings.onScreenChange()
      },
      focus() {
        if (mode === 'xterm' && term) {
          try {
            term.focus()
          } catch {
            /* focus is best-effort */
          }
        }
      },
      dispose() {
        if (disposed) return
        disposed = true
        for (const cleanup of cleanups) {
          try {
            cleanup()
          } catch {
            /* ignore */
          }
        }
        cleanups.length = 0
        if (term) {
          try {
            term.dispose()
          } catch (error) {
            console.warn('[dsh-ssh] terminal dispose failed', error)
          }
          term = null
        }
      },
      get disposed() {
        return disposed
      },
    }

    return host
  }

  return {
    createHost,
    configureHost,
    hostPreference,
    loadXterm,
    xtermAvailable,
    themeFromTokens,
    encodeKey,
    FONT_STACK,
    KEY_SEQUENCES,
  }
})
