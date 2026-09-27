/**
 * @module ssh.conn.list
 * @order 120
 *
 * `ConnList` — the connection manager's landing view: search, grouping, per-profile
 * state and the actions that start the main chain ("new connection → connect a real
 * host → session workspace").
 *
 * It is a pure function of `app` (the store facade) plus the module-level wiring:
 * every state change goes through `actions.*`, and every endpoint call through the
 * store's connector, so a test can drive the whole surface with a fake carrier and
 * no DOM events at all.
 */

SSH.define('ssh.conn.list', function (SSH) {
  const { useState, useEffect, useRef } = SSH.react
  const h = SSH.h
  const conn = () => SSH.require('ssh.conn.ui')

  function Badge(props) {
    return h('span', { className: 'dsh-ssh-pill', title: props.title }, props.children)
  }

  /** One profile row: identity, live state, credential summary and its actions. */
  function ProfileRow(props) {
    const { profile, session, app, onTest, testing, testResult } = props
    const { Pill } = conn().ui()
    const actions = app.actions
    const password = conn().secretSummary(profile, 'password')
    const passphrase = conn().secretSummary(profile, 'passphrase')
    const state = session ? session.state : 'idle'

    return h(
      'div',
      {
        className: 'dsh-ssh-conn-row',
        'data-testid': `ssh-conn-row-${profile.id}`,
        'data-active': session && (state === 'connected' || state === 'connecting') ? 'true' : 'false',
      },
      h(
        'div',
        { className: 'dsh-ssh-conn-main' },
        h('span', { className: 'dsh-ssh-conn-name', 'data-testid': `ssh-conn-name-${profile.id}` }, profile.name || '—'),
        h('span', { className: 'dsh-ssh-conn-target', 'data-testid': `ssh-conn-target-${profile.id}` }, conn().targetOf(profile)),
        h(
          'div',
          { className: 'dsh-ssh-conn-badges' },
          session
            ? h(Pill, { state: state === 'connected' ? 'connected' : state === 'error' ? 'error' : 'connecting' },
                conn().t(conn().stateLabelKey(state)))
            : null,
          h(Badge, null,
            `${conn().t('conn.field.password')}: ${conn().t(password.labelKey)}${password.present && password.masked ? ` ${password.masked}` : ''}`),
          profile.auth === 'privateKey'
            ? h(Badge, null,
                `${conn().t('conn.field.passphrase')}: ${conn().t(passphrase.labelKey)}${passphrase.present && passphrase.masked ? ` ${passphrase.masked}` : ''}`)
            : null,
        ),
        testing && testResult
          ? h(
              'div',
              { className: 'dsh-ssh-conn-notice', 'data-tone': testResult.ok === true ? 'ok' : 'error', 'data-testid': `ssh-conn-test-${profile.id}` },
              testResult.ok === true
                ? conn().t('conn.test.ok', { latencyMs: Math.round(Number(testResult.latencyMs) || 0) })
                : conn().t('conn.test.fail', { message: conn().errorText(testResult.error) }),
            )
          : null,
      ),
      h(
        'div',
        { className: 'dsh-ssh-conn-actions' },
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-ssh-btn',
            'data-kind': 'primary',
            'data-testid': `ssh-conn-connect-${profile.id}`,
            disabled: session && (state === 'connected' || state === 'connecting'),
            onClick: () => actions.connect({ profileId: profile.id }),
          },
          conn().t('conn.connect'),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-ssh-btn',
            'data-testid': `ssh-conn-test-btn-${profile.id}`,
            disabled: testing,
            onClick: () => onTest(profile),
          },
          conn().t('conn.test'),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-ssh-btn',
            'data-testid': `ssh-conn-edit-${profile.id}`,
            onClick: () => actions.openForm(profile.id),
          },
          conn().t('conn.edit'),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-ssh-btn',
            'data-testid': `ssh-conn-duplicate-${profile.id}`,
            onClick: () => actions.duplicateProfile(profile.id),
          },
          conn().t('conn.duplicate'),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-ssh-btn',
            'data-danger': 'true',
            'data-testid': `ssh-conn-delete-${profile.id}`,
            onClick: () => props.onDelete(profile),
          },
          conn().t('conn.delete'),
        ),
      ),
    )
  }

  /**
   * `ConnList`.
   * @param {{app: {useApp: Function, actions: object}}} props
   */
  function ConnList(props) {
    const { app } = props
    const { Button, Input, Spinner } = conn().ui()
    const state = app.useApp()
    const actions = app.actions
    const profiles = state.profiles
    const [testingId, setTestingId] = useState(null)

    conn().ensureStyles()

    // The list is the landing view: load once, unless something already did.
    useEffect(() => {
      if (profiles.items.length === 0 && profiles.loading !== true && !profiles.loadedAt) {
        actions.loadProfiles()
      }
    }, [])

    /**
     * Heal a first load that landed before the carrier existed.
     *
     * The bridge re-resolves the carrier on every call, so this is only the residual
     * case where its own window expires (the shell may mount `remote` well after this
     * tab renders). Without it the user stares at an empty list until they refresh by
     * hand — the failure is a snapshot, not a verdict. Bounded: after three attempts
     * the error stands and the user can retry deliberately.
     */
    const retry = useRef(0)
    useEffect(() => {
      if (!profiles.error || retry.current >= 3) return undefined
      const delay = 400 * 2 ** retry.current
      const timer = setTimeout(() => {
        retry.current += 1
        actions.loadProfiles()
      }, delay)
      return () => clearTimeout(timer)
    }, [profiles.error])

    const testResult = state.ui.testResult
    const notice = state.ui.notice

    const runTest = async (profile) => {
      setTestingId(profile.id)
      try {
        await actions.testProfile({ profileId: profile.id })
      } finally {
        // The result stays visible on the row; the spinner stops either way.
      }
    }

    /**
     * Deleting a profile is irreversible (it drops the stored credential
     * references), so it goes through the chrome's danger dialog — which refuses
     * (`false`) when no confirmation host is mounted, i.e. fail-closed.
     */
    const confirmDelete = async (profile) => {
      const chrome = conn().chrome()
      const danger = chrome && typeof chrome.danger === 'function' ? chrome.danger : null
      const approved = danger
        ? await danger('deleteProfile', {
            title: conn().t('conn.delete'),
            body: conn().t('conn.confirm.delete', { name: profile.name || conn().targetOf(profile) }),
          })
        : false
      if (approved === true) await actions.deleteProfile(profile.id)
    }

    const groups = conn().groupProfiles(profiles.items, state.panel.query)
    const total = profiles.items.length
    const shown = groups.reduce((sum, group) => sum + group.items.length, 0)

    return h(
      'div',
      { className: 'dsh-ssh-conn', 'data-testid': 'ssh-conn-list' },
      h(
        'div',
        { className: 'dsh-ssh-conn-toolbar' },
        h(
          'div',
          { className: 'dsh-ssh-conn-search' },
          h(Input, {
            value: state.panel.query,
            onChange: (next) => actions.setQuery(next),
            placeholder: conn().t('conn.list.search'),
            dataTestId: 'ssh-conn-search',
          }),
        ),
        h(
          Button,
          { onClick: () => actions.loadProfiles(), disabled: profiles.loading === true, dataTestId: 'ssh-conn-refresh' },
          conn().t('ws.files.refresh'),
        ),
        h(
          Button,
          { kind: 'primary', onClick: () => actions.openForm(null), dataTestId: 'ssh-conn-new' },
          conn().t('conn.new'),
        ),
      ),

      notice && notice.tone === 'error'
        ? h(
            'div',
            { className: 'dsh-ssh-conn-notice', 'data-tone': 'error', 'data-testid': 'ssh-conn-notice' },
            conn().errorText(notice.error),
          )
        : null,
      notice && notice.tone === 'ok'
        ? h('div', { className: 'dsh-ssh-conn-notice', 'data-tone': 'ok', 'data-testid': 'ssh-conn-notice-ok' }, conn().t(notice.messageKey))
        : null,

      h(
        'div',
        { className: 'dsh-ssh-conn-scroll', 'data-testid': 'ssh-conn-scroll' },
        profiles.loading === true && total === 0 ? h(Spinner, { size: 12 }) : null,
        profiles.error
          ? h('div', { className: 'dsh-ssh-conn-notice', 'data-tone': 'error', 'data-testid': 'ssh-conn-error' },
              conn().errorText(profiles.error))
          : null,

        total === 0 && profiles.loading !== true
          ? h(
              'div',
              { className: 'dsh-ssh-conn-empty', 'data-testid': 'ssh-conn-empty' },
              h('span', { className: 'dsh-ssh-hint' }, conn().t('conn.list.empty')),
              h(
                Button,
                { kind: 'primary', onClick: () => actions.openForm(null), dataTestId: 'ssh-conn-empty-new' },
                conn().t('conn.new'),
              ),
            )
          : null,

        // A query that matches nothing is a different situation from an empty store.
        total > 0 && shown === 0
          ? h('div', { className: 'dsh-ssh-conn-empty', 'data-testid': 'ssh-conn-no-match' },
              h('span', { className: 'dsh-ssh-hint' }, conn().t('conn.list.empty')))
          : null,

        groups.map((group) =>
          h(
            'div',
            { key: group.group || '__ungrouped__', 'data-testid': `ssh-conn-group-${group.group || 'ungrouped'}` },
            group.group
              ? h(
                  'div',
                  { className: 'dsh-ssh-conn-group' },
                  h('span', { className: 'dsh-ssh-conn-group-name' }, group.group),
                  h('span', { className: 'dsh-ssh-conn-group-count' }, `${group.items.length}`),
                )
              : null,
            group.items.map((profile) =>
              h(ProfileRow, {
                key: profile.id,
                profile,
                session: conn().sessionForProfile(state.sessions.items, profile.id),
                app,
                testing: testingId === profile.id,
                testResult,
                onTest: runTest,
                onDelete: confirmDelete,
              }),
            ),
          ),
        ),
      ),
    )
  }

  return { ConnList, ProfileRow }
})
