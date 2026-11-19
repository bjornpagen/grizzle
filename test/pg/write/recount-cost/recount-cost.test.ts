/**
 * The cost of recounting a mutable owner's family grows linearly with the owners a write recounts, on PostgreSQL 19: a
 * ChangeSet appending two members to each of n owners of a mutable owner relation, whose counted family's count and a
 * sum fold's end each owner holds, so the family additions statement recounts every owner it appends to
 * (write/family/additions.ts recountOf), at n, 2n and 4n owners. The fold's scan reads each member's before, the after
 * before it, by lag() (write/family/scan.ts), which the structural audit holds to its default (R27).
 *
 * Property, for each situation: the rows the write's statements read and pair (rowsScannedAndPaired,
 * bench/harness/explain.ts: every scan's rows over all of its loops, and every pair a join examined past its keys, the
 * same whichever sort, hash or merge the planner chooses for a step) at most double with each doubling of the owners,
 * from n to 2n and from 2n to 4n. A cost of a fixed part and a part per owner, a·n + b, at most doubles, since its
 * fixed part does not double, whatever constant a plan switch between sizes adds below that part; a cost with any term
 * above linear more than doubles once that term outgrows the fixed part, which the sizes reach: no slack, no
 * threshold, no clock. A recount that reads its recount source once per owner row,
 * or once per owner row and recounted column, grows by more. The pages the statements read and the temp they wrote are
 * reported beside the rows, unjudged. Every size is measured on a fresh installation that no ANALYZE has run on when
 * the write begins, which the case checks (pg_stat_user_tables): the owners a case stores first are committed, which
 * autovacuum may analyze later, after the write it measures. Every statement of the write passes the structural audit
 * (test/support/write-audit.ts), which refuses NULL and outer joins.
 *
 * The box, exhausted: the owners inserted in the same write as their members, or stored before it, the write appending
 * to them; to one of their families or to two, a family's recount then joined to the other's at their keys; each at a
 * smallest size n of 125 and of 250 owners. Each size's write is applied once, its statements each
 * under EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON) in its place, its transaction ended by ROLLBACK
 * (bench/write/support/writes.ts explainedChange). The oracle is the law itself; the family suites
 * (test/pg/write/swarm/families.test.ts, test/pg/write/fill-order, test/pg/write/family-cost) judge the rows the same
 * statements write.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	costOf,
	costText,
	type Situation,
	situations,
	sketchGen
} from "#test/pg/write/recount-cost/recount-cost.fixtures.ts"
import { assert } from "#test/support/assert.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The cost of recounting a mutable owner's family the rows it reads at most double with each doubling of its owners.
 */
export const theCostOfRecountingAMutableOwnersFamilyTheRowsItReadsAtMostDoubleWithEachDoublingOfItsOwners =
	property.exhaust(finite(sketchGen), {
		needs: { substrate: Substrate.installing },
		situations: situations satisfies ReadonlyArray<Reached<Situation>>,
		check:
			({ substrate }, c: Case<Situation>) =>
			(sketch) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const [n, twice, four] = yield* Effect.all([
							costOf(sketch.situation, sketch.n),
							costOf(sketch.situation, 2 * sketch.n),
							costOf(sketch.situation, 4 * sketch.n)
						])
						c.note(sketch.situation)
						for (const at of [n, twice, four]) {
							assert.equal(
								at.analyzed,
								0,
								`${sketch.situation}: the installation measured at ${at.cost.owners} owners was analyzed`
							)
						}
						assert.ok(
							twice.cost.rows <= 2 * n.cost.rows && four.cost.rows <= 2 * twice.cost.rows,
							`${sketch.situation}: its write reads rows faster than linearly: ${Arr.join(
								Arr.map([n.cost, twice.cost, four.cost], costText),
								"; "
							)}`
						)
					}),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "linear growth: a cost of a fixed part and a part per row at most doubles when its rows double, the fixed part not doubling, and a cost above linear more than doubles"
		},
		box: "each situation of the box at n, 2n and 4n owners of two appended items each and, with two families, one tag each, each size on a fresh installation, at n of 125 and of 250",
		kept: [],
		kills: []
	})
