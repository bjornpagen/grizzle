/** What the properties of planned-entries.test.ts read: its spaces, models and helpers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import {
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	weighted
} from "@bjornpagen/testing/gen"
import type { Source } from "@bjornpagen/testing/source"
import { Array as Arr, Option, Order } from "effect"
import type { KeyFault } from "#compiler/core/causes.ts"

import { defined } from "@bjornpagen/testing/assert"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import { Id } from "#test/support/ids.ts"
import {
	octetLengthAtMost,
	rawContract,
	rawPg,
	regex,
	wildcard
} from "#test/support/unit/schema/support.ts"

/** nbtree.h's BTMaxItemSize at the default block, restated: the most bytes one B-tree entry takes. */
const postgresBtreeMaxItem = 2704

/** IndexTupleData's bytes: its heap tuple identifier and its t_info. */
const indexTupleHeader = 8

const maxalign = (n: number): number => Math.ceil(n / 8) * 8

/** A pair's type, the one both its source and its target field are of. */
export type PairType =
	| { readonly kind: "uuid" | "bigint" | "integer" | "smallint" | "boolean" }
	| { readonly kind: "octets"; readonly bytes: number }
	| { readonly kind: "letters"; readonly length: number }
	| { readonly kind: "wildcard" }

/** A datum's longest bytes, its type's alignment, and whether its type is fixed-width or a varlena. */
interface Datum {
	readonly bytes: number
	readonly align: number
	readonly fixed: boolean
}

/** pg_type's typlen and typalign of each fixed type; a varlena's 4-byte header and its longest value, int-aligned; none
 * for the wildcard, which bounds nothing. */
const datumOf = (t: PairType): Datum | undefined => {
	switch (t.kind) {
		case "uuid":
			return { bytes: 16, align: 1, fixed: true }
		case "bigint":
			return { bytes: 8, align: 8, fixed: true }
		case "integer":
			return { bytes: 4, align: 4, fixed: true }
		case "smallint":
			return { bytes: 2, align: 2, fixed: true }
		case "boolean":
			return { bytes: 1, align: 1, fixed: true }
		case "octets":
			return { bytes: 4 + t.bytes, align: 4, fixed: false }
		case "letters":
			return { bytes: 4 + t.length, align: 4, fixed: false }
		case "wildcard":
			return undefined
	}
}

/**
 * Where an index tuple's datums end in any order of them, before MAXALIGN: past its header, each datum after its worst
 * padding, align - 1, a varlena at its longest under its aligned 4-byte header, since every offset past the first
 * datum's depends on the order. Whether an index fits is a function of its column set
 * (schema/representability.ts btreeEntryBytes).
 */
const anyOrderEnd = (datums: ReadonlyArray<Datum>): number =>
	Arr.reduce(datums, indexTupleHeader, (end, d) => end + d.align - 1 + d.bytes)

/** An index's columns: each by its name and type. */
export type IndexColumns = ReadonlyArray<{ readonly name: string; readonly type: PairType }>

/**
 * The fault the model finds in an index over `columns`, every column as itself, or none where it fits in any order of
 * them: the first column of no byte bound, unbounded; else an entry past BTMaxItemSize, by its bytes in any order and
 * each column's datum.
 */
export const faultOf = (columns: IndexColumns): KeyFault | undefined => {
	const own = Arr.map(columns, (c) => ({ name: c.name, datum: datumOf(c.type) }))
	const free = Arr.findFirst(own, (c) => c.datum === undefined)
	if (Option.isSome(free)) {
		return { kind: "unboundedText", field: free.value.name }
	}
	const bounded = Arr.flatMap(own, (c) =>
		c.datum === undefined ? [] : [{ name: c.name, datum: c.datum }]
	)
	const bytes = maxalign(anyOrderEnd(Arr.map(bounded, (b) => b.datum)))
	return bytes > postgresBtreeMaxItem
		? {
				kind: "btreeEntry",
				bytes,
				limit: postgresBtreeMaxItem,
				datums: Arr.map(bounded, (b) => ({ field: b.name, bytes: b.datum.bytes }))
			}
		: undefined
}

interface PlannedSketch {
	/** B's key fields' types, k0 of any type and the rest fixed-width, then its other fields' types, x0…. */
	readonly key: Arr.NonEmptyReadonlyArray<PairType>
	readonly extra: ReadonlyArray<PairType>
	/** B's primary key, its key fields' positions in a drawn order. */
	readonly keyOrder: ReadonlyArray<number>
	/** The target's terms, by their position in B's fields (key fields first): B's key, or a superkey of it. */
	readonly target: { readonly superkey: boolean; readonly order: ReadonlyArray<number> }
	/**
	 * A text planted to bring an index's entry to the item limit plus `delta` bytes: the target's last field where the
	 * target is a superkey, else k0 where it closes B's primary key.
	 */
	readonly boundary: { readonly kind: "none" } | { readonly kind: "at"; readonly delta: number }
}

const fixedGen: Gen<PairType> = map(
	element(["uuid", "bigint", "integer", "smallint", "boolean"] as const),
	(kind): PairType => ({ kind })
)

const typeGen: Gen<PairType> = weighted<PairType>([
	[4, fixedGen],
	[2, map(int(0, 2800), (bytes): PairType => ({ kind: "octets", bytes }))],
	[1, map(int(0, 200), (length): PairType => ({ kind: "letters", length }))],
	[1, constant<PairType>({ kind: "wildcard" })]
])

/** `positions` in an order drawn from `source`. */
const shuffled = (source: Source, positions: ReadonlyArray<number>): ReadonlyArray<number> =>
	Arr.map(
		Arr.sort(
			Arr.map(positions, (position) => ({ position, rank: source.draw(int(0, 0xffff)) })),
			Order.mapInput(Order.Number, (p: { readonly rank: number }) => p.rank)
		),
		(p) => p.position
	)

export const sketchGen: Gen<PlannedSketch> = (source) => {
	const key: Arr.NonEmptyReadonlyArray<PairType> = [
		source.draw(typeGen),
		...Arr.map(indices(source.draw(int(0, 2))), () => source.draw(fixedGen))
	]
	const extra = Arr.map(indices(source.draw(int(0, 3))), () => source.draw(typeGen))
	const superkey = extra.length > 0 && source.draw(boolean)
	const extras = Arr.filter(
		Arr.map(indices(extra.length), (i) => key.length + i),
		() => source.draw(boolean)
	)
	const chosen = superkey
		? [...indices(key.length), ...(extras.length === 0 ? [key.length] : extras)]
		: indices(key.length)
	return {
		key,
		extra,
		keyOrder: shuffled(source, indices(key.length)),
		target: { superkey, order: shuffled(source, chosen) },
		boundary: source.draw(
			oneOf([
				constant<PlannedSketch["boundary"]>({ kind: "none" }),
				map(int(-8, 8), (delta): PlannedSketch["boundary"] => ({ kind: "at", delta }))
			])
		)
	}
}

/**
 * B's fields' types in field order, with the planted text in place where one is planted: the field closing the index
 * the boundary is planted in, sized so that the index's entry is the item limit plus `delta`, where every other column
 * of the index is bounded.
 */
export const typesOf = (s: PlannedSketch): ReadonlyArray<PairType> => {
	const fields: ReadonlyArray<PairType> = [...s.key, ...s.extra]
	const index = s.target.superkey ? s.target.order : s.keyOrder
	const planted = index[index.length - 1]
	if (
		s.boundary.kind === "none" ||
		planted === undefined ||
		(s.target.superkey && planted < s.key.length)
	) {
		return fields
	}
	const others = Arr.map(Arr.take(index, index.length - 1), (p) =>
		datumOf(defined(fields[p], "a field"))
	)
	const datums = Arr.filter(others, (d): d is Datum => d !== undefined)
	if (datums.length < others.length) {
		return fields
	}
	const room = postgresBtreeMaxItem + s.boundary.delta - (anyOrderEnd(datums) + 3 + 4)
	return room < 0
		? fields
		: Arr.map(fields, (t, i): PairType => (i === planted ? { kind: "octets", bytes: room } : t))
}

export const descriptorOf = (t: PairType, i: number): FieldBase => {
	switch (t.kind) {
		case "uuid":
			return Id
		case "bigint":
			return rawPg.bigint
		case "integer":
			return rawPg.integer
		case "smallint":
			return rawPg.smallint
		case "boolean":
			return rawPg.boolean
		case "octets":
			return rawContract(`Octets${i}`, wildcard, octetLengthAtMost(t.bytes))
		case "letters":
			return regex(`^[a-z]{0,${t.length}}$`, "u")
		case "wildcard":
			return wildcard
	}
}

export type PlannedFeature =
	| "target is the declared key"
	| "target is a superkey"
	| "admitted"
	| "declared key refused"
	| "a text no pattern bounds, refused"
	| "target UNIQUE refused, over the limit"
	| "target UNIQUE at the limit, admitted"
