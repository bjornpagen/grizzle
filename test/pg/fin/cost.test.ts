/**
 * The work of rewriting a family or a tree on PostgreSQL 19 grows linearly with its size: the cost law of every
 * foreign key's reverse probe (laws/model/plan.ts Reversed).
 *
 * Deleting a referenced row runs its foreign keys' RI probes, one per row (ri_triggers.c, RI_FKey_noaction_del), each
 * over the referencing columns. Where an index leads with the referencing columns that pair with the target's key, a
 * probe reads the rows that reference that one row; where only a shorter prefix leads one, as a family's key (g, at)
 * does for its predecessor axis (g, ‹p›) or a tree's primary key (doc, start) for its owner axis (doc, parent), each
 * probe reads the whole family or tree, so deleting n members reads n² rows.
 *
 * Each case draws a size n and a tree's fan-out, and measures, at n, 2n and 4n members, three operations through the
 * SQL grizzle's lowering sends, each in one SERIALIZABLE transaction rolled back after its deferred checks fire (SET
 * CONSTRAINTS ALL IMMEDIATE): a family's whole delete (its members, then its owner) and its suffix rewrite from the first
 * slot (delete every member, lower the count, insert the rest one slot down), for an ordered and a counted family; and a
 * tree's whole delete. Its work is the buffers it reads: over every table and index of the installation's schema, the
 * block requests its scans and probes made, hit or read, PostgreSQL's per-transaction counter
 * (pg_stat_get_xact_blocks_fetched), which no timing or cache state moves. Tuples returned would not do: a sequential
 * scan counts only the tuples visible to it, and a probe after a delete reads dead ones.
 * Each size's tables are analyzed once loaded, as a stored family's are, so the RI probes are planned over their
 * statistics rather than over a freshly truncated relation's defaults.
 *
 * The law: doubling the size at most multiplies the work by 2^(3/2), w(2k)² ≤ 8 w(k)² for k = n and 2n, a growth
 * exponent of at most 3/2. The exponent is a classification threshold, not a measured limit: halfway, in exponent,
 * between linear work, which doubles, and quadratic work, which quadruples once its square term dominates, so it
 * separates the two with room on both sides. A probe's B-tree descent grows by a level only past a page's fan-out of
 * entries, which keeps n·log n with its constant overheads near a doubling, and the buffers a size's plan spends beside
 * its members shrink the ratio rather than break it. Measured on a private cluster: the ordered family's whole delete
 * read 28,039, 56,069 and 112,127 buffers at 2,000, 4,000 and 8,000 members, ×2.00 at each doubling, and with no
 * reverse index for an axis and no successor key, each axis's probe scanning the member or the tree, 52,039, 164,069
 * and 560,127, ×3.15 and ×3.41, against 2^(3/2) ≈ 2.83; that ratio climbs toward 4 as n grows, which is why n is
 * drawn from 2,000 up.
 *
 * Oracle: PostgreSQL's own counters of the buffers each operation read, against the law. Features: none beyond the
 * operations, each measured in every case.
 */

import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	costFamilies,
	costGen,
	costTree,
	familyOf,
	linear,
	sizesOf,
	suffixRewrite,
	touched,
	wholeDelete
} from "#test/pg/fin/cost.fixtures.ts"
import { familySeatIn } from "#test/pg/fin/family.ts"
import { cleared, seatIn } from "#test/pg/fin/installed.ts"
import { nodeBatchParams, nodeBatchSql, RELATIONS } from "#test/pg/fin/tree.ts"
import { loadTree } from "#test/pg/substrate/tree.ts"
import { SHAPES } from "#test/support/families/theorem.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The cost of rewriting families and trees on PostgreSQL 19 a family's whole delete and suffix rewrite, and a tree's whole delete, read buffers linear in its size.
 *
 * Its pre-conversion budget: runs 2, no coverage cases, so the runner's 200 steered (test/pg/fin/cost.test.ts at d8eed1786).
 */
export const theCostOfRewritingFamiliesAndTreesOnPostgreSQL19AFamilysWholeDeleteAndSuffixRewriteAndATreesWholeDeleteReadBuffersLinearInItsSize =
	property.explore(costGen, {
		needs: {
			ordered: Substrate.seat(costFamilies.ordered),
			counted: Substrate.seat(costFamilies.counted),
			tree: Substrate.seat(costTree)
		},
		situations: [],
		check: (seats) => (c) =>
			Effect.gen(function* () {
				const sizes = sizesOf(c)
				const [n1, n2, n4] = sizes
				for (const shape of SHAPES) {
					const taken = yield* seats[shape]
					const f = yield* familySeatIn(shape, taken, `cost ${shape}`)
					/** A family of k members, its whole delete's work and its suffix rewrite's. */
					const at = (k: number) =>
						Effect.gen(function* () {
							yield* familyOf(f, k)
							const whole = yield* touched(f.seat, "Member", wholeDelete(f))
							const suffix = yield* touched(f.seat, "Member", suffixRewrite(f, k))
							return { whole, suffix }
						})
					const [m1, m2, m4] = yield* Effect.provideService(
						Effect.all([at(n1), at(n2), at(n4)]),
						Substrate,
						taken.substrate
					)
					linear([m1.whole, m2.whole, m4.whole], sizes, `the ${f.shape} family's whole delete`)
					linear([m1.suffix, m2.suffix, m4.suffix], sizes, `the ${f.shape} family's suffix rewrite`)
				}
				const tree = yield* seats.tree
				const trees = yield* seatIn(tree, RELATIONS, "cost tree")
				/** A tree of k rows, and its whole delete's work. */
				const treeAt = (k: number) =>
					Effect.gen(function* () {
						yield* cleared(trees, RELATIONS)
						yield* trees.session.begin
						yield* trees.session.query(nodeBatchSql(trees), nodeBatchParams(loadTree(k, c.fanout)))
						yield* trees.session.commit
						yield* trees.session.query(`ANALYZE ${trees.table("Node")}`, [])
						return yield* touched(trees, "Node", [
							`DELETE FROM ${trees.table("Node")} WHERE ${trees.column("Node", "doc")} = 0`
						])
					})
				const deleted = yield* Effect.provideService(
					Effect.all([treeAt(n1), treeAt(n2), treeAt(n4)]),
					Substrate,
					tree.substrate
				)
				linear(deleted, sizes, "the tree's whole delete")
			}),
		oracle: {
			kind: "postgresql",
			name: "PostgreSQL's per-transaction count of the buffers each operation read, w(2k)^2 <= 8 w(k)^2 at k = n, 2n"
		},
		budget: { runs: 2, steered: 200 },
		kept: [],
		kills: []
	})
