/**
 * A group's key texts on the host, as a write's statements carry them: each key field's value admitted in its type's
 * carrier under the installation's codes.
 */
import { carrierSpecOf, paramOfText } from "#compiler/codec/scalar.ts"
import { type TextsId, textsId } from "#compiler/core/text.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import { columnKeyOf } from "#compiler/ir/law.ts"
import type { HeadingColumn } from "#compiler/ir/rel.ts"
import {
	type Cells,
	type ColumnIndex,
	type Columns,
	type Texts,
	textAt
} from "#compiler/runtime/write/cells.ts"
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
 * type, those the host reads (runtime/write/bind.ts freshOwners). A Family is one. */
export interface Grouped {
	readonly group: ReadonlyArray<{
		readonly member: HeadingColumn
		readonly owner: HeadingColumn
	}>
}

/** Which side of a family's group a row stands on: a member's group fields, or its owner's key fields, each pair's. */
export type GroupSide = "member" | "owner"

/**
 * The reader of a row's group in a family, its group key texts keyed (core/text.ts TextsId), in the order the
 * family's group fields pair with them, from the side `side` names, a row of that side's relation, whose columns are
 * `columns`, its cells and the texts the write holds of them (cells.ts textAt): each group field's position among them
 * and its carrier's spec under the installation's codes, worked out once per family, so reading a row's group costs
 * its fields' texts the write holds none of, and one key.
 */
export const groupReader = (
	ctx: FillContext,
	family: Grouped,
	side: GroupSide,
	columns: Columns
): ((values: Cells, texts: Texts) => TextsId) => {
	const fields = family.group.map((g) => {
		const field = g[side]
		return { at: columns.at(columnKeyOf(field.name)), spec: carrierSpecOf(field.type, ctx.codes) }
	})
	return (values, texts) =>
		textsId(fields.map((f) => paramOfText(f.spec, textAt(values, texts, f.at, f.spec))))
}
