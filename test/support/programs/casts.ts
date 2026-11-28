/**
 * The names the casts program reads (test/types/compute/casts.ts), its prelude (test/support/prelude.ts): the program
 * imports these alone, each through this module.
 */
export { Num, Type } from "#compiler/public/compute.ts"
export {
	exactInteger,
	exactMoney,
	float4,
	float8,
	int2,
	int4,
	int8,
	Money,
	money,
	numeric,
	Numeric
} from "#compiler/public/fields.ts"
export { query, v } from "#compiler/public/query.ts"
export { relation, schema } from "#compiler/public/schema.ts"
