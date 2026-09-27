/**
 * The real `SftpHandle`: an adapter over one `ssh2` SFTP subsystem channel.
 *
 * The connection layer owns the channel (`SftpChannelSource.openSftpChannel`,
 * lazily created on the session's own transport) and hands it to the factory
 * exported here through `PoolOptions.sftp`. Keeping the adapter in SP3's tree is
 * what makes the frozen `SftpHandle` real: normalization of `ssh2`'s raw
 * `FileEntry`/`Stats` into ICD `DirEntry`/`FileInfo` happens in exactly one
 * place, using the same `format.ts` helpers the local pane uses.
 *
 * Protocol facts this file is built around (SFTP v3, what ssh2 speaks):
 *  - status codes stop at 8, so "file exists" arrives as a bare `FAILURE` with
 *    the detail in the text. `mkdir` therefore never trusts the error code: it
 *    re-stats the path to decide. Conflict detection in `transfer.ts` works the
 *    same way — by `stat()`, not by catching an error.
 *  - `mkdir` is single-level; `{ recursive: true }` walks the components here.
 *  - `rmdir` refuses a non-empty directory; recursive removal is done here.
 *  - `createWriteStream` honours `options.start` (ssh2 sets `this.pos` to it),
 *    which is why {@link SftpHandle.supportsOffsetWrite} can answer `true`.
 */
import { SshError } from '../protocol.js';
import { compareEntries, entryOf, fileInfoOf, isHiddenName, missingFileInfo, typeOfStat } from './format.js';
import { remoteBasename, remoteJoin, remoteNormalize } from './paths.js';
import { codedError, toSftpError } from './errors.js';
function abortedError() {
    const error = new Error('the operation was aborted');
    error.name = 'AbortError';
    return error;
}
/** Reject with the standard `AbortError` shape as soon as `signal` aborts. */
function raceAbort(promise, signal) {
    if (signal === undefined)
        return promise;
    if (signal.aborted)
        return Promise.reject(abortedError());
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(abortedError());
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then((value) => {
            signal.removeEventListener('abort', onAbort);
            resolve(value);
        }, (error) => {
            signal.removeEventListener('abort', onAbort);
            reject(error);
        });
    });
}
/**
 * Promise wrapper for the callback style of every `SFTPWrapper` method.
 *
 * **ssh2 reports success as `null`, not as `undefined`** (`Callback` is
 * `(err?: Error | null) => void`), so the test below is truthiness, never
 * `error !== undefined`: the latter would turn every *successful* ssh2 call into
 * a rejection. The wrapper's parameter type is deliberately the widest of the
 * shapes ssh2 uses, so one helper serves both `Callback` and the two-argument
 * callbacks (`lstat`, `readdir`, `readlink`).
 */
function fromCallback(run) {
    return new Promise((resolve, reject) => {
        run((error, value) => {
            if (error)
                reject(error);
            else
                resolve(value);
        });
    });
}
/**
 * Type from an `ls -l` long name, used when a server omits `S_IFMT` bits.
 *
 * OpenSSH always returns the mode, but SFTP only requires the *permission* bits
 * to be meaningful; the long name is the one field a listing always fills in.
 */
function typeFromLongname(longname) {
    const kind = (longname ?? '').charAt(0);
    if (kind === 'd')
        return 'dir';
    if (kind === 'l')
        return 'symlink';
    if (kind === '-')
        return 'file';
    if (kind === 'b' || kind === 'c' || kind === 'p' || kind === 's')
        return 'other';
    return undefined;
}
/**
 * Make a stream's failures carry ICD codes.
 *
 * `ssh2` reports stream failures by emitting an `Error` whose `code` is the raw
 * **numeric** SFTP status (e.g. `2`). The wire contract in ICD §5 is a *string*
 * code, and a caller that reads `error.code` directly (the API layer, a UI
 * presenter) would otherwise publish a localisable-hostile number. The stream
 * object itself is returned unchanged — only the `error` argument is translated —
 * so this adds no wrapper the caller has to unwrap.
 */
function translateStreamErrors(stream, context) {
    const originalEmit = stream.emit.bind(stream);
    stream.emit = ((event, ...args) => {
        if (event === 'error' && args.length > 0 && args[0] !== undefined && args[0] !== null) {
            args[0] = toSftpError(args[0], context);
        }
        return originalEmit(event, ...args);
    });
    return stream;
}
/**
 * Adapt one live `ssh2` SFTP channel to the frozen handle.
 *
 * Every failure leaving this object is an `SshError` with a string ICD code:
 * promise rejections are mapped at each call site, stream failures by
 * {@link translateStreamErrors}. That invariant is what lets the API layer put
 * `error.code` on the wire unmodified.
 *
 * The adapter is stateless apart from the channel, so one instance per SFTP
 * subsystem is enough; the connection layer caches the channel itself.
 */
export function createSftpHandle(wrapper, options = {}) {
    const log = options.logger;
    const statRaw = (path, signal) => raceAbort(fromCallback((done) => wrapper.lstat(path, done)), signal);
    /** `lstat` + `readlink` for symlinks: the file manager shows the link target. */
    const describe = async (path, signal) => {
        const normalized = remoteNormalize(path);
        let stats;
        try {
            stats = await statRaw(normalized, signal);
        }
        catch (error) {
            const mapped = toSftpError(error, { op: 'stat', path: normalized });
            if (mapped.code === 'SSH_SFTP_NO_SUCH_FILE')
                return missingFileInfo(normalized);
            throw mapped;
        }
        const type = typeOfStat(stats);
        let target;
        if (type === 'symlink') {
            try {
                target = await raceAbort(fromCallback((done) => wrapper.readlink(normalized, done)), signal);
            }
            catch {
                // A dangling link, or a server that refuses readlink: the entry is still
                // a symlink, we simply cannot show where it points. Logged because a
                // server that never answers readlink also disables "follow symlinks".
                log?.debug(`dsh-ssh: could not read the symlink target of ${normalized}`);
                target = undefined;
            }
        }
        return fileInfoOf({
            name: remoteBasename(normalized),
            path: normalized,
            stat: stats,
            type,
            isSymlink: type === 'symlink',
            ...(target === undefined ? {} : { target }),
            exists: true,
        });
    };
    const mkdirOne = async (path) => {
        try {
            await fromCallback((done) => wrapper.mkdir(path, done));
        }
        catch (error) {
            // "exists" is not distinguishable by code in v3: the only reliable test is
            // whether the path is now a directory.
            const info = await describe(path).catch(() => undefined);
            if (info?.exists === true && info.type === 'dir') {
                log?.debug(`dsh-ssh: mkdir ${path} reported a failure but the directory exists; continuing`);
                return;
            }
            throw toSftpError(error, { op: 'mkdir', path });
        }
    };
    const removeRecursive = async (path, signal) => {
        const info = await describe(path, signal);
        if (!info.exists)
            return 0;
        let removed = 0;
        if (info.type === 'dir') {
            const children = await listEntries(path, { showHidden: true, signal });
            for (const child of children) {
                removed += await removeRecursive(child.path, signal);
            }
            await raceAbort(fromCallback((done) => wrapper.rmdir(path, done)), signal);
            return removed + 1;
        }
        await raceAbort(fromCallback((done) => wrapper.unlink(path, done)), signal);
        return 1;
    };
    const listEntries = async (path, opts = {}) => {
        const normalized = remoteNormalize(path);
        // `readdir` failures arrive as a raw numeric status; mapping here (rather than
        // only in `SftpClient`) means a direct handle caller also gets an ICD code.
        let list;
        try {
            list = await raceAbort(fromCallback((done) => wrapper.readdir(normalized, done)), opts.signal);
        }
        catch (error) {
            throw toSftpError(error, { op: 'listDir', path: normalized });
        }
        const showHidden = opts.showHidden === true;
        const entries = [];
        for (const item of list) {
            const name = item.filename;
            if (name === '.' || name === '..')
                continue;
            if (!showHidden && isHiddenName(name))
                continue;
            const stat = item.attrs;
            const type = typeOfStat(stat) === 'other' ? (typeFromLongname(item.longname) ?? 'other') : typeOfStat(stat);
            entries.push(entryOf({
                name,
                path: remoteJoin(normalized, name),
                stat,
                type,
                isSymlink: type === 'symlink',
            }));
        }
        entries.sort(compareEntries);
        return entries;
    };
    return {
        listDir: (path, opts) => listEntries(path, { showHidden: opts?.showHidden, signal: opts?.signal }),
        stat: (path, signal) => describe(path, signal),
        async mkdir(path, opts) {
            const normalized = remoteNormalize(path);
            if (opts?.recursive !== true) {
                await mkdirOne(normalized);
                return;
            }
            // `mkdir -p`: create every missing component from the top down. Already
            // existing components are tolerated, which is what -p means.
            const absolute = normalized.startsWith('/');
            const segments = normalized.split('/').filter((segment) => segment.length > 0);
            let current = absolute ? '/' : '';
            for (const segment of segments) {
                current = current === '/' ? `/${segment}` : current === '' ? segment : `${current}/${segment}`;
                try {
                    await mkdirOne(current);
                }
                catch (error) {
                    const mapped = toSftpError(error, { op: 'mkdir', path: current });
                    throw mapped;
                }
            }
        },
        async rename(from, to) {
            try {
                await fromCallback((done) => wrapper.rename(remoteNormalize(from), remoteNormalize(to), done));
            }
            catch (error) {
                throw toSftpError(error, { op: 'rename', path: `${from} -> ${to}` });
            }
        },
        async remove(path, opts, signal) {
            const normalized = remoteNormalize(path);
            const info = await describe(normalized, signal);
            if (!info.exists) {
                throw toSftpError(codedError(2, `no such file or directory: ${normalized}`), {
                    op: 'remove',
                    path: normalized,
                });
            }
            if (info.type === 'dir' && opts?.recursive !== true) {
                try {
                    // `rmdir` refuses a non-empty directory, which is exactly the ICD
                    // semantic: no recursion means "remove only if empty".
                    await raceAbort(fromCallback((done) => wrapper.rmdir(normalized, done)), signal);
                    return 1;
                }
                catch (error) {
                    throw toSftpError(error, { op: 'remove', path: normalized });
                }
            }
            try {
                return await removeRecursive(normalized, signal);
            }
            catch (error) {
                throw toSftpError(error, { op: 'remove', path: normalized });
            }
        },
        async chmod(path, mode) {
            const normalized = remoteNormalize(path);
            try {
                await fromCallback((done) => wrapper.chmod(normalized, mode, done));
            }
            catch (error) {
                throw toSftpError(error, { op: 'chmod', path: normalized });
            }
        },
        createReadStream(path, opts = {}) {
            const normalized = remoteNormalize(path);
            const range = {};
            if (opts.start !== undefined)
                range.start = opts.start;
            if (opts.end !== undefined)
                range.end = opts.end;
            const stream = wrapper.createReadStream(normalized, range);
            return translateStreamErrors(stream, { op: 'read', path: normalized });
        },
        createWriteStream(path, opts = {}) {
            const normalized = remoteNormalize(path);
            const write = {};
            // The ICD types `flags` as a plain string so the wire stays declarative;
            // ssh2 only accepts its own OpenMode union, hence the narrowing here.
            if (opts.flags !== undefined)
                write.flags = opts.flags;
            if (opts.mode !== undefined)
                write.mode = opts.mode;
            if (opts.start !== undefined)
                write.start = opts.start;
            const stream = wrapper.createWriteStream(normalized, write);
            return translateStreamErrors(stream, { op: 'write', path: normalized });
        },
        /**
         * ssh2 writes at `options.start` (`SFTP.js` `WriteStream`: `this.pos =
         * options.start`), so the engine may run concurrent offset writes on this
         * handle. Declared explicitly so the engine never has to probe a live
         * connection — and so a foreign handle without the member is probed instead
         * of trusted.
         */
        supportsOffsetWrite: () => true,
        /**
         * `SSH_FXP_SETSTAT` with a size attribute is POSIX `truncate()` on the server
         * side (OpenSSH's sftp-server calls `truncate(name, attrs->size)`), which is
         * how an aborted parallel upload is cut back to its durable prefix. Only
         * meaningful for a regular file the caller already created.
         */
        async truncate(path, size) {
            const normalized = remoteNormalize(path);
            if (!Number.isFinite(size) || size < 0) {
                throw new SshError('SSH_CFG_INVALID', `invalid truncate size: ${String(size)}`, {
                    details: { path: normalized, size },
                });
            }
            try {
                await fromCallback((done) => wrapper.setstat(normalized, { size: Math.trunc(size) }, done));
            }
            catch (error) {
                throw toSftpError(error, { op: 'truncate', path: normalized });
            }
        },
    };
}
/**
 * `PoolOptions.sftp` factory: open (or reuse) this session's SFTP channel and
 * adapt it.
 *
 * Deliberately uncached here: `openSftpChannel` is the connection layer's own
 * cache and lifecycle, and a second cache in this module would keep a dead
 * channel alive across a reconnect.
 */
export function createSftpProvider(options = {}) {
    return async (source, signal) => {
        const wrapper = await source.openSftpChannel(signal);
        return createSftpHandle(wrapper, options);
    };
}
//# sourceMappingURL=adapter.js.map