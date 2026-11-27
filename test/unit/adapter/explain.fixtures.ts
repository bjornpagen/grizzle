/** What the properties of explain.test.ts read: its spaces, models and helpers. */

import { array, element, type Gen, int, oneOf, recursive, subset } from "@bjornpagen/testing/gen"
import { double } from "@bjornpagen/testing/values"
import { Array as Arr, Option, Record as Rec } from "effect"
import type { Plan, PlanTarget } from "#adapter/types/db.ts"
import type { Json } from "#compiler/core/canonical.ts"

/**
 * EXPLAIN (FORMAT JSON, VERBOSE) decoding (packages/grizzle/src/adapter/explain/plan.ts): the public Plan keeps exactly
 * each node's type, its four estimates and its children in order, names what each node reads by the served file's
 * installed tables, and drops every other member PostgreSQL prints; a plan reading a table or an index the file does not
 * name is refused.
 *
 * Over drawn installed tables, two schemas holding tables of the same names, each a relation of its own with indexes of
 * the same names across tables, and drawn plan trees over them: each node of a type
 * PostgreSQL names, its estimates drawn apart from each other so no two coincide by accident, reading nothing, a table
 * whole, a table through an index, a table by a bitmap whose Bitmap Index Scans name their index alone, or a table of
 * the session's temporary schema, which no served statement names (write/carriers/carriers.ts: a ChangeSet's carriers
 * travel in its transaction's settings), read whole, through an index or by a bitmap, beside members PostgreSQL prints
 * that the Plan drops. The answer's json text decodes to the tree's projection onto the Plan's fields, or is refused
 * exactly where some node names a table the file does not hold, a temporary one among them, or an index its table does
 * not. The oracle is that projection, written from the documented mapping ("Node Type" to node, "Startup Cost", "Total
 * Cost", "Plan Rows" and "Plan Width" to the estimates, "Plans" to the children, "Schema" and "Relation Name" to the
 * relation the file names for that table, "Index Name" to that table's index by its name, under a Bitmap Heap Scan the
 * heap's table).
 *
 * Features: a leaf, a node with several children, a tree nested three deep, members the Plan drops, a table read
 * whole, an index scan, a bitmap index scan under its heap, a plan refused for a table or an index the file does not
 * name, and one refused for a temporary table.
 */

/** The schemas, tables and indexes a case names, each name shared across its owners so a lookup must take its owner. */
const schemaNames = ["s0", "s1"] as const

const tableNames = ["t0", "t1"] as const

const indexNames = ["i0", "i1"] as const

/** A table the served file names: its place, the relation it stores, and its indexes. */
interface TableDraw {
	readonly schema: number
	readonly table: number
	readonly indexes: ReadonlyArray<number>
}

/** The relation the file names for the table at `schema`, `table`: one of its own. */
const relationAt = (schema: number, table: number): string => `Relation${schema}${table}`

const placesGen: Gen<ReadonlyArray<readonly [number, number]>> = subset(
	[
		[0, 0],
		[0, 1],
		[1, 0],
		[1, 1]
	],
	{ min: 1, max: 4 }
)

const tablesGen: Gen<ReadonlyArray<TableDraw>> = (source) =>
	Arr.map(source.draw(placesGen), ([schema, table]) => ({
		schema,
		table,
		indexes: source.draw(subset([0, 1], { min: 0, max: 2 }))
	}))

/** The served file's tables of `tables`, as its JSON holds them: each relation and its index names. */
export const installedJson = (tables: ReadonlyArray<TableDraw>): Json =>
	Rec.fromEntries(
		Arr.flatMap(schemaNames, (schemaName, schema) => {
			const held = Arr.filter(tables, (t) => t.schema === schema)
			return held.length === 0
				? []
				: [
						[
							schemaName,
							Rec.fromEntries(
								Arr.map(held, (t) => [
									tableNames[t.table] ?? "",
									{
										relation: relationAt(t.schema, t.table),
										indexes: Arr.map(t.indexes, (i) => indexNames[i] ?? "")
									}
								])
							)
						]
					]
		})
	)

/** How a node reads a temporary table: whole, through an index, or by a bitmap. */
type TemporaryAccess = "whole" | "key" | "bitmap"

/** What a drawn node reads: nothing, a table whole, a table through an index, a bitmap of a table, or a temporary
 * table. */
type Read =
	| { readonly kind: "none" }
	| { readonly kind: "scan"; readonly schema: number; readonly table: number }
	| {
			readonly kind: "index"
			readonly schema: number
			readonly table: number
			readonly index: number
	  }
	| {
			readonly kind: "heap"
			readonly schema: number
			readonly table: number
			readonly bitmaps: ReadonlyArray<number>
	  }
	| { readonly kind: "temporary"; readonly access: TemporaryAccess }

interface Estimates {
	readonly startup: number
	readonly total: number
	readonly rows: number
	readonly width: number
}

interface Node extends Estimates {
	readonly type: string
	readonly read: Read
	readonly dropped: ReadonlyArray<readonly [string, Json]>
	readonly children: ReadonlyArray<Node>
}

/** Node types PostgreSQL prints for a node that reads no relation. */
const nodeTypes = [
	"Hash Join",
	"Hash",
	"Nested Loop",
	"Merge Join",
	"Sort",
	"Aggregate",
	"Limit",
	"Result",
	"CTE Scan"
] as const

/** Members PostgreSQL prints beside the ones the Plan keeps, each with a value of its kind. */
const droppedMembers: Arr.NonEmptyReadonlyArray<readonly [string, Json]> = [
	["Parallel Aware", false],
	["Async Capable", false],
	["Alias", "t"],
	["Hash Cond", "(a.id = b.id)"],
	["Index Cond", "(id = $1)"],
	["Join Type", "Inner"],
	["Sort Key", ["a.id"]],
	["Output", ["a.id"]],
	["Disabled", true],
	["Parent Relationship", "Outer"]
]

const place = int(0, 1)

const estimatesGen: Gen<Estimates> = (source) => ({
	startup: source.draw(double(0, 1e6)),
	total: source.draw(double(0, 1e9)),
	rows: source.draw(int(0, 1_000_000)),
	width: source.draw(int(0, 4096))
})

const readGen: Gen<Read> = oneOf<Read>([
	() => ({ kind: "none" }),
	(source) => ({ kind: "scan", schema: source.draw(place), table: source.draw(place) }),
	(source) => ({
		kind: "index",
		schema: source.draw(place),
		table: source.draw(place),
		index: source.draw(place)
	}),
	(source) => ({
		kind: "heap",
		schema: source.draw(place),
		table: source.draw(place),
		bitmaps: source.draw(array(place, { min: 1, max: 2 }))
	}),
	(source) => ({
		kind: "temporary",
		access: source.draw(element(["whole", "key", "bitmap"] as const))
	})
])

/** The types PostgreSQL names a node reading a temporary table by, by how it reads it. */
const temporaryTypes: { readonly [A in TemporaryAccess]: Gen<string> } = {
	whole: element(["Seq Scan", "Insert", "Delete"] as const),
	key: element(["Index Scan", "Index Only Scan"] as const),
	bitmap: element(["Bitmap Heap Scan"] as const)
}

/** The type PostgreSQL names a node of `read` by. */
const typeOf = (read: Read): Gen<string> => {
	switch (read.kind) {
		case "none":
			return element(nodeTypes)
		case "scan":
			return element(["Seq Scan", "Insert"] as const)
		case "index":
			return element(["Index Scan", "Index Only Scan"] as const)
		case "heap":
			return element(["Bitmap Heap Scan"] as const)
		case "temporary":
			return temporaryTypes[read.access]
	}
}

const leaf: Gen<Node> = (source) => {
	const read = source.draw(readGen)
	return {
		...source.draw(estimatesGen),
		type: source.draw(typeOf(read)),
		read,
		dropped: source.draw(subset(droppedMembers, { min: 0, max: droppedMembers.length })),
		children: []
	}
}

const nodeGen: Gen<Node> = recursive(
	leaf,
	(inner) => (source) => ({
		...source.draw(leaf),
		read: { kind: "none" },
		type: source.draw(element(nodeTypes)),
		children: source.draw(array(inner, { min: 1, max: 3 }))
	}),
	3
)

interface Case {
	readonly tables: ReadonlyArray<TableDraw>
	readonly root: Node
	/** Each bitmap index scan's estimates, in the order the tree prints them. */
	readonly bitmap: Estimates
}

export const caseGen: Gen<Case> = (source) => ({
	tables: source.draw(tablesGen),
	root: source.draw(nodeGen),
	bitmap: source.draw(estimatesGen)
})

const estimatesJson = (e: Estimates): Readonly<Record<string, Json>> => ({
	"Startup Cost": e.startup,
	"Total Cost": e.total,
	"Plan Rows": e.rows,
	"Plan Width": e.width
})

/** A temporary table, and an index of it, as PostgreSQL would name a PRIMARY KEY's index. */
const temporaryName = "__carrier_1"

const temporaryKey = `${temporaryName}_pkey`

/** What PostgreSQL prints of what a node reads under VERBOSE: its table and schema, and its index. */
const readJson = (read: Read): Readonly<Record<string, Json>> => {
	switch (read.kind) {
		case "none":
			return {}
		case "scan":
		case "heap":
			return {
				"Relation Name": tableNames[read.table] ?? "",
				Schema: schemaNames[read.schema] ?? ""
			}
		case "index":
			return {
				"Relation Name": tableNames[read.table] ?? "",
				Schema: schemaNames[read.schema] ?? "",
				"Index Name": indexNames[read.index] ?? ""
			}
		case "temporary":
			return {
				"Relation Name": temporaryName,
				Schema: "pg_temp",
				...(read.access === "key" ? { "Index Name": temporaryKey } : {})
			}
	}
}

/** The index names a node's Bitmap Index Scans print: a table's drawn ones, a temporary table's index, or none. */
const bitmapIndexes = (read: Read): ReadonlyArray<string> =>
	read.kind === "heap"
		? Arr.map(read.bitmaps, (index) => indexNames[index] ?? "")
		: read.kind === "temporary" && read.access === "bitmap"
			? [temporaryKey]
			: []

/** A Bitmap Heap Scan's Bitmap Index Scans, which name their index alone. */
const bitmapsJson = (read: Read, bitmap: Estimates): ReadonlyArray<Json> =>
	Arr.map(bitmapIndexes(read), (index) => ({
		...estimatesJson(bitmap),
		"Node Type": "Bitmap Index Scan",
		"Index Name": index
	}))

/** The node as PostgreSQL prints it: its members, the dropped ones among them, "Plans" only when it has children. */
export const printed = (node: Node, bitmap: Estimates): Json => {
	const plans = [
		...bitmapsJson(node.read, bitmap),
		...Arr.map(node.children, (c) => printed(c, bitmap))
	]
	return {
		...Rec.fromEntries(node.dropped),
		...estimatesJson(node),
		...readJson(node.read),
		"Node Type": node.type,
		...(plans.length === 0 ? {} : { Plans: plans })
	}
}

/** The table at `schema`, `table` the file names, if it names one. */
const tableAt = (c: Case, schema: number, table: number): TableDraw | undefined =>
	Arr.findFirst(c.tables, (t) => t.schema === schema && t.table === table).pipe(
		Option.getOrUndefined
	)

/** The index `index` of `table` as a target, if the table holds it. */
const indexTarget = (table: TableDraw, index: number): PlanTarget | undefined =>
	Arr.contains(table.indexes, index)
		? {
				kind: "index",
				relation: relationAt(table.schema, table.table),
				index: { name: indexNames[index] ?? "" }
			}
		: undefined

/** The target of a read, by the documented mapping, or none where the file names no such table or index. */
const targetOf = (c: Case, read: Read): PlanTarget | undefined => {
	switch (read.kind) {
		case "none":
			return { kind: "none" }
		case "temporary":
			return undefined
		case "scan":
		case "heap": {
			const table = tableAt(c, read.schema, read.table)
			return table === undefined
				? undefined
				: { kind: "relation", relation: relationAt(read.schema, read.table) }
		}
		case "index": {
			const table = tableAt(c, read.schema, read.table)
			return table === undefined ? undefined : indexTarget(table, read.index)
		}
	}
}

/** The targets of a node's Bitmap Index Scans: its table's index each, or none the file does not name, a temporary
 * table's among them. */
const bitmapTargets = (c: Case, read: Read): ReadonlyArray<PlanTarget | undefined> => {
	if (read.kind === "heap") {
		const table = tableAt(c, read.schema, read.table)
		return Arr.map(read.bitmaps, (index) =>
			table === undefined ? undefined : indexTarget(table, index)
		)
	}
	return read.kind === "temporary" && read.access === "bitmap" ? [undefined] : []
}

/** The documented mapping onto the Plan, or none where some node reads what the file does not name. */
export const projected = (c: Case, node: Node): Plan | undefined => {
	const read = node.read
	const on = targetOf(c, read)
	const bitmaps = Arr.map(bitmapTargets(c, read), (target) =>
		target === undefined
			? undefined
			: {
					node: "Bitmap Index Scan",
					on: target,
					startupCost: c.bitmap.startup,
					totalCost: c.bitmap.total,
					rows: c.bitmap.rows,
					width: c.bitmap.width,
					children: []
				}
	)
	const children = [...bitmaps, ...Arr.map(node.children, (child) => projected(c, child))]
	const kept = Arr.flatMap(children, (child) => (child === undefined ? [] : [child]))
	return on === undefined || kept.length !== children.length
		? undefined
		: {
				node: node.type,
				on,
				startupCost: node.startup,
				totalCost: node.total,
				rows: node.rows,
				width: node.width,
				children: kept
			}
}

export const depthOf = (node: Node): number =>
	1 + Arr.reduce(node.children, 0, (deepest, child) => Math.max(deepest, depthOf(child)))

export const all = (node: Node): ReadonlyArray<Node> => [node, ...Arr.flatMap(node.children, all)]

export type PlanFeature =
	| "a leaf"
	| "a node with several children"
	| "nested three deep"
	| "members dropped"
	| "a table read whole"
	| "an index scan"
	| "a bitmap index scan under its heap"
	| "a plan refused"
	| "a temporary table refused"
