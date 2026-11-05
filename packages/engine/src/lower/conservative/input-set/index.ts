import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { inputSetPlaceholder, type NodeOf, type PlaceholderInput } from "#compiler/ir/rel.ts"
import {
	arraysSource,
	type ColumnMap,
	distinctSelect,
	headingTargets,
	type LowerContext,
	type Lowerers,
	type NodeLowerer,
	nodeLabel,
	relationColumns
} from "#compiler/lower/conservative/context.ts"
import type { ArraySlot, RelationColumn } from "#compiler/lower/conservative/types.ts"
import type { Expr, FromSource } from "#compiler/sql/ast.ts"
import { arrays, cast, col, unitRow } from "#compiler/sql/build.ts"

/**
 * The array placeholders a placeholder input reads, by what fills them: the declared relation parameter its caller
 * binds, or the write's member slot bind fills from the facts the write puts into the slot's relation, which only a
 * write statement has (LowerContext.member).
 */
const placeholdersOf = (
	node: NodeOf<"InputSet">,
	input: PlaceholderInput,
	cx: LowerContext,
	allocate: () => ReadonlyArray<RelationColumn>
): NonEmptyReadonlyArray<ArraySlot> => {
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
 * The FROM item of an InputSet under a fresh alias, and its columns by heading name: one array per column of the
 * input, its name and its base type.
 *
 * A declared relation parameter or a write's enumerated member slot is the rows of its arrays, one array placeholder
 * per column, read in lockstep in the select-list form (sql/print.ts):
 *
 *   SELECT DISTINCT r2.c1, r2.c2 FROM (SELECT pg_catalog.unnest($1::uuid[]) AS c1,
 *     pg_catalog.unnest($2::bigint[]) AS c2) AS r2
 *
 * Each array's element type is its column's base type (a closed id's smallint code), so no composite type is installed and
 * a contract domain is never applied at the input; a text column's array is collated pg_catalog.pg_c_utf8, like every
 * stored text column, so a recursion seeded from the input agrees with its step's collation, and a column whose type
 * has a typmod is cast back to it. The arrays' columns are the generated names of the input's columns, recorded in the
 * statement's slots, and every read of one parameter or member slot in a statement reads the same placeholders. The
 * host codec deduplicates the input and refuses null, but the conservative baseline relies on no codec and
 * deduplicates the input itself under native equality, where 1.0 and 1.00 are one value.
 *
 * A write filter's membership row is the one-row VALUES of the values its caller names (LowerContext.membershipRow),
 * each cast to its column's base type and collated as the input's column would be, so the row means what an input of
 * its one fact would:
 *
 *   SELECT r2.c1, r2.c2 FROM (VALUES ("t"."doc"::uuid, "t"."user"::text COLLATE pg_catalog.pg_c_utf8)) AS r2(c1, c2)
 *
 * An input of no field is the unit relation, read by the unit marker. PostgreSQL spells neither an array nor a VALUES
 * of no column, so a placeholder input of no field is one row of no column per fact, the generated series of its count
 * (sql/print.ts), and a row of no field is the derived `(SELECT)`:
 *
 *   SELECT DISTINCT true FROM pg_catalog.generate_series(1::bigint, $1::bigint) AS r2
 *   SELECT DISTINCT true FROM (SELECT) AS r2
 */
export const inputSetSource = (node: NodeOf<"InputSet">, cx: LowerContext): InputSource => {
	const input = node.input
	return input.kind === "row" ? rowSource(node, cx) : arraysOf(node, input, cx)
}

/** The FROM item of an InputSet and its columns by heading name. */
interface InputSource {
	readonly item: FromSource
	readonly map: ColumnMap
}

/** The arrays of a placeholder input's placeholders under a fresh alias (see `inputSetSource`). */
const arraysOf = (
	node: NodeOf<"InputSet">,
	input: PlaceholderInput,
	cx: LowerContext
): InputSource => {
	const origin = { kind: "param", param: inputSetPlaceholder(input) } as const
	const slots = placeholdersOf(node, input, cx, () =>
		relationColumns(
			node.heading,
			() => cx.supply.column(origin),
			(type) => cx.baseTypeRef(type)
		)
	)
	const alias = cx.relationAlias(origin)
	return {
		item: arrays(arraysSource(slots), alias),
		map: new Map(slots[0].columns.map((c) => [c.name, col(alias, c.definition.name)]))
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
