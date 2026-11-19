/**
 * The cost of an arbitrated insert grows linearly with its rows, on PostgreSQL 19: a ChangeSet inserting n owners and two
 * members of each into an empty installation, the members a counted family's under a key of three columns, so the
 * family additions statement inserts them by ON CONFLICT DO NOTHING and reads its met rows, the proposed rows its INSERT
 * did not return (sql/ast.ts FromSource `metRows`), as do the owners' own insert, at n, 2n and 4n owners. Every row is
 * new, so the INSERT returns every row it proposes and the met rows are none: the set difference of two CTEs of one
 * size. A key of several columns is what PostgreSQL estimates two such CTEs at a row each by, with no statistics of
 * them, and a nested loop of the two pairs every proposed row with every returned one.
 *
 * Property, for each situation: the rows the write's statements read and pair (rowsScannedAndPaired,
 * bench/harness/explain.ts: every scan's rows over all of its loops, and every pair a join examined past its keys, the
 * same whichever sort, hash or merge the planner chooses for a step) at most double with each doubling of the owners,
 * from n to 2n and from 2n to 4n. A cost of a fixed part and a part per owner, a·n + b, at most doubles, since its
 * fixed part does not double, whatever constant a plan switch between sizes adds below that part; a cost with any term
 * above linear more than doubles once that term outgrows the fixed part, which the sizes reach: no slack, no
 * threshold, no clock. The pages the statements read and the temp they wrote are
 * reported beside the rows, unjudged. Every size is measured on a fresh installation that no ANALYZE has run on, which
 * the case checks (pg_stat_user_tables), and every statement of the write passes the structural audit
 * (test/support/write-audit.ts), which refuses NULL and outer joins.
 *
 * The box, exhausted: the smallest size n, of 125 and of 250 owners. Each size's write is applied once, its statements
 * each under EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON) in its place, its transaction ended by ROLLBACK
 * (bench/write/support/writes.ts explainedChange). The oracle is the law itself; the insert and family suites
 * (test/pg/write/met, test/pg/write/oracle, test/pg/write/fill-order, test/pg/write/swarm/families.test.ts) judge the
 * rows the same statements write and the met rows they classify.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	costOf,
	costText,
	type Situation,
	situations,
	sketchGen,
	smallest
} from "#test/pg/write/met-rows-cost/met-rows-cost.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The cost of an arbitrated insert the rows it reads at most double with each doubling of its owners.
 */
export const theCostOfAnArbitratedInsertTheRowsItReadsAtMostDoubleWithEachDoublingOfItsOwners =
	property.exhaust(finite(sketchGen), {
		needs: { substrate: Substrate.installing },
		situations: situations satisfies ReadonlyArray<Reached<Situation>>,
		check:
			({ substrate }, c: Case<Situation>) =>
			(sketch) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const [n, twice, four] = yield* Effect.all([
							costOf(smallest[sketch.situation]),
							costOf(2 * smallest[sketch.situation]),
							costOf(4 * smallest[sketch.situation])
						])
						c.note(sketch.situation)
						for (const at of [n, twice, four]) {
							assert.equal(
								at.analyzed,
								0,
								`the installation measured at ${at.cost.owners} owners was analyzed`
							)
						}
						assert.ok(
							twice.cost.rows <= 2 * n.cost.rows && four.cost.rows <= 2 * twice.cost.rows,
							`its write reads rows faster than linearly: ${Arr.join(
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
		box: "n, 2n and 4n owners of two members each, all new, each size on a fresh installation, at n of 125 and of 250",
		kept: [],
		kills: []
	})
