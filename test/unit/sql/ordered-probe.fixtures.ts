/** What the property of ordered-probe.test.ts reads: its box, the probe's meaning, and the probe read back over values. */

import { defined } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Option } from "effect"
import type { Expr, OperandSelect } from "#compiler/sql/ast.ts"
import type { ProbeCut } from "#compiler/sql/ordered-probe.ts"

/** The cuts a probe takes. */
const cuts: Arr.NonEmptyReadonlyArray<ProbeCut> = ["<", "<=", ">", ">="]

/** The ordered values a probe's prefix holds, ascending and distinct: none, one, and several apart. */
const orders: Arr.NonEmptyReadonlyArray<ReadonlyArray<number>> = [[], [3], [1, 3, 5], [2, 4, 6, 8]]

/** A case: a cut, the values at the prefix, and the bound, from below every value to above every one. */
export interface ProbeCase {
	readonly cut: ProbeCut
	readonly values: ReadonlyArray<number>
	readonly bound: number
}

export const probeBox: Gen<ProbeCase> = (s) => ({
	cut: s.draw(element(cuts)),
	values: s.draw(element(orders)),
	bound: s.draw(int(0, 9))
})

const holds: { readonly [C in ProbeCut]: (v: number, bound: number) => boolean } = {
	"<": (v, b) => v < b,
	"<=": (v, b) => v <= b,
	">": (v, b) => v > b,
	">=": (v, b) => v >= b
}

/**
 * The probe's meaning, its specification: the value nearest the bound among those past the cut, the greatest below a
 * bound (`<`, `<=`), the least above it (`>`, `>=`); none where no value lies past it.
 */
export const nearestPast = (c: ProbeCase): Option.Option<number> => {
	const past = Arr.filter(c.values, (v) => holds[c.cut](v, c.bound))
	return c.cut === "<" || c.cut === "<=" ? Arr.last(past) : Arr.head(past)
}

const conjunctsOf = (e: Expr): ReadonlyArray<Expr> =>
	e.kind === "and" ? Arr.flatMap(e.args, conjunctsOf) : [e]

const literalOf = (e: Expr): number => {
	if (e.kind !== "literal" || e.value.kind !== "int") {
		throw new Error("a probe's bound and limit are integer literals here")
	}
	return Number(e.value.value)
}

const cutOps: ReadonlySet<string> = new Set(cuts)

/**
 * What the probe's statement reads over the values, by its own parts, the second reading: its WHERE's comparison of the
 * order column with the bound, its ORDER BY's direction and its LIMIT, each read off the statement and applied to the
 * values; the values the statement returns.
 */
export const probeReads = (probe: Expr, values: ReadonlyArray<number>): ReadonlyArray<number> => {
	if (probe.kind !== "subquery") {
		throw new Error("a probe is a scalar subquery")
	}
	const query: OperandSelect = probe.query
	const body = query.body
	if (body.kind !== "core" || body.where === undefined) {
		throw new Error("a probe reads one core with a WHERE")
	}
	const cut = defined(
		Arr.findFirst(conjunctsOf(body.where), (e) => e.kind === "binary" && cutOps.has(e.op)).pipe(
			Option.getOrUndefined
		),
		"the probe's cut"
	)
	if (cut.kind !== "binary") {
		throw new Error("a cut is a comparison")
	}
	const op = cut.op
	const compare = defined(
		Option.getOrUndefined(Arr.findFirst(cuts, (c) => c === op)),
		"the cut's operator"
	)
	const bound = literalOf(cut.right)
	const [order] = query.orderBy
	const limit = query.limit === undefined ? values.length : literalOf(query.limit)
	const past = Arr.filter(values, (v) => holds[compare](v, bound))
	const walked = order?.direction === "DESC" ? Arr.reverse(past) : past
	return Arr.take(walked, limit)
}

export type ProbeFeature =
	| "a predecessor"
	| "a successor"
	| "a probe finding its nearest value"
	| "a probe finding no value"
	| "a bound at a held value"

export const probeFeatures = (c: ProbeCase, found: boolean): ReadonlyArray<ProbeFeature> => [
	c.cut === "<" || c.cut === "<=" ? "a predecessor" : "a successor",
	found ? "a probe finding its nearest value" : "a probe finding no value",
	...(c.values.includes(c.bound) ? ["a bound at a held value" as const] : [])
]
