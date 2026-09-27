/**
 * SFTP contract — the in-process surface frozen by `docs/ICD.md` §7.2.
 *
 * `SftpHandle` and `TransferRequest` are consumed exactly as frozen: the
 * connection layer hands this module a handle (through the `SftpProvider`
 * factory implemented in `adapter.ts`) and the wire layer hands it a request.
 * Everything else here is the transfer layer's own vocabulary and is free to
 * grow (it is not wire-visible).
 *
 * Three deliberate choices, called out because a reviewer should be able to
 * check them at a glance:
 *
 *  1. `DirEntry` / `FileInfo` are **re-exported** from `src/connection/types.ts`
 *     instead of re-declared. The ICD shape is then defined exactly once, so a
 *     one-sided edit cannot make the remote pane and the local pane disagree.
 *     (`src/api/**` builds local entries with `format.ts` from the same shape.)
 *  2. `createWriteStream` accepts an extra **optional** `start`. Concurrent
 *     chunked uploads must write at an offset, and ssh2 supports it natively
 *     (`SFTP.js` `WriteStream`: `this.pos = options.start`). Because the
 *     parameter is optional, a narrower implementation still type-checks in both
 *     directions (method parameters are bivariant); `transfer.ts` additionally
 *     probes the handle's behaviour and degrades to sequential writes when the
 *     offset is neither declared nor honoured. Raised with the Lead as an
 *     additive ICD item (see `src/sftp/README.md`).
 *  3. Optional `supportsOffsetWrite()` lets a handle *declare* the capability so
 *     the safe fallback proves nothing by accident. The adapter we own returns
 *     `true`; an unknown handle is probed once per handle and otherwise assumed
 *     to be sequential (correct, merely slower).
 */
export {};
//# sourceMappingURL=types.js.map