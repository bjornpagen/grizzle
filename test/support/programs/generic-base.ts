/**
 * The names the generic-base program reads (test/types/schema/generic-base.ts), its prelude (test/support/prelude.ts):
 * the program imports these alone, each through this module.
 */
export { closedId, natural } from "#compiler/public/fields.ts"
export { query, v } from "#compiler/public/query.ts"
export type { AnySchema, SchemaOver } from "#compiler/public/schema.ts"
export { closed, contained, derived, on, relation, schema } from "#compiler/public/schema.ts"
