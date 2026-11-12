import { Array as Arr, Option, Record as Rec, Result } from "effect"
import { type ReadError, ReadFailure } from "#adapter/errors/execution.ts"
import { temporaryRefusal } from "#adapter/errors/failures.ts"
import type { ExecutedPlan, ExecutedStatement, Plan, PlanTarget } from "#adapter/types/db.ts"
import { asReadFailure, type FlightFailure } from "#adapter/wire/batch.ts"
import type { ExecutionPart } from "#compiler/plan/change.ts"
import { temporarySchema, trustedJson } from "#compiler/plan/runtime.ts"
import type { ServedTable, ServedTables } from "#compiler/plan/serve.ts"

/**
 * Reading PostgreSQL's EXPLAIN (FORMAT JSON, VERBOSE) as the public Plan, and EXPLAIN (ANALYZE, FORMAT JSON, VERBOSE) as
 * the public ExecutedPlan.
 *
 * Either answers one row of one json column: an array holding one object whose "Plan" is the root node, beside, for an
 * ANALYZE, the statement's "Planning Time" and "Execution Time". Each node has "Node Type", "Startup Cost", "Total
 * Cost", "Plan Rows", "Plan Width" and, when it has children, "Plans"; a node that scans or writes a relation names it
 * ("Relation Name", and under VERBOSE its "Schema"), and a node that reads an index names the index ("Index Name"), whose
 * schema is its table's. An ANALYZE node adds what it did: "Actual Startup Time", "Actual Total Time", "Actual Rows",
 * "Actual Loops", and its buffers, "Shared Hit Blocks" and "Shared Read Blocks", which PostgreSQL 19 reports under
 * ANALYZE unasked. A plan keeps exactly those and drops every other member, so it is one shape across server versions.
 *
 * What a node reads is named by the login's served file (served/forms.ts ServedFile tables), never parsed from
 * PostgreSQL's names: its table by schema and name, an index by name among its table's index names, a Bitmap Index
 * Scan's, which names no relation, among the table of its nearest ancestor that names one, its Bitmap Heap Scan. A table in the
 * session's temporary schema is the explained ChangeSet's own carrier, read whole: a carrier holds no index
 * (write/carriers/carriers.ts WriteCarrier), so an index under one is refused. A table or index the file does not name
 * is a plan the explain cannot read, refused like an answer that is no plan.
 */

/** A node as PostgreSQL prints it, read for the members a Plan keeps; a relation, a schema or an index it does not name
 * is absent. */
interface PrintedNode {
	readonly "Node Type": string
	readonly "Startup Cost": number
	readonly "Total Cost": number
	readonly "Plan Rows": number
	readonly "Plan Width": number
	readonly "Relation Name"?: string
	readonly Schema?: string
	readonly "Index Name"?: string
}

/** A node of an estimate-only EXPLAIN. A leaf prints no "Plans". */
interface EstimatedNode extends PrintedNode {
	readonly Plans?: ReadonlyArray<EstimatedNode>
}

/** A node of an EXPLAIN ANALYZE: an estimated node's members, and what it did. */
interface ExecutedNode extends PrintedNode {
	readonly "Actual Startup Time": number
	readonly "Actual Total Time": number
	readonly "Actual Rows": number
	readonly "Actual Loops": number
	readonly "Shared Hit Blocks": number
	readonly "Shared Read Blocks": number
	readonly Plans?: ReadonlyArray<ExecutedNode>
}

/** EXPLAIN (FORMAT JSON)'s one value: one object holding the root node. */
type EstimatedAnswer = readonly [{ readonly Plan: EstimatedNode }]

/** EXPLAIN (ANALYZE, FORMAT JSON)'s one value: one object holding the root node and the statement's times. */
type ExecutedAnswer = readonly [
	{
		readonly Plan: ExecutedNode
		readonly "Planning Time": number
		readonly "Execution Time": number
	}
]

/** The value of `record` at its own key `key`, none where it holds none. */
const own = <V>(record: Readonly<Record<string, V>>, key: string): V | undefined =>
	Option.getOrUndefined(Rec.get(record, key))

/** A node's table, by the served file: the explained ChangeSet's own carrier, or a table the file names. */
type Named = { readonly kind: "carrier" } | { readonly kind: "table"; readonly table: ServedTable }

/** The table a node's descendants' Bitmap Index Scans read from: its nearest ancestor's that names one, or none. */
type Heap = { readonly kind: "none" } | Named

/** What a node reads, and the table its descendants' Bitmap Index Scans read from. */
interface Reading {
	readonly on: PlanTarget
	readonly heap: Heap
}

const nothing: { readonly kind: "none" } = { kind: "none" }
const carrier: { readonly kind: "carrier" } = { kind: "carrier" }

/** The index `name` of `table`, as a target, or why none is. */
const indexOn = (table: ServedTable, name: string): Result.Result<PlanTarget, string> =>
	Arr.contains(table.indexes, name)
		? Result.succeed({ kind: "index", relation: table.relation, index: { name } })
		: Result.fail(`the index ${name}, which the served file names on no table of ${table.relation}`)

/** What a node reads through the index `name` of `heap`'s table: a table's index; a carrier holds none. */
const indexUnder = (heap: Heap, name: string): Result.Result<PlanTarget, string> => {
	switch (heap.kind) {
		case "none":
			return Result.fail(`the index ${name}, under no table the served file names`)
		case "carrier":
			return Result.fail(`the index ${name}, of a carrier, which holds none`)
		case "table":
			return indexOn(heap.table, name)
	}
}

/** What a node reads of `named`'s table whole: a carrier, or the relation the table stores. */
const wholeOf = (named: Named): PlanTarget =>
	named.kind === "carrier" ? carrier : { kind: "relation", relation: named.table.relation }

/** The table `relation` of `schema` by `installed`: a carrier in the temporary schema, else the file's, or why none is. */
const namedOf = (
	relation: string,
	schema: string | undefined,
	installed: ServedTables
): Result.Result<Named, string> => {
	if (schema === temporarySchema) {
		return Result.succeed(carrier)
	}
	const tables = schema === undefined ? undefined : own(installed, schema)
	const table = tables === undefined ? undefined : own(tables, relation)
	return table === undefined
		? Result.fail(`the table ${relation}, which the served file does not name`)
		: Result.succeed({ kind: "table", table })
}

/** What `node` reads, under the table `heap` its nearest ancestor naming one reads, by `installed` (see the header). */
const readingOf = (
	node: PrintedNode,
	heap: Heap,
	installed: ServedTables
): Result.Result<Reading, string> => {
	const relation = node["Relation Name"]
	const index = node["Index Name"]
	if (relation === undefined) {
		return Result.map(
			index === undefined ? Result.succeed(nothing) : indexUnder(heap, index),
			(on) => ({ on, heap })
		)
	}
	return Result.flatMap(namedOf(relation, node.Schema, installed), (named) =>
		Result.map(
			index === undefined ? Result.succeed(wholeOf(named)) : indexUnder(named, index),
			(on) => ({ on, heap: named })
		)
	)
}

/** Each of `nodes` read by `read` under `heap`, in order, or the first refusal. */
const childrenOf = <N, P>(
	nodes: ReadonlyArray<N> | undefined,
	heap: Heap,
	read: (node: N, heap: Heap) => Result.Result<P, string>
): Result.Result<ReadonlyArray<P>, string> => {
	const out: Array<P> = []
	for (const node of nodes ?? []) {
		const child = read(node, heap)
		if (Result.isFailure(child)) {
			return Result.fail(child.failure)
		}
		out.push(child.success)
	}
	return Result.succeed(Object.freeze(out))
}

/** An estimated node and its descendants as a Plan, under `heap`. */
const toPlan = (
	node: EstimatedNode,
	heap: Heap,
	installed: ServedTables
): Result.Result<Plan, string> =>
	Result.flatMap(readingOf(node, heap, installed), (reading) =>
		Result.map(
			childrenOf(node.Plans, reading.heap, (child, under) => toPlan(child, under, installed)),
			(children): Plan =>
				Object.freeze({
					node: node["Node Type"],
					on: reading.on,
					startupCost: node["Startup Cost"],
					totalCost: node["Total Cost"],
					rows: node["Plan Rows"],
					width: node["Plan Width"],
					children
				})
		)
	)

/** An executed node and its descendants as an ExecutedPlan, under `heap`. */
const toExecuted = (
	node: ExecutedNode,
	heap: Heap,
	installed: ServedTables
): Result.Result<ExecutedPlan, string> =>
	Result.flatMap(readingOf(node, heap, installed), (reading) =>
		Result.map(
			childrenOf(node.Plans, reading.heap, (child, under) => toExecuted(child, under, installed)),
			(children): ExecutedPlan =>
				Object.freeze({
					node: node["Node Type"],
					on: reading.on,
					startupCost: node["Startup Cost"],
					totalCost: node["Total Cost"],
					rows: node["Plan Rows"],
					width: node["Plan Width"],
					actual: Object.freeze({
						startupMs: node["Actual Startup Time"],
						totalMs: node["Actual Total Time"],
						rows: node["Actual Rows"],
						loops: node["Actual Loops"]
					}),
					buffers: Object.freeze({
						sharedHit: node["Shared Hit Blocks"],
						sharedRead: node["Shared Read Blocks"]
					}),
					children
				})
		)
	)

/**
 * The Plan of one EXPLAIN (FORMAT JSON, VERBOSE) answer's first cell, its json text, the only form the driver hands
 * over (every cell is raw text): PostgreSQL's answer to grizzle's own statement, parsed once and trusted, its nodes
 * named by `installed`. An answer with no row, and a plan reading a table or index `installed` does not name, are
 * refused.
 */
export const decodePlan = (
	cell: string | undefined,
	installed: ServedTables
): Result.Result<Plan, string> =>
	cell === undefined
		? Result.fail("an EXPLAIN that answered no row")
		: toPlan(trustedJson<EstimatedAnswer>(cell)[0].Plan, nothing, installed)

/**
 * The executed plan and the times of one EXPLAIN (ANALYZE, FORMAT JSON, VERBOSE) answer's first cell, read as
 * decodePlan reads an estimate.
 */
export const decodeExecuted = (
	cell: string | undefined,
	installed: ServedTables
): Result.Result<Omit<ExecutedStatement, "statement">, string> => {
	if (cell === undefined) {
		return Result.fail("an EXPLAIN ANALYZE that answered no row")
	}
	const [answer] = trustedJson<ExecutedAnswer>(cell)
	return Result.map(toExecuted(answer.Plan, nothing, installed), (plan) => ({
		planningMs: answer["Planning Time"],
		executionMs: answer["Execution Time"],
		plan
	}))
}

/**
 * An explain's flight failure as its ReadError: a temporary table the role may not create, refused at the statement of
 * `explained`, each with what it does (write/program/staged.ts ExecutionPart), that creates it, as TemporaryRefused
 * (errors/failures.ts temporaryRefusal); any other as a read's (wire/batch.ts asReadFailure).
 */
export const explainFailure = (
	explained: ReadonlyArray<{ readonly part: ExecutionPart }>,
	failure: FlightFailure
): ReadError => {
	if (failure._tag !== "BatchRefused") {
		return asReadFailure(failure)
	}
	const at = explained[failure.index]
	const temporary = at === undefined ? undefined : temporaryRefusal(at.part, failure.failure)
	return temporary === undefined ? asReadFailure(failure) : new ReadFailure({ reason: temporary })
}
