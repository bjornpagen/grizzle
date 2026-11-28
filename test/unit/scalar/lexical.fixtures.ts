/** What the properties of lexical.test.ts read: its spaces, models and helpers. */

import { buildNfa, type Nfa } from "@bjornpagen/grizzle-text/regex/nfa"
import { parsePattern } from "@bjornpagen/grizzle-text/regex/parse"
import { type Config, Configurations, successorAt } from "@bjornpagen/grizzle-text/regex/subset"
import { defined } from "@bjornpagen/testing/assert"
import { constant, element, type Gen, int, map, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { Logic, Text, Type } from "#compiler/public/compute.ts"
import {
	accumulated,
	date,
	Numeric,
	drawn,
	exactInteger,
	generated,
	natural,
	bool,
	float8,
	int2,
	int4,
	int8,
	numeric
} from "#compiler/public/fields.ts"
import { type AnyRelation, relation } from "#compiler/public/schema.ts"
import { type lexicalForm, str } from "#compiler/public/text.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { toFloat } from "#compiler/scalar/compute/cast.ts"
import { numericTextMaxBytes, formSource, type LexicalTarget } from "#compiler/scalar/lexical.ts"
import { generatedField } from "#compiler/schema/relation.ts"
import { regexField } from "#compiler/text/field.ts"
import { succeeded } from "#test/support/assert.ts"
import { Id } from "#test/support/ids.ts"
import {
	type Candidate,
	candidateOf,
	targetGen,
	type TypeTarget,
	type StartedTarget,
	startedTargetGen,
	typeTargetGen
} from "#test/support/lexical.ts"
import { admittedPatternOver } from "#test/support/unit/text/generators.ts"

export const nfaOf = (source: string): Nfa => buildNfa(succeeded(parsePattern(source, "u")))

export const roundDouble = (negative: boolean, num: bigint, den: bigint): number =>
	toFloat(negative, num, den, "float8")

/** The greatest precision of the numeric targets whose forms the text analysis is held to admit. */
export const admittedMaxPrecision = 12

/** What a pair of patterns came to under the walk, the features of the inclusion suite. */
export type InclusionFeature = "included" | "refuted" | "bounded"

/**
 * A pattern pair over one small alphabet, the characters of the forms' numerals, and walks of the inner pattern's NFA;
 * one pair in two puts a lexical form outside.
 */
export const alphabet: Arr.NonEmptyReadonlyArray<number> = [0x30, 0x31, 0x39, 0x2d, 0x2e, 0x65]

export const pairGen: Gen<{ readonly inner: string; readonly outer: string }> = weighted([
	[
		1,
		(source) => ({
			inner: source.draw(admittedPatternOver(alphabet)),
			outer: source.draw(admittedPatternOver(alphabet))
		})
	],
	[
		1,
		(source) => ({
			inner: source.draw(admittedPatternOver(alphabet)),
			outer: formSource(source.draw(targetGen(admittedMaxPrecision)))
		})
	]
])

/** How a case states the parse's operand: by its field's type, or under a Text.matches guard on a plain text. */
export type Route = "type" | "guard"

/** What the checker answered a case, by how it stated the operand. */
export type CheckFeature = `${Route} admitted` | `${Route} refused`

/**
 * A case's relation: its text field `t` typed by the pattern, or plain text under a matches guard by it, and a field
 * generated from its parse into the target, one builder per target so each names its own descriptor.
 */
type Parsed = (pattern: string, route: Route) => AnyRelation

const typedText = (pattern: string, route: Route) =>
	route === "type" ? regexField<string>(pattern, []) : regexField<string>("^.*$", ["su"])

export const checkTargets: Arr.NonEmptyReadonlyArray<readonly [LexicalTarget, Parsed]> = [
	[
		{ kind: "integer", carrier: "int2" },
		(pattern, route) =>
			relation.generated("R", { id: Id, t: typedText(pattern, route) }, ["id"], (r) => ({
				n: generated(
					int2,
					route === "type"
						? Type.cast(r.t, int2)
						: Logic.when(
								Text.matches(r.t, Text.pattern(pattern)),
								(t) => Type.cast(t, int2),
								Type.literal(int2, 0)
							)
				)
			}))
	],
	[
		{ kind: "decimal", typmod: { precision: 3, scale: 1 } },
		(pattern, route) =>
			relation.generated("R", { id: Id, t: typedText(pattern, route) }, ["id"], (r) => ({
				n: generated(
					numeric(3, 1),
					route === "type"
						? Type.cast(r.t, numeric(3, 1))
						: Logic.when(
								Text.matches(r.t, Text.pattern(pattern)),
								(t) => Type.cast(t, numeric(3, 1)),
								Type.literal(numeric(3, 1), "0")
							)
				)
			}))
	],
	[
		{ kind: "float8Text" },
		(pattern, route) =>
			relation.generated("R", { id: Id, t: typedText(pattern, route) }, ["id"], (r) => ({
				n: generated(
					float8,
					route === "type"
						? Text.parseFloat8(r.t)
						: Logic.when(
								Text.matches(r.t, Text.pattern(pattern)),
								(t) => Text.parseFloat8(t),
								Type.literal(float8, 0)
							)
				)
			}))
	],
	[
		{ kind: "boolean" },
		(pattern, route) =>
			relation.generated("R", { id: Id, t: typedText(pattern, route) }, ["id"], (r) => ({
				n: generated(
					bool,
					route === "type"
						? Type.cast(r.t, bool)
						: Logic.when(
								Text.matches(r.t, Text.pattern(pattern)),
								(t) => Type.cast(t, bool),
								Type.literal(bool, false)
							)
				)
			}))
	]
]

/** How a decimal case bounds its operand's bytes: not at all, or at a drawn count, by its type or by a guard. */
type DecimalBound = { readonly kind: "none" } | { readonly kind: "bytes"; readonly bytes: number }

/** What the checker answered a decimal case, by how it stated the operand. */
export type DecimalFeature =
	| `${Route} admitted`
	| `${Route} refused by its language`
	| `${Route} refused by its bytes`

/** A bound of none, a few bytes, or one byte either side of the most the form's members hold. */
export const decimalBoundGen: Gen<DecimalBound> = weighted<DecimalBound>([
	[2, constant({ kind: "none" })],
	[3, map(int(-1, 1), (offset) => ({ kind: "bytes", bytes: numericTextMaxBytes + offset }))],
	[1, map(int(0, 12), (bytes) => ({ kind: "bytes", bytes }))]
])

/**
 * A decimal case's relation: its text `t` typed by the pattern within the bound (str.bytes), or any text under a matches
 * guard of the pattern and a guard of its bytes at the bound, and a field generated from whether the parse is at
 * least zero.
 */
export const decimalRelation = (
	pattern: string,
	route: Route,
	bound: DecimalBound
): AnyRelation => {
	const no = computeCore.literal(bool, false)
	const parsedSign = (t: unknown): unknown =>
		computeCore.cond(
			computeCore.ge(computeCore.parseNumeric(t), 0n),
			computeCore.literal(bool, true),
			no
		)
	if (route === "type") {
		const typed = regexField<string>(pattern, [])
		const t = bound.kind === "none" ? typed : str.bytes(bound.bytes, typed)
		return relation.generated("R", { id: Id, t }, ["id"], (r) => ({
			n: generatedField(bool, parsedSign(r.t), [])
		}))
	}
	return relation.generated("R", { id: Id, t: typedText(pattern, route) }, ["id"], (r) => ({
		n: generatedField(
			bool,
			computeCore.when(
				computeCore.matches(r.t, computeCore.pattern(pattern)),
				(t: unknown) =>
					bound.kind === "none"
						? parsedSign(t)
						: computeCore.when(
								computeCore.within(computeCore.octetLength(t), 0, bound.bytes),
								() => parsedSign(t),
								no
							),
				no
			),
			[]
		)
	}))
}

/**
 * The most characters a member of `nfa`'s language of at most `chars` characters takes, 0 where none is that short, by
 * the host matcher's walk (subset.ts Configurations closure) over every text at once: the configurations some text of
 * n characters reaches, a text of n characters a member where a walk of it reached the accepting state before its end,
 * or reaches it at its end. A language inside numericText is ASCII, a character a byte, so for one it is the most bytes
 * a value of its text within `chars` bytes takes, which the parse compares with the form's bound.
 */
export const longestMember = (nfa: Nfa, chars: number): number => {
	const configs = new Configurations(nfa)
	const start = configs.plain(nfa.start)
	const accepts = (reached: ReadonlyArray<Config>): boolean =>
		Arr.some(reached, (c) => configs.state(c) === nfa.accept)
	let seeds: ReadonlyArray<Config> = [start]
	let early = false
	let longest = 0
	for (let n = 0; n <= chars; n += 1) {
		const atStart = n === 0
		if (early || accepts(configs.closure(seeds, { atStart, atEnd: true }))) {
			longest = n
		}
		const walked = configs.closure(seeds, { atStart, atEnd: false })
		early ||= accepts(walked)
		seeds = [
			...Arr.flatMap(walked, (c) => {
				const successors = configs.successors(c)
				return Arr.flatMap(defined(nfa.edges[configs.state(c)]), (e, i) => {
					const to = successorAt(successors, i)
					return e.kind === "set" && to !== undefined ? [to] : []
				})
			}),
			start
		]
	}
	return longest
}

/**
 * The kinds of field lexicalForm and lexical are handed, each typed as a type with a lexical form: a caller's
 * descriptor, an accumulated field of it, and drawn(natural), a bigint's. A slot is a
 * closed id, which has no form, and a generated field is no type.
 */
const lexicalReadings = ["caller", "accumulated", "drawn"] as const

type LexicalReading = (typeof lexicalReadings)[number]

/** A kind of field lexicalForm read, the property's situation. */
export type LexicalFieldFeature = `reads ${LexicalReading}`

/**
 * A field's case: the kind of field, the target of its type's form, and a candidate of that form; an accumulated
 * field's target one a literal's value starts it at, every type's but the exact integer's, of which no literal is a
 * value (scalar/compute/literal.ts).
 */
type LexicalField =
	| {
			readonly reading: "accumulated"
			readonly target: StartedTarget
			readonly candidate: Candidate
	  }
	| {
			readonly reading: "caller" | "drawn"
			readonly target: TypeTarget
			readonly candidate: Candidate
	  }

/** What lexicalForm and lexical are handed: a type with a lexical form. */
type LexicalType = Parameters<typeof lexicalForm>[0]

/** The descriptor of a target's type. */
const declaredOf = (target: TypeTarget): LexicalType => {
	switch (target.kind) {
		case "integer":
			return target.carrier === "int2" ? int2 : target.carrier === "int4" ? int4 : int8
		case "decimal":
			return numeric(target.typmod.precision, target.typmod.scale)
		case "double":
			return float8
		case "boolean":
			return bool
		case "date":
			return date
		case "exactInteger":
			return exactInteger
	}
}

/** A value of a target's type, which an accumulated field of it starts at: its zero, false, or a date. */
const startOf = (target: StartedTarget): unknown => {
	switch (target.kind) {
		case "integer":
			return target.carrier === "int8" ? 0n : 0
		case "decimal":
			return Numeric.of("0")
		case "double":
			return 0
		case "boolean":
			return false
		case "date":
			return "2000-01-01"
	}
}

/**
 * A field's case: a kind of field, each alike, a target its type has (any type's for a caller's descriptor, one a
 * literal starts for an accumulated field, a bigint's for drawn(natural), natural's base), and a candidate of the
 * target's form.
 */
export const lexicalFieldGen: Gen<LexicalField> = (source) => {
	const reading = source.draw(element(lexicalReadings))
	switch (reading) {
		case "accumulated": {
			const target = source.draw(startedTargetGen)
			return { reading, target, candidate: source.draw(candidateOf(target)) }
		}
		case "caller":
		case "drawn": {
			const target: TypeTarget =
				reading === "caller" ? source.draw(typeTargetGen) : { kind: "integer", carrier: "int8" }
			return { reading, target, candidate: source.draw(candidateOf(target)) }
		}
	}
}

/** The field of a case: its kind of field, of its target's type. */
export const lexicalFieldOf = (c: LexicalField): LexicalType => {
	switch (c.reading) {
		case "caller":
			return declaredOf(c.target)
		case "accumulated":
			return accumulated(declaredOf(c.target), startOf(c.target))
		case "drawn":
			return drawn(natural)
	}
}

/** The situations: each kind of field. */
export const lexicalFieldSituations: ReadonlyArray<LexicalFieldFeature> = Arr.map(
	lexicalReadings,
	(r): LexicalFieldFeature => `reads ${r}`
)
