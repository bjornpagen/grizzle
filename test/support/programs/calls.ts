/**
 * The names the declared-call program reads (test/types/compute/calls.ts), its prelude (test/support/prelude.ts): the
 * program imports these alone, each through this module.
 */
export {
	Crypto,
	Distance,
	Fn,
	Logic,
	Num,
	Range,
	Search,
	Text,
	Type,
	Xml
} from "#compiler/public/compute.ts"
export { closedId, uuid } from "#compiler/public/fields.ts"
export { query, v } from "#compiler/public/query.ts"
export { closed, fn, relation, row, rows, schema } from "#compiler/public/schema.ts"
export { Id } from "#test/support/ids.ts"
