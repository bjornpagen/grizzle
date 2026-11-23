/**
 * The names of public/schema.ts the schema agreement's generated program reads as Sc
 * (test/support/agreement/schemas.ts), its prelude (test/support/prelude.ts): the program reads that namespace through
 * this module alone.
 */
export {
	alternatives,
	check,
	closed,
	contained,
	counted,
	derived,
	fin,
	fold,
	key,
	mirrors,
	Monoid,
	mutable,
	on,
	ordered,
	pred,
	relation,
	role,
	schema,
	select,
	tree,
	unit
} from "#compiler/public/schema.ts"
export type {
	ContainmentsOf,
	Fact,
	KeysOf,
	KeyValues,
	LevelsOf,
	Relation,
	StatementsOf,
	WriteListOf
} from "#compiler/public/schema.ts"
