/** What the properties of backfill-cost.test.ts read: its spaces, models and helpers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { ChunkView } from "@bjornpagen/grizzle-text/chunks"
import { assert, defined } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, Order, String as Str } from "effect"
import { readMeta } from "#adapter/boundary/meta.ts"
import { advisedSteps } from "#adapter/migrate/apply.ts"
import {
	explainStatementWith,
	parsePlan,
	type PlanNode,
	rowsTouched
} from "#bench/harness/explain.ts"
import type { Draft } from "#compiler/deploy/diff/plan.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { splitStatements, statedAdvice } from "#compiler/plan/migration.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { apply, noFurther, openMigrator } from "#test/pg/migrate/support.ts"
import { succeeded } from "#test/support/assert.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import {
	column,
	type DocTree,
	docTree,
	keyedFields,
	keyedRows,
	keyedTreeOf,
	nodeTable,
	q,
	type StoredDocument,
	storedInsert,
	type TreeCase,
	treeDataStep,
	treePlaceholder,
	withDataStep
} from "#test/support/migrate/keyed-tree.ts"
import { asDrafted, compile, draftedAt, fromSnapshot, generate } from "#test/support/migrate/kit.ts"
import { review } from "#test/support/migrate/review.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** The shapes of the box: a chain of n nodes, each the parent of the next, or a star, one root over n − 1 children. */
export const shapes = ["a chain", "a star"] as const

type Shape = (typeof shapes)[number]

/** The sizes of the box, each a multiple of the smallest, n: n, 2n and 4n nodes. */
export const scales = [1, 2, 4] as const

export type Scale = (typeof scales)[number]

/** A forest of one shape at one size: what a case reaches at each of its sizes. */
interface LawCase {
	readonly shape: Shape
	readonly scale: Scale
}

/** What a case reaches: its shape at its size. */
export type Situation = `${Shape} at ${Scale}n`

export const situationOf = (c: LawCase): Situation => `${c.shape} at ${c.scale}n`

/** A case of the box: one shape, whose forest the case runs at every size, n, 2n and 4n nodes. */
export const shapeGen: Gen<Shape> = (source) => source.draw(element(shapes))

/** The nodes of the smallest size, n: 2n and 4n follow. */
export const smallest = 200

/** A document of `shape` with `size` nodes, each node's kind its start's residue modulo four (treeOfParents numbers a
 * node's parent before it, the root 0). */
const documentOf = (shape: Shape, size: number): StoredDocument => {
	const below = indices(size - 1)
	return {
		parents: shape === "a chain" ? below : Arr.map(below, () => 0),
		kinds: Arr.map(indices(size), (i) => i % 4)
	}
}

/** What one size's backfill cost: the rows its UPDATEs touched, and the pages they read and the temp they wrote. */
export interface Cost {
	readonly size: number
	readonly rows: number
	readonly pages: number
	readonly temp: number
}

const costText = (c: Cost): string =>
	`${c.rows} rows at ${c.size} nodes (${c.pages} pages read, ${c.temp} temp pages written)`

/** The statement texts of `steps`'s backfill UPDATEs, as a folder spells them. */
const backfillTexts = (g: ReturnType<typeof keyedDraft>): ReadonlySet<string> => {
	const backfills = new Set<Draft>(
		Arr.flatMap(g.plan.steps, (s) =>
			s.slot === "structure.backfill" &&
			s.draft.kind === "statement" &&
			s.draft.statement.kind === "update"
				? [s.draft]
				: []
		)
	)
	return new Set(
		Arr.flatMap(g.files, (f) =>
			Arr.flatMap(f.drafts, (bound, at) => {
				const drafted = f.file.drafts[at]
				return drafted !== undefined && backfills.has(drafted) && bound.kind === "step"
					? [normalized(printStatement(bound.statement))]
					: []
			})
		)
	)
}

/** A statement's text without its surrounding blanks and its closing semicolon. */
const normalized = (statement: string): string => {
	const text = Str.trim(statement)
	return Str.endsWith(";")(text) ? Str.trim(Str.slice(0, -1)(text)) : text
}

/** A step of a folder's transaction as the runner sends it: an advice set, or a statement of a file. */
type Sent =
	| { readonly kind: "advise"; readonly advice: string }
	| { readonly kind: "statement"; readonly sql: string }

/** The column every row's tid is read by. */
const rowColumn = "ctid"

/** Rows of texts in one order, each compared whole. */
const byRow = Order.mapInput(Order.String, (row: ReadonlyArray<string>) => Arr.join(row, "\u0000"))

/** The keyed tree drafted from the stored tree (keyed-tree.ts docTree), its document dropped. */
const keyedDraft = (tree: DocTree) =>
	succeeded(
		generate({
			previous: fromSnapshot(tree.snapshot),
			installation: compile(keyedTreeOf(), asDrafted),
			name: "keyed",
			timestamp: draftedAt(1),
			workload: noWorkload,
			declared: {
				renames: [],
				drops: [{ kind: "field", relation: parsedName("Node"), field: parsedName("doc") }]
			}
		}),
		"the keyed tree drafts"
	)

/**
 * One size's cost: the stored tree installed, its forest of one document of `shape` stored, then the keyed tree's
 * reviewed folder run in one transaction up to its backfill, each backfill UPDATE explained, and rolled back.
 */
export const costAt = (shape: Shape, size: number) =>
	Effect.scoped(
		Effect.gen(function* () {
			const substrate = yield* Substrate
			const tree = docTree()
			yield* Effect.addFinalizer(() =>
				Effect.orDie(
					substrate.admin.query(`DROP SCHEMA IF EXISTS ${q(tree.snapshot.schema)} CASCADE`, [])
				)
			)
			const m = yield* openMigrator(substrate, substrate.owner)
			yield* apply(m, { snapshot: tree.snapshot, folders: [tree.folder] }, noFurther)
			const c: TreeCase = { documents: [documentOf(shape, size)], roots: [0] }
			yield* transaction(substrate.admin, [storedInsert(tree, c)])
			const g = keyedDraft(tree)
			const backfill = backfillTexts(g)
			const reviewed = review(withDataStep(g, treeDataStep(tree, c)), {
				losses: "written",
				value: treePlaceholder
			})
			const meta = succeeded(readMeta(g.folder.metaText), "the keyed tree's meta.json read")
			/** The reviewed folder's statements as the runner sends them, each file's under the advice its record states
			 * (adapter/migrate/apply.ts advisedSteps): its record's set first, set off around the reviewer's data step. */
			const sent = Arr.flatMap(reviewed.files, (f): ReadonlyArray<Sent> => {
				const written = splitStatements(new ChunkView(f.text))
				const stated = statedAdvice(meta, f)
				return [
					{ kind: "advise", advice: stated.advice },
					...Arr.map(advisedSteps(stated, written.length), (step): Sent =>
						step.kind === "advise"
							? step
							: { kind: "statement", sql: defined(written[step.index], "a statement of the file") }
					)
				]
			})
			const statements = Arr.map(sent, (x) => (x.kind === "statement" ? x.sql : ""))

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
			const table = nodeTable(tree.snapshot)
			const pinned = yield* substrate.admin.pin
			/** Each row's tid by its stored key, its start in its document, as the transaction sees it. */
			const tids = Effect.map(
				pinned.queryValues(
					`SELECT ${column("doc")}::text, ${column("start")}::text, ${rowColumn}::text FROM ${table}`,
					[]
				),
				(rows) =>
					new Map(
						Arr.map(rows, ([doc, start, tid]): readonly [string, string] => [
							`${String(doc)}:${String(start)}`,
							String(tid)
						])
					)
			)
			yield* pinned.query("BEGIN", [])
			const run = Effect.gen(function* () {
				const plans: Array<PlanNode> = []
				const loaded = new Map<string, string>()
				for (const [i, x] of sent.slice(0, through + 1).entries()) {
					if (x.kind === "advise") {
						yield* pinned.queryValues(
							"SELECT pg_catalog.set_config('pg_plan_advice.advice', $1::text, true)",
							[x.advice]
						)
						continue
					}
					const s = x.sql
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
							explainStatementWith(normalized(s), {
								serialize: { kind: "off" },
								wal: false,
								verbose: false
							}),
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

/** The law over one shape's costs, by the size its case ran each at: its increment over the second doubling at most
 * twice its first. */
export const linear = (shape: Shape, costs: ReadonlyMap<Scale, Cost>): void => {
	const at = (scale: Scale): Cost =>
		defined(costs.get(scale), `the search ran ${shape} at ${scale}n`)
	const [n, twice, four] = [at(1), at(2), at(4)]
	const sizes = Arr.join(Arr.map([n, twice, four], costText), "; ")
	assert.ok(
		four.rows - twice.rows <= 2 * (twice.rows - n.rows),
		`the keyed tree's backfill over ${shape} touches rows faster than linearly: ${sizes}`
	)
}
