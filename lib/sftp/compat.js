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
export {};
//# sourceMappingURL=compat.js.map