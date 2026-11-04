import { Array as Arr, Option, String as Str } from "effect"
import {
	findNodes,
	type PlanMode,
	type PlanNode,
	type PlanSummary,
	planNodes
} from "#bench/harness/explain.ts"
import type { VariantMeasure } from "#bench/harness/variant.ts"
import { GateSetupError, type InstalledIndex } from "#bench/query/support/kit.ts"

/**
 * Reading the captured plans of the query gates: actual row and loop counts, heap fetches, rows removed,
 * buffers, temp I/O, and startup versus total work.
 *
 * Every mechanism check of a query gate is structural over EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON): which
 * nodes a plan has, which relations it reads and how, which installed index an access reads by an index condition,
 * and how many rows each scan read over all its loops. None reads a timing, and none reads a condition's text.
 *
 *  The plan summary of statement `index` of a measured variant.
 */
export const summaryOf = (measure: VariantMeasure, index: number): PlanSummary => {
	const summary = measure.plans[index]
	if (summary === undefined) {
		throw new GateSetupError({ what: `${measure.label} has no statement ${index}` })
	}
	return summary
}

/** The first sample's plan of statement `index` of a measured variant. */
export const planOf = (measure: VariantMeasure, index: number): PlanNode =>
	summaryOf(measure, index).plan

/** Every statement's plan of a measured variant. */
export const plansOf = (measure: VariantMeasure): ReadonlyArray<PlanNode> =>
	Arr.map(measure.plans, (p) => p.plan)

/** The first sample's plan of statement `index` of a measured variant planned as a server statement in `mode`. */
export const serverStatementPlanOf = (
	measure: VariantMeasure,
	mode: PlanMode,
	index: number
): PlanNode => {
	const plan = Option.flatMap(
		Arr.findFirst(measure.serverPlans, (p) => p.mode === mode),
		(p) => Arr.get(p.plans, index)
	)
	return Option.getOrThrowWith(
		plan,
		() => new GateSetupError({ what: `${measure.label} has no ${mode} plan of statement ${index}` })
	).plan
}

/**
 * Nodes that remove duplicates in a plan of a query that aggregates nothing: a Unique, or an Aggregate (HashAggregate
 * or GroupAggregate over the distinct columns), or a SetOp.
 */
export const dedupNodes = (plan: PlanNode): ReadonlyArray<PlanNode> =>
	findNodes(
		plan,
		(n) => n.nodeType === "Unique" || n.nodeType === "Aggregate" || n.nodeType === "SetOp"
	)

export const aggregateNodes = (plan: PlanNode): ReadonlyArray<PlanNode> =>
	findNodes(plan, "Aggregate")

export const joinTypes = (plan: PlanNode): ReadonlyArray<string> =>
	planNodes(plan)
		.flatMap((n) => Option.toArray(n.joinType))
		.toArray()

/** The nodes that scan the stored relation `table` (its unqualified name). */
export const scansOf = (plan: PlanNode, table: string): ReadonlyArray<PlanNode> =>
	findNodes(
		plan,
		(n) =>
			Option.contains(n.relation, table) &&
			Option.isNone(n.operation) &&
			n.nodeType !== "Bitmap Index Scan"
	)

/**
 * Rows a plan read from `table`, over every loop of every scan of it: output plus what filters and rechecks removed.
 */
export const rowsReadFrom = (plan: PlanNode, table: string): number =>
	Arr.reduce(
		scansOf(plan, table),
		0,
		(sum, n) =>
			sum + (n.actualRows + n.rowsRemovedByFilter + n.rowsRemovedByIndexRecheck) * n.actualLoops
	)

/**
 * One access of an installed index by a plan node: the index, its key columns in key order, and the access condition
 * the node has, an Index Cond or an Order By.
 */
export interface IndexAccess {
	readonly index: string
	readonly columns: ReadonlyArray<string>
	readonly condition: "index cond" | "order by"
}

/**
 * Every access of an index of `table` in a plan, one per Index Cond or Order By a node has, as opposed to a sequential
 * scan or an index scan followed by a filter alone. A node reads `table` by an index when it names one of `table`'s
 * installed indexes, which is how a bitmap index scan, which names no relation, is attributed.
 */
export const indexAccessOn = (
	plan: PlanNode,
	table: string,
	indexes: ReadonlyArray<InstalledIndex>
): ReadonlyArray<IndexAccess> =>
	planNodes(plan)
		.flatMap((n) => {
			const found = Arr.findFirst(
				indexes,
				(i) => i.table === table && Option.contains(n.index, i.name)
			)
			return Option.match(found, {
				onNone: (): ReadonlyArray<IndexAccess> => [],
				onSome: (index) => {
					const of = (condition: IndexAccess["condition"]): IndexAccess => ({
						index: index.name,
						columns: index.columns,
						condition
					})
					return [
						...(Option.isSome(n.indexCond) ? [of("index cond")] : []),
						...(Option.isSome(n.orderBy) ? [of("order by")] : [])
					]
				}
			})
		})
		.toArray()

/** The node types of a plan, each once. */
export const nodeTypes = (plan: PlanNode): ReadonlySet<string> =>
	new Set(planNodes(plan).map((n) => n.nodeType))

/** The planner's figures a gate records for a variant: planning and execution p50s, rows read, shared buffers. */
export const planFigures = (measure: VariantMeasure): Readonly<Record<string, number>> => ({
	planningMs: Arr.reduce(measure.plans, 0, (s, p) => s + p.planningMs.p50),
	executionMs: Arr.reduce(measure.plans, 0, (s, p) => s + p.executionMs.p50),
	rowsRead: Arr.reduce(measure.plans, 0, (s, p) => s + p.rowsRead.p50),
	sharedHit: Arr.reduce(measure.plans, 0, (s, p) => s + p.sharedHit.p50),
	sharedRead: Arr.reduce(measure.plans, 0, (s, p) => s + p.sharedRead.p50)
})

/** The serialized output of statement `index` of a variant captured with SERIALIZE, its p50 in kB. */
export const serializedKb = (measure: VariantMeasure, index: number): number => {
	const serialized = summaryOf(measure, index).serializationKb
	if (serialized.kind === "notCaptured") {
		throw new GateSetupError({
			what: `${measure.label}'s statement ${index} was captured without SERIALIZE`
		})
	}
	return serialized.kb.p50
}

/** A key EXPLAIN printed, after its label; nothing for one it omitted. */
const present = (key: Option.Option<string>, label: string): string =>
	Option.match(key, { onNone: () => "", onSome: (value) => `${label}${value}` })

/** One plan as an indented outline, for a check's detail. */
export const outline = (plan: PlanNode, depth: number): string =>
	Arr.join(
		[
			`${Str.repeat(depth)("  ")}${plan.nodeType}${present(plan.joinType, " ")}${present(plan.relation, " on ")}${present(plan.index, " using ")} rows=${plan.actualRows} loops=${plan.actualLoops}${present(plan.indexCond, " cond=")}${present(plan.filter, " filter=")}`,
			...Arr.map(plan.children, (c) => outline(c, depth + 1))
		],
		"\n"
	)
