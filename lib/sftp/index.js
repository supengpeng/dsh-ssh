/**
 * `@local/dsh-ssh` SFTP module — the stable import surface for the wire layer
 * (`src/api/**`, `src/service.ts`) and the model-facing tools.
 *
 * Consumers should import from here rather than reaching into individual files,
 * so an internal split (for example moving the range scheduler out of
 * `transfer.ts`) never breaks the integration seam.
 */
export { TransferEngine, buildRanges, durableOffset, resolveTransferOptions, digestRemote, } from './transfer.js';
export { TransferManager } from './manager.js';
export { SftpClient } from './client.js';
export { ProgressReporter, systemProgressClock, toProgressFrame } from './progress.js';
export { createSftpHandle, createSftpProvider } from './adapter.js';
export { compareEntries, dotFileHidden, entryOf, fileInfoOf, formatMode, isHiddenName, missingFileInfo, mtimeMsOf, naturalCompare, normalizeMtime, parseMode, typeOfStat, } from './format.js';
export { abortedTransfer, cancelledTransfer, codedError, errorInfoOf, isAbortError, localDenied, noSuchSession, noSuchTransfer, targetExists, toSftpError, verifyMismatch, } from './errors.js';
export { isRemoteAbsolute, localBasename, localDirname, localJoin, remoteBasename, remoteDirname, remoteJoin, remoteNormalize, remoteRelativeUnder, } from './paths.js';
export { createOrTruncateLocalFile, ensureLocalDir, listLocalTree, lstatLocal, readExactly, sha256OfFile, sha256OfReadable, statLocal, writeExactly, } from './local.js';
//# sourceMappingURL=index.js.map