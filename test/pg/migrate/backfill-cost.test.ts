/**
 * The cost of a tree's backfill grows linearly with the stored forest, on PostgreSQL 19: the keyed tree drafted from a
 * tree rooted at its document, its root replaced (test/support/migrate/keyed-tree.ts), its backfill run over stored
 * forests of one shape at three sizes, n, 2n and 4n nodes a tree.
 *
 * Property, for each shape: the rows the backfill's UPDATEs touch (bench/harness/explain.ts rowsTouched: every row each
 * plan node handled over all of its loops, a join's examined pairs among them) grow by no more from 2n to 4n than twice
 * what they grow by from n to 2n. A cost of a fixed part and a part per node grows by exactly twice as much over the
 * doubled step; a cost with any term above linear, the n²/2 pairs of a chain's closure, a step of a recursion that
 * rereads the tree once per level, a subquery run once per row or a join of every pair of a tree's nodes, grows by more,
 * at every size: no slack, no threshold, no clock. The pages each size read and the temp it wrote are reported beside
 * the rows, unjudged: a page holds a varying number of rows, so pages are no exact measure.
 *
 * The box, exhausted: the shapes that stress a tree's derivations from either side, a chain, n levels deep, and a star,
 * a root over n − 1 children, each its own document mapped onto its own root, one case a shape at all three sizes, so
 * the law reads one case's costs, every node's kind its start's residue
 * modulo four, so the turns fold selects members at every size. Each size's backfill runs in one transaction on a fresh
 * install of the stored tree: its folder's statements in order up to the backfill's, each backfill UPDATE under EXPLAIN (ANALYZE,
 * BUFFERS, SETTINGS, FORMAT JSON), then rolled back. The oracle of the cost is the law itself, the definition of linear
 * growth.
 *
 * And each size's backfill draws the reference's rows (keyed-tree.ts keyedRows, the direct pre-order numbering of the
 * stored forest), read in its transaction right after it, over rows every one of which the data step moved before it: the
 * data step updates every row of the table in the same transaction, which gives each a new version at a new tid, and
 * the suite reads each row's tid before the data step and again before the backfill and requires them to differ. The
 * backfill meets its rows at their tids (deploy/diff/backfill.ts rowColumn), so a tid carried from before a row moved
 * would meet no row, and the row would keep its placeholder.
 *
 * Each case runs in a database of its own (Substrate.fresh): the stored tree installs under its own fixed schema name,
 * forest, one size after another.
 */
import { nonEmpty } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	type Cost,
	costAt,
	linear,
	type Scale,
	scales,
	shapeGen,
	shapes,
	type Situation,
	situationOf,
	smallest
} from "#test/pg/migrate/backfill-cost.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** The cost of a tree's backfill over a chain and a star of n, 2n and 4n nodes, every row moved before it, the keyed tree's backfill draws the reference's rows, and the rows it touches grow by no more from 2n to 4n than twice what they grow by from n to 2n. */
export const backfillCost = property.exhaust(finite(shapeGen), {
	needs: { substrate: Substrate.fresh(baseSubstrate) },
	situations: nonEmpty(
		Arr.flatMap(shapes, (shape) => Arr.map(scales, (scale) => situationOf({ shape, scale }))),
		"the box's situations"
	) satisfies ReadonlyArray<Reached<Situation>>,
	check:
		({ substrate }, k: Case<Situation>) =>
		(shape) =>
			Effect.provideServiceEffect(
				Effect.gen(function* () {
					const costs = new Map<Scale, Cost>()
					for (const scale of scales) {
						k.note(situationOf({ shape, scale }))
						const cost = yield* costAt(shape, scale * smallest)
						costs.set(scale, cost)
					}
					linear(shape, costs)
				}),
				Substrate,
				Effect.map(substrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "specification",
		name: "linear growth, judged over one shape's three sizes: its rows touched growing by no more from 2n to 4n than twice what they grow by from n to 2n; and each size's rows the keyed tree's reference (keyedRows) over rows the data step moved"
	},
	box: `each shape, a chain and a star, its forest at n, 2n and 4n nodes (n = ${smallest}) in one case, one document mapped onto its own root`,
	kept: [
		{
			token: ReplayToken("test/pg/migrate/backfill-cost.test.ts#backfillCost:-:0"),
			since: "2026-11-27",
			reason:
				"the chain at 200, 400 and 800 nodes (VEHICLES' run over 587fd269): the reviewer's data step at the draft's slot run under no advice and the backfill after it with its record's advice dropped, the bound backfill planned by PostgreSQL's costs touched 32787, 65585 and 131185 rows, past linear by 4; under the advice the runner sets again after the reviewer's statement it is linear"
		}
	],
	kills: [
		{
			file: "packages/grizzle/src/adapter/migrate/apply.ts",
			original: '\t\tconst wanted = stated.reviewed[index] === true ? "" : stated.advice\n',
			replacement: '\t\tconst wanted = stated.reviewed[index] === true ? "" : inForce\n',
			why: "The runner sets the file's advice off before the reviewer's data step and never again: the backfill after it runs under no advice, its bound statement planned by PostgreSQL's costs, and its rows grow past linear."
		},
		{
			file: "packages/engine/src/deploy/diff/backfill.ts",
			original:
				'\t/** One arm of `w`\'s rows: each row of the table, met at `meets`, as itself (`__self`) or as a child (`__child`). */\n\tconst arm = (\n\t\tmeets: NonEmptyReadonlyArray<string>,\n\t\tchild: bigint,\n\t\twhere: Expr | undefined\n\t): SetCore =>\n\t\tprovedCore(\n\t\t\t"keyed",\n\t\t\t[\n\t\t\t\t...carried.map((c) => targetAs(col("t", c), c)),\n\t\t\t\ttargetAs(isRoot, rootName),\n\t\t\t\t...meets.map((c, k) => targetAs(col("t", c), at(k))),\n\t\t\t\ttargetAs(int(child), "__child"),\n\t\t\t\ttargetAs(lit.bool(child === 0n), "__self")\n\t\t\t],\n\t\t\t[{ kind: "table", table, alias: "t" }],\n\t\t\twhere\n\t\t)\n\tconst roles = derived(\n\t\tselect(unionAll("disjoint", [arm(owner, 0n, undefined), arm(parent, 1n, not(isRoot))])),',
			replacement: `\tconst rooted = family.group.filter((g) => g.member.column === g.owner.column)\n\tconst other = derived(\n\t\tselect(\n\t\t\tprovedCore(\n\t\t\t\t"keyed",\n\t\t\t\t[\n\t\t\t\t\t...rooted.map((g, k) => targetAs(col("c", g.owner.column), \`__r_\${k}\`)),\n\t\t\t\t\t...owner.map((c, k) => targetAs(col("c", c), \`__o_\${k}\`)),\n\t\t\t\t\t...parent.map((c, k) => targetAs(col("c", c), \`__p_\${k}\`)),\n\t\t\t\t\ttargetAs(\n\t\t\t\t\t\tand(\n\t\t\t\t\t\t\tmapNonEmpty(family.group, (g) =>\n\t\t\t\t\t\t\t\ttypedEq(\n\t\t\t\t\t\t\t\t\tg.owner.type,\n\t\t\t\t\t\t\t\t\tcol("c", g.member.column),\n\t\t\t\t\t\t\t\t\tcol("c", g.owner.column),\n\t\t\t\t\t\t\t\t\tinstallation.names\n\t\t\t\t\t\t\t\t)\n\t\t\t\t\t\t\t)\n\t\t\t\t\t\t),\n\t\t\t\t\t\t"__proot"\n\t\t\t\t\t)\n\t\t\t\t],\n\t\t\t\t[{ kind: "table", table, alias: "c" }],\n\t\t\t\tundefined\n\t\t\t)\n\t\t),\n\t\t"p",\n\t\tfalse\n\t)\n\tconst sameTree = rooted.map((g, k) => eq(col("t", g.owner.column), col("p", \`__r_\${k}\`)))\n\tconst roles = derived(\n\t\tselect(\n\t\t\tprovedCore(\n\t\t\t\t"keyed",\n\t\t\t\t[\n\t\t\t\t\t...carried.map((c) => targetAs(col("t", c), c)),\n\t\t\t\t\ttargetAs(isRoot, rootName),\n\t\t\t\t\t...owner.map((c, k) => targetAs(col("t", c), at(k))),\n\t\t\t\t\ttargetAs(\n\t\t\t\t\t\t{\n\t\t\t\t\t\t\tkind: "case",\n\t\t\t\t\t\t\toperand: undefined,\n\t\t\t\t\t\t\twhens: [\n\t\t\t\t\t\t\t\t{\n\t\t\t\t\t\t\t\t\twhen: and([\n\t\t\t\t\t\t\t\t\t\tnot(col("p", "__proot")),\n\t\t\t\t\t\t\t\t\t\t...owner.map((c, k) => eq(col("p", \`__p_\${k}\`), col("t", c)))\n\t\t\t\t\t\t\t\t\t]),\n\t\t\t\t\t\t\t\t\tresult: int(1n)\n\t\t\t\t\t\t\t\t}\n\t\t\t\t\t\t\t],\n\t\t\t\t\t\t\telse: int(0n)\n\t\t\t\t\t\t},\n\t\t\t\t\t\t"__child"\n\t\t\t\t\t),\n\t\t\t\t\ttargetAs(\n\t\t\t\t\t\tand(mapNonEmpty(owner, (c, k) => eq(col("p", \`__o_\${k}\`), col("t", c)))),\n\t\t\t\t\t\t"__self"\n\t\t\t\t\t)\n\t\t\t\t],\n\t\t\t\t[\n\t\t\t\t\t{\n\t\t\t\t\t\tkind: "joins",\n\t\t\t\t\t\tfirst: { kind: "table", table, alias: "t" },\n\t\t\t\t\t\tsteps: [{ kind: "on", source: other, on: and([lit.bool(true), ...sameTree]) }]\n\t\t\t\t\t}\n\t\t\t\t],\n\t\t\t\tundefined\n\t\t\t)\n\t\t),`,
			why: "Each row's children counted over every pair of its tree's rows; the law of linear growth fails."
		}
	]
})
