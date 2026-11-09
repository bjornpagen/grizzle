/**
 * A row's and a group's key texts on the host, as a write's statements and reads carry them: each key field's value
 * admitted in its type's carrier under the installation's codes.
 */
import { admittedParam, carrierSpecOf } from "#compiler/codec/scalar.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { ParamText } from "#compiler/core/wire.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { LawField } from "#compiler/ir/law.ts"
import type { HeadingColumn } from "#compiler/ir/rel.ts"
import type { MemberKey, Owner } from "#compiler/runtime/write/draw.ts"
import { type ColumnKey, fieldKey, type HostEvaluator } from "#compiler/runtime/write/fill.ts"

/** A row's host values by column key: the values a codec admits (scalar/values/identity.ts CarrierHost). */
export type Values = ReadonlyMap<ColumnKey, unknown>

/** A fact of a member relation's slot, as normalization admitted it: its fields' host values by name. */
export type Fact = { readonly [field: string]: unknown }

/** The context the host fills in: the installation's codes and the evaluator of generated fields. */
export interface FillContext {
	readonly codes: Codebook
	readonly evaluate: HostEvaluator
}

/** A type's carrier spec under the installation's codes. */
export const specOf = (ctx: FillContext, type: LawField["type"]) => carrierSpecOf(type, ctx.codes)

/**
 * A host value's parameter text in its type's carrier: a key's, which the read and the delete send and which its
 * relation's rows are a set by, and a count's, written once at its statement; a row's other columns are cells
 * (codec/scalar.ts admittedCell), a bytes value travelling as itself. No text it writes is read back: what PostgreSQL
 * holds comes back through decodeRead, from PostgreSQL's own output.
 */
export const textOf = (ctx: FillContext, type: LawField["type"], value: unknown): ParamText =>
	admittedParam(specOf(ctx, type), value)

/** A fact's values by column key. */
export const valuesOfFact = (fact: Fact): Map<ColumnKey, unknown> =>
	new Map(Object.entries(fact).map(([name, v]) => [fieldKey(name), v] as const))

/** A row's key texts in its layout. */
export const keyOf = (
	ctx: FillContext,
	layout: {
		readonly key: NonEmptyReadonlyArray<{
			readonly key: ColumnKey
			readonly type: LawField["type"]
		}>
	},
	values: Values
): MemberKey => mapNonEmpty(layout.key, (c) => textOf(ctx, c.type, values.get(c.key)))

/** A family by its group alone: each member field with the owner key field it pairs with, in key order, by name and
 * type. A Family is one. */
export interface Grouped {
	readonly group: NonEmptyReadonlyArray<{
		readonly member: HeadingColumn
		readonly owner: HeadingColumn
	}>
}

/** A row's group key texts in a family. */
export const groupOf = (ctx: FillContext, family: Grouped, values: Values): Owner =>
	mapNonEmpty(family.group, (g) => textOf(ctx, g.member.type, values.get(fieldKey(g.member.name))))

/** An owner's group key texts, its key fields paired with the family's group in order. */
export const groupOfOwner = (ctx: FillContext, family: Grouped, values: Values): Owner =>
	mapNonEmpty(family.group, (g) => textOf(ctx, g.owner.type, values.get(fieldKey(g.owner.name))))
