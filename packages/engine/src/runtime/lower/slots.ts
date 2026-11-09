/**
 * What fills each placeholder of a statement under the installation's codes: a declared parameter's text codec or array
 * encoder, a write's member slot's array encoder, a stratum's nested rows' column, or a page fill. A lowered statement
 * holds its placeholders as data (lower/conservative/types.ts ConservativeParamSlot); a template's spec and a loaded
 * write (runtime/write/flight.ts) hold them with these encoders.
 */
import {
	memberArray,
	normalArray,
	positionalColumns,
	type RelationSpec
} from "#compiler/codec/recordset.ts"
import { paramEncoder } from "#compiler/codec/scalar.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { ParamSlot, WriteSlot } from "#compiler/ir/products.ts"
import type {
	ArrayPart,
	DeclaredParamSlot,
	MemberParamSlot,
	PageParamSlot,
	PageStatementSlot,
	RelationColumn,
	WriteParamSlot
} from "#compiler/lower/conservative/types.ts"

/** The spec of a relation input's placeholders over `columns` under the installation's codes, its refusals naming
 * `label`. */
const placeholderSpec = (
	label: string,
	columns: ReadonlyArray<RelationColumn>,
	codes: Codebook
): RelationSpec => ({
	relation: label,
	slot: { kind: "slot", name: label },
	columns: positionalColumns(columns),
	codes
})

/** The position of a placeholder's array among its input's arrays: its column's, or the count's, the only one. */
export const partIndex = (part: ArrayPart): number => (part.kind === "column" ? part.index : 0)

/**
 * What fills a declared parameter's placeholder under the installation's codes, with its encoder: a scalar's text
 * codec, a relation's array encoder over the placeholder's columns (codec/recordset.ts normalArray), which writes the
 * array at its part of the parameter's input, normalized once per execution.
 */
export const declaredSlotOf =
	(codes: Codebook) =>
	(slot: DeclaredParamSlot): Extract<ParamSlot, { readonly kind: "scalar" | "relation" }> => {
		switch (slot.kind) {
			case "scalar":
				return {
					kind: "scalar",
					param: slot.param,
					encode: paramEncoder(slot.type, slot.param, codes)
				}
			case "relation":
				return {
					kind: "relation",
					param: slot.param,
					part: partIndex(slot.part),
					encode: normalArray(placeholderSpec(slot.param, slot.columns, codes))
				}
		}
	}

/**
 * What fills a member slot's placeholder, with its array encoder over the slot's normal facts: the host normalized them
 * already, so it writes the array at its part of their rows in its column order and refuses no same-key pair.
 */
const memberSlotOf = (
	slot: MemberParamSlot,
	codes: Codebook
): Extract<ParamSlot, { readonly kind: "member" }> => ({
	kind: "member",
	slot: slot.slot,
	part: partIndex(slot.part),
	encode: memberArray(placeholderSpec(slot.relation, slot.columns, codes))
})

/**
 * What fills a page placeholder: its fill, with no encoder, since the page runtime binds a limit or a size, a
 * `$n::bigint`, as a bigint's decimal digits, and a boundary as the text its cursor carried (adapter/page/execute.ts).
 */
const pageSlotOf = (slot: PageParamSlot): Extract<ParamSlot, { readonly kind: "page" }> => ({
	kind: "page",
	fill: slot.fill
})

/** What fills a write statement's placeholder under the installation's codes: a declared parameter's or a member
 * slot's, with its encoder, or a column of a stratum's nested rows, which the binding encodes. */
export const writeSlotOf =
	(codes: Codebook) =>
	(slot: WriteParamSlot): WriteSlot => {
		switch (slot.kind) {
			case "member":
				return memberSlotOf(slot, codes)
			case "nestedRows":
				return {
					kind: "nestedRows",
					stratum: slot.stratum,
					relation: slot.relation,
					part: partIndex(slot.part)
				}
			case "scalar":
			case "relation":
				return declaredSlotOf(codes)(slot)
		}
	}

/** What fills a page statement's placeholder under the installation's codes: a declared parameter's, with its
 * encoder, or a page fill. */
export const pageStatementSlotOf =
	(codes: Codebook) =>
	(slot: PageStatementSlot): ParamSlot =>
		slot.kind === "page" ? pageSlotOf(slot) : declaredSlotOf(codes)(slot)
