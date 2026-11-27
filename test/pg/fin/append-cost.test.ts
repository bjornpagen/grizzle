/**
 * An append to a stored family costs O(log n) pages, on PostgreSQL 19: one member appended to a family of n members
 * writes its owner's row and its member's row, each a B-tree descent of the family's indexes, and the RI checks of the
 * family's axes, each a probe, so its pages grow as the descents do, logarithmically in n, never with the members
 * stored before it. The family is a sequence, its members nested under their owner restated exactly (metis's
 * `ordered(TestIssued, fin(TestSeries, issued))`, whose every issue is an append), or a counted family, whose member
 * is a row of its own naming its owner.
 *
 * Property, for each kind: at sizes 10, 100, 1,000 and 10,000, each on a fresh installation, the pages the append's
 * statements and its family's foreign key checks read of the owner's and the member's tables and their indexes
 * (append-cost.fixtures.ts costOf: what the backend counts in the write's own transaction, its deferred checks fired
 * before its COMMIT) are at most c · log₁₀ n, c the pages at n = 10: a cost of a + b · d(n), d a B-tree's depth, which
 * grows by a level for each power of its fan-out, stays under it at every tenfold, since its constant part does not
 * grow, while a cost with a term in n passes it once that term outgrows the constant: no slack, no threshold, no
 * clock. The rows its statements read of those tables whole, the tuples a sequential scan returns there
 * (pg_stat_get_xact_tuples_returned, beside the tuples index scans fetch), are the same at every size: no statement of
 * an append, a sequence's put among them, reads the family's table whole, its stored rows reached at their keys, a
 * law column's (the counted slot ‹i›) and an `= ANY` of the keys the write holds among them. And the append updates
 * at most one stored member's row, the one whose slot it follows; and a member a direct writer then inserts past the
 * family's last slot, naming its own slot its successor, is refused by the family's foreign keys (23503): the member
 * at the last slot names its own slot its successor, so the one past it has no predecessor it follows.
 *
 * Its red, at 26b4ab22f: every member held its owner's count, ‹n›, and the owner axis's ON UPDATE CASCADE rewrote
 * every stored member at each append, 164, 1,557, 18,351 and 181,342 pages for a sequence's append at 10 to 10,000
 * members and 130, 1,602, 19,254 and 191,274 for a counted family's, n members updated each time. Each member now holds
 * its successor (ir/family.ts Family `next`), and an append updates the one member before its slots: 105, 111, 135 and
 * 134 pages, and 60, 62, 79 and 79, under 26b4ab22f's binding. The binder (40b6352e) read them again past the bound:
 * its catalog held no law column, so the seam's probe bound the group alone, ‹i› a filter, 64, 66, 125 and 501 pages
 * at 2dc71d9e; and it read every `= ANY` of a held array whole, a sublink, a sequence's put reading its stored row by a
 * Seq Scan of Line, 11, 101, 1,001 and 10,001 rows. Bound by their columns and their arrays, the sequence's append reads
 * 110, 116, 141 and 141 pages and the counted family's 64, 66, 84 and 84, no row of a table whole.
 *
 * The oracle is the law itself; test/pg/fin's other properties and the world model judge the rows the same writes
 * leave.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	type Cost,
	costOf,
	costText,
	type Feature,
	kinds,
	sizes,
	sketchGen
} from "#test/pg/fin/append-cost.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** An append of one member to a stored family of n reads at most c · log₁₀ n pages, no table whole, and updates one stored member at most. */
export const anAppendToAStoredFamilyOfNReadsAtMostCTimesLogNPagesAndUpdatesOneStoredMemberAtMost =
	property.exhaust(finite(sketchGen), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: Arr.map(kinds, (k): Feature => `an append to ${k}`) satisfies ReadonlyArray<
			Reached<Feature>
		>,
		check:
			({ substrate }, c: Case<Feature>) =>
			(sketch) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const costs: ReadonlyArray<Cost> = yield* Effect.forEach(sizes, (n) =>
							costOf(sketch.kind, n)
						)
						c.note(`an append to ${sketch.kind}`)
						const text = Arr.join(Arr.map(costs, costText), "; ")
						const [base] = costs
						assert.ok(base !== undefined, "a cost at the smallest size")
						for (const cost of costs) {
							assert.ok(
								cost.pages <= (base.pages * Math.log10(cost.n)) / Math.log10(base.n),
								`${sketch.kind}: an append at ${cost.n} members reads more than c · log n pages: ${text}`
							)
							assert.equal(
								cost.rows,
								base.rows,
								`${sketch.kind}: an append at ${cost.n} members reads a table whole: ${text}`
							)
							assert.ok(
								cost.membersUpdated <= 1,
								`${sketch.kind}: the append updates its stored members: ${text}`
							)
							assert.equal(
								cost.dangling,
								"23503",
								`${sketch.kind}: a member past the last slot is refused by the family's foreign keys: ${text}`
							)
						}
					}),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "logarithmic growth: a cost of a constant part and a part per B-tree level stays under c · log n, c its cost at the smallest size, and a cost with a term in n passes it; a statement reading no table whole reads as many of its rows at every size"
		},
		box: "each kind of family at 10, 100, 1,000 and 10,000 stored members, each size on a fresh installation",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/access/catalog.ts",
				original:
					'\t\t\t),\n\t\t\t...(lawColumns.get(r.name) ?? []).map(\n\t\t\t\t(c) =>\n\t\t\t\t\t[\n\t\t\t\t\t\tc.column,\n\t\t\t\t\t\tcolumnOf(c.field, { kind: "law", column: c.column }, names.vectorSchema)\n\t\t\t\t\t] as const\n\t\t\t)\n\t\t])',
				replacement: "\t\t\t)\n\t\t])",
				why: "The binding's catalog holds a relation's fields alone, as the binder's did at 40b6352e: an equality on a law column binds nothing, so a counted family's seam probes its group by g alone, its slot ‹i› a filter, and reads every member of the group at each append; the property fails at the larger sizes."
			},
			{
				file: "packages/engine/src/sql/bind.ts",
				original: '\t\t\t(c.array.kind === "array" || !opaque(c.array)) &&\n',
				replacement: "\t\t\t!opaque(c.array) &&\n",
				why: "An `= ANY` of an array sublink is opaque again, no binding: a put's read of its stored rows among the keys the write holds (write/probe.ts amongHeld) is a whole read, a Seq Scan of Line returning its every row; the sequence's rows fail at every size past the first."
			},
			{
				file: "packages/engine/src/sql/bind.ts",
				original:
					"\t\tfor (const [place, logical] of innerHoisted(entriesOf(c.from), where).entries()) {\n",
				replacement: "\t\tfor (const [place, logical] of entriesOf(c.from).entries()) {\n",
				why: "An inner join's ON keeps the conjuncts that read none of its own step: the `= ANY` restricting the stored table its chain reads first stands in the next step's ON, which that table's read never sees, so it is read whole; the sequence's rows fail at every size past the first."
			},
			{
				file: "packages/engine/src/write/family/written.ts",
				original:
					'\t\t\t\t),\n\t\t\t\ttypedEq(\n\t\t\t\t\tindexType,\n\t\t\t\t\tat(m),\n\t\t\t\t\twritten(w, binary("-", seamAt(g), lit.int(1, bigint)), indexType),\n\t\t\t\t\tw.names\n\t\t\t\t)\n\t\t\t]\n',
				replacement: "\t\t\t\t)\n\t\t\t]\n",
				why: "The seam reaches every member of its group, not the one member before the slots the statement draws, as the owner axis's cascade of the count once rewrote every member: each stored member is read and judged at each append, so an append to a family of 10,000 reads its every member's pages and passes c · log n; the property fails at the larger sizes."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original:
					"\t\tconst successors = appendNonEmpty(familyKeyColumns, next)\n\t\tconst predecessorBase = appendNonEmpty(successorKey, index)\n\t\tconst lastSlots = appendNonEmpty(lastBase, lastPred)\n",
				replacement:
					"\t\tconst successors = familyKeyColumns\n\t\tconst predecessorBase = successorKey\n\t\tconst lastSlots = lastBase\n",
				why: "The predecessor and last axes pair no successor, so nothing holds the last member to be followed by none: a direct writer's member past the last slot, at n + 1 behind the member at n, commits, where the family's foreign keys must refuse it; the property fails at every size."
			}
		]
	})
