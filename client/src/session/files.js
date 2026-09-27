/**
 * @module ssh.session.files
 * @order 440
 *
 * `FileManager` — dual-pane local/remote SFTP browser (ICD §8.3 props, frozen).
 *
 * The shipped `dsh-client-ui-sidebar-files` tab browses the *local* workspace; this
 * one exists for the other side of the wire, so the pane pair (local on the left,
 * remote on the right) and the direction of every transfer are always visible
 * instead of implied (docs/M0-SPIKE.md §4 C5).
 *
 * Data resolution is deliberately forgiving. The frozen props carry the two roots
 * and the operation callbacks; if the container also passes `localEntries` /
 * `remoteEntries` those win, and otherwise the pane reads the session runtime's
 * directory cache, which loads through `listDir` / `listLocalDir`. A pane that
 * cannot load says why rather than rendering as an empty folder.
 *
 * Every destructive operation goes through a confirmation dialog before a callback
 * fires: delete and overwrite are always asked about, a non-empty directory
 * additionally requires typing its name (ICD §8.3 `requireType`).
 */

SSH.define('ssh.session.files', function (SSH) {
  const { useState, useEffect, useCallback, useMemo, useRef } = SSH.react
  const h = SSH.h

  /**
   * Bundle identity of this module.
   *
   * Printed when the file tab mounts, so the build actually loaded is a fact rather
   * than an assumption. The sequence names the fix in each build: `.5` bounded a
   * request that never answers, `.6` makes sure a request is issued at all, `.7`
   * wired navigation and upload, `.8` keeps the file name on screen.
   */
  const BUILD_MARKER = 'ssh-files-2026-09-27.8-entry-name-visible'

  /** Sort a directory listing without mutating the input. */
  function sortEntries(entries, sort) {
    const list = Array.isArray(entries) ? entries.slice() : []
    const key = (sort && sort.key) || 'name'
    const direction = sort && sort.direction === 'desc' ? -1 : 1
    return list.sort((a, b) => {
      // Directories lead in every mode: it is the order a file manager is read in.
      const aDir = a && a.type === 'dir' ? 0 : 1
      const bDir = b && b.type === 'dir' ? 0 : 1
      if (aDir !== bDir) return aDir - bDir
      let left
      let right
      if (key === 'size') {
        left = Number(a.size) || 0
        right = Number(b.size) || 0
      } else if (key === 'mtime') {
        left = a.mtime || ''
        right = b.mtime || ''
      } else if (key === 'mode') {
        left = a.mode || ''
        right = b.mode || ''
      } else {
        left = String(a.name || '').toLowerCase()
        right = String(b.name || '').toLowerCase()
      }
      if (left < right) return -1 * direction
      if (left > right) return 1 * direction
      return 0
    })
  }

  /** True when a listing already contains a child of that name. */
  function hasChild(entries, name) {
    return (Array.isArray(entries) ? entries : []).some((entry) => entry && entry.name === name)
  }

  /** Octal mode check for the chmod dialog; '' means "not obviously invalid". */
  function modeError(mode) {
    if (typeof mode !== 'string' || mode.trim() === '') return 'required'
    return /^[0-7]{3,4}$/.test(mode.trim()) ? '' : 'octal'
  }

  function kindOf(entry) {
    if (!entry) return 'file'
    if (entry.type === 'dir') return 'dir'
    if (entry.type === 'symlink' || entry.isSymlink === true) return 'symlink'
    return 'file'
  }

  function iconFor(kind) {
    if (kind === 'dir') return 'folder'
    if (kind === 'symlink') return 'link'
    return 'file'
  }

  /**
   * How long a pane may stay in `loading` before it is declared timed out.
   *
   * A directory request is a unary host call, but nothing on the way back is
   * bounded: the carrier can accept the call and never answer (no session, a
   * dropped link, a host that resolved the method to a no-op). Without a local
   * deadline the pane renders `Loading…` forever and offers no way out, which is
   * precisely the failure this guard removes. Injectable per instance through
   * `props.timeoutMs` so a test never has to wait the production value out.
   */
  const DEFAULT_LOAD_TIMEOUT_MS = 8000

  /**
   * Bootstrap roots, used when the frozen props omit a pane's root.
   *
   * The real GUI mounts this component as `FileManager({ sessionId })` - with no
   * `localRoot`/`remoteRoot` - and neither pane can list anything without a path:
   * `runtime.actions.listLocalDir` returns early on a falsy path, and the host's
   * `listDir` requires one. A missing root therefore has to be filled in, not
   * treated as "nothing to load":
   *
   *  - local: `.` - the host resolves it against its configured local root (or its
   *    process cwd) and answers with the *absolute* directory, which the pane then
   *    shows and navigates from. Until that answer lands only one breadcrumb
   *    exists, so the "parent" control stays disabled and no request can escape
   *    the configured root.
   *  - remote: the session's profile `defaultCwd`, else `/` - both absolute, and
   *    `/` is listable on every server, so the pane starts somewhere real instead
   *    of nowhere.
   */
  const LOCAL_ROOT_BOOTSTRAP = '.'
  const REMOTE_ROOT_BOOTSTRAP = '/'

  /** A usable, non-empty root: the explicit prop wins, the bootstrap is the floor. */
  function paneRoot(explicit, fallback) {
    return typeof explicit === 'string' && explicit.trim() !== '' ? explicit : fallback
  }

  /**
   * Drop a trailing separator, keeping filesystem roots intact.
   *
   * Required because a trailing separator is not cosmetic here: `ui.parentPath`
   * appends one to every drive-rooted path it returns, and a path that already ends
   * in a separator is its own parent - so "up" re-requests the same directory
   * forever, which is how a local pane came to look like it could not change
   * directory. Normalising also keeps one directory to one cache key, so the same
   * folder can never be stored twice under `C:\x` and `C:\x\`.
   */
  function normalizeDirPath(path) {
    if (typeof path !== 'string' || path === '') return path
    if (/^[\\/]+$/.test(path)) return path // POSIX root, and UNC-style '\\'
    if (/^[A-Za-z]:[\\/]*$/.test(path)) return path // 'C:\' is its own parent
    return path.replace(/[\\/]+$/, '')
  }

  /**
   * The profile's `defaultCwd` for a session, when the store knows both.
   *
   * Read-only and total: the profile list may not have loaded yet, a session may
   * come from an inline (profile-less) connection, and a half-built store is not an
   * error here - every one of those cases degrades to the caller's fallback.
   */
  function sessionDefaultCwd(app, sessionId) {
    try {
      const state = app && app.store && typeof app.store.getState === 'function' ? app.store.getState() : null
      if (!state || !sessionId) return null
      const sessions = (state.sessions && state.sessions.items) || []
      const session = sessions.find((item) => item && item.id === sessionId)
      const profileId = session && session.profileId
      if (!profileId) return null
      const profiles = (state.profiles && state.profiles.items) || []
      const profile = profiles.find((item) => item && item.id === profileId)
      const cwd = profile && profile.defaultCwd
      return typeof cwd === 'string' && cwd.trim() !== '' ? cwd.trim() : null
    } catch {
      return null
    }
  }

  /**
   * Arm the deadline for one pane while it is loading.
   *
   * The timer is keyed on the *derived* loading state rather than on the request
   * itself, so every route into `loading` is covered: a request issued by this
   * pane, a record left mid-flight by an earlier mount, or a container that
   * started the load. `attempt` re-arms the deadline when a newer load replaces
   * an in-flight one, so a retry gets its own full interval instead of inheriting
   * the remainder of the previous request's.
   */
  function useLoadWatchdog(scope, loading, attempt, timeoutMs, expire) {
    useEffect(() => {
      if (loading !== true) return undefined
      const timer = setTimeout(() => expire(scope), timeoutMs)
      return () => clearTimeout(timer)
    }, [scope, loading, attempt, timeoutMs, expire])
  }

  function FilePane(props) {
    const {
      pane,
      title,
      root,
      entries,
      loading,
      error,
      selected,
      active,
      hidden,
      sort,
      t,
      ui,
      primitives,
      uploadReason,
      unwired,
      onActivate,
      onEntryClick,
      onEntryActivate,
      onNavigate,
      onRefresh,
      onRetry,
      onToggleHidden,
      onSort,
      onCreateFolder,
      onUpload,
      onDownload,
    } = props

    const crumbs = ui.breadcrumbs(root)
    const sorted = useMemo(() => sortEntries(entries, sort), [entries, sort])
    const visible = hidden ? sorted : sorted.filter((entry) => entry && !String(entry.name || '').startsWith('.'))

    return h(
      'div',
      {
        className: 'ssh-ws-pane',
        'data-active': active === true ? 'true' : 'false',
        'data-pane': pane,
        'data-testid': `ssh-ws-pane-${pane}`,
        onMouseDown: () => (typeof onActivate === 'function' ? onActivate(pane) : undefined),
      },
      h(
        'div',
        { className: 'ssh-ws-pane-head' },
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: '1 1 auto' } },
          h('span', { className: 'ssh-ws-pane-label' }, title),
          h(
            'div',
            { className: 'ssh-ws-crumbs', 'data-testid': `ssh-ws-crumbs-${pane}` },
            crumbs.map((crumb, crumbIndex) => [
              crumbIndex > 0 ? h('span', { className: 'ssh-ws-crumb-sep', key: `sep-${crumbIndex}` }, '/') : null,
              h(
                'button',
                {
                  key: `crumb-${crumbIndex}`,
                  type: 'button',
                  className: 'ssh-ws-crumb',
                  'data-current': crumbIndex === crumbs.length - 1 ? 'true' : 'false',
                  title: crumb.path,
                  onClick: () => (typeof onNavigate === 'function' ? onNavigate(pane, crumb.path, 'crumb') : undefined),
                },
                crumb.label,
              ),
            ]),
          ),
        ),
        h(primitives.IconButton, {
          name: 'chevronUp',
          title: t('ws.files.up'),
          dataTestId: `ssh-ws-up-${pane}`,
          disabled: crumbs.length <= 1,
          onClick: () => (typeof onNavigate === 'function' ? onNavigate(pane, ui.parentPath(root), 'up') : undefined),
        }),
        h(primitives.IconButton, {
          name: 'refresh',
          title: t('ws.files.refresh'),
          dataTestId: `ssh-ws-refresh-${pane}`,
          onClick: () => (typeof onRefresh === 'function' ? onRefresh(pane, root) : undefined),
        }),
        h(primitives.IconButton, {
          name: 'plus',
          title: t('ws.files.mkdir'),
          dataTestId: `ssh-ws-mkdir-${pane}`,
          onClick: () => (typeof onCreateFolder === 'function' ? onCreateFolder(pane, root) : undefined),
        }),
      ),
      h(
        'div',
        { className: 'ssh-ws-pane-head', style: { borderBottom: 0 } },
        h(primitives.Checkbox, {
          checked: hidden,
          onChange: () => (typeof onToggleHidden === 'function' ? onToggleHidden(pane) : undefined),
          label: t('ws.files.hidden'),
          dataTestId: `ssh-ws-hidden-${pane}`,
        }),
        h('span', { className: 'ssh-ws-spacer' }),
        h(
          'button',
          {
            type: 'button',
            className: 'ssh-ws-filter',
            'data-active': pane === 'local' ? 'true' : 'false',
            'data-testid': `ssh-ws-upload-${pane}`,
            disabled: pane !== 'local' || !selected || Boolean(uploadReason),
            // A disabled control that does not say why is the same dead end as an
            // unexplained spinner: the reason is carried on hover and in the DOM.
            'data-reason': pane === 'local' && uploadReason ? uploadReason : undefined,
            title: pane === 'local' && uploadReason ? uploadReason : t('ws.files.upload'),
            onClick: () => (typeof onUpload === 'function' ? onUpload(selected) : undefined),
          },
          h(primitives.Icon, { name: 'upload', size: 12 }),
          t('ws.files.upload'),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'ssh-ws-filter',
            'data-testid': `ssh-ws-download-${pane}`,
            disabled: pane !== 'remote' || !selected,
            title: t('ws.files.download'),
            onClick: () => (typeof onDownload === 'function' ? onDownload(selected) : undefined),
          },
          h(primitives.Icon, { name: 'download', size: 12 }),
          t('ws.files.download'),
        ),
      ),
      h(
        'div',
        { className: 'ssh-ws-head-row' },
        h('span', null, ''),
        h(
          'button',
          { type: 'button', className: 'ssh-ws-filter', onClick: () => onSort && onSort(pane, 'name') },
          t('ws.files.name'),
        ),
        h(
          'button',
          { type: 'button', className: 'ssh-ws-filter', onClick: () => onSort && onSort(pane, 'size') },
          t('ws.files.size'),
        ),
        h(
          'button',
          { type: 'button', className: 'ssh-ws-filter', onClick: () => onSort && onSort(pane, 'mode') },
          t('ws.files.mode'),
        ),
        h(
          'button',
          { type: 'button', className: 'ssh-ws-filter', onClick: () => onSort && onSort(pane, 'mtime') },
          t('ws.files.mtime'),
        ),
      ),
      h(
        'div',
        { className: 'ssh-ws-entries', 'data-testid': `ssh-ws-entries-${pane}` },
        loading === true
          ? h('div', { className: 'ssh-ws-hint', style: { padding: 8 } }, t('ws.files.loading'))
          : null,
        error
          ? h(
              'div',
              { className: 'ssh-ws-empty', 'data-testid': `ssh-ws-error-${pane}` },
              h('span', { className: 'ssh-ws-empty-title' }, `${error.code || 'SSH_UNKNOWN'}`),
              h('span', { className: 'ssh-ws-hint' }, error.message || ''),
              // Every failure - including the local watchdog deadline - offers one
              // retry, so a pane can always leave the failed state without a reload.
              h(
                'button',
                {
                  type: 'button',
                  className: 'ssh-ws-filter',
                  'data-testid': `ssh-ws-retry-${pane}`,
                  onClick: () => (typeof onRetry === 'function' ? onRetry(pane) : undefined),
                },
                t('ws.files.refresh'),
              ),
            )
          : null,
        !loading && !error && visible.length === 0
          ? h(
              'div',
              { className: 'ssh-ws-empty', 'data-testid': `ssh-ws-empty-${pane}` },
              h(
                'span',
                { className: 'ssh-ws-empty-title' },
                // A pane nobody asked to load is not an empty folder: with no remote
                // session there is nothing to list at all, and saying "empty" would
                // send the user looking for files that were never fetched.
                unwired
                  ? pane === 'local'
                    ? t('ws.files.emptyLocal')
                    : t('err.SSH_STATE_INVALID')
                  : pane === 'local'
                    ? t('ws.files.emptyLocal')
                    : t('ws.files.empty'),
              ),
              pane === 'local' ? h('span', { className: 'ssh-ws-hint' }, t('ws.files.emptyLocalHint')) : null,
            )
          : null,
        visible.map((entry) =>
          h(
            'button',
            {
              key: entry.path || entry.name,
              type: 'button',
              className: 'ssh-ws-entry',
              'data-kind': kindOf(entry),
              'data-selected': selected && selected.path === entry.path ? 'true' : 'false',
              'data-testid': `ssh-ws-entry-${pane}-${entry.name}`,
              title: entry.path,
              onClick: (event) => (typeof onEntryClick === 'function' ? onEntryClick(pane, entry, event) : undefined),
              onDoubleClick: () => (typeof onEntryActivate === 'function' ? onEntryActivate(pane, entry) : undefined),
            },
            h('span', { className: 'ssh-ws-icon', 'data-kind': kindOf(entry) }, h(primitives.Icon, { name: iconFor(kindOf(entry)), size: 13 })),
            h('span', { className: 'ssh-ws-entry-name' }, entry.name),
            h('span', { className: 'ssh-ws-entry-meta' }, kindOf(entry) === 'dir' ? '—' : ui.formatBytes(entry.size)),
            h('span', { className: 'ssh-ws-entry-meta' }, entry.mode || ''),
            h('span', { className: 'ssh-ws-entry-meta' }, ui.formatDateTime(entry.mtime)),
          ),
        ),
      ),
    )
  }

  function FileManager(props) {
    const settings = props || {}
    const {
      sessionId,
      localRoot,
      remoteRoot,
      transfers,
      onTransferCancel,
      onUpload,
      onDownload,
      onMkdir,
      onRename,
      onDelete,
      onChmod,
      onRefresh,
      onNavigate,
      loadingByPane,
    } = settings

    const ui = SSH.require('ssh.session.ui')
    const runtime = SSH.require('ssh.session.runtime')
    const primitives = ui.ui()
    const t = ui.t

    const [activePane, setActivePane] = useState(settings.activePane === 'local' ? 'local' : 'remote')
    const [selection, setSelection] = useState({ local: null, remote: null })
    const [hidden, setHidden] = useState({ local: false, remote: false })
    const [sort, setSort] = useState({ local: { key: 'name', direction: 'asc' }, remote: { key: 'name', direction: 'asc' } })
    const [dialog, setDialog] = useState(null)
    const [dialogValue, setDialogValue] = useState('')
    const [notice, setNotice] = useState(null)
    // A request is in flight for this pane; the record may not exist yet.
    const [pending, setPending] = useState({ local: false, remote: false })
    // The pane's last request outlived the watchdog: an error the user can retry.
    const [expired, setExpired] = useState({ local: false, remote: false })
    // Bumped per issued request so the watchdog re-arms for a newer one.
    const [attempt, setAttempt] = useState({ local: 0, remote: 0 })
    /** Ticket of the newest request per pane, so a superseded one cannot settle it. */
    const attempts = useRef({ local: 0, remote: 0 })
    /** Requests in flight from *this* mount: the mount trigger must not re-fire. */
    const inflight = useRef({ local: false, remote: false })

    const timeoutMs =
      typeof settings.timeoutMs === 'number' && settings.timeoutMs > 0 ? settings.timeoutMs : DEFAULT_LOAD_TIMEOUT_MS

    // Declared before the roots are derived: the remote default is resolved against
    // the wiring revision, and hooks keep a stable order across renders.
    const wiring = runtime.useWiringRevision()

    /**
     * Where the remote pane starts when no root prop is given.
     *
     * Resolved once per (session, wiring) rather than on every render: a value whose
     * identity changed during a render would re-run the mount trigger and re-issue a
     * load for a directory that is already on screen.
     */
    const remoteDefaultRoot = useMemo(
      () => sessionDefaultCwd(runtime.app(), sessionId) || REMOTE_ROOT_BOOTSTRAP,
      [runtime, sessionId, wiring],
    )

    /**
     * The root each pane starts from.
     *
     * The frozen props may omit both (the real GUI mounts with `sessionId` alone), so
     * a missing root is filled in rather than treated as "nothing to load".
     */
    const effectiveRoot = (pane) =>
      pane === 'local' ? paneRoot(localRoot, LOCAL_ROOT_BOOTSTRAP) : paneRoot(remoteRoot, remoteDefaultRoot)

    /** The session half of a directory key, matching what the runtime writes. */
    const readSessionId = (pane) => (pane === 'local' ? sessionId ?? 'local' : sessionId)

    /**
     * The directory each pane is currently *in*.
     *
     * `null` means "wherever this pane starts" (the prop, or the bootstrap root).
     * This state is what makes navigation visible: the pane used to read its cache
     * under a key derived only from its props, which never changes, so a navigation
     * stored its answer under the new path while the view kept reading the old one -
     * the request went out, the host answered, and the listing never moved. That is
     * precisely "I cannot switch directories".
     */
    const [panePath, setPanePath] = useState({ local: null, remote: null })
    const currentPath = (pane) => panePath[pane] ?? effectiveRoot(pane)

    // Scalar snapshots for the mount trigger: a function in a dependency array would
    // re-run the effect on every render, and re-running it must be meaningful.
    const providedLocalForTrigger = Array.isArray(settings.localEntries)
    const providedRemoteForTrigger = Array.isArray(settings.remoteEntries)
    const localRootForTrigger = currentPath('local')
    const remoteRootForTrigger = currentPath('remote')

    // Both panes read their directory through the same key the loader writes, and it
    // follows navigation: read what is displayed, not what the props once said.
    const localDir = runtime.useDirectory(readSessionId('local'), 'local', currentPath('local'))
    const remoteDir = runtime.useDirectory(readSessionId('remote'), 'remote', currentPath('remote'))
    const runtimeTransfers = runtime.useTransfers()

    useEffect(() => {
      SSH.require('ssh.session.styles').ensureStyles()
      // The bundle identity, so "am I looking at the fixed build?" is answerable from
      // the console without guessing (same convention as ssh.bridge/ssh.chrome). The
      // roots are included because "which directory was this pane pointed at?" is the
      // first question when a listing does not appear.
      console.info(
        `[dsh-ssh] ${BUILD_MARKER} load-deadline=${timeoutMs}ms local=${localRootForTrigger} remote=${remoteRootForTrigger}`,
      )
    }, [])

    useEffect(() => {
      if (!notice) return undefined
      const timer = setTimeout(() => setNotice(null), 2400)
      return () => clearTimeout(timer)
    }, [notice])

    /**
     * Issue one directory load for a pane, with the lifecycle made visible.
     *
     * Three console lines carry the whole story of a pane that shows nothing, which
     * a screenshot cannot distinguish: the request went out (`loading`), it came back
     * (`loaded`, with the entry count), or it came back broken (`failed`, with the
     * code). A request that never settles is reported by the watchdog instead, and
     * that is the case this used to lose silently.
     */
    const loadPane = useCallback(
      (pane, path, options) => {
        const opts = options || {}
        const target = normalizeDirPath(path ?? currentPath(pane))
        if (!target) return Promise.resolve(null)
        if (pane === 'remote' && !sessionId) return Promise.resolve(null)

        const showHidden = typeof opts.showHidden === 'boolean' ? opts.showHidden : pane === 'local' ? hidden.local : hidden.remote
        // This request's ticket. A newer request for the same pane takes over, and
        // the older one is then not allowed to settle the pane it no longer owns.
        const token = (attempts.current[pane] || 0) + 1
        attempts.current[pane] = token
        inflight.current[pane] = true
        setPending((current) => ({ ...current, [pane]: true }))
        setExpired((current) => (current[pane] ? { ...current, [pane]: false } : current))
        setAttempt((current) => ({ ...current, [pane]: token }))
        console.info('[dsh-ssh] files: loading', { scope: pane, path: target })

        let request
        try {
          request =
            pane === 'remote'
              ? runtime.actions.listDir({ sessionId, path: target, showHidden })
              : runtime.actions.listLocalDir({ sessionId, path: target, showHidden })
        } catch (error) {
          request = Promise.reject(error)
        }

        const settle = (record, failure) => {
          // A newer request for this pane owns the outcome now.
          if (attempts.current[pane] !== token) return
          inflight.current[pane] = false
          setPending((current) => (current[pane] ? { ...current, [pane]: false } : current))
          // Settled data always beats a deadline that fired while it was in flight.
          setExpired((current) => (current[pane] ? { ...current, [pane]: false } : current))
          // The runtime reports a failed listing inside the returned record rather
          // than by rejecting, so both paths are folded into one outcome.
          const reported = failure || (record && record.error) || null
          if (reported) {
            console.warn('[dsh-ssh] files: failed', {
              scope: pane,
              code: reported.code || 'SSH_UNKNOWN',
              message: reported.message || String(reported),
            })
          } else {
            console.info('[dsh-ssh] files: loaded', {
              scope: pane,
              entries: Array.isArray(record && record.entries) ? record.entries.length : 0,
            })
          }
        }

        return Promise.resolve(request).then(
          (record) => settle(record, null),
          (error) => settle(null, error),
        )
      },
      [currentPath, hidden.local, hidden.remote, runtime, sessionId],
    )

    /** Deadline reached: the pane leaves `loading` for a retryable error. */
    const expirePane = useCallback((pane) => {
      inflight.current[pane] = false
      setPending((current) => (current[pane] ? { ...current, [pane]: false } : current))
      setExpired((current) => ({ ...current, [pane]: true }))
      console.warn('[dsh-ssh] files: timeout', { scope: pane, afterMs: timeoutMs })
    }, [timeoutMs])

    /** Re-issue the pane's current directory after a failure or a deadline. */
    const retryPane = useCallback(
      (pane) => {
        setExpired((current) => (current[pane] ? { ...current, [pane]: false } : current))
        return loadPane(pane, effectiveRoot(pane))
      },
      [effectiveRoot, loadPane],
    )

    /**
     * Fire a pane's first load when it has nothing settled to show.
     *
     * The decision comes from the *derived* state - an in-flight request from this
     * mount, or a record that holds a real answer - and never from the record's own
     * `loading` flag. Gating on `record.loading !== true` (the previous rule) is
     * exactly what stopped the trigger: a record left mid-flight by an earlier mount
     * has `loading: true, loadedAt: 0` forever, so the tab mounted and issued
     * nothing at all. Every decision is logged with the values it was made from, so
     * "no request was sent" is diagnosable from the console instead of inferred.
     */
    const trigger = (pane, path, provided) => {
      const record = runtime.getDirectory(readSessionId(pane), pane, path)
      let skipBy = null
      if (provided) skipBy = 'provided'
      else if (pane === 'remote' && !sessionId) skipBy = 'no-session'
      else if (inflight.current[pane] === true) skipBy = 'pending'
      else if (record && (record.loadedAt > 0 || record.error)) skipBy = 'settled'
      console.info('[dsh-ssh] files: trigger', {
        scope: pane,
        path,
        hasRecord: Boolean(record),
        loadedAt: record ? record.loadedAt : null,
        recordLoading: record ? record.loading === true : null,
        reason: skipBy ? 'skip' : 'fire',
        skipBy,
      })
      if (!skipBy) loadPane(pane, path)
    }

    // Load a pane when it has nothing to show and nobody else supplied the entries.
    useEffect(() => {
      trigger('local', localRootForTrigger, providedLocalForTrigger)
      trigger('remote', remoteRootForTrigger, providedRemoteForTrigger)
    }, [sessionId, localRootForTrigger, remoteRootForTrigger, wiring, providedLocalForTrigger, providedRemoteForTrigger])

    /**
     * One pane's view state.
     *
     * `loading` is driven by *evidence that a request is outstanding* - this pane's
     * own pending flag, or a record the runtime marked in flight - never by the
     * absence of a record. `expired` (the watchdog) outranks the record's own flag,
     * so a request that never answers ends in an explained error with a retry
     * instead of an endless spinner. `settled` records that a real answer (data or
     * failure) has landed, which clears both flags.
     */
    const paneState = (pane, dir, provided) => {
      const record = dir && dir.directory ? dir.directory : null
      const settled = Boolean(record && (record.loadedAt > 0 || record.error))
      const timedOut = expired[pane] === true
      const loading = !timedOut && (pending[pane] === true || (record ? record.loading === true : false))
      const error = timedOut
        ? { code: 'SSH_NET_TIMEOUT', message: t('err.SSH_NET_TIMEOUT') }
        : record
          ? record.error
          : null
      // The directory the host actually answered with wins. Once a record carries an
      // absolute `cwd`, the bootstrap root must never be used again: falling back to
      // it is what made the pane snap back to the starting folder after navigating.
      const fromRecord = record && record.cwd ? normalizeDirPath(record.cwd) : null
      return {
        root: fromRecord || currentPath(pane),
        rootReason: fromRecord ? 'record' : panePath[pane] !== null ? 'path' : 'bootstrap',
        entries: provided ? (pane === 'local' ? settings.localEntries : settings.remoteEntries) : record ? record.entries : [],
        // A container that supplies the entries also owns their loading state, and
        // therefore its own deadline: the watchdog must not expire a pane this
        // component never asked to load.
        loading: provided ? loadingByPane && loadingByPane[pane] === true : loading,
        watchdog: !provided && loading,
        error: provided ? null : error,
        settled,
        timedOut,
        // Only the remote pane can still be unaddressable: a remote listing needs a
        // session, while the local pane always has its bootstrap root.
        unwired: !provided && pane === 'remote' && !sessionId,
      }
    }

    const panes = {
      local: paneState('local', localDir, Array.isArray(settings.localEntries)),
      remote: paneState('remote', remoteDir, Array.isArray(settings.remoteEntries)),
    }

    // The deadline is armed from the derived loading state, so every route into
    // `loading` gets one - including a request issued before this mount.
    useLoadWatchdog('local', panes.local.watchdog === true, attempt.local, timeoutMs, expirePane)
    useLoadWatchdog('remote', panes.remote.watchdog === true, attempt.remote, timeoutMs, expirePane)

    /**
     * Report which root each pane is displaying and where it came from.
     *
     * "The listing snapped back to the starting folder" is invisible in a screenshot
     * of a file manager, so the decision is logged with its source: `record` means the
     * host's own absolute answer is in use, `path` a directory the user navigated to,
     * `bootstrap` the derived starting point.
     */
    const localRootReason = panes.local.rootReason
    const remoteRootReason = panes.remote.rootReason
    const localRootShown = panes.local.root
    const remoteRootShown = panes.remote.root
    useEffect(() => {
      console.info('[dsh-ssh] files: root', {
        scope: 'local',
        effective: localRootShown,
        fromRecord: localRootReason === 'record' ? localRootShown : null,
        reason: localRootReason,
      })
      console.info('[dsh-ssh] files: root', {
        scope: 'remote',
        effective: remoteRootShown,
        fromRecord: remoteRootReason === 'record' ? remoteRootShown : null,
        reason: remoteRootReason,
      })
    }, [localRootShown, localRootReason, remoteRootShown, remoteRootReason])

    /**
     * Why the upload affordance is unavailable, in the user's words.
     *
     * Uses keys that already exist (no new translation contract): an unusable
     * session or a missing remote root is a state error, an unsettled remote
     * listing is "loading", and a denied listing is the permission error itself.
     */
    const uploadReason = (() => {
      if (!sessionId || !panes.remote.root) return t('err.SSH_STATE_INVALID')
      if (panes.remote.loading) return t('ws.files.loading')
      if (panes.remote.error) return panes.remote.error.message || panes.remote.error.code || t('ws.files.loading')
      if (!selection.local) return t('ws.files.selectFirst')
      return null
    })()

    const transferList = Array.isArray(transfers) ? transfers : runtimeTransfers.transfers

    /**
     * Move a pane to another directory.
     *
     * `via` records what the user did (`entry`, `up`, `crumb`, `api`), because "the
     * click did nothing" and "the click moved the pane somewhere else" look the same
     * in a screenshot and completely different in the log.
     */
    const navigate = useCallback(
      (pane, path, via) => {
        const from = currentPath(pane)
        // Normalise before anything else: the target is both the log's `to`, the key
        // the pane will read and the path the host is asked for, so one canonical
        // form keeps them in agreement (`C:\x\` and `C:\x` must not be two folders).
        const to = normalizeDirPath(path)
        if (typeof onNavigate === 'function') onNavigate(pane, to)
        console.info('[dsh-ssh] files: navigate', { scope: pane, from, to, via: via || 'api' })
        // Remember the destination first: the pane reads its cache through this path,
        // so setting it is what makes the new listing visible at all.
        setPanePath((current) => (current[pane] === to ? current : { ...current, [pane]: to }))
        loadPane(pane, to)
      },
      [currentPath, loadPane, onNavigate],
    )

    /** Re-read the pane's current directory (the refresh control, a filter change). */
    const refresh = useCallback(
      (pane, path) => {
        const target = normalizeDirPath(path || currentPath(pane))
        if (typeof onRefresh === 'function') onRefresh(pane, target)
        loadPane(pane, target)
      },
      [currentPath, loadPane, onRefresh],
    )

    const select = useCallback((pane, entry) => {
      setActivePane(pane)
      setSelection((current) => ({ ...current, [pane]: entry }))
    }, [])

    const dialogComponent = useMemo(() => {
      // SP7 owns the confirmation surface; the frozen primitive is the fallback so
      // a dangerous action can never run without a dialog at all.
      try {
        const chrome = SSH.require('ssh.chrome.confirm')
        const candidate = chrome && (chrome.ConfirmDialog || chrome.Confirm)
        if (typeof candidate === 'function') return candidate
      } catch {
        /* the chrome module is optional */
      }
      return primitives.ConfirmDialog
    }, [primitives])

    const transferTarget = useCallback(
      (fromPane, entry) => {
        if (!entry) return null
        const name = ui.basename(entry.path || entry.name)
        if (fromPane === 'local') return ui.joinPath(panes.remote.root, name)
        return ui.joinPath(panes.local.root, name)
      },
      [panes.local.root, panes.remote.root, ui],
    )

    /**
     * Start a transfer, through the container's callback or the workspace runtime.
     *
     * The frozen props are optional, and the GUI mounts this component with
     * `sessionId` alone - so a handler that only called `props.onUpload` computed a
     * destination and then did nothing at all. That is exactly the reported "I cannot
     * upload": no request, no error, no clue. The container still wins when it
     * supplies the callback; otherwise the runtime issues the stream, which is the
     * same data plane the panes already load through.
     */
    const startTransfer = useCallback(
      (direction, source, destination, options) => {
        const overwrite = options && options.overwrite === true
        const from = direction === 'upload' ? source.path : destination
        const to = direction === 'upload' ? destination : source.path
        const detail = { scope: direction, path: to, file: from, bytes: source.size }
        console.info('[dsh-ssh] files: upload', { ...detail, state: 'picked', direction })
        if (!sessionId) {
          console.warn('[dsh-ssh] files: upload', { ...detail, direction, state: 'failed', code: 'SSH_STATE_INVALID' })
          setNotice(t('err.SSH_STATE_INVALID'))
          return Promise.resolve(null)
        }
        const callback = direction === 'upload' ? onUpload : onDownload
        const params =
          direction === 'upload'
            ? { localPath: source.path, remotePath: destination }
            : { remotePath: source.path, localPath: destination }
        let request
        try {
          request =
            typeof callback === 'function'
              ? callback(from, to, overwrite ? { overwrite: true } : undefined)
              : runtime.actions[direction]({ sessionId, ...params, ...(overwrite ? { overwrite: true } : {}) })
          console.info('[dsh-ssh] files: upload', { ...detail, direction, state: 'started' })
        } catch (error) {
          console.warn('[dsh-ssh] files: upload', {
            ...detail,
            direction,
            state: 'failed',
            code: (error && error.code) || 'SSH_UNKNOWN',
          })
          setNotice((error && error.message) || t('err.SSH_UNKNOWN'))
          return Promise.resolve(null)
        }
        return Promise.resolve(request).then(
          (result) => {
            // "done" means the stream was accepted and is running: its progress and
            // outcome are owned by the transfer list, not by this call.
            console.info('[dsh-ssh] files: upload', {
              ...detail,
              direction,
              state: 'done',
              streamId: result && (result.streamId || result.localId),
            })
            return result
          },
          (error) => {
            const code = (error && error.code) || 'SSH_UNKNOWN'
            console.warn('[dsh-ssh] files: upload', { ...detail, direction, state: 'failed', code })
            setNotice((error && error.message) || t('err.SSH_UNKNOWN'))
            return null
          },
        )
      },
      [onDownload, onUpload, runtime, sessionId, t],
    )

    const startUpload = useCallback(
      (entry) => {
        const target = entry || selection.local
        if (!target) {
          console.warn('[dsh-ssh] files: upload', { scope: 'upload', state: 'failed', code: 'SSH_CFG_INVALID', reason: 'no local file selected' })
          setNotice(t('ws.files.selectFirst'))
          return
        }
        if (!panes.remote.root) {
          console.warn('[dsh-ssh] files: upload', { scope: 'upload', file: target.path, state: 'failed', code: 'SSH_STATE_INVALID', reason: 'no remote root' })
          setNotice(t('err.SSH_STATE_INVALID'))
          return
        }
        const remotePath = transferTarget('local', target)
        if (hasChild(panes.remote.entries, ui.basename(remotePath))) {
          setDialog({ kind: 'overwrite', direction: 'upload', entry: target, target: remotePath })
          return
        }
        startTransfer('upload', target, remotePath)
      },
      [panes.remote.entries, panes.remote.root, selection.local, setDialog, startTransfer, t, transferTarget, ui],
    )

    const startDownload = useCallback(
      (entry) => {
        const target = entry || selection.remote
        if (!target) {
          setNotice(t('ws.files.selectFirst'))
          return
        }
        const localPath = transferTarget('remote', target)
        if (hasChild(panes.local.entries, ui.basename(localPath))) {
          setDialog({ kind: 'overwrite', direction: 'download', entry: target, target: localPath })
          return
        }
        startTransfer('download', target, localPath)
      },
      [panes.local.entries, selection.remote, setDialog, startTransfer, t, transferTarget, ui],
    )

    /**
     * A click on a row.
     *
     * A directory opens on a plain click. The previous build only opened on a double
     * click, and combined with a pane that never re-read its cache this read as a
     * frozen tree. Ctrl/Cmd+click still selects a directory instead of entering it,
     * which keeps folder operations (rename, delete, recursive upload) reachable.
     */
    const clickEntry = useCallback(
      (pane, entry, event) => {
        const kind = kindOf(entry)
        const modified = Boolean(event && (event.metaKey || event.ctrlKey))
        console.info('[dsh-ssh] files: entry', {
          scope: pane,
          name: entry && entry.name,
          kind,
          modified,
          action: kind === 'dir' && !modified ? 'open' : 'select',
        })
        if (kind === 'dir' && !modified) {
          // Select it *and* open it. Selecting keeps rename/delete/chmod aimed at the
          // folder the user actually clicked, which is also what the confirmation
          // dialog names; opening is what "switch to that folder" means to a user.
          select(pane, entry)
          navigate(pane, entry.path, 'entry')
          return
        }
        select(pane, entry)
      },
      [navigate, select],
    )

    /**
     * A double click on a row.
     *
     * Directories are already opened by the single click, so repeating it here would
     * navigate twice; for files it keeps the transfer shortcut.
     */
    const activateEntry = useCallback(
      (pane, entry) => {
        if (kindOf(entry) === 'dir') return
        if (pane === 'local') startUpload(entry)
        else startDownload(entry)
      },
      [startDownload, startUpload],
    )

    const requestDelete = useCallback(
      (pane) => {
        const entry = selection[pane]
        if (!entry) {
          setNotice(t('ws.files.selectFirst'))
          return
        }
        setDialogValue('')
        setDialog({ kind: 'delete', pane, entry })
      },
      [selection, t],
    )

    const requestRename = useCallback(
      (pane) => {
        const entry = selection[pane]
        if (!entry) {
          setNotice(t('ws.files.selectFirst'))
          return
        }
        setDialogValue(entry.name)
        setDialog({ kind: 'rename', pane, entry })
      },
      [selection, t],
    )

    const requestChmod = useCallback(
      (pane) => {
        const entry = selection[pane]
        if (!entry) {
          setNotice(t('ws.files.selectFirst'))
          return
        }
        setDialogValue(entry.mode || '0644')
        setDialog({ kind: 'chmod', pane, entry })
      },
      [selection, t],
    )

    const requestMkdir = useCallback(
      (pane, path) => {
        setDialogValue('')
        setDialog({ kind: 'mkdir', pane, path })
      },
      [],
    )

    const closeDialog = useCallback(() => {
      setDialog(null)
      setDialogValue('')
    }, [])

    /**
     * Run one remote mutation, through the container's callback or the runtime.
     *
     * Same reason as the transfers: the callbacks are optional props and the GUI does
     * not pass them, so `if (typeof onDelete === 'function')` alone turned every
     * confirmed delete, rename, mkdir and chmod into a silent no-op. The host has no
     * local-side mutation endpoint, so a local-pane request is refused with a code
     * instead of being sent to the remote endpoint by mistake.
     */
    const runRemoteOp = useCallback(
      (op, callback, pane, args, params) => {
        if (typeof callback === 'function') {
          callback(...args)
          return
        }
        if (pane === 'local') {
          console.warn('[dsh-ssh] files: op', { op, scope: pane, state: 'failed', code: 'SSH_STATE_INVALID' })
          setNotice(t('err.SSH_STATE_INVALID'))
          return
        }
        if (!sessionId) {
          console.warn('[dsh-ssh] files: op', { op, scope: pane, state: 'failed', code: 'SSH_STATE_INVALID' })
          setNotice(t('err.SSH_STATE_INVALID'))
          return
        }
        const action = runtime.actions[op]
        if (typeof action !== 'function') return
        console.info('[dsh-ssh] files: op', { op, scope: pane, state: 'started', ...params })
        Promise.resolve(action({ sessionId, ...params })).catch((error) => {
          console.warn('[dsh-ssh] files: op', {
            op,
            scope: pane,
            state: 'failed',
            code: (error && error.code) || 'SSH_UNKNOWN',
          })
          setNotice((error && error.message) || t('err.SSH_UNKNOWN'))
        })
      },
      [runtime, sessionId, t],
    )

    const confirmDialog = useCallback(() => {
      const pending = dialog
      if (!pending) return
      const pane = pending.pane
      const path = pending.entry ? pending.entry.path : ''
      if (pending.kind === 'delete') {
        runRemoteOp(
          'removePath',
          onDelete,
          pane,
          [pane, path, { recursive: pending.entry && kindOf(pending.entry) === 'dir' }],
          { path, recursive: pending.entry && kindOf(pending.entry) === 'dir' },
        )
      } else if (pending.kind === 'rename') {
        const next = ui.joinPath(ui.parentPath(path), dialogValue)
        runRemoteOp('rename', onRename, pane, [pane, path, next], { from: path, to: next })
      } else if (pending.kind === 'chmod') {
        runRemoteOp('chmod', onChmod, pane, [pane, path, dialogValue], { path, mode: dialogValue })
      } else if (pending.kind === 'mkdir') {
        const next = ui.joinPath(pending.path, dialogValue)
        runRemoteOp('mkdir', onMkdir, pane, [pane, next], { path: next })
      } else if (pending.kind === 'overwrite') {
        if (pending.direction === 'upload') startTransfer('upload', pending.entry, pending.target, { overwrite: true })
        if (pending.direction === 'download') startTransfer('download', pending.entry, pending.target, { overwrite: true })
      }
      closeDialog()
    }, [closeDialog, dialog, dialogValue, onChmod, onDelete, onMkdir, onRename, runRemoteOp, startTransfer, ui])

    const activeSelection = selection[activePane]
    const canRename = Boolean(activeSelection)

    const dialogNode = (() => {
      if (!dialog) return null
      if (dialog.kind === 'delete') {
        const isDir = kindOf(dialog.entry) === 'dir'
        return h(dialogComponent, {
          open: true,
          danger: true,
          title: t('files.delete.title', { name: dialog.entry.name }),
          body: isDir
            ? t('files.delete.bodyDir', { path: dialog.entry.path })
            : t('files.delete.body', { path: dialog.entry.path }),
          confirmText: t('ws.files.delete'),
          cancelText: t('confirm.cancel'),
          requireType: isDir ? dialog.entry.name : undefined,
          onConfirm: confirmDialog,
          onCancel: closeDialog,
          dataTestId: 'ssh-ws-dialog-delete',
        })
      }
      if (dialog.kind === 'overwrite') {
        return h(dialogComponent, {
          open: true,
          danger: true,
          title: t('files.overwrite.title', { name: ui.basename(dialog.target) }),
          body: t('files.overwrite.body'),
          confirmText: t('ws.files.overwrite'),
          cancelText: t('confirm.cancel'),
          onConfirm: confirmDialog,
          onCancel: closeDialog,
          dataTestId: 'ssh-ws-dialog-overwrite',
        })
      }
      const invalid = dialog.kind === 'chmod' ? modeError(dialogValue) !== '' : dialogValue.trim() === ''
      const title =
        dialog.kind === 'rename'
          ? t('files.rename.title', { name: dialog.entry.name })
          : dialog.kind === 'chmod'
            ? t('files.chmod.title', { name: dialog.entry.name })
            : t('files.mkdir.title', { path: dialog.path })
      return h(
        primitives.Modal,
        {
          open: true,
          danger: dialog.kind === 'chmod',
          title,
          dataTestId: `ssh-ws-dialog-${dialog.kind}`,
          onClose: closeDialog,
          footer: [
            h(primitives.Button, { key: 'cancel', onClick: closeDialog }, t('confirm.cancel')),
            h(
              primitives.Button,
              { key: 'ok', kind: 'primary', disabled: invalid, dataTestId: 'ssh-ws-dialog-ok', onClick: confirmDialog },
              t('confirm.ok'),
            ),
          ],
        },
        h(primitives.Input, {
          value: dialogValue,
          onChange: setDialogValue,
          invalid,
          autoFocus: true,
          dataTestId: 'ssh-ws-dialog-input',
          placeholder: dialog.kind === 'chmod' ? t('ws.files.chmodPrompt') : t('ws.files.namePrompt'),
        }),
        invalid && dialog.kind === 'chmod' ? h('div', { className: 'ssh-ws-error' }, t('ws.files.chmodPrompt')) : null,
      )
    })()

    return h(
      'div',
      { className: 'ssh-ws', 'data-testid': 'ssh-ws-files' },
      h(
        'div',
        { className: 'ssh-ws-toolbar' },
        h('span', { className: 'ssh-ws-title' }, t('ws.tabs.files')),
        h('span', { className: 'ssh-ws-sub' }, sessionId || '—'),
        h('span', { className: 'ssh-ws-spacer' }),
        h(
          primitives.Button,
          {
            onClick: () => startUpload(),
            disabled: Boolean(uploadReason),
            // The primitive forwards `title` (not arbitrary attributes), so the
            // reason is carried where a user can actually read it on hover.
            title: uploadReason || t('ws.files.upload'),
            dataTestId: 'ssh-ws-files-upload',
          },
          h(primitives.Icon, { name: 'upload', size: 12 }),
          t('ws.files.upload'),
        ),
        h(
          primitives.Button,
          {
            onClick: () => startDownload(),
            disabled: !selection.remote,
            dataTestId: 'ssh-ws-files-download',
          },
          h(primitives.Icon, { name: 'download', size: 12 }),
          t('ws.files.download'),
        ),
        h(primitives.Button, { onClick: () => requestRename(activePane), disabled: !canRename, dataTestId: 'ssh-ws-files-rename' }, t('ws.files.rename')),
        h(
          primitives.Button,
          { onClick: () => requestChmod(activePane), disabled: !canRename, dataTestId: 'ssh-ws-files-chmod' },
          t('ws.files.chmod'),
        ),
        h(
          primitives.Button,
          { kind: 'danger', onClick: () => requestDelete(activePane), disabled: !canRename, dataTestId: 'ssh-ws-files-delete' },
          t('ws.files.delete'),
        ),
        notice ? h('span', { className: 'ssh-ws-hint', 'data-testid': 'ssh-ws-files-notice' }, notice) : null,
      ),

      h(
        'div',
        { className: 'ssh-ws-panes' },
        h(FilePane, {
          pane: 'local',
          title: t('ws.files.local'),
          root: panes.local.root,
          entries: panes.local.entries,
          loading: panes.local.loading,
          error: panes.local.error,
          selected: selection.local,
          active: activePane === 'local',
          hidden: hidden.local,
          sort: sort.local,
          t,
          ui,
          primitives,
          uploadReason,
          unwired: panes.local.unwired,
          onActivate: setActivePane,
          onEntryClick: clickEntry,
          onEntryActivate: activateEntry,
          onNavigate: navigate,
          onRefresh: refresh,
          onRetry: retryPane,
          onToggleHidden: (pane) => {
            setHidden((current) => ({ ...current, [pane]: !current[pane] }))
            refresh(pane, panes[pane].root)
          },
          onSort: (pane, key) =>
            setSort((current) => ({
              ...current,
              [pane]: { key, direction: current[pane].key === key && current[pane].direction === 'asc' ? 'desc' : 'asc' },
            })),
          onCreateFolder: requestMkdir,
          onUpload: startUpload,
          onDownload: startDownload,
        }),
        h('div', { className: 'ssh-ws-divider' }),
        h(FilePane, {
          pane: 'remote',
          title: t('ws.files.remote'),
          root: panes.remote.root,
          entries: panes.remote.entries,
          loading: panes.remote.loading,
          error: panes.remote.error,
          selected: selection.remote,
          active: activePane === 'remote',
          hidden: hidden.remote,
          sort: sort.remote,
          t,
          ui,
          primitives,
          uploadReason,
          unwired: panes.remote.unwired,
          onActivate: setActivePane,
          onEntryClick: clickEntry,
          onEntryActivate: activateEntry,
          onNavigate: navigate,
          onRefresh: refresh,
          onRetry: retryPane,
          onToggleHidden: (pane) => {
            setHidden((current) => ({ ...current, [pane]: !current[pane] }))
            refresh(pane, panes[pane].root)
          },
          onSort: (pane, key) =>
            setSort((current) => ({
              ...current,
              [pane]: { key, direction: current[pane].key === key && current[pane].direction === 'asc' ? 'desc' : 'asc' },
            })),
          onCreateFolder: requestMkdir,
          onUpload: startUpload,
          onDownload: startDownload,
        }),
      ),

      transferList.length > 0
        ? h(
            'div',
            { className: 'ssh-ws-transfers', 'data-testid': 'ssh-ws-transfers' },
            h('div', { className: 'ssh-ws-pane-head' }, h('span', { className: 'ssh-ws-pane-label' }, t('ws.files.progress'))),
            transferList.map((task) =>
              h(
                'div',
                { className: 'ssh-ws-transfer', key: task.opId || task.streamId, 'data-testid': `ssh-ws-transfer-${task.opId || task.streamId}` },
                h(
                  'div',
                  { className: 'ssh-ws-transfer-head' },
                  h(primitives.Icon, { name: task.direction === 'download' ? 'download' : 'upload', size: 12 }),
                  h(
                    'span',
                    { className: 'ssh-ws-transfer-path', title: `${task.localPath} → ${task.remotePath}` },
                    `${task.direction === 'upload' ? task.localPath : task.remotePath} → ${task.direction === 'upload' ? task.remotePath : task.localPath}`,
                  ),
                  task.error ? h('span', { className: 'ssh-ws-badge', 'data-outcome': 'error' }, task.error.code || 'error') : null,
                  h(
                    'span',
                    { className: 'ssh-ws-sub', 'data-testid': `ssh-ws-transfer-meta-${task.opId || task.streamId}` },
                    `${ui.formatBytes(task.transferred)}${task.totalBytes ? ` / ${ui.formatBytes(task.totalBytes)}` : ''} · ${ui.formatSpeed(
                      task.bytesPerSec,
                    )} · ${ui.formatEta(task.etaMs)}`,
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'ssh-ws-filter',
                      'data-testid': `ssh-ws-transfer-cancel-${task.opId || task.streamId}`,
                      onClick: () => {
                        if (typeof onTransferCancel === 'function') onTransferCancel(task.opId)
                        else runtime.actions.cancelTransfer(task.opId)
                      },
                    },
                    t('ws.files.cancel'),
                  ),
                ),
                h(primitives.Progress, {
                  value: task.transferred,
                  total: task.totalBytes,
                  bytesPerSec: task.bytesPerSec,
                  etaMs: task.etaMs,
                  indeterminate: task.totalBytes === undefined && task.status === 'running',
                  status: task.status === 'done' ? 'done' : task.status === 'error' ? 'error' : task.status === 'cancelled' ? 'cancelled' : 'running',
                }),
              ),
            ),
          )
        : null,

      dialogNode,
    )
  }

  return { FileManager, sortEntries, hasChild, modeError }
})
