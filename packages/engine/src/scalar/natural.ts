import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import type { Column } from "#compiler/core/decoder.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { Refused } from "#compiler/core/refusals.ts"
import { integerRanges } from "#compiler/ir/carriers.ts"
import { descText, type ExprDesc, type FieldDesc, type TermDesc } from "#compiler/ir/desc.ts"
import { isInstantDesc } from "#compiler/ir/instant.ts"
import { baseOf, naturalName, type ScalarType } from "#compiler/ir/scalar.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { integerHostOf } from "#compiler/scalar/compute/literal.ts"
import { contractParts } from "#compiler/scalar/contract.ts"
import { int8 } from "#compiler/scalar/pg.ts"
import { defineField, describeFieldOrThrow } from "#compiler/scalar/registry.ts"

/**
 * natural's admission: the contract `natural` over int8, whose values are never below zero, which it declares it
 * proves, admitted by the one path every contract is.
 */
const parts = contractParts(naturalName, int8, [
	(v: unknown) => computeCore.ge(v, 0n),
	{ proves: ["nonnegative"] }
])

/** int8's column, which natural's values are read by: a bigint's. */
const column: Column<bigint> = int8.column

/**
 * natural: a count, a bigint never below zero, and the one field type a law side may read pred of. It is the builtin
 * contract `natural` over int8, `CHECK (VALUE >= 0)`, so it lowers to its PostgreSQL domain as every contract
 * does, and a schema that declares another contract under its name declares a conflicting descriptor. Its host type is
 * bigint, unbranded: its column is int8's, and it is no brand constructor. `natural: true` is the member its type
 * is told apart by (types/fields NaturalField).
 */
export const naturalDescriptor = defineField(
	{},
	int8.sql,
	parts.desc,
	{
		name: parts.name,
		base: int8,
		predicate: parts.predicate,
		column,
		natural: true
	},
	SourceLoc("natural", []),
	parts.env
)

/** natural's type, a count's (scalar/aggregate.ts countOverload) and every pred a side's caller writes. */
export const naturalType: ScalarType = describeFieldOrThrow(
	naturalDescriptor,
	SourceLoc("natural", [])
).scalar

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
 * What drawn refuses a type for: grizzle draws a natural, or a value of a contract over an integer, whose own CHECK
 * bounds every value drawn into it.
 */
export const drawnTypes: Refused =
	"drawn(type): natural or a domain over an integer, the types a family's index and count are of"

/**
 * Whether grizzle draws values of a type, by its descriptor: a contract over an integer, int2, int4 or int8, at its last
 * level, natural's among them, but instant, the database's clock's. A drawn value is exact, counted from 0, and enters
 * its column as every value does: the column's carrier and the contract's CHECK refuse one they do not hold. It is the
 * one rule over the types grizzle draws: drawn(type)'s (schema/relation.ts drawnField, analysis/schema.ts) and a
 * series' key's (schema/statements.ts admitSeries, schema/own.ts).
 */
export const isDrawnType = (desc: FieldDesc): boolean =>
	desc.kind === "domain" && !isInstantDesc(desc) && isIntegerDesc(desc.base)

/** Whether a descriptor is of an integer at its last level: smallint, integer or bigint, through every contract over it. */
const isIntegerDesc = (desc: FieldDesc): boolean => {
	switch (desc.kind) {
		case "domain":
			return isIntegerDesc(desc.base)
		case "pg":
			return desc.type === "int2" || desc.type === "int4" || desc.type === "int8"
		case "numeric":
		case "exact":
		case "computedNumeric":
		case "uuid":
		case "bytes":
		case "sha256":
		case "text":
		case "pattern":
		case "span":
		case "closedId":
		case "bits":
		case "vector":
		case "search":
		case "variant":
			return false
	}
}

/**
 * Where a drawn type's values, drawn exactly in bigint, are narrowed into a carrier below bigint, smallint's or
 * integer's (isDrawnType): its greatest value, and the contract whose law a value past it breaks, the type's own; none
 * for a type of bigint's carrier, natural's among them, whose values are drawn in their own carrier.
 */
export interface DrawnNarrowing {
	readonly greatest: bigint
	readonly contract: string
}

export const drawnNarrowing = (type: ScalarType): DrawnNarrowing | undefined => {
	const carrier = baseOf(type).carrier
	return carrier === "int2" || carrier === "int4"
		? {
				greatest: integerRanges[carrier][1],
				contract: defined(type.contract, "a drawn type below int8 is a domain").name
			}
		: undefined
}

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

/**
 * pred(x) over the field `field` of `type`, a drawn type (isDrawnType): its 0 and its 1 written as a value of its
 * carrier is, so they meet x at x's own type (`GuardedTerm`).
 */
const predTerm = (field: string, type: ScalarType): GuardedTerm => {
	const x: ExprDesc = { kind: "field", field }
	const integer = (value: bigint): ExprDesc => ({
		kind: "literal",
		value: integerHostOf(baseOf(type).carrier, value)
	})
	return {
		guard: [{ kind: "compare", op: "gt", left: x, right: integer(0n) }],
		term: { kind: "compute", fn: "sub", args: [x, integer(1n)] }
	}
}

/**
 * A side's term as a row expression (`GuardedTerm`), the term's field of `type`: a field's own value, or pred's. A
 * side's pred, which its caller writes, reads a natural alone (schema/statements.ts admitOn); a family's law reads pred
 * of its index and its count, a drawn type's.
 */
export const guardedTerm = (term: TermDesc, type: ScalarType): GuardedTerm =>
	term.kind === "field" ? valueTerm(term.field) : predTerm(term.field, type)

/** A field's own value as a side's term, defined on every row (`GuardedTerm`). */
const valueTerm = (field: string): GuardedTerm => ({
	guard: [],
	term: { kind: "field", field }
})
