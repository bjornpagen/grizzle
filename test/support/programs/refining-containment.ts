/**
 * The names the refining-containment program reads (test/types/schema/refining-containment.ts), its prelude
 * (test/support/prelude.ts): the program imports these alone, each through this module.
 */
export { Logic } from "#compiler/public/compute.ts"
export { closedId, contract, instant, int4, int8, natural } from "#compiler/public/fields.ts"
export { closed, contained, on, relation } from "#compiler/public/schema.ts"
