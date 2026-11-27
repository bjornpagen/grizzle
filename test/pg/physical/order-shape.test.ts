/**
 * A served read's canonical order sorts only the rows its key restricts: the order a read that states none comes back
 * in, its key's declared order, is applied above the read's seek, never above a scan of the whole table, so an ordered
 * delivery costs O(r) where the key's index delivers the order and O(r log r) in the r rows delivered where it does
 * not, never a sort of the table.
 *
 * - **Property:** a case draws the order Item's key declares a, b and c in after its shelf, the key's leading field
 *   and the unit Item is mutable in, and the shelf read at. It installs Item as `grizzle generate` drafts and serves it,
 *   fills it with 2^14 items over 64 shelves, 256 to a shelf, vacuumed and analyzed, and plans the read of one shelf's
 *   items (result-order.fixtures.ts, the shelf read), which states no order, as every login's session plans the
 *   statements it prepares, generically (bench/harness/explain.ts genericPlanOf, under the generic plans every session
 *   grizzle opens plans by, physical/ddl/roles.ts genericPlans), under the installation's declared statistics.
 * - **Oracle:** PostgreSQL's generic plan of the served statement: Item is read by an index whose condition binds the
 *   shelf, and every Sort or Incremental Sort node reads Item only so, never by a Seq Scan. Where the plan reads the
 *   shelf's rows in the index's order it holds no Sort at all; where a bitmap scan reads them, the Sort above it sorts
 *   those rows alone.
 * - **Features:** a key declared out of its fields' name order and one declared in it.
 * - **Kills:** a filter's predicate lost, so the read scans the whole table and its Sort sorts every row.
 *
 * A deduplicated read's order sorts only the r rows it delivers, never the n rows it deduplicates: a read that keeps no
 * key (result-order.fixtures.ts, each item's twins less b, a join of Item with itself) is a DISTINCT, formed in a
 * MATERIALIZED CTE and ordered outside it (lower/shapes/index.ts #formed), so the order's sort reads only the r rows the
 * deduplication keeps, however the plan forms them, where an ORDER BY over the DISTINCT itself is read as one sort of
 * every row of the join, the Unique after it.
 *
 * - **Property:** a case draws the order Item's key declares its fields in, installs and serves it as above, and fills
 *   Item with 2^14 items, two to each shelf, a and b, differing in c, so the join holds n = 2^15 rows, four to each
 *   shelf, a and b, and the read, dropping b, eight values a shelf and a, delivers r = 2^12. Item's size is counted as a
 *   VACUUM counts it (fill.ts countedAsVacuumed), its columns' statistics the installation's declared ones, under which
 *   the planner takes the distinct rows for as many as the join's. It runs the read's served statement, EXPLAIN
 *   ANALYZE: a statement of no parameter, whose generic plan is its one plan.
 * - **Oracle:** PostgreSQL's executed plan: the statement delivers r rows, and every Sort or Incremental Sort of the
 *   statement's own query, outside the plans of its CTEs, which form the rows as the planner finds cheapest, reads at
 *   most r rows.
 * - **Kills:** the fence dropped, so the ORDER BY sits on the DISTINCT and PostgreSQL sorts the join's n rows before
 *   their Unique.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { constant, type Gen, int, oneOf, shuffled } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Result, String as Str } from "effect"
import {
	type EstimatedNode,
	genericPlanOf,
	type PlanNode,
	parsePlan,
	parsePlanTree
} from "#bench/harness/explain.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import {
	declaredUnlikeNames,
	installationOf,
	servedOf
} from "#test/pg/served/result-order.fixtures.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { succeeded } from "#test/support/assert.ts"
import { installGenerated } from "#test/support/install-migrate.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { countedAsVacuumed } from "#test/support/substrate/fill.ts"
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

/** Every node of a plan, itself first. */
const nodesOf = (node: EstimatedNode): ReadonlyArray<EstimatedNode> => [
	node,
	...Arr.flatMap(node.children, nodesOf)
]

/** The nodes of `plan` that read relation `table`: its scans of the table and the index scans a bitmap reads it by. */
const readsOf = (plan: EstimatedNode, table: string): ReadonlyArray<EstimatedNode> =>
	Arr.filter(
		nodesOf(plan),
		(n) => Option.contains(n.relation, table) || Str.startsWith("Bitmap Index")(n.nodeType)
	)

/** Whether a read of the table is restricted by an index condition that binds `shelf`, the key's leading column. */
const restricted =
	(shelf: string) =>
	(read: EstimatedNode): boolean =>
		read.nodeType === "Bitmap Heap Scan" ||
		Option.exists(read.indexCond, (cond) => Str.includes(shelf)(cond))

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
					const { admin } = yield* Substrate
					const relation = installed.names.relation("Item")
					const table = printObjectName(relation)
					const column = (f: string) => installed.names.column("Item", f)
					yield* admin.query(
						`INSERT INTO ${table} (${Arr.join(
							Arr.map(["shelf", "a", "b", "c", "note"], (f) => quoteIdent(column(f))),
							", "
						)}) SELECT g / 256, pg_catalog.chr(97 + g / 16 % 16), g % 16, 'c', 'n' FROM pg_catalog.generate_series(0, 16383) AS g`,
						[]
					)
					yield* admin.query(`VACUUM (ANALYZE) ${table}`, [])
					const served = servedOf(c.declared, installed.declared)
					yield* withServedDb(installed, served.world.server.roles.app, {}, ({ loadWithTables }) =>
						Effect.gen(function* () {
							const loaded = yield* loadWithTables(served.programs)
							const onShelf = member(loaded.members, "onShelf")
							if (onShelf.kind !== "read") {
								return assert.fail("the shelf's read is a read")
							}
							const explained = yield* genericPlanOf(
								{ values: admin.queryValues },
								onShelf.read.program.run.spec.text.sql,
								1
							)
							const parsed = parsePlanTree(explained[0]?.[0])
							if (Result.isFailure(parsed)) {
								return assert.fail(`the read's plan: ${parsed.failure.message}`)
							}
							const plan = parsed.success
							const shown = Arr.join(
								Arr.map(nodesOf(plan), (n) => n.nodeType),
								" > "
							)
							const reads = readsOf(plan, relation.name)
							assert.ok(
								Arr.isReadonlyArrayNonEmpty(reads) && Arr.every(reads, restricted(column("shelf"))),
								`the read of one shelf reads Item by an index condition on its shelf: ${shown}`
							)
							for (const sort of Arr.filter(
								nodesOf(plan),
								(n) => n.nodeType === "Sort" || n.nodeType === "Incremental Sort"
							)) {
								assert.ok(
									Arr.every(readsOf(sort, relation.name), restricted(column("shelf"))),
									`a Sort of the read sorts only the shelf's rows, above its seek: ${shown}`
								)
							}
						})
					)
				}).pipe(Effect.scoped),
				Substrate,
				Effect.map(substrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "postgresql",
		name: "PostgreSQL's generic plan of the served statement under declared statistics: every Sort above an index read restricted to the shelf"
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
const shownOf = (node: PlanNode): string =>
	`${node.nodeType} ${node.actualRows * node.actualLoops}${
		node.children.length === 0 ? "" : ` [${Arr.join(Arr.map(node.children, shownOf), ", ")}]`
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
					const { admin } = yield* Substrate
					const table = printObjectName(installed.names.relation("Item"))
					const column = (f: string) => quoteIdent(installed.names.column("Item", f))
					yield* admin.query(
						`INSERT INTO ${table} (${Arr.join(
							Arr.map(["shelf", "a", "b", "c", "note"], column),
							", "
						)}) SELECT g / 256, pg_catalog.chr(97 + g / 2 % 16), g / 32 % 8, pg_catalog.chr(99 + g % 2), 'n' FROM pg_catalog.generate_series(0, ${filledRows - 1}) AS g`,
						[]
					)
					yield* admin.query(countedAsVacuumed(table), [])
					const served = servedOf(c.declared, installed.declared)
					yield* withServedDb(installed, served.world.server.roles.app, {}, ({ loadWithTables }) =>
						Effect.gen(function* () {
							const loaded = yield* loadWithTables(served.programs)
							const twinsRead = member(loaded.members, "twins")
							if (twinsRead.kind !== "read") {
								return assert.fail("the twins' read is a read")
							}
							const explained = yield* admin.queryValues(
								`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SETTINGS, FORMAT JSON) ${twinsRead.read.program.run.spec.text.sql}`,
								[]
							)
							const plan = succeeded(parsePlan(explained[0]?.[0]), "one EXPLAIN plan").plan
							const shown = shownOf(plan)
							assert.equal(
								plan.actualRows * plan.actualLoops,
								deliveredTwins,
								`the read delivers its ${deliveredTwins} rows: ${shown}`
							)
							for (const sort of Arr.filter(
								ownNodesOf(plan),
								(n) => n.nodeType === "Sort" || n.nodeType === "Incremental Sort"
							)) {
								assert.ok(
									inputRowsOf(sort) <= deliveredTwins,
									`a Sort reads ${inputRowsOf(sort)} rows, at most the ${deliveredTwins} delivered, not the join's rows it deduplicates: ${shown}`
								)
							}
						})
					)
				}).pipe(Effect.scoped),
				Substrate,
				Effect.map(substrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "postgresql",
		name: "PostgreSQL's executed generic plan of the served statement over filled rows: every Sort of its own query reads at most the rows delivered"
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
