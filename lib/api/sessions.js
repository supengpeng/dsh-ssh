/**
 * §4.3 sessions: connect, disconnect, list, get, follow, and the host-key
 * accept/reject flow.
 *
 * ## `connect` never silently changes trust
 *
 * `accept-new` trusts a first-seen key and records it (OpenSSH's semantics). A
 * *changed* key is never accepted by any policy, and `strict` never accepts an
 * unknown one: both raise a **pending question** that the user answers through
 * `decideHostKey`, which is what makes `pendingHostKey` meaningful instead of
 * decorative. Until the answer arrives the connect call is parked, not failed —
 * and it gives up after `connectTimeoutMs`, because a prompt nobody answers must
 * not hold a connection attempt forever.
 *
 * ## `inline` versus `profileId`
 *
 * The ICD requires exactly one of them. An inline profile is validated through the
 * same `normalizeProfile` as a stored one (so a plaintext cannot ride in), but it
 * is **not persisted**: `connect` is not `saveProfile`, and writing a profile the
 * user did not ask to keep would be a side effect they cannot see.
 */
import { SshError, toErrorInfo } from '../protocol.js';
import { objectJson, optionalBoolean, optionalString, requiredString } from './params.js';
import { ApiGroup, transientProfile } from './deps.js';
import { FrameQueue } from './frames.js';
export class SessionsApi extends ApiGroup {
    pending = new Map();
    /** Connect attempts and their pending prompts, keyed by the attempt handle. */
    attemptSeq = 0;
    /** ICD §4.3 `connect`. */
    async connect(params) {
        const profileId = optionalString(params, 'profileId');
        // The ICD names this parameter `inline` (the profile body itself), so the wire
        // field is `inlineJson` — not `profileJson`, which is `testProfile`'s.
        const inline = objectJson(params, 'inline', (name) => this.warnDirect(name));
        const label = optionalString(params, 'name');
        const oneShot = this.oneShot(params);
        if (profileId !== undefined && inline !== undefined) {
            throw new SshError('SSH_CFG_INVALID', 'provide either profileId or inline, not both (ICD §4.3)');
        }
        if (profileId === undefined && inline === undefined) {
            // A caller that sent `profile`/`profileJson` mistook `connect` for
            // `testProfile`. This is not tolerance — the call still fails — but naming
            // the mistake instead of the symptom turns a puzzling "needs an inline
            // profile" into a one-line fix. (The tools layer had exactly this mix-up;
            // `api-tools.test.mjs` now covers the seam.)
            const mistaken = params['profile'] !== undefined || optionalString(params, 'profileJson') !== undefined;
            throw new SshError('SSH_CFG_INVALID', mistaken
                ? 'connect reads its inline profile from `inline`/`inlineJson`; `profile`/`profileJson` belongs to testProfile'
                : 'connect needs a profileId or an inline profile');
        }
        let profile;
        let persisted = true;
        if (profileId !== undefined) {
            const stored = this.deps.store.get(profileId);
            if (stored === undefined)
                throw new SshError('SSH_CFG_INVALID', `no profile with id "${profileId}"`, { details: { profileId } });
            profile = stored;
        }
        else {
            profile = transientProfile(this.deps, inline);
            persisted = false;
        }
        // `inline.forceNew === true` is the ICD's own spelling (ICD §4.3); a top-level
        // `forceNew` is accepted too so a caller may force it without a body.
        const forceNew = (inline !== undefined && inline['forceNew'] === true) || optionalBoolean(params, 'forceNew') === true;
        const started = this.now();
        const attempt = `connect_${(this.attemptSeq += 1).toString(36)}_${started.toString(36)}`;
        try {
            const resolved = await this.deps.credentials.resolveProfile(profile, oneShot);
            const handle = await this.deps.pool.acquire({
                profile: resolved,
                ...(label === undefined ? {} : { label }),
                forceNew,
                onHostKeyPrompt: (question) => this.askHostKey(attempt, question),
            });
            const info = this.deps.registry.get(handle.id) ?? this.infoOf(handle.id, profile, label);
            if (persisted)
                void this.deps.store.touch(profile.id).catch(() => undefined);
            this.audit({
                op: 'connect',
                outcome: 'ok',
                ...(persisted ? { profileId: profile.id } : {}),
                sessionId: info.id,
                target: { host: profile.host, port: profile.port, user: profile.user },
                durationMs: Math.max(0, this.now() - started),
            });
            return { session: info };
        }
        catch (error) {
            const info = toErrorInfo(error);
            this.audit({
                op: 'connect',
                outcome: error instanceof SshError && error.code === 'SSH_CANCELLED' ? 'denied' : 'error',
                ...(persisted ? { profileId: profile.id } : {}),
                target: { host: profile.host, port: profile.port, user: profile.user },
                durationMs: Math.max(0, this.now() - started),
                detail: { code: info.code, message: info.message },
            });
            throw error;
        }
        finally {
            this.forgetAttempt(attempt);
        }
    }
    /** ICD §4.3 `disconnect`. */
    async disconnect(params) {
        const sessionId = requiredString(params, 'sessionId');
        const force = optionalBoolean(params, 'force') === true;
        const before = this.deps.registry.get(sessionId);
        const session = this.deps.pool.get(sessionId);
        if (session === undefined) {
            throw new SshError('SSH_STATE_INVALID', `no live session with id "${sessionId}"`, { details: { sessionId } });
        }
        try {
            await session.close({ force, reason: 'user' });
        }
        catch (error) {
            // A close that fails on a force request is still a close as far as the user
            // is concerned; report it but do not pretend the session is alive.
            this.log.warn('session close reported an error', { sessionId, reason: error instanceof Error ? error.message : String(error) });
        }
        const after = this.deps.registry.get(sessionId) ?? before ?? this.placeholderInfo(sessionId);
        this.audit({ op: 'disconnect', outcome: 'ok', sessionId, detail: { force } });
        return { session: { ...after, state: 'closed' } };
    }
    /** ICD §4.3 `listSessions`. */
    listSessions() {
        return { sessions: this.deps.registry.list() };
    }
    /** ICD §4.3 `getSession`. */
    getSession(params) {
        const sessionId = requiredString(params, 'sessionId');
        const info = this.deps.registry.get(sessionId);
        if (info === undefined) {
            throw new SshError('SSH_STATE_INVALID', `no session with id "${sessionId}"`, {
                details: { sessionId, sessions: this.deps.registry.list().map((session) => session.id) },
            });
        }
        return { session: info };
    }
    /**
     * ICD §4.3 `followSessions` (stream `state` frames).
     *
     * The current snapshot is emitted first: the client subscribes and *then* calls
     * `listSessions` would otherwise open a window in which a session that appeared
     * between the two calls is never announced.
     */
    async *follow() {
        const queue = new FrameQueue();
        const emit = (info) => {
            queue.push({ t: 'state', sessionId: info.id, state: info.state, ...(info.error === undefined ? {} : { error: info.error }) });
        };
        for (const info of this.deps.registry.list())
            emit(info);
        const unsubscribe = this.deps.registry.subscribe((info) => emit(info));
        try {
            for await (const frame of queue)
                yield frame;
        }
        finally {
            unsubscribe();
        }
    }
    /**
     * ICD §4.3 `pendingHostKey`: every question currently waiting for an answer.
     *
     * `sessionId` is the handle the caller must pass to `decideHostKey`. While the
     * connection is still being established there is no session id yet, so the
     * attempt's own handle is reported — the field is a decision token, and the
     * ICD's `SessionId` type is a string.
     */
    pendingHostKey(params) {
        const filter = optionalString(params, 'sessionId');
        const entries = [...this.pending.values()]
            .filter((entry) => filter === undefined || entry.key === filter)
            .map((entry) => ({
            sessionId: entry.key,
            host: entry.host,
            port: entry.port,
            keyType: entry.keyType,
            fingerprint: entry.fingerprint,
            knownHostsMatch: entry.knownHostsMatch,
        }));
        return { pending: entries };
    }
    /** ICD §4.3 `decideHostKey`. */
    async decideHostKey(params) {
        const sessionId = requiredString(params, 'sessionId');
        const accept = optionalBoolean(params, 'accept') === true;
        const remember = optionalBoolean(params, 'remember') === true;
        const entry = this.pending.get(sessionId);
        if (entry === undefined) {
            throw new SshError('SSH_STATE_INVALID', `no host-key question is pending for "${sessionId}"`, { details: { sessionId } });
        }
        entry.decide(accept ? 'accept' : 'reject', remember);
        this.audit({
            op: 'decideHostKey',
            outcome: accept ? 'ok' : 'denied',
            target: { host: entry.host, port: entry.port, user: '' },
            detail: { keyType: entry.keyType, fingerprint: entry.fingerprint, knownHostsMatch: entry.knownHostsMatch, remember },
        });
        return { decided: true };
    }
    // ── internals ────────────────────────────────────────────────────────────
    /**
     * Park a connect attempt on a user decision.
     *
     * The waiting promise is raced against `connectTimeoutMs`: an unanswered prompt
     * must not hold the connection attempt (and the pool slot) forever, and a
     * timeout is reported as `SSH_TIMEOUT_CONNECT` — the same code the user would
     * see if the handshake itself had stalled.
     */
    askHostKey(attempt, question) {
        const key = `${attempt}#${this.pending.size + 1}`;
        return new Promise((resolve) => {
            let settled = false;
            const finish = (answer, remember) => {
                if (settled)
                    return;
                settled = true;
                this.pending.delete(key);
                clearTimeout(timer);
                if (remember && answer === 'accept') {
                    // The prompt carries a fingerprint, not the key, so the *key material of
                    // the handshake in flight* is what gets persisted — captured by the
                    // verifier wrapper the runtime installs (see `ApiDeps.lastHostKey`).
                    // With no captured key nothing is written: a made-up entry in
                    // known_hosts would be worse than no entry at all.
                    const material = this.deps.lastHostKey?.(question.host, question.port);
                    if (material === undefined) {
                        this.log.warn('the accepted host key could not be remembered: no key material was captured', {
                            host: question.host,
                            port: question.port,
                        });
                    }
                    else {
                        void this.deps.knownHosts
                            .remember({ host: question.host, port: question.port, keyType: material.keyType, key: material.key })
                            .catch((error) => this.log.warn('could not remember the accepted host key', {
                            reason: error instanceof Error ? error.message : String(error),
                        }));
                    }
                }
                resolve(answer);
            };
            const timer = setTimeout(() => {
                this.log.warn('host-key prompt timed out', { host: question.host, port: question.port, fingerprint: question.fingerprint });
                finish('reject', false);
            }, Math.max(1000, this.config.connectTimeoutMs));
            // Node keeps the process alive for a pending timer otherwise.
            timer.unref?.();
            this.pending.set(key, {
                key,
                host: question.host,
                port: question.port,
                keyType: question.keyType,
                fingerprint: question.fingerprint,
                knownHostsMatch: question.knownHostsMatch,
                createdAt: this.now(),
                decide: finish,
            });
            this.audit({
                op: 'hostKeyPrompt',
                outcome: 'denied',
                target: { host: question.host, port: question.port, user: '' },
                detail: { keyType: question.keyType, fingerprint: question.fingerprint, knownHostsMatch: question.knownHostsMatch, pending: key },
            });
        });
    }
    /**
     * A rejected accept/reject prompt is reported by the transport with its own
     * structured `SSH_HOSTKEY_*` error, so this module does not synthesise one.
     */
    forgetAttempt(attempt) {
        for (const [key, entry] of [...this.pending]) {
            if (key.startsWith(`${attempt}#`)) {
                entry.decide('reject', false);
                this.pending.delete(key);
            }
        }
    }
    infoOf(sessionId, profile, label) {
        return {
            id: sessionId,
            profileId: profile.id,
            label: label ?? profile.name,
            host: profile.host,
            port: profile.port,
            user: profile.user,
            state: 'connected',
            since: new Date(this.now()).toISOString(),
            metrics: { bytesIn: 0, bytesOut: 0 },
            capabilities: { shell: true, sftp: true },
        };
    }
    placeholderInfo(sessionId) {
        return {
            id: sessionId,
            label: sessionId,
            host: '',
            port: 0,
            user: '',
            state: 'closed',
            since: new Date(this.now()).toISOString(),
            metrics: { bytesIn: 0, bytesOut: 0 },
            capabilities: { shell: false, sftp: false },
        };
    }
    oneShot(params) {
        const secrets = objectJson(params, 'secrets', (name) => this.warnDirect(name));
        if (secrets === undefined)
            return {};
        const out = {};
        if (typeof secrets['password'] === 'string' && secrets['password'] !== '')
            out.password = secrets['password'];
        if (typeof secrets['passphrase'] === 'string' && secrets['passphrase'] !== '')
            out.passphrase = secrets['passphrase'];
        return out;
    }
    warnDirect(name) {
        this.log.warn(`${name} arrived as a nested object; the wire convention is ${name}Json (ICD §12 R1.3)`, { name });
    }
}
//# sourceMappingURL=sessions.js.map