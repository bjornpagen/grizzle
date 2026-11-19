/**
 * The cost of a family write's pair checks grows linearly with its rows, on PostgreSQL 19: a ChangeSet inserting n
 * owners and two members of each into an empty installation, the members a counted family's under a key of three
 * columns and one more unique object beside it, so the family additions statement probes its candidate members for two
 * of them that object cannot both hold (write/insert/unique.ts buildProbe, its pair branch), at n, 2n and 4n owners.
 * Every member is lawful, so no pair is found: each check reads every candidate it holds. The object is a key beside the
 * primary key, a key over a selection of the members (edullm's Attribute keys over a kind and a name are such), or a
 * no-overlap key over a span; the first two pair by equal fields, the third by overlapping spans. A key of several
 * columns is what PostgreSQL estimates the candidates' CTE at a row by, with no statistics of it, and a pair read as a
 * nested loop of two scans of it pairs every candidate with every other.
 *
 * Property, for each situation: the rows the write's statements read and pair (rowsScannedAndPaired,
 * bench/harness/explain.ts: every scan's rows over all of its loops, and every pair a join examined past its keys, the
 * same whichever sort, hash or merge the planner chooses for a step) at most double with each doubling of the owners,
 * from n to 2n and from 2n to 4n. A cost of a fixed part and a part per owner, a·n + b, at most doubles, since its
 * fixed part does not double, whatever constant a plan switch between sizes adds below that part; a cost with any term
 * above linear more than doubles once that term outgrows the fixed part, which the sizes reach: no slack, no
 * threshold, no clock. The pages the statements read and the temp they wrote are reported beside the rows, unjudged.
 * Every size is measured on a fresh installation that no ANALYZE has run on, which the case checks
 * (pg_stat_user_tables), and every statement of the write passes the structural audit (test/support/write-audit.ts),
 * which refuses NULL and outer joins.
 *
 * The box, exhausted: each unique object, at the smallest size n of 125 and of 250 owners. Each size's write is applied
 * once, its statements each under EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON) in its place, its transaction ended
 * by ROLLBACK (bench/write/support/writes.ts explainedChange). The oracle is the law itself; the family, key and span
 * suites (test/pg/write/swarm/families.test.ts, test/pg/write/unique-witness, test/pg/write/span-key,
 * test/pg/write/oracle) judge the refusals the same probe raises.
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
	sketchGen,
	smallest
} from "#test/pg/write/pair-cost/pair-cost.fixtures.ts"
import { assert } from "#test/support/assert.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The cost of a family write's pair checks the rows it reads at most double with each doubling of its owners.
 */
export const theCostOfAFamilyWritesPairChecksTheRowsItReadsAtMostDoubleWithEachDoublingOfItsOwners =
	property.exhaust(finite(sketchGen), {
		needs: { substrate: Substrate.installing },
		situations: situations satisfies ReadonlyArray<Reached<Situation>>,
		check:
			({ substrate }, c: Case<Situation>) =>
			(sketch) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const least = smallest[sketch.size]
						const [n, twice, four] = yield* Effect.all([
							costOf(sketch.object, least),
							costOf(sketch.object, 2 * least),
							costOf(sketch.object, 4 * least)
						])
						c.note(`${sketch.object}, ${sketch.size}`)
						for (const at of [n, twice, four]) {
							assert.equal(
								at.analyzed,
								0,
								`the installation measured at ${at.cost.owners} owners was analyzed`
							)
						}
						assert.ok(
							twice.cost.rows <= 2 * n.cost.rows && four.cost.rows <= 2 * twice.cost.rows,
							`its write under ${sketch.object} reads rows faster than linearly: ${Arr.join(
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
		box: "n, 2n and 4n owners of two lawful members each, all new, each size on a fresh installation, under a key beside the primary key, a key over a selection or a no-overlap key, at n of 125 and of 250",
		kept: [],
		kills: []
	})
