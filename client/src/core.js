/**
 * @module ssh.core
 * @order 10
 *
 * Foundation shared by every other client module: service access that cannot
 * throw, the stylesheet, small formatting helpers, and the first slice of the
 * UI primitive set the ICD freezes under `SSH.ui`.
 *
 * Nothing here may hardcode a colour: every value comes from a DSH theme token
 * so the panel follows light/dark without a second code path.
 */

SSH.define('ssh.core', function (SSH) {
  const { useState, useEffect, useRef, useSyncExternalStore } = SSH.react
  const h = SSH.h

  /** Read a client service without letting an absent one break the plugin. */
  function service(ctx, name) {
    try {
      if (!ctx || typeof ctx.get !== 'function') return undefined
      return ctx.get(name) ?? undefined
    } catch {
      return undefined
    }
  }

  /** Structural summary of a value, for spike diagnostics only. */
  function describeShape(value, depth) {
    const limit = typeof depth === 'number' ? depth : 1
    if (value === null) return 'null'
    if (value === undefined) return 'undefined'
    const type = typeof value
    if (type === 'function') return 'function'
    if (type !== 'object') return type
    if (Array.isArray(value)) return `array[${value.length}]`
    let prototype = null
    try {
      prototype = Object.getPrototypeOf(value)
    } catch {
      prototype = null
    }
    const name = prototype && prototype.constructor ? prototype.constructor.name : 'Object'
    if (limit <= 0) return name
    let keys = []
    try {
      keys = Object.keys(value).slice(0, 14)
    } catch {
      keys = []
    }
    if (keys.length === 0) return name
    return `${name}{${keys.join(',')}}`
  }

  const CSS = `
.dsh-ssh-root { display:flex; flex-direction:column; height:100%; min-height:0; color:var(--dsw-alias-label-primary);
  font:400 12px/1.5 var(--dsw-font-family, ui-sans-serif, system-ui, sans-serif); }
.dsh-ssh-head { display:flex; align-items:center; gap:8px; padding:8px 10px; border-bottom:1px solid var(--dsw-alias-border-l1); }
.dsh-ssh-title { font-weight:600; font-size:12px; letter-spacing:.02em; }
.dsh-ssh-body { flex:1 1 auto; min-height:0; overflow:auto; padding:10px; display:flex; flex-direction:column; gap:10px; }
.dsh-ssh-card { border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-layer-1);
  padding:10px; display:flex; flex-direction:column; gap:8px; }
.dsh-ssh-card[data-tone="error"] { border-color:var(--dsw-alias-state-error-primary); }
.dsh-ssh-card[data-tone="ok"] { border-color:var(--dsw-alias-state-success-primary); }
.dsh-ssh-card[data-tone="warn"] { border-color:var(--dsw-alias-state-warn-primary); }
.dsh-ssh-label { color:var(--dsw-alias-label-secondary); font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
.dsh-ssh-kv { display:grid; grid-template-columns:minmax(88px,auto) 1fr; gap:4px 10px; align-items:baseline; }
.dsh-ssh-kv > dt { color:var(--dsw-alias-label-secondary); font-size:11px; }
.dsh-ssh-kv > dd { margin:0; word-break:break-all; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:11px; }
.dsh-ssh-btn { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); border-radius:6px;
  padding:4px 10px; font-size:12px; cursor:pointer; }
.dsh-ssh-btn:hover:not(:disabled) { border-color:var(--dsw-alias-brand-primary); }
.dsh-ssh-btn:disabled { opacity:.55; cursor:default; }
.dsh-ssh-btn[data-kind="primary"] { background:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-bg-base); }
.dsh-ssh-row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.dsh-ssh-pill { display:inline-flex; align-items:center; gap:5px; border-radius:999px; padding:1px 8px; font-size:11px;
  border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2); }
.dsh-ssh-dot { width:7px; height:7px; border-radius:50%; background:var(--dsw-alias-state-idle-primary); flex:none; }
.dsh-ssh-dot[data-state="connected"] { background:var(--dsw-alias-state-success-primary); }
.dsh-ssh-dot[data-state="connecting"] { background:var(--dsw-alias-state-warn-primary); }
.dsh-ssh-dot[data-state="error"] { background:var(--dsw-alias-state-error-primary); }
.dsh-ssh-mono { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:11px;
  white-space:pre-wrap; word-break:break-all; background:var(--dsw-alias-bg-base); border:1px solid var(--dsw-alias-border-l1);
  border-radius:6px; padding:8px; max-height:220px; overflow:auto; }
.dsh-ssh-hint { color:var(--dsw-alias-label-secondary); font-size:11px; }
.dsh-ssh-float { position:fixed; right:16px; bottom:16px; width:380px; max-height:70vh; overflow:auto; z-index:2147483000;
  /* The shell.overlay layer is click-through by design: an occupant opts back into
     pointer events itself, so this must be set or the card's buttons are inert. */
  pointer-events:auto;
  border:1px solid var(--dsw-alias-border-l2); border-radius:10px; background:var(--dsw-alias-bg-overlay);
  /* Token-derived shadow (ICD v1.0.8): a literal black alpha is invisible on a dark
     background, so the card would lose its elevation cue in dark mode. 22% matches
     the confirm dialog's layer. */
  box-shadow:0 12px 32px color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent); display:flex; flex-direction:column; }
.dsh-ssh-float .dsh-ssh-head { background:var(--dsw-alias-bg-layer-2); border-top-left-radius:10px; border-top-right-radius:10px; }
/* The sidebar-foot entry point to the panel; token-only so it follows the theme. */
.dsh-ssh-footer-action { display:inline-flex; align-items:center; gap:6px; padding:6px 8px; border:0; border-radius:8px;
  background:transparent; color:var(--dsw-alias-label-primary); font:inherit; cursor:pointer; }
.dsh-ssh-footer-action:hover { background:var(--dsw-alias-bg-layer-2); }
.dsh-ssh-footer-action:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; }
`

  let disposeCss = null
  /** Install the stylesheet exactly once per client run. */
  function ensureStyles() {
    if (disposeCss) return
    disposeCss = SSH.style.insert(CSS)
  }

  /** Subscribe a component to a DSH client service that exposes subscribe(). */
  function useServiceSnapshot(source, fallback) {
    const subscribe = source && typeof source.subscribe === 'function' ? source.subscribe : null
    const getSnapshot = source && typeof source.getSnapshot === 'function'
      ? source.getSnapshot
      : () => fallback
    return useSyncExternalStore(
      subscribe ? (onChange) => subscribe.call(source, onChange) : () => () => {},
      getSnapshot,
      getSnapshot,
    )
  }

  // ── UI primitives (ICD §8.3). SP5 owns the complete set; these are the ones
  //    the M0 spike needs, and their props already match the frozen contract.
  function Button(props) {
    const { kind, size, disabled, loading, onClick, title, children, dataTestId } = props
    return h(
      'button',
      {
        type: 'button',
        className: 'dsh-ssh-btn',
        'data-kind': kind || 'secondary',
        'data-size': size || 'md',
        'data-testid': dataTestId,
        disabled: disabled === true || loading === true,
        title,
        onClick,
      },
      loading ? h(Spinner, { size: 10 }) : null,
      children,
    )
  }

  function Spinner(props) {
    const size = (props && props.size) || 12
    return h('span', {
      'aria-hidden': 'true',
      style: {
        width: size,
        height: size,
        display: 'inline-block',
        borderRadius: '50%',
        border: '1.5px solid var(--dsw-alias-border-l2)',
        borderTopColor: 'var(--dsw-alias-brand-primary)',
        animation: 'dsh-ssh-spin .7s linear infinite',
      },
    })
  }

  function Card(props) {
    return h('div', { className: 'dsh-ssh-card', 'data-tone': props.tone || 'neutral' }, props.children)
  }

  function Pill(props) {
    return h(
      'span',
      { className: 'dsh-ssh-pill', title: props.title },
      props.state ? h('span', { className: 'dsh-ssh-dot', 'data-state': props.state }) : null,
      props.children,
    )
  }

  function KV(props) {
    const rows = props.rows || []
    return h(
      'dl',
      { className: 'dsh-ssh-kv' },
      rows.flatMap((row, index) => [
        h('dt', { key: `k${index}` }, row[0]),
        h('dd', { key: `v${index}` }, row[1] === undefined || row[1] === null || row[1] === '' ? '—' : String(row[1])),
      ]),
    )
  }

  function Mono(props) {
    return h('pre', { className: 'dsh-ssh-mono', 'data-testid': props.dataTestId }, props.children)
  }

  /** Tiny local store factory matching the ICD's `createStore` contract. */
  function createStore(initial) {
    let state = initial
    const listeners = new Set()
    return {
      getState: () => state,
      setState(patch) {
        const next = typeof patch === 'function' ? patch(state) : patch
        state = { ...state, ...next }
        for (const listener of [...listeners]) listener()
      },
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      useStore(selector) {
        const read = () => (selector ? selector(state) : state)
        return useSyncExternalStore(
          (onChange) => {
            listeners.add(onChange)
            return () => listeners.delete(onChange)
          },
          read,
          read,
        )
      },
    }
  }

  function useInterval(callback, delayMs) {
    const saved = useRef(callback)
    useEffect(() => {
      saved.current = callback
    }, [callback])
    useEffect(() => {
      if (!delayMs || delayMs <= 0) return undefined
      const id = setInterval(() => saved.current(), delayMs)
      return () => clearInterval(id)
    }, [delayMs])
  }

  function useStateSafe(initial) {
    return useState(initial)
  }

  return {
    service,
    describeShape,
    ensureStyles,
    CSS,
    useServiceSnapshot,
    useInterval,
    useStateSafe,
    createStore,
    ui: { Button, Spinner, Card, Pill, KV, Mono },
  }
})
