/**
 * The compile side of a nesting's fill (runtime/write/fill.ts): where a nesting's walk starts, and the base of a copy a
 * family's edit carries along an axis.
 */
import { baseLiteral, type Family, isTreeOf } from "#compiler/ir/family.ts"
import type { FillPosition } from "#compiler/ir/fill.ts"
import type { NativeColumn } from "#compiler/ir/law.ts"
import { literalHost } from "#compiler/runtime/write/fill.ts"
import type { CarrierSpec } from "#compiler/scalar/values/identity.ts"

/** Where a walk of a nesting of `relation` starts its root: a tree's root where `relation` is a tree's, else the
 * ChangeSet's own row. */
export const walkStart = (families: ReadonlyArray<Family>, relation: string): FillPosition => {
	const tree = families.find((f) => isTreeOf(f, relation))
	return tree === undefined ? { kind: "top" } : { kind: "root", family: tree }
}

/**
 * The base of a copy carried along an axis of `family` as a host value of `spec`'s carrier: an accumulated field's
 * start, a hidden before's plane identity; none for a column that is neither.
 */
export const baseOf = (
	family: Family,
	column: NativeColumn,
	spec: CarrierSpec
): { readonly kind: "base"; readonly value: unknown } | { readonly kind: "none" } => {
	const base = baseLiteral(family, column)
	return base === undefined ? { kind: "none" } : { kind: "base", value: literalHost(spec, base) }
}
