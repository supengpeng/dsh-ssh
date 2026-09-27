/**
 * @local/dsh-ssh — SSH connectivity, command execution and file transfer for DSH,
 * with a right-sidebar session workspace.
 *
 *     name       'dsh-ssh'      (must equal the cordis.patch.yml row id and
 *                                dsh.plugin.json's id — asserted by test/unit/identity.test.mjs)
 *     inject     ['tools']      the only required service
 *     Config     Schemastery schema; the Loader validates the row's config with it
 *     apply      builds the host runtime and owns every resource through ctx.effect
 *
 * This file is deliberately only a *shell*: it names the plugin, validates its
 * config, and hands the object graph to `createHostRuntime`, which owns who is
 * constructed with what. Keeping the graph on the other side of one function is
 * what lets the endpoints, the connection pool and the security modules evolve
 * without this file turning into a second composition root.
 *
 * Activation is non-fatal by design: a missing optional service or an unwritable
 * store must produce a plugin that *reports* the problem through structured error
 * codes, because a row that fails to load tells the user nothing actionable.
 *
 * Measured reload behaviour (M4): the live host re-imports this module when the
 * emitted bytes under `lib/` change (HMR watches content, not mtime), which is why
 * `apply()` leaves its diagnostics on disk — the host's own logger is not readable
 * from a file, so an on-disk marker is the only way to tell "apply never ran" from
 * "apply ran and the runtime failed to compose".
 *
 * HMR only watches module roots that are explicitly opted in (the shipped `hmr` row
 * defaults to `root: []`), so this package adds its own directory to that row in the
 * live profile patch; without it a rebuilt host half stays invisible until restart.
 *
 * **Measured Windows caveat (2026-09-27):** adding the root is necessary but not
 * sufficient. The row's shipped `ignored` default begins with a pattern that matches
 * any dot-prefixed segment, and the watcher matches it against
 * `relative(baseDir, path)` — where `baseDir` is the *profile* directory, a sibling
 * of this package. On Windows that path is `..\plugins\dsh-ssh\lib\service.js`:
 * picomatch does not treat `\` as a separator, so the whole string is one segment
 * that begins with `.` and the default pattern ignores every file under the root.
 * A rebuilt `lib` tree then produces no reload event at all (observed: `apply()`
 * re-ran from the row toggle and still reported the previous method count). The live
 * row therefore watches the three source trees directly and passes `ignored: []`,
 * which is also cheaper: none of them contains `node_modules` or a dot-directory.
 * The full explanation lives in the profile patch's managed block.
 */
import type { Context } from '@deepseek-ai/cordis';
import { Config, type Config as SshConfig } from './config.js';
export declare const name = "dsh-ssh";
/** The tool registry is the only hard dependency; everything else is opportunistic. */
export declare const inject: string[];
export { Config };
export type { Config as SshPluginConfig } from './config.js';
export * from './protocol.js';
export declare function apply(ctx: Context, config: SshConfig): Promise<void>;
//# sourceMappingURL=index.d.ts.map