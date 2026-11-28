/**
 * The names the drawn-types program reads (test/types/schema/drawn-types.ts), its prelude (test/support/prelude.ts):
 * the program imports these alone, each through this module.
 */
export { Logic } from "#compiler/public/compute.ts"
export { domain, drawn, int2, int4, int8, natural, numeric } from "#compiler/public/fields.ts"
export { contained, counted, fin, on, ordered, relation, schema } from "#compiler/public/schema.ts"
export { str } from "#compiler/public/text.ts"
