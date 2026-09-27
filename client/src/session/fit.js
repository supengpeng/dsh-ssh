/**
 * @module ssh.session.fit
 * @order 320
 *
 * When may the terminal be measured and fitted?
 *
 * The answer used to be "always", and it produced two visible defects: a zero-height
 * container yielded `rows: 1` (a PTY nobody can use), and fitting before xterm's
 * renderer existed threw out of `Viewport.syncScrollArea`
 * (`Cannot read properties of undefined (reading 'dimensions')`) — an uncaught error
 * that stays red in the user's console.
 *
 * The decision is a pure function so it can be asserted directly; the caller owns the
 * animation-frame scheduling and the try/catch.
 */

SSH.define('ssh.session.fit', function (SSH) {
  /** Smallest grid worth telling a host about. */
  const MIN_COLS = 2
  const MIN_ROWS = 2

  /**
   * @param {object} input
   * @param {boolean} input.attached   the container is in the document (detached ⇒ h=0)
   * @param {number}  input.width      container width in px
   * @param {number}  input.height     container height in px
   * @param {boolean} input.rendererReady the emulator's renderer exists
   * @param {number}  [input.attempts]  frames already spent waiting
   * @param {number}  [input.maxAttempts]
   * @returns {{action: 'fit'|'wait'|'skip', reason: string}}
   *          `wait` retries on the next frame, `skip` gives up quietly.
   */
  function planFit(input) {
    const options = input || {}
    const attempts = Number.isFinite(options.attempts) ? options.attempts : 0
    const maxAttempts = Number.isFinite(options.maxAttempts) ? options.maxAttempts : 3

    if (options.attached === false) return { action: 'wait', reason: 'detached' }
    if (!(Number(options.width) > 0) || !(Number(options.height) > 0)) return { action: 'wait', reason: 'no-size' }
    if (options.rendererReady !== true) {
      // xterm creates its renderer during `open()`; resizing before that throws inside it.
      return attempts >= maxAttempts
        ? { action: 'skip', reason: 'renderer-never-ready' }
        : { action: 'wait', reason: 'renderer-not-ready' }
    }
    if (!(Number(options.cols) >= MIN_COLS) || !(Number(options.rows) >= MIN_ROWS)) {
      return { action: 'skip', reason: 'grid-too-small' }
    }
    return { action: 'fit', reason: 'ready' }
  }

  /**
   * Is the renderer mounted inside `container`?
   *
   * xterm's own DOM is the public signal: `.xterm-screen` only exists once the renderer
   * has been created. The built-in screen has no such node and is ready as soon as the
   * host reports it (it is plain DOM painted by React).
   */
  function rendererReady(container, host) {
    if (!host) return false
    if (host.mode === 'fallback') return true
    if (!container || typeof container.querySelector !== 'function') return false
    return container.querySelector('.xterm-screen') !== null
  }

  return { planFit, rendererReady, MIN_COLS, MIN_ROWS }
})
