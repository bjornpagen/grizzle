/** What the properties of rows.test.ts read: its spaces, models and helpers. */

import { boolean, element } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import { f } from "#test/support/fixtures/ir/desc.ts"

/** A column kind with its pg_type storage: typlen and typalign in bytes, or a varlena held as a TOAST pointer. */
interface Kind {
	readonly name: "int2" | "int4" | "int8" | "bool" | "uuid" | "closed id" | "text"
	readonly desc: FieldDesc
	readonly storage: { readonly typlen: number; readonly typalign: number } | "varlena"
}

export const int8: Kind = { name: "int8", desc: f.bigint, storage: { typlen: 8, typalign: 8 } }

export const uuidKind: Kind = { name: "uuid", desc: f.uuid, storage: { typlen: 16, typalign: 1 } }

/** The kinds a stored relation's field may have here: every kind but the closed id, whose roster no schema here holds. */
export const storedKinds: Arr.NonEmptyReadonlyArray<Kind> = [
	{ name: "int2", desc: f.smallint, storage: { typlen: 2, typalign: 2 } },
	{ name: "int4", desc: f.integer, storage: { typlen: 4, typalign: 4 } },
	int8,
	{ name: "bool", desc: f.boolean, storage: { typlen: 1, typalign: 1 } },
	uuidKind,
	{ name: "text", desc: f.wildcard, storage: "varlena" }
]

const kinds: Arr.NonEmptyReadonlyArray<Kind> = [
	...storedKinds,
	{ name: "closed id", desc: f.closedId("R"), storage: { typlen: 2, typalign: 2 } }
]

export interface Column {
	readonly kind: Kind
	readonly nullable: boolean
}

export const columnGen = (source: Parameters<typeof boolean>[0]): Column => ({
	kind: element(kinds)(source),
	nullable: boolean(source)
})

/** The checker's size of a row: heaptuple.c's header and data area, by pg_type's catalog. */
export const specified = (columns: ReadonlyArray<Column>): number => {
	const align = (n: number, a: number): number => Math.ceil(n / a) * a
	const hasNull = Arr.some(columns, (c) => c.nullable)
	const hoff = align(23 + (hasNull ? Math.ceil(columns.length / 8) : 0), 8)
	const ordered = Arr.sort(columns, (a: Column, b: Column) => {
		const alignOf = (c: Column) => (c.kind.storage === "varlena" ? 1 : c.kind.storage.typalign)
		return alignOf(b) - alignOf(a) > 0 ? 1 : alignOf(b) - alignOf(a) < 0 ? -1 : 0
	})
	return Arr.reduce(ordered, hoff, (offset, c) =>
		c.kind.storage === "varlena"
			? offset + 18
			: align(offset, c.kind.storage.typalign) + c.kind.storage.typlen
	)
}

export type Feature = "a NULL-able column" | "a varlena" | "mixed alignments" | "no column"

export const features: Arr.NonEmptyReadonlyArray<Feature> = [
	"a NULL-able column",
	"a varlena",
	"mixed alignments",
	"no column"
]

/** Where a relation's row falls against MaxHeapTupleSize, and what its other fields hold. */
export type BoundFeature =
	| "within the bound"
	| "at the bound"
	| "past the bound"
	| "a varlena"
	| "mixed alignments"
