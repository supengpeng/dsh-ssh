/**
 * @module ssh.session.logs
 * @order 460
 *
 * `LogTab` — the audit feed (ICD §8.3 props, frozen).
 *
 * The entries come from the host pre-redacted (§4.6), and this tab treats that as
 * a guarantee it must not undo: it re-runs a redaction pass of its own before
 * anything reaches the DOM, so a future host-side regression - or a caller passing
 * a raw object - cannot turn the log view into a credential leak. Values whose key
 * looks secret are replaced with a fixed eight-dot mask (the same shape §4.2 uses),
 * private-key blocks and URL credentials are excised from free text, and the detail
 * payload is only ever rendered as JSON built from the scrubbed copy.
 *
 * `levelFilter` is honoured as an initial/controlled value; when the owner also
 * passes `onLevelFilterChange` the filter becomes fully controlled.
 */

SSH.define('ssh.session.logs', function (SSH) {
  const { useState, useEffect, useCallback, useMemo } = SSH.react
  const h = SSH.h

  /** Fixed mask, independent of the real length (ICD §4.2). */
  const MASK = '••••••••'

  /**
   * Key names that must never render, however they are nested.
   *
   * This is the ICD §6 `logging.redactKeys` set, matched per *word* so that
   * `passphrase`, `private_key` and `apiKey` are all caught while `keyboardLayout`
   * is not. Over-redaction is the deliberate direction: the log view is where a
   * regression would be permanent, so an ambiguous name is masked.
   */
  const SECRET_WORDS = new Set([
    'password',
    'passphrase',
    'privatekey',
    'keydata',
    'secret',
    'token',
    'authorization',
    'credential',
    'apikey',
    'key',
  ])

  /** True when any word of a key name is a credential word. */
  function isSecretKey(key) {
    const words = String(key)
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[^A-Za-z0-9]+/)
      .map((word) => word.toLowerCase())
      .filter(Boolean)
    return words.some((word) => SECRET_WORDS.has(word))
  }

  /** Text-level scrubbing for values that are not keyed (URLs, PEM blocks). */
  function redactText(value) {
    let text = String(value)
    text = text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[redacted private key]')
    text = text.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/g, `$1$2:${MASK}@`)
    return text
  }

  /** Deep-scrub an audit entry; the input is never modified. */
  function redactEntry(entry, depth = 0) {
    if (entry === null || entry === undefined) return entry
    if (depth > 6) return '[depth limit]'
    if (typeof entry === 'string') return redactText(entry)
    if (typeof entry === 'number' || typeof entry === 'boolean') return entry
    if (Array.isArray(entry)) return entry.map((item) => redactEntry(item, depth + 1))
    if (typeof entry !== 'object') return String(entry)
    const out = {}
    for (const key of Object.keys(entry)) {
      const value = entry[key]
      if (isSecretKey(key)) {
        out[key] = value === undefined || value === null || value === '' ? value : MASK
        continue
      }
      out[key] = redactEntry(value, depth + 1)
    }
    return out
  }

  /** CSV cell quoting: commas, quotes and newlines all need care. */
  function csvCell(value) {
    const text = value === undefined || value === null ? '' : String(value)
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }

  /** Export an entry list as JSON or CSV text (redacted first). */
  function exportEntries(entries, format) {
    const safe = (entries || []).map((entry) => redactEntry(entry))
    if (format === 'csv') {
      const header = ['at', 'op', 'sessionId', 'profileId', 'outcome', 'durationMs', 'host', 'port', 'user', 'detail']
      const rows = safe.map((entry) =>
        [
          entry.at,
          entry.op,
          entry.sessionId,
          entry.profileId,
          entry.outcome,
          entry.durationMs,
          entry.target ? entry.target.host : '',
          entry.target ? entry.target.port : '',
          entry.target ? entry.target.user : '',
          entry.detail === undefined ? '' : JSON.stringify(entry.detail),
        ]
          .map(csvCell)
          .join(','),
      )
      return [header.join(','), ...rows].join('\n')
    }
    return JSON.stringify(safe, null, 2)
  }

  function LogTab(props) {
    const settings = props || {}
    const { sessionId, onClear, onRefresh, onExport } = settings

    const ui = SSH.require('ssh.session.ui')
    const runtime = SSH.require('ssh.session.runtime')
    const primitives = ui.ui()
    const t = ui.t

    const [internalLevel, setInternalLevel] = useState(settings.levelFilter || 'all')
    const [query, setQuery] = useState('')
    const [expanded, setExpanded] = useState(null)
    const [confirming, setConfirming] = useState(false)
    const [notice, setNotice] = useState(null)

    const live = runtime.useAudit()
    const controlled = typeof settings.levelFilter === 'string'
    const level = controlled ? settings.levelFilter : internalLevel

    useEffect(() => {
      SSH.require('ssh.session.styles').ensureStyles()
    }, [])

    useEffect(() => {
      if (!notice) return undefined
      const timer = setTimeout(() => setNotice(null), 1800)
      return () => clearTimeout(timer)
    }, [notice])

    const entries = Array.isArray(settings.entries) ? settings.entries : live.audit.entries
    const loading = settings.loading === true || (settings.entries === undefined && live.audit.loading === true)

    // Only this session's entries, unless the caller already scoped them.
    const scoped = useMemo(() => {
      const list = entries.filter((entry) => entry && typeof entry === 'object')
      if (!sessionId || Array.isArray(settings.entries)) return list
      return list.filter((entry) => !entry.sessionId || entry.sessionId === sessionId)
    }, [entries, sessionId, settings.entries])

    const redacted = useMemo(() => scoped.map((entry) => ({ source: entry, safe: redactEntry(entry) })), [scoped])

    const filtered = useMemo(() => {
      const needle = query.trim().toLowerCase()
      return redacted.filter(({ safe }) => {
        if (level && level !== 'all' && safe.outcome !== level) return false
        if (needle === '') return true
        const haystack = `${safe.op || ''} ${safe.target ? `${safe.target.host || ''} ${safe.target.user || ''}` : ''}`.toLowerCase()
        return haystack.includes(needle)
      })
    }, [level, query, redacted])

    const counts = useMemo(() => {
      const result = { all: redacted.length, ok: 0, denied: 0, error: 0 }
      for (const { safe } of redacted) {
        if (safe.outcome === 'ok') result.ok += 1
        else if (safe.outcome === 'denied') result.denied += 1
        else if (safe.outcome === 'error') result.error += 1
      }
      return result
    }, [redacted])

    const setLevel = useCallback(
      (next) => {
        setInternalLevel(next)
        if (typeof settings.onLevelFilterChange === 'function') settings.onLevelFilterChange(next)
      },
      [settings],
    )

    const handleExport = useCallback(
      (format) => {
        const text = exportEntries(
          filtered.map(({ safe }) => safe),
          format,
        )
        if (typeof onExport === 'function') onExport(text, format, filtered.map(({ safe }) => safe))
        else ui.copyText(text).then((ok) => setNotice(ok ? t('toast.copied') : t('toast.copiedFailed')))
      },
      [filtered, onExport, t, ui],
    )

    const dialogComponent = useMemo(() => {
      try {
        const chrome = SSH.require('ssh.chrome.confirm')
        const candidate = chrome && (chrome.ConfirmDialog || chrome.Confirm)
        if (typeof candidate === 'function') return candidate
      } catch {
        /* the chrome module is optional */
      }
      return primitives.ConfirmDialog
    }, [primitives])

    return h(
      'div',
      { className: 'ssh-ws', 'data-testid': 'ssh-ws-logs' },
      h(
        'div',
        { className: 'ssh-ws-toolbar' },
        h('span', { className: 'ssh-ws-title' }, t('ws.tabs.logs')),
        h('span', { className: 'ssh-ws-sub' }, sessionId || '—'),
        h('span', { className: 'ssh-ws-spacer' }),
        h('span', { className: 'ssh-ws-lock', 'data-testid': 'ssh-ws-logs-redacted' }, h(primitives.Icon, { name: 'lock', size: 12 }), t('ws.logs.redacted')),
        h(primitives.Button, { onClick: () => (typeof onRefresh === 'function' ? onRefresh(sessionId) : runtime.actions.refreshAudit({ sessionId })), dataTestId: 'ssh-ws-logs-refresh' }, t('ws.logs.refresh')),
        h(primitives.Button, { onClick: () => handleExport('json'), disabled: filtered.length === 0, dataTestId: 'ssh-ws-logs-export-json' }, `${t('ws.logs.export')} JSON`),
        h(primitives.Button, { onClick: () => handleExport('csv'), disabled: filtered.length === 0, dataTestId: 'ssh-ws-logs-export-csv' }, `${t('ws.logs.export')} CSV`),
        h(primitives.Button, { kind: 'danger', onClick: () => setConfirming(true), disabled: redacted.length === 0, dataTestId: 'ssh-ws-logs-clear' }, t('ws.logs.clear')),
        notice ? h('span', { className: 'ssh-ws-copied', 'data-testid': 'ssh-ws-logs-notice' }, notice) : null,
      ),

      h(
        'div',
        { className: 'ssh-ws-toolbar', 'data-variant': 'inset' },
        h(
          'div',
          { className: 'ssh-ws-filters', 'data-testid': 'ssh-ws-logs-filters' },
          ['all', 'ok', 'denied', 'error'].map((key) =>
            h(
              'button',
              {
                key,
                type: 'button',
                className: 'ssh-ws-filter',
                'data-active': level === key ? 'true' : 'false',
                'data-testid': `ssh-ws-logs-filter-${key}`,
                onClick: () => setLevel(key),
              },
              `${key === 'all' ? t('ws.logs.all') : t(`ws.logs.outcome.${key}`)} ${counts[key] ?? 0}`,
            ),
          ),
        ),
        h('span', { className: 'ssh-ws-spacer' }),
        h(primitives.Input, {
          value: query,
          onChange: setQuery,
          placeholder: t('ws.logs.search'),
          dataTestId: 'ssh-ws-logs-search',
        }),
      ),

      h(
        'div',
        { className: 'ssh-ws-body ssh-ws-scroll', 'data-testid': 'ssh-ws-logs-list' },
        loading ? h('div', { className: 'ssh-ws-hint', style: { padding: 10 } }, t('ws.files.loading')) : null,
        !loading && filtered.length === 0
          ? h(primitives.EmptyState, { title: t('ws.logs.empty'), hint: t('ws.logs.emptyHint'), dataTestId: 'ssh-ws-logs-empty' })
          : null,
        filtered.map(({ source, safe }, index) => {
          const key = `${safe.at || index}-${safe.op || ''}-${index}`
          const open = expanded === key
          return h(
            'div',
            { key },
            h(
              'div',
              {
                className: 'ssh-ws-log-row',
                'data-testid': `ssh-ws-log-${index}`,
                'data-outcome': safe.outcome || 'ok',
                onClick: () => setExpanded(open ? null : key),
              },
              h('span', { className: 'ssh-ws-log-time' }, ui.formatClock(safe.at)),
              h('span', { className: 'ssh-ws-badge', 'data-outcome': safe.outcome || 'ok' }, t(`ws.logs.outcome.${safe.outcome || 'ok'}`)),
              h('span', { className: 'ssh-ws-log-op', title: safe.op }, safe.op || '—'),
              h('span', { className: 'ssh-ws-log-meta' }, safe.durationMs === undefined ? '—' : `${Math.round(safe.durationMs)} ${t('ws.logs.duration')}`),
              h(
                'span',
                { className: 'ssh-ws-log-target' },
                safe.target ? `${safe.target.user ? `${safe.target.user}@` : ''}${safe.target.host || ''}${safe.target.port ? `:${safe.target.port}` : ''}` : '',
              ),
            ),
            open ? h('pre', { className: 'ssh-ws-log-detail', 'data-testid': `ssh-ws-log-detail-${index}` }, JSON.stringify(safe, null, 2)) : null,
          )
        }),
      ),

      h(dialogComponent, {
        open: confirming,
        danger: true,
        title: t('logs.clear.title'),
        body: t('logs.clear.body'),
        confirmText: t('ws.logs.clear'),
        cancelText: t('confirm.cancel'),
        dataTestId: 'ssh-ws-logs-confirm-clear',
        onCancel: () => setConfirming(false),
        onConfirm: () => {
          setConfirming(false)
          if (typeof onClear === 'function') onClear()
          else runtime.actions.clearAudit()
        },
      }),
    )
  }

  return { LogTab, redactEntry, redactText, exportEntries, isSecretKey, MASK }
})
