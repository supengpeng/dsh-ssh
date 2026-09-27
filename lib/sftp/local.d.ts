/**
 * Local filesystem helpers for the transfer engine.
 *
 * "Local" is the machine DSH runs on, so this is the only module in `src/sftp`
 * that talks to `node:fs`. Keeping it separate buys two things: the remote half
 * stays a pure adapter over `SftpHandle` (and therefore mock-testable), and every
 * local error is mapped to the local-side ICD codes in one place.
 *
 * All reads and writes are **positional** (`FileHandle.read/write` with an
 * explicit offset) and loop until the requested length is satisfied: a short
 * read from a stream would otherwise be recorded as committed bytes and corrupt
 * the resume offset.
 */
import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import type { DirEntry } from './types.js';
/** One node of a walked local tree; mirrors `WalkEntry` on the remote side. */
export interface LocalEntry extends DirEntry {
    /** Path relative to the walk root; `''` for the root itself. */
    relPath: string;
    depth: number;
}
export interface LocalWalkOptions {
    followSymlinks?: boolean;
    maxDepth?: number;
    signal?: AbortSignal;
    onEntry?: (entry: LocalEntry) => void;
}
declare function throwIfAborted(signal?: AbortSignal): void;
/** `lstat` that answers `undefined` for a missing path instead of throwing. */
export declare function lstatLocal(path: string): Promise<Stats | undefined>;
/** `stat` (symlinks followed) that answers `undefined` for a missing path. */
export declare function statLocal(path: string): Promise<Stats | undefined>;
/** Create (or truncate) a file without writing anything — the fresh-start case. */
export declare function createOrTruncateLocalFile(path: string): Promise<void>;
/** `mkdir -p`; an existing directory is not an error. */
export declare function ensureLocalDir(path: string): Promise<void>;
/**
 * Depth-first local listing, parents before children, same ordering rule as the
 * remote side (`compareEntries`).
 *
 * With `followSymlinks: false` (the default, `sftp.followSymlinks`) a symlinked
 * directory is reported as `symlink` and is never entered — which is what keeps
 * a recursive upload from duplicating a tree through a link, or from looping.
 */
export declare function listLocalTree(root: string, options?: LocalWalkOptions): Promise<LocalEntry[]>;
/** Read exactly `length` bytes at `position`; a short result means the file shrank. */
export declare function readExactly(handle: FileHandle, length: number, position: number, signal?: AbortSignal): Promise<Buffer>;
/** Write the whole buffer at `position`, looping over short writes. */
export declare function writeExactly(handle: FileHandle, buffer: Buffer, position: number, signal?: AbortSignal): Promise<void>;
export interface DigestResult {
    hex: string;
    bytes: number;
}
/** Streamed sha256 of a local file (never buffers the file in memory). */
export declare function sha256OfFile(path: string, signal?: AbortSignal): Promise<DigestResult>;
/**
 * Streamed sha256 of any readable stream (a local file or a remote SFTP read
 * stream), with byte accounting so a truncated read is visible.
 *
 * The stream is destroyed on abort, which is what keeps `verify: 'sha256'` from
 * pinning a 100 MiB read that the user already cancelled.
 */
export declare function sha256OfReadable(readable: NodeJS.ReadableStream, options?: {
    signal?: AbortSignal;
    expectedBytes?: number;
}): Promise<DigestResult>;
/** Best-effort destroy; a stream that already ended may not have `destroy`. */
export declare function destroyStream(stream: NodeJS.ReadableStream | NodeJS.WritableStream | undefined): void;
export { throwIfAborted };
//# sourceMappingURL=local.d.ts.map