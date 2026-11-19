/**
 * The names the hosted-operation program reads (test/types/compute/hosted.ts), its prelude (test/support/prelude.ts):
 * the program imports these alone, each through this module.
 */
export { Compute } from "#compiler/public/compute.ts"
export { contract, generated, pg, uuid } from "#compiler/public/fields.ts"
export { query, v } from "#compiler/public/query.ts"
export { check, derived, relation, schema, select } from "#compiler/public/schema.ts"
