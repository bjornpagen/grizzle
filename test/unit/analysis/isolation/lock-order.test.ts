/**
 * The lock order (analysis/isolation/borrows.ts lockOrder) over drawn members' borrows: up to three members, each
 * borrowing up to three of the units A, B and C and the series lock of R, in flight or at the judge, each borrow keying
 * up to two sites, each bound to a parameter or held under one of those locks.
 *
 * Oracle: the order restated over the drawn borrows and found by trying every order of their locks
 * (lock-order.fixtures.ts expectedOf): where some order puts each edge's first lock before its second, the code's order
 * is the least of them by name, place by place; where none does, the code returns one cycle of those edges in its
 * order, each the edge the first member that needs it states.
 *
 * Features: an order with no edge, a flight lock before a judge lock, a held site's lock before the lock it keys, a tie
 * broken by name, a lock only a held site names, a cycle of one, and a cycle of several locks.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { lockName, lockOrder } from "#compiler/analysis/isolation/borrows.ts"
import {
	type Drawn,
	drawnGen,
	expectedOf,
	type OrderFeature,
	statedOf
} from "#test/unit/analysis/isolation/lock-order.fixtures.ts"

/** The lock order is the least by name of the orders the members' borrows need, or one cycle where none is. */
export const theLockOrderIsTheLeastByNameOfTheOrdersTheMembersBorrowsNeedOrOneCycleWhereNoneIs =
	property.explore(drawnGen, {
		needs: {},
		situations: [
			"an order with no edge",
			"a flight lock before a judge lock",
			"a held site's lock before the lock it keys",
			"a tie broken by name",
			"a lock only a held site names",
			"a cycle of one",
			"a cycle of several locks"
		] satisfies ReadonlyArray<OrderFeature>,
		check: (_, c: Case<OrderFeature>) => (drawn: Drawn) =>
			Effect.sync(() => {
				const expected = expectedOf(drawn)
				for (const f of expected.features) {
					c.note(f)
				}
				const got = lockOrder(drawn)
				if (expected.order !== undefined) {
					assert.ok(got.ok, "an order where one is")
					assert.deepEqual(
						Arr.map(got.value, lockName),
						[...expected.order],
						"the least order by name"
					)
					return
				}
				assert.ok(!got.ok, "a cycle where no order is")
				const cycle = Arr.map(got.error, statedOf)
				for (const [i, e] of cycle.entries()) {
					assert.equal(
						e.to,
						Arr.getUnsafe(cycle, (i + 1) % cycle.length).from,
						"each edge of the cycle leads to the next, the last to the first"
					)
					assert.ok(
						Arr.some(expected.edges, (x) => x.from === e.from && x.to === e.to && x.by === e.by),
						"each edge of the cycle is one the first member that needs it states"
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: "the lock order restated over the drawn borrows: the least by name of every order that meets their edges, tried whole, or a cycle of those edges"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/isolation/borrows.ts",
				original: "\tconst names = [...locks.keys()].toSorted(compareStrings)\n",
				replacement: "\tconst names = [...locks.keys()].toSorted((a, b) => compareStrings(b, a))\n",
				why: "Ties broken by the greatest name: two installations of one schema agree, but the order is no longer the one its doc and the lock plan's ids name."
			},
			{
				file: "packages/engine/src/analysis/isolation/borrows.ts",
				original:
					'\t\t\tsite.kind === "held" ? [{ from: site.under, to: b.lock, by, why: "under" }] : []\n',
				replacement: "\t\t\t[]\n",
				why: "A held site's lock ranked anywhere: a call reads the key it learns under a lock it takes only later, so the key moves before it is locked."
			}
		]
	})
