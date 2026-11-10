import type { Column } from "#compiler/core/decoder.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { descText, type ExprDesc, type FieldDesc, type TermDesc } from "#compiler/ir/desc.ts"
import { contractParts } from "#compiler/scalar/contract.ts"
import { pgDescriptors } from "#compiler/scalar/pg.ts"
import { defineField } from "#compiler/scalar/registry.ts"

/** The comparison natural's predicate reads its VALUE by: a scalar of bigint, compared with a bigint literal. */
interface NaturalValue {
	readonly ge: (other: bigint) => unknown
}

/**
 * natural's admission: the contract `natural` over pg.bigint, whose values are never below zero, which it declares it
 * proves, admitted by the one path every contract is.
 */
const parts = contractParts("natural", pgDescriptors.bigint, [
	(v: NaturalValue) => v.ge(0n),
	{ proves: ["nonnegative"] }
])

/** pg.bigint's column, which natural's values are read by: a bigint's. */
const column: Column<bigint> = pgDescriptors.bigint.column

/**
 * natural: a count, a bigint never below zero, and the one field type a law side may read pred of. It is the builtin
 * contract `natural` over pg.bigint, `CHECK (VALUE >= 0)`, so it lowers to its PostgreSQL domain as every contract
 * does, and a schema that declares another contract under its name declares a conflicting descriptor. Its host type is
 * bigint, unbranded: its column is pg.bigint's, and it is no brand constructor. `natural: true` is the member its type
 * is told apart by (types/fields NaturalField).
 */
export const naturalDescriptor = defineField(
	{},
	pgDescriptors.bigint.sql,
	parts.desc,
	{
		name: parts.name,
		base: pgDescriptors.bigint,
		predicate: parts.predicate,
		column,
		natural: true
	},
	SourceLoc("natural", []),
	parts.env
)

/** A field descriptor's canonical text, its identity. A decoded descriptor always has one, so a failure is a defect. */
const fieldText = (desc: FieldDesc): string => {
	const text = descText(desc)
	if (!text.ok) {
		throw text.error
	}
	return text.value
}

/** natural's descriptor as a Description states it, by its canonical text. */
const naturalText = fieldText(parts.desc)

/**
 * Whether a field descriptor is natural's: the one a law side may read pred of. Identity is the canonical text, so a
 * contract declared with natural's very name, base, predicate and facts is natural, and any other is not. pred is exact
 * to natural, never to a refinement of it: pred(x) is typed as x's own type (types/schema TermTypeOf), which holds only
 * for a type closed under x - 1 above zero, as natural is and a refinement such as ge(5) is not.
 */
export const isNaturalDesc = (desc: FieldDesc): boolean => fieldText(desc) === naturalText

/**
 * A law side's term as a row expression over its relation's own fields: its value, and the guard it is defined under,
 * conjuncts that all hold where it is. A field is itself, defined on every row. pred(x), natural's destructor, is
 * `x - 1` under `x > 0`, computed at the field's own type: above zero the difference is a natural, so it never leaves
 * that type. A law's violation query and the law column a term lowers to both read it, so one definition computes
 * pred everywhere.
 */
export interface GuardedTerm {
	readonly guard: ReadonlyArray<ExprDesc>
	readonly term: ExprDesc
}

/** pred(x) over the natural field `field` (`GuardedTerm`). */
const predTerm = (field: string): GuardedTerm => {
	const x: ExprDesc = { kind: "field", field }
	return {
		guard: [{ kind: "compare", op: "gt", left: x, right: { kind: "literal", value: 0n } }],
		term: { kind: "compute", fn: "sub", args: [x, { kind: "literal", value: 1n }] }
	}
}

/** A side's term as a row expression (`GuardedTerm`): a field's own value, or pred's. */
export const guardedTerm = (term: TermDesc): GuardedTerm =>
	term.kind === "field"
		? { guard: [], term: { kind: "field", field: term.field } }
		: predTerm(term.field)
