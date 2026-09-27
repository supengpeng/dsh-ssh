/**
 * The one place that talks to `ssh2`'s `Client`.
 *
 * Responsibilities: dial with the effective timeouts/keepalive settings, run the
 * host-key policy, classify every failure into an ICD §5 code, open exec/shell/
 * SFTP channels on the live connection, and close it gracefully.
 *
 * Deliberate omission: `ssh2`'s `debug` hook is **not** wired to the plugin
 * logger. Its packet dumps can contain authentication data in binary form, which
 * neither key-name nor literal-value redaction can catch; a logger that leaks a
 * password is worse than a quiet handshake.
 */
import { createHash } from 'node:crypto';
import { SshError } from '../protocol.js';
import { classifyError, readHostKeyType } from './errors.js';
/** Default PTY geometry, matching the ICD's `openShell` defaults. */
export const DEFAULT_TERM = 'xterm-256color';
export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;
/** How long a graceful `close()` waits for the peer before tearing the socket down. */
const GRACEFUL_CLOSE_MS = 3000;
/**
 * `SHA256:` + base64(sha256(blob)) without padding — byte-identical to
 * `ssh-keygen -lf` (ICD §7.3). Used when no verifier is injected.
 */
export function sshFingerprint(key) {
    return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}
/** Effective per-profile value with a config fallback. */
function positive(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}
export function effectiveTimeouts(profile, config) {
    return {
        connectTimeoutMs: positive(profile.connectTimeoutMs, config.connectTimeoutMs),
        keepaliveIntervalMs: positive(profile.keepaliveIntervalMs, config.keepaliveIntervalMs),
        keepaliveCountMax: typeof profile.keepaliveCountMax === 'number' && Number.isFinite(profile.keepaliveCountMax) && profile.keepaliveCountMax >= 0
            ? Math.trunc(profile.keepaliveCountMax)
            : config.keepaliveCountMax,
    };
}
/**
 * Host-key policy decision (ICD §6 `hostKey.policy`).
 *
 * `insecure` accepts anything; `strict` refuses an unknown key; `accept-new`
 * trusts on first use *and* still asks about a changed key — a mismatch is never
 * silently accepted, because that is the whole point of the check.
 */
export async function decideHostKey(key, context) {
    const { host, port, policy, knownHosts, onHostKeyPrompt, logger } = context;
    const keyType = readHostKeyType(key);
    const fingerprint = fingerprintOf(knownHosts, keyType, key);
    const report = (info) => {
        try {
            context.onDecision?.(info);
        }
        catch {
            /* a diagnostic hook must never break the handshake */
        }
    };
    if (policy === 'insecure') {
        report({ keyType, fingerprint, knownHostsMatch: 'unknown', accepted: true });
        return true;
    }
    if (knownHosts === undefined) {
        if (policy === 'strict') {
            throw new SshError('SSH_HOSTKEY_UNKNOWN', `no known_hosts verifier is configured; refusing to trust ${host}:${port}`, {
                details: { host, port, keyType, policy, fingerprint },
            });
        }
        // Degraded but documented: without a verifier there is nothing to compare
        // against, and `accept-new` is trust-on-first-use by definition.
        logger.warn(`host key verification is degraded (no known_hosts verifier): accepting ${host}:${port} [${keyType}]`);
        report({ keyType, fingerprint, knownHostsMatch: 'unknown', accepted: true });
        return true;
    }
    const verdict = await knownHosts.verify({ host, port, keyType, key, policy });
    if (verdict.ok) {
        // SP4's verifier already persists a first-seen key under `accept-new`.
        report({ keyType, fingerprint, knownHostsMatch: 'exact', accepted: true });
        return true;
    }
    const question = {
        host,
        port,
        keyType,
        fingerprint: verdict.fingerprint === '' ? fingerprint : verdict.fingerprint,
        knownHostsMatch: verdict.knownHostsMatch === 'changed' ? 'changed' : 'unknown',
    };
    if (onHostKeyPrompt === undefined) {
        report({ keyType, fingerprint: question.fingerprint, knownHostsMatch: question.knownHostsMatch, accepted: false });
        throw hostKeyRejection(verdict.code, verdict.knownHostsMatch, question, 'no prompt handler');
    }
    let answer;
    try {
        answer = await onHostKeyPrompt(question);
    }
    catch (error) {
        report({ keyType, fingerprint: question.fingerprint, knownHostsMatch: question.knownHostsMatch, accepted: false });
        throw hostKeyRejection(verdict.code, verdict.knownHostsMatch, question, 'prompt failed', error);
    }
    if (answer !== 'accept') {
        report({ keyType, fingerprint: question.fingerprint, knownHostsMatch: question.knownHostsMatch, accepted: false });
        throw hostKeyRejection(verdict.code, verdict.knownHostsMatch, question, 'rejected by user');
    }
    if (verdict.knownHostsMatch === 'unknown' && policy === 'accept-new') {
        try {
            await knownHosts.remember({ host, port, keyType, key });
        }
        catch (error) {
            // The connection is already trusted for this session; a failed write must
            // not abort it, but it must be visible.
            logger.warn(`could not update known_hosts for ${host}:${port}: ${errorMessage(error)}`);
        }
    }
    else {
        logger.info(`host key for ${host}:${port} accepted for this session only (${verdict.knownHostsMatch}, policy ${policy})`);
    }
    report({ keyType, fingerprint: question.fingerprint, knownHostsMatch: question.knownHostsMatch, accepted: true });
    return true;
}
/** Best-effort fingerprint: the verifier's own helper, else the ICD formula. */
function fingerprintOf(knownHosts, keyType, key) {
    if (knownHosts !== undefined) {
        try {
            const value = knownHosts.fingerprint(keyType, key);
            if (typeof value === 'string' && value !== '')
                return value;
        }
        catch {
            /* fall through to the local implementation */
        }
    }
    return sshFingerprint(key);
}
function hostKeyRejection(code, match, question, reason, cause) {
    const text = code === 'SSH_HOSTKEY_MISMATCH'
        ? `the host key of ${question.host}:${question.port} does not match known_hosts`
        : `the host key of ${question.host}:${question.port} is not in known_hosts`;
    return new SshError(code, text, {
        details: {
            host: question.host,
            port: question.port,
            keyType: question.keyType,
            fingerprint: question.fingerprint,
            knownHostsMatch: match,
            reason,
        },
        ...(cause === undefined ? {} : { cause }),
    });
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
/** Open a connection and resolve once it is authenticated and ready. */
export async function openTransport(options) {
    const { profile, config, auth, logger, createClient } = options;
    const now = options.now ?? (() => Date.now());
    const policy = profile.hostKeyPolicy ?? config.hostKey.policy;
    const timeouts = effectiveTimeouts(profile, config);
    const client = createClient();
    let hostKeyFailure;
    let hostKeyFingerprint;
    let banner;
    let negotiated;
    let closed = false;
    let closing = false;
    let connectError;
    const startedAt = now();
    const abortSignal = options.signal;
    await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            if (error === undefined)
                resolve();
            else
                reject(error);
        };
        const onAbort = () => {
            const reason = abortSignal?.reason;
            finish(new SshError('SSH_CANCELLED', 'connection attempt cancelled', { cause: reason }));
            try {
                client.destroy();
            }
            catch {
                /* the socket may already be gone */
            }
        };
        const onReadyEvent = () => finish();
        const onErrorEvent = (error) => {
            const classified = classifyError(error, {
                phase: 'connect',
                auth: auth.kind,
                hostKeyError: hostKeyFailure,
                host: profile.host,
                port: profile.port,
            });
            const sshError = new SshError(classified.code, classified.message, {
                ...(classified.details === undefined ? {} : { details: classified.details }),
                cause: classified.cause,
            });
            connectError = sshError;
            finish(sshError);
        };
        const onCloseBeforeReady = () => {
            finish(connectError ??
                new SshError('SSH_NET_RESET', 'the connection closed before it became ready', {
                    details: { host: profile.host, port: profile.port },
                }));
        };
        const cleanup = () => {
            abortSignal?.removeEventListener('abort', onAbort);
        };
        client.on('banner', (message) => {
            // ssh2 hands the banner over verbatim, including its trailing CRLF.
            if (typeof message === 'string' && message.trim() !== '')
                banner = message.replace(/[\r\n]+$/, '');
        });
        client.on('handshake', (algorithms) => {
            if (algorithms !== null && typeof algorithms === 'object')
                negotiated = algorithms;
            options.onHandshake?.();
        });
        client.on('ready', onReadyEvent);
        client.on('error', onErrorEvent);
        client.on('close', onCloseBeforeReady);
        abortSignal?.addEventListener('abort', onAbort, { once: true });
        const connectConfig = {
            host: profile.host,
            port: profile.port,
            ...auth.config,
            readyTimeout: timeouts.connectTimeoutMs,
            keepaliveInterval: timeouts.keepaliveIntervalMs,
            keepaliveCountMax: timeouts.keepaliveCountMax,
            // `hostHash` is intentionally not set: the verifier needs the raw key blob
            // to derive the algorithm name and the SHA256 fingerprint (ICD §7.3).
            hostVerifier: (key, verify) => {
                void decideHostKey(key, {
                    host: profile.host,
                    port: profile.port,
                    policy,
                    knownHosts: options.knownHosts,
                    onHostKeyPrompt: options.onHostKeyPrompt,
                    logger,
                    onDecision: (info) => {
                        if (info.accepted)
                            hostKeyFingerprint = info.fingerprint;
                        options.onHostKeyDecision?.(info);
                    },
                })
                    .then((ok) => verify(ok))
                    .catch((error) => {
                    hostKeyFailure =
                        error instanceof SshError
                            ? error
                            : new SshError('SSH_HOSTKEY_MISMATCH', 'host key verification failed', { cause: error });
                    verify(false);
                });
            },
        };
        try {
            client.connect(connectConfig);
        }
        catch (error) {
            onErrorEvent(error);
        }
        if (abortSignal?.aborted === true)
            onAbort();
    });
    const connectMs = Math.max(0, now() - startedAt);
    options.onReady?.();
    logger.info(`connected to ${profile.user}@${profile.host}:${profile.port} in ${connectMs}ms ` +
        `(auth=${auth.describe()}, hostKey=${policy})`);
    // After `ready`, the pre-ready listeners are replaced by link-death reporting.
    client.on('error', (error) => {
        if (closing || closed)
            return;
        const classified = classifyError(error, {
            phase: 'runtime',
            auth: auth.kind,
            host: profile.host,
            port: profile.port,
        });
        options.onClosed?.(new SshError(classified.code, classified.message, { cause: classified.cause }));
    });
    client.on('close', () => {
        if (closed)
            return;
        closed = true;
        if (closing)
            return;
        options.onClosed?.(new SshError('SSH_NET_RESET', `the connection to ${profile.host}:${profile.port} was closed by the peer`, {
            details: { host: profile.host, port: profile.port },
        }));
    });
    const rttSample = (started) => {
        const elapsed = now() - started;
        if (elapsed >= 0)
            options.onRttSample?.(elapsed);
        logger.debug(`channel opened on ${profile.host}:${profile.port} in ${elapsed}ms`);
    };
    return {
        client,
        connectMs,
        get banner() {
            return banner;
        },
        get negotiated() {
            return negotiated;
        },
        get hostKeyFingerprint() {
            return hostKeyFingerprint;
        },
        get closed() {
            return closed;
        },
        exec(command, execOptions = {}) {
            return new Promise((resolve, reject) => {
                const started = now();
                const execConfig = {
                    ...(execOptions.env === undefined ? {} : { env: execOptions.env }),
                    ...(execOptions.pty === undefined ? {} : { pty: execOptions.pty }),
                };
                let timer;
                try {
                    client.exec(command, execConfig, (error, channel) => {
                        if (timer !== undefined)
                            clearTimeout(timer);
                        if (error !== undefined) {
                            reject(toChannelError(error, 'exec', profile));
                            return;
                        }
                        rttSample(started);
                        resolve(channel);
                    });
                    timer = channelTimeout(config, () => reject(channelTimeoutError('exec', profile)));
                }
                catch (error) {
                    if (timer !== undefined)
                        clearTimeout(timer);
                    reject(toChannelError(error, 'exec', profile));
                }
            });
        },
        shell(shellOptions = {}) {
            return new Promise((resolve, reject) => {
                const started = now();
                const pty = {
                    term: shellOptions.term ?? DEFAULT_TERM,
                    cols: positive(shellOptions.cols, DEFAULT_COLS),
                    rows: positive(shellOptions.rows, DEFAULT_ROWS),
                    width: 0,
                    height: 0,
                };
                let timer;
                try {
                    client.shell(pty, { ...(shellOptions.env === undefined ? {} : { env: shellOptions.env }) }, (error, channel) => {
                        if (timer !== undefined)
                            clearTimeout(timer);
                        if (error !== undefined) {
                            reject(toChannelError(error, 'shell', profile));
                            return;
                        }
                        rttSample(started);
                        resolve(channel);
                    });
                    timer = channelTimeout(config, () => reject(channelTimeoutError('shell', profile)));
                }
                catch (error) {
                    if (timer !== undefined)
                        clearTimeout(timer);
                    reject(toChannelError(error, 'shell', profile));
                }
            });
        },
        sftp() {
            return new Promise((resolve, reject) => {
                const started = now();
                let timer;
                try {
                    client.sftp((error, sftp) => {
                        if (timer !== undefined)
                            clearTimeout(timer);
                        if (error !== undefined) {
                            reject(toChannelError(error, 'sftp', profile, 'SSH_SFTP_PROTOCOL'));
                            return;
                        }
                        rttSample(started);
                        resolve(sftp);
                    });
                    timer = channelTimeout(config, () => reject(new SshError('SSH_TIMEOUT_OPERATION', 'timed out while opening the SFTP subsystem', {
                        details: { host: profile.host, port: profile.port, op: 'sftp' },
                    })));
                }
                catch (error) {
                    if (timer !== undefined)
                        clearTimeout(timer);
                    reject(toChannelError(error, 'sftp', profile, 'SSH_SFTP_PROTOCOL'));
                }
            });
        },
        async close(closeOptions = {}) {
            if (closed)
                return;
            closing = true;
            if (closeOptions.force === true) {
                try {
                    client.destroy();
                }
                catch {
                    /* ignore */
                }
                closed = true;
                return;
            }
            await new Promise((resolve) => {
                const timer = setTimeout(() => {
                    logger.warn(`graceful close timed out for ${profile.host}:${profile.port}; destroying the socket`);
                    try {
                        client.destroy();
                    }
                    catch {
                        /* ignore */
                    }
                    resolve();
                }, GRACEFUL_CLOSE_MS);
                timer.unref?.();
                client.on('close', () => {
                    clearTimeout(timer);
                    resolve();
                });
                try {
                    client.end();
                }
                catch {
                    clearTimeout(timer);
                    resolve();
                }
            });
            closed = true;
        },
    };
}
/** Channel-open failure: never let a raw ssh2 error escape unclassified. */
function toChannelError(error, op, profile, fallbackCode) {
    const classified = classifyError(error, { phase: 'runtime', host: profile.host, port: profile.port });
    // An sftp channel that will not open is an SFTP-subsystem problem (the ICD has
    // a dedicated code for it) unless the classifier already produced a specific
    // SFTP code of its own.
    const code = fallbackCode !== undefined && !String(classified.code).startsWith('SSH_SFTP_') ? fallbackCode : classified.code;
    const message = code === fallbackCode || classified.code === 'SSH_UNKNOWN'
        ? `could not open a ${op} channel on ${profile.host}:${profile.port}: ${classified.message}`
        : classified.message;
    return new SshError(code, message, {
        ...(classified.details === undefined ? {} : { details: { ...classified.details, op } }),
        cause: classified.cause,
    });
}
function channelTimeout(config, onTimeout) {
    const timer = setTimeout(onTimeout, Math.max(1000, config.operationTimeoutMs));
    timer.unref?.();
    return timer;
}
function channelTimeoutError(op, profile) {
    return new SshError('SSH_TIMEOUT_OPERATION', `timed out while opening a ${op} channel`, {
        details: { host: profile.host, port: profile.port, op },
    });
}
/** Compose `cwd`/`env` into a single remote command (ICD §4.4). */
export function composeRemoteCommand(command, cwd, env) {
    const assignments = env === undefined || Object.keys(env).length === 0
        ? ''
        : Object.entries(env)
            .map(([key, value]) => `${key}=${shellQuote(value)} `)
            .join('');
    const body = `${assignments}${command}`;
    if (cwd === undefined || cwd === '')
        return { command: body, env };
    // ssh2 does not implement `cwd` for exec channels; prefixing `cd --` keeps the
    // behaviour identical for every server and is what the shell offers anyway.
    return { command: `cd -- ${shellQuote(cwd)} && ${body}`, env };
}
/** POSIX single-quote escaping: `'` → `'\''`. */
export function shellQuote(value) {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}
/** Message used by `SessionHandle.close({reason})` logging; exported for tests. */
export function closeReason(options) {
    if (options?.reason !== undefined && options.reason !== '')
        return options.reason;
    return options?.force === true ? 'forced close' : 'close requested';
}
//# sourceMappingURL=transport.js.map