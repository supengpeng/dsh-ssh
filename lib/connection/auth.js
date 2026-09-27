/**
 * Authentication planning (ICD §4.2 `auth: password | privateKey | agent`).
 *
 * The connection layer never guesses: before any TCP connection is opened, the
 * plan is built and validated so that an unreadable key, a missing passphrase or
 * an unavailable agent is reported as a precise ICD §5 code instead of a generic
 * "authentication failed" after a 15-second timeout.
 *
 * The returned `config` object contains plaintext material. It exists only to be
 * handed to `ssh2`'s `connect()` and must never be logged, serialised or merged
 * into a `SessionInfo`.
 */
import { readFile as fsReadFile } from 'node:fs/promises';
// `ssh2` is CommonJS and only *some* of its exports are visible to Node's ESM
// named-export detection (`utils` and `Server` are not). The default import is
// the full `module.exports`, so it is the only interop that works at runtime.
import ssh2 from 'ssh2';
import { SshError } from '../protocol.js';
/**
 * Effective agent source: an explicit socket path wins, then `$SSH_AUTH_SOCK`,
 * then Pageant on Windows. Returns `undefined` when no agent can be reached.
 */
export function resolveAgentSource(secrets, env = process.env, platform = process.platform) {
    if (typeof secrets.agentSocket === 'string' && secrets.agentSocket.trim() !== '')
        return secrets.agentSocket.trim();
    const fromEnv = env['SSH_AUTH_SOCK'];
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '')
        return fromEnv.trim();
    if (platform === 'win32')
        return 'pageant';
    return undefined;
}
/** `••••••••` — fixed 8 dots, never a length hint (ICD §4.2). */
export function maskedSecret(value) {
    return value === undefined || value === '' ? '' : '••••••••';
}
function keyUnreadable(message, path, cause) {
    return new SshError('SSH_AUTH_KEY_UNREADABLE', message, {
        details: path === undefined ? {} : { path },
        cause,
    });
}
/**
 * Parse a private key up-front so that an encrypted key without a passphrase, a
 * wrong passphrase and a malformed key are distinguishable before connecting.
 * `ssh2.utils.parseKey` is the same parser the client will use, so this cannot
 * disagree with the handshake outcome.
 */
export function parsePrivateKey(pem, passphrase, path) {
    const parsed = ssh2.utils.parseKey(pem, passphrase);
    if (parsed instanceof Error) {
        const message = parsed.message;
        if (/no passphrase given/i.test(message)) {
            throw new SshError('SSH_AUTH_PASSPHRASE_REQUIRED', 'the private key is encrypted and no passphrase was supplied', {
                details: path === undefined ? {} : { path },
                cause: parsed,
            });
        }
        if (/bad passphrase|integrity check failed/i.test(message)) {
            throw new SshError('SSH_AUTH_PASSPHRASE_REQUIRED', 'the private key passphrase was rejected', {
                details: path === undefined ? {} : { path },
                cause: parsed,
            });
        }
        throw keyUnreadable(`the private key could not be read: ${message}`, path, parsed);
    }
    if (Array.isArray(parsed)) {
        if (parsed.length === 0)
            throw keyUnreadable('the private key file contains no key', path, parsed);
        return;
    }
    if (typeof parsed !== 'object' || parsed === null) {
        throw keyUnreadable('the private key could not be parsed', path, parsed);
    }
}
/**
 * Build the ssh2 auth fields for one profile.
 *
 * Precedence for the key material: inline `secrets.privateKey`, else the path in
 * `secrets.privateKeyPath` / `profile.secretRefs.privateKeyPath`.
 */
export async function planAuth(profile, options = {}) {
    const readFile = options.readFile ?? ((path) => fsReadFile(path));
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    const secrets = profile.secrets ?? {};
    const username = profile.user;
    if (typeof username !== 'string' || username.trim() === '') {
        throw new SshError('SSH_CFG_INVALID', 'the connection profile has no SSH user name', { details: { field: 'user' } });
    }
    switch (profile.auth) {
        case 'password': {
            const password = secrets.password;
            if (typeof password !== 'string' || password === '') {
                throw new SshError('SSH_CFG_INVALID', 'password authentication was selected but no password is available', {
                    details: { field: 'password', auth: 'password' },
                });
            }
            return {
                kind: 'password',
                config: { username, password },
                describe: () => `password(${maskedSecret(password)})`,
            };
        }
        case 'privateKey': {
            const path = secrets.privateKeyPath ?? profile.secretRefs.privateKeyPath;
            let pem;
            if (typeof secrets.privateKey === 'string' && secrets.privateKey.trim() !== '') {
                pem = Buffer.from(secrets.privateKey);
            }
            else if (typeof path === 'string' && path.trim() !== '') {
                try {
                    pem = await readFile(path);
                }
                catch (error) {
                    throw keyUnreadable('the private key file could not be read', path, error);
                }
            }
            else {
                throw new SshError('SSH_CFG_INVALID', 'private-key authentication was selected but no key was provided', {
                    details: { field: 'privateKeyPath', auth: 'privateKey' },
                });
            }
            parsePrivateKey(pem, secrets.passphrase, path);
            const inline = typeof secrets.privateKey === 'string' && secrets.privateKey.trim() !== '';
            return {
                kind: 'privateKey',
                config: { username, privateKey: pem, ...(secrets.passphrase === undefined ? {} : { passphrase: secrets.passphrase }) },
                describe: () => `privateKey(${inline ? 'inline' : String(path)}${secrets.passphrase === undefined ? '' : ', encrypted'})`,
            };
        }
        case 'agent': {
            const agent = resolveAgentSource(secrets, env, platform);
            if (agent === undefined) {
                throw new SshError('SSH_AUTH_AGENT_UNAVAILABLE', 'agent authentication was selected but no ssh-agent is reachable', {
                    details: { auth: 'agent', checked: 'SSH_AUTH_SOCK' },
                });
            }
            return {
                kind: 'agent',
                config: { username, agent },
                describe: () => `agent(${agent === 'pageant' ? 'pageant' : 'socket'})`,
            };
        }
        default: {
            // Unreachable for a validated profile; kept so a bad runtime value cannot
            // silently fall through to password auth.
            const kind = String(profile.auth);
            throw new SshError('SSH_CFG_INVALID', `unsupported authentication method "${kind}"`, {
                details: { field: 'auth', auth: kind },
            });
        }
    }
}
/**
 * Resolve the credentials a profile brings, falling back to SP4's resolver when
 * the profile arrived without any (an inline profile, or a caller that only
 * holds a stored profile).
 */
export async function resolveProfileSecrets(profile, credentials) {
    const inline = profile.secrets;
    if (inline !== undefined && Object.keys(inline).length > 0)
        return profile;
    if (credentials === undefined)
        return { ...profile, secrets: {} };
    const secrets = await credentials.resolve(profile);
    return { ...profile, secrets };
}
//# sourceMappingURL=auth.js.map