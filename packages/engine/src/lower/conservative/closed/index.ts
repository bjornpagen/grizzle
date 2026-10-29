import { closedRows } from "#compiler/ir/rel.ts"
import { contractOf, type ScalarType } from "#compiler/ir/scalar.ts"
import {
	distinctSelect,
	headingTargets,
	type LowerContext,
	type Lowerers,
	type NodeLowerer,
	nodeLabel,
	outputNames,
	refuse
} from "#compiler/lower/conservative/context.ts"
import { lowerLiteral } from "#compiler/lower/conservative/expr/index.ts"
import type { Expr, FromItem } from "#compiler/sql/ast.ts"
import { lit } from "#compiler/sql/build.ts"

/** A value of every admitted type, for the one row an empty VALUES source stands on; WHERE false discards it. */
const placeholderValue = (cx: LowerContext, type: ScalarType, at: string): Expr => {
	const contract = contractOf(type)
	const base = contract === undefined ? type : contract.base
	switch (base.carrier) {
		case "int2":
		case "int4":
		case "int8":
			return lowerLiteral(cx.names, { kind: "int", value: 0n }, base)
		case "numeric":
		case "money":
			return lit.decimal("0", cx.baseTypeRef(base))
		case "float4":
		case "float8":
			return lowerLiteral(cx.names, { kind: "float", value: 0 }, base)
		case "bool":
			return lit.bool(false)
		case "uuid":
			return lit.text("00000000-0000-0000-0000-000000000000", cx.baseTypeRef(base))
		case "text":
			return lit.text("", cx.baseTypeRef(base))
		case "enum": {
			const handle = base.roster.handles[0]
			if (handle === undefined) {
				return refuse("MalformedDescription", at, "an enum type naming its roster")
			}
			return lowerLiteral(cx.names, { kind: "enum", handle }, base)
		}
		case "range4":
		case "range8":
			return lowerLiteral(cx.names, { kind: "span", start: 0n, end: 1n }, base)
		case "vector":
			return lit.text(
				`[${Array.from({ length: base.typmod.dims }, () => "0").join(",")}]`,
				cx.baseTypeRef(base)
			)
	}
}

/**
 * Closed: the complete declared ground facts of a closed relation as a typed VALUES source.
 *
 *   SELECT DISTINCT r2.c1, r2.c2 FROM (VALUES ('Automatic'::"work"."kind", 1), ...) AS r2(c1, c2)
 *
 * Every value is a typed literal of its column's base type: an enum handle is typed by its roster's enum, a contract
 * payload by its base, because a declared fact was checked against its contract at compile time and a VALUES source is
 * never a refined write. VALUES needs at least one row, so a closed relation without facts is the empty
 * relation `SELECT ... WHERE false` over placeholder rows of its column types; no NULL ever stands for a value.
 *
 * The placeholder is two equal rows, never one. PostgreSQL flattens a one-row VALUES list into constants once its query
 * is pulled up into the one that reads it (an optimized artifact elides the DISTINCT that would prevent that), and then
 * folds every expression over those constants at plan time, before WHERE false discards the row: an expression the
 * placeholder makes fail, `c / 0` over a placeholder 0, would raise although the relation is empty. A list of two rows
 * stays a VALUES scan whose columns are never constants.
 */
const lowerClosed: NodeLowerer<"Closed"> = (node, cx) => {
	const at = nodeLabel(node)
	/** Each row holds a value of its column's type per column (ir/rel.ts closedRows). */
	const rows: ReadonlyArray<ReadonlyArray<Expr>> =
		node.heading.length === 0
			? node.rows.map(() => [lit.bool(true)])
			: closedRows(node).map((row) =>
					row.map(({ column, literal }) => lowerLiteral(cx.names, literal, column.type))
				)
	const empty = rows.length === 0
	const placeholder =
		node.heading.length === 0
			? [lit.bool(true)]
			: node.heading.map((c) => placeholderValue(cx, c.type, at))
	const values = empty ? [placeholder, placeholder] : rows
	const origin = { kind: "node", node: node.id } as const
	const named = outputNames(node.heading).map((name) => ({
		name,
		column: cx.supply.column(origin)
	}))
	const columns = named.map((n) => n.column)
	const alias = cx.relationAlias(origin)
	const item: FromItem = { kind: "values", rows: values, alias, columns }
	const map = new Map<string, Expr>()
	for (const { name, column } of named) {
		map.set(name, { kind: "column", table: alias, column })
	}
	return distinctSelect(headingTargets(node.heading, map), [item], empty ? [lit.bool(false)] : [])
}

/** This kind's entry of the conservative kind table (dispatch.ts). */
export const closedLowering: Lowerers<"Closed"> = { Closed: lowerClosed }
