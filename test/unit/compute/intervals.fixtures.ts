/** What the property of intervals.test.ts reads: its box, the typings it judges and the brute force it judges them by. */

import { defined } from "@bjornpagen/testing/assert"
import { element, type FiniteSpace, finite, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Option } from "effect"
import { type Bounds, seriesBounds } from "#compiler/scalar/compute/bounds.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import type { ScalarTerm } from "#compiler/scalar/compute/term.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	baseParams,
	spelledExpr,
	type TestField,
	testContract,
	testPg,
	typeWith,
	v
} from "#test/unit/compute/support.ts"

/**
 * What an interval is read off: a term over two integers (Type.base of the first, GREATEST, LEAST, and an exact
 * integer's truncating division), or a series from the first to the second (seriesBounds).
 */
export const operations = ["base", "greatest", "least", "quotient", "series"] as const
export type Operation = (typeof operations)[number]

/** A case: an operation over x within [a, b] and y within [c, d], each a closed interval of a few integers. */
export interface IntervalCase {
	readonly operation: Operation
	readonly a: number
	readonly b: number
	readonly c: number
	readonly d: number
}

/** The ends an operand's interval is drawn from: a few integers either side of zero, zero among them. */
const end = int(-3, 3)

/** Every operation over every pair of intervals of the ends, each of x's and y's ends in order. */
export const intervalBox: FiniteSpace<IntervalCase> = finite((source) => {
	const operation = source.draw(element(operations))
	const a = source.draw(end)
	const b = source.draw(int(a, 3))
	const c = source.draw(end)
	const d = source.draw(int(c, 3))
	return { operation, a, b, c, d }
})

/** A bigint contract within [low, high], whose predicate's atoms are its bounds (typing.ts boundsOfType). */
const within = (name: string, low: number, high: number): TestField =>
	testContract(name, testPg.bigint, (x) =>
		computeCore.and([computeCore.ge(x, BigInt(low)), computeCore.le(x, BigInt(high))])
	)

/** The operation's term over the variables x and y. */
const termOf = (operation: Exclude<Operation, "series">, x: ScalarTerm, y: ScalarTerm) => {
	const bx = computeCore.base(x)
	const by = computeCore.base(y)
	switch (operation) {
		case "base":
			return bx
		case "greatest":
			return computeCore.greatest(bx, by)
		case "least":
			return computeCore.least(bx, by)
		case "quotient":
			return computeCore.div(bx, by)
	}
}

/** The typed interval of a term, its root's bounds. */
const typedBounds = (
	term: { readonly expr: Parameters<typeof spelledExpr>[0] },
	x: TestField,
	y: TestField
): Bounds =>
	defined(
		succeeded(
			typeWith(
				spelledExpr(term.expr),
				{ x: { kind: "column", type: x.scalar }, y: { kind: "column", type: y.scalar } },
				false,
				baseParams
			)
		).root.bounds,
		"an integer term's bounds"
	)

/** The interval the engine states for a case: its term's typed bounds, or a series' element's over x's and y's. */
export const statedOf = (c: IntervalCase): Bounds => {
	const x = within("X", c.a, c.b)
	const y = within("Y", c.c, c.d)
	if (c.operation === "series") {
		return seriesBounds(
			typedBounds(computeCore.base(v("x", x)), x, y),
			typedBounds(computeCore.base(v("y", y)), x, y)
		)
	}
	return typedBounds(termOf(c.operation, v("x", x), v("y", y)), x, y)
}

/** The integers from low to high, both included. */
const span = (low: number, high: number): ReadonlyArray<number> =>
	Array.from({ length: Math.max(high - low + 1, 0) }, (_, i) => low + i)

/** PostgreSQL's div: the quotient truncated toward zero. */
const truncated = (x: number, y: number): number => Number(BigInt(x) / BigInt(y))

/**
 * Every value the operation takes over every x within [a, b] and y within [c, d], by brute force: a division's by every
 * y but zero, which its precondition excludes, and a series' every element of every (x, y), none where x lies above y.
 */
export const valuesOf = (c: IntervalCase): ReadonlyArray<number> =>
	Arr.flatMap(span(c.a, c.b), (x) =>
		Arr.flatMap(span(c.c, c.d), (y): ReadonlyArray<number> => {
			switch (c.operation) {
				case "base":
					return [x]
				case "greatest":
					return [Math.max(x, y)]
				case "least":
					return [Math.min(x, y)]
				case "quotient":
					return y === 0 ? [] : [truncated(x, y)]
				case "series":
					return span(x, y)
			}
		})
	)

/** Whether a case's stated interval must be exactly its values' hull: every case but a division by a range through zero. */
export const exact = (c: IntervalCase): boolean => c.operation !== "quotient" || c.c > 0 || c.d < 0

/** The least and the greatest integer an interval admits, its edges read as integers' (undefined at an infinity). */
export const integerEnds = (b: Bounds): readonly [number | undefined, number | undefined] => {
	const lowEnd = (): number | undefined => {
		if (b.low.kind !== "at") {
			return undefined
		}
		const value = Number(b.low.value.units) / 10 ** b.low.value.scale
		const up = Math.ceil(value)
		return b.low.open && up === value ? up + 1 : up
	}
	const highEnd = (): number | undefined => {
		if (b.high.kind !== "at") {
			return undefined
		}
		const value = Number(b.high.value.units) / 10 ** b.high.value.scale
		const down = Math.floor(value)
		return b.high.open && down === value ? down - 1 : down
	}
	return [lowEnd(), highEnd()]
}

/** The least and the greatest of some values. */
export const hullOf = (values: ReadonlyArray<number>): Option.Option<readonly [number, number]> =>
	Arr.match(values, {
		onEmpty: () => Option.none(),
		onNonEmpty: (some) =>
			Option.some([
				Arr.reduce(some, some[0], (m, x) => Math.min(m, x)),
				Arr.reduce(some, some[0], (m, x) => Math.max(m, x))
			] as const)
	})

/** What a case reaches: its operation, and for a division whether its divisor's range passes through zero. */
export type Feature = Operation | "a division by a range through zero" | "a series of no element"
