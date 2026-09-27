/**
 * Frozen connection-layer surface — mirrors `docs/ICD.md` §7.1 verbatim.
 *
 * SP2 (`src/exec`) and SP3 (`src/sftp`) code against exactly these signatures.
 * A change here is an ICD change: message the Lead before touching it.
 *
 * The file also declares the *injection ports* the pool consumes for services
 * owned by other agents (SP4 credentials / known-hosts / redaction, SP3 SFTP).
 * They are structural mirrors of the ICD interfaces, which keeps TypeScript's
 * structural typing happy across module boundaries and lets this module be
 * unit-tested with hand-written doubles long before the other agents land.
 */
export {};
//# sourceMappingURL=types.js.map