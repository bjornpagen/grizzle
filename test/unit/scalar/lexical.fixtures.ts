/** What the properties of lexical.test.ts read: its spaces, models and helpers. */

import { constant, type Gen, int, map, weighted } from "@bjornpagen/testing/gen"
import { decimalTextMaxBytes } from "@grizzle/limits"
import { Array as Arr } from "effect"
import { Compute } from "#compiler/public/compute.ts"
import { generated, pg, uuid } from "#compiler/public/fields.ts"
import { type AnyRelation, relation } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { toFloat } from "#compiler/scalar/compute/cast.ts"
import { formSource, type LexicalTarget } from "#compiler/scalar/lexical.ts"
import { closure, type Nfa } from "#compiler/scalar/regex/match.ts"
import { buildNfa } from "#compiler/scalar/regex/nfa.ts"
import { parsePattern } from "#compiler/scalar/regex/parse.ts"
import { generatedField } from "#compiler/schema/relation.ts"
import { regexField } from "#compiler/text/field.ts"
import { defined, succeeded } from "#test/support/assert.ts"
import { targetGen } from "#test/support/lexical.ts"
import { admittedPatternOver } from "#test/unit/text/generators.ts"

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

/** How a case states the parse's operand: by its field's type, or under a Compute.matches guard on a plain text. */
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
			relation.generated("R", { id: uuid, t: typedText(pattern, route) }, ["id"], (r) => ({
				n: generated(
					pg.smallint,
					route === "type"
						? Compute.cast(r.t, pg.smallint)
						: Compute.when(
								Compute.matches(r.t, Compute.pattern(pattern)),
								(t) => Compute.cast(t, pg.smallint),
								Compute.literal(pg.smallint, 0)
							)
				)
			}))
	],
	[
		{ kind: "decimal", typmod: { precision: 3, scale: 1 } },
		(pattern, route) =>
			relation.generated("R", { id: uuid, t: typedText(pattern, route) }, ["id"], (r) => ({
				n: generated(
					pg.numeric(3, 1),
					route === "type"
						? Compute.cast(r.t, pg.numeric(3, 1))
						: Compute.when(
								Compute.matches(r.t, Compute.pattern(pattern)),
								(t) => Compute.cast(t, pg.numeric(3, 1)),
								Compute.literal(pg.numeric(3, 1), "0")
							)
				)
			}))
	],
	[
		{ kind: "doubleText" },
		(pattern, route) =>
			relation.generated("R", { id: uuid, t: typedText(pattern, route) }, ["id"], (r) => ({
				n: generated(
					pg["double precision"],
					route === "type"
						? Compute.parseDouble(r.t)
						: Compute.when(
								Compute.matches(r.t, Compute.pattern(pattern)),
								(t) => Compute.parseDouble(t),
								Compute.literal(pg["double precision"], 0)
							)
				)
			}))
	],
	[
		{ kind: "boolean" },
		(pattern, route) =>
			relation.generated("R", { id: uuid, t: typedText(pattern, route) }, ["id"], (r) => ({
				n: generated(
					pg.boolean,
					route === "type"
						? Compute.cast(r.t, pg.boolean)
						: Compute.when(
								Compute.matches(r.t, Compute.pattern(pattern)),
								(t) => Compute.cast(t, pg.boolean),
								Compute.literal(pg.boolean, false)
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
	[3, map(int(-1, 1), (offset) => ({ kind: "bytes", bytes: decimalTextMaxBytes.value + offset }))],
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
	const no = computeCore.literal(pg.boolean, false)
	const parsedSign = (t: unknown): unknown =>
		computeCore.cond(
			computeCore.ge(computeCore.parseDecimal(t), 0n),
			computeCore.literal(pg.boolean, true),
			no
		)
	if (route === "type") {
		const typed = regexField<string>(pattern, [])
		const t = bound.kind === "none" ? typed : str.bytes(bound.bytes, typed)
		return relation.generated("R", { id: uuid, t }, ["id"], (r) => ({
			n: generatedField(pg.boolean, parsedSign(r.t), [])
		}))
	}
	return relation.generated("R", { id: uuid, t: typedText(pattern, route) }, ["id"], (r) => ({
		n: generatedField(
			pg.boolean,
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
 * the host matcher's walk (match.ts closure) over every text at once: the states some text of n characters reaches, a
 * text of n characters a member where a walk of it reached the accepting state before its end, or reaches it at its
 * end. A language inside decimalText is ASCII, a character a byte, so for one it is the most bytes a value of its text
 * within `chars` bytes takes, which the parse compares with the form's bound.
 */
export const longestMember = (nfa: Nfa, chars: number): number => {
	const mark = new Int32Array(nfa.edges.length).fill(-1)
	let stamp = 0
	let seeds: ReadonlyArray<number> = [nfa.start]
	let early = false
	let longest = 0
	for (let n = 0; n <= chars; n += 1) {
		const atStart = n === 0
		if (
			early ||
			closure(nfa, seeds, { atStart, atEnd: true }, mark, stamp++).includes(nfa.accept)
		) {
			longest = n
		}
		const walked = closure(nfa, seeds, { atStart, atEnd: false }, mark, stamp++)
		early ||= walked.includes(nfa.accept)
		seeds = [
			...Arr.flatMap(walked, (state) =>
				Arr.flatMap(defined(nfa.edges[state]), (e) => (e.kind === "set" ? [e.to] : []))
			),
			nfa.start
		]
	}
	return longest
}
