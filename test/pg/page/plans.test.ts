import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Layer, Option, pipe, String as Str } from "effect"
import { openDbContext } from "#adapter/db/open.ts"
import { poolExecutor } from "#adapter/reader/executor.ts"
import { makeReader } from "#adapter/reader/reader.ts"
import { explainStatementWith, parsePlan, rowsRead } from "#bench/harness/explain.ts"
import { planNodeTypes } from "#bench/harness/explain.ts"
import { workload } from "#compiler/program/workload/value.ts"
import type { Uuid } from "#compiler/public/fields.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { countingExecutor, untyped } from "#test/pg/page/support.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { workloadOver } from "#test/support/compile.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import {
	ascendingTasks,
	descendingTasks,
	priorityDescendingTasks,
	Paging,
	Task
} from "#test/unit/page/fixtures.ts"
import { fixtureLogin } from "#test/unit/workload/fixtures.ts"

/**
 * The plans of the statements the page runtime sends, as performance properties over drawn requests.
 *
 * The paging example's Task holds 40,000 facts over 40 accounts, 1,000 each. It installs with one workload holding every
 * order a page reads (program/workload, physical/access workloadExtension): priority ascending, priority descending with
 * the id ascending (mixed), and every key descending. An access index is identified by its columns and a direction
 * vector canonical under reversal, so the descending order is the ascending one's index read backward and the mixed
 * order has its own; the three orders install together, which is the case a workload naming an order and its exact
 * reverse must reach. A drawn request (an order, first, after or before an anchor drawn among the account's rows, a page
 * size of 1 to 20) is sent through the runtime with a counting executor, and the rows statement it sent is run under
 * EXPLAIN (ANALYZE), read by the tree's one EXPLAIN decoder:
 *
 * - every request reads the task table through an index, never by a sequential scan, and none has a Unique node: the
 *   delivered heading keeps the primary key, so no page deduplicates (R17);
 * - past a long remainder (every first page among them) nothing is sorted: each order has an access path in its own
 *   order or its exact reverse, read forward or backward; a short remainder the planner may read and sort, a few rows;
 * - a seek in one direction is a native row comparison the index bounds (R05): it never reads a row on the far side of
 *   the anchor, and past a long remainder it reads at most the page and its lookahead;
 * - a first page in mixed directions reads at most the page and its lookahead; a seek in mixed directions (the OR
 *   expansion) reads either the index up to the page or the rows past the anchor, never the whole account. Which, for
 *   a short remainder, is the planner's measured choice.
 *
 * The plan's node order, index names and costs are the planner's; the properties above are the contract. Anchors with
 * a long remainder past them, where a seek the index does not bound reads far more than a page, are planted by drawing
 * the anchor across the whole account.
 */

const id = (n: number): Uuid =>
	`00000000-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`
const accounts = 40
/** Ten times any page, so the cost of a page's seek and of reading an account apart are never close. */
const perAccount = 1000

/** The facts are written in SQL over generate_series once the schema is installed: 40,000 tasks, priorities 0 to 996. */
const factsSql = (table: string, column: (field: string) => string): string =>
	`INSERT INTO ${table} (${Arr.join(Arr.map(["id", "account", "priority", "title"], column), ", ")})
	SELECT ('00000000-0000-4000-8000-' || lpad(to_hex(1048576 + i), 12, '0'))::uuid,
		('00000000-0000-4000-8000-' || lpad(to_hex(i % ${accounts}), 12, '0'))::uuid,
		(i * 7919) % 997, 'title ' || (i % 13)
	FROM generate_series(0, ${accounts * perAccount - 1}) AS i`

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
type Variant = "first" | "after" | "before"

interface PlanCase {
	readonly order: Order
	readonly variant: Variant
	readonly size: number
	readonly account: number
	/** The anchor's position in the account's order, 1-based: the last row of the first `anchor` rows. */
	readonly anchor: number
}

const planCaseGen: Gen<PlanCase> = (source) => ({
	order: source.draw(element<Order>(["descending", "ascending", "mixed"])),
	variant: source.draw(element<Variant>(["first", "after", "before"])),
	size: source.draw(int(1, 20)),
	account: source.draw(int(0, accounts - 1)),
	anchor: source.draw(int(1, perAccount))
})

type PlanFeature =
	| `${Order} ${Variant}`
	| "a one-direction seek past a long remainder"
	| "a mixed seek past a long remainder"

/** A remainder ten times the largest page: a seek bounded by the page is the only sensible plan past it. */
const longRemainder = 200

/**
 * The rows past the anchor on the seek's side: after it for an after page, before it for a before page, every row of
 * the account for a first page.
 */
const remainder = (c: PlanCase): number =>
	c.variant === "after" ? perAccount - c.anchor : c.variant === "before" ? c.anchor - 1 : perAccount

/** Explores drawn requests over every order on one installation of the combined workload. */
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
			]
		}
	)
	const task = namesOf(opened.installed).table(Task)
	yield* s.admin.query(
		factsSql(task, (field) => quoteIdent(opened.installed.names.column(Task.name, field))),
		[]
	)
	yield* s.admin.query(`VACUUM ANALYZE ${task}`, [])
	return yield* Effect.gen(function* () {
		const { ctx } = yield* openDbContext(opened.server.roles.app, {})
		const { executor, counts } = countingExecutor(poolExecutor(ctx))
		const pager = untyped(makeReader(ctx, executor))
		/** The rows statement the runtime sends for a request: the first statement of that request. */
		const sentFor = (q: unknown, params: object, request: object) =>
			Effect.gen(function* () {
				const before = counts.sent.length
				yield* pager.page(q, params, request)
				const sent = counts.sent[before]
				if (sent === undefined) {
					return yield* Effect.die(new Error("no statement sent"))
				}
				return sent
			})
		return yield* explore(
			{
				oracle: { kind: "unstated" },
				/**
				 * The task table is read through an index, never sequentially, and nothing is deduplicated.
				 *
				 * Past a long remainder every order is read by an index in its own order or its exact reverse, so
				 * nothing is sorted; a short one the planner may read and sort, a few rows either way.
				 *
				 * Sargable: no row on the far side of the anchor is read.
				 *
				 * Past a long remainder the seek is bounded by the page and its lookahead.
				 *
				 * The OR expansion reads the index in its own order up to the page, or the rows past the anchor
				 * alone: never the whole account.
				 */
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
								["first", "after", "before"] as const,
								(variant): PlanFeature => `${order} ${variant}`
							)
						),
						"a one-direction seek past a long remainder",
						"a mixed seek past a long remainder"
					],
					{ cases: 60, sense: notesOnly }
				)
			},
			(c, cx) =>
				Effect.gen(function* () {
					const q = orders[c.order]
					const params = { account: id(c.account) }
					const upToAnchor = yield* pager.page(q, params, { first: c.anchor })
					const anchor = Option.getOrThrow(upToAnchor.pageInfo.endCursor)
					const request =
						c.variant === "first"
							? { first: c.size }
							: c.variant === "after"
								? { first: c.size, after: anchor }
								: { last: c.size, before: anchor }
					const sent = yield* sentFor(q, params, request)
					const rows = yield* s.admin.queryValues(
						explainStatementWith(sent.sql, { serialize: { kind: "off" }, wal: false }),
						sent.params
					)
					const cell = rows[0]?.[0]
					const types = planNodeTypes(cell)
					const shown = Arr.join(types, ", ")
					assert.ok(
						Arr.some(["Index Scan", "Index Only Scan", "Bitmap Index Scan"], (nodeType) =>
							types.includes(nodeType)
						),
						`an index access: ${shown}`
					)
					for (const absent of ["Seq Scan", "Unique"]) {
						assert.equal(types.includes(absent), false, `no ${absent}: ${shown}`)
					}
					const read = rowsRead(succeeded(parsePlan(cell), "one EXPLAIN ANALYZE plan").plan)
					const past = remainder(c)
					if (past >= longRemainder) {
						for (const absent of ["Sort", "Incremental Sort"]) {
							assert.equal(
								types.includes(absent),
								false,
								`no ${absent} past a long remainder: ${shown}`
							)
						}
						if (c.variant !== "first") {
							cx.note(
								c.order === "mixed"
									? "a mixed seek past a long remainder"
									: "a one-direction seek past a long remainder"
							)
						}
					}
					if (c.order !== "mixed") {
						assert.ok(read <= past, `${read} rows read, ${past} past the anchor`)
						if (past >= longRemainder) {
							assert.ok(read <= c.size + 1, `${read} rows read for a page of ${c.size}`)
						}
					} else if (c.variant === "first") {
						assert.ok(read <= c.size + 1, `${read} rows read for a first page of ${c.size}`)
					} else {
						assert.ok(
							read <= Math.max(perAccount - past + c.size + 1, past),
							`${read} rows read, ${past} past the anchor, a page of ${c.size}`
						)
					}
					cx.note(`${c.order} ${c.variant}`)
				})
		)
	}).pipe(
		Effect.scoped,
		(body) =>
			Effect.flatMap(Layer.build(opened.layer), (context) => Effect.provideContext(body, context)),
		Effect.scoped
	)
}).pipe(Effect.scoped)

layer(Substrate.layer)("the plans of the page runtime's statements", (it) => {
	it.effect(
		"with an order, its exact reverse and a mixed order in one workload, every page reads the task table by an index, deduplicates nothing, sorts nothing past a long remainder, and a seek reads only its page and lookahead",
		(ctx) => searched(ctx, explorePlans)
	)
})
