/**
 * §4.2 connection profiles.
 *
 * Two invariants from the ICD are enforced here rather than trusted to the UI:
 *
 *   - **Nothing that leaves this file contains a plaintext credential.** Every
 *     profile crosses the wire through `toConnProfileView`, whose `secrets` member
 *     is a presence/provenance/fixed-mask triple; the reference *names* travel
 *     alongside because a reference is not a secret and without it an edited
 *     profile could not be saved back without orphaning its stored credential
 *     (ICD v1.0.5).
 *   - **A secret is written through the credential seam, never into the profile
 *     file.** `setSecret` delegates to the resolver, which stores the value with
 *     `ctx.credentials` and writes only the reference into the profile.
 *
 * `setSecret`'s answer is a deliberate superset of the frozen `{ ref }`:
 * `persisted: false` means "this value is good for the current process only" —
 * the documented outcome when the launching environment already supplies the
 * reference (that value is read-only for this run). It is a **normal degradation,
 * not a failure**, and the UI is expected to say so instead of showing an error.
 */

import { SECRET_MASK } from '../redact.js'
import {
  toConnProfileView,
  type ConnProfile,
  type ConnProfileInput,
  type ConnProfilePatch,
  type ConnProfileView,
} from '../store.js'
import { SshError, toErrorInfo, type ErrorInfo, type HostKeyPolicy } from '../protocol.js'
import { objectJson, optionalBoolean, optionalString, requiredEnum, requiredString, type Params } from './params.js'
import { ApiGroup, transientProfile, sessionsForProfile, type ApiDeps } from './deps.js'

/** One profile, projected for the wire. */
async function viewOf(deps: ApiDeps, profile: ConnProfile): Promise<ConnProfileView> {
  const secrets = await deps.credentials.describe(profile)
  return toConnProfileView(profile, secrets)
}

export class ProfilesApi extends ApiGroup {
  /** ICD §4.2 `listProfiles`. */
  async list(): Promise<{ profiles: ConnProfileView[] }> {
    const profiles = this.deps.store.list()
    // `describe` is async (it may consult the credential store), so the profiles
    // are projected concurrently rather than one round trip at a time.
    const views = await Promise.all(profiles.map((profile) => viewOf(this.deps, profile)))
    return { profiles: views }
  }

  /** ICD §4.2 `saveProfile`. */
  async save(params: Params): Promise<{ profile: ConnProfileView }> {
    const patch = objectJson(params, 'profile', (name) => this.warnDirect(name))
    if (patch === undefined) throw new SshError('SSH_CFG_INVALID', 'profile is required (JSON-encoded in profileJson)')
    const saved = await this.deps.store.save(patch as ConnProfilePatch)
    const view = await viewOf(this.deps, saved)
    this.audit({ op: 'saveProfile', outcome: 'ok', profileId: saved.id, target: { host: saved.host, port: saved.port, user: saved.user } })
    return { profile: view }
  }

  /** ICD §4.2 `deleteProfile`. */
  async remove(params: Params): Promise<{ deleted: true }> {
    const profileId = requiredString(params, 'profileId')
    const removed = await this.deps.store.remove(profileId)
    if (!removed) {
      this.audit({ op: 'deleteProfile', outcome: 'error', profileId, detail: { reason: 'unknown profile' } })
      throw new SshError('SSH_CFG_INVALID', `no profile with id "${profileId}"`, { details: { profileId } })
    }
    this.audit({ op: 'deleteProfile', outcome: 'ok', profileId })
    return { deleted: true }
  }

  /** ICD §4.2 `duplicateProfile`. */
  async duplicate(params: Params): Promise<{ profile: ConnProfileView }> {
    const profileId = requiredString(params, 'profileId')
    const name = optionalString(params, 'name')
    const copy = await this.deps.store.duplicate(profileId, name)
    this.audit({ op: 'duplicateProfile', outcome: 'ok', profileId: copy.id, detail: { from: profileId } })
    return { profile: await viewOf(this.deps, copy) }
  }

  /**
   * ICD §4.2 `testProfile`: connect once, report what happened, leave nothing behind.
   *
   * If the profile is already connected the answer is derived from that live
   * session — re-connecting (and then closing) could tear down the connection the
   * user is working in, which is a spectacular way for a "test" button to break a
   * terminal.
   */
  async test(params: Params): Promise<{ ok: boolean; latencyMs?: number; serverBanner?: string; hostKeyFingerprint?: string; error?: ErrorInfo }> {
    const profile = await this.profileFrom(params)
    const { password, passphrase } = this.oneShot(params)
    const existing = profile.id === undefined ? [] : sessionsForProfile(this.deps, profile.id)
    const live = existing[0]

    if (live !== undefined) {
      this.audit({ op: 'testProfile', outcome: 'ok', profileId: profile.id, detail: { reused: true } })
      return {
        ok: true,
        ...(live.metrics.connectMs === undefined ? {} : { latencyMs: live.metrics.connectMs }),
        ...(this.fingerprintFor(profile.host, profile.port) === undefined ? {} : { hostKeyFingerprint: this.fingerprintFor(profile.host, profile.port) }),
      }
    }

    const started = this.now()
    try {
      const resolved = await this.deps.credentials.resolveProfile(profile, {
        ...(password === undefined ? {} : { password }),
        ...(passphrase === undefined ? {} : { passphrase }),
      })
      const handle = await this.deps.pool.acquire({
        profile: resolved,
        label: `${profile.name} (test)`,
        forceNew: true,
        onHostKeyPrompt: (question) => this.promptHostKey(question),
      })
      const latencyMs = Math.max(0, this.now() - started)
      const fingerprint = this.fingerprintFor(profile.host, profile.port)
      // A test must not leave a session behind: it is closed before answering, so
      // the session list the user sees is exactly the one they built.
      await handle.close({ reason: 'test' })
      this.audit({
        op: 'testProfile',
        outcome: 'ok',
        ...(profile.id === undefined ? {} : { profileId: profile.id }),
        target: { host: profile.host, port: profile.port, user: profile.user },
        durationMs: latencyMs,
      })
      return { ok: true, latencyMs, ...(fingerprint === undefined ? {} : { hostKeyFingerprint: fingerprint }) }
    } catch (error) {
      const info = toErrorInfo(error)
      this.audit({
        op: 'testProfile',
        outcome: 'error',
        ...(profile.id === undefined ? {} : { profileId: profile.id }),
        target: { host: profile.host, port: profile.port, user: profile.user },
        durationMs: Math.max(0, this.now() - started),
        detail: { code: info.code, message: info.message },
      })
      return { ok: false, error: info }
    }
  }

  /** ICD §4.2 `setSecret`. */
  async setSecret(params: Params): Promise<{ ref: string; masked: string; persisted: boolean; reason?: string }> {
    const profileId = requiredString(params, 'profileId')
    const field = requiredEnum(params, 'field', ['password', 'passphrase'] as const)
    const value = requiredString(params, 'value')
    const persist = optionalBoolean(params, 'persist') ?? true

    const result = await this.deps.credentials.set(profileId, field, value, persist)
    this.audit({
      op: 'setSecret',
      outcome: 'ok',
      profileId,
      // `ref` is a reference name and `persisted` says whether it is durable;
      // neither is a secret, and the value is never recorded.
      detail: { field, ref: result.ref, persisted: result.persisted, ...(result.reason === undefined ? {} : { reason: result.reason }) },
    })
    return {
      ref: result.ref,
      masked: SECRET_MASK,
      persisted: result.persisted,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    }
  }

  /** ICD §4.2 `clearSecret`. */
  async clearSecret(params: Params): Promise<{ cleared: true }> {
    const profileId = requiredString(params, 'profileId')
    const field = requiredEnum(params, 'field', ['password', 'passphrase'] as const)
    await this.deps.credentials.clear(profileId, field)
    this.audit({ op: 'clearSecret', outcome: 'ok', profileId, detail: { field } })
    return { cleared: true }
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** The profile a request names: by id, by inline body, or the two combined (an error). */
  private async profileFrom(params: Params): Promise<ConnProfile> {
    const profileId = optionalString(params, 'profileId')
    const inline = objectJson(params, 'profile', (name) => this.warnDirect(name))
    if (profileId !== undefined && inline !== undefined) {
      throw new SshError('SSH_CFG_INVALID', 'provide either profileId or inline profile, not both (ICD §4.3)')
    }
    if (profileId !== undefined) {
      const stored = this.deps.store.get(profileId)
      if (stored === undefined) throw new SshError('SSH_CFG_INVALID', `no profile with id "${profileId}"`, { details: { profileId } })
      // A stored profile may carry secret references; feeding it back through the
      // temporary-profile path would re-validate them (harmless) but it must keep
      // its own id and policy, so the stored object is used as-is.
      return stored
    }
    if (inline === undefined) throw new SshError('SSH_CFG_INVALID', 'profileId or an inline profile is required')
    return transientProfile(this.deps, inline as ConnProfileInput)
  }

  private oneShot(params: Params): { password?: string; passphrase?: string } {
    const secrets = objectJson(params, 'secrets', (name) => this.warnDirect(name))
    if (secrets === undefined) return {}
    const out: { password?: string; passphrase?: string } = {}
    if (typeof secrets['password'] === 'string' && secrets['password'] !== '') out.password = secrets['password']
    if (typeof secrets['passphrase'] === 'string' && secrets['passphrase'] !== '') out.passphrase = secrets['passphrase']
    return out
  }

  private fingerprintFor(host: string, port: number): string | undefined {
    return this.deps.lastFingerprint?.(host, port)
  }

  /**
   * A host-key prompt reached an endpoint with no UI waiting on it (`testProfile`
   * has no session to key the prompt against), so it is refused explicitly rather
   * than left hanging: the structured error tells the user to connect (where the
   * prompt is wired) or to trust the key first.
   */
  private async promptHostKey(question: { host: string; port: number; fingerprint: string }): Promise<'reject'> {
    this.audit({
      op: 'hostKeyPrompt',
      outcome: 'denied',
      target: { host: question.host, port: question.port, user: '' },
      detail: { fingerprint: question.fingerprint, context: 'testProfile' },
    })
    return 'reject'
  }

  private warnDirect(name: string): void {
    this.log.warn(`${name} arrived as a nested object; the wire convention is ${name}Json (ICD §12 R1.3)`, { name })
  }
}
