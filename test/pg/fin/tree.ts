/**
 * The tree relation of the fin suites, declared with grizzle's `tree` former, and the SQL a direct writer, the owner,
 * reads and writes its rows by (test/support/families/tree.ts TreeRow), each column addressed by its role in the
 * installed table (installed.ts): its fields by name, its two drawn law columns ‹n› and ‹ps›.
 */
import { Array as Arr, Option } from "effect"
import { drawn, natural, pg } from "#compiler/public/fields.ts"
import { fin, on, relation, schema, tree } from "#compiler/public/schema.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
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

export const Trees = schema(
	"fin_tree",
	[Node],
	[tree(on(Node, "parent", "at"), fin(Node, "children"), { root: "doc" })]
)

export const RELATIONS = ["Node"] as const

/** The row CHECKs of §2.2, each its own constraint or all one: the tree law's CHECK on T. */
const TREE_CHECKS: ReadonlyArray<TreeNative> = [
	"bound",
	"root",
	"root pin",
	"first child",
	"interval"
]

/** The roles each row CHECK reads, by which a CHECK of its own is told apart. */
const CHECK_ROLES: ReadonlyArray<readonly [TreeNative, ReadonlyArray<string>]> = [
	["bound", ["start", "at", "‹n›"]],
	["root", ["parent", "id", "start"]],
	["root pin", ["start", "at"]],
	["first child", ["start", "at", "‹ps›"]],
	["interval", ["end", "start", "children"]]
]

/**
 * The natives of §2.2 an installed constraint stands for, read off the roles of its columns; none for any other. A CHECK
 * reading every role of every row check is the tree law's one CHECK, the conjunction of all five, which stands for each.
 */
export const nativesOf = (c: Catalogued): ReadonlyArray<TreeNative> => {
	const is = (roles: ReadonlyArray<string>) => sameRoles(c.columns, roles)
	switch (c.kind) {
		case "primary":
			return is(["id"]) ? ["identity"] : []
		case "unique":
			return is(["‹gen parent›", "at"])
				? ["family key"]
				: is(["doc", "start"])
					? ["document order"]
					: is(["id", "children", "start", "doc"]) || is(["id", "children", "start"])
						? ["owner superkey"]
						: is(["‹gen parent›", "at", "end"])
							? ["member superkey"]
							: []
		case "check": {
			const own = Arr.filter(CHECK_ROLES, ([, roles]) => is(roles))
			if (Arr.isReadonlyArrayNonEmpty(own)) {
				return Arr.map(own, ([n]) => n)
			}
			return Arr.every(CHECK_ROLES, ([, roles]) =>
				Arr.every(roles, (r) => c.columns.includes(r))
			) && Arr.every(c.columns, (r) => Arr.some(CHECK_ROLES, ([, roles]) => roles.includes(r)))
				? TREE_CHECKS
				: []
		}
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

/**
 * The tree law's row CHECKs without the root pin, `start > 0 OR at = 0`, as one CHECK over the seat's columns: the
 * mutant "root unpinned" of the merged CHECK, its other four conjuncts as LM prints them.
 */
export const unpinnedCheckSql = (seat: Seat, name: string): string => {
	const c = (role: string) => seat.column("Node", role)
	return `ALTER TABLE ${seat.table("Node")} ADD CONSTRAINT ${quoteIdent(name)} CHECK (((${c("start")} = 0 OR ${c("at")} < ${c("‹n›")}) AND ((${c("parent")} = ${c("id")} AND ${c("start")} = 0) OR (${c("parent")} <> ${c("id")} AND ${c("start")} > 0)) AND (${c("start")} = 0 OR ${c("at")} > 0 OR ${c("start")} = ${c("‹ps›")} + 1) AND (${c("end")} > ${c("start")} AND (${c("children")} > 0 OR ${c("end")} = ${c("start")} + 1))) IS TRUE)`
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
