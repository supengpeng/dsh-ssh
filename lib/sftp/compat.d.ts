/**
 * Compile-time drift guards for the frozen SFTP surface.
 *
 * Every export here is a *type* whose only purpose is to fail `tsc` if a
 * signature on either side of a seam moves. Nothing is emitted at runtime, so
 * the module costs nothing; the single-project tsc gate (R7) then turns an
 * interface drift into a build failure instead of a runtime mystery.
 *
 * The trick is `Assignable<From, To>` + `Expect<...>`: an unsatisfied constraint
 * is a compile error, and the alias name says what broke.
 *
 * The same pattern is used by `src/exec/compat.ts` for `SessionHandle`; that is
 * deliberate — both modules consume the connection layer and must be re-checked
 * when §7.1 changes.
 */
import type { Frame } from '../protocol.js';
import type { ResolvedConfig } from '../config.js';
import type { SftpProvider } from '../connection/types.js';
import type { DirEntry as ConnectionDirEntry, FileInfo as ConnectionFileInfo, SftpHandle as ConnectionSftpHandle } from '../connection/types.js';
import type { createSftpProvider } from './adapter.js';
import type { toProgressFrame } from './progress.js';
import type { TransferEngineDefaults, DirEntry, FileInfo, SftpHandle } from './types.js';
type Expect<T extends true> = T;
type Assignable<From, To> = [From] extends [To] ? true : false;
export type SftpHandleIsUsableWhereConnectionExpectsIt = Expect<Assignable<SftpHandle, ConnectionSftpHandle>>;
export type ConnectionHandleIsUsableWhereSftpExpectsIt = Expect<Assignable<ConnectionSftpHandle, SftpHandle>>;
export type DirEntryHasOneDeclaration = Expect<Assignable<DirEntry, ConnectionDirEntry>>;
export type FileInfoHasOneDeclaration = Expect<Assignable<FileInfo, ConnectionFileInfo>>;
export type AdapterSatisfiesSftpProvider = Expect<Assignable<ReturnType<typeof createSftpProvider>, SftpProvider>>;
export type SftpConfigFeedsEngineDefaults = Expect<Assignable<ResolvedConfig['sftp'], TransferEngineDefaults>>;
export type ProgressFrameMatchesIcd = Expect<Assignable<ReturnType<typeof toProgressFrame>, Extract<Frame, {
    t: 'progress';
}>>>;
export {};
//# sourceMappingURL=compat.d.ts.map