/** What the properties of domain.test.ts read: its spaces, models and helpers. */

import { boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { NumericBound, ScalarType } from "#compiler/ir/scalar.ts"
import { numericValue } from "#compiler/scalar/registry.ts"
import { btreeMaxItemSize, btreeEntryBytes, datumBound } from "#compiler/schema/representability.ts"
import { allTypeSpecs, fieldDescOf, scalarOfSpec } from "#test/support/oracle/gen/domain.ts"
import { naturalType } from "#test/support/oracle/gen/natural.ts"

const roster = scalarOfSpec({
	carrier: "code",
	roster: { closed: "K0", handles: ["H0", "H1", "H2"] }
})
/**
 * The computed numerics a generated query's columns are typed at (an operation's or an aggregate's result, with the
 * bound its making proved), over a box of bounds around the raw classes' widths: no, one, two and twenty integer digits,
 * and no, one and two fraction digits.
 */
const computed: ReadonlyArray<ScalarType> = Arr.flatMap([0, 1, 2, 20], (digits) =>
	Arr.map([0, 1, 2], (scale) => numericValue({ digits, scale }))
)

const types: Arr.NonEmptyReadonlyArray<ScalarType> = Arr.appendAll(
	Arr.append(Arr.append(Arr.map(allTypeSpecs, scalarOfSpec), roster), naturalType),
	computed
)

/**
 * Whether a numeric class lies within a computed numeric's bound: its magnitude below 10^digits and its value a multiple
 * of 10^-scale, a negative digits or scale read exactly (bounds.ts tenTo): the value is its coefficient over 10^minScale,
 * so it is below 10^digits exactly when 10^digits times 10^minScale exceeds the coefficient.
 */
export const withinBound = (literal: TypedLiteral, bound: NumericBound): boolean => {
	if (literal.kind !== "numeric" || literal.value.parts.kind !== "finite") {
		return true
	}
	const p = literal.value.parts
	const shift = bound.digits + p.minScale
	const below = shift >= 0 ? p.coefficient < 10n ** BigInt(shift) : p.coefficient === 0n
	const multiple =
		p.minScale <= bound.scale ||
		(p.minScale === 0 && p.coefficient % 10n ** BigInt(-bound.scale) === 0n)
	return below && multiple
}

/**
 * Whether a type passes the key representability check as a one-field key (schema/representability.ts): its datum
 * bounded and its B-tree entry within BTMaxItemSize.
 */
export const representableKey = (type: ScalarType): boolean => {
	const bound = datumBound(fieldDescOf(type))
	return (
		bound !== undefined &&
		btreeEntryBytes([{ name: "k", datum: bound, nullable: false }]) <= btreeMaxItemSize
	)
}

/** What a generated type reaches: each carrier the claims single out, edge classes, its own key type, a computed numeric. */
export type TypeFeature =
	| ScalarType["carrier"]
	| "edge classes"
	| "a type that is its own key type"
	| "a computed numeric"
	| "a contract's predicate"

/** How a key field keeps its type: as a span or as a scalar. */
type Keep = "span" | "scalar"

/**
 * Every type, computed numerics included, with and without its edge classes, each key kept as a span or as a scalar.
 */
export const typeBox: Gen<readonly [ScalarType, boolean, Keep]> = (source) =>
	[
		source.draw(element(types)),
		source.draw(boolean),
		source.draw(element<Keep>(["span", "scalar"]))
	] as const

/** A type, a value class and a spelling of it, and whether its edge classes are drawn. */
export const spellingGen: Gen<readonly [ScalarType, number, number, boolean]> = (source) =>
	[
		source.draw(element(types)),
		source.draw(int(0, 12)),
		source.draw(int(0, 6)),
		source.draw(boolean)
	] as const
