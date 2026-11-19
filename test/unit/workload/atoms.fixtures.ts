/** What the properties of atoms.test.ts read: its spaces, models and helpers. */

import { assert } from "@bjornpagen/testing/assert"
import { Array as Arr } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import { predicateAtoms } from "#compiler/physical/access/atoms.ts"
import { queryInput } from "#compiler/program/compile.ts"
import { query, v } from "#compiler/public/query.ts"
import { succeeded } from "#test/support/assert.ts"
import { checkedInput, checkOptions } from "#test/support/policy.ts"
import { Sp } from "#test/unit/workload/fixtures.ts"

/** The atoms of every Filter a query checks to. */
export const filterAtoms = (q: unknown) => {
	const input = succeeded(queryInput(q), "the query builds")
	if (input.kind !== "built" || input.schema.kind === "fragment") {
		return assert.fail("a built query carries its schema")
	}
	const dag = succeeded(
		checkQuery(
			succeeded(checkedInput(input.schema), "the query's schema checks"),
			input.desc,
			checkOptions("query")
		),
		"the query checks"
	).dag
	return Arr.flatMap(topoOrder(dag), (n) =>
		n.kind === "Filter" ? predicateAtoms(n.input.id, n.pred) : []
	)
}

/** A query over the spans fixture's bookings whose filter is the Allen comparison of `mask` against a window. */
export const allenQuery = (mask: number) =>
	query(Sp.Schedule).rule((r) => {
		const { room, during } = v(Sp.Booking, "booking")
		return r
			.match(Sp.Booking, { room, during })
			.where(r.allen(during, mask, r.param("window", Sp.Booking.fields.during)))
			.find({ room, during })
	})
