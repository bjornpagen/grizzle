/**
 * The tree relation of the fin suites, declared with grizzle's `tree` former, and the SQL a direct writer, the owner,
 * reads and writes its rows by, each column addressed by its role in the installed table (installed.ts): its fields by
 * name and its drawn law column ‹n›. A row is the substrate's TreeRow (test/pg/substrate/tree.ts), written keyed by
 * its root value `doc` and its start, its `parent` the parent's start: the substrate's `parentStart`.
 */
import { Array as Arr, Option } from "effect"
import { drawn, natural, pg } from "#compiler/public/fields.ts"
import { fin, on, relation, schema, tree } from "#compiler/public/schema.ts"
import type { Catalogued, Seat } from "#test/pg/fin/installed.ts"
import { sameRoles } from "#test/pg/fin/installed.ts"
import type { TreeRow } from "#test/pg/substrate/tree.ts"
import type { TreeNative } from "#test/support/families/tree.ts"

/** The tree relation: keyed by its root field `doc` and its start, its parent the parent's start, all five drawn. */
const Node = relation(
	"Node",
	{
		doc: pg.int4,
		parent: drawn(natural),
		at: drawn(natural),
		children: drawn(natural),
		start: drawn(natural),
		end: drawn(natural)
	},
	["doc", "start"]
)

export const Trees = schema("fin_tree", { Node }, [
	tree(on(Node, "parent", "at"), fin(Node, "children"), { root: ["doc"] })
])

export const RELATIONS = ["Node"] as const

/**
 * The natives an installed constraint stands for, read off the roles of its columns; none for any other: the primary
 * key (doc, start) is the identity and the document order at once.
 */
export const nativesOf = (c: Catalogued): ReadonlyArray<TreeNative> => {
	const is = (roles: ReadonlyArray<string>) => sameRoles(c.columns, roles)
	switch (c.kind) {
		case "primary":
			return is(["doc", "start"]) ? ["identity", "document order"] : []
		case "unique":
			return is(["doc", "‹gen parent›", "at"])
				? ["family key"]
				: is(["doc", "start", "children"])
					? ["owner superkey"]
					: is(["doc", "‹gen parent›", "at", "end"])
						? ["member superkey"]
						: []
		case "check":
			return []
		case "foreign":
			return Option.exists(c.target, (t) => t.columns.includes("children"))
				? ["owner axis"]
				: c.columns.includes("‹gen children›")
					? ["last axis"]
					: c.columns.includes("‹gen at›")
						? ["predecessor axis"]
						: []
	}
}

/** The roles every row is written and read by, in order: the root value, the parent's start, its slot and interval, ‹n›. */
const COLUMNS = ["doc", "parent", "at", "children", "start", "end", "‹n›"] as const

const valuesOf = (r: TreeRow): ReadonlyArray<number> => [
	r.root,
	r.parentStart,
	r.at,
	r.children,
	r.start,
	r.end,
	r.copy
]

const columnsOf = (seat: Seat): string =>
	Arr.join(
		Arr.map(COLUMNS, (c) => seat.column("Node", c)),
		", "
	)

/**
 * One INSERT of many rows from seven array parameters, one per column in COLUMNS' order, in the order the arrays hold
 * them: the statement of a load too long for a VALUES list.
 */
export const nodeBatchSql = (seat: Seat): string =>
	`INSERT INTO ${seat.table("Node")} (${columnsOf(seat)}) SELECT * FROM ROWS FROM (${Arr.join(
		Arr.map(
			["int4", "int8", "int8", "int8", "int8", "int8", "int8"],
			(type, i) => `pg_catalog.unnest($${i + 1}::${type}[])`
		),
		", "
	)})`

/** The seven array parameters of nodeBatchSql, each an array literal. */
export const nodeBatchParams = (rows: ReadonlyArray<TreeRow>): ReadonlyArray<string> =>
	Arr.map(
		Array.from({ length: COLUMNS.length }, (_, column) => column),
		(column) =>
			`{${Arr.join(
				Arr.map(rows, (r) => String(Arr.getUnsafe(valuesOf(r), column))),
				","
			)}}`
	)
