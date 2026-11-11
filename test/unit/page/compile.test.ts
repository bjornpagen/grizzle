/**
 * The page compiler (lower/shapes/page/compile.ts) refuses a page over a bounded heterogeneous union as
 * UnsupportedOperation: a group statement cannot tell which of its rows are among the union's first k, which only the
 * merge across groups decides.
 *
 * Inputs: the fixture's two heterogeneous unions of heading groups (test/unit/page/fixtures.ts flagged and
 * flaggedByTitle, told apart by the roster-typed level), each bounded by a take of the ordered union or by a take
 * ordered again, at any bound and in either direction. An unbounded union pages, and the generated page oracle
 * (test/pg/page/generated.ts) holds that side.
 *
 * Oracle: the compiler's contract, a specification: every bounded heterogeneous union is refused, by its tag.
 *
 * Features: each union, and each bound: a take of the ordered union, and an order over the take.
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
import { type Direction, directions } from "#compiler/core/order.ts"
import { refused } from "#test/support/assert.ts"
import { testCompile } from "#test/support/compile.ts"
import { caseHang } from "#test/support/limits.ts"
import { compiledPageResult, flagged, flaggedByTitle } from "#test/unit/page/fixtures.ts"

type Union = "flagged" | "flagged by title"

type Bound = "a take of the ordered union" | "an order over the take"

type Feature = Union | Bound

/** The union bounded: taken in its own order, or taken and ordered again by its id. */
const bounded = (union: Union, bound: Bound, take: number, direction: Direction): unknown => {
	const ordered = union === "flagged" ? flagged : flaggedByTitle
	switch (bound) {
		case "a take of the ordered union":
			return ordered.take(take)
		case "an order over the take":
			return ordered.take(take).orderBy(["id", direction])
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
						bound: source.draw(
							element<Bound>(["a take of the ordered union", "an order over the take"])
						),
						take: source.draw(int(1, 50)),
						direction: source.draw(element(directions))
					})),
					literal: Formatter.format,
					coverage: required<Feature>(
						[
							"flagged",
							"flagged by title",
							"a take of the ordered union",
							"an order over the take"
						],
						{ cases: 30, sense: notesOnly }
					),
					kept: [],
					runs: 30,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				({ union, bound, take, direction }, c) =>
					Effect.sync(() => {
						refused(
							compiledPageResult(bounded(union, bound, take, direction), testCompile),
							"UnsupportedOperation",
							`${union}, ${bound}`
						)
						c.note(union)
						c.note(bound)
					})
			)
		)
	)
})
