/**
 * The names the bound-argument agreement's generated program reads (test/support/agreement/bound-arguments.ts), its
 * prelude (test/support/prelude.ts): the program imports these alone, each through this module.
 */
export { Fn } from "#compiler/public/compute.ts"
export { int4, int8 } from "#compiler/public/fields.ts"
export { type ParamsOf, query, v } from "#compiler/public/query.ts"
export {
	attached,
	Bound,
	f,
	g,
	Item,
	none,
	relational,
	scalar,
	taken,
	union
} from "#test/support/agreement/bound-arguments-schema.ts"
