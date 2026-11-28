/**
 * The names the scalar agreement's generated program reads (test/support/agreement/compute.ts), its prelude
 * (test/support/prelude.ts): the program imports these alone, each through this module.
 */
export {
	Crypto,
	Distance,
	Fn,
	Logic,
	Net,
	Num,
	Range,
	Search,
	Text,
	Time,
	Type,
	Xml
} from "#compiler/public/compute.ts"
export { Bit, bytea, Numeric, generated, Money, sha256, uuid } from "#compiler/public/fields.ts"
export type { CalendarDate, Uuid, Vector } from "#compiler/public/fields.ts"
export { query, v } from "#compiler/public/query.ts"
export type { HeadOf, ParamsOf, ParamType, Rule } from "#compiler/public/query.ts"
export { relation, schema } from "#compiler/public/schema.ts"
export { lexicalForm, str } from "#compiler/public/text.ts"
export type {
	DomainOf,
	Rostered,
	SqlOfTerm,
	TypeOfTerm,
	Unordered,
	Zoned
} from "#compiler/types/core/phantom.ts"
export type { Infer } from "#compiler/types/fields/field.ts"
export type { Aggregate } from "#compiler/types/query/terms.ts"
export type { SqlTag } from "#compiler/scalar/registry.ts"
export {
	bodyKey,
	Cell,
	Cells,
	centsKey,
	divisorKey,
	epochDayKey,
	Heads,
	Hue,
	rateKey,
	toBody,
	toCents,
	toDivisor,
	toEpochDay,
	Tone,
	toRate,
	Tuning
} from "#test/support/agreement/compute-schema.ts"
export { Id, idKey, toId } from "#test/support/ids.ts"
