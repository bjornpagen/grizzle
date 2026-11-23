/**
 * The least exponents of a relation's declared statistics (physical/statistics/least.ts): an exact search over integer
 * exponents, the least largest anchor exponent, then the columns' least in column order, then each anchor's least.
 *
 * Property: over small systems (one or two anchors, one to four columns, one to six key and apart bounds, each over an
 * anchor or a pair of anchors a dependency ties, which binds two rows), a least
 * solution meets every bound, and no solution of the box its own largest exponent spans is less: none of a smaller
 * largest anchor exponent, none of the same with lexicographically smaller columns, and its anchors each at their least;
 * a crossing is a set of the system's bounds the box of exponents up to twice the bounds' count holds no solution of,
 * and dropping any one of them leaves a system with a least solution.
 *
 * Oracle: second implementation, brute force over the box (least.fixtures.ts leastInBox).
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { leastExponents } from "#compiler/physical/statistics/least.ts"
import {
	type LeastFeature,
	leastInBox,
	meets,
	systemGen
} from "#test/unit/statistics/least.fixtures.ts"

/** The least exponents meet every bound and are least against brute force over the box they span. */
export const theLeastExponentsMeetEveryBoundAndAreLeastAgainstBruteForce = property.explore(
	systemGen,
	{
		needs: {},
		situations: [
			"a system with a least solution",
			"a crossing",
			"an anchor above 1",
			"a column above 1",
			"two anchors",
			"a bound over a pair"
		] satisfies ReadonlyArray<Reached<LeastFeature>>,
		check: (_, c: Case<LeastFeature>) => (system) =>
			Effect.sync(() => {
				if (system.anchors > 1) {
					c.note("two anchors")
				}
				if (Arr.some(system.bounds, (b) => b.over.kind === "pair")) {
					c.note("a bound over a pair")
				}
				const least = leastExponents(system)
				if (least.kind === "crossing") {
					c.note("a crossing")
					const crossed = {
						...system,
						bounds: Arr.map(least.bounds, (i) => defined(system.bounds[i], "a bound"))
					}
					assert.equal(
						leastInBox(crossed, 2 * crossed.bounds.length),
						undefined,
						"a crossing's bounds hold no solution"
					)
					for (const i of least.bounds.keys()) {
						const fewer = { ...crossed, bounds: Arr.filter(crossed.bounds, (_, j) => j !== i) }
						assert.equal(
							leastExponents(fewer).kind,
							"least",
							"a crossing is least: dropping any one of its bounds leaves a solution"
						)
					}
					return
				}
				c.note("a system with a least solution")
				if (Arr.some(least.anchors, (y) => y > 1)) {
					c.note("an anchor above 1")
				}
				if (Arr.some(least.columns, (x) => x > 1)) {
					c.note("a column above 1")
				}
				assert.ok(
					meets(system, least.anchors, least.columns),
					"the least solution meets every bound"
				)
				const top = Arr.reduce(least.anchors, 0, (m, y) => Math.max(m, y))
				assert.deepEqual(
					leastInBox(system, top),
					{ anchors: least.anchors, columns: least.columns },
					"the least solution is brute force's least over its box"
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "brute force over the box of exponents the least solution spans (least.fixtures.ts leastInBox)"
		},
		kept: [],
		kills: []
	}
)
