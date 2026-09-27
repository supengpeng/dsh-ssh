/**
 * @module ssh.chrome.statusbar
 * @order 70
 *
 * Connection status bar (ICD §8.3 `StatusBar` props, §8.6 token-driven theme).
 *
 * The frozen `info` shape is what SP1/SP5 publish today, so this component is a pure
 * projection of it: connection identity, round-trip time, uptime, traffic counters and
 * the active transfer. All formatting lives in exported pure helpers, because
 * "how long has this been connected" is the part that silently drifts.
 */

SSH.define('ssh.chrome.statusbar', function (SSH) {
  const h = SSH.h
  const tabs = SSH.require('ssh.chrome.tabs')

  /** States that still hold a live connection; disconnecting them needs a confirmation. */
  const LIVE_STATES = tabs.LIVE_STATES

  function isLiveState(state) {
    return LIVE_STATES.includes(state)
  }

  function stateLabelKey(state) {
    return `conn.state.${typeof state === 'string' && state !== '' ? state : 'idle'}`
  }

  /** `1h 02m 03s` / `2m 05s` / `12s`; undefined for an unknown duration. */
  function formatDuration(ms) {
    const value = Number(ms)
    if (!Number.isFinite(value) || value < 0) return null
    const total = Math.floor(value / 1000)
    const hours = Math.floor(total / 3600)
    const minutes = Math.floor((total % 3600) / 60)
    const seconds = total % 60
    const pad = (part) => String(part).padStart(2, '0')
    if (hours > 0) return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`
    if (minutes > 0) return `${minutes}m ${pad(seconds)}s`
    return `${seconds}s`
  }

  /** `1.5 KiB`; binary units, one decimal below 10. */
  function formatBytes(bytes) {
    const value = Number(bytes)
    if (!Number.isFinite(value) || value < 0) return null
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
    let size = value
    let unit = 0
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024
      unit += 1
    }
    return `${unit === 0 ? Math.round(size) : size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`
  }

  function formatRate(bytesPerSec) {
    const formatted = formatBytes(bytesPerSec)
    return formatted === null ? null : `${formatted}/s`
  }

  /** Clamped whole percent, so a stalled transfer cannot render `NaN%`. */
  function formatPercent(percent) {
    const value = Number(percent)
    if (!Number.isFinite(value)) return null
    return `${Math.max(0, Math.min(100, Math.round(value)))}%`
  }

  function formatEta(ms) {
    const value = Number(ms)
    if (!Number.isFinite(value) || value < 0) return null
    const total = Math.round(value / 1000)
    const minutes = Math.floor(total / 60)
    const seconds = total % 60
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }

  /** Everything the bar renders, derived from the frozen `info` object. */
  function describeStatus(info, i18n) {
    const data = info || {}
    const state = typeof data.sessionState === 'string' && data.sessionState !== '' ? data.sessionState : 'idle'
    const connected = state === 'connected'
    const disconnected = state === 'closed' || state === 'error'
    const rtt = Number(data.rttMs)
    const duration = formatDuration(data.connectedFor)
    const bytesIn = formatBytes(data.bytesIn)
    const bytesOut = formatBytes(data.bytesOut)
    const transfer = data.transfer && data.transfer.active === true ? data.transfer : null
    const percent = transfer ? Number(transfer.percent) : null
    return {
      state,
      live: isLiveState(state),
      disconnected,
      stateText: i18n ? i18n.t(stateLabelKey(state)) : stateLabelKey(state),
      target: `${data.user || '—'}@${data.host || '—'}:${data.port === undefined || data.port === null ? '—' : data.port}`,
      rttText: Number.isFinite(rtt) && rtt >= 0 ? (i18n ? i18n.t('status.rtt', { ms: Math.round(rtt) }) : `${Math.round(rtt)} ms`) : null,
      uptimeText: connected && duration ? (i18n ? i18n.t('status.uptime', { duration }) : duration) : null,
      trafficText:
        bytesIn !== null || bytesOut !== null
          ? i18n
            ? i18n.t('status.traffic', { in: bytesIn || '—', out: bytesOut || '—' })
            : `${bytesOut || '—'} / ${bytesIn || '—'}`
          : null,
      transfer,
      percentText: transfer ? formatPercent(percent) : null,
      /** Bare number for locale strings that carry their own `%`. */
      percentNumber: transfer ? Math.round(percentClamp(percent)) : null,
      rateText: transfer ? formatRate(transfer.bytesPerSec) : null,
      etaText: transfer ? formatEta(transfer.etaMs) : null,
    }
  }

  /**
   * The frozen `StatusBar` props (ICD §8.3):
   * `{ info, onDisconnect, onReconnect, onToggleLog }`.
   *
   * Extra optional prop: `confirmDanger: false` skips the confirmation before
   * `onDisconnect` (the default routes a live session through `ssh.chrome.confirm`).
   */
  function StatusBar(props) {
    const { info, onDisconnect, onReconnect, onToggleLog } = props
    const i18n = SSH.require('ssh.i18n').getI18n()
    const view = describeStatus(info, i18n)

    /** Disconnecting is closing a live session: confirm first (ICD §12). */
    const requestDisconnect = () => {
      if (typeof onDisconnect !== 'function') return
      if (props.confirmDanger === false || !view.live) {
        onDisconnect()
        return
      }
      SSH.require('ssh.chrome.confirm')
        .danger('closeSession', { label: view.target, sessionId: info && info.sessionId }, { t: i18n.t })
        .then((confirmed) => {
          if (confirmed) onDisconnect()
        })
        .catch((error) => {
          console.error('[dsh-ssh] disconnect confirmation failed', error)
        })
    }

    return h(
      'div',
      { className: 'dsh-ssh-statusbar', 'data-testid': 'ssh-statusbar', role: 'status' },
      h(
        'span',
        { className: 'dsh-ssh-status-item' },
        h('span', { className: 'dsh-ssh-tab-state', 'data-state': tabs.normalizeState(view.state) }),
        h(
          'span',
          {
            className: 'dsh-ssh-status-state',
            'data-state': view.state,
            'data-testid': 'ssh-status-state',
            title: i18n.t('chrome.status.session'),
          },
          view.stateText,
        ),
      ),
      h('span', { className: 'dsh-ssh-status-item dsh-ssh-status-value', 'data-testid': 'ssh-status-target' }, view.target),
      view.rttText
        ? h('span', { className: 'dsh-ssh-status-item', 'data-testid': 'ssh-status-rtt' }, view.rttText)
        : null,
      view.uptimeText
        ? h('span', { className: 'dsh-ssh-status-item', 'data-testid': 'ssh-status-uptime' }, view.uptimeText)
        : null,
      view.trafficText
        ? h('span', { className: 'dsh-ssh-status-item', 'data-testid': 'ssh-status-traffic' }, view.trafficText)
        : null,
      h(
        'span',
        {
          className: 'dsh-ssh-status-item',
          'data-testid': 'ssh-status-transfer',
          // A title made of un-interpolated placeholders is worse than none, so the
          // tooltip is only built when there are real values to put in it.
          title: view.transfer
            ? i18n.t('chrome.status.transfer', {
                direction: directionText(i18n, view.transfer.direction),
                percent: view.percentNumber,
                rate: view.rateText,
                eta: view.etaText,
              })
            : i18n.t('chrome.status.transferIdle'),
        },
        view.transfer
          ? [
              h('span', { key: 'text' }, view.percentText),
              h(
                'span',
                { className: 'dsh-ssh-status-progress', key: 'bar' },
                h('span', { style: { width: `${percentClamp(view.transfer.percent)}%` } }),
              ),
              h('span', { key: 'rate' }, [view.rateText, view.etaText].filter(Boolean).join(' · ')),
            ]
          : i18n.t('chrome.status.transferIdle'),
      ),
      view.disconnected
        ? h('span', { className: 'dsh-ssh-status-item', 'data-testid': 'ssh-status-disconnected' }, i18n.t('status.disconnected'))
        : null,
      h(
        'div',
        { className: 'dsh-ssh-status-actions' },
        view.live && typeof onDisconnect === 'function'
          ? h(
              'button',
              {
                type: 'button',
                className: 'dsh-ssh-status-btn',
                'data-testid': 'ssh-status-disconnect',
                onClick: requestDisconnect,
              },
              i18n.t('conn.disconnect'),
            )
          : null,
        view.disconnected && typeof onReconnect === 'function'
          ? h(
              'button',
              {
                type: 'button',
                className: 'dsh-ssh-status-btn',
                'data-testid': 'ssh-status-reconnect',
                onClick: () => onReconnect(),
              },
              i18n.t('chrome.status.reconnect'),
            )
          : null,
        typeof onToggleLog === 'function'
          ? h(
              'button',
              {
                type: 'button',
                className: 'dsh-ssh-status-btn',
                'data-testid': 'ssh-status-toggle-log',
                onClick: () => onToggleLog(),
              },
              i18n.t('chrome.status.toggleLog'),
            )
          : null,
      ),
    )
  }

  function percentClamp(percent) {
    const value = Number(percent)
    if (!Number.isFinite(value)) return 0
    return Math.max(0, Math.min(100, value))
  }

  /** Localized direction word for the transfer tooltip. */
  function directionText(i18n, direction) {
    return i18n.t(direction === 'download' ? 'ws.files.download' : 'ws.files.upload')
  }

  return {
    StatusBar,
    LIVE_STATES,
    isLiveState,
    stateLabelKey,
    describeStatus,
    directionText,
    formatDuration,
    formatBytes,
    formatRate,
    formatPercent,
    formatEta,
  }
})
