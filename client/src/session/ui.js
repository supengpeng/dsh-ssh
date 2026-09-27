/**
 * @module ssh.session.ui
 * @order 210
 *
 * Shared surface for the four session components: primitive resolution, tiny
 * formatting helpers and the labels this tab owns.
 *
 * **Primitive resolution.** The ICD freezes the `SSH.ui.*` prop signatures and SP5
 * owns the real implementation. This module uses SP5's primitives when they are
 * present and falls back to a local implementation with *the same props* when they
 * are not, so the workspace renders correctly against either version of the UI
 * layer and a missing primitive can never blank the tab. Resolution happens on
 * every render, so a primitive that arrives later is picked up without a reload.
 *
 * **Labels.** DSH's locale service is owned by the plugin body; until the injected
 * translator is reachable this module falls back to a small dictionary covering
 * the `ws.*` keys the workspace needs. SP7's `locale/*.json` remains the source of
 * truth for key names - this is a display fallback, never a second contract.
 */

SSH.define('ssh.session.ui', function (SSH) {
  const { useState } = SSH.react
  const h = SSH.h

  // ── i18n fallback ─────────────────────────────────────────────────────────

  const DICT = {
    en: {
      'ws.tabs.terminal': 'Terminal',
      'ws.tabs.command': 'Command',
      'ws.tabs.files': 'Files',
      'ws.tabs.logs': 'Logs',
      'ws.term.clear': 'Clear',
      'ws.term.copy': 'Copy',
      'ws.term.paste': 'Paste',
      'ws.term.fontUp': 'Larger',
      'ws.term.fontDown': 'Smaller',
      'ws.term.reconnect': 'Reconnect',
      'ws.term.reconnected': 'Reconnected',
      'ws.term.disconnected': 'Disconnected',
      'ws.term.connecting': 'Connecting…',
      'ws.term.live': 'Live',
      'ws.term.exited': 'Exited',
      'ws.term.ended': 'Stream ended',
      'ws.term.noStream': 'No shell stream for this session yet',
      'ws.term.noStreamHint': 'Open a shell from the connection list to start typing.',
      'ws.term.renderer': 'renderer',
      'ws.term.xtermUnavailable': 'xterm.js could not attach; using the built-in screen.',
      'ws.term.notWired': 'The workspace is not wired to the host yet (ssh.session.runtime.configure).',
      'ws.cmd.placeholder': 'Command to run on the remote host…',
      'ws.cmd.run': 'Run',
      'ws.cmd.cancel': 'Cancel',
      'ws.cmd.clear': 'Clear output',
      'ws.cmd.exitCode': 'exit',
      'ws.cmd.stdout': 'stdout',
      'ws.cmd.stderr': 'stderr',
      'ws.cmd.duration': 'duration',
      'ws.cmd.history': 'History',
      'ws.cmd.empty': 'No output yet',
      'ws.cmd.running': 'Running…',
      'ws.cmd.truncated': 'output truncated (maxOutputBytes)',
      'ws.cmd.timedOut': 'timed out',
      'ws.files.local': 'Local',
      'ws.files.remote': 'Remote',
      'ws.files.upload': 'Upload',
      'ws.files.download': 'Download',
      'ws.files.mkdir': 'New folder',
      'ws.files.rename': 'Rename',
      'ws.files.delete': 'Delete',
      'ws.files.chmod': 'Permissions',
      'ws.files.refresh': 'Refresh',
      'ws.files.hidden': 'Hidden',
      'ws.files.overwrite': 'Overwrite',
      'ws.files.progress': 'Transfers',
      'ws.files.empty': 'This folder is empty',
      'ws.files.emptyLocal': 'No local listing available',
      'ws.files.emptyLocalHint': 'The host has no local-directory endpoint reachable yet.',
      'ws.files.loading': 'Loading…',
      'ws.files.up': 'Parent folder',
      'ws.files.selectFirst': 'Select a file first',
      'ws.files.cancel': 'Cancel transfer',
      'ws.files.name': 'Name',
      'ws.files.size': 'Size',
      'ws.files.mode': 'Mode',
      'ws.files.mtime': 'Modified',
      'ws.files.namePrompt': 'Name',
      'ws.files.chmodPrompt': 'Mode (octal, e.g. 0644)',
      'ws.files.dir': 'Folder',
      'ws.files.file': 'File',
      'ws.files.symlink': 'Link',
      'ws.logs.level': 'Level',
      'ws.logs.clear': 'Clear log',
      'ws.logs.export': 'Export',
      'ws.logs.refresh': 'Refresh',
      'ws.logs.empty': 'No audit entries',
      'ws.logs.emptyHint': 'Operations are recorded here as they happen.',
      'ws.logs.all': 'All',
      'ws.logs.search': 'Filter by operation…',
      'ws.logs.redacted': 'Secrets are redacted at the source',
      'ws.logs.target': 'Target',
      'ws.logs.duration': 'ms',
      'ws.logs.outcome.ok': 'ok',
      'ws.logs.outcome.denied': 'denied',
      'ws.logs.outcome.error': 'error',
      'confirm.danger.title': 'Confirm dangerous operation',
      'confirm.danger.body': 'This cannot be undone.',
      'confirm.danger.typeToConfirm': 'Type {name} to confirm',
      'confirm.ok': 'Confirm',
      'confirm.cancel': 'Cancel',
      'toast.copied': 'Copied',
      'toast.copiedFailed': 'Copy failed',
      'files.delete.title': 'Delete {name}?',
      'files.delete.body': 'The remote path {path} will be removed. This cannot be undone.',
      'files.delete.bodyDir': 'The folder {path} and everything inside it will be removed.',
      'files.rename.title': 'Rename {name}',
      'files.chmod.title': 'Change permissions of {name}',
      'files.mkdir.title': 'New folder in {path}',
      'files.overwrite.title': 'Overwrite {name}?',
      'files.overwrite.body': 'The destination already exists. Overwrite it?',
      'logs.clear.title': 'Clear the audit log?',
      'logs.clear.body': 'All recorded entries will be removed.',
    },
    zh: {
      'ws.tabs.terminal': '终端',
      'ws.tabs.command': '命令',
      'ws.tabs.files': '文件',
      'ws.tabs.logs': '日志',
      'ws.term.clear': '清屏',
      'ws.term.copy': '复制',
      'ws.term.paste': '粘贴',
      'ws.term.fontUp': '放大字号',
      'ws.term.fontDown': '缩小字号',
      'ws.term.reconnect': '重连',
      'ws.term.reconnected': '已重连',
      'ws.term.disconnected': '已断开',
      'ws.term.connecting': '连接中…',
      'ws.term.live': '在线',
      'ws.term.exited': '已退出',
      'ws.term.ended': '流已结束',
      'ws.term.noStream': '该会话还没有 shell 流',
      'ws.term.noStreamHint': '请先在连接列表中打开一个 shell。',
      'ws.term.renderer': '渲染器',
      'ws.term.xtermUnavailable': 'xterm.js 无法挂载，已切换到内置屏幕渲染。',
      'ws.term.notWired': '工作区尚未接到 host（缺少 ssh.session.runtime.configure）。',
      'ws.cmd.placeholder': '在远端主机执行的命令…',
      'ws.cmd.run': '执行',
      'ws.cmd.cancel': '取消',
      'ws.cmd.clear': '清空输出',
      'ws.cmd.exitCode': '退出码',
      'ws.cmd.stdout': '标准输出',
      'ws.cmd.stderr': '标准错误',
      'ws.cmd.duration': '耗时',
      'ws.cmd.history': '历史',
      'ws.cmd.empty': '暂无输出',
      'ws.cmd.running': '执行中…',
      'ws.cmd.truncated': '输出被截断（maxOutputBytes）',
      'ws.cmd.timedOut': '已超时',
      'ws.files.local': '本地',
      'ws.files.remote': '远端',
      'ws.files.upload': '上传',
      'ws.files.download': '下载',
      'ws.files.mkdir': '新建文件夹',
      'ws.files.rename': '重命名',
      'ws.files.delete': '删除',
      'ws.files.chmod': '权限',
      'ws.files.refresh': '刷新',
      'ws.files.hidden': '隐藏文件',
      'ws.files.overwrite': '覆盖',
      'ws.files.progress': '传输',
      'ws.files.empty': '此文件夹为空',
      'ws.files.emptyLocal': '本地目录列表不可用',
      'ws.files.emptyLocalHint': 'host 侧还没有可用的本地目录接口。',
      'ws.files.loading': '加载中…',
      'ws.files.up': '上级目录',
      'ws.files.selectFirst': '请先选择一个文件',
      'ws.files.cancel': '取消传输',
      'ws.files.name': '名称',
      'ws.files.size': '大小',
      'ws.files.mode': '权限',
      'ws.files.mtime': '修改时间',
      'ws.files.namePrompt': '名称',
      'ws.files.chmodPrompt': '权限（八进制，如 0644）',
      'ws.files.dir': '文件夹',
      'ws.files.file': '文件',
      'ws.files.symlink': '链接',
      'ws.logs.level': '级别',
      'ws.logs.clear': '清空日志',
      'ws.logs.export': '导出',
      'ws.logs.refresh': '刷新',
      'ws.logs.empty': '暂无审计记录',
      'ws.logs.emptyHint': '操作发生后会记录在这里。',
      'ws.logs.all': '全部',
      'ws.logs.search': '按操作筛选…',
      'ws.logs.redacted': '敏感信息已在源头脱敏',
      'ws.logs.target': '目标',
      'ws.logs.duration': '毫秒',
      'ws.logs.outcome.ok': '成功',
      'ws.logs.outcome.denied': '被拒',
      'ws.logs.outcome.error': '错误',
      'confirm.danger.title': '危险操作确认',
      'confirm.danger.body': '该操作无法撤销。',
      'confirm.danger.typeToConfirm': '请输入 {name} 以确认',
      'confirm.ok': '确认',
      'confirm.cancel': '取消',
      'toast.copied': '已复制',
      'toast.copiedFailed': '复制失败',
      'files.delete.title': '删除 {name}？',
      'files.delete.body': '将删除远端路径 {path}，此操作无法撤销。',
      'files.delete.bodyDir': '将删除目录 {path} 及其全部内容。',
      'files.rename.title': '重命名 {name}',
      'files.chmod.title': '修改 {name} 的权限',
      'files.mkdir.title': '在 {path} 中新建文件夹',
      'files.overwrite.title': '覆盖 {name}？',
      'files.overwrite.body': '目标已存在，是否覆盖？',
      'logs.clear.title': '清空审计日志？',
      'logs.clear.body': '所有已记录的条目都将被移除。',
    },
  }

  /** The injected translator, when the plugin body has published one. */
  function injectedTranslator() {
    const i18n = SSH.i18n
    if (typeof i18n === 'function') return i18n
    if (i18n && typeof i18n.t === 'function') return (key) => i18n.t(key)
    try {
      const mod = SSH.require('ssh.i18n')
      if (mod && typeof mod.t === 'function') return mod.t
    } catch {
      /* the i18n module is optional */
    }
    return null
  }

  function activeLocale() {
    try {
      if (typeof document !== 'undefined' && document.documentElement) {
        const lang = document.documentElement.getAttribute('lang')
        if (lang) return lang.toLowerCase().startsWith('zh') ? 'zh' : 'en'
      }
    } catch {
      /* a headless render has no documentElement language */
    }
    try {
      const nav = typeof navigator !== 'undefined' ? navigator : null
      if (nav && typeof nav.language === 'string') return nav.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
    } catch {
      /* ignore */
    }
    return 'en'
  }

  function substitute(text, params) {
    if (!params) return text
    return String(text).replace(/\{(\w+)\}/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
    )
  }

  /** Translate a key, preferring the injected translator over the local fallback. */
  function t(key, params) {
    const injected = injectedTranslator()
    if (injected) {
      try {
        const value = injected(key)
        if (typeof value === 'string' && value !== '' && value !== key) return substitute(value, params)
      } catch {
        /* fall through to the local dictionary */
      }
    }
    const locale = activeLocale()
    const dict = DICT[locale] ?? DICT.en
    const text = dict[key] ?? DICT.en[key] ?? key
    return substitute(text, params)
  }

  // ── formatting ────────────────────────────────────────────────────────────

  /** Human byte size; '—' for an unknown total. */
  function formatBytes(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—'
    if (value < 1024) return `${value} B`
    const units = ['KiB', 'MiB', 'GiB', 'TiB']
    let size = value / 1024
    let unit = 0
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024
      unit += 1
    }
    return `${size >= 100 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`
  }

  /** Transfer rate; '—' when there is no sample yet. */
  function formatSpeed(bytesPerSec) {
    if (typeof bytesPerSec !== 'number' || !Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '—'
    return `${formatBytes(bytesPerSec)}/s`
  }

  /** Compact duration: 240ms / 1m 05s / 2h 03m. */
  function formatDuration(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—'
    if (ms < 1000) return `${Math.round(ms)} ms`
    const totalSeconds = Math.round(ms / 1000)
    if (totalSeconds < 60) return `${totalSeconds} s`
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
    const hours = Math.floor(minutes / 60)
    return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
  }

  /** Remaining time estimate; '—' when unknown. */
  function formatEta(etaMs) {
    if (typeof etaMs !== 'number' || !Number.isFinite(etaMs) || etaMs <= 0) return '—'
    return formatDuration(etaMs)
  }

  /** Integer percentage, clamped; null when the total is unknown. */
  function percentOf(transferred, total) {
    if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return null
    const ratio = (Number(transferred) || 0) / total
    return Math.max(0, Math.min(100, Math.round(ratio * 100)))
  }

  function formatClock(iso) {
    if (typeof iso !== 'string' || iso === '') return '—'
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) return iso
    return date.toTimeString().slice(0, 8)
  }

  function formatDateTime(iso) {
    if (typeof iso !== 'string' || iso === '') return '—'
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) return iso
    const pad = (n) => String(n).padStart(2, '0')
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  function clamp(value, min, max) {
    const number = Number(value)
    if (!Number.isFinite(number)) return min
    return Math.max(min, Math.min(max, number))
  }

  /** Terminal font bounds; the ICD persists the choice under `dsh-ssh.termFontSize`. */
  const FONT_MIN = 8
  const FONT_MAX = 28
  const FONT_KEY = 'dsh-ssh.termFontSize'

  function readStoredFontSize() {
    try {
      const raw = window.localStorage.getItem(FONT_KEY)
      const value = Number(raw)
      return Number.isFinite(value) ? clamp(value, FONT_MIN, FONT_MAX) : null
    } catch {
      return null
    }
  }

  function writeStoredFontSize(size) {
    try {
      window.localStorage.setItem(FONT_KEY, String(size))
    } catch {
      /* private mode: the size simply does not survive a reload */
    }
  }

  // ── path helpers ──────────────────────────────────────────────────────────
  //
  // Panes show POSIX paths on the remote side and either flavour locally, so the
  // helpers accept both separators instead of assuming one platform.

  function splitPath(path) {
    const text = typeof path === 'string' && path !== '' ? path : '/'
    const separator = text.includes('\\') && !text.includes('/') ? '\\' : '/'
    const parts = text.split(/[\\/]+/).filter((part) => part !== '')
    return { separator, parts, absolute: /^[\\/]/.test(text) }
  }

  /** Trailing component of a path ('/' for the root). */
  function basename(path) {
    const { parts, separator } = splitPath(path)
    if (parts.length === 0) return separator
    return parts[parts.length - 1]
  }

  /** Everything above `path`; stays at the root when there is nothing above. */
  function parentPath(path) {
    const { separator, parts, absolute } = splitPath(path)
    if (parts.length <= 1) return separator === '\\' ? `${parts[0] ?? ''}\\` : '/'
    const head = parts.slice(0, -1).join(separator)
    const drive = /^[A-Za-z]:$/.test(parts[0])
    if (separator === '\\' && drive) return `${head}\\`
    return absolute ? `${separator}${head}` : head
  }

  /** Join a directory and a child name, keeping the directory's separator. */
  function joinPath(dir, name) {
    const { separator } = splitPath(dir)
    if (typeof dir !== 'string' || dir === '') return name
    if (typeof name !== 'string' || name === '') return dir
    const trimmed = dir.endsWith(separator) ? dir.slice(0, -separator.length) : dir
    return `${trimmed}${separator}${name}`
  }

  /** Breadcrumb segments of an absolute path, each with the path it points at. */
  function breadcrumbs(path) {
    const { separator, parts, absolute } = splitPath(path)
    const crumbs = []
    let current = absolute ? '' : ''
    if (absolute && parts.length > 0 && separator === '\\' && /^[A-Za-z]:$/.test(parts[0])) {
      crumbs.push({ label: parts[0], path: `${parts[0]}\\` })
      current = `${parts[0]}\\`
      for (const part of parts.slice(1)) {
        current = current.endsWith('\\') ? `${current}${part}` : `${current}\\${part}`
        crumbs.push({ label: part, path: current })
      }
      return crumbs
    }
    for (const part of parts) {
      current = current === '' ? (absolute ? `${separator}${part}` : part) : `${current}${separator}${part}`
      crumbs.push({ label: part, path: current })
    }
    if (crumbs.length === 0) crumbs.push({ label: separator, path: separator })
    return crumbs
  }

  // ── icons ─────────────────────────────────────────────────────────────────
  //
  // Monochrome, currentColor, and sized by the caller: the shipped panel icons
  // receive `{ size, active }` and must not assume 16px (docs/M0-SPIKE.md §4 C6).

  const ICONS = {
    terminal: ['M4 5.5h16v13H4z', 'M7.5 9.5 10 11.8l-2.5 2.3', 'M12 14.2h4.5'],
    command: ['M4 5.5h16v13H4z', 'M7.5 9.5 10 11.8l-2.5 2.3'],
    files: ['M3.5 6.5h5l1.8 2h9.2v10h-16z'],
    logs: ['M5 4.5h14v15H5z', 'M8 8.5h8', 'M8 12h8', 'M8 15.5h5'],
    folder: ['M3.5 6.5h5l1.8 2h9.2v10h-16z'],
    file: ['M6 3.5h8l4 4v13H6z', 'M14 3.5v4h4'],
    link: ['M10.5 13.5 13.5 10.5', 'M9 15l-1.5 1.5a2.6 2.6 0 0 1-3.7-3.7L6 10.6', 'M15 9l1.5-1.5a2.6 2.6 0 0 1 3.7 3.7L18 13.4'],
    upload: ['M12 16.5V6', 'M8 9.5 12 5.5l4 4', 'M5 18.5h14'],
    download: ['M12 5.5v10.5', 'M8 12.5l4 4 4-4', 'M5 18.5h14'],
    refresh: ['M19 12a7 7 0 1 1-2.2-5.1', 'M19 4.5V9h-4.5'],
    plus: ['M12 6v12', 'M6 12h12'],
    trash: ['M5.5 7.5h13', 'M9.5 7.5V5h5v2.5', 'M7 7.5 8 20h8l1-12.5'],
    pencil: ['M5 19h3l9.5-9.5-3-3L5 16z', 'M14 6.5l3 3'],
    key: ['M14.5 9.5a4 4 0 1 1-3.3 6.3L5 16.5v-3h2v-2h2.7', 'M15.5 8.5h.01'],
    copy: ['M9 9h11v11H9z', 'M15 6H4v11'],
    eraser: ['M8 17 4.8 13.8 13 5.6l3.2 3.2z', 'M8 17h11'],
    zoomIn: ['M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z', 'M16 16l4 4', 'M11 8.5v5', 'M8.5 11h5'],
    zoomOut: ['M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z', 'M16 16l4 4', 'M8.5 11h5'],
    plug: ['M9 4.5v5', 'M15 4.5v5', 'M6.5 9.5h11v2a5.5 5.5 0 0 1-11 0z', 'M12 17v3'],
    chevronUp: ['M7 14.5 12 9.5l5 5'],
    chevronRight: ['M10 7.5 14.5 12 10 16.5'],
    close: ['M6.5 6.5l11 11', 'M17.5 6.5l-11 11'],
    lock: ['M6.5 10.5h11v9h-11z', 'M9 10.5V8a3 3 0 0 1 6 0v2.5'],
    alignLeft: ['M4 6.5h16', 'M4 12h10', 'M4 17.5h13'],
  }

  function Icon(props) {
    const { name, size } = props || {}
    const paths = ICONS[name] ?? ICONS.file
    const dimension = typeof size === 'number' && size > 0 ? size : 14
    return h(
      'svg',
      {
        width: dimension,
        height: dimension,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
      paths.map((d, index) => h('path', { key: `p${index}`, d })),
    )
  }

  // ── primitives (fallbacks; SP5's implementation wins when present) ─────────

  function Button(props) {
    const { kind, size, disabled, loading, onClick, title, children, dataTestId } = props || {}
    return h(
      'button',
      {
        type: 'button',
        className: 'dsh-ssh-btn',
        'data-kind': kind || 'secondary',
        'data-size': size || 'sm',
        'data-testid': dataTestId,
        disabled: disabled === true || loading === true,
        title,
        onClick,
      },
      loading ? h(Spinner, { size: 10 }) : null,
      children,
    )
  }

  function IconButton(props) {
    const { name, title, onClick, disabled, active, size, dataTestId } = props || {}
    return h(
      'button',
      {
        type: 'button',
        className: 'dsh-ssh-btn',
        'data-kind': 'ghost',
        'data-testid': dataTestId,
        'data-active': active === true ? 'true' : undefined,
        title: title || name,
        'aria-label': title || name,
        disabled: disabled === true,
        onClick,
      },
      h(Icon, { name, size: size || 14 }),
    )
  }

  function Input(props) {
    const { value, onChange, placeholder, type, invalid, disabled, onEnter, autoFocus, dataTestId, onKeyDown, inputRef } = props || {}
    return h('input', {
      className: 'ssh-ws-cmd-field',
      'data-testid': dataTestId,
      'data-invalid': invalid === true ? 'true' : undefined,
      value: value === undefined || value === null ? '' : value,
      type: type || 'text',
      placeholder,
      disabled: disabled === true,
      autoFocus: autoFocus === true,
      spellCheck: false,
      ref: inputRef,
      onChange: (event) => {
        if (typeof onChange === 'function') onChange(event.target.value, event)
      },
      onKeyDown: (event) => {
        if (typeof onKeyDown === 'function') onKeyDown(event)
        if (event.key === 'Enter' && typeof onEnter === 'function') onEnter(event.target.value, event)
      },
    })
  }

  function Select(props) {
    const { value, options, onChange, disabled, dataTestId, title } = props || {}
    return h(
      'select',
      {
        className: 'ssh-ws-filter',
        'data-testid': dataTestId,
        title,
        value: value === undefined || value === null ? '' : value,
        disabled: disabled === true,
        onChange: (event) => {
          if (typeof onChange === 'function') onChange(event.target.value, event)
        },
      },
      (options || []).map((option) => h('option', { key: option.value, value: option.value }, option.label)),
    )
  }

  function Checkbox(props) {
    const { checked, onChange, label, disabled, dataTestId } = props || {}
    return h(
      'label',
      { className: 'ssh-ws-hint', style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
      h('input', {
        type: 'checkbox',
        'data-testid': dataTestId,
        checked: checked === true,
        disabled: disabled === true,
        onChange: (event) => {
          if (typeof onChange === 'function') onChange(event.target.checked, event)
        },
      }),
      label,
    )
  }

  function Field(props) {
    const { label, hint, error, required, children } = props || {}
    return h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
      label ? h('span', { className: 'ssh-ws-hint' }, `${label}${required ? ' *' : ''}`) : null,
      children,
      hint ? h('span', { className: 'ssh-ws-hint' }, hint) : null,
      error ? h('span', { className: 'ssh-ws-error' }, error) : null,
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

  /**
   * Progress bar. `value`/`total` are bytes; `status` drives the colour token.
   * `data-percent` carries the rendered percentage for tests and screenshots.
   */
  function Progress(props) {
    const { value, total, bytesPerSec, etaMs, indeterminate, status } = props || {}
    const percent = percentOf(value, total)
    const resolved = status || 'running'
    return h(
      'div',
      {
        className: 'ssh-ws-progress',
        'data-status': resolved,
        'data-percent': percent === null ? 'indeterminate' : String(percent),
        'data-indeterminate': indeterminate === true ? 'true' : 'false',
        role: 'progressbar',
        'aria-valuemin': 0,
        'aria-valuemax': percent === null ? undefined : 100,
        'aria-valuenow': percent === null ? undefined : percent,
        'aria-label': `${percent === null ? 'transfer in progress' : `${percent}%`}`,
        title: `${formatBytes(value)}${total ? ` / ${formatBytes(total)}` : ''}${
          bytesPerSec ? ` · ${formatSpeed(bytesPerSec)}` : ''
        }${etaMs ? ` · ETA ${formatEta(etaMs)}` : ''}`,
      },
      h('div', {
        className: 'ssh-ws-progress-fill',
        style: { width: percent === null ? '35%' : `${percent}%` },
      }),
    )
  }

  function EmptyState(props) {
    const { title, hint, action, dataTestId } = props || {}
    return h(
      'div',
      { className: 'ssh-ws-empty', 'data-testid': dataTestId },
      h('span', { className: 'ssh-ws-empty-title' }, title),
      hint ? h('span', { className: 'ssh-ws-hint' }, hint) : null,
      action || null,
    )
  }

  function Modal(props) {
    const { open, title, onClose, footer, width, children, danger, dataTestId } = props || {}
    if (open !== true) return null
    return h(
      'div',
      {
        className: 'ssh-ws-modal-layer',
        'data-testid': dataTestId,
        // shell.overlay is click-through; a modal that opts back in must not
        // swallow the click that dismisses it (docs/M0-SPIKE.md §4 C4).
        onClick: (event) => {
          if (event.target === event.currentTarget && typeof onClose === 'function') onClose(event)
        },
      },
      h(
        'div',
        {
          className: 'ssh-ws-modal',
          'data-danger': danger === true ? 'true' : 'false',
          style: width ? { width } : undefined,
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': title,
        },
        title ? h('div', { className: 'ssh-ws-modal-title' }, title) : null,
        h('div', { className: 'ssh-ws-modal-body' }, children),
        footer ? h('div', { className: 'ssh-ws-modal-foot' }, footer) : null,
      ),
    )
  }

  /**
   * Confirmation dialog for dangerous operations.
   *
   * `requireType` (ICD §8.3) makes the user type the target name: deleting a
   * directory is the case that needs it, since a mis-click there is unrecoverable.
   * The typed value lives in local state so the primitive stays a pure function.
   */
  function ConfirmDialog(props) {
    const { open, title, body, danger, confirmText, cancelText, onConfirm, onCancel, requireType, dataTestId } = props || {}
    const [typed, setTyped] = useState('')
    const needsType = typeof requireType === 'string' && requireType !== ''
    const satisfied = !needsType || typed === requireType
    if (open !== true) return null
    return h(
      Modal,
      {
        open: true,
        danger: danger === true,
        title: title || t('confirm.danger.title'),
        dataTestId: dataTestId || 'ssh-ws-confirm',
        onClose: () => {
          if (typeof onCancel === 'function') onCancel()
        },
        footer: [
          h(
            Button,
            {
              key: 'cancel',
              onClick: () => {
                if (typeof onCancel === 'function') onCancel()
              },
            },
            cancelText || t('confirm.cancel'),
          ),
          h(
            Button,
            {
              key: 'confirm',
              kind: danger === true ? 'danger' : 'primary',
              disabled: !satisfied,
              dataTestId: 'ssh-ws-confirm-ok',
              onClick: () => {
                if (typeof onConfirm === 'function') onConfirm()
              },
            },
            confirmText || t('confirm.ok'),
          ),
        ],
      },
      h('div', null, body || t('confirm.danger.body')),
      needsType
        ? h(
            'div',
            { style: { marginTop: 8 } },
            h('div', { className: 'ssh-ws-hint' }, t('confirm.danger.typeToConfirm', { name: requireType })),
            h(Input, {
              value: typed,
              onChange: setTyped,
              dataTestId: 'ssh-ws-confirm-type',
              placeholder: requireType,
            }),
          )
        : null,
    )
  }

  const FALLBACKS = {
    Button,
    IconButton,
    Input,
    Select,
    Checkbox,
    Field,
    Modal,
    ConfirmDialog,
    Progress,
    Spinner,
    EmptyState,
    Icon,
  }

  let cachedUi = null

  /** The primitive set to render with: SP5's when available, ours otherwise. */
  function ui() {
    if (cachedUi) return cachedUi
    let fromCore = {}
    try {
      const core = SSH.require('ssh.core')
      if (core && core.ui) fromCore = core.ui
    } catch {
      /* ssh.core is part of the same bundle; a failure here must not blank the tab */
    }
    const fromBundle = SSH.ui && typeof SSH.ui === 'object' ? SSH.ui : {}
    cachedUi = { ...FALLBACKS, ...fromCore, ...fromBundle }
    return cachedUi
  }

  /**
   * Clipboard write with the failure surfaced rather than swallowed: a copy button
   * that silently does nothing is worse than one that reports it could not copy.
   */
  async function copyText(text) {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(String(text ?? ''))
        return true
      }
    } catch {
      /* fall through: the environment may deny clipboard access */
    }
    try {
      if (typeof document !== 'undefined' && document.body) {
        const area = document.createElement('textarea')
        area.value = String(text ?? '')
        area.setAttribute('data-dsh-ssh-clipboard', '1')
        document.body.appendChild(area)
        if (typeof area.select === 'function') area.select()
        const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false
        if (area.parentNode) area.parentNode.removeChild(area)
        return ok === true
      }
    } catch {
      /* ignore */
    }
    return false
  }

  return {
    t,
    ui,
    Icon,
    copyText,
    FALLBACKS,
    DICT,
    formatBytes,
    formatSpeed,
    formatDuration,
    formatEta,
    formatClock,
    formatDateTime,
    percentOf,
    clamp,
    FONT_MIN,
    FONT_MAX,
    FONT_KEY,
    readStoredFontSize,
    writeStoredFontSize,
    splitPath,
    basename,
    parentPath,
    joinPath,
    breadcrumbs,
  }
})
