/**
 * The names the hosted-operation program reads (test/types/compute/hosted.ts), its prelude (test/support/prelude.ts):
 * the program imports these alone, each through this module.
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
export {
	domain,
	float8,
	generated,
	int4,
	int8,
	numeric,
	uuid,
	vector
} from "#compiler/public/fields.ts"
export { query, v } from "#compiler/public/query.ts"
export { check, derived, fn, relation, schema, select } from "#compiler/public/schema.ts"
export { Id } from "#test/support/ids.ts"
