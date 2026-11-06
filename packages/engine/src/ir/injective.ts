import type { ScalarExpr } from "#compiler/ir/expr.ts"
import {
	baseOf,
	type Carrier,
	numericTypmodOf,
	rosterOf,
	type ScalarType,
	vectorTypmodOf
} from "#compiler/ir/scalar.ts"

const integers: ReadonlyArray<Carrier> = ["int2", "int4", "int8"]

/** The scale a numeric type rounds to, or undefined when it keeps any scale. */
const numericScale = (t: ScalarType): number | undefined => numericTypmodOf(t)?.scale

const crossCarrier: ReadonlySet<string> = new Set([
	"int2->float4",
	"int2->float8",
	"int4->float8",
	"float4->float8"
])

/**
 * Whether the native cast from `from` to `to` maps distinct values to distinct values under native equality.
 *
 * Injective representation of a key column through a scalar computation.
 *
 * "Scalar computation: preserve only keys still retained or proved injectively represented. A function of a key is
 * not necessarily injective": integer division, lowercasing text, or a rounding cast can destroy uniqueness, and "a
 * numeric typmod cast that rounds is not an equality-preserving rename". The admitted injective set is deliberately
 * small and is decided over native equality, the equality DISTINCT and the key constraints compare under:
 *
 * - a cast within one carrier that keeps every value: dropping or adding a contract or text refinement (a domain cast
 *   only validates membership), a numeric cast whose target scale does not round the source's, a vector cast that
 *   keeps the dimension, a closed id's or a set's cast within its roster;
 * - a widening integer cast, a proved integer narrowing (it is exact where it stands, never merges two values), an
 *   integer into numeric at a scale that does not round, a smallint into real or double precision, an integer into
 *   double precision, and real into double precision (every binary32 value is exact in binary64, and NaN and the two
 *   zeros keep their native equality);
 * - an integer into the exact integers and money into exact money, and an exact value narrowed back where proved, its
 *   value unchanged;
 * - nothing else. No operator is admitted: an arithmetic identity that could be injective is not worth its proof, and
 *   a computed output is still determined by its inputs (fds.ts), which is all a later key needs.
 */
export const castInjective = (from: ScalarType, to: ScalarType): boolean => {
	const f = baseOf(from)
	const t = baseOf(to)
	if (f.carrier === t.carrier) {
		switch (f.carrier) {
			case "numeric": {
				const target = numericScale(t)
				const source = numericScale(f)
				return target === undefined || (source !== undefined && target >= source)
			}
			case "vector":
				return f.typmod.dims === vectorTypmodOf(t)?.dims
			case "code":
			case "bits":
				return f.roster.closed === rosterOf(t)?.closed
			case "int2":
			case "int4":
			case "int8":
			case "float4":
			case "float8":
			case "money":
			case "bool":
			case "uuid":
			case "date":
			case "text":
			case "range4":
			case "range8":
			case "exactInteger":
			case "exactMoney":
				return true
		}
	}
	if (integers.includes(f.carrier) && integers.includes(t.carrier)) {
		return true
	}
	if (
		(integers.includes(f.carrier) && t.carrier === "exactInteger") ||
		(f.carrier === "exactInteger" && integers.includes(t.carrier)) ||
		(f.carrier === "money" && t.carrier === "exactMoney") ||
		(f.carrier === "exactMoney" && t.carrier === "money")
	) {
		return true
	}
	if (integers.includes(f.carrier) && t.carrier === "numeric") {
		const target = numericScale(t)
		return target === undefined || target >= 0
	}
	return crossCarrier.has(`${f.carrier}->${t.carrier}`)
}

/** The identity a coercion contributes to a certificate. */
export const castIdentity = (from: ScalarType, to: ScalarType): `cast:${Carrier}->${Carrier}` =>
	`cast:${baseOf(from).carrier}->${baseOf(to).carrier}`

/**
 * The value an equality compares an operand at: under every cast that maps distinct values to distinct values
 * (castInjective), its operand, so an equality of the cast values is an equality of the values. An equality of a column
 * with an expression over parameters and literals fixes the column, and of two columns equates them, whatever carriers
 * and widenings the comparison is written at.
 */
export const comparedValue = (e: ScalarExpr): ScalarExpr => {
	if (e.kind !== "cast") {
		return e
	}
	const [arg] = e.args
	return castInjective(arg.type, e.type) ? comparedValue(arg) : e
}
