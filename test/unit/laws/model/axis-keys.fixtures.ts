/** What the properties of axis-keys.test.ts read: its spaces, models and helpers. */

import { constant, type Gen, int, map, oneOf } from "@bjornpagen/testing/gen"
import type { ExprDesc, FieldDesc } from "#compiler/ir/desc.ts"
import { accumulated, Bit, bit, drawn, natural } from "#compiler/public/fields.ts"
import {
	closed,
	fin as finOf,
	fold as foldOf,
	Monoid,
	on as onOf,
	ordered as orderedOf,
	relation as relationOf,
	schema
} from "#compiler/public/schema.ts"
import { Numeric } from "#compiler/scalar/values/decimal.ts"
import { alignUp, btreeMaxItemSize, maxAlign, typlens } from "#compiler/schema/representability.ts"
import { succeeded } from "#test/support/assert.ts"
import { codebookOfStates } from "#test/support/closed/generate.ts"
import {
	charLength,
	f,
	fin,
	fold,
	le,
	literal,
	on,
	ordered,
	relation,
	type SchemaDesc,
	value
} from "#test/support/fixtures/ir/desc.ts"
import { Id } from "#test/support/ids.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { ownedInput } from "#test/support/policy.ts"
import { upTo } from "#test/support/up-to.ts"

export type TextType =
	| Readonly<{ kind: "unbounded" }>
	| Readonly<{ kind: "octets"; n: number }>
	| Readonly<{ kind: "code points"; n: number }>

/**
 * The bytes the IndexTupleData header, a uuid (1-aligned) and two bigints (8-aligned), the slot and its successor ‹s›,
 * take in any order of a key's columns, which decides whether the key fits (schema/representability.ts
 * btreeEntryBytes, a function of the column set): each datum after its worst alignment padding, align - 1.
 */
const keyPrefixBytes = 8 + (1 - 1 + typlens.uuid) + 2 * (typlens.int8 - 1 + typlens.int8)

/** The bytes of the entry before the text's data: its prefix, then the text's 4-byte varlena header after its worst
 * padding to 4. */
const textStartBytes = keyPrefixBytes + (4 - 1) + 4

/**
 * The B-tree entry of Line's (doc, at, ‹s›, after) in any order of its columns: its prefix, then the text's varlena
 * header and its longest value, the whole MAXALIGNed.
 */
export const entryBytes = (textBytes: number): number =>
	alignUp(textStartBytes + textBytes, maxAlign)

/** The most text bytes whose entry fits: BTMaxItemSize is itself MAXALIGNed. */
export const fittingBytes = btreeMaxItemSize - textStartBytes

/** UTF-8 encodes a code point in at most 4 bytes. */
const codePointBytes = 4

/** A text type's longest value in UTF-8 bytes, or none for a text of no bound. */
export const bytesOf = (t: TextType): number | undefined => {
	switch (t.kind) {
		case "unbounded":
			return undefined
		case "octets":
			return t.n
		case "code points":
			return t.n * codePointBytes
	}
}

/** The box: the unbounded text, and every bound of either measure whose entry lies within a MAXALIGN step of the bound. */
export const textGen: Gen<TextType> = oneOf<TextType>([
	constant<TextType>({ kind: "unbounded" }),
	map(int(fittingBytes - maxAlign, fittingBytes + maxAlign), (n): TextType => ({
		kind: "octets",
		n
	})),
	map(
		int(
			Math.floor((fittingBytes - maxAlign) / codePointBytes),
			Math.ceil((fittingBytes + maxAlign) / codePointBytes)
		),
		(n): TextType => ({ kind: "code points", n })
	)
])

const octetLength = (arg: ExprDesc): ExprDesc => ({
	kind: "compute",
	fn: "octetLength",
	args: [arg]
})

/** The text of `t`: the wildcard, or the wildcard under a contract bounding its octet_length or char_length. */
const textOf = (t: TextType): FieldDesc => {
	switch (t.kind) {
		case "unbounded":
			return f.wildcard
		case "octets":
			return f.contract("Bounded", f.wildcard, le(octetLength(value), literal(t.n)))
		case "code points":
			return f.contract("Bounded", f.wildcard, le(charLength(value), literal(t.n)))
	}
}

/** Doc's lines in order, and the concat fold of their pieces into Doc.text, every text of `t`. */
export const docSchema = (t: TextType): SchemaDesc => {
	const text = textOf(t)
	return {
		name: "Axis",
		relations: [
			relation("Doc", { id: f.uuid, n: f.drawn, text: f.accumulated(text, "") }, ["id"]),
			relation(
				"Line",
				{
					doc: f.uuid,
					at: f.drawn,
					piece: text,
					before: f.accumulated(text, ""),
					after: f.accumulated(text, "")
				},
				["doc", "at"]
			)
		],
		statements: [
			ordered(on("Line", ["doc", "at"]), fin("Doc", "n")),
			fold(
				fin("Doc", "n"),
				"concat",
				on("Line", ["doc", "piece", "before", "after"]),
				on("Doc", ["id", "text"])
			)
		],
		bases: []
	}
}

type Verdict = "an entry within the bound" | "an entry at the bound" | "an entry past the bound"

export type Feature = Verdict | TextType["kind"]

/** A sum fold's numeric: PostgreSQL's numeric of no typmod, or numeric(precision, scale). */
export type NumericType =
	| Readonly<{ kind: "bare" }>
	| Readonly<{ kind: "precise"; precision: number; scale: number }>

export type NumericFeature = "refused" | "installed"

/** The box: the numeric of no typmod, and numeric(p, 2) at the least and the greatest precisions a field declares. */
export const numericGen: Gen<NumericType> = oneOf<NumericType>([
	constant<NumericType>({ kind: "bare" }),
	map(oneOf([constant(2), constant(1000)]), (precision): NumericType => ({
		kind: "precise",
		precision,
		scale: 2
	}))
])

/**
 * Account(id, n, total) and its ordered family Entry(account, at), whose sum fold steps each entry's `amount` into the
 * account's `total` through its running `before` and `after`, every one of them of the numeric type `t`.
 */
export const sumSchema = (t: NumericType): SchemaDesc => {
	const type = t.kind === "bare" ? f.pg("numeric") : f.numeric(t.precision, t.scale)
	const zero = Numeric.of("0")
	return {
		name: "Ledger",
		relations: [
			relation("Account", { id: f.uuid, n: f.drawn, total: f.accumulated(type, zero) }, ["id"]),
			relation(
				"Entry",
				{
					account: f.uuid,
					at: f.drawn,
					amount: type,
					before: f.accumulated(type, zero),
					after: f.accumulated(type, zero)
				},
				["account", "at"]
			)
		],
		statements: [
			ordered(on("Entry", ["account", "at"]), fin("Account", "n")),
			fold(
				fin("Account", "n"),
				"sum",
				on("Entry", ["account", "amount", "before", "after"]),
				on("Account", ["id", "total"])
			)
		],
		bases: []
	}
}

export const verdictOf = (bytes: number): Verdict => {
	const entry = entryBytes(bytes)
	return entry < btreeMaxItemSize
		? "an entry within the bound"
		: entry === btreeMaxItemSize
			? "an entry at the bound"
			: "an entry past the bound"
}

/**
 * A set an axis carries is its roster's bit(n), n every code the roster has minted, holes included: the law model
 * counts it at its two live handles, and the installation's codes size it exactly (physical/ddl/tables.ts
 * setUniqueBound), so a roster pruned of many handles refuses the UNIQUE when it is compiled rather than at an insert
 * (54000). The box: Tag's codes its two live handles, then every count of holes whose codes lie within a MAXALIGN
 * step's worth of bytes of the most that fit. The oracle: the entry counted by hand, a bit(n)'s varlena header, its
 * 4-byte bit count and a byte per eight codes after Line's (order, at) at their exact offsets.
 */
const Tag = closed.ordered("Tag", ["red", "blue"])

const none = Bit.of(Tag, [])

const Order = relationOf(
	"Order",
	{ id: Id, n: drawn(natural), seen: accumulated(bit(Tag), none) },
	["id"]
)

const Line = relationOf(
	"Line",
	{
		order: Id,
		at: drawn(natural),
		flags: bit(Tag),
		before: accumulated(bit(Tag), none),
		after: accumulated(bit(Tag), none)
	},
	["order", "at"]
)

const lines = orderedOf(onOf(Line, "order", "at"), finOf(Order, "n"))

const seen = foldOf(
	lines,
	Monoid.or,
	onOf(Line, "order", "flags", "before", "after"),
	onOf(Order, "id", "seen")
)

export const owned = succeeded(ownedInput(schema("Holes", [Tag, Order, Line], [lines, seen])))

/** Tag's live handles, which every code count holds. */
export const live = 2

/** Tag's codes: its two live handles, then `holes` removed ones. */
export const codesWith = (holes: number) =>
	codebookOfStates([
		{
			closed: parsedName("Tag"),
			slots: [
				{ kind: "live", handle: "red" },
				{ kind: "live", handle: "blue" },
				...upTo(holes, (i) => ({ kind: "hole" as const, was: `gone${i}` }))
			],
			spellings: { plain: 1 }
		}
	])

/** A bit(n)'s varlena header and its 4-byte bit count, before a byte per eight codes. */
const setHeaderBytes = 4 + typlens.int4

/** A bit(n) of `codes` codes. */
export const setBytes = (codes: number): number => setHeaderBytes + Math.ceil(codes / 8)

/** Line's (order, at, ‹s›, after) entry in any order of its columns: its prefix, then a bit(n) after its worst padding
 * to 4, MAXALIGNed. */
export const entryOf = (codes: number): number =>
	alignUp(keyPrefixBytes + (4 - 1) + setBytes(codes), maxAlign)

/** The most codes whose entry fits: each eight codes take a byte, and BTMaxItemSize is itself MAXALIGNed. */
export const fittingCodes = 8 * (btreeMaxItemSize - (keyPrefixBytes + (4 - 1)) - setHeaderBytes)

export type SetFeature = "an entry within the bound" | "an entry at the bound" | "an entry past it"
