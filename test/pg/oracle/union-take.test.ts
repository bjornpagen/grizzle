/**
 * A bounded heterogeneous union on PostgreSQL 19: the optimized artifact against the conservative one.
 *
 * The fixture is bench/query/union.bench.ts's fixed union, delivered per heading group: open tasks with their title and
 * done tasks with their memo, a task having at most one memo, discriminated by kind, so (id, kind) is a key of every
 * arm and the take over the union completes on it (a union over notes, of which a task may have several, is refused at
 * check time, test/unit/check/unions.test.ts). For each query, every statement of the optimized artifact returns
 * the raw text set of the same statement of the conservative artifact, with no repeated row, and both are the
 * bounded subset computed here by definition:
 *
 * - the take delivered to the host: one statement per heading group, each that group's first k in the common order
 *   (id, then kind in roster order), whose merge is the union's first k;
 * - the take consumed inside a statement, its ids: one statement, the UNION ALL of the common fields under ORDER BY and
 *   LIMIT;
 * - a match of the bounded union that binds kind to Done and so may bind the memo text: the done group's rows joined
 *   back to the bounded union on every common field.
 */
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Order, pipe, String as Str } from "effect"
import { indices } from "#compiler/core/array.ts"
import { identity } from "#compiler/core/identity.ts"
import type { StatementSpec } from "#compiler/ir/products.ts"
import type { QueryTemplate } from "#compiler/program/compile.ts"
import { closedId, uuid, type Uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, contained, key, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import { installMigrated as install, loadMigrated as load } from "#test/support/install-migrate.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { at } from "#test/support/oracle/pick.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

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

/** Twelve tasks cycling Open, Done, Held; every other done task has a memo, so some done tasks are in no arm. */
const kinds = ["Open", "Done", "Held"] as const
const tasks = Arr.map(indices(12), (i) => ({
	id: id(i + 1),
	kind: at(kinds, i),
	title: `t${i + 1}`
}))

const memos = Arr.map(
	Arr.filter(tasks, (t, i) => t.kind === "Done" && i % 2 === 1),
	(t, i) => ({ id: id(100 + i), task: t.id, text: `memo of ${t.title}` })
)

/** A tuple of the union: its id and kind, the key it is ordered by. */
interface UnionTuple {
	readonly id: string
	readonly kind: string
}

/** The union's tuples in the completed order: id, then kind in roster order (Open before Done). */
const union = Arr.sort(
	[
		...Arr.map(
			Arr.filter(tasks, (t) => t.kind === "Open"),
			(t) => ({ id: t.id, kind: "Open", own: t.title })
		),
		...Arr.map(memos, (m) => ({ id: m.task, kind: "Done", own: m.text }))
	],
	Order.combine(
		Order.mapInput(Order.String, (u: UnionTuple) => u.id),
		Order.mapInput(Order.Number, (u: UnionTuple) => (u.kind === "Open" ? 0 : 1))
	)
)

const compiled = (q: unknown, schemaIdent: string): QueryTemplate => {
	const r = compileTemplate(q, undefined, {
		...testCompile,
		installation: identity.schema(parsedSchemaName(schemaIdent))
	})
	if (!r.ok) {
		throw new Error(r.error.message)
	}
	return r.value
}

/** The rows of a statement as sorted record text; these queries take no parameter. */
const run = (spec: StatementSpec) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		assert.deepEqual(spec.paramSlots, [])
		const rows = yield* s.admin.queryValues(`SELECT t::text FROM (${spec.sql}) AS t`, [])
		return Arr.sort(
			Arr.map(rows, (r) => String(r[0])),
			Order.String
		)
	})

/**
 * Every statement of both artifacts, the optimized one's agreeing with the conservative one's; the conservative rows.
 */
const agreed = (template: QueryTemplate) =>
	Effect.gen(function* () {
		assert.equal(template.optimized.length, template.conservative.length)
		const out: Array<ReadonlyArray<string>> = []
		for (const [i, base] of template.conservative.entries()) {
			const optimized = template.optimized[i]
			if (optimized === undefined) {
				throw new Error(`optimized statement ${i}`)
			}
			const expected = yield* run(base)
			const optimizedRows = yield* run(optimized)
			assert.deepEqual(optimizedRows, expected, `statement ${i}`)
			assert.equal(new Set(expected).size, expected.length, `statement ${i} repeats a row`)
			out.push(expected)
		}
		return out
	})

const sorted = (rows: ReadonlyArray<string>): ReadonlyArray<string> =>
	Arr.sort([...rows], Order.String)

/** The take bounds each query is compiled at: one row, a few, and more than the union holds. */
const bounds = [1, 2, 3, 5, 20] as const

type Bound = (typeof bounds)[number]

type BoundFeature = `take ${Bound}`

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
						yield* load(installed, { Task: tasks, Memo: memos })
						return yield* exhaust(
							{
								suite: "oracle/union-take",
								generator: element(bounds),
								literal: Formatter.format,
								limit: bounds.length,
								coverage: requiredInSpace<BoundFeature>(
									Arr.map(bounds, (k): BoundFeature => `take ${k}`)
								),
								caseHang
							},
							(k, c) =>
								Effect.gen(function* () {
									const first = union.slice(0, k)
									/** Delivered: each heading group's first k, whose merge is the union's first k. */
									const [open, done, ...rest] = yield* agreed(
										compiled(firstOf(k), installed.declared)
									)
									assert.deepEqual(rest, [])
									const group = (kind: string) =>
										Arr.filter(union, (u) => u.kind === kind).slice(0, k)
									assert.deepEqual(
										open,
										sorted(Arr.map(group("Open"), (u) => `(${u.id},Open,${u.own})`))
									)
									assert.deepEqual(
										done,
										sorted(Arr.map(group("Done"), (u) => `(${u.id},Done,"${u.own}")`))
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
												(u) => `(${u.id},"${u.own}")`
											)
										)
									)
									c.note(`take ${k}`)
								})
						)
					}).pipe(Effect.scoped)
				)
		)
	}
)
