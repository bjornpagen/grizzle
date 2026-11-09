import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	alphabet as lettersOf,
	array,
	constant,
	element,
	type Gen,
	int,
	map,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import { regexMaxRepeat } from "#compiler/core/limits.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { codePoints, codePointsText } from "#compiler/core/text.ts"
import { workloadExtension } from "#compiler/physical/access/extension.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { decimalText, doubleText, lexicalForm, str } from "#compiler/public/text.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { computeCore as Compute } from "#compiler/scalar/compute/builders.ts"
import { charSet, complement } from "#compiler/scalar/regex/charset.ts"
import { inclusion } from "#compiler/scalar/regex/inclusion.ts"
import { buildNfa, type Nfa } from "#compiler/scalar/regex/nfa.ts"
import { parsePattern } from "#compiler/scalar/regex/parse.ts"
import { sourceSet } from "#compiler/scalar/regex/source.ts"
import { generatedField } from "#compiler/schema/relation.ts"
import { type RegexText, regexField } from "#compiler/text/field.ts"
import { analyzeText } from "#compiler/text/refinement.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { compileTestWorkload, testCompile } from "#test/support/compile.ts"
import { caseHang } from "#test/support/limits.ts"
import { asDrafted, compile } from "#test/support/migrate/kit.ts"
import { checkedIn } from "#test/support/policy.ts"
import { jsAccepts, patternOver } from "#test/unit/text/generators.ts"

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

/**
 * The characters an operand's alphabet, a map and a value are drawn over: ASCII capitals and small letters, a digit,
 * XML's four white space characters, and characters of two, three and four bytes, the ideographic space among them,
 * which XML does not count as white space.
 */
const pool: Arr.NonEmptyReadonlyArray<number> = [
	0x61, 0x41, 0x5a, 0x30, 0x20, 0x09, 0x0a, 0x0d, 0xe9, 0x20ac, 0x3000, 0x1f600
]

/** XML's white space, which collapse folds: tab, LF, CR and space. */
const white: ReadonlyArray<number> = [0x09, 0x0a, 0x0d, 0x20]

/** The space a collapse joins runs with, and replaceWhitespace writes. */
const space = 0x20

/** What a concatenation appends: a string, or the operand itself. */
type Suffix =
	| { readonly kind: "literal"; readonly points: ReadonlyArray<number> }
	| { readonly kind: "operand" }

/**
 * A text-to-text operation that keeps a byte bound: collapse, a translation by its map, or a concatenation with its
 * suffix.
 */
type Step =
	| { readonly kind: "collapse" }
	| {
			readonly kind: "translate"
			readonly from: ReadonlyArray<number>
			readonly to: ReadonlyArray<number>
	  }
	| { readonly kind: "lowerAscii" }
	| { readonly kind: "replaceWhitespace" }
	| { readonly kind: "concat"; readonly suffix: Suffix }

type Translating = Extract<
	Step,
	{ readonly kind: "translate" | "lowerAscii" | "replaceWhitespace" }
>

/** A step that maps character by character: a translation, lowerAscii and replaceWhitespace. */
const isTranslating = (step: Step): step is Translating =>
	step.kind === "translate" || step.kind === "lowerAscii" || step.kind === "replaceWhitespace"

/** The characters an operand's pattern holds: every one, or some of the pool. */
type Over =
	| { readonly kind: "every" }
	| { readonly kind: "listed"; readonly points: Arr.NonEmptyReadonlyArray<number> }

/** How many characters an operand's pattern holds: any number, or at most `chars`. */
type Count = { readonly kind: "any" } | { readonly kind: "atMost"; readonly chars: number }

/** An operand's type: `str.bytes(bytes, str.regex(P))`, P every text over its characters of its count. */
interface Operand {
	readonly bytes: number
	readonly over: Over
	readonly count: Count
}

/** The bounded texts a case casts into: every text, and a lowered, a replaced and a collapsed text's patterns. */
const boundedTargets: Arr.NonEmptyReadonlyArray<{
	readonly source: string
	readonly flags: "u" | "su"
}> = [
	{ source: "^.*$", flags: "su" },
	{ source: "^[^A-Z]*$", flags: "u" },
	{ source: "^[^\\t\\n\\r]*$", flags: "u" },
	{ source: "^(?:[^ \\t\\n\\r]+(?: [^ \\t\\n\\r]+)*)?$", flags: "u" }
]

/**
 * A transformed text keeps the byte bound its operation proves: `generated(T, Compute.cast(S(t), T))`, t of
 * `str.bytes(b, str.regex(P))` with P every text over the pool's characters or over every one, of at most a drawn count
 * or of any, S a chain of one or two of collapse, a translation by a drawn map (to characters of more bytes than their
 * sources among them), lowerAscii and replaceWhitespace, and T `str.bytes(n, Q)` for a drawn pattern Q, n drawn about
 * S's bound. The schema compiles exactly when S's language lies inside Q and its byte bound within n.
 *
 * The oracles, written apart from the lowering:
 * - the verdict: each step's language as README states it (a translation's, the operand's pattern with each class
 *   mapped; a collapse's, the operand's own where it holds no white space, the empty text where it holds nothing else,
 *   its bounded image where its count is small enough to spell, and the collapsed texts over its other characters
 *   otherwise), and each step's bytes, a collapse's the operand's bound and a translation's the most bytes the image of
 *   a text of the operand's byte and character bounds over its pattern's characters takes, found by a dynamic program
 *   over counts of characters and bytes, each within what the step's own language bounds; language inclusion in Q
 *   decides the pattern.
 * - the host: the chain evaluated by hand on a text whose first step's image takes the program's most bytes, built from
 *   its choices, and on drawn values of t's type: no image takes more than the bound, a translation first takes exactly
 *   the most, and where the cast compiles every image is of T.
 * - the installation: the chain stored uncast in T installs with a workload reading it, as generate drafts it
 *   (installsStored), whatever refinement its type states.
 *
 * Planted bugs, each refuted by the search: a collapse and a translation that carry no byte bound, the type before this
 * search, refused where the bound fits; a translation that keeps its operand's bound under a map to wider characters,
 * admitted where a value outgrows it; a translation's bound read without the operand's character bound, refused where
 * few characters fit; a generated field cast into its term's computed type, which names no domain, refused at its
 * installation.
 */
interface ByteCase {
	readonly operand: Operand
	readonly steps: Arr.NonEmptyReadonlyArray<Step>
	readonly target: { readonly pattern: number; readonly slack: number }
	readonly values: ReadonlyArray<ReadonlyArray<number>>
}

type ByteRoute = Step["kind"]
type ByteFeature =
	| `${ByteRoute} admitted`
	| `${ByteRoute} refused`
	| "a translation to wider characters"
	| "fewer characters than bytes"
	| "a refusal by the bound alone"
	| "a refusal by the pattern alone"
	| "an admission at its bound"
	| "a chain of two"

const byteRoutes: Arr.NonEmptyReadonlyArray<ByteRoute> = [
	"collapse",
	"translate",
	"lowerAscii",
	"replaceWhitespace",
	"concat"
]

const stepGen: Gen<Step> = weighted<Step>([
	[2, constant<Step>({ kind: "collapse" })],
	[
		3,
		(source) => {
			const from = Arr.dedupe(source.draw(array(element(pool), { min: 1, max: 3 })))
			return { kind: "translate", from, to: Arr.map(from, () => source.draw(element(pool))) }
		}
	],
	[1, constant<Step>({ kind: "lowerAscii" })],
	[1, constant<Step>({ kind: "replaceWhitespace" })],
	[
		1,
		map(array(element(pool), { min: 0, max: 3 }), (points): Step => ({
			kind: "concat",
			suffix: { kind: "literal", points }
		}))
	],
	[1, constant<Step>({ kind: "concat", suffix: { kind: "operand" } })]
])

const byteCaseGen: Gen<ByteCase> = (source) => ({
	operand: {
		bytes: source.draw(
			weighted([
				[6, int(0, 12)],
				[1, element([255, 256, 257, 258, 259])]
			])
		),
		over: source.draw(
			weighted<Over>([
				[1, constant<Over>({ kind: "every" })],
				[3, map(lettersOf(pool), (points): Over => ({ kind: "listed", points }))]
			])
		),
		count: source.draw(
			weighted<Count>([
				[3, constant<Count>({ kind: "any" })],
				[1, map(int(1, 6), (chars): Count => ({ kind: "atMost", chars }))]
			])
		)
	},
	steps: [source.draw(stepGen), ...source.draw(array(stepGen, { min: 0, max: 1 }))],
	target: {
		pattern: source.draw(int(0, boundedTargets.length - 1)),
		slack: source.draw(int(-3, 3))
	},
	values: source.draw(
		array(array(element([...pool, 0x62, 0xe0, 0x4e00, 0x1f601]), { min: 0, max: 16 }), {
			min: 0,
			max: 4
		})
	)
})

const capitals = Arr.makeBy(26, (i) => 0x41 + i)
const smalls = Arr.makeBy(26, (i) => 0x61 + i)

/** The map a translating step applies, character by character, lowerAscii's and replaceWhitespace's as README states them. */
const mapOf = (step: Translating): ReadonlyMap<number, number> => {
	switch (step.kind) {
		case "translate":
			return new Map(Arr.zip(step.from, step.to))
		case "lowerAscii":
			return new Map(Arr.zip(capitals, smalls))
		case "replaceWhitespace":
			return new Map([
				[0x09, space],
				[0x0a, space],
				[0x0d, space]
			])
	}
}

/** A character's UTF-8 bytes, as the host encodes it. */
const widthOf = (c: number): number => new TextEncoder().encode(String.fromCodePoint(c)).length

/** A text's UTF-8 bytes, as the host encodes it. */
const bytesOf = (text: string): number => new TextEncoder().encode(text).length

/** A set of characters the oracle reads: some listed, or every admitted one but some. */
type Points =
	| { readonly kind: "listed"; readonly points: ReadonlyArray<number> }
	| { readonly kind: "everyBut"; readonly except: ReadonlyArray<number> }

const holds = (p: Points, c: number): boolean =>
	p.kind === "listed" ? Arr.contains(p.points, c) : !Arr.contains(p.except, c)

const isNone = (p: Points): boolean => p.kind === "listed" && p.points.length === 0

/** The image of a set under a map: its characters the map leaves, and the target of each it moves. */
const mappedPoints = (p: Points, m: ReadonlyMap<number, number>): Points => {
	const moved = Arr.fromIterable(m)
	const inImage = (c: number): boolean =>
		(holds(p, c) && !m.has(c)) || Arr.some(moved, ([s, t]) => t === c && holds(p, s))
	return p.kind === "listed"
		? { kind: "listed", points: Arr.dedupe(Arr.map(p.points, (c) => m.get(c) ?? c)) }
		: {
				kind: "everyBut",
				except: Arr.filter(Arr.dedupe([...p.except, ...m.keys()]), (c) => !inImage(c))
			}
}

const withoutWhite = (p: Points): Points =>
	p.kind === "listed"
		? { kind: "listed", points: Arr.filter(p.points, (c) => !Arr.contains(white, c)) }
		: { kind: "everyBut", except: Arr.dedupe([...p.except, ...white]) }

const withPoint = (p: Points, c: number): Points =>
	p.kind === "listed"
		? { kind: "listed", points: Arr.dedupe([...p.points, c]) }
		: { kind: "everyBut", except: Arr.filter(p.except, (e) => e !== c) }

/** The most bytes a character of the set takes. */
const widest = (p: Points): number =>
	p.kind === "listed" ? Arr.reduce(p.points, 0, (w, c) => Math.max(w, widthOf(c))) : 4

/** A set as a class of grizzle's pattern grammar, as the lowering spells one (source.ts sourceSet). */
const classOf = (p: Points): string =>
	sourceSet(
		p.kind === "listed"
			? charSet(Arr.map(p.points, (c) => [c, c] as const))
			: complement(charSet(Arr.map(p.except, (c) => [c, c] as const)))
	)

/**
 * A language as README states each step's: every text over a set, of its count; every collapsed text over a set, its
 * runs a `gap` apart; and a bounded collapse's, at most `chars` characters that begin and end with one of `ends`.
 */
type Language =
	| { readonly kind: "free"; readonly over: Points; readonly count: Count }
	| { readonly kind: "collapsed"; readonly runs: Points; readonly gap: number }
	| {
			readonly kind: "bounded"
			readonly ends: Points
			readonly middle: Points
			readonly chars: number
	  }

/** The empty text alone. */
const noText: Language = {
	kind: "free",
	over: { kind: "listed", points: [] },
	count: { kind: "atMost", chars: 0 }
}

/** A language's pattern under the flags "u". */
const languageSource = (l: Language): string => {
	switch (l.kind) {
		case "free":
			return isNone(l.over)
				? "^$"
				: `^${classOf(l.over)}${l.count.kind === "any" ? "*" : `{0,${l.count.chars}}`}$`
		case "collapsed":
			return `^(?:${classOf(l.runs)}+(?:${classOf({ kind: "listed", points: [l.gap] })}${classOf(l.runs)}+)*)?$`
		case "bounded":
			return l.chars === 0
				? "^$"
				: l.chars === 1
					? `^${classOf(l.ends)}?$`
					: `^(?:${classOf(l.ends)}(?:${classOf(l.middle)}{0,${l.chars - 2}}${classOf(l.ends)})?)?$`
	}
}

/** The characters a language's pattern holds, as README reads them for a translation's bytes. */
const lettersIn = (l: Language): Points =>
	l.kind === "free" ? l.over : l.kind === "collapsed" ? withPoint(l.runs, l.gap) : l.middle

/** What a language's own pattern bounds: its characters and bytes, or nothing. */
type Own =
	| { readonly kind: "unbounded" }
	| { readonly kind: "bounded"; readonly chars: number; readonly bytes: number }

const ownBounds = (l: Language): Own => {
	switch (l.kind) {
		case "free":
			return isNone(l.over)
				? { kind: "bounded", chars: 0, bytes: 0 }
				: l.count.kind === "any"
					? { kind: "unbounded" }
					: { kind: "bounded", chars: l.count.chars, bytes: l.count.chars * widest(l.over) }
		case "collapsed":
			return { kind: "unbounded" }
		case "bounded":
			return {
				kind: "bounded",
				chars: l.chars,
				bytes:
					l.chars === 0
						? 0
						: l.chars === 1
							? widest(l.ends)
							: 2 * widest(l.ends) + (l.chars - 2) * widest(l.middle)
			}
	}
}

/** A text type as the oracle reads it: its language, and its byte and character bounds. */
interface Typed {
	readonly language: Language
	readonly bytes: number
	readonly chars: number
}

/** A language within `bytes`, as str.bytes declares it: the tighter of its own bounds and the byte bound. */
const typedWithin = (language: Language, bytes: number): Typed => {
	const own = ownBounds(language)
	if (own.kind === "unbounded") {
		return { language, bytes, chars: bytes }
	}
	const within = Math.min(own.bytes, bytes)
	return { language, bytes: within, chars: Math.min(own.chars, within) }
}

/** A collapse's language as README states it, of a text of `t`'s type. */
const collapsedLanguage = (t: Typed): Language => {
	const letters = lettersIn(t.language)
	if (!Arr.some(white, (c) => holds(letters, c))) {
		return t.language
	}
	const other = withoutWhite(letters)
	if (isNone(other)) {
		return noText
	}
	const bounded: Language = {
		kind: "bounded",
		ends: other,
		middle: withPoint(other, space),
		chars: t.chars
	}
	return t.chars - 2 <= regexMaxRepeat.value &&
		analyzeText([{ source: languageSource(bounded), flags: "u" }], SourceLoc("image", [])).ok
		? bounded
		: { kind: "collapsed", runs: other, gap: space }
}

/** A translation's language: each class of the operand's pattern mapped. */
const translatedLanguage = (l: Language, m: ReadonlyMap<number, number>): Language => {
	switch (l.kind) {
		case "free":
			return { kind: "free", over: mappedPoints(l.over, m), count: l.count }
		case "collapsed":
			return { kind: "collapsed", runs: mappedPoints(l.runs, m), gap: m.get(l.gap) ?? l.gap }
		case "bounded":
			return {
				kind: "bounded",
				ends: mappedPoints(l.ends, m),
				middle: mappedPoints(l.middle, m),
				chars: l.chars
			}
	}
}

/**
 * Unmoved characters of each width, one to four bytes, which stand for every character a set of all but a few holds:
 * none is in the pool, so no map moves one and no set leaves one out.
 */
const standIns: ReadonlyArray<number> = [0x62, 0x63, 0xe0, 0xe1, 0x4e00, 0x4e01, 0x1f601, 0x1f602]

/** A kind of character of a set: the bytes it takes, the bytes its image takes, and one character of it. */
interface Kind {
	readonly bytes: number
	readonly image: number
	readonly point: number
}

/** The kinds of character of a set under a map: each listed character's, or a stand-in's and each moved one's. */
const kindsOver = (p: Points, m: ReadonlyMap<number, number>): ReadonlyArray<Kind> =>
	Arr.dedupeWith(
		Arr.map(
			Arr.filter(p.kind === "listed" ? p.points : [...standIns, ...m.keys()], (c) => holds(p, c)),
			(c): Kind => ({ bytes: widthOf(c), image: widthOf(m.get(c) ?? c), point: c })
		),
		(a, b) => a.bytes === b.bytes && a.image === b.image
	)

/**
 * The most bytes an image takes of a text of at most `chars` characters and `bytes` bytes over `kinds`, by a dynamic
 * program over counts of characters and bytes, and a text that takes it, built from the program's choices.
 */
const mostOf = (
	kinds: ReadonlyArray<Kind>,
	bytes: number,
	chars: number
): { readonly most: number; readonly witness: string } => {
	const rows = Math.min(chars, bytes)
	const cols = bytes + 1
	const best = new Int32Array((rows + 1) * cols)
	const at = (c: number, b: number): number => defined(best[c * cols + b])
	for (let c = 1; c <= rows; c += 1) {
		for (let b = 0; b <= bytes; b += 1) {
			let most = at(c - 1, b)
			for (const k of kinds) {
				if (k.bytes <= b) {
					most = Math.max(most, at(c - 1, b - k.bytes) + k.image)
				}
			}
			best[c * cols + b] = most
		}
	}
	const points: Array<number> = []
	let b = bytes
	for (let c = rows; c > 0; c -= 1) {
		const here = at(c, b)
		if (here === at(c - 1, b)) {
			continue
		}
		const k = defined(
			Arr.findFirst(
				kinds,
				(kind) => kind.bytes <= b && at(c - 1, b - kind.bytes) + kind.image === here
			).pipe(Option.getOrUndefined)
		)
		points.push(k.point)
		b -= k.bytes
	}
	return { most: at(rows, bytes), witness: codePointsText(points) }
}

/** Every text, a concatenation's language. */
const anyText: Language = {
	kind: "free",
	over: { kind: "everyBut", except: [] },
	count: { kind: "any" }
}

/**
 * What a step does to a text type, `operand` the type of the text the chain starts from, and whether a translation
 * widened it or read fewer characters than bytes.
 */
const stepped = (
	t: Typed,
	step: Step,
	operand: Typed
): { readonly typed: Typed; readonly widened: boolean; readonly fewer: boolean } => {
	switch (step.kind) {
		case "collapse":
			return { typed: typedWithin(collapsedLanguage(t), t.bytes), widened: false, fewer: false }
		case "concat":
			return {
				typed: typedWithin(
					anyText,
					t.bytes +
						(step.suffix.kind === "literal"
							? bytesOf(codePointsText(step.suffix.points))
							: operand.bytes)
				),
				widened: false,
				fewer: false
			}
		case "translate":
		case "lowerAscii":
		case "replaceWhitespace": {
			const m = mapOf(step)
			const most = mostOf(kindsOver(lettersIn(t.language), m), t.bytes, t.chars).most
			return {
				typed: typedWithin(translatedLanguage(t.language, m), most),
				widened: most > t.bytes,
				fewer: t.chars < t.bytes
			}
		}
	}
}

/**
 * One step evaluated by hand on the host, `operand` the text the chain starts from: a collapse by its pieces, a
 * translation character by character, a concatenation by appending.
 */
const hostStep = (step: Step, value: string, operand: string): string => {
	switch (step.kind) {
		case "collapse":
			return Arr.join(
				Arr.filter(
					Str.split(" ")(
						codePointsText(Arr.map(codePoints(value), (c) => (Arr.contains(white, c) ? space : c)))
					),
					Str.isNonEmpty
				),
				" "
			)
		case "concat":
			return `${value}${step.suffix.kind === "literal" ? codePointsText(step.suffix.points) : operand}`
		case "translate":
		case "lowerAscii":
		case "replaceWhitespace": {
			const m = mapOf(step)
			return codePointsText(Arr.map(codePoints(value), (c) => m.get(c) ?? c))
		}
	}
}

/** A chain evaluated by hand on the host over a value of its operand. */
const hostChain = (steps: ReadonlyArray<Step>, value: string): string =>
	Arr.reduce(steps, value, (v, step) => hostStep(step, v, value))

/** The operand's language: every text over its characters, of its count. */
const operandLanguage = (o: Operand): Language => ({
	kind: "free",
	over:
		o.over.kind === "every"
			? { kind: "everyBut", except: [] }
			: { kind: "listed", points: o.over.points },
	count: o.count
})

/** A drawn value made a value of the operand's type: its characters the pattern holds, cut to its count and bytes. */
const projected = (o: Operand, points: ReadonlyArray<number>): string => {
	const letters = lettersIn(operandLanguage(o))
	const limit = o.count.kind === "any" ? Number.POSITIVE_INFINITY : o.count.chars
	const kept: Array<number> = []
	let bytes = 0
	for (const c of Arr.filter(points, (p) => holds(letters, p))) {
		if (kept.length >= limit || bytes + widthOf(c) > o.bytes) {
			break
		}
		kept.push(c)
		bytes += widthOf(c)
	}
	return codePointsText(kept)
}

/** The operand's declared pattern, as str.regex reads it. */
const operandPattern = (o: Operand): { readonly source: string; readonly flags: "u" | "su" } => {
	const repeat = o.count.kind === "any" ? "*" : `{0,${o.count.chars}}`
	return o.over.kind === "every"
		? { source: `^.${repeat}$`, flags: "su" }
		: { source: `^${classOf({ kind: "listed", points: o.over.points })}${repeat}$`, flags: "u" }
}

/** A step over a term, as Compute builds it, `operand` the term the chain starts from. */
const computed = (step: Step, term: unknown, operand: unknown): unknown => {
	switch (step.kind) {
		case "collapse":
			return Compute.collapse(term)
		case "translate":
			return Compute.translate(term, codePointsText(step.from), codePointsText(step.to))
		case "lowerAscii":
			return Compute.lowerAscii(term)
		case "replaceWhitespace":
			return Compute.replaceWhitespace(term)
		case "concat":
			return Compute.concat(
				term,
				step.suffix.kind === "literal" ? codePointsText(step.suffix.points) : operand
			)
	}
}

/** A chain of steps over a term, the first step innermost. */
const chained = (steps: ReadonlyArray<Step>, term: unknown): unknown =>
	Arr.reduce(steps, term, (inner, step) => computed(step, inner, term))

/**
 * The chain stored uncast in a generated field of `Target`, the text entering its column as computed, its column's
 * domain the judge (ir/scalar.ts enteredType), and a workload reading the relation: the schema is admitted, and it
 * installs with the workload's plan as `grizzle generate` drafts it (compile, completeInstallOptions). A stored
 * computation's own refinement, a translation's image or a collapse's or a concatenation's byte bound, names no domain,
 * so neither the generated column nor the workload asks for one.
 */
const installsStored = (
	steps: Arr.NonEmptyReadonlyArray<Step>,
	Operand: RegexText<string>,
	Target: RegexText<string>
): void => {
	const Stored = relation.generated("R", { id: uuid, t: Operand }, ["id"], (r) => ({
		n: generatedField(Target, chained(steps, r.t), [])
	}))
	const Installed = schema("Stored", { R: Stored }, [])
	const reads = queryOver(Installed).rule((r: RuleValue) => {
		const row = varsOver(Stored, "row")
		return r.match(Stored, row).find(row)
	})
	const plan = succeeded(
		compileTestWorkload(
			[{ login: "server", workloads: [workload(Installed, { reads })] }],
			Installed,
			testCompile
		),
		`the workload over ${Formatter.format(steps)} stored uncast`
	)
	compile(Installed, { ...asDrafted, extensions: [workloadExtension(plan)] })
}

describe("a transformed text's byte bound", () => {
	it.effect(
		"admits a cast into a bounded text exactly when the bound its operations prove and their language fit it",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/compute/transformed-bytes",
						draw: drawn(byteCaseGen),
						literal: Formatter.format,
						coverage: required<ByteFeature>(
							[
								...Arr.flatMap(byteRoutes, (r): Arr.NonEmptyReadonlyArray<ByteFeature> => [
									`${r} admitted`,
									`${r} refused`
								]),
								"a translation to wider characters",
								"fewer characters than bytes",
								"a refusal by the bound alone",
								"a refusal by the pattern alone",
								"an admission at its bound",
								"a chain of two"
							],
							{ cases: 800, sense: notesOnly }
						),
						kept: [
							{
								note: "qti-pie's key: lowerAscii(collapse(x)) over x of at most 2587 bytes, stored in a generated field of that type, which the collapse and the case fold each keep within x's bound",
								sketch: {
									operand: { bytes: 2587, over: { kind: "every" }, count: { kind: "any" } },
									steps: [{ kind: "collapse" }, { kind: "lowerAscii" }],
									target: { pattern: 0, slack: 0 },
									values: []
								},
								draws: "",
								reaches: ["lowerAscii admitted", "an admission at its bound", "a chain of two"]
							}
						],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						oracle: {
							kind: "second-implementation",
							name: "each step's language as README states it, its bytes by a dynamic program over counts of characters and bytes, inclusion in the target, and the chain evaluated by hand on the host"
						}
					},
					(c, run) =>
						Effect.sync(() => {
							const operand = operandPattern(c.operand)
							const OperandText = str.bytes(
								c.operand.bytes,
								regexField<string>(operand.source, [operand.flags])
							)
							const first = typedWithin(operandLanguage(c.operand), c.operand.bytes)
							const [head] = c.steps
							const steps = Arr.scan(
								c.steps,
								{ typed: first, widened: false, fewer: false },
								(s, step) => stepped(s.typed, step, first)
							)
							const typed = Arr.lastNonEmpty(steps).typed
							for (const s of steps) {
								if (s.widened) {
									run.note("a translation to wider characters")
								}
								if (s.fewer) {
									run.note("fewer characters than bytes")
								}
							}
							if (c.steps.length === 2) {
								run.note("a chain of two")
							}
							const target = defined(boundedTargets[c.target.pattern])
							const bytes = Math.max(0, typed.bytes + c.target.slack)
							const TargetText = str.bytes(bytes, regexField<string>(target.source, [target.flags]))
							const checked = checkedIn(
								schema(
									"Bounded",
									{
										R: relation.generated("R", { id: uuid, t: OperandText }, ["id"], (r) => ({
											n: generatedField(
												TargetText,
												Compute.cast(chained(c.steps, r.t), TargetText),
												[]
											)
										}))
									},
									[]
								)
							)
							const route = Arr.lastNonEmpty(c.steps).kind
							run.note(`${route} ${checked.ok ? "admitted" : "refused"}`)
							installsStored(c.steps, OperandText, TargetText)
							const verdict = inclusion(
								[nfaOf(languageSource(typed.language), "u")],
								[nfaOf(target.source, target.flags)]
							).kind
							const label = `${Formatter.format(c)}: ${verdict} within ${typed.bytes} bytes, cast into ${bytes}`
							if (verdict === "bounded") {
								assert.ok(!checked.ok && checked.error.reason._tag === "ResourceBound", label)
								return
							}
							assert.equal(
								checked.ok,
								verdict === "included" && typed.bytes <= bytes,
								`${label}, ${checked.ok ? "admitted" : checked.error.message}`
							)
							if (!checked.ok) {
								assert.equal(checked.error.reason._tag, "PartialOperation", label)
								if (verdict === "included") {
									run.note("a refusal by the bound alone")
								} else if (typed.bytes <= bytes) {
									run.note("a refusal by the pattern alone")
								}
							} else if (typed.bytes === bytes) {
								run.note("an admission at its bound")
							}
							const kinds = kindsOver(
								lettersIn(first.language),
								isTranslating(head) ? mapOf(head) : new Map<number, number>()
							)
							const most = mostOf(kinds, first.bytes, first.chars)
							if (isTranslating(head)) {
								assert.equal(
									bytesOf(hostStep(head, most.witness, most.witness)),
									defined(steps[1]).typed.bytes,
									`${label}: the first translation's widest image takes its bound`
								)
							}
							for (const value of [
								most.witness,
								...Arr.map(c.values, (v) => projected(c.operand, v))
							]) {
								const image = hostChain(c.steps, value)
								assert.ok(
									bytesOf(image) <= typed.bytes,
									`${label}: ${Formatter.format(value)} becomes ${Formatter.format(image)}, within the bound`
								)
								if (checked.ok) {
									assert.ok(
										bytesOf(image) <= bytes && jsAccepts(target.source, target.flags, image),
										`${label}: ${Formatter.format(image)} is of the target`
									)
								}
							}
						})
				)
			)
	)
})
