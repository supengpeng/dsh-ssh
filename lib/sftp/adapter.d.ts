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
import type { SFTPWrapper } from 'ssh2';
import type { SftpProvider } from '../connection/types.js';
import type { SftpHandle, TransferLogger } from './types.js';
export interface SftpAdapterOptions {
    /** Structured logger; the adapter only logs at debug/warn level. */
    logger?: TransferLogger;
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
export declare function createSftpHandle(wrapper: SFTPWrapper, options?: SftpAdapterOptions): SftpHandle;
/**
 * `PoolOptions.sftp` factory: open (or reuse) this session's SFTP channel and
 * adapt it.
 *
 * Deliberately uncached here: `openSftpChannel` is the connection layer's own
 * cache and lifecycle, and a second cache in this module would keep a dead
 * channel alive across a reconnect.
 */
export declare function createSftpProvider(options?: SftpAdapterOptions): SftpProvider;
//# sourceMappingURL=adapter.d.ts.map