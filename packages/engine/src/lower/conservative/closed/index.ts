import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { exactParts } from "#compiler/core/decimal.ts"
import { sha256Octets, sha256Text } from "#compiler/core/digest.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import { floatLiteral } from "#compiler/ir/carriers.ts"
import { firstCalendarDate } from "#compiler/ir/date.ts"
import { closedRows, type Heading } from "#compiler/ir/rel.ts"
import { baseOf, type ScalarType } from "#compiler/ir/scalar.ts"
import {
	distinctSelect,
	headingTargets,
	type LowerContext,
	type Lowerers,
	type NodeLowerer,
	outputNames
} from "#compiler/lower/conservative/context.ts"
import { lowerLiteral } from "#compiler/lower/conservative/expr/index.ts"
import { variantRecord } from "#compiler/lower/conservative/expr/variant.ts"
import type { Expr, FromItem, Select } from "#compiler/sql/ast.ts"
import { lit } from "#compiler/sql/build.ts"

/**
 * A value of each column type's SQL type, for the rows an empty VALUES source stands on, which WHERE false discards
 * before any is read (see lowerClosed): its zero, which its type's facts need not admit. A closed id's is the code 0 of
 * its roster's domain, which the domain refuses where 0 is a hole and over the empty roster, whose domain admits no
 * value at all, so no handle's code need stand for it. A variant's is a record of its composite, its base type: its
 * first arm, whose fields are their own placeholders (expr/variant.ts variantRecord), which its domain's CHECK need not
 * admit either. A relation of a variant column stands on placeholders only empty, since no literal is a variant's
 * (ir/expr.ts TypedLiteral): an empty literal relation of a made value (`r.where(r.or([])).find({ value: V.make(…) })`),
 * and a side of a delta no statement makes, which lowers as one (lower/conservative/delta).
 */
const placeholderValue = (cx: LowerContext, type: ScalarType): Expr => {
	const base = baseOf(type)
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
			return lowerLiteral(cx.names, floatLiteral(0), base)
		case "bool":
			return lit.bool(false)
		case "uuid":
			return lit.text("00000000-0000-0000-0000-000000000000", cx.baseTypeRef(base))
		case "date":
			return lowerLiteral(cx.names, { kind: "date", value: firstCalendarDate }, base)
		case "inet":
			return lit.text("0.0.0.0", cx.baseTypeRef(base))
		case "cidr":
			return lit.text("0.0.0.0/0", cx.baseTypeRef(base))
		case "text":
			return lit.text("", cx.baseTypeRef(base))
		case "bytes":
			return lit.text("\\x", cx.baseTypeRef(base))
		case "sha256":
			return lit.text(sha256Text(new Uint8Array(sha256Octets)), cx.baseTypeRef(base))
		case "code":
			return lit.int(0n, cx.baseTypeRef(base))
		case "bits":
			return lowerLiteral(cx.names, { kind: "handles", handles: [] }, base)
		case "range4":
		case "range8":
		case "rangeDate":
			return lowerLiteral(cx.names, { kind: "span", start: 0n, end: 1n }, base)
		case "vector":
			return lit.text(
				`[${Array.from({ length: base.typmod.dims }, () => "0").join(",")}]`,
				cx.baseTypeRef(base)
			)
		case "tsvector":
			return lit.text("", cx.baseTypeRef(base))
		case "variant": {
			const [first] = base.variant.arms
			return variantRecord(
				base.variant,
				first.handle,
				first.fields.map((f) => placeholderValue(cx, f.type)),
				cx.names
			)
		}
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
 * them. A membership of a declared relation's every fact is no source at all: the optimizer's R07 reads it as one
 * binary search of the relation's installed codes (lower/optimize/closed). What stays a source is enumerated from its
 * facts, a VALUES list the planner sees, never unnested from the installed constant. VALUES needs at least one row, so a closed relation without facts is
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
	return valuesRelation(cx, node.heading, rows, node.id)
}

/** The relation of `heading` whose rows are `rows`, a typed VALUES source, or, of no row, the empty relation over two
 * placeholder rows (see lowerClosed). */
const valuesRelation = (
	cx: LowerContext,
	heading: Heading,
	rows: ReadonlyArray<ReadonlyArray<Expr>>,
	node: NodeId
): Select => {
	const placeholder =
		heading.length === 0 ? [lit.bool(true)] : heading.map((c) => placeholderValue(cx, c.type))
	const values: NonEmptyReadonlyArray<ReadonlyArray<Expr>> = isNonEmpty(rows)
		? rows
		: [placeholder, placeholder]
	const origin = { kind: "node", node } as const
	const named = mapNonEmpty(outputNames(heading), (name) => ({
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
	return distinctSelect(
		headingTargets(heading, map),
		[item],
		isNonEmpty(rows) ? [] : [lit.bool(false)]
	)
}

/** The empty relation of the node `node`'s heading, as an empty closed relation lowers: `SELECT ... WHERE false` over
 * two placeholder rows of its column types. */
export const emptyRelation = (cx: LowerContext, heading: Heading, node: NodeId): Select =>
	valuesRelation(cx, heading, [], node)

/** This kind's entry of the conservative kind table (dispatch.ts). */
export const closedLowering: Lowerers<"Closed"> = { Closed: lowerClosed }
