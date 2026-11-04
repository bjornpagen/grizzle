import { isNonEmpty, mapNonEmpty } from "#compiler/core/nonempty.ts"
import { inputSetPlaceholder, type NodeOf, type PlaceholderInput } from "#compiler/ir/rel.ts"
import {
	type ColumnMap,
	distinctSelect,
	headingTargets,
	type LowerContext,
	type Lowerers,
	type NodeLowerer,
	nodeLabel,
	relationColumns
} from "#compiler/lower/conservative/context.ts"
import type { RecordsetSlot, RelationColumn } from "#compiler/lower/conservative/types.ts"
import type { Expr, FromSource } from "#compiler/sql/ast.ts"
import { cast, col, recordset, unitRow } from "#compiler/sql/build.ts"

/**
 * The jsonb placeholder a placeholder input reads, by what fills it: the declared relation parameter its caller binds,
 * or the write's member slot bind fills from the facts the write puts into the slot's relation, which only a write
 * statement has (LowerContext.member).
 */
const placeholderOf = (
	node: NodeOf<"InputSet">,
	input: PlaceholderInput,
	cx: LowerContext,
	allocate: () => ReadonlyArray<RelationColumn>
): RecordsetSlot => {
	switch (input.kind) {
		case "declared":
			return cx.params.relation(input.param, allocate)
		case "member":
			return cx.member(input.slot, input.relation, allocate, nodeLabel(node))
	}
}

/** One cell of a membership's row: the caller's value of a field, cast to its column's base type and collated as it. */
const rowCell = (value: Expr, column: RelationColumn): Expr => {
	const definition = column.definition
	const typed = cast(value, definition.type)
	return definition.collation === undefined
		? typed
		: { kind: "collate", expr: typed, collation: definition.collation }
}

/**
 * The FROM item of an InputSet under a fresh alias, and its columns by heading name: one definition per column of the
 * input, its name and its base type.
 *
 * A declared relation parameter or a write's enumerated member slot is one jsonb recordset over its placeholder:
 *
 *   SELECT DISTINCT r2.c1, r2.c2 FROM jsonb_to_recordset($1::jsonb) AS r2(c1 uuid, c2 bigint)
 *
 * The definition list names base PostgreSQL types (an enum keeps its enum), so no composite type is installed and a
 * contract domain is never applied at the recordset; a text column names COLLATE pg_catalog.pg_c_utf8,
 * like every stored text column, so a recursion seeded from the recordset agrees with its step's collation.
 * The JSON keys are the definition list's generated column names, recorded in the statement's parameter
 * slot so the caller encodes each fact under them; every recordset over one parameter or member slot in a statement
 * shares that placeholder and those keys. The host codec deduplicates the input and refuses null, but the
 * conservative baseline relies on no codec and deduplicates the recordset itself under native equality, where 1.0 and
 * 1.00 are one value.
 *
 * A write filter's membership row is the one-row VALUES of the values its caller names (LowerContext.membershipRow),
 * each cast to its column's base type and collated as the recordset column would be, so the row means what a
 * recordset of its one fact would:
 *
 *   SELECT r2.c1, r2.c2 FROM (VALUES ("t"."doc"::uuid, "t"."user"::text COLLATE pg_catalog.pg_c_utf8)) AS r2(c1, c2)
 *
 * An input of no field is the unit relation, read by the unit marker. PostgreSQL spells neither a recordset nor a VALUES
 * of no column, so a placeholder input of no field is one row of no column per fact, the placeholder's array elements
 * (sql/print.ts), and a row of no field is the derived `(SELECT)`:
 *
 *   SELECT DISTINCT true FROM jsonb_array_elements($1::jsonb) AS r2
 *   SELECT DISTINCT true FROM (SELECT) AS r2
 */
export const inputSetSource = (node: NodeOf<"InputSet">, cx: LowerContext): InputSource => {
	const input = node.input
	return input.kind === "row" ? rowSource(node, cx) : recordsetSource(node, input, cx)
}

/** The FROM item of an InputSet and its columns by heading name. */
interface InputSource {
	readonly item: FromSource
	readonly map: ColumnMap
}

/** The recordset of a placeholder input's placeholder under a fresh alias (see `inputSetSource`). */
const recordsetSource = (
	node: NodeOf<"InputSet">,
	input: PlaceholderInput,
	cx: LowerContext
): InputSource => {
	const origin = { kind: "param", param: inputSetPlaceholder(input) } as const
	const slot = placeholderOf(node, input, cx, () =>
		relationColumns(
			node.heading,
			() => cx.supply.column(origin),
			(type) => cx.baseTypeRef(type)
		)
	)
	const alias = cx.relationAlias(origin)
	return {
		item: recordset(
			slot,
			alias,
			slot.columns.map((c) => c.definition)
		),
		map: new Map(slot.columns.map((c) => [c.name, col(alias, c.definition.name)]))
	}
}

/** The one-row VALUES of a membership's row under a fresh alias, the derived `(SELECT)` for a row of no field (see
 * `inputSetSource`). */
const rowSource = (node: NodeOf<"InputSet">, cx: LowerContext): InputSource => {
	const value = cx.membershipRow(nodeLabel(node))
	const origin = { kind: "node", node: node.id } as const
	const columns = relationColumns(
		node.heading,
		() => cx.supply.column(origin),
		(type) => cx.baseTypeRef(type)
	)
	const alias = cx.relationAlias(origin)
	return {
		item: isNonEmpty(columns)
			? {
					kind: "values",
					rows: [columns.map((c) => rowCell(value(c.name), c))],
					alias,
					columns: mapNonEmpty(columns, (c) => c.definition.name)
				}
			: unitRow(alias),
		map: new Map(columns.map((c) => [c.name, col(alias, c.definition.name)]))
	}
}

const lowerInputSet: NodeLowerer<"InputSet"> = (node, cx) => {
	const { item, map } = inputSetSource(node, cx)
	return distinctSelect(headingTargets(node.heading, map), [item], [])
}

/** This kind's entry of the conservative kind table (dispatch.ts). */
export const inputSetLowering: Lowerers<"InputSet"> = { InputSet: lowerInputSet }
