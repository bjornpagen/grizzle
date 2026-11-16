import { exhaust } from "@bjornpagen/testing/explore"
import { requiredInSpace } from "@bjornpagen/testing/features"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { searched } from "@bjornpagen/testing/vitest"
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
 * BUFFERS, SETTINGS, FORMAT JSON), then rolled back. The oracle of the cost is the law itself, the definition of linear
 * growth.
 *
 * And each size's backfill draws the reference's rows (keyed-tree.ts keyedRows, the direct pre-order numbering of the
 * old forest), read in its transaction right after it, over rows every one of which the data step moved before it: the
 * data step updates every row of the table in the same transaction, which gives each a new version at a new tid, and
 * the suite reads each row's tid before the data step and again before the backfill and requires them to differ. The
 * backfill meets its rows at their tids (deploy/diff/backfill.ts rowColumn), so a tid carried from before a row moved
 * would meet no row, and the row would keep its placeholder.
 *
 * The file builds Substrate.isolatedLayer: the old-form tree installs under its own fixed schema name, old_tree.
 */
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, String as Str } from "effect"
import {
	explainStatementWith,
	type PlanNode,
	parsePlan,
	rowsTouched
} from "#bench/harness/explain.ts"
import { indices } from "#compiler/core/array.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { splitStatements } from "#compiler/plan/migration.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { apply, noFurther, openMigrator } from "#test/pg/migrate/support.ts"
import { assert, defined, nonEmpty, succeeded } from "#test/support/assert.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	column,
	keyedFields,
	keyedRows,
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

/** The shapes of the box: a chain of n nodes, each the parent of the next, or a star, one root over n − 1 children. */
const shapes = ["a chain", "a star"] as const

type Shape = (typeof shapes)[number]

/** The sizes of the box, each a multiple of the smallest, n: n, 2n and 4n nodes. */
const scales = [1, 2, 4] as const

type Scale = (typeof scales)[number]

/** A case of the box: a forest of one shape at one size. */
interface LawCase {
	readonly shape: Shape
	readonly scale: Scale
}

/** What a case reaches: its shape at its size. */
type Situation = `${Shape} at ${Scale}n`

const situationOf = (c: LawCase): Situation => `${c.shape} at ${c.scale}n`

const lawGen: Gen<LawCase> = (source) => ({
	shape: source.draw(element(shapes)),
	scale: source.draw(element(scales))
})

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

/** The column every row's tid is read by. */
const rowColumn = "ctid"

/** Rows of texts in one order, each compared whole. */
const byRow = Order.mapInput(Order.String, (row: ReadonlyArray<string>) => Arr.join(row, "\u0000"))

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
			const dataStep = new Set(Arr.map(treeDataStep(tree, c), normalized))
			const firstStep = Option.getOrThrowWith(
				Arr.findFirstIndex(statements, (s) => dataStep.has(normalized(s))),
				() => new Error("the reviewed folder holds the data step")
			)
			const table = `${q(tree.snapshot.schema)}.${q(tree.columns.table)}`
			const pinned = yield* substrate.admin.pin
			/** Each row's tid by its old id, as the transaction sees it. */
			const tids = Effect.map(
				pinned.queryValues(`SELECT ${column("id")}::text, ${rowColumn}::text FROM ${table}`, []),
				(rows) => new Map(Arr.map(rows, ([id, tid]) => [String(id), String(tid)] as const))
			)
			yield* pinned.query("BEGIN", [])
			const run = Effect.gen(function* () {
				const plans: Array<PlanNode> = []
				const loaded = new Map<string, string>()
				for (const [i, s] of statements.slice(0, through + 1).entries()) {
					if (i === firstStep) {
						for (const [id, tid] of yield* tids) {
							loaded.set(id, tid)
						}
					}
					if (backfill.has(normalized(s))) {
						const moved = yield* tids
						assert.ok(
							loaded.size > 0 && Arr.every([...loaded], ([id, tid]) => moved.get(id) !== tid),
							"the data step moves every row before the backfill, so no tid is where the rows were loaded"
						)
						const rows = yield* pinned.queryValues(
							explainStatementWith(normalized(s), { serialize: { kind: "off" }, wal: false }),
							[]
						)
						plans.push(succeeded(parsePlan(rows[0]?.[0]), "one EXPLAIN plan").plan)
					} else {
						yield* pinned.query(s, [])
					}
				}
				const drawn = yield* pinned.queryValues(
					`SELECT ${Arr.join(
						Arr.map(keyedFields, (f) => `${column(f)}::text`),
						", "
					)} FROM ${table}`,
					[]
				)
				const read: ReadonlyArray<ReadonlyArray<string>> = Arr.map(drawn, (row) =>
					Arr.map(row, String)
				)
				assert.deepEqual(
					Arr.sort(read, byRow),
					Arr.sort(keyedRows(c), byRow),
					`the backfill over ${shape} of ${size} nodes draws the reference's rows (${Arr.join(keyedFields, ", ")})`
				)
				return plans
			})
			const plans = yield* run.pipe(Effect.ensuring(Effect.ignore(pinned.query("ROLLBACK", []))))
			assert.equal(plans.length, backfill.size, "every backfill UPDATE is explained once")
			return {
				size,
				rows: Arr.reduce(plans, 0, (sum, p) => sum + rowsTouched(p)),
				pages: Arr.reduce(plans, 0, (sum, p) => sum + p.buffers.sharedHit + p.buffers.sharedRead),
				temp: Arr.reduce(plans, 0, (sum, p) => sum + p.buffers.tempWritten)
			} satisfies Cost
		})
	)

/** The law over one shape's costs, by the size the search ran each at: its increment over the second doubling at most
 * twice its first. */
const linear = (shape: Shape, costs: ReadonlyMap<Scale, Cost>): void => {
	const at = (scale: Scale): Cost =>
		defined(costs.get(scale), `the search ran ${shape} at ${scale}n`)
	const [n, twice, four] = [at(1), at(2), at(4)]
	const sizes = Arr.join(Arr.map([n, twice, four], costText), "; ")
	assert.ok(
		four.rows - twice.rows <= 2 * (twice.rows - n.rows),
		`the keyed tree's backfill over ${shape} touches rows faster than linearly: ${sizes}`
	)
}

layer(Substrate.isolatedLayer)("the cost of a tree's backfill", (it) => {
	it.effect(
		"over a chain and a star of n, 2n and 4n nodes, every row moved before it, the keyed tree's backfill draws the reference's rows, and the rows it touches grow by no more from 2n to 4n than twice what they grow by from n to 2n",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const costs = new Map<Shape, Map<Scale, Cost>>()
					const exhausted = yield* exhaust(
						{
							suite: "pg/migrate/backfill-cost",
							generator: lawGen,
							literal: Formatter.format,
							box: `each shape, a chain and a star, at n, 2n and 4n nodes (n = ${smallest}), one document mapped onto its own root`,
							oracle: {
								kind: "specification",
								name: "linear growth, judged over the cases the search ran: each shape's rows touched growing by no more from 2n to 4n than twice what they grow by from n to 2n; and each case's rows the keyed tree's reference (keyedRows) over rows the data step moved"
							},
							coverage: requiredInSpace<Situation>(
								nonEmpty(
									Arr.flatMap(shapes, (shape) =>
										Arr.map(scales, (scale) => situationOf({ shape, scale }))
									),
									"the box's situations"
								)
							),
							caseHang
						},
						(c, k) =>
							Effect.gen(function* () {
								k.note(situationOf(c))
								const cost = yield* costAt(c.shape, c.scale * smallest)
								const ran = costs.get(c.shape) ?? new Map<Scale, Cost>()
								ran.set(c.scale, cost)
								costs.set(c.shape, ran)
							})
					)
					for (const [shape, ran] of costs) {
						linear(shape, ran)
					}
					return exhausted
				})
			)
	)
})
