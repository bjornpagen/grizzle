/**
 * The page compiler (lower/shapes/page/compile.ts) refuses a page over a bounded heterogeneous union as
 * UnsupportedOperation: a group statement cannot tell which of its rows are among the union's first k, which only the
 * merge across groups decides.
 *
 * Inputs: the fixture's two heterogeneous unions of heading groups (test/unit/page/fixtures.ts flagged and
 * flaggedByTitle, told apart by the roster-typed level), each taken at any bound and ordered again, by its own order or
 * by its own key reversed: a page reads an Ordered query, so an order over the take is the one page a bounded union
 * can be asked for, and a take with no order after it is no page at all. An unbounded union pages, and the generated
 * page oracle (test/pg/page/generated.ts) holds that side.
 *
 * Oracle: the compiler's contract, a specification: every bounded heterogeneous union is refused, by its tag.
 *
 * Features: each union, and each order over the take: the union's own, and its key reversed.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { element, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { refused } from "#test/support/assert.ts"
import { testCompile } from "#test/support/compile.ts"
import {
	bounded,
	type Feature,
	type Reorder,
	type Union
} from "#test/unit/page/compile.fixtures.ts"
import { compiledPageResult } from "#test/unit/page/fixtures.ts"

/**
 * The page compiler refuses a bounded heterogeneous union, whatever its bound and order.
 *
 * Budget: its suite's count before the conversion (unit/page/bounded-union: 30 independent cases and 0 steered, Vitest
 * at grizzle 4ca3036a).
 */
export const thePageCompilerRefusesABoundedHeterogeneousUnionWhateverItsBoundAndOrder =
	property.explore(
		(source) => ({
			union: source.draw(element<Union>(["flagged", "flagged by title"])),
			reorder: source.draw(element<Reorder>(["the union's own order", "its key reversed"])),
			take: source.draw(int(1, 50))
		}),
		{
			needs: {},
			situations: [
				"flagged",
				"flagged by title",
				"the union's own order",
				"its key reversed"
			] satisfies ReadonlyArray<Reached<Feature>>,
			check:
				(_, c: Case<Feature>) =>
				({ union, reorder, take }) =>
					Effect.sync(() => {
						refused(
							compiledPageResult(bounded(union, reorder, take), testCompile),
							"UnsupportedOperation",
							`${union}, ${reorder}`
						)
						c.note(union)
						c.note(reorder)
					}),
			oracle: {
				kind: "specification",
				name: "no page over a bounded heterogeneous union, refused as UnsupportedOperation"
			},
			budget: { runs: 30, steered: 0 },
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/shapes/page/compile.ts",
					original:
						'\t\t\tcase "takeThenOrder":\n\t\t\t\treturn refuse(\n\t\t\t\t\t"UnsupportedOperation",\n\t\t\t\t\tnodeLabel(bound.take),\n\t\t\t\t\t"a page over a bounded heterogeneous union: a group statement cannot tell which of its rows are among the union\'s first k, which only the merge across groups decides"\n\t\t\t\t)',
					replacement:
						'\t\t\t\treturn refuse(\n\t\t\t\t\t"UnsupportedOperation",\n\t\t\t\t\tnodeLabel(bound.take),\n\t\t\t\t\t"a page over a bounded heterogeneous union: a group statement cannot tell which of its rows are among the union\'s first k, which only the merge across groups decides"\n\t\t\t\t)\n\t\t\tcase "takeThenOrder":',
					why: "An order over the take is paged as an unbounded union is, not refused; the property fails."
				}
			]
		}
	)
