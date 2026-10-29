import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import { predicateAtoms } from "#compiler/physical/access/atoms.ts"
import { queryInput } from "#compiler/program/compile.ts"
import { query, v } from "#compiler/public/query.ts"
import { allenMaskMax } from "#compiler/query/build/terms.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { checking, checkOptions } from "#test/support/policy.ts"
import { Sp } from "#test/unit/workload/fixtures.ts"

/**
 * Predicate atoms for access-path extraction (physical/access): every Allen mask's formula but the full mask's yields
 * the span atom on its span field that a GiST index serves; the full mask holds of every pair and lowers to no
 * predicate, so it yields none.
 */

/** The atoms of every Filter a query checks to. */
const filterAtoms = (q: unknown) => {
	const input = succeeded(queryInput(q), "the query builds")
	if (input.kind !== "built") {
		return assert.fail("a built query carries its schema")
	}
	const dag = succeeded(
		checkQuery(checking(input.schema), input.desc, checkOptions("query")),
		"the query checks"
	).dag
	return Arr.flatMap(topoOrder(dag), (n) =>
		n.kind === "Filter" ? predicateAtoms(n.input.id, n.pred) : []
	)
}

const allenQuery = (mask: number) =>
	query(Sp.Schedule).rule((r) => {
		const { room, during } = v(Sp.Booking)
		return r
			.match(Sp.Booking, { room, during })
			.where(r.allen(during, mask, r.param("window", Sp.Booking.fields.during)))
			.find({ room, during })
	})

describe("Allen masks", () => {
	it.effect(
		"yield the span atom on their span field, every mask but the full one, exhaustively",
		(ctx) =>
			Effect.gen(function* () {
				type Mask = "a partial mask" | "the full mask"
				yield* searched(
					ctx,
					exhaust(
						{
							suite: "unit/workload/atoms-allen",
							generator: int(1, allenMaskMax),
							literal: Formatter.format,
							limit: allenMaskMax,
							features: features<Mask>(["a partial mask", "the full mask"]),
							caseHang: Duration.minutes(2)
						},
						(mask, c) =>
							Effect.sync(() => {
								const full = mask === allenMaskMax
								const spanned = Arr.some(
									filterAtoms(allenQuery(mask)),
									(a) => a.kind === "span" && a.column === "during"
								)
								assert.equal(spanned, !full, `mask ${mask}`)
								c.note(full ? "the full mask" : "a partial mask")
							})
					)
				)
			})
	)
})
