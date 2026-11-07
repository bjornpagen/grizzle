/**
 * The names the generic-source agreement's generated program reads (test/support/agreement/generic-sources.ts), its
 * prelude (test/support/prelude.ts): the program imports these alone, each through this module.
 */
export { query, v } from "#compiler/public/query.ts"
export {
	alternatives,
	check,
	contained,
	counted,
	fin,
	fold,
	key,
	mirrors,
	Monoid,
	on,
	ordered,
	select,
	tree
} from "#compiler/public/schema.ts"
export {
	A,
	Arm,
	B,
	Folded,
	IA,
	IB,
	IM,
	Kind,
	Members,
	MKind,
	MN,
	MOwner,
	Other,
	Slots,
	Slots2,
	SlotsM,
	T1,
	T2,
	Target,
	TM,
	W
} from "#test/support/agreement/generic-schema.ts"
