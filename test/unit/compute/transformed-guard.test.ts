import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, map, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import { codePointsText } from "#compiler/core/text.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { decimalText, doubleText, lexicalForm, str } from "#compiler/public/text.ts"
import { computeCore as Compute } from "#compiler/scalar/compute/builders.ts"
import { inclusion } from "#compiler/scalar/regex/inclusion.ts"
import { buildNfa, type Nfa } from "#compiler/scalar/regex/nfa.ts"
import { parsePattern } from "#compiler/scalar/regex/parse.ts"
import { generatedField } from "#compiler/schema/relation.ts"
import { regexField } from "#compiler/text/field.ts"
import { analyzeText } from "#compiler/text/refinement.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { checkedIn } from "#test/support/policy.ts"
import { patternOver } from "#test/unit/text/generators.ts"

/**
 * A guard over a transformed text proves what its language allows: `Compute.when(Compute.matches(T(t), P), (x) =>
 * Op(x), otherwise)` in a generated field, t any text, T a text-to-text operation (collapse, a translation by a drawn
 * map, lowerAscii, replaceWhitespace, a cast into the text's own type), P a drawn pattern, and Op a partial operation
 * over a text: parseDouble, parseDecimal under a guard of its bytes, a cast into an integer, and a cast into a refined
 * text. Inside the branch x is T(t) restated at T's language and narrowed again by the guards it stands under, so the
 * schema compiles exactly when T's image of every text and P together lie inside Op's form.
 *
 * The oracle: language inclusion (scalar/regex/inclusion.ts) of the conjunction of P and T's image of every text, as
 * README states each (a collapse's, every collapsed text, `^(?:[^ \t\n\r]+(?: [^ \t\n\r]+)*)?$`; a translation's,
 * every text but the characters it maps away; a cast into the text's own type, every text), in Op's form, written
 * apart from the lowering's own image of the operand's pattern. A comparison past the analysis's bounds decides
 * nothing, which names them (ResourceBound), and a guard no value of the image matches types its branch by no value,
 * which the text analysis refuses (UnsupportedOperation).
 *
 * Planted bug: collapse writes its language over the term after settle, `{ ...node, nominal: collapseType(...) }`,
 * which drops the guard's narrowing; a type error since Lowered's type is private to settle, and run untyped, the
 * search refutes it.
 */

/** The characters the forms, the maps and the guards' patterns are drawn over: digits, a sign, a point, an exponent, white space and letters. */
const alphabet: Arr.NonEmptyReadonlyArray<number> = [
	0x30, 0x31, 0x39, 0x2d, 0x2b, 0x2e, 0x65, 0x45, 0x20, 0x09, 0x0a, 0x41, 0x61, 0x78
]

/** A text-to-text operation over a text, and the pattern of its image of every text. */
type Transform =
	| { readonly kind: "collapse" }
	| { readonly kind: "translate"; readonly from: string; readonly to: string }
	| { readonly kind: "lowerAscii" }
	| { readonly kind: "replaceWhitespace" }
	| { readonly kind: "cast" }

/** A partial operation over a text, and its form: the language its operand must lie in. */
type Operation =
	| { readonly kind: "parseDouble" }
	| { readonly kind: "parseDecimal" }
	| { readonly kind: "integer" }
	| { readonly kind: "refined"; readonly target: string }

type Route = Transform["kind"]
type Feature = `${Route} admitted` | `${Route} refused`

const routes: Arr.NonEmptyReadonlyArray<Route> = [
	"collapse",
	"translate",
	"lowerAscii",
	"replaceWhitespace",
	"cast"
]

/** A translation's map: distinct characters of the alphabet, each to a drawn one. */
const translateGen: Gen<Transform> = (source) => {
	const from = Arr.dedupe(source.draw(array(element(alphabet), { min: 1, max: 3 })))
	const to = Arr.map(from, () => source.draw(element(alphabet)))
	return { kind: "translate", from: codePointsText(from), to: codePointsText(to) }
}

const transformGen: Gen<Transform> = weighted<Transform>([
	[3, () => ({ kind: "collapse" })],
	[2, translateGen],
	[1, () => ({ kind: "lowerAscii" })],
	[1, () => ({ kind: "replaceWhitespace" })],
	[1, () => ({ kind: "cast" })]
])

/** Refined texts a cast may target, each holding the empty text, which the branch's otherwise writes. */
const targets: Arr.NonEmptyReadonlyArray<string> = [
	"^[0-9]*$",
	"^[^ \\t\\n\\r]*$",
	"^(?:[0-9a-z]+(?: [0-9a-z]+)*)?$",
	"^[^A-Z]*$"
]

const operationGen: Gen<Operation> = weighted<Operation>([
	[2, () => ({ kind: "parseDouble" })],
	[2, () => ({ kind: "parseDecimal" })],
	[1, () => ({ kind: "integer" })],
	[1, map(element(targets), (target): Operation => ({ kind: "refined", target }))]
])

/** The integer form a cast into pg.integer reads. */
const integerForm = lexicalForm(pg.integer)

/**
 * A guard's pattern: a drawn one over the alphabet, a form with white space either side of it, a run of digits padded
 * or not, or a form itself, so a guard proves an operation alone, with its transform's image, or not at all.
 */
const guardGen: Gen<string> = weighted([
	[4, map(patternOver(alphabet), (body) => `^(?:${body})$`)],
	[
		2,
		map(
			element([doubleText, decimalText, integerForm]),
			(form) => `^[ \\t\\n]*(?:${Str.slice(1, -1)(form)})[ \\t\\n]*$`
		)
	],
	[2, element(["^ ?[0-9]+ ?$", "^[0-9]+$", "^-?[0-9]{1,4}(?:\\.[0-9]{1,3})?$", "^[0-9a-z ]*$"])],
	[1, element([doubleText, decimalText, integerForm])]
])

interface Case {
	readonly transform: Transform
	readonly guard: string
	readonly operation: Operation
}

const caseGen: Gen<Case> = (source) => ({
	transform: source.draw(transformGen),
	guard: source.draw(guardGen),
	operation: source.draw(operationGen)
})

/** The characters a map takes out of every text: those of `from` that `to` does not put back. */
const mappedAway = (from: string, to: string): string =>
	Arr.join(
		Arr.filter(Array.from(from), (c) => !Str.includes(c)(to)),
		""
	)

/** A class's member for a character, escaped where the class grammar needs it. */
const classMember = (c: string): string =>
	c === "\t"
		? "\\t"
		: c === "\n"
			? "\\n"
			: c === "\r"
				? "\\r"
				: Str.includes(c)("\\]^-")
					? `\\${c}`
					: c

/** The pattern, under its flags, of T's image of every text, as README states it. */
const imageOf = (t: Transform): { readonly source: string; readonly flags: "u" | "su" } => {
	switch (t.kind) {
		case "collapse":
			return { source: "^(?:[^ \\t\\n\\r]+(?: [^ \\t\\n\\r]+)*)?$", flags: "u" }
		case "translate": {
			const away = mappedAway(t.from, t.to)
			return away.length === 0
				? { source: "^.*$", flags: "su" }
				: { source: `^[^${Arr.join(Arr.map(Array.from(away), classMember), "")}]*$`, flags: "u" }
		}
		case "lowerAscii":
			return { source: "^[^A-Z]*$", flags: "u" }
		case "replaceWhitespace":
			return { source: "^[^\\t\\n\\r]*$", flags: "u" }
		case "cast":
			return { source: "^.*$", flags: "su" }
	}
}

/** Op's form: the pattern its operand must lie in. */
const formOf = (op: Operation): string => {
	switch (op.kind) {
		case "parseDouble":
			return doubleText
		case "parseDecimal":
			return decimalText
		case "integer":
			return integerForm
		case "refined":
			return op.target
	}
}

const nfaOf = (source: string, flags: "u" | "su"): Nfa =>
	buildNfa(succeeded(parsePattern(source, flags)))

const AnyText = str.regex("^.*$", "su")

/** T over the row's text. */
const transformed = (t: Transform, text: unknown): unknown => {
	switch (t.kind) {
		case "collapse":
			return Compute.collapse(text)
		case "translate":
			return Compute.translate(text, t.from, t.to)
		case "lowerAscii":
			return Compute.lowerAscii(text)
		case "replaceWhitespace":
			return Compute.replaceWhitespace(text)
		case "cast":
			return Compute.cast(text, AnyText)
	}
}

/** A case's relation: its generated field, the guarded operation over T(t), the otherwise a value of its type. */
const relationOf = (c: Case) =>
	relation.generated("R", { id: uuid, t: AnyText }, ["id"], (r) => {
		const subject = transformed(c.transform, r.t)
		const guarded = <F extends FieldBase>(
			type: F,
			op: (x: unknown) => unknown,
			otherwise: unknown
		) => generatedField(type, Compute.when(Compute.matches(subject, c.guard), op, otherwise), [])
		switch (c.operation.kind) {
			case "parseDouble":
				return {
					n: guarded(
						pg["double precision"],
						(x) => Compute.parseDouble(x),
						Compute.literal(pg["double precision"], 0)
					)
				}
			case "parseDecimal": {
				const yes = Compute.literal(pg.boolean, true)
				const no = Compute.literal(pg.boolean, false)
				return {
					n: guarded(
						pg.boolean,
						(x) =>
							Compute.when(
								Compute.within(Compute.octetLength(x), 0, 16384),
								() => Compute.cond(Compute.ge(Compute.parseDecimal(x), 0n), yes, no),
								no
							),
						no
					)
				}
			}
			case "integer":
				return {
					n: guarded(pg.integer, (x) => Compute.cast(x, pg.integer), Compute.literal(pg.integer, 0))
				}
			case "refined": {
				const Target = regexField<string>(c.operation.target, [])
				return {
					n: guarded(Target, (x) => Compute.cast(x, Target), Compute.literal(Target, ""))
				}
			}
		}
	})

describe("a guard over a transformed text", () => {
	it.effect(
		"proves a partial operation exactly when the transform's image and the guard's pattern together lie inside its form",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/compute/transformed-guard",
						draw: drawn(caseGen),
						literal: Formatter.format,
						coverage: required<Feature>(
							Arr.flatMap(routes, (r): Arr.NonEmptyReadonlyArray<Feature> => [
								`${r} admitted`,
								`${r} refused`
							]),
							{ cases: 800, sense: notesOnly }
						),
						kept: [],
						runs: 800,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						oracle: {
							kind: "second-implementation",
							name: "language inclusion of the guard's pattern and the transform's image of every text, as README states it, in the operation's form"
						}
					},
					(c, run) =>
						Effect.sync(() => {
							if (!analyzeText([{ source: c.guard, flags: "u" }], SourceLoc("guard", [])).ok) {
								return
							}
							const image = imageOf(c.transform)
							const checked = checkedIn(schema("Transformed", { R: relationOf(c) }, []))
							run.note(`${c.transform.kind} ${checked.ok ? "admitted" : "refused"}`)
							if (
								!analyzeText([{ source: c.guard, flags: "u" }, image], SourceLoc("guard", [])).ok
							) {
								assert.ok(
									!checked.ok && checked.error.reason._tag === "UnsupportedOperation",
									`${Formatter.format(c)}: a guard no image value matches is refused`
								)
								return
							}
							const verdict = inclusion(
								[nfaOf(c.guard, "u"), nfaOf(image.source, image.flags)],
								[nfaOf(formOf(c.operation), "u")]
							).kind
							const label = `${Formatter.format(c)}: ${verdict}`
							if (verdict === "bounded") {
								assert.ok(!checked.ok && checked.error.reason._tag === "ResourceBound", label)
								return
							}
							assert.equal(
								checked.ok,
								verdict === "included",
								`${label}, ${checked.ok ? "admitted" : checked.error.message}`
							)
						})
				)
			)
	)
})
