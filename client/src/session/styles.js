/**
 * @module ssh.session.styles
 * @order 200
 *
 * Stylesheet for the session workspace (terminal / command / files / logs / agent
 * activity).
 *
 * Two rules shape every declaration here:
 *
 * 1. **No colour literals.** Every colour, border and surface comes from a
 *    `--dsw-*` token, so light and dark follow the host theme without a second
 *    code path (ICD §8.6). The stylesheet is inserted once per client run and
 *    removed with it.
 * 2. **Layout only, no invention.** The shipped right-sidebar tabs
 *    (`dsh-client-ui-sidebar-terminal`, `-files`) already define how a tab body
 *    looks inside this sidebar; this sheet reuses that idiom — a compact toolbar,
 *    a scrolling body, hairline separators — instead of introducing a new one
 *    (docs/M0-SPIKE.md §4 C5).
 */

SSH.define('ssh.session.styles', function (SSH) {
  const CSS = `
/* ── shell ─────────────────────────────────────────────────────────────── */
.ssh-ws { display:flex; flex-direction:column; height:100%; min-height:0; color:var(--dsw-alias-label-primary); }
.ssh-ws-toolbar { display:flex; align-items:center; gap:6px; flex-wrap:wrap; padding:6px 8px;
  border-bottom:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); }
.ssh-ws-toolbar[data-variant="inset"] { border-bottom:0; border-top:1px solid var(--dsw-alias-border-l1); }
.ssh-ws-spacer { flex:1 1 auto; }
.ssh-ws-title { font-weight:600; font-size:12px; }
.ssh-ws-sub { color:var(--dsw-alias-label-secondary); font-size:11px; }
.ssh-ws-mono { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.ssh-ws-body { flex:1 1 auto; min-height:0; display:flex; flex-direction:column; }
.ssh-ws-scroll { flex:1 1 auto; min-height:0; overflow:auto; }
.ssh-ws-hint { color:var(--dsw-alias-label-secondary); font-size:11px; }
.ssh-ws-error { color:var(--dsw-alias-state-error-primary); font-size:11px; }
.ssh-ws-empty { flex:1 1 auto; display:flex; flex-direction:column; align-items:center; justify-content:center;
  gap:6px; padding:18px; text-align:center; color:var(--dsw-alias-label-secondary); }
.ssh-ws-empty-title { color:var(--dsw-alias-label-primary); font-weight:600; font-size:12px; }
.ssh-ws-badge { display:inline-flex; align-items:center; gap:4px; border-radius:999px; padding:0 7px;
  border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2); font-size:11px; line-height:18px; }
.ssh-ws-badge[data-outcome="ok"] { border-color:var(--dsw-alias-state-success-primary); }
.ssh-ws-badge[data-outcome="denied"] { border-color:var(--dsw-alias-state-warn-primary); }
.ssh-ws-badge[data-outcome="error"] { border-color:var(--dsw-alias-state-error-primary); }
.ssh-ws-dot { width:7px; height:7px; border-radius:50%; flex:none; background:var(--dsw-alias-state-idle-primary); }
.ssh-ws-dot[data-state="connected"] { background:var(--dsw-alias-state-success-primary); }
.ssh-ws-dot[data-state="connecting"] { background:var(--dsw-alias-state-warn-primary); }
.ssh-ws-dot[data-state="error"] { background:var(--dsw-alias-state-error-primary); }

/* ── terminal ──────────────────────────────────────────────────────────── */
.ssh-ws-term { flex:1 1 auto; min-height:0; position:relative; background:var(--dsw-alias-bg-base);
  border-top:1px solid var(--dsw-alias-border-l1); }
.ssh-ws-term-host { position:absolute; inset:0; padding:4px 6px; overflow:hidden; }
.ssh-ws-term-host:focus, .ssh-ws-term-host:focus-within { outline:none; }
/* The emulator paints its own background; keep it on the token so a theme
   switch repaints the whole cell area instead of leaving a stale rectangle. */
.ssh-ws-term-host .xterm { height:100%; padding:0; }
.ssh-ws-term-host .xterm-viewport { background-color:transparent !important; scrollbar-width:thin; }
.ssh-ws-term-host .xterm-screen { background-color:transparent; }
.ssh-ws-screen { position:absolute; inset:0; margin:0; padding:4px 6px; overflow:auto;
  font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; line-height:1.25;
  white-space:pre; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-base);
  font-size:var(--ssh-ws-term-font-size, 13px); }
.ssh-ws-screen-row { min-height:1.25em; }
.ssh-ws-screen-bold { font-weight:700; }
.ssh-ws-screen-underline { text-decoration:underline; }
.ssh-ws-screen-reverse { background:var(--dsw-alias-label-primary); color:var(--dsw-alias-bg-base); }
.ssh-ws-screen-dim { color:var(--dsw-alias-label-secondary); }
.ssh-ws-cursor { display:inline-block; width:6px; height:1em; vertical-align:text-bottom;
  background:var(--dsw-alias-brand-primary); }
.ssh-ws-copied { color:var(--dsw-alias-state-success-primary); font-size:11px; }

/* ── command panel ─────────────────────────────────────────────────────── */
.ssh-ws-cmd-input { display:flex; align-items:center; gap:6px; border:1px solid var(--dsw-alias-border-l2);
  border-radius:6px; background:var(--dsw-alias-bg-layer-2); padding:2px 6px; }
.ssh-ws-cmd-input:focus-within { border-color:var(--dsw-alias-brand-primary); }
.ssh-ws-cmd-prompt { color:var(--dsw-alias-state-success-primary); font-size:12px; }
.ssh-ws-cmd-field { flex:1 1 auto; border:0; outline:none; background:transparent; color:inherit;
  font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:12px; padding:4px 0; }
.ssh-ws-cmd-field::placeholder { color:var(--dsw-alias-label-secondary); }
.ssh-ws-cmd-history { display:flex; flex-direction:column; gap:2px; max-height:96px; overflow:auto; }
.ssh-ws-cmd-history-item { text-align:left; border:0; background:transparent; color:var(--dsw-alias-label-secondary);
  font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:11px; padding:1px 4px;
  border-radius:4px; cursor:pointer; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ssh-ws-cmd-history-item:hover { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); }
.ssh-ws-cmd-pane { border:1px solid var(--dsw-alias-border-l1); border-radius:6px; background:var(--dsw-alias-bg-base); }
.ssh-ws-cmd-pane-head { display:flex; align-items:center; gap:6px; padding:3px 8px;
  border-bottom:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); font-size:11px; }
.ssh-ws-out { margin:0; padding:8px; max-height:220px; overflow:auto; font-size:11px; line-height:1.45;
  font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space:pre-wrap; word-break:break-word; }
.ssh-ws-out[data-channel="stderr"] { color:var(--dsw-alias-state-error-primary); }

/* ── file manager ──────────────────────────────────────────────────────── */
.ssh-ws-panes { flex:1 1 auto; min-height:0; display:grid; grid-template-columns:minmax(0,1fr) 6px minmax(0,1fr); }
.ssh-ws-divider { background:var(--dsw-alias-border-l1); }
.ssh-ws-pane { display:flex; flex-direction:column; min-width:0; min-height:0; background:var(--dsw-alias-bg-base);
  /* Query container for the row layout below: the two panes share the sidebar, so a
     pane is often under 210px and the row has to drop columns instead of squeezing
     the file name out of existence. */
  container-type:inline-size; }
.ssh-ws-pane[data-active="true"] { outline:1px solid var(--dsw-alias-brand-primary); outline-offset:-1px; }
.ssh-ws-pane-head { display:flex; align-items:center; gap:6px; padding:5px 8px;
  border-bottom:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); }
.ssh-ws-pane-label { font-size:11px; color:var(--dsw-alias-label-secondary); text-transform:uppercase; letter-spacing:.04em; }
.ssh-ws-crumbs { display:flex; align-items:center; gap:2px; flex-wrap:wrap; min-width:0; }
.ssh-ws-crumb { border:0; background:transparent; color:var(--dsw-alias-label-primary); cursor:pointer;
  font-size:11px; padding:0 2px; border-radius:4px; max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ssh-ws-crumb:hover { background:var(--dsw-alias-bg-layer-2); }
.ssh-ws-crumb[data-current="true"] { font-weight:600; }
.ssh-ws-crumb-sep { color:var(--dsw-alias-label-secondary); font-size:11px; }
/* Row = icon · name · size · mode · modified.
   The name track carries a hard minimum (minmax(80px,1fr), never minmax(0,1fr)):
   with a zero minimum the fixed meta columns (76+66+108px) plus the gaps consumed the
   whole row first, the name was squeezed to 0px and overflow:hidden made it vanish -
   sizes and dates stayed visible while every file name disappeared. */
.ssh-ws-head-row { display:grid; grid-template-columns:18px minmax(80px,1fr) 76px 66px 108px; gap:6px;
  padding:2px 8px; border-bottom:1px solid var(--dsw-alias-border-l1);
  color:var(--dsw-alias-label-secondary); font-size:10px; text-transform:uppercase; letter-spacing:.04em; }
.ssh-ws-entries { flex:1 1 auto; min-height:0; overflow:auto; }
.ssh-ws-entry { display:grid; grid-template-columns:18px minmax(80px,1fr) 76px 66px 108px; gap:6px;
  align-items:center; width:100%; text-align:left; border:0; background:transparent;
  color:var(--dsw-alias-label-primary); padding:3px 8px; font-size:11.5px; cursor:pointer; }

/* Narrow pane: keep the two columns that identify an entry (icon · name) and the size,
   and drop mode + modified in *both* the header and the rows, so the two grids keep the
   same tracks and the columns stay aligned. 380px is the width at which the five-column
   row stops fitting; below it the name would otherwise be the column that gives way. */
@container (max-width: 380px) {
  .ssh-ws-entry, .ssh-ws-head-row { grid-template-columns:18px minmax(64px,1fr) 72px; }
  .ssh-ws-entry > :nth-child(n+4), .ssh-ws-head-row > :nth-child(n+4) { display:none; }
}
.ssh-ws-entry:hover { background:var(--dsw-alias-bg-layer-2); }
.ssh-ws-entry[data-selected="true"] { background:var(--dsw-alias-bg-layer-2); box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary); }
/* The name is the one column that must always be readable, so it states its own
   colour (a label token, never a background token) and refuses to be squeezed away. */
.ssh-ws-entry-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  color:var(--dsw-alias-label-primary); }
.ssh-ws-entry[data-kind="dir"] .ssh-ws-entry-name { font-weight:600; }
.ssh-ws-entry[data-kind="symlink"] .ssh-ws-entry-name { font-style:italic; color:var(--dsw-alias-label-secondary); }
.ssh-ws-entry-meta { color:var(--dsw-alias-label-secondary); font-size:10.5px;
  font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ssh-ws-icon { display:inline-flex; align-items:center; justify-content:center; color:var(--dsw-alias-label-secondary); }
.ssh-ws-icon[data-kind="dir"] { color:var(--dsw-alias-brand-primary); }
.ssh-ws-transfers { border-top:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1);
  max-height:186px; overflow:auto; }
.ssh-ws-transfer { display:flex; flex-direction:column; gap:3px; padding:5px 8px; border-bottom:1px solid var(--dsw-alias-border-l1); }
.ssh-ws-transfer-head { display:flex; align-items:center; gap:6px; font-size:11px; }
.ssh-ws-transfer-path { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ssh-ws-progress { height:5px; border-radius:999px; background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l1); overflow:hidden; }
.ssh-ws-progress-fill { height:100%; background:var(--dsw-alias-brand-primary); transition:width .18s linear; }
.ssh-ws-progress[data-status="done"] .ssh-ws-progress-fill { background:var(--dsw-alias-state-success-primary); }
.ssh-ws-progress[data-status="error"] .ssh-ws-progress-fill { background:var(--dsw-alias-state-error-primary); }
.ssh-ws-progress[data-status="cancelled"] .ssh-ws-progress-fill { background:var(--dsw-alias-state-idle-primary); }
.ssh-ws-progress[data-indeterminate="true"] .ssh-ws-progress-fill { width:35%; }

/* ── logs ──────────────────────────────────────────────────────────────── */
.ssh-ws-filters { display:flex; align-items:center; gap:4px; flex-wrap:wrap; }
.ssh-ws-filter { border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-secondary); border-radius:999px; padding:1px 8px; font-size:11px; cursor:pointer; }
.ssh-ws-filter[data-active="true"] { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-label-primary); }
.ssh-ws-log-row { display:grid; grid-template-columns:78px 78px minmax(0,1fr) 62px 58px; gap:6px; align-items:baseline;
  padding:3px 8px; border-bottom:1px solid var(--dsw-alias-border-l1); cursor:pointer; }
.ssh-ws-log-row:hover { background:var(--dsw-alias-bg-layer-2); }
.ssh-ws-log-time, .ssh-ws-log-meta { color:var(--dsw-alias-label-secondary); font-size:10.5px;
  font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.ssh-ws-log-op { font-size:11.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ssh-ws-log-target { color:var(--dsw-alias-label-secondary); font-size:10.5px; overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; }
.ssh-ws-log-detail { margin:0 8px 6px; padding:6px 8px; border-radius:6px; background:var(--dsw-alias-bg-base);
  border:1px solid var(--dsw-alias-border-l1); font-size:10.5px; white-space:pre-wrap; word-break:break-word;
  font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.ssh-ws-lock { display:inline-flex; align-items:center; gap:4px; color:var(--dsw-alias-label-secondary); font-size:10.5px; }

/* ── modal (danger confirmation fallback) ──────────────────────────────── */
.ssh-ws-modal-layer { position:fixed; inset:0; z-index:2147482000; display:flex; align-items:center; justify-content:center;
  background:var(--dsw-alias-bg-overlay); pointer-events:auto; }
.ssh-ws-modal { width:min(420px, 92vw); border:1px solid var(--dsw-alias-border-l2); border-radius:10px;
  background:var(--dsw-alias-bg-layer-1); padding:12px; display:flex; flex-direction:column; gap:8px; }
.ssh-ws-modal[data-danger="true"] { border-color:var(--dsw-alias-state-error-primary); }
.ssh-ws-modal-title { font-weight:600; font-size:12px; }
.ssh-ws-modal-body { font-size:11.5px; color:var(--dsw-alias-label-secondary); white-space:pre-wrap; }
.ssh-ws-modal-foot { display:flex; justify-content:flex-end; gap:6px; }

/* ── agent activity mirror (ICD §4.7) ──────────────────────────────────── */
/* The pane is a transcript: one block per activity, newest last. Like the logs
   tab it is a scrolling body, so every block states its own height (flex:0 0 auto)
   instead of being shrunk by the flex column - otherwise a long transcript would
   be squeezed into the visible box rather than scrolled. */
.ssh-ws-activity { flex:1 1 auto; min-height:0; }
.ssh-ws-activity-switch { display:inline-flex; align-items:center; border:1px solid var(--dsw-alias-border-l2);
  border-radius:999px; overflow:hidden; background:var(--dsw-alias-bg-layer-2); }
.ssh-ws-activity-switch-btn { display:inline-flex; align-items:center; gap:5px; border:0; background:transparent;
  color:var(--dsw-alias-label-secondary); font:inherit; font-size:11.5px; line-height:20px; padding:2px 10px;
  cursor:pointer; white-space:nowrap; }
.ssh-ws-activity-switch-btn:hover { color:var(--dsw-alias-label-primary); }
.ssh-ws-activity-switch-btn[data-active="true"] { background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary); font-weight:600; }
.ssh-ws-activity-switch-btn:focus-visible { outline:1px solid var(--dsw-alias-brand-primary); outline-offset:-1px; }
.ssh-ws-activity-unread { display:inline-flex; align-items:center; justify-content:center; min-width:15px; height:15px;
  padding:0 4px; border-radius:999px; background:var(--dsw-alias-brand-primary); color:var(--dsw-alias-bg-base);
  font-size:10px; font-weight:600; }
.ssh-ws-activity-running { display:inline-flex; align-items:center; gap:4px; color:var(--dsw-alias-state-warn-primary);
  font-size:10.5px; }
.ssh-ws-activity-list { flex:1 1 auto; min-height:0; overflow:auto; }
.ssh-ws-activity-entry { flex:0 0 auto; display:flex; flex-direction:column; gap:3px; padding:5px 8px;
  border-bottom:1px solid var(--dsw-alias-border-l1); }
/* A running block is marked on its leading edge; the status badge states it in words. */
.ssh-ws-activity-entry[data-status="running"] { box-shadow:inset 2px 0 0 var(--dsw-alias-state-warn-primary); }
.ssh-ws-activity-entry[data-status="error"], .ssh-ws-activity-entry[data-status="timeout"],
.ssh-ws-activity-entry[data-status="refused"] { box-shadow:inset 2px 0 0 var(--dsw-alias-state-error-primary); }
.ssh-ws-activity-head { display:flex; align-items:baseline; gap:6px; flex-wrap:wrap; font-size:11px; }
.ssh-ws-activity-time { color:var(--dsw-alias-label-secondary); font-size:10.5px;
  font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.ssh-ws-activity-kind { border:1px solid var(--dsw-alias-border-l1); border-radius:4px; padding:0 4px;
  color:var(--dsw-alias-label-secondary); font-size:10px; text-transform:lowercase;
  font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.ssh-ws-activity-target { color:var(--dsw-alias-label-secondary); font-size:10.5px; min-width:0; max-width:100%;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.ssh-ws-activity-subject { color:var(--dsw-alias-label-primary); font-size:11.5px; white-space:pre-wrap;
  word-break:break-word; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.ssh-ws-activity-cwd { color:var(--dsw-alias-label-secondary); font-size:10px;
  font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap:anywhere; }
.ssh-ws-activity-segs { display:flex; flex-direction:column; gap:3px; flex:0 0 auto; }
.ssh-ws-activity-seg { margin:0; padding:4px 6px; border:1px solid var(--dsw-alias-border-l1); border-radius:4px;
  background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font-size:11px; line-height:1.45;
  font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space:pre-wrap; word-break:break-word;
  max-height:220px; overflow:auto; }
/* stderr is the one channel that must look different at a glance; info is narration. */
.ssh-ws-activity-seg[data-channel="stderr"] { color:var(--dsw-alias-state-error-primary); }
.ssh-ws-activity-seg[data-channel="info"] { color:var(--dsw-alias-label-secondary); }
.ssh-ws-activity-foot { display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; font-size:10.5px;
  color:var(--dsw-alias-label-secondary); font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.ssh-ws-activity-code { color:var(--dsw-alias-state-error-primary); }
.ssh-ws-activity-note { color:var(--dsw-alias-label-secondary); font-family:inherit; overflow-wrap:anywhere; }
.ssh-ws-activity-follow { display:inline-flex; align-items:center; color:var(--dsw-alias-label-secondary);
  font-size:10.5px; }
.ssh-ws-activity-follow[data-following="true"] { color:var(--dsw-alias-state-success-primary); }
/* The status badge colours the terminal states (the shared badge only knows ok/denied/error). */
.ssh-ws-badge[data-outcome="running"] { border-color:var(--dsw-alias-state-warn-primary); }
.ssh-ws-badge[data-outcome="timeout"], .ssh-ws-badge[data-outcome="refused"] {
  border-color:var(--dsw-alias-state-warn-primary); }
.ssh-ws-badge[data-outcome="cancelled"] { border-color:var(--dsw-alias-state-idle-primary); }
`

  let dispose = null
  /** Insert the sheet once per client run; a second call is a no-op. */
  function ensureStyles() {
    if (dispose) return dispose
    dispose = SSH.style.insert(CSS)
    return dispose
  }

  return { ensureStyles, CSS }
})
