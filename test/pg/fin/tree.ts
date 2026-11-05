/**
 * The tree relation of the fin suites, declared with grizzle's `tree` former, and the SQL a direct writer, the owner,
 * reads and writes its rows by (test/support/families/tree.ts TreeRow), each column addressed by its role in the
 * installed table (installed.ts): its fields by name, its two drawn law columns ‹n› and ‹ps›.
 */
import { Array as Arr, Option } from "effect"
import { drawn, natural, pg } from "#compiler/public/fields.ts"
import { fin, on, relation, schema, tree } from "#compiler/public/schema.ts"
import { type Catalogued, type Seat, sameRoles } from "#test/pg/fin/installed.ts"
import type { TreeRow } from "#test/pg/substrate/tree.ts"
import type { TreeNative } from "#test/support/families/tree.ts"

/** The tree relation: its key, its root field `doc`, its parent, and the four naturals the tree draws. */
const Node = relation(
	"Node",
	{
		id: pg.int4,
		doc: pg.int4,
		parent: pg.int4,
		at: drawn(natural),
		children: drawn(natural),
		start: drawn(natural),
		end: drawn(natural)
	},
	["id"]
)

export const Trees = schema("fin_tree", { Node }, [
	tree(on(Node, "parent", "at"), fin(Node, "children"), { root: "doc" })
])

export const RELATIONS = ["Node"] as const

/** The role of an installed constraint among §2.2's natives, read off the roles of its columns; none for any other. */
export const nativeOf = (c: Catalogued): Option.Option<TreeNative> => {
	const is = (roles: ReadonlyArray<string>) => sameRoles(c.columns, roles)
	switch (c.kind) {
		case "primary":
			return is(["id"]) ? Option.some("identity") : Option.none()
		case "unique":
			return is(["‹gen parent›", "at"])
				? Option.some("family key")
				: is(["doc", "start"])
					? Option.some("document order")
					: is(["id", "children", "start", "doc"]) || is(["id", "children", "start"])
						? Option.some("owner superkey")
						: is(["‹gen parent›", "at", "end"])
							? Option.some("member superkey")
							: Option.none()
		case "check":
			return is(["start", "at", "‹n›"])
				? Option.some("bound")
				: is(["parent", "id", "start"])
					? Option.some("root")
					: is(["start", "at"])
						? Option.some("root pin")
						: is(["start", "at", "‹ps›"])
							? Option.some("first child")
							: is(["end", "start", "children"])
								? Option.some("interval")
								: Option.none()
		case "foreign":
			return Option.exists(c.target, (t) => t.columns.includes("children"))
				? Option.some("owner axis")
				: c.columns.includes("‹gen children›")
					? Option.some("last axis")
					: c.columns.includes("‹gen at›")
						? Option.some("predecessor axis")
						: Option.none()
	}
}

/** The roles every row is written and read by, in order: a TreeRow's fields, `doc` for its root, and its two copies. */
const COLUMNS = ["id", "doc", "parent", "at", "children", "start", "end", "‹n›", "‹ps›"] as const

const valuesOf = (r: TreeRow): ReadonlyArray<number> => [
	r.id,
	r.root,
	r.parent,
	r.at,
	r.children,
	r.start,
	r.end,
	r.copy,
	r.parentStart
]

const columnsOf = (seat: Seat): string =>
	Arr.join(
		Arr.map(COLUMNS, (c) => seat.column("Node", c)),
		", "
	)

/** One INSERT of rows, in the order given. */
export const nodeInsertSql = (seat: Seat, rows: Arr.NonEmptyReadonlyArray<TreeRow>): string =>
	`INSERT INTO ${seat.table("Node")} (${columnsOf(seat)}) VALUES ${Arr.join(
		Arr.map(rows, (r) => `(${Arr.join(Arr.map(valuesOf(r), String), ", ")})`),
		", "
	)}`

export const nodeReadSql = (seat: Seat): string =>
	`SELECT ${Arr.join(
		Arr.map(COLUMNS, (c) => `${seat.column("Node", c)}::int8`),
		", "
	)} FROM ${seat.table("Node")}`

export const nodeRowsOfRead = (
	rows: ReadonlyArray<ReadonlyArray<unknown>>
): ReadonlyArray<TreeRow> =>
	Arr.map(rows, ([id, root, parent, at, children, start, end, copy, parentStart]) => ({
		id: Number(id),
		root: Number(root),
		parent: Number(parent),
		at: Number(at),
		children: Number(children),
		start: Number(start),
		end: Number(end),
		copy: Number(copy),
		parentStart: Number(parentStart)
	}))

/**
 * One INSERT of many rows from nine array parameters, one per column in COLUMNS' order, in the order the arrays hold
 * them: the statement of a load too long for a VALUES list.
 */
export const nodeBatchSql = (seat: Seat): string =>
	`INSERT INTO ${seat.table("Node")} (${columnsOf(seat)}) SELECT * FROM ROWS FROM (${Arr.join(
		Arr.map(
			["int4", "int4", "int4", "int8", "int8", "int8", "int8", "int8", "int8"],
			(type, i) => `pg_catalog.unnest($${i + 1}::${type}[])`
		),
		", "
	)})`

/** The nine array parameters of nodeBatchSql, each an array literal. */
export const nodeBatchParams = (rows: ReadonlyArray<TreeRow>): ReadonlyArray<string> =>
	Arr.map(
		Arr.makeBy(9, (column) => column),
		(column) =>
			`{${Arr.join(
				Arr.map(rows, (r) => String(Arr.getUnsafe(valuesOf(r), column))),
				","
			)}}`
	)
