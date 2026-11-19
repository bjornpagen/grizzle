/**
 * The cost of a family write whose members copy their owners' columns grows linearly with the write, on PostgreSQL 19:
 * a ChangeSet inserting n owners and two members of each, every member copying two of its owner's columns along the
 * family's owner axis, the owners inserted in the same write, so the family additions statement reads each copy from
 * the owners' facts it holds (schedule.ts CopySource `held`), at three sizes, n, 2n and 4n owners.
 *
 * Property, for each situation: the rows the write's statements read and pair (rowsScannedAndPaired,
 * bench/harness/explain.ts: every scan's rows over all of its loops, and every pair a join examined past its keys, the
 * same whichever sort, hash or merge the planner chooses for a step) at most double with each doubling of the owners,
 * from n to 2n and from 2n to 4n. A cost of a fixed part and a part per owner, a·n + b, at most doubles, since its
 * fixed part does not double, whatever constant a plan switch between sizes adds below that part; a cost with any term
 * above linear more than doubles once that term outgrows the fixed part, which the sizes reach: no slack, no
 * threshold, no clock. The pages the statements read and the temp they wrote are reported
 * beside the rows, unjudged.
 *
 * Statistics play no part: every size is measured on a fresh installation that no ANALYZE has run on, which the case
 * checks (pg_stat_user_tables), and the statement reads its owners from the call's own facts, of which PostgreSQL holds
 * none. Each case also holds the write to the copy's contract and the emission discipline: the write applied stores
 * every member with its owner's columns as its copies (a specification oracle of the copy, which the window's
 * first_value over the held owners must meet), and every statement passes the structural audit
 * (test/support/write-audit.ts), which refuses NULL and outer joins.
 *
 * The box, exhausted: the members inserted, so their groups start empty and the insert is arbitrated, or put, so each
 * group's stored state and its stored owner are probed beside the owners' facts; each at a smallest size n of 125 and of
 * 250 owners. The owner relation is immutable, so the write recounts no stored owner. Each size's write is applied once,
 * on a fresh installation, its statements each under EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON) in its place,
 * its transaction ended by ROLLBACK (bench/write/support/writes.ts
 * explainedChange). The oracle is the law itself, the definition of linear growth; the family suites
 * (test/pg/write/swarm/families.test.ts, test/pg/write/fill-order) judge the rows the same statements write.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	costOf,
	costText,
	membersPerOwner,
	type Situation,
	situations,
	sketchGen
} from "#test/pg/write/owner-copy-cost/owner-copy-cost.fixtures.ts"
import { assert } from "#test/support/assert.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The cost of a family write whose members copy their owners' columns the rows it reads at most double with each doubling of its owners.
 */
export const theCostOfAFamilyWriteWhoseMembersCopyTheirOwnersColumnsTheRowsItReadsAtMostDoubleWithEachDoublingOfItsOwners =
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
								at.copied,
								membersPerOwner * at.cost.owners,
								`${sketch.situation}: at ${at.cost.owners} owners, a member's copies are not its owner's columns`
							)
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
		box: "each situation of the box written at n, 2n and 4n owners of two members each, each size on a fresh installation, at n of 125 and of 250",
		kept: [],
		kills: []
	})
