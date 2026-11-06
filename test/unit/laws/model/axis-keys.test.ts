import { describe, it } from "@effect/vitest"
import { type Case, exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { alignUp, maxAlign, typlens } from "#compiler/core/limits.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { accumulated, drawn, natural, uuid } from "#compiler/public/fields.ts"
import { fin, fold, Monoid, on, ordered, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { btreeMaxItemSize } from "#compiler/schema/representability.ts"
import { assert, refused, succeeded } from "#test/support/assert.ts"
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
 * The B-tree entry of Line's (doc, at, after) as representability counts one: the IndexTupleData header, then each
 * datum after its alignment's worst-case padding, since a varlena before it may be any length (a uuid, aligned to 1; a
 * bigint, to 8; a text's 4-byte varlena header and its longest value, to 4), the whole MAXALIGNed.
 */
const entryBytes = (textBytes: number): number => {
	const header = 8
	const doc = header + typlens.uuid.value
	const at = doc + (typlens.int8.value - 1) + typlens.int8.value
	return alignUp(at + (4 - 1) + 4 + textBytes, maxAlign.value)
}

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
								bytes === undefined
									? { kind: "unboundedText", field: "after" }
									: { kind: "btreeEntry", bytes, limit: btreeMaxItemSize.value }
							)
							c.note(bytes === undefined ? "an unbounded accumulator" : "an entry past the bound")
						})
				)
			)
	)
})
