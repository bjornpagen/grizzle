/**
 * A bounded heterogeneous union on PostgreSQL 19: the optimized artifact against the conservative one, over generated
 * tasks.
 *
 * The schema is bench/query/union.bench.ts's fixed union, delivered per heading group: open tasks with their title and
 * done tasks with their memo, a task having at most one memo, discriminated by kind, so (id, kind) is a key of every
 * arm and the take over the union completes on it (a union over notes, of which a task may have several, is refused at
 * check time, test/unit/check/unions.test.ts). A case draws the tasks, each of a kind of the roster, a done task with
 * a memo or not, and the take's bound. For each query, every relation the optimized artifact's statement delivers
 * holds the raw text set of the same relation of the conservative artifact's, with no repeated row, and both are the
 * bounded subset the model computes by definition, each closed id the code the installation stores for its handle:
 *
 * - the take delivered to the host: one part per heading group, each that group's first k in the common order
 *   (id, then kind in roster order), whose merge is the union's first k;
 * - the take consumed inside a statement, its ids: one relation, the UNION ALL of the common fields under ORDER BY and
 *   LIMIT;
 * - a match of the bounded union that binds kind to Done and so may bind the memo text: the done group's rows joined
 *   back to the bounded union on every common field.
 *
 *
 * Oracle: a model of the bounded union computed by definition, and the conservative artifact beside the optimized one.
 *
 * Plants: oracle-union-take-unordered (a heading group's statement of a union take drops its ORDER BY).
 *
 * Features: each delivery of the take, and each kind of the roster with and without a memo.
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Order, pipe, String as Str } from "effect"
import { partRuns } from "#adapter/reader/execution.ts"
import { identity } from "#compiler/core/identity.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import type { SpecifiedArtifact } from "#compiler/lower/template.ts"
import { closedId, uuid, type Uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, contained, key, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import type { OracleTemplate } from "#test/support/conservative.ts"
import { installMigrated as install, replaceMigrated } from "#test/support/install-migrate.ts"
import { namesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { outputRows } from "#test/support/wire.ts"

const Kind = closed("Kind", ["Open", "Done", "Held"])
const Text = str.regex("^.{1,80}$", "su")
const Task = relation("Task", { id: uuid, kind: closedId(Kind), title: Text }, ["id"])
const Memo = relation("Memo", { id: uuid, task: uuid, text: Text }, ["id"])
const Unions = schema("Unions", { Kind, Task, Memo }, [
	contained(on(Memo, "task"), on(Task, "id")),
	key(on(Memo, "task"))
])

const activity = query(Unions)
	.rule((r) => {
		const { id, title } = v(Task, "task")
		return r.match(Task, { id, kind: "Open", title }).find({ id, kind: Kind.handle("Open"), title })
	})
	.rule((r) => {
		const { id } = v(Task, "task")
		const { text } = v(Memo, "memo")
		return r
			.match(Task, { id, kind: "Done" })
			.match(Memo, { task: id, text })
			.find({ id, kind: Kind.handle("Done"), text })
	})

const firstOf = (k: number) => activity.orderBy(["id", "asc"]).take(k)
const idsOf = (k: number) =>
	query(Unions).rule((r) => {
		const first = firstOf(k)
		const { id } = v(first, "first")
		return r.match(first, { id }).find({ id })
	})

const memosOf = (k: number) =>
	query(Unions).rule((r) => {
		const first = firstOf(k)
		const { id, text } = v(first, "first")
		return r.match(first, { id, kind: "Done", text }).find({ id, text })
	})

const id = (n: number): Uuid =>
	`00000000-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`

type KindHandle = "Open" | "Done" | "Held"

const kinds: Arr.NonEmptyReadonlyArray<KindHandle> = ["Open", "Done", "Held"]

/**
 * One case: its tasks in id order, each a kind of the roster and whether, done, it has a memo (a done task without one
 * is in no arm); and the take's bound, from one row to past every row the union can hold.
 */
interface UnionCase {
	readonly tasks: ReadonlyArray<{ readonly kind: KindHandle; readonly memo: boolean }>
	readonly k: number
}

const maxTasks = 12

const caseGen: Gen<UnionCase> = (source) => ({
	tasks: source.draw(
		array((s) => ({ kind: s.draw(element(kinds)), memo: s.draw(boolean) }), {
			min: 0,
			max: maxTasks
		})
	),
	k: source.draw(int(1, maxTasks + 2))
})

/** A tuple of the union: its id and kind, the key it is ordered by, and its group's own field. */
interface UnionTuple {
	readonly id: string
	readonly kind: KindHandle
	readonly own: string
}

/**
 * A case's facts, and the union's tuples in the completed order: id, then kind in code order, which is the roster's
 * (Open before Done), each kind's code the one the installation stores for it.
 */
const modelOf = (c: UnionCase, code: (kind: KindHandle) => number) => {
	const tasks = Arr.map(c.tasks, (t, i) => ({ id: id(i + 1), kind: t.kind, title: `t${i + 1}` }))
	const memos = Arr.flatMap(c.tasks, (t, i) =>
		t.kind === "Done" && t.memo ? [{ id: id(0x100 + i), task: id(i + 1), text: `m${i + 1}` }] : []
	)
	const union: ReadonlyArray<UnionTuple> = Arr.sort(
		[
			...Arr.flatMap(tasks, (t): ReadonlyArray<UnionTuple> =>
				t.kind === "Open" ? [{ id: t.id, kind: "Open", own: t.title }] : []
			),
			...Arr.map(memos, (m): UnionTuple => ({ id: m.task, kind: "Done", own: m.text }))
		],
		Order.combine(
			Order.mapInput(Order.String, (u: UnionTuple) => u.id),
			Order.mapInput(Order.Number, (u: UnionTuple) => code(u.kind))
		)
	)
	return { facts: { Task: tasks, Memo: memos }, union }
}

const compiled = (q: unknown, schemaIdent: string): OracleTemplate => {
	const r = compileTemplate(q, undefined, {
		...testCompile,
		installation: identity.schema(parsedSchemaName(schemaIdent))
	})
	if (!r.ok) {
		throw new Error(r.error.message)
	}
	return r.value
}

/**
 * The rows of each relation an artifact delivers, in flight order, each as sorted record text: its one statement run,
 * its rows divided into its parts' runs as the runtime divides them (adapter/reader/execution.ts partRuns), and each
 * row the record of its cells. These queries take no parameter, and no cell of theirs, an id, a code or a title, is one
 * a record's text quotes.
 */
const run = (artifact: SpecifiedArtifact) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const spec = artifact.statement.spec
		assert.deepEqual(spec.paramSlots, [])
		const rows = yield* s.admin.queryValues(spec.sql, [])
		const runs = partRuns(
			artifact.parts,
			outputRows(Arr.map(rows, (row) => Arr.map(row, (cell) => String(cell))))
		)
		return Arr.map(flight(artifact.roots), (part): ReadonlyArray<string> => {
			const partRun = runs[part.answer]
			if (partRun === undefined) {
				throw new Error(`no part answers ${part.answer}`)
			}
			return Arr.sort(
				Arr.map(partRun, (cells) => `(${Arr.join(cells, ",")})`),
				Order.String
			)
		})
	})

/**
 * Every relation both artifacts deliver, the optimized one's rows agreeing with the conservative one's, none repeated;
 * the conservative rows.
 */
const agreed = (template: OracleTemplate) =>
	Effect.gen(function* () {
		const optimized = yield* run(template.runs.optimized)
		const conservative = yield* run(template.runs.conservative)
		assert.deepEqual(optimized, conservative, "the relations of both artifacts")
		for (const [i, rows] of conservative.entries()) {
			assert.equal(new Set(rows).size, rows.length, `relation ${i} repeats a row`)
		}
		return conservative
	})

const sorted = (rows: ReadonlyArray<string>): ReadonlyArray<string> => Arr.sort(rows, Order.String)

type Feature =
	| "a take below the union's size"
	| "a take past the union's size"
	| "a heading group the take cuts"
	| "a done task without a memo"

layer(Substrate.layer, { excludeTestServices: true })(
	"a bounded heterogeneous union delivered per heading group",
	(it) => {
		it.effect(
			"agrees with the conservative lowering delivered, consumed and narrowed by kind",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const installed = yield* install(Unions, {
							ambient: ordinarySession,
							label: "real",
							logins: [],
							extensions: []
						})
						const names = namesOf(installed)
						const code = (kind: KindHandle): number => names.code(Kind, kind)
						return yield* explore(
							{
								oracle: {
									kind: "second-implementation",
									name: "the bounded union computed by definition, and the conservative artifact"
								},
								suite: "oracle/union-take",
								draw: drawn(caseGen),
								literal: Formatter.format,
								coverage: required<Feature>(
									[
										"a take below the union's size",
										"a take past the union's size",
										"a heading group the take cuts",
										"a done task without a memo"
									],
									{ cases: 16, sense: notesOnly }
								),
								kept: [],
								runs: 24,
								shrink: { kind: "bounded", candidates: 60 },
								concurrency: 1,
								steerEvery: 8,
								caseHang
							},
							(unionCase, c) =>
								Effect.gen(function* () {
									const { facts, union } = modelOf(unionCase, code)
									yield* replaceMigrated(installed, facts)
									const k = unionCase.k
									const first = union.slice(0, k)
									c.note(
										k < union.length
											? "a take below the union's size"
											: "a take past the union's size"
									)
									if (Arr.some(unionCase.tasks, (t) => t.kind === "Done" && !t.memo)) {
										c.note("a done task without a memo")
									}
									/** Delivered: each heading group's first k, whose merge is the union's first k. */
									const [open, done, ...rest] = yield* agreed(
										compiled(firstOf(k), installed.declared)
									)
									assert.deepEqual(rest, [])
									const group = (kind: KindHandle) => Arr.filter(union, (u) => u.kind === kind)
									if (group("Open").length > k || group("Done").length > k) {
										c.note("a heading group the take cuts")
									}
									assert.deepEqual(
										open,
										sorted(
											Arr.map(
												group("Open").slice(0, k),
												(u) => `(${u.id},${code(u.kind)},${u.own})`
											)
										)
									)
									assert.deepEqual(
										done,
										sorted(
											Arr.map(
												group("Done").slice(0, k),
												(u) => `(${u.id},${code(u.kind)},${u.own})`
											)
										)
									)
									/** Consumed: the ids of the first k. */
									const [ids] = yield* agreed(compiled(idsOf(k), installed.declared))
									assert.deepEqual(ids, sorted(Arr.map(first, (u) => `(${u.id})`)))
									/** Narrowed by kind: the done group's own field for exactly its rows among the first k. */
									const [texts] = yield* agreed(compiled(memosOf(k), installed.declared))
									assert.deepEqual(
										texts,
										sorted(
											Arr.map(
												Arr.filter(first, (u) => u.kind === "Done"),
												(u) => `(${u.id},${u.own})`
											)
										)
									)
								})
						)
					}).pipe(Effect.scoped)
				)
		)
	}
)
