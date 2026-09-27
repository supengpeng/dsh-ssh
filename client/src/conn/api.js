/**
 * @module ssh.conn.api
 * @order 110
 *
 * The connection manager's endpoint client: the **only** place that turns
 * user intent into `sshPlugin/*` calls.
 *
 * Two rules from the wire contract live here, deliberately in one file:
 *
 * 1. **R1.3 — flat primitives only.** The carrier delivers a rich payload lossily
 *    (M0 §7.2: a six-key object arrived as two keys, dropping the string *after*
 *    the nested object), so a nested structure travels as `<field>Json` and is
 *    decoded on the host (`src/api/params.ts`). `assertFlat()` turns a
 *    regression into a loud `SSH_CFG_INVALID` instead of a field that silently
 *    disappears — the user-visible form of which is "I clicked and nothing
 *    happened".
 * 2. **Credentials.** A plaintext password never travels in a profile: profiles
 *    carry `secretRefs` only, and a password is either stored with `setSecret`
 *    or passed once through `connect`'s in-memory `secrets`. Every profile-shaped
 *    payload is stripped here before it is serialised, so no caller can leak one
 *    by accident.
 */

SSH.define('ssh.conn.api', function (SSH) {
  /** Endpoint timeouts: a real SSH handshake (plus a host-key prompt) is slow. */
  const TIMEOUTS = Object.freeze({ list: 10000, unary: 15000, connect: 40000 })

  let rt = { bridge: null, app: null }

  function configure(next) {
    rt = { ...rt, ...next }
    return rt
  }

  function bridge() {
    if (rt.bridge && typeof rt.bridge.call === 'function') return rt.bridge
    throw {
      code: 'SSH_STATE_INVALID',
      message: 'the connection manager is not wired to the host (ssh.conn.api.configure)',
      retryable: false,
    }
  }

  function asError(error) {
    if (error && typeof error === 'object' && typeof error.code === 'string') return error
    return {
      code: 'SSH_UNKNOWN',
      message: error && error.message ? error.message : String(error),
      retryable: false,
    }
  }

  /**
   * Reject a payload the carrier would deliver lossily.
   *
   * `undefined` members are dropped (they mean "leave it out"), but a nested
   * object/array at this level is a bug in the caller: it must be JSON-encoded
   * into `<field>Json` instead.
   */
  function assertFlat(params, method) {
    const out = {}
    for (const [key, value] of Object.entries(params || {})) {
      if (value === undefined) continue
      if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        out[key] = value
        continue
      }
      if (Array.isArray(value) || typeof value === 'object') {
        // The documented alternative is the `<field>Json` string.
        if (key.endsWith('Json')) {
          out[key] = JSON.stringify(value)
          continue
        }
        throw {
          code: 'SSH_CFG_INVALID',
          message: `${method}: parameter "${key}" must be a primitive (JSON-encode it as "${key}Json")`,
          retryable: false,
        }
      }
      throw {
        code: 'SSH_CFG_INVALID',
        message: `${method}: parameter "${key}" has unsupported type ${typeof value}`,
        retryable: false,
      }
    }
    return out
  }

  /** One unary call: flat params, one timeout policy, one error shape. */
  async function call(method, params, timeoutMs) {
    const payload = assertFlat(params, method)
    try {
      return await bridge().call(method, payload, { timeoutMs })
    } catch (error) {
      throw asError(error)
    }
  }

  /** The profile fields that are credentials, by definition (ICD §4.2 invariant). */
  const SECRET_FIELDS = Object.freeze(['password', 'passphrase', 'secrets', 'passwordRef', 'passphraseRef'])

  /**
   * Build the payload for a profile-shaped parameter.
   *
   * `secretRefs` travels (it is a reference name, not a secret — it is what lets
   * an edited form round-trip without silently dropping a stored credential),
   * while anything credential-shaped is removed: `setSecret` and `connect`'s
   * one-shot `secrets` are the only carriers for a plaintext value.
   */
  function profilePayload(input) {
    const out = {}
    for (const [key, value] of Object.entries(input || {})) {
      if (SECRET_FIELDS.includes(key)) continue
      if (value === undefined) continue
      out[key] = value
    }
    return out
  }

  const api = {
    configure,
    /** Exposed so a caller can report the transport honestly. */
    wired: () => Boolean(rt.bridge && typeof rt.bridge.call === 'function'),

    async listProfiles() {
      const result = await call('listProfiles', {}, TIMEOUTS.list)
      return Array.isArray(result && result.profiles) ? result.profiles : []
    },

    /** Create or update. Returns the stored projection (`ConnProfileView`). */
    async saveProfile(input) {
      const profile = profilePayload(input)
      const result = await call('saveProfile', { profileJson: profile }, TIMEOUTS.unary)
      return result && result.profile ? result.profile : null
    },

    async deleteProfile(profileId) {
      const result = await call('deleteProfile', { profileId }, TIMEOUTS.unary)
      return Boolean(result && result.deleted)
    },

    async duplicateProfile(profileId, name) {
      const result = await call('duplicateProfile', { profileId, name: name || undefined }, TIMEOUTS.unary)
      return result && result.profile ? result.profile : null
    },

    /**
     * Test a stored profile (`{profileId}`) or an unsaved draft (`{input}`).
     * `testProfile` leaves nothing behind, so it is safe from the form.
     */
    async testProfile(target) {
      const params = target && target.profileId ? { profileId: target.profileId } : { profileJson: profilePayload(target && target.input) }
      const result = await call('testProfile', params, TIMEOUTS.connect)
      return result || { ok: false, error: { code: 'SSH_UNKNOWN', message: 'empty result' } }
    },

    /**
     * Store a credential. `persist: true` asks for durability; the host answers
     * `persisted: false` when the credential store is read-only — a normal
     * degradation the UI reports, never an error.
     */
    async setSecret(request) {
      const result = await call(
        'setSecret',
        {
          profileId: request.profileId,
          field: request.field,
          value: request.value,
          persist: request.persist !== false,
        },
        TIMEOUTS.unary,
      )
      return result || { ref: '', masked: '', persisted: request.persist !== false }
    },

    async clearSecret(request) {
      const result = await call('clearSecret', { profileId: request.profileId, field: request.field }, TIMEOUTS.unary)
      return Boolean(result && result.cleared)
    },

    /**
     * Connect. `profileId` and `inline` are mutually exclusive (ICD §4.3); a
     * one-shot `secrets` object is allowed for a profile whose credential is not
     * stored and is never persisted on this side.
     */
    async connect(request = {}) {
      const params = {}
      if (request.profileId) params.profileId = request.profileId
      if (request.inline) params.inlineJson = profilePayload(request.inline)
      if (request.name) params.name = request.name
      if (request.secrets) params.secretsJson = { ...request.secrets }
      const result = await call('connect', params, TIMEOUTS.connect)
      return result && result.session ? result.session : null
    },

    async disconnect(sessionId, force) {
      const result = await call('disconnect', { sessionId, force: force === true ? true : undefined }, TIMEOUTS.unary)
      return result && result.session ? result.session : null
    },

    async listSessions() {
      const result = await call('listSessions', {}, TIMEOUTS.list)
      return Array.isArray(result && result.sessions) ? result.sessions : []
    },

    // Exported for the tests and for a caller that must build a payload itself.
    assertFlat,
    profilePayload,
    SECRET_FIELDS,
    TIMEOUTS,
  }

  return api
})
