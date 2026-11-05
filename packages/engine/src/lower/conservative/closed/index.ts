import { exactParts } from "#compiler/core/decimal.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { canonicalZero } from "#compiler/ir/carriers.ts"
import { closedRows } from "#compiler/ir/rel.ts"
import { contractOf, type ScalarType } from "#compiler/ir/scalar.ts"
import {
	distinctSelect,
	headingTargets,
	type LowerContext,
	type Lowerers,
	type NodeLowerer,
	outputNames
} from "#compiler/lower/conservative/context.ts"
import { lowerLiteral } from "#compiler/lower/conservative/expr/index.ts"
import type { Expr, FromItem } from "#compiler/sql/ast.ts"
import { lit } from "#compiler/sql/build.ts"

/** A value of every admitted type, for the one row an empty VALUES source stands on; WHERE false discards it. */
const placeholderValue = (cx: LowerContext, type: ScalarType): Expr => {
	const contract = contractOf(type)
	const base = contract === undefined ? type : contract.base
	switch (base.carrier) {
		case "int2":
		case "int4":
		case "int8":
			return lowerLiteral(cx.names, { kind: "int", value: 0n }, base)
		case "numeric":
		case "money":
		case "exactInteger":
		case "exactMoney":
			return lit.decimal(exactParts(0n, 0), cx.baseTypeRef(base))
		case "float4":
		case "float8":
			return lowerLiteral(cx.names, { kind: "float", value: canonicalZero(0) }, base)
		case "bool":
			return lit.bool(false)
		case "uuid":
			return lit.text("00000000-0000-0000-0000-000000000000", cx.baseTypeRef(base))
		case "text":
			return lit.text("", cx.baseTypeRef(base))
		case "code":
			return lowerLiteral(cx.names, { kind: "handle", handle: base.roster.handles[0] }, base)
		case "bits":
			return lowerLiteral(cx.names, { kind: "handles", handles: [] }, base)
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
 *   SELECT DISTINCT r2.c1, r2.c2 FROM (VALUES (0::smallint, 1), ...) AS r2(c1, c2)
 *
 * Every value is a typed literal of its column's base type: a handle is its code under the installation's codebook, a
 * smallint, and a contract payload is typed by its base, because a declared fact was checked against its contract at
 * compile time and a VALUES source is never a refined write. The rows are the node's own, which the optimizer may have
 * narrowed from a declared closed relation's (simplify/rules.ts finiteFold), so no installed constant need stand for
 * them. A membership of a declared relation's every fact is no source at all: the optimizer's R07 reads it as one bit
 * of the relation's installed key set (lower/optimize/closed). What stays a source is enumerated from its facts, never
 * from the installed constant by generate_series over the key space filtered by its cells: the key space is the
 * product of the key fields' radices, holes included, and a sparse relation fills little of it, as qti-pie's
 * ChildGrammar fills 77,734 of its 819,200 cells. VALUES needs at least one row, so a closed relation without facts is
 * the empty relation `SELECT ... WHERE false` over placeholder rows of its column types; no NULL ever stands for a
 * value.
 *
 * The placeholder is two equal rows, never one. PostgreSQL flattens a one-row VALUES list into constants once its query
 * is pulled up into the one that reads it (an optimized artifact elides the DISTINCT that would prevent that), and then
 * folds every expression over those constants at plan time, before WHERE false discards the row: a placeholder need
 * not have its column type's facts, so `x / c` over a placeholder 0 of a contract proved nonzero would raise although
 * the relation is empty. A list of two rows stays a VALUES scan whose columns are never constants.
 */
const lowerClosed: NodeLowerer<"Closed"> = (node, cx) => {
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
			: node.heading.map((c) => placeholderValue(cx, c.type))
	const values: NonEmptyReadonlyArray<ReadonlyArray<Expr>> = isNonEmpty(rows)
		? rows
		: [placeholder, placeholder]
	const origin = { kind: "node", node: node.id } as const
	const named = mapNonEmpty(outputNames(node.heading), (name) => ({
		name,
		column: cx.supply.column(origin)
	}))
	const columns = mapNonEmpty(named, (n) => n.column)
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
