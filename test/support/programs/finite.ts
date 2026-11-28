/**
 * The names the finite-guard program reads (test/types/compute/finite.ts), its prelude (test/support/prelude.ts): the
 * program imports these alone, each through this module.
 */
export { Logic, Num, Type } from "#compiler/public/compute.ts"
export { float8, int8, numeric } from "#compiler/public/fields.ts"
export { query, v } from "#compiler/public/query.ts"
export { relation, schema } from "#compiler/public/schema.ts"
