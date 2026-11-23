/**
 * The intervals the bound domain states of a term over two integers and of a series' element (scalar/compute/bounds.ts),
 * over an exhaustive box: x within [a, b] and y within [c, d], each end from -3 to 3, each a bigint contract whose
 * predicate is its interval; Type.base of x, GREATEST and LEAST of their bases, an exact integer's division of x by y,
 * and a series from x to y (r.series's element, seriesBounds).
 *
 * The oracle: brute force, every value the operation takes over every x and y, a division's by every y but zero, a
 * series' every element of every (x, y), none where x lies above y. The stated interval holds every such value, and
 * is exactly their least and greatest where any exists, but for a division by a range through zero, whose quotient may
 * then be as large as its dividend and whose interval only holds its values.
 *
 * Features: each operation; a division by a range through zero; a series of no element.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Option } from "effect"
import {
	exact,
	type Feature,
	hullOf,
	integerEnds,
	intervalBox,
	operations,
	statedOf,
	valuesOf
} from "#test/unit/compute/intervals.fixtures.ts"

/** Type.base, GREATEST, LEAST, an integer's division and a series' element are stated within every value they take, exactly their hull. */
export const anIntervalHoldsEveryValueItsTermTakesExactlyTheirHullTypeBaseGreatestLeastAQuotientAndASeriesElement =
	property.exhaust(intervalBox, {
		box: "Type.base, GREATEST, LEAST, an integer's division and a series' element over every pair of intervals of integers from -3 to 3",
		needs: {},
		situations: [
			...operations,
			"a division by a range through zero",
			"a series of no element"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (drawn) =>
			Effect.sync(() => {
				const [low, high] = integerEnds(statedOf(drawn))
				const values = valuesOf(drawn)
				const what = `${drawn.operation} over x in [${drawn.a}, ${drawn.b}], y in [${drawn.c}, ${drawn.d}]`
				c.note(drawn.operation)
				Option.match(hullOf(values), {
					onNone: () => {
						c.note(drawn.operation === "series" ? "a series of no element" : drawn.operation)
					},
					onSome: ([least, greatest]) => {
						assert.ok(
							low !== undefined && high !== undefined && low <= least && greatest <= high,
							`${what} is stated within [${low}, ${high}], holding every value from ${least} to ${greatest}`
						)
						if (exact(drawn)) {
							assert.deepEqual(
								[low, high],
								[least, greatest],
								`${what} is stated exactly as its values' hull`
							)
						} else {
							c.note("a division by a range through zero")
						}
					}
				})
			}),
		oracle: {
			kind: "specification",
			name: "brute force: every value each operation takes over every x and y in their intervals, a division's by every y but zero, a series' every element of every (x, y)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original: '\t\t\t\tconst combined = desc.fn === "least" ? leastBounds : greatestBounds\n',
				replacement: "\t\t\t\tconst combined = hullBounds\n",
				why: "GREATEST and LEAST are stated as their operands' hull, so LEAST of x in [0, 0] and y in [1, 1] is stated up to 1 and GREATEST of them down to 0, past their values' hull; the ledger's high end of its days reads the instant's top, far past Moment's."
			},
			{
				file: "packages/engine/src/scalar/compute/bounds.ts",
				original: "\t\ttighterLow(a.low, b.low),\n",
				replacement:
					'\t\ta.low.kind === "infinite" || b.low.kind === "infinite" ? infinite : lowest(a.low, b.low),\n',
				why: "GREATEST's least value is its operands' lower least value, so GREATEST of x in [0, 0] and y in [1, 1] is stated down to 0, below its every value."
			},
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original:
					"\t\t\t\t(b.bounds === undefined ? undefined : quotientBounds(dividend, b.bounds)) ??\n",
				replacement: "",
				why: "An exact integer's quotient is stated by its dividend's digits alone, -9 to 9 for x in [0, 3] by y in [1, 3], not 0 to 3: the ledger's day of a microsecond is stated as wide as the microsecond."
			},
			{
				file: "packages/engine/src/scalar/compute/bounds.ts",
				original: "\tbounds(low.low, high.high, false, Math.max(low.digits, high.digits), 0)\n",
				replacement: "\tbounds(low.low, low.high, false, Math.max(low.digits, high.digits), 0)\n",
				why: "A series' element is stated at most its low end's greatest value, so a series from x in [0, 0] to y in [2, 2] is stated within [0, 0] while it holds 1 and 2."
			}
		]
	})
