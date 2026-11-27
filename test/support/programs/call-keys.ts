/**
 * The names the call-key program reads (test/types/evidence/call-keys.ts), its prelude (test/support/prelude.ts): the
 * program imports these alone, each through this module.
 */
export { Fn } from "#compiler/public/compute.ts"
export { pg, variant } from "#compiler/public/fields.ts"
export { type EvidenceOfQuery, query, v } from "#compiler/public/query.ts"
export { closed, fn, relation, row, rows, schema } from "#compiler/public/schema.ts"
export { str } from "#compiler/public/text.ts"
