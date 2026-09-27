/**
 * Compile-time proof that the exec layer and the connection layer agree.
 *
 * `src/exec/**` declares structural mirrors of ICD §7.1 (see `types.ts`) so it
 * can be developed and tested against fakes without importing SP1's module. That
 * freedom has one failure mode: the two declarations could drift apart and only
 * fail at runtime, inside a running SSH session.
 *
 * This module closes that hole. Every check is a type alias that resolves to
 * `never` — and therefore fails `tsc -p .` — the moment a signature stops being
 * mutually assignable. The checks are **per member**, not whole-interface, so the
 * failing alias names the exact property that drifted (a whole-interface check
 * only says "false").
 *
 * This has already paid for itself: it caught ICD v1.0.4's `ExecHandle.endInput()`
 * being added to SP1's interface while this mirror still lacked it.
 *
 * There is no runtime body; the values are exported only so the module is not
 * elided from the program.
 */
/** Exported so the module is not elided; the value never runs. */
export const COMPAT_CHECKS = true;
//# sourceMappingURL=compat.js.map