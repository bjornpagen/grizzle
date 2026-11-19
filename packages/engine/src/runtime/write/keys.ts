/**
 * A group's key texts on the host, as a write's statements carry them: each key field's value admitted in its type's
 * carrier under the installation's codes.
 */
import { admittedParam, carrierSpecOf } from "#compiler/codec/scalar.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import { columnKeyOf } from "#compiler/ir/law.ts"
import type { HeadingColumn } from "#compiler/ir/rel.ts"
import type { Cells, ColumnIndex, Columns } from "#compiler/runtime/write/cells.ts"
import type { Owner } from "#compiler/runtime/write/draw.ts"
import type { HostEvaluator } from "#compiler/runtime/write/fill.ts"

/** A fact of a member relation's slot, as normalization admitted it: its fields' host values by name. */
export type Fact = { readonly [field: string]: unknown }

/** The context the host fills in: the installation's codes, the evaluator of generated fields, and the write's column
 * index (cells.ts ColumnIndex), which every row of the write is laid out by. */
export interface FillContext {
	readonly codes: Codebook
	readonly evaluate: HostEvaluator
	readonly columns: ColumnIndex
}

/** A family by its group alone: each member field with the owner key field it pairs with, in key order, by name and
 * type. A Family is one. */
export interface Grouped {
	readonly group: NonEmptyReadonlyArray<{
		readonly member: HeadingColumn
		readonly owner: HeadingColumn
	}>
}

/** Which side of a family's group a row stands on: a member's group fields, or its owner's key fields, each pair's. */
export type GroupSide = "member" | "owner"

/**
 * The reader of a row's group key texts in a family, from the side `side` names, a row of that side's relation, whose
 * columns are `columns`: each group field's position among them and its carrier's spec under the installation's codes,
 * worked out once per family, so reading a row's group costs its fields' texts and no more.
 */
export const groupReader = (
	ctx: FillContext,
	family: Grouped,
	side: GroupSide,
	columns: Columns
): ((values: Cells) => Owner) => {
	const fields = mapNonEmpty(family.group, (g) => {
		const field = g[side]
		return { at: columns.at(columnKeyOf(field.name)), spec: carrierSpecOf(field.type, ctx.codes) }
	})
	return (values) => mapNonEmpty(fields, (f) => admittedParam(f.spec, values[f.at]))
}
