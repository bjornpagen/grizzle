/**
 * The cost of replacing a stored unit grows linearly with the unit, on PostgreSQL 19: a ChangeSet deleting a stored
 * unit whole and inserting it again in one stratum (write/delete/unit.ts), edullm's re-publish of a package, at units of
 * n, 2n and 4n rows. The unit is a Doc owning a tree of nodes as its counted family's members (qti-pie's and edullm's
 * shape, a test's tree of instances), an ordered family of lines, and a counted family of tags, each family one group
 * of the unit's size. The tree is a complete tree of four children a node, numbered in breadth-first order, so each node
 * has a path from its root and siblings before it; or a root with every other node its child, so every node has every
 * other as a sibling. The unit is replaced by the same value, every row kept and none written, or with its first child,
 * its first line or its first tag changed, which breaks the kept rows of a tree behind that node, of a sequence behind
 * that line, and of a counted group with that tag.
 *
 * Property, for each situation and tree: the rows the write's statements read and pair (rowsScannedAndPaired,
 * bench/harness/explain.ts: every scan's rows over all of its loops, and every pair a join examined past its keys, the
 * same whichever sort, hash or merge the planner chooses for a step) at most double with each doubling of the unit,
 * from n to 2n and from 2n to 4n, and so do the unit delete's alone, the write's one statement that deletes. A cost of a
 * fixed part and a part per row, a·n + b, at most doubles, since its fixed part does not double, whatever constant a plan
 * switch between sizes adds below that part; a cost with any term above linear more than doubles once that term
 * outgrows the fixed part, which the sizes reach: no slack, no threshold, no clock. A kept-row judgement that reads a
 * row's group, its earlier siblings or its path once per row grows by more, and so does a family additions statement
 * that finds each node it inserts again among its siblings by reading them: the tree's sibling key is a UNIQUE over
 * the node's law column of its parent, which a probe reaches by binding that column (laws/model/uniques.ts
 * GuardedReach), and a probe that binds a stored row's other columns beside its key lets PostgreSQL, holding no
 * statistics, read the row through the parent's index instead (write/probe.ts Equal). The guarded reach is no case
 * of this law: a node re-inserted after its siblings were removed meets them only as dead index entries, which the
 * rows read do not count. The pages the statements read and
 * the temp they wrote are reported beside the rows, unjudged. Every size is measured on a fresh installation that no
 * ANALYZE has run on when the write begins: autovacuum is off on each of its tables before the unit a case stores first
 * is committed, so no analyze races the write however long the case waits, and the case checks that the installation
 * and the store ran none of their own (pg_stat_user_tables). Every statement of the write passes the structural audit
 * (test/support/write-audit.ts), which refuses NULL and outer joins.
 *
 * The box, exhausted: each situation in each tree at a smallest size n of 100 and of 200 rows, the unit stored beside a
 * second unit of 3,200 rows a family that the write leaves alone (`beside`). Each size's write is applied once, its
 * statements each under EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON) in its place, its transaction ended by
 * ROLLBACK (bench/write/support/writes.ts explainedChange). The oracle is the law itself; test/pg/write/whole judges the
 * rows the same statements write and keep against a model of the units.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	costOf,
	costText,
	type Feature,
	features,
	sketchGen
} from "#test/pg/write/replace-cost/replace-cost.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The cost of replacing a stored unit the rows it reads at most double with each doubling of the unit.
 */
export const theCostOfReplacingAStoredUnitTheRowsItReadsAtMostDoubleWithEachDoublingOfTheUnit =
	property.exhaust(finite(sketchGen), {
		needs: { substrate: Substrate.installing },
		situations: features satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ substrate }, c: Case<Feature>) =>
			(sketch) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const [n, twice, four] = yield* Effect.all([
							costOf(sketch.situation, sketch.tree, sketch.n),
							costOf(sketch.situation, sketch.tree, 2 * sketch.n),
							costOf(sketch.situation, sketch.tree, 4 * sketch.n)
						])
						c.note(`${sketch.situation} in ${sketch.tree}`)
						for (const at of [n, twice, four]) {
							assert.equal(
								at.analyzed,
								0,
								`${sketch.situation}: the installation measured at ${at.cost.rows} rows a family was analyzed`
							)
						}
						const sizes = Arr.join(Arr.map([n.cost, twice.cost, four.cost], costText), "; ")
						assert.ok(
							twice.cost.read <= 2 * n.cost.read && four.cost.read <= 2 * twice.cost.read,
							`${sketch.situation} in ${sketch.tree}: its unit delete reads rows faster than linearly: ${sizes}`
						)
						assert.ok(
							twice.cost.written <= 2 * n.cost.written &&
								four.cost.written <= 2 * twice.cost.written,
							`${sketch.situation} in ${sketch.tree}: its replace reads rows faster than linearly: ${sizes}`
						)
					}),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "linear growth: a cost of a fixed part and a part per row at most doubles when its rows double, the fixed part not doubling, and a cost above linear more than doubles"
		},
		box: "each situation of the box at units of n, 2n and 4n nodes, lines and tags, each size on a fresh installation, at n of 100 and of 200",
		kept: [],
		kills: []
	})
