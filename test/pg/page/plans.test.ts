/**
 * The plans of the statements the page runtime sends: what the installation's access paths serve, over drawn tasks and
 * drawn requests, with PostgreSQL's alternatives to an access path disabled.
 *
 * The paging example's Task installs with one workload holding every order a page reads (program/workload,
 * physical/access workloadExtension): priority ascending, priority descending with the id ascending (mixed), and every
 * key descending. An access index is identified by its columns and a direction vector canonical under reversal, so the
 * descending order is the ascending one's index read backward and the mixed order has its own; the three orders
 * install together, which is the case a workload naming an order and its exact reverse must reach. Each case replaces
 * the task table's facts with drawn tasks of the paged account and of another (substrate/replace.ts), and reads a drawn
 * window (an order, from the start, or after or before the key of a row drawn among the paged account's, a size of one
 * to seven) through the order's paged member of the login's served workload, on a Db context that records what its
 * sessions send (test/support/plans.ts recordingContext). The window's statement runs under EXPLAIN (ANALYZE) with
 * sequential scans and sorts disabled, so a plan that still scans the table sequentially or sorts has no access path
 * that does otherwise, read by the tree's one EXPLAIN decoder:
 *
 * - every window reads the task table through an index, never by a sequential scan, and none has a Unique node: the
 *   delivered heading keeps the primary key, so no window deduplicates (R17);
 * - nothing is sorted: each order has an access path in its own order or its exact reverse, read forward or backward;
 * - a start window, and a seek in one direction, a native row comparison the index bounds (R05), read at most the
 *   window, and a seek no row on the far side of its anchor;
 * - a seek in mixed directions (the OR expansion) reads at most the account's rows up to its anchor and the window past
 *   it, never the rest of the account.
 *
 * The plan's node order, index names and costs are the planner's; the properties above are what the access paths serve,
 * at any volume, so no volume stands in for the planner's choice.
 *
 * Oracle: PostgreSQL's EXPLAIN (ANALYZE) of each statement sent, under the specification above.
 *
 * Plants: page-access-paths-dropped (the workload requests no access path, so a window scans or sorts the table).
 *
 * Features: each order, each anchor kind, and each seek direction the plans name.
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, pipe, Record as Rec, String as Str } from "effect"
import { memberCalls } from "#adapter/db/handles.ts"
import { explainStatementWith, parsePlan, rowsRead } from "#bench/harness/explain.ts"
import { planNodeTypes } from "#bench/harness/explain.ts"
import type { Param } from "#compiler/core/wire.ts"
import { type Anchor, keyOf } from "#compiler/live/index.ts"
import { workload } from "#compiler/program/workload/value.ts"
import type { Uuid } from "#compiler/public/fields.ts"
import { paged as pagedMember } from "#compiler/public/workload.ts"
import { pageTemplate, windowOf } from "#test/pg/page/support.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { workloadOver } from "#test/support/compile.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { pickGen, pickIndex } from "#test/support/pick.ts"
import { recordingContext } from "#test/support/plans.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import {
	ascendingTasks,
	descendingTasks,
	priorityDescendingTasks,
	Paging,
	Task
} from "#test/unit/page/fixtures.ts"
import { fixtureLogin } from "#test/unit/workload/fixtures.ts"

const id = (n: number): Uuid =>
	`00000000-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`

/** The paged account, and another whose tasks share the table and its indexes. */
const paged = id(0xa)
const other = id(0xb)

/**
 * The orders: every key descending, every key ascending (one native row comparison each), and priority descending
 * with the id ascending (mixed: the OR expansion).
 */
const orders = {
	descending: descendingTasks,
	ascending: ascendingTasks,
	mixed: priorityDescendingTasks
} as const
type Order = keyof typeof orders
type Variant = "start" | "after" | "before"

interface PlanCase {
	readonly order: Order
	readonly variant: Variant
	readonly size: number
	/** The priorities of the paged account's tasks, at least one, and of the other account's. */
	readonly tasks: { readonly paged: ReadonlyArray<number>; readonly other: ReadonlyArray<number> }
	/** Which of the paged account's rows, in the order, is the anchor: the last of the window from the start up to it. */
	readonly anchor: number
}

/** A task's priority: few, so tasks tie on it and the id completes the order. */
const priorityGen = int(0, 4)

const planCaseGen: Gen<PlanCase> = (source) => ({
	order: source.draw(element<Order>(["descending", "ascending", "mixed"])),
	variant: source.draw(element<Variant>(["start", "after", "before"])),
	size: source.draw(int(1, 7)),
	tasks: {
		paged: source.draw(array(priorityGen, { min: 1, max: 16 })),
		other: source.draw(array(priorityGen, { min: 0, max: 16 }))
	},
	anchor: source.draw(pickGen)
})

type PlanFeature =
	| `${Order} ${Variant}`
	| "a one-direction seek past more rows than its window reads"
	| "a mixed seek past more rows than its window reads"

/**
 * The paged account's rows past the anchor on the seek's side, of `total`, the anchor the `at`th: after it for an after
 * window, before it for a before window, every row of the account for a start window.
 */
const remainder = (c: PlanCase, total: number, at: number): number =>
	c.variant === "after" ? total - at : c.variant === "before" ? at - 1 : total

/** Explores drawn windows over drawn tasks on one installation of the combined workload. */
const explorePlans = Effect.gen(function* () {
	const s = yield* Substrate
	const opened = yield* installed(
		Paging,
		{},
		{
			label: "real",
			extensions: [
				workloadOver([
					{
						login: fixtureLogin,
						workloads: [
							workload(Paging, {
								ascending: ascendingTasks,
								mixed: priorityDescendingTasks,
								descending: descendingTasks
							})
						]
					}
				])
			],
			programs: {}
		}
	)
	const names = namesOf(opened.installed)
	const task = names.table(Task)
	const column = (field: "id" | "account" | "priority" | "title"): string =>
		names.column(Task, field)
	return yield* withServedDb(opened.installed, opened.server.roles.app, {}, ({ ctx, load }) =>
		Effect.gen(function* () {
			const loaded = yield* load(Rec.map(orders, (q) => pagedMember(q)))
			const recording = recordingContext(ctx)
			/** The paged member of an order, what its windows send recorded. */
			const pager = (order: Order) => memberCalls(recording.ctx, member(loaded, order))
			const params = { account: paged }
			/** The statement the runtime sends for a window: the one statement of its flight. */
			const sentFor = (order: Order, anchor: Anchor, size: number) =>
				Effect.gen(function* () {
					const before = recording.counts.sent.length
					yield* windowOf(pager(order), params, anchor, size)
					return defined(recording.counts.sent[before], "the window's statement")
				})
			/**
			 * The plan of a sent statement, run under EXPLAIN (ANALYZE) in a transaction of its own with sequential scans and
			 * sorts disabled, rolled back.
			 */
			const planOf = (sent: { readonly sql: string; readonly params: ReadonlyArray<Param> }) =>
				Effect.scoped(
					Effect.gen(function* () {
						const session = yield* s.admin.pin
						yield* session.query("BEGIN", [])
						yield* Effect.addFinalizer(() => Effect.orDie(session.query("ROLLBACK", [])))
						yield* session.query("SET LOCAL enable_seqscan = off", [])
						yield* session.query("SET LOCAL enable_sort = off", [])
						const rows = yield* session.queryValues(
							explainStatementWith(sent.sql, { serialize: { kind: "off" }, wal: false }),
							sent.params
						)
						return rows[0]?.[0]
					})
				)
			return yield* explore(
				{
					oracle: {
						kind: "postgresql",
						name: "EXPLAIN (ANALYZE) with sequential scans and sorts disabled"
					},
					suite: "pg/page/plans",
					draw: drawn(planCaseGen),
					literal: Formatter.format,
					kept: [],
					runs: 60,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang,
					coverage: required<PlanFeature>(
						[
							...Arr.flatMap(["descending", "ascending", "mixed"] as const, (order) =>
								Arr.map(
									["start", "after", "before"] as const,
									(variant): PlanFeature => `${order} ${variant}`
								)
							),
							"a one-direction seek past more rows than its window reads",
							"a mixed seek past more rows than its window reads"
						],
						{ cases: 60, sense: notesOnly }
					)
				},
				(c, cx) =>
					Effect.gen(function* () {
						const tasks = [
							...Arr.map(c.tasks.paged, (priority) => ({ account: paged, priority })),
							...Arr.map(c.tasks.other, (priority) => ({ account: other, priority }))
						]
						yield* replaceRows(
							s.admin,
							installationGroup(names),
							Arr.map(tasks, (t, n) => ({
								sql: `INSERT INTO ${task} (${column("id")}, ${column("account")}, ${column("priority")}, ${column("title")}) VALUES ($1::uuid, $2::uuid, $3::integer, $4::text)`,
								params: [id(0x1000 + n), t.account, String(t.priority), `title ${n}`]
							}))
						)
						yield* s.admin.query(`ANALYZE ${task}`, [])
						const total = c.tasks.paged.length
						const at = pickIndex(c.anchor, total) + 1
						const upToAnchor = yield* windowOf(pager(c.order), params, { kind: "start" }, at)
						const key = keyOf(
							pageTemplate(member(loaded, c.order), opened.installed.names.codes).fields,
							defined(upToAnchor.at(-1), "the anchor's row")
						)
						const anchor: Anchor =
							c.variant === "start"
								? { kind: "start" }
								: c.variant === "after"
									? { kind: "after", key }
									: { kind: "before", key }
						const sent = yield* sentFor(c.order, anchor, c.size)
						const cell = yield* planOf(sent)
						const types = planNodeTypes(cell)
						const shown = Arr.join(types, ", ")
						assert.ok(
							Arr.some(["Index Scan", "Index Only Scan", "Bitmap Index Scan"], (nodeType) =>
								types.includes(nodeType)
							),
							`an index access: ${shown}`
						)
						for (const absent of ["Seq Scan", "Unique", "Sort", "Incremental Sort"]) {
							assert.equal(types.includes(absent), false, `no ${absent}: ${shown}`)
						}
						const read = rowsRead(succeeded(parsePlan(cell), "one EXPLAIN ANALYZE plan").plan)
						const past = remainder(c, total, at)
						if (c.order !== "mixed" || c.variant === "start") {
							assert.ok(
								read <= Math.min(past, c.size),
								`${read} rows read, ${past} past the anchor, a window of ${c.size}`
							)
						} else {
							assert.ok(
								read <= total - past + c.size,
								`${read} rows read, ${total - past} of the account up to the anchor, a window of ${c.size}`
							)
						}
						if (c.variant !== "start" && past > c.size) {
							cx.note(
								c.order === "mixed"
									? "a mixed seek past more rows than its window reads"
									: "a one-direction seek past more rows than its window reads"
							)
						}
						cx.note(`${c.order} ${c.variant}`)
					})
			)
		})
	)
}).pipe(Effect.scoped)

layer(Substrate.layer)("the plans of the page runtime's statements", (it) => {
	it.effect(
		"with an order, its exact reverse and a mixed order in one workload, every window reads the task table by an index, deduplicates nothing, sorts nothing, and a seek reads only its window past the anchor",
		(ctx) => searched(ctx, explorePlans)
	)
})
