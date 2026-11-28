/**
 * A served read's canonical order sorts only the rows its key restricts: the order a read that states none comes back
 * in, its key's declared order, is applied above the read's seek, never above a scan of the whole table, so an ordered
 * delivery costs O(r) where the key's index delivers the order and O(r log r) in the r rows delivered where it does
 * not, never a sort of the table.
 *
 * - **Property:** a case draws the order Item's key declares a, b and c in after its shelf, the key's leading field
 *   and the unit Item is mutable in, and the shelf read at. It installs Item as `grizzle generate` drafts and serves it,
 *   compiles the read of one shelf's items as a served Db of its world compiles it (result-order.fixtures.ts, the shelf
 *   read; test/support/advice.ts servedRead), which states no order, and in each pg_class state (never vacuumed, counted
 *   empty, analyzed, skewed, large; test/pg/physical/serving.ts inEveryState), Item filled with 2^14 items over 64
 *   shelves, 256 to a shelf, plans it under the advice it carries (plannedScope).
 * - **Oracle:** PostgreSQL's plan of the served statement under its advice: the plan laws hold over it, Item is read by
 *   an index whose condition binds the shelf, and every Sort or Incremental Sort node reads Item only so, never by a Seq
 *   Scan. Where the plan reads the shelf's rows in the index's order it holds no Sort at all; where a bitmap scan reads
 *   them, the Sort above it sorts those rows alone.
 * - **Features:** a key declared out of its fields' name order and one declared in it.
 * - **Kills:** a filter's predicate lost, so the read scans the whole table and its Sort sorts every row.
 *
 * A deduplicated read's order sorts only the r rows it delivers, never the n rows it deduplicates: a read that keeps no
 * key (result-order.fixtures.ts, each item's twins less b, a join of Item with itself) is a DISTINCT, formed in a
 * MATERIALIZED CTE and ordered outside it (lower/shapes/index.ts #formed), so the order's sort reads only the r rows the
 * deduplication keeps, however the plan forms them, where an ORDER BY over the DISTINCT itself is read as one sort of
 * every row of the join, the Unique after it.
 *
 * - **Property:** a case draws the order Item's key declares its fields in, installs and serves it as above, and in each
 *   pg_class state fills Item with 2^14 items, two to each shelf, a and b, differing in c, so the join holds n = 2^15
 *   rows, four to each shelf, a and b, and the read, dropping b, eight values a shelf and a, delivers r = 2^12. It runs
 *   the read's served statement under the advice it carries, once the plan laws hold over it, EXPLAIN ANALYZE: a
 *   statement of no parameter, whose generic plan is its one plan.
 * - **Oracle:** PostgreSQL's executed plan: the statement delivers r rows, and every Sort or Incremental Sort of the
 *   statement's own query, outside the plans of its CTEs, reads at most r rows.
 * - **Kills:** the fence dropped, so the ORDER BY sits on the DISTINCT and PostgreSQL sorts the join's n rows before
 *   their Unique.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { constant, type Gen, int, oneOf, shuffled } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import type { PlanNode } from "#bench/harness/explain.ts"
import type { BenchSession } from "#bench/harness/session.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import type { ObjectName } from "#compiler/sql/ast.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { inEveryState } from "#test/pg/physical/serving.ts"
import {
	advisedExplain,
	type LawNode,
	lawNodes,
	lawsOver,
	plannedScope,
	servedRead,
	type StateLoad
} from "#test/support/advice.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Installed, installGenerated } from "#test/support/install-migrate.ts"
import {
	declaredUnlikeNames,
	installationOf,
	servedOf
} from "#test/support/pg/served/result-order.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

type OrderShapeFeature =
	| "a key declared out of its fields' name order"
	| "a key declared in its fields' name order"

interface OrderShapeCase {
	readonly declared: ReadonlyArray<"a" | "b" | "c">
	readonly shelf: number
}

/** A key declared in its fields' name order, or in any order. */
const declaredGen: Gen<ReadonlyArray<"a" | "b" | "c">> = oneOf([
	constant(["a", "b", "c"] as const),
	shuffled(["a", "b", "c"] as const, { min: 3, max: 3 })
])

const caseGen: Gen<OrderShapeCase> = (source) => ({
	declared: source.draw(declaredGen),
	shelf: source.draw(int(0, 63))
})

const situations = [
	"a key declared out of its fields' name order",
	"a key declared in its fields' name order"
] as const satisfies ReadonlyArray<Reached<OrderShapeFeature>>

/**
 * Item filled by `row`, its columns' SQL over the series `g` from 0 (shelf, a, b, c and note), as a load the laws stand
 * in a state (test/support/advice.ts StateLoad), an item its unit.
 */
const itemLoad = (
	session: BenchSession,
	installed: Installed,
	rows: number,
	row: string
): StateLoad => {
	const table = printObjectName(installed.names.relation("Item"))
	return {
		tables: [table],
		units: rows,
		load: (from, to) =>
			Effect.asVoid(
				session.values(
					`INSERT INTO ${table} (${Arr.join(
						Arr.map(["shelf", "a", "b", "c", "note"], (f) =>
							quoteIdent(installed.names.column("Item", f))
						),
						", "
					)}) SELECT ${row} FROM pg_catalog.generate_series(${from - 1}, ${to - 1}) AS g`,
					[]
				)
			)
	}
}

/** The nodes of `plan` that read the table `item`: its scans of the table and the index scans a bitmap reads it by. */
const readsOf = (plan: LawNode, item: ObjectName): ReadonlyArray<LawNode> =>
	Arr.filter(
		[...lawNodes(plan)],
		(n) =>
			Option.contains(n.relation, `${item.schema}.${item.name}`) ||
			n.nodeType === "Bitmap Index Scan"
	)

/** Whether a read of the table is restricted by an index condition that binds `shelf`, the key's leading column. */
const restricted =
	(shelf: string) =>
	(read: LawNode): boolean =>
		read.nodeType === "Bitmap Heap Scan" || Arr.some(read.indexCond, (c) => c.column === shelf)

/** A plan's nodes by their types, outermost first. */
const shownOf = (plan: LawNode): string =>
	Arr.join(
		Arr.map([...lawNodes(plan)], (n) => n.nodeType),
		" > "
	)

/** A served read's canonical order sorts only the rows its key's seek restricts, never the whole table. */
export const aReadsCanonicalOrderSortsOnlyTheRowsItsKeyRestricts = property.explore(caseGen, {
	needs: { substrate: Substrate.fresh(baseSubstrate) },
	situations,
	budget: { runs: 8, steered: 8 },
	check:
		({ substrate }, notes: Case<OrderShapeFeature>) =>
		(c: OrderShapeCase) =>
			Effect.provideServiceEffect(
				Effect.gen(function* () {
					notes.note(
						declaredUnlikeNames(c)
							? "a key declared out of its fields' name order"
							: "a key declared in its fields' name order"
					)
					const generated = yield* installGenerated(installationOf(c.declared), {
						label: "order_shape",
						ambient: ordinarySession
					})
					const installed = generated.installed
					const item = installed.names.relation("Item")
					const shelf = installed.names.column("Item", "shelf")
					const served = servedOf(c.declared, installed.declared)
					const read = yield* servedRead(
						installed,
						served.world.server.roles.app,
						served.programs.onShelf,
						"the read of one shelf"
					)
					const problems = yield* inEveryState(
						installed.installation,
						(session) =>
							itemLoad(
								session,
								installed,
								16384,
								"g / 256, pg_catalog.chr(97 + g / 16 % 16), g % 16, 'c', 'n'"
							),
						(session) =>
							Effect.gen(function* () {
								const planned = yield* plannedScope(session, read.scope)
								const found = [...lawsOver(read.scope, planned)]
								for (const plan of planned.plans) {
									const reads = readsOf(plan.root, item)
									if (!Arr.isReadonlyArrayNonEmpty(reads) || !Arr.every(reads, restricted(shelf))) {
										found.push(
											`the read of one shelf reads Item by no index condition on its shelf: ${shownOf(plan.root)}`
										)
									}
									for (const sort of Arr.filter(
										[...lawNodes(plan.root)],
										(n) => n.nodeType === "Sort" || n.nodeType === "Incremental Sort"
									)) {
										if (!Arr.every(readsOf(sort, item), restricted(shelf))) {
											found.push(
												`a Sort of the read sorts more than the shelf's rows: ${shownOf(plan.root)}`
											)
										}
									}
								}
								return found
							})
					)
					assert.deepEqual(problems, [], "the read of one shelf sorts only the shelf's rows")
				}).pipe(Effect.scoped),
				Substrate,
				Effect.map(substrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "postgresql",
		name: "PostgreSQL 19's plan of the served statement under the advice it carries, in every pg_class state: the plan laws, and every Sort above an index read restricted to the shelf"
	},
	show: Formatter.format,
	kept: [],
	kills: [
		{
			file: "packages/engine/src/lower/conservative/filter/index.ts",
			original: "\t\tlowerExpr(cx, node.pred, scope)\n\t])",
			replacement: "\t])",
			why: "A filter's predicate is lost: the read of one shelf scans the whole table and sorts every row, a Sort above a Seq Scan."
		}
	]
})

/**
 * The rows a Sort sorts: its outer child's, over all its loops. A child of another relationship, a CTE's or a
 * subquery's plan, computes rows the sort reads through a scan of them, not its input.
 */
const inputRowsOf = (node: PlanNode): number =>
	Arr.reduce(
		Arr.filter(node.children, (child) => Option.contains(child.parentRelationship, "Outer")),
		0,
		(sum, child) => sum + child.actualRows * child.actualLoops
	)

/** An executed plan's nodes, each with its rows and its children in brackets, outermost first. */
const shownRowsOf = (node: PlanNode): string =>
	`${node.nodeType} ${node.actualRows * node.actualLoops}${
		node.children.length === 0 ? "" : ` [${Arr.join(Arr.map(node.children, shownRowsOf), ", ")}]`
	}`

/**
 * The rows Item is filled with, two to each shelf, a and b, differing in c; and the twins' rows they deliver: each
 * shelf's a with its four pairs of c, b dropped.
 */
const filledRows = 16384

const deliveredTwins = filledRows / 4

/**
 * The nodes of the statement's own query, outermost first: not the plans of its CTEs and subqueries, whose rows it reads
 * by a scan of them.
 */
const ownNodesOf = (node: PlanNode): ReadonlyArray<PlanNode> => [
	node,
	...Arr.flatMap(
		Arr.filter(
			node.children,
			(child) =>
				!Option.contains(child.parentRelationship, "InitPlan") &&
				!Option.contains(child.parentRelationship, "SubPlan")
		),
		ownNodesOf
	)
]

/** A deduplicated read's order sorts only the r rows it delivers, never the n rows it deduplicates. */
export const aDeduplicatedReadsOrderSortsOnlyTheRowsItDelivers = property.explore(caseGen, {
	needs: { substrate: Substrate.fresh(baseSubstrate) },
	situations,
	budget: { runs: 4, steered: 4 },
	check:
		({ substrate }, notes: Case<OrderShapeFeature>) =>
		(c: OrderShapeCase) =>
			Effect.provideServiceEffect(
				Effect.gen(function* () {
					notes.note(
						declaredUnlikeNames(c)
							? "a key declared out of its fields' name order"
							: "a key declared in its fields' name order"
					)
					const generated = yield* installGenerated(installationOf(c.declared), {
						label: "dedup_shape",
						ambient: ordinarySession
					})
					const installed = generated.installed
					const served = servedOf(c.declared, installed.declared)
					const read = yield* servedRead(
						installed,
						served.world.server.roles.app,
						served.programs.twins,
						"the twins' read"
					)
					const problems = yield* inEveryState(
						installed.installation,
						(session) =>
							itemLoad(
								session,
								installed,
								filledRows,
								"g / 256, pg_catalog.chr(97 + g / 2 % 16), g / 32 % 8, pg_catalog.chr(99 + g % 2), 'n'"
							),
						(session) =>
							Effect.gen(function* () {
								const planned = yield* plannedScope(session, read.scope)
								const found = [...lawsOver(read.scope, planned)]
								const plan = yield* advisedExplain(session, read.statement.sql, [])
								const shown = shownRowsOf(plan)
								if (plan.actualRows * plan.actualLoops !== deliveredTwins) {
									found.push(
										`the read delivers ${plan.actualRows * plan.actualLoops} rows, not its ${deliveredTwins}: ${shown}`
									)
								}
								for (const sort of Arr.filter(
									ownNodesOf(plan),
									(n) => n.nodeType === "Sort" || n.nodeType === "Incremental Sort"
								)) {
									if (inputRowsOf(sort) > deliveredTwins) {
										found.push(
											`a Sort reads ${inputRowsOf(sort)} rows, past the ${deliveredTwins} delivered, the join's rows it deduplicates: ${shown}`
										)
									}
								}
								return found
							})
					)
					assert.deepEqual(problems, [], "the twins' order sorts only the rows the read delivers")
				}).pipe(Effect.scoped),
				Substrate,
				Effect.map(substrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "postgresql",
		name: "PostgreSQL 19's executed generic plan of the served statement under the advice it carries, over filled rows in every pg_class state: the plan laws, and every Sort of its own query reads at most the rows delivered"
	},
	show: Formatter.format,
	kept: [],
	kills: [
		{
			file: "packages/engine/src/lower/shapes/index.ts",
			original:
				"\t\treturn spec.order === undefined || spec.heading.length === 0 || !deduplicates(rel)",
			replacement:
				"\t\treturn spec.order === undefined || spec.heading.length >= 0 || !deduplicates(rel)",
			why: "The fence is dropped: the ORDER BY sits on the DISTINCT, and PostgreSQL sorts every one of the join's 2^15 rows before its Unique, a Sort that grows with the rows deduplicated, not the 2^12 delivered."
		}
	]
})
