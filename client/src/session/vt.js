/**
 * @module ssh.session.vt
 * @order 300
 *
 * A small VT/ANSI screen model.
 *
 * xterm.js is the terminal's renderer (client/src/vendor), but two things still
 * need a screen the workspace itself can read:
 *
 * 1. **A degraded renderer.** If the emulator cannot attach - a stripped-down
 *    webview, a headless render, a DOM without layout - the tab must still show the
 *    session instead of an empty box. `client/src/session/term.js` paints this
 *    model with plain DOM in that case, so the frozen props keep working
 *    (docs/DESIGN.md D4/R4).
 * 2. **Assertable output.** A screen model that can be read as text is what makes
 *    "streaming frames render" and "a full-screen app redraws in place" testable
 *    without depending on the emulator's private internals.
 *
 * Scope is deliberate: enough of ECMA-48 to render shells and full-screen curses
 * applications correctly (cursor addressing, erasing, scrolling regions, SGR runs,
 * the alternate screen), and nothing that only affects colour fidelity - colour
 * stays a `--dsw-*` token decision (ICD §8.6), so SGR colours are parsed and
 * intentionally dropped.
 */

SSH.define('ssh.session.vt', function (SSH) {
  /** Attribute bits kept per cell: colour is deliberately not one of them. */
  const BOLD = 1
  const DIM = 2
  const UNDERLINE = 4
  const REVERSE = 8

  function blankCell() {
    return { ch: ' ', attrs: 0 }
  }

  function blankLine(cols) {
    const line = new Array(cols)
    for (let index = 0; index < cols; index++) line[index] = { ch: ' ', attrs: 0 }
    return line
  }

  /**
   * Create a screen.
   * @param {{cols?: number, rows?: number, scrollback?: number}} options
   */
  function createScreen(options = {}) {
    let cols = Math.max(1, Number(options.cols) || 80)
    let rows = Math.max(1, Number(options.rows) || 24)
    const scrollbackLimit = Math.max(0, Number(options.scrollback) || 1000)

    let grid = []
    let scrollback = []
    let cursor = { x: 0, y: 0, visible: true }
    let saved = null
    let attrs = 0
    let wrap = true
    let pendingWrap = false
    let scrollTop = 0
    let scrollBottom = rows - 1
    let alt = false
    let altStash = null

    // Parser state; kept across chunks because a frame may split an escape.
    let state = 'ground'
    let csi = ''
    let oscEsc = false
    let dirty = 0

    resetGrid()

    function resetGrid() {
      grid = []
      for (let row = 0; row < rows; row++) grid.push(blankLine(cols))
    }

    function markDirty() {
      dirty += 1
    }

    // ── text projection ─────────────────────────────────────────────────────

    function lineText(line) {
      let text = ''
      for (const cell of line) text += cell.ch
      return text.replace(/\s+$/, '')
    }

    // ── cursor / scrolling ──────────────────────────────────────────────────

    function clampCursor() {
      cursor.x = Math.max(0, Math.min(cols - 1, cursor.x))
      cursor.y = Math.max(0, Math.min(rows - 1, cursor.y))
    }

    function scrollUp(count = 1, region = scrollTop !== 0 || scrollBottom !== rows - 1) {
      for (let step = 0; step < count; step++) {
        const leaving = grid[scrollTop]
        if (!region && !alt && scrollbackLimit > 0) {
          scrollback.push(lineText(leaving))
          if (scrollback.length > scrollbackLimit) scrollback = scrollback.slice(-scrollbackLimit)
        }
        for (let row = scrollTop; row < scrollBottom; row++) grid[row] = grid[row + 1]
        grid[scrollBottom] = blankLine(cols)
      }
      markDirty()
    }

    function scrollDown(count = 1) {
      for (let step = 0; step < count; step++) {
        for (let row = scrollBottom; row > scrollTop; row--) grid[row] = grid[row - 1]
        grid[scrollTop] = blankLine(cols)
      }
      markDirty()
    }

    function lineFeed() {
      pendingWrap = false
      if (cursor.y === scrollBottom) scrollUp(1)
      else if (cursor.y < rows - 1) cursor.y += 1
    }

    function reverseLineFeed() {
      pendingWrap = false
      if (cursor.y === scrollTop) scrollDown(1)
      else if (cursor.y > 0) cursor.y -= 1
    }

    // ── erasing ─────────────────────────────────────────────────────────────

    function eraseInLine(mode) {
      const line = grid[cursor.y]
      if (!line) return
      const from = mode === 1 || mode === 2 ? 0 : cursor.x
      const to = mode === 0 || mode === 2 ? cols - 1 : cursor.x
      for (let index = from; index <= to; index++) line[index] = blankCell()
      markDirty()
    }

    function eraseInDisplay(mode) {
      if (mode === 2) {
        resetGrid()
        markDirty()
        return
      }
      if (mode === 0) {
        eraseInLine(0)
        for (let row = cursor.y + 1; row < rows; row++) grid[row] = blankLine(cols)
      } else if (mode === 1) {
        eraseInLine(1)
        for (let row = 0; row < cursor.y; row++) grid[row] = blankLine(cols)
      }
      markDirty()
    }

    function eraseChars(count) {
      const line = grid[cursor.y]
      if (!line) return
      for (let index = cursor.x; index < Math.min(cols, cursor.x + count); index++) line[index] = blankCell()
      markDirty()
    }

    function insertChars(count) {
      const line = grid[cursor.y]
      if (!line) return
      for (let index = cols - 1; index >= cursor.x + count; index--) line[index] = line[index - count]
      for (let index = cursor.x; index < Math.min(cols, cursor.x + count); index++) line[index] = blankCell()
      markDirty()
    }

    function deleteChars(count) {
      const line = grid[cursor.y]
      if (!line) return
      for (let index = cursor.x; index < cols; index++) {
        line[index] = index + count < cols ? line[index + count] : blankCell()
      }
      markDirty()
    }

    function insertLines(count) {
      if (cursor.y < scrollTop || cursor.y > scrollBottom) return
      for (let step = 0; step < count; step++) {
        for (let row = scrollBottom; row > cursor.y; row--) grid[row] = grid[row - 1]
        grid[cursor.y] = blankLine(cols)
      }
      markDirty()
    }

    function deleteLines(count) {
      if (cursor.y < scrollTop || cursor.y > scrollBottom) return
      for (let step = 0; step < count; step++) {
        for (let row = cursor.y; row < scrollBottom; row++) grid[row] = grid[row + 1]
        grid[scrollBottom] = blankLine(cols)
      }
      markDirty()
    }

    // ── writing ─────────────────────────────────────────────────────────────

    function putChar(ch) {
      if (pendingWrap && wrap) {
        cursor.x = 0
        lineFeed()
      }
      const line = grid[cursor.y]
      if (!line) return
      line[cursor.x] = { ch, attrs }
      if (cursor.x >= cols - 1) {
        pendingWrap = true
      } else {
        cursor.x += 1
      }
      markDirty()
    }

    // ── SGR ─────────────────────────────────────────────────────────────────

    function applySgr(params) {
      const codes = params.length === 0 ? [0] : params
      for (let index = 0; index < codes.length; index++) {
        const code = codes[index] === null ? 0 : codes[index]
        if (code === 0) attrs = 0
        else if (code === 1) attrs |= BOLD
        else if (code === 2) attrs |= DIM
        else if (code === 4) attrs |= UNDERLINE
        else if (code === 7) attrs |= REVERSE
        else if (code === 22) attrs &= ~(BOLD | DIM)
        else if (code === 24) attrs &= ~UNDERLINE
        else if (code === 27) attrs &= ~REVERSE
        else if (code === 38 || code === 48) {
          // Extended colour: consume its parameters so their numbers are not read
          // as further attribute codes. The colour itself is dropped on purpose.
          const mode = codes[index + 1]
          if (mode === 5) index += 2
          else if (mode === 2) index += 4
        }
      }
    }

    // ── modes / CSI dispatch ────────────────────────────────────────────────

    function setMode(privateMode, value, params) {
      if (!privateMode) return
      const enabled = value === 'h'
      for (const param of params) {
        if (param === 7) wrap = enabled
        else if (param === 25) cursor.visible = enabled
        else if (param === 47 || param === 1047 || param === 1049) switchAltScreen(enabled)
        else if (param === 1048) {
          if (enabled) saveCursor()
          else restoreCursor()
        }
      }
    }

    function switchAltScreen(enabled) {
      if (enabled === alt) return
      if (enabled) {
        altStash = { grid, cursor: { ...cursor }, saved, scrollTop, scrollBottom }
        alt = true
        resetGrid()
        cursor = { x: 0, y: 0, visible: cursor.visible }
        scrollTop = 0
        scrollBottom = rows - 1
        pendingWrap = false
      } else {
        alt = false
        const stash = altStash
        altStash = null
        if (stash) {
          grid = stash.grid
          cursor = { ...stash.cursor }
          saved = stash.saved
          scrollTop = stash.scrollTop
          scrollBottom = stash.scrollBottom
        }
        pendingWrap = false
      }
      markDirty()
    }

    function saveCursor() {
      saved = { x: cursor.x, y: cursor.y, attrs }
    }

    function restoreCursor() {
      if (!saved) return
      cursor.x = saved.x
      cursor.y = saved.y
      attrs = saved.attrs
      clampCursor()
    }

    function dispatchCsi(final, raw) {
      const privateMarker = raw.startsWith('?') ? '?' : raw.startsWith('>') ? '>' : ''
      const body = privateMarker === '' ? raw : raw.slice(1)
      const params = body === '' ? [] : body.split(';').map((part) => (part === '' ? null : Number(part)))
      const arg = (index, fallback) => {
        const value = params[index]
        return value === null || value === undefined || Number.isNaN(value) ? fallback : value
      }

      if (privateMarker !== '' && (final === 'h' || final === 'l')) {
        setMode(true, final, params.map((value) => (value === null ? 0 : value)))
        return
      }

      switch (final) {
        case 'A':
          cursor.y = Math.max(scrollTop, cursor.y - Math.max(1, arg(0, 1)))
          pendingWrap = false
          break
        case 'B':
          cursor.y = Math.min(scrollBottom, cursor.y + Math.max(1, arg(0, 1)))
          pendingWrap = false
          break
        case 'C':
          cursor.x = Math.min(cols - 1, cursor.x + Math.max(1, arg(0, 1)))
          pendingWrap = false
          break
        case 'D':
          cursor.x = Math.max(0, cursor.x - Math.max(1, arg(0, 1)))
          pendingWrap = false
          break
        case 'E':
          cursor.x = 0
          for (let index = 0; index < Math.max(1, arg(0, 1)); index++) lineFeed()
          break
        case 'F':
          cursor.x = 0
          for (let index = 0; index < Math.max(1, arg(0, 1)); index++) reverseLineFeed()
          break
        case 'G':
          cursor.x = Math.max(0, Math.min(cols - 1, arg(0, 1) - 1))
          pendingWrap = false
          break
        case 'd':
          cursor.y = Math.max(0, Math.min(rows - 1, arg(0, 1) - 1))
          pendingWrap = false
          break
        case 'H':
        case 'f':
          cursor.y = Math.max(0, Math.min(rows - 1, arg(0, 1) - 1))
          cursor.x = Math.max(0, Math.min(cols - 1, arg(1, 1) - 1))
          pendingWrap = false
          break
        case 'J':
          eraseInDisplay(arg(0, 0))
          break
        case 'K':
          eraseInLine(arg(0, 0))
          break
        case 'X':
          eraseChars(Math.max(1, arg(0, 1)))
          break
        case 'L':
          insertLines(Math.max(1, arg(0, 1)))
          break
        case 'M':
          deleteLines(Math.max(1, arg(0, 1)))
          break
        case 'P':
          deleteChars(Math.max(1, arg(0, 1)))
          break
        case '@':
          insertChars(Math.max(1, arg(0, 1)))
          break
        case 'S':
          scrollUp(Math.max(1, arg(0, 1)))
          break
        case 'T':
          scrollDown(Math.max(1, arg(0, 1)))
          break
        case 'm':
          applySgr(params)
          break
        case 'r':
          scrollTop = Math.max(0, Math.min(rows - 1, arg(0, 1) - 1))
          scrollBottom = Math.max(scrollTop, Math.min(rows - 1, arg(1, rows) - 1))
          cursor.x = 0
          cursor.y = scrollTop
          pendingWrap = false
          break
        case 's':
          saveCursor()
          break
        case 'u':
          restoreCursor()
          break
        default:
          break
      }
    }

    // ── parser ──────────────────────────────────────────────────────────────

    function step(ch) {
      if (state === 'ground') {
        const code = ch.codePointAt(0)
        if (ch === '\x1b') state = 'esc'
        else if (ch === '\r') {
          cursor.x = 0
          pendingWrap = false
        } else if (ch === '\n') lineFeed()
        else if (ch === '\b') {
          cursor.x = Math.max(0, cursor.x - 1)
          pendingWrap = false
        } else if (ch === '\t') {
          cursor.x = Math.min(cols - 1, (Math.floor(cursor.x / 8) + 1) * 8)
          pendingWrap = false
        } else if (ch === '\x07' || ch === '\x00' || ch === '\x0e' || ch === '\x0f') {
          /* bell / NUL / shift-in / shift-out: nothing to render */
        } else if (code >= 0x20 && code !== 0x7f) putChar(ch)
        return
      }

      if (state === 'esc') {
        if (ch === '[') {
          state = 'csi'
          csi = ''
        } else if (ch === ']' || ch === 'P' || ch === '^' || ch === '_') {
          state = 'osc'
          oscEsc = false
        } else if (ch === '(' || ch === ')' || ch === '*' || ch === '+') {
          state = 'charset'
        } else if (ch === '7') {
          saveCursor()
          state = 'ground'
        } else if (ch === '8') {
          restoreCursor()
          state = 'ground'
        } else if (ch === 'D') {
          lineFeed()
          state = 'ground'
        } else if (ch === 'M') {
          reverseLineFeed()
          state = 'ground'
        } else if (ch === 'E') {
          cursor.x = 0
          lineFeed()
          state = 'ground'
        } else if (ch === 'c') {
          reset()
          state = 'ground'
        } else {
          state = 'ground'
        }
        return
      }

      if (state === 'charset') {
        state = 'ground'
        return
      }

      if (state === 'osc') {
        if (ch === '\x07') state = 'ground'
        else if (oscEsc && ch === '\\') state = 'ground'
        else oscEsc = ch === '\x1b'
        return
      }

      if (state === 'csi') {
        const code = ch.codePointAt(0)
        if (code >= 0x40 && code <= 0x7e) {
          dispatchCsi(ch, csi)
          state = 'ground'
          csi = ''
          return
        }
        if (csi.length < 64) csi += ch
      }
    }

    /** Feed one chunk of terminal output (may split an escape sequence). */
    function feed(text) {
      if (typeof text !== 'string' || text === '') return
      for (const ch of text) step(ch)
    }

    function reset() {
      attrs = 0
      saved = null
      scrollTop = 0
      scrollBottom = rows - 1
      cursor = { x: 0, y: 0, visible: true }
      pendingWrap = false
      alt = false
      altStash = null
      state = 'ground'
      csi = ''
      resetGrid()
      markDirty()
    }

    function resize(nextCols, nextRows) {
      const targetCols = Math.max(1, Math.floor(Number(nextCols) || cols))
      const targetRows = Math.max(1, Math.floor(Number(nextRows) || rows))
      if (targetCols === cols && targetRows === rows) return
      const next = []
      for (let row = 0; row < targetRows; row++) {
        const line = blankLine(targetCols)
        const previous = grid[row]
        if (previous) {
          for (let index = 0; index < Math.min(targetCols, previous.length); index++) line[index] = previous[index]
        }
        next.push(line)
      }
      cols = targetCols
      rows = targetRows
      grid = next
      scrollTop = 0
      scrollBottom = rows - 1
      clampCursor()
      markDirty()
    }

    // ── reading ─────────────────────────────────────────────────────────────

    /** Visible rows as right-trimmed strings. */
    function lines() {
      return grid.map((line) => lineText(line))
    }

    /** Everything the user could scroll back to; oldest first. */
    function history() {
      return scrollback.slice()
    }

    /**
     * Visible rows as attribute runs, ready to render without per-cell DOM.
     * Trailing blanks are dropped so a mostly empty screen produces few nodes.
     */
    function runs() {
      return grid.map((line, rowIndex) => {
        let end = cols - 1
        while (end >= 0 && line[end].ch === ' ' && line[end].attrs === 0) end -= 1
        const parts = []
        let current = null
        for (let index = 0; index <= end; index++) {
          const cell = line[index]
          if (current && current.attrs === cell.attrs) current.text += cell.ch
          else {
            current = { text: cell.ch, attrs: cell.attrs }
            parts.push(current)
          }
        }
        return { row: rowIndex, runs: parts }
      })
    }

    function lineCount() {
      return rows
    }

    return {
      feed,
      reset,
      resize,
      lines,
      history,
      runs,
      lineCount,
      clearScrollback() {
        scrollback = []
        markDirty()
      },
      /** Clear the visible screen, keeping the scrollback (a "clear" action). */
      clearScreen() {
        resetGrid()
        cursor = { x: 0, y: 0, visible: cursor.visible }
        pendingWrap = false
        markDirty()
      },
      get cols() {
        return cols
      },
      get rows() {
        return rows
      },
      get cursor() {
        return { ...cursor }
      },
      get altScreen() {
        return alt
      },
      get version() {
        return dirty
      },
      /** Scrollback plus screen, for export and for "select all" style actions. */
      allText() {
        return [...scrollback, ...lines()].join('\n').replace(/\n+$/, '')
      },
    }
  }

  return { createScreen, BOLD, DIM, UNDERLINE, REVERSE }
})
