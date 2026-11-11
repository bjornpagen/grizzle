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
 *
 * Plant (~/.cache/grizzle-release/BR06/plants): page-bounded-union-paged (an order over the take paged as an unbounded
 * union is).
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { element, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Effect, Formatter } from "effect"
import { refused } from "#test/support/assert.ts"
import { testCompile } from "#test/support/compile.ts"
import { caseHang } from "#test/support/limits.ts"
import { compiledPageResult, flagged, flaggedByTitle } from "#test/unit/page/fixtures.ts"

type Union = "flagged" | "flagged by title"

type Reorder = "the union's own order" | "its key reversed"

type Feature = Union | Reorder

/**
 * The union taken at `take` and ordered again: by its own order (flagged's id descending, flaggedByTitle's title
 * ascending), or by its key in the other direction.
 */
const bounded = (union: Union, reorder: Reorder, take: number): unknown => {
	const own = reorder === "the union's own order"
	switch (union) {
		case "flagged":
			return flagged.take(take).orderBy(["id", own ? "desc" : "asc"])
		case "flagged by title":
			return flaggedByTitle.take(take).orderBy(["title", own ? "asc" : "desc"])
	}
}

describe("the page compiler", () => {
	it.effect("refuses a bounded heterogeneous union, whatever its bound and order", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "specification",
						name: "no page over a bounded heterogeneous union, refused as UnsupportedOperation"
					},
					suite: "unit/page/bounded-union",
					draw: drawn((source) => ({
						union: source.draw(element<Union>(["flagged", "flagged by title"])),
						reorder: source.draw(element<Reorder>(["the union's own order", "its key reversed"])),
						take: source.draw(int(1, 50))
					})),
					literal: Formatter.format,
					coverage: required<Feature>(
						["flagged", "flagged by title", "the union's own order", "its key reversed"],
						{ cases: 30, sense: notesOnly }
					),
					kept: [],
					runs: 30,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				({ union, reorder, take }, c) =>
					Effect.sync(() => {
						refused(
							compiledPageResult(bounded(union, reorder, take), testCompile),
							"UnsupportedOperation",
							`${union}, ${reorder}`
						)
						c.note(union)
						c.note(reorder)
					})
			)
		)
	)
})
