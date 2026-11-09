import { describe, it } from "@effect/vitest"
import { type Case, exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { constant, type Gen, int, map, oneOf } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { alignUp, maxAlign, typlens } from "#compiler/core/limits.ts"
import type { ExprDesc, FieldDesc } from "#compiler/ir/desc.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { accumulated, Bits, bits, drawn, natural, uuid } from "#compiler/public/fields.ts"
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
import { installationsOf } from "#compiler/schema/own.ts"
import { btreeMaxItemSize } from "#compiler/schema/representability.ts"
import { assert, refused, succeeded } from "#test/support/assert.ts"
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
import { parsedName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { ownedInput } from "#test/support/policy.ts"

/**
 * A family axis's key is a key like any declared one (laws/model/plan.ts #axis): the UNIQUE its predecessor and last
 * axes reference, Line's (doc, at, after) for a concat fold that carries its running text `after` along them, fits a
 * B-tree entry for every value its columns admit, or the schema is refused when it compiles with UnrepresentableKey at
 * the fold, over that UNIQUE, where PostgreSQL would refuse the first write that outgrew it (54000).
 *
 * The box: the fold's text, its pieces and accumulators one type, of no bound, or bounded by a contract to at most n
 * bytes, or to at most n code points of 4 bytes each, with n every bound whose entry lies within one MAXALIGN step of
 * BTMaxItemSize on either side. The oracle: the B-tree entry nbtree.h bounds, counted by hand from the columns' layouts
 * as schema/representability.ts documents the count (entryBytes), refused exactly past BTMaxItemSize, and an unbounded
 * text refused whatever its entry.
 */
type TextType =
	| Readonly<{ kind: "unbounded" }>
	| Readonly<{ kind: "octets"; n: number }>
	| Readonly<{ kind: "code points"; n: number }>

/** The bytes the IndexTupleData header, a uuid and a bigint aligned to 8 take, at exact offsets since no varlena or
 * NULL comes before them. */
const keyPrefixBytes = alignUp(8 + typlens.uuid.value, typlens.int8.value) + typlens.int8.value

/** The bytes of the entry before the text's data: its prefix, aligned to 4 for the text, and the text's varlena header. */
const textStartBytes = alignUp(keyPrefixBytes, 4) + 4

/**
 * The B-tree entry of Line's (doc, at, after) as index_form_tuple lays it out: its prefix, then the text's 4-byte
 * varlena header and its longest value aligned to 4, the whole MAXALIGNed.
 */
const entryBytes = (textBytes: number): number =>
	alignUp(textStartBytes + textBytes, maxAlign.value)

/** The most text bytes whose entry fits: BTMaxItemSize is itself MAXALIGNed. */
const fittingBytes = btreeMaxItemSize.value - textStartBytes

/** UTF-8 encodes a code point in at most 4 bytes. */
const codePointBytes = 4

/** A text type's longest value in UTF-8 bytes, or none for a text of no bound. */
const bytesOf = (t: TextType): number | undefined => {
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
const textGen: Gen<TextType> = oneOf<TextType>([
	constant<TextType>({ kind: "unbounded" }),
	map(int(fittingBytes - maxAlign.value, fittingBytes + maxAlign.value), (n): TextType => ({
		kind: "octets",
		n
	})),
	map(
		int(
			Math.floor((fittingBytes - maxAlign.value) / codePointBytes),
			Math.ceil((fittingBytes + maxAlign.value) / codePointBytes)
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
const docSchema = (t: TextType): SchemaDesc => {
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
		extends: undefined
	}
}

type Verdict = "an entry within the bound" | "an entry at the bound" | "an entry past the bound"
type Feature = Verdict | TextType["kind"]

const verdictOf = (bytes: number): Verdict => {
	const entry = entryBytes(bytes)
	return entry < btreeMaxItemSize.value
		? "an entry within the bound"
		: entry === btreeMaxItemSize.value
			? "an entry at the bound"
			: "an entry past the bound"
}

describe("a family axis's key", () => {
	it.effect(
		"fits a B-tree entry for every value of the accumulators it carries, or is refused as UnrepresentableKey",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/laws/model/axis-keys",
						oracle: {
							kind: "specification",
							name: "nbtree.h's BTMaxItemSize over the entry counted from the columns' layouts"
						},
						box: "a concat fold's text of no bound, or of a byte or code point bound whose entry is within a MAXALIGN step of BTMaxItemSize",
						generator: textGen,
						literal: Formatter.format,
						/** The space: the unbounded text, 17 byte bounds and 5 code point bounds. */
						limit: 23,
						coverage: requiredInSpace<Feature>([
							"unbounded",
							["octets", "an entry within the bound"],
							["octets", "an entry at the bound"],
							["octets", "an entry past the bound"],
							["code points", "an entry within the bound"],
							["code points", "an entry at the bound"],
							["code points", "an entry past the bound"]
						]),
						caseHang
					},
					(t: TextType, c: Case<Feature>) =>
						Effect.sync(() => {
							const desc = docSchema(t)
							const owned = succeeded(ownedInput(desc))
							const compiled = compileInstallation(owned, installOptions(owned, "owner"))
							const bytes = bytesOf(t)
							if (bytes === undefined) {
								c.note("unbounded")
							} else {
								c.pair(t.kind, verdictOf(bytes))
							}
							if (bytes !== undefined && entryBytes(bytes) <= btreeMaxItemSize.value) {
								succeeded(compiled, `an entry of ${entryBytes(bytes)} bytes fits`)
								return
							}
							const reason = refused(compiled, "UnrepresentableKey").reason
							if (reason._tag !== "UnrepresentableKey") {
								return assert.fail("an UnrepresentableKey reason")
							}
							const foldAt = Arr.findFirstIndex(desc.statements, (s) => s.kind === "fold")
							assert.deepEqual(
								reason.at.path,
								["statements", ...Option.toArray(foldAt)],
								"the refusal is the fold's"
							)
							assert.deepEqual(
								reason.key,
								["doc", "at", "after"],
								"the UNIQUE Line's axes reference"
							)
							assert.deepEqual(
								reason.fault,
								bytes === undefined
									? { kind: "unboundedText", field: "after" }
									: {
											kind: "btreeEntry",
											bytes: entryBytes(bytes),
											limit: btreeMaxItemSize.value,
											datums: [
												{ field: "doc", bytes: typlens.uuid.value },
												{ field: "at", bytes: typlens.int8.value },
												{ field: "after", bytes: 4 + bytes }
											]
										}
							)
						})
				)
			)
	)
})

describe("a carried set's key", () => {
	/**
	 * A set an axis carries is its roster's bit(n), n every code the roster has minted, holes included: the law model
	 * counts it at its two live handles, and the installation's codes size it exactly (physical/ddl/tables.ts
	 * setUniqueBound), so a roster pruned of many handles refuses the UNIQUE when it is compiled rather than at an insert
	 * (54000). The box: Tag's codes its two live handles, then every count of holes whose codes lie within a MAXALIGN
	 * step's worth of bytes of the most that fit. The oracle: the entry counted by hand, a bit(n)'s varlena header, its
	 * 4-byte bit count and a byte per eight codes after Line's (order, at) at their exact offsets.
	 */
	const Tag = closed("Tag", ["red", "blue"])
	const none = Bits.of(Tag, [])
	const Order = relationOf(
		"Order",
		{ id: uuid, n: drawn(natural), seen: accumulated(bits(Tag), none) },
		["id"]
	)
	const Line = relationOf(
		"Line",
		{
			order: uuid,
			at: drawn(natural),
			flags: bits(Tag),
			before: accumulated(bits(Tag), none),
			after: accumulated(bits(Tag), none)
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
	const owned = succeeded(ownedInput(schema("Holes", { Tag, Order, Line }, [lines, seen])))

	/** Tag's live handles, which every code count holds. */
	const live = 2

	/** Tag's codes: its two live handles, then `holes` removed ones. */
	const codesWith = (holes: number) =>
		codebookOfStates([
			{
				closed: parsedName("Tag"),
				slots: [
					{ kind: "live", handle: "red" },
					{ kind: "live", handle: "blue" },
					...Arr.makeBy(holes, (i) => ({ kind: "hole" as const, was: `gone${i}` }))
				],
				spellings: { plain: 1 }
			}
		])

	/** A bit(n)'s varlena header and its 4-byte bit count, before a byte per eight codes. */
	const setHeaderBytes = 4 + typlens.int4.value

	/** A bit(n) of `codes` codes. */
	const setBytes = (codes: number): number => setHeaderBytes + Math.ceil(codes / 8)

	/** Line's (order, at, after) entry: its prefix, a bit(n) aligned to 4, MAXALIGNed. */
	const entryOf = (codes: number): number =>
		alignUp(alignUp(keyPrefixBytes, 4) + setBytes(codes), maxAlign.value)

	/** The most codes whose entry fits: each eight codes take a byte, and BTMaxItemSize is itself MAXALIGNed. */
	const fittingCodes = 8 * (btreeMaxItemSize.value - alignUp(keyPrefixBytes, 4) - setHeaderBytes)

	type SetFeature = "an entry within the bound" | "an entry at the bound" | "an entry past it"

	it.effect("is sized by its roster's codes, holes included, and refused past the bound", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/laws/model/axis-set-keys",
					oracle: {
						kind: "specification",
						name: "VARBITTOTALLEN and nbtree.h's BTMaxItemSize, counted by hand"
					},
					box: "Tag's two live handles and every count of holes within eight codes of the most that fit",
					generator: int(fittingCodes - live - 8, fittingCodes - live + 8),
					literal: Formatter.format,
					limit: 17,
					coverage: requiredInSpace<SetFeature>(["an entry at the bound", "an entry past it"]),
					caseHang
				},
				(holes: number, c: Case<SetFeature>) =>
					Effect.sync(() => {
						const codes = live + holes
						const compiled = compileInstallation(owned, {
							...completeInstallOptions(owned, installationsOf(owned), [], [], codesWith(holes)),
							owner: "owner"
						})
						const bytes = entryOf(codes)
						if (bytes <= btreeMaxItemSize.value) {
							succeeded(compiled, `${holes} holes: an entry of ${bytes} bytes fits`)
							c.note(
								bytes === btreeMaxItemSize.value
									? "an entry at the bound"
									: "an entry within the bound"
							)
							return
						}
						const reason = refused(compiled, "UnrepresentableKey").reason
						if (reason._tag !== "UnrepresentableKey") {
							return assert.fail("an UnrepresentableKey reason")
						}
						assert.deepEqual(reason.fault, {
							kind: "btreeEntry",
							bytes,
							limit: btreeMaxItemSize.value,
							datums: [
								{ field: "order", bytes: typlens.uuid.value },
								{ field: "at", bytes: typlens.int8.value },
								{ field: "after", bytes: setBytes(codes) }
							]
						})
						c.note("an entry past it")
					})
			)
		)
	)
})
