/**
 * @module ssh.conn.form
 * @order 130
 *
 * `ConnForm` — create, edit, test and connect one connection profile.
 *
 * **Credential discipline** (ICD §4.2 invariant, task constraint 3):
 *
 * - a typed password/passphrase lives in *this component's* state and nowhere else:
 *   not in the store, not in `localStorage`, not in a `data-*`/`title`/`aria-*`
 *   attribute, not in an error message, not in a log line;
 * - the form sends a profile with `secretRefs` only; a new secret travels through
 *   `setSecret` (durable) or `connect`'s one-shot `secrets` (never persisted);
 * - what the user sees for a *stored* secret is the host's fixed-width mask
 *   (`••••••••`), so the mask cannot leak the length;
 * - the fields are cleared as soon as the operation finishes.
 *
 * `persisted: false` from `setSecret` is the documented read-only/one-shot
 * degradation: it is reported as a warning with the host's own reason, never as a
 * failure (the connection still works for this session).
 */

SSH.define('ssh.conn.form', function (SSH) {
  const { useState } = SSH.react
  const h = SSH.h
  const conn = () => SSH.require('ssh.conn.ui')

  /** A short remark line: tone + text, used for test results and secret notices. */
  function Notice(props) {
    if (!props.text) return null
    return h(
      'div',
      { className: 'dsh-ssh-conn-notice', 'data-tone': props.tone || 'neutral', 'data-testid': props.dataTestId },
      h('span', null, props.text),
    )
  }

  /**
   * `ConnForm`.
   * @param {{app: {useApp: Function, actions: object}}} props
   */
  function ConnForm(props) {
    const { app } = props
    const { Button, Input, Select, Field } = conn().ui()
    const state = app.useApp()
    const actions = app.actions
    const draft = state.panel.form
    const editingId = state.panel.editingId
    const previous = editingId ? state.profiles.items.find((item) => item.id === editingId) || null : null

    // Secrets: component-local by design (see the file header).
    const [password, setPassword] = useState('')
    const [passphrase, setPassphrase] = useState('')
    const [reveal, setReveal] = useState(false)
    const [pending, setPending] = useState(false)

    conn().ensureStyles()

    const stored = conn().secretSummary(previous, 'password')
    const storedPassphrase = conn().secretSummary(previous, 'passphrase')
    const busy = pending || state.ui.busy === true

    const set = (patch) => actions.setForm(patch)
    const nameInvalid = String(draft.name || '').trim() === ''
    const hostInvalid = String(draft.host || '').trim() === ''
    const userInvalid = String(draft.user || '').trim() === ''
    const portInvalid = !Number.isFinite(Number(draft.port)) || Number(draft.port) <= 0 || Number(draft.port) > 65535
    const canSubmit = !nameInvalid && !hostInvalid && !userInvalid && !portInvalid

    const input = () => conn().toProfileInput(draft, previous)

    /** Persist a typed credential, then report the degradation honestly. */
    const storeSecrets = async (profileId) => {
      if (String(draft.auth || 'password') === 'password' && password !== '') {
        await actions.setSecret({ profileId, field: 'password', value: password, persist: true })
      }
      if (String(draft.auth || '') === 'privateKey' && passphrase !== '') {
        await actions.setSecret({ profileId, field: 'passphrase', value: passphrase, persist: true })
      }
      setPassword('')
      setPassphrase('')
      setReveal(false)
    }

    /**
     * The main chain: save (create or update) → store a newly typed secret →
     * connect. Nothing is persisted when the save itself failed.
     */
    const saveAndConnect = async () => {
      if (!canSubmit) return
      setPending(true)
      try {
        const saved = await actions.saveProfile(input())
        if (!saved) return
        await storeSecrets(saved.id)
        await actions.connect({ profileId: saved.id })
      } finally {
        setPending(false)
      }
    }

    /** Test the draft as it stands: `testProfile` connects once and leaves nothing. */
    const testDraft = async () => {
      if (!canSubmit) return
      setPending(true)
      try {
        const secrets = {}
        if (password !== '') secrets.password = password
        if (passphrase !== '') secrets.passphrase = passphrase
        const target = previous && !password && !passphrase
          ? { profileId: previous.id }
          : { input: { ...input(), ...(Object.keys(secrets).length > 0 ? { secrets } : {}) } }
        await actions.testProfile(target)
      } finally {
        setPending(false)
      }
    }

    const testResult = state.ui.testResult
    const secretNotice = state.ui.secretNotice
    const authValue = draft.auth || 'password'

    const noticeText = (() => {
      if (secretNotice && secretNotice.error) return conn().errorText(secretNotice.error)
      if (secretNotice && secretNotice.persisted === false) {
        const masked = secretNotice.masked ? ` ${secretNotice.masked}` : ''
        return `${conn().t('conn.secret.present')}${masked}${secretNotice.reason ? ` — ${secretNotice.reason}` : ''}`
      }
      return ''
    })()

    return h(
      'div',
      { className: 'dsh-ssh-conn', 'data-testid': 'ssh-conn-form' },
      h(
        'div',
        { className: 'dsh-ssh-conn-toolbar' },
        h('span', { className: 'dsh-ssh-conn-name' }, editingId ? conn().t('conn.edit') : conn().t('conn.new')),
        h('span', { style: { flex: '1 1 auto' } }),
        h('span', { className: 'dsh-ssh-conn-kicker', 'data-testid': 'ssh-conn-form-target' }, conn().targetOf(draft)),
      ),

      h(
        'div',
        { className: 'dsh-ssh-conn-scroll' },
        h(
          'div',
          { className: 'dsh-ssh-conn-form' },
          h(
            'div',
            { className: 'dsh-ssh-conn-grid' },
            h(Field, { label: conn().t('conn.field.name'), required: true },
              h(Input, {
                value: draft.name,
                onChange: (next) => set({ name: next }),
                invalid: nameInvalid,
                disabled: busy,
                dataTestId: 'ssh-conn-field-name',
              })),
            h(Field, { label: conn().t('conn.field.group') },
              h(Input, {
                value: draft.group,
                onChange: (next) => set({ group: next }),
                disabled: busy,
                dataTestId: 'ssh-conn-field-group',
              })),
            h(
              'div',
              { 'data-span': '2' },
              h(Field, { label: conn().t('conn.field.host'), required: true },
                h(Input, {
                  value: draft.host,
                  onChange: (next) => set({ host: next }),
                  invalid: hostInvalid,
                  disabled: busy,
                  dataTestId: 'ssh-conn-field-host',
                })),
            ),
            h(Field, { label: conn().t('conn.field.port'), required: true },
              h(Input, {
                value: String(draft.port ?? ''),
                onChange: (next) => set({ port: next === '' ? '' : Number(next) }),
                invalid: portInvalid,
                disabled: busy,
                dataTestId: 'ssh-conn-field-port',
              })),
            h(Field, { label: conn().t('conn.field.user'), required: true },
              h(Input, {
                value: draft.user,
                onChange: (next) => set({ user: next }),
                invalid: userInvalid,
                disabled: busy,
                dataTestId: 'ssh-conn-field-user',
              })),
            h(
              'div',
              { 'data-span': '2' },
              h(Field, { label: conn().t('conn.field.auth') },
                h(Select, {
                  value: authValue,
                  options: [
                    { value: 'password', label: conn().t('conn.auth.password') },
                    { value: 'privateKey', label: conn().t('conn.auth.privateKey') },
                    { value: 'agent', label: conn().t('conn.auth.agent') },
                  ],
                  onChange: (next) => set({ auth: next }),
                  disabled: busy,
                  dataTestId: 'ssh-conn-field-auth',
                })),
            ),

            // password (only for password auth): masked input + show/hide toggle.
            authValue === 'password'
              ? h(
                  'div',
                  { className: 'dsh-ssh-conn-secret', 'data-span': '2' },
                  h(Field, {
                    label: conn().t('conn.field.password'),
                    hint: previous
                      ? `${conn().t(stored.labelKey)}${stored.masked ? ` ${stored.masked}` : ''}`
                      : undefined,
                  },
                    h(Input, {
                      value: password,
                      onChange: (next) => setPassword(next),
                      type: reveal ? 'text' : 'password',
                      disabled: busy,
                      dataTestId: 'ssh-conn-field-password',
                    })),
                  h(
                    Button,
                    {
                      onClick: () => setReveal((current) => current !== true),
                      dataTestId: 'ssh-conn-secret-toggle',
                      title: conn().t(reveal ? 'conn.secret.hide' : 'conn.secret.show'),
                    },
                    conn().t(reveal ? 'conn.secret.hide' : 'conn.secret.show'),
                  ),
                )
              : null,

            // private key auth: path + optional passphrase.
            authValue === 'privateKey'
              ? h(
                  'div',
                  { 'data-span': '2' },
                  h(Field, { label: conn().t('conn.field.privateKey') },
                    h(Input, {
                      value: draft.privateKeyPath,
                      onChange: (next) => set({ privateKeyPath: next }),
                      disabled: busy,
                      dataTestId: 'ssh-conn-field-private-key',
                    })),
                )
              : null,
            authValue === 'privateKey'
              ? h(
                  'div',
                  { className: 'dsh-ssh-conn-secret', 'data-span': '2' },
                  h(Field, {
                    label: conn().t('conn.field.passphrase'),
                    hint: previous
                      ? `${conn().t(storedPassphrase.labelKey)}${storedPassphrase.masked ? ` ${storedPassphrase.masked}` : ''}`
                      : undefined,
                  },
                    h(Input, {
                      value: passphrase,
                      onChange: (next) => setPassphrase(next),
                      type: reveal ? 'text' : 'password',
                      disabled: busy,
                      dataTestId: 'ssh-conn-field-passphrase',
                    })),
                )
              : null,

            h(Field, { label: conn().t('conn.field.timeout') },
              h(Input, {
                value: String(draft.connectTimeoutMs ?? ''),
                onChange: (next) => set({ connectTimeoutMs: next === '' ? '' : Number(next) }),
                disabled: busy,
                dataTestId: 'ssh-conn-field-timeout',
              })),
            h(Field, { label: conn().t('conn.field.keepalive') },
              h(Input, {
                value: String(draft.keepaliveIntervalMs ?? ''),
                onChange: (next) => set({ keepaliveIntervalMs: next === '' ? '' : Number(next) }),
                disabled: busy,
                dataTestId: 'ssh-conn-field-keepalive',
              })),
            h(
              'div',
              { 'data-span': '2' },
              h(Field, { label: conn().t('conn.field.tags') },
                h(Input, {
                  value: draft.tags,
                  onChange: (next) => set({ tags: next }),
                  disabled: busy,
                  dataTestId: 'ssh-conn-field-tags',
                })),
            ),
          ),

          testResult && testResult.pending !== true
            ? h(Notice, {
                tone: testResult.ok === true ? 'ok' : 'error',
                dataTestId: 'ssh-conn-test-result',
                text:
                  testResult.ok === true
                    ? conn().t('conn.test.ok', { latencyMs: Math.round(Number(testResult.latencyMs) || 0) })
                    : conn().t('conn.test.fail', { message: conn().errorText(testResult.error) }),
              })
            : null,
          secretNotice && noticeText
            ? h(Notice, {
                tone: secretNotice.error ? 'error' : 'warn',
                dataTestId: 'ssh-conn-secret-notice',
                text: noticeText,
              })
            : null,
          state.ui.notice && state.ui.notice.tone === 'error'
            ? h(Notice, { tone: 'error', dataTestId: 'ssh-conn-form-error', text: conn().errorText(state.ui.notice.error) })
            : null,
        ),
      ),

      h(
        'div',
        { className: 'dsh-ssh-conn-footer' },
        h(
          Button,
          { kind: 'primary', onClick: saveAndConnect, disabled: !canSubmit || busy, loading: pending, dataTestId: 'ssh-conn-submit' },
          conn().t('conn.connect'),
        ),
        h(
          Button,
          { onClick: testDraft, disabled: !canSubmit || busy, dataTestId: 'ssh-conn-test-draft' },
          conn().t('conn.test'),
        ),
        h('span', { style: { flex: '1 1 auto' } }),
        h(
          Button,
          { onClick: () => actions.setPanel({ view: 'list' }), disabled: busy, dataTestId: 'ssh-conn-cancel' },
          conn().t('chrome.confirm.cancel'),
        ),
      ),
    )
  }

  return { ConnForm, Notice }
})
