/**
 * The names the closed-key program reads (test/types/evidence/closed-keys.ts), its prelude (test/support/prelude.ts):
 * the program imports these alone, each through this module.
 */
export { closedId, int4 } from "#compiler/public/fields.ts"
export { type EvidenceOfQuery, query, v } from "#compiler/public/query.ts"
export { closed, schema } from "#compiler/public/schema.ts"
