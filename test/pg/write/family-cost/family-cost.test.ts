/**
 * The cost of a family write grows linearly with the members it draws, on PostgreSQL 19: a ChangeSet appending L members
 * to one stored group, the family additions statement drawing each appended member's columns (write/family/scan.ts), at
 * three lengths, L = n, 2n and 4n.
 *
 * Property, for each family: the rows the write's statements read and pair (rowsScannedAndPaired, bench/harness/explain.ts: every scan's rows over all of
 * its loops, and every pair a join examined past its keys) grow by no more from 2n to 4n than twice what they grow by
 * from n to 2n. A cost of a fixed part and a part per member grows by exactly twice as much over the
 * doubled step; a cost with any term above linear, a recursion that rereads the appended members once per member it
 * draws among them, grows by more, at every length: no slack, no threshold, no clock. The pages the statements read and
 * the temp they wrote are reported beside the rows, unjudged.
 *
 * The box, exhausted: the families a scan draws differently. A counted family whose appended members draw only their
 * index and their copy of the count (bench/write/families.bench.ts's append, whose 100,000 members' recursive scan wrote
 * some 570 GB of temp before it was cancelled), appended to an empty group, which draws from slot 0; and a counted
 * family with a sum fold, whose hidden before is its predecessor's after, appended past a stored member, which draws
 * from its seed; each at a shortest length n of 125 and of 250 members. Each length's write is applied once on a group
 * of its own, its statements each under EXPLAIN (ANALYZE,
 * BUFFERS, SETTINGS, FORMAT JSON) in its place, its transaction ended by ROLLBACK (bench/write/support/writes.ts
 * explainedChange). The oracle is the law itself, the definition of linear growth; the family suites
 * (test/pg/write/swarm/families.test.ts, test/pg/write/fill-order) judge the rows the same statements write.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	box,
	costOf,
	costText,
	families,
	type FamilyName,
	sketchGen
} from "#test/pg/write/family-cost/family-cost.fixtures.ts"
import { assert } from "#test/support/assert.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The cost of a family write the rows a family's append reads grow by no more from 2n to 4n members than twice what they grow by from n to 2n.
 */
export const theCostOfAFamilyWriteTheRowsAFamilysAppendReadsGrowByNoMoreFrom2nTo4nMembersThanTwiceWhatTheyGrowByFromNTo2n =
	property.exhaust(finite(sketchGen), {
		needs: { substrate: Substrate.installing },
		situations: families satisfies ReadonlyArray<Reached<FamilyName>>,
		check:
			({ substrate }, c: Case<FamilyName>) =>
			(sketch) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const at = yield* costOf(box[sketch.family], "familycost")
						const [n, twice, four] = yield* Effect.all([
							at(sketch.n, 1),
							at(2 * sketch.n, 2),
							at(4 * sketch.n, 3)
						])
						c.note(sketch.family)
						assert.ok(
							four.rows - twice.rows <= 2 * (twice.rows - n.rows),
							`${sketch.family}: its write reads rows faster than linearly: ${Arr.join(
								Arr.map([n, twice, four], costText),
								"; "
							)}`
						)
					}),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "linear growth: a cost of a fixed part and a part per member grows by exactly twice as much from 2n to 4n as from n to 2n, and a cost above linear by more"
		},
		box: "each family of the box appended n, 2n and 4n members, each length to a group of its own, at n of 125 and of 250",
		kept: [],
		kills: []
	})
