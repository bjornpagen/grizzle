/**
 * The cost of a tree's backfill grows linearly with the stored forest, on PostgreSQL 19: the keyed tree edullm's
 * identity migration drafts from the old-form tree (test/support/migrate/keyed-tree.ts), its backfill run over old
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
 * a root over n − 1 children, each its own document mapped onto its own root, every node's kind its start's residue
 * modulo four, so the turns fold selects members at every size. Each size's backfill runs in one transaction on a fresh
 * old-form install: its folder's statements in order up to the backfill's, each backfill UPDATE under EXPLAIN (ANALYZE,
 * BUFFERS, SETTINGS, FORMAT JSON), then rolled back. The oracle is the law itself, the definition of linear growth; the
 * cutover's tree property (test/pg/migrate/cutover.test.ts) judges the rows the same backfill draws.
 *
 * Plants (~/.cache/grizzle-release/TREECOST/plants): tree-closure-restored (the tree drawn over the closure of its
 * parents, under a WITH RECURSIVE, as before 2026-11-14) and tree-children-paired (each row's children counted over
 * every pair of its tree's rows).
 *
 * The file builds Substrate.isolatedLayer: the old-form tree installs under its own fixed schema name, old_tree.
 */
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import { explainStatementWith, parsePlan, rowsTouched } from "#bench/harness/explain.ts"
import { indices } from "#compiler/core/array.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { splitStatements } from "#compiler/plan/migration.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { apply, noFurther, openMigrator } from "#test/pg/migrate/support.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import {
	keyedTreeOf,
	type OldDocument,
	oldInsert,
	q,
	type TreeCase,
	treeDataStep,
	treePlaceholder,
	withDataStep
} from "#test/support/migrate/keyed-tree.ts"
import { asDrafted, compile, draftedAt, fromSnapshot, generate } from "#test/support/migrate/kit.ts"
import { oldFormTree } from "#test/support/migrate/old-form-tree.ts"
import { review } from "#test/support/migrate/review.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A shape of the box: a chain of n nodes, each the parent of the next, or a star, one root over n − 1 children. */
type Shape = "a chain" | "a star"

const shapes: ReadonlyArray<Shape> = ["a chain", "a star"]

/** The nodes of the smallest size, n: 2n and 4n follow. */
const smallest = 200

/** A document of `shape` with `size` nodes, each node's kind its start's residue modulo four (treeOfParents numbers a
 * node's parent before it, the root 0). */
const documentOf = (shape: Shape, size: number): OldDocument => {
	const below = indices(size - 1)
	return {
		parents: shape === "a chain" ? below : Arr.map(below, () => 0),
		kinds: Arr.map(indices(size), (i) => i % 4)
	}
}

/** What one size's backfill cost: the rows its UPDATEs touched, and the pages they read and the temp they wrote. */
interface Cost {
	readonly size: number
	readonly rows: number
	readonly pages: number
	readonly temp: number
}

const costText = (c: Cost): string =>
	`${c.rows} rows at ${c.size} nodes (${c.pages} pages read, ${c.temp} temp pages written)`

/** The statement texts of `steps`'s backfill UPDATEs, as a folder spells them. */
const backfillTexts = (g: ReturnType<typeof keyedDraft>): ReadonlySet<string> =>
	new Set(
		Arr.flatMap(g.plan.steps, (s) =>
			s.slot === "structure.backfill" &&
			s.draft.kind === "statement" &&
			s.draft.statement.kind === "update"
				? [normalized(printStatement(s.draft.statement))]
				: []
		)
	)

/** A statement's text without its surrounding blanks and its closing semicolon. */
const normalized = (statement: string): string => {
	const text = Str.trim(statement)
	return Str.endsWith(";")(text) ? Str.trim(Str.slice(0, -1)(text)) : text
}

/** The keyed tree drafted from the old-form tree, its old id and document dropped. */
const keyedDraft = () =>
	succeeded(
		generate({
			previous: fromSnapshot(oldFormTree().snapshot),
			installation: compile(keyedTreeOf(), asDrafted),
			name: "keyed",
			timestamp: draftedAt(1),
			workload: noWorkload,
			declared: {
				renames: [],
				drops: [
					{ kind: "field", relation: parsedName("Node"), field: parsedName("id") },
					{ kind: "field", relation: parsedName("Node"), field: parsedName("doc") }
				]
			}
		}),
		"the keyed tree drafts"
	)

/**
 * One size's cost: the old-form tree installed, its forest of one document of `shape` stored, then the keyed tree's
 * reviewed folder run in one transaction up to its backfill, each backfill UPDATE explained, and rolled back.
 */
const costAt = (shape: Shape, size: number) =>
	Effect.scoped(
		Effect.gen(function* () {
			const substrate = yield* Substrate
			const tree = oldFormTree()
			yield* Effect.addFinalizer(() =>
				Effect.orDie(
					substrate.admin.query(`DROP SCHEMA IF EXISTS ${q(tree.snapshot.schema)} CASCADE`, [])
				)
			)
			const m = yield* openMigrator(substrate, substrate.owner)
			yield* apply(m, { snapshot: tree.snapshot, folders: [tree.folder] }, noFurther)
			const c: TreeCase = { documents: [documentOf(shape, size)], roots: [0] }
			yield* transaction(substrate.admin, [oldInsert(tree, c)])
			const g = keyedDraft()
			const backfill = backfillTexts(g)
			const reviewed = review(withDataStep(g, treeDataStep(tree, c)), {
				losses: "written",
				value: treePlaceholder
			})
			const statements = Arr.flatMap(reviewed.files, (f) => splitStatements(f.text))
			const last = Arr.findLastIndex(statements, (s) => backfill.has(normalized(s)))
			const through = Option.getOrThrowWith(
				last,
				() => new Error("the keyed tree's folder holds its backfill's UPDATE")
			)
			const pinned = yield* substrate.admin.pin
			yield* pinned.query("BEGIN", [])
			const explained = yield* Effect.forEach(statements.slice(0, through + 1), (s) =>
				backfill.has(normalized(s))
					? Effect.map(
							pinned.queryValues(
								explainStatementWith(normalized(s), { serialize: { kind: "off" }, wal: false }),
								[]
							),
							(rows) => [succeeded(parsePlan(rows[0]?.[0]), "one EXPLAIN plan").plan]
						)
					: Effect.as(pinned.query(s, []), [])
			).pipe(Effect.ensuring(Effect.ignore(pinned.query("ROLLBACK", []))))
			const plans = Arr.flatten(explained)
			assert.equal(plans.length, backfill.size, "every backfill UPDATE is explained once")
			return {
				size,
				rows: Arr.reduce(plans, 0, (sum, p) => sum + rowsTouched(p)),
				pages: Arr.reduce(plans, 0, (sum, p) => sum + p.buffers.sharedHit + p.buffers.sharedRead),
				temp: Arr.reduce(plans, 0, (sum, p) => sum + p.buffers.tempWritten)
			} satisfies Cost
		})
	)

layer(Substrate.isolatedLayer)("the cost of a tree's backfill", (it) => {
	for (const shape of shapes) {
		it.effect(
			`over ${shape} of n, 2n and 4n nodes, the rows the keyed tree's backfill touches grow by no more from 2n to 4n than twice what they grow by from n to 2n`,
			() =>
				Effect.gen(function* () {
					const [n, twice, four] = yield* Effect.all(
						[costAt(shape, smallest), costAt(shape, 2 * smallest), costAt(shape, 4 * smallest)],
						{ concurrency: 1 }
					)
					const sizes = Arr.join(Arr.map([n, twice, four], costText), "; ")
					assert.ok(
						four.rows - twice.rows <= 2 * (twice.rows - n.rows),
						`the keyed tree's backfill over ${shape} touches rows faster than linearly: ${sizes}`
					)
				})
		)
	}
})
