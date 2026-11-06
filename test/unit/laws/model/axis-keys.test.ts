import { describe, it } from "@effect/vitest"
import { type Case, exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { alignUp, maxAlign, typlens } from "#compiler/core/limits.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { accumulated, Bits, bits, drawn, natural, uuid } from "#compiler/public/fields.ts"
import {
	closed,
	fin,
	fold,
	Monoid,
	on,
	ordered,
	relation,
	schema
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { btreeMaxItemSize } from "#compiler/schema/representability.ts"
import { assert, refused, succeeded } from "#test/support/assert.ts"
import { codebookOfStates } from "#test/support/closed/generate.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { ownedInput } from "#test/support/policy.ts"

/**
 * A family axis's key is a key like any declared one (laws/model/plan.ts #axis): the UNIQUE its predecessor and last
 * axes reference, Line's (doc, at, after) for a `Monoid.concat` fold that carries its running text `after` along them,
 * fits a B-tree entry for every value its columns admit, or the schema is refused when it compiles with
 * UnrepresentableKey, naming the UNIQUE, the family and the fold, where PostgreSQL would refuse the first write that
 * outgrew it (54000).
 *
 * The box: the fold's text, its pieces and accumulators one type, of no bound (`^.*$`), of at most 64 code points of 4
 * bytes, or of at most 2,805 ASCII letters. The oracle: the B-tree entry nbtree.h bounds, counted by hand from the
 * columns' layouts as schema/representability.ts documents the count (entryBytes), refused exactly past BTMaxItemSize,
 * and an unbounded text refused whatever its entry.
 */
interface TextType {
	readonly name: "unbounded" | "64 code points" | "2,805 letters"
	/** Its longest value in UTF-8 bytes; none for a pattern of no bound. */
	readonly bytes: number | undefined
}

const types: Arr.NonEmptyReadonlyArray<TextType> = [
	{ name: "unbounded", bytes: undefined },
	{ name: "64 code points", bytes: 64 * 4 },
	{ name: "2,805 letters", bytes: 255 * 11 }
]

/** The text type of `t`, its pattern a literal the type checker admits. */
const textOf = (t: TextType) => {
	switch (t.name) {
		case "unbounded":
			return str.regex("^.*$", "su")
		case "64 code points":
			return str.regex("^.{0,64}$", "su")
		case "2,805 letters":
			return str.regex(
				"^[a-z]{0,255}[a-z]{0,255}[a-z]{0,255}[a-z]{0,255}[a-z]{0,255}[a-z]{0,255}[a-z]{0,255}[a-z]{0,255}[a-z]{0,255}[a-z]{0,255}[a-z]{0,255}$"
			)
	}
}

/**
 * The B-tree entry of Line's (doc, at, after) as index_form_tuple lays it out: the IndexTupleData header, a uuid aligned
 * to 1, a bigint aligned to 8, both at exact offsets since no varlena or NULL comes before them, then the text's 4-byte
 * varlena header and its longest value aligned to 4, the whole MAXALIGNed.
 */
const entryBytes = (textBytes: number): number => {
	const header = 8
	const doc = header + typlens.uuid.value
	const at = alignUp(doc, typlens.int8.value) + typlens.int8.value
	return alignUp(alignUp(at, 4) + 4 + textBytes, maxAlign.value)
}

/** The bytes the refusal counts each of Line's (doc, at, after) at, a text's with its 4-byte varlena header. */
const datumsOf = (textBytes: number) => [
	{ field: "doc", bytes: typlens.uuid.value },
	{ field: "at", bytes: typlens.int8.value },
	{ field: "after", bytes: 4 + textBytes }
]

/** Doc's lines in order, and the concat fold of their pieces into Doc.text, every text of `t`. */
const docSchema = (t: TextType) => {
	const text = textOf(t)
	const Doc = relation("Doc", { id: uuid, n: drawn(natural), text: accumulated(text, "") }, ["id"])
	const Line = relation(
		"Line",
		{
			doc: uuid,
			at: drawn(natural),
			piece: text,
			before: accumulated(text, ""),
			after: accumulated(text, "")
		},
		["doc", "at"]
	)
	const lines = ordered(on(Line, "doc", "at"), fin(Doc, "n"))
	const joined = fold(
		lines,
		Monoid.concat,
		on(Line, "doc", "piece", "before", "after"),
		on(Doc, "id", "text")
	)
	return schema("Axis", { Doc, Line }, [lines, joined])
}

type Feature = "an unbounded accumulator" | "an entry past the bound" | "an entry within it"

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
						box: "a concat fold's text of no bound, of 64 code points, or of 2,805 letters",
						generator: element(types),
						literal: Formatter.format,
						limit: 3,
						coverage: requiredInSpace<Feature>([
							"an unbounded accumulator",
							"an entry past the bound",
							"an entry within it"
						]),
						caseHang
					},
					(t: TextType, c: Case<Feature>) =>
						Effect.sync(() => {
							const owned = succeeded(ownedInput(docSchema(t)))
							const compiled = compileInstallation(owned, installOptions(owned, "owner"))
							const bytes = t.bytes === undefined ? undefined : entryBytes(t.bytes)
							if (bytes !== undefined && bytes <= btreeMaxItemSize.value) {
								succeeded(compiled, `${t.name}: an entry of ${bytes} bytes fits`)
								c.note("an entry within it")
								return
							}
							const reason = refused(compiled, "UnrepresentableKey").reason
							if (reason._tag !== "UnrepresentableKey") {
								return assert.fail("an UnrepresentableKey reason")
							}
							assert.deepEqual(
								reason.key,
								["doc", "at", "after"],
								"the UNIQUE Line's axes reference"
							)
							assert.ok(
								Str.includes("the concat fold into Doc.text")(reason.subject),
								`the refusal names the fold: ${reason.subject}`
							)
							assert.deepEqual(
								reason.fault,
								bytes === undefined || t.bytes === undefined
									? { kind: "unboundedText", field: "after" }
									: {
											kind: "btreeEntry",
											bytes,
											limit: btreeMaxItemSize.value,
											datums: datumsOf(t.bytes)
										}
							)
							c.note(bytes === undefined ? "an unbounded accumulator" : "an entry past the bound")
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
	 * (54000). The box: Tag's codes its two live handles, then 0, 21,310 or 21,311 holes, the entry exactly at
	 * BTMaxItemSize at 21,310 and one MAXALIGN past it at 21,311. The oracle: the entry counted by hand, a bit(n)'s varlena
	 * header, its 4-byte bit count and a byte per eight codes after Line's (order, at) at their exact offsets.
	 */
	const Tag = closed("Tag", ["red", "blue"])
	const none = Bits.of(Tag, [])
	const Order = relation(
		"Order",
		{ id: uuid, n: drawn(natural), seen: accumulated(bits(Tag), none) },
		["id"]
	)
	const Line = relation(
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
	const lines = ordered(on(Line, "order", "at"), fin(Order, "n"))
	const seen = fold(
		lines,
		Monoid.or,
		on(Line, "order", "flags", "before", "after"),
		on(Order, "id", "seen")
	)
	const owned = succeeded(ownedInput(schema("Holes", { Tag, Order, Line }, [lines, seen])))

	/** Tag's codes: its two live handles, then `holes` removed ones. */
	const codesWith = (holes: number) =>
		codebookOfStates([
			{
				closed: parsedName("Tag"),
				slots: [
					{ kind: "live", handle: "red" },
					{ kind: "live", handle: "blue" },
					...Array.from({ length: holes }, (_, i) => ({ kind: "hole" as const, was: `gone${i}` }))
				],
				spellings: { plain: 1 }
			}
		])

	/** A bit(n) of `codes` codes: its varlena header, its 4-byte bit count and a byte per eight codes. */
	const setBytes = (codes: number): number => 4 + typlens.int4.value + Math.ceil(codes / 8)

	/** Line's (order, at, after) entry: its header, a uuid, a bigint aligned to 8, a bit(n) aligned to 4, MAXALIGNed. */
	const entryOf = (codes: number): number => {
		const at = alignUp(8 + typlens.uuid.value, typlens.int8.value) + typlens.int8.value
		return alignUp(alignUp(at, 4) + setBytes(codes), maxAlign.value)
	}

	type SetFeature = "no hole" | "an entry at the bound" | "an entry past it"

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
					box: "Tag's two live handles and 0, 21,310 or 21,311 holes",
					generator: element([0, 21_310, 21_311] as const),
					literal: Formatter.format,
					limit: 3,
					coverage: requiredInSpace<SetFeature>([
						"no hole",
						"an entry at the bound",
						"an entry past it"
					]),
					caseHang
				},
				(holes: number, c: Case<SetFeature>) =>
					Effect.sync(() => {
						const codes = codesWith(holes)
						const compiled = compileInstallation(owned, {
							...completeInstallOptions(owned, owned.installation, [], [], codes),
							owner: "owner"
						})
						const bytes = entryOf(2 + holes)
						if (bytes <= btreeMaxItemSize.value) {
							succeeded(compiled, `${holes} holes: an entry of ${bytes} bytes fits`)
							c.note(holes === 0 ? "no hole" : "an entry at the bound")
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
								{ field: "after", bytes: setBytes(2 + holes) }
							]
						})
						c.note("an entry past it")
					})
			)
		)
	)
})
