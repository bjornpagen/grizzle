import { type Situations, type Tally, tallyOf } from "@bjornpagen/testing/features"
import { boolean, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { floorSeed, rotatingSeed } from "@bjornpagen/testing/random"
import { sample } from "@bjornpagen/testing/source"
import { Array as Arr } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import { str } from "#compiler/public/text.ts"
import { regexField } from "#compiler/text/field.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"

/**
 * The containments of str.bytes texts, generated, which test/types/text/bytes.test.ts holds the types to and
 * test/unit/text/bytes.test.ts the engine: a byte bound is a refinement as a pattern is, not a type, so a text it
 * bounds meets every text a pattern-refined text meets.
 *
 * A case is a containment of a source relation's text in a target relation's key text, each side a pattern, every text
 * (`^.*$`), at most so many code points (`^.{0,L}$`) or lowercase letters of no bound (`^[a-z]*$`), bounded or not by
 * str.bytes; the target, a key, is bounded by its pattern or its bytes. The program declares each case's relations and
 * schema over the public API, and states that each str.bytes field's type is its pattern's own, both ways; it must
 * typecheck with no diagnostic. The cases are drawn as test/types/text/contained.ts draws its patterns: those the
 * label fixes (the floor), the same on every run, which must reach every required situation, and those the run's seed
 * draws, new on every run.
 */

/** A side's pattern: every text, at most so many code points, or letters of no bound. */
type BytesPattern =
	| { readonly kind: "every" }
	| { readonly kind: "upTo"; readonly codePoints: number }
	| { readonly kind: "letters" }

/** A side's text: its pattern, and the byte bound str.bytes cuts it to, none for the pattern alone. */
export interface Text {
	readonly pattern: BytesPattern
	readonly bytes: number | undefined
}

/** A containment of a source's text in a target's key text. */
export interface MeetCase {
	readonly source: Text
	readonly target: Text
}

const patternGen: Gen<BytesPattern> = weighted<BytesPattern>([
	[2, element<BytesPattern>([{ kind: "every" }, { kind: "letters" }])],
	[2, (source) => ({ kind: "upTo", codePoints: source.draw(int(0, 80)) })]
])

const textGen: Gen<Text> = (source) => ({
	pattern: source.draw(patternGen),
	bytes: source.draw(boolean) ? source.draw(int(0, 400)) : undefined
})

/** A key text: bounded by its pattern, or by its bytes. */
const keyTextGen: Gen<Text> = (source) => {
	const text = source.draw(textGen)
	return text.pattern.kind === "upTo" || text.bytes !== undefined
		? text
		: { pattern: text.pattern, bytes: source.draw(int(0, 400)) }
}

export const meetCaseGen: Gen<MeetCase> = (source) => ({
	source: source.draw(textGen),
	target: source.draw(keyTextGen)
})

/** A pattern's source and flags, as str.regex takes them. */
const patternSource = (
	p: BytesPattern
): { readonly source: string; readonly flags: "u" | "su" } => {
	switch (p.kind) {
		case "every":
			return { source: "^.*$", flags: "su" }
		case "upTo":
			return { source: `^.{0,${p.codePoints}}$`, flags: "su" }
		case "letters":
			return { source: "^[a-z]*$", flags: "u" }
	}
}

/** A side's field: str.bytes over its pattern, or the pattern itself. */
export const fieldOf = (t: Text): FieldBase => {
	const { source, flags } = patternSource(t.pattern)
	const pattern = regexField(source, [flags])
	return t.bytes === undefined ? pattern : str.bytes(t.bytes, pattern)
}

/** The situations a case reaches. */
export type MeetFeature =
	| "a str.bytes source"
	| "a str.bytes target"
	| "str.bytes on both sides"
	| "a source of its pattern alone"
	| "a target of its pattern alone"
	| "a bound over every text"
	| "a bound the pattern meets"
	| "a bound that cuts the pattern"

export const meetFeatures: Arr.NonEmptyReadonlyArray<MeetFeature> = [
	"a str.bytes source",
	"a str.bytes target",
	"str.bytes on both sides",
	"a source of its pattern alone",
	"a target of its pattern alone",
	"a bound over every text",
	"a bound the pattern meets",
	"a bound that cuts the pattern"
]

/** What a side's byte bound does to its pattern: none, a bound over every text, one it meets, or one that cuts it. */
const boundFeatures = (t: Text): ReadonlyArray<MeetFeature> => {
	if (t.bytes === undefined) {
		return []
	}
	if (t.pattern.kind === "every") {
		return ["a bound over every text"]
	}
	return t.pattern.kind === "upTo" && 4 * t.pattern.codePoints <= t.bytes
		? ["a bound the pattern meets"]
		: ["a bound that cuts the pattern"]
}

export const featuresOf = (c: MeetCase): ReadonlyArray<MeetFeature> => {
	const sides: ReadonlyArray<MeetFeature> =
		c.source.bytes !== undefined && c.target.bytes !== undefined
			? ["a str.bytes source", "a str.bytes target", "str.bytes on both sides"]
			: c.source.bytes !== undefined
				? ["a str.bytes source", "a target of its pattern alone"]
				: c.target.bytes !== undefined
					? ["a source of its pattern alone", "a str.bytes target"]
					: ["a source of its pattern alone", "a target of its pattern alone"]
	return [...sides, ...boundFeatures(c.source), ...boundFeatures(c.target)]
}

/** The cases the label fixes, the same on every run, and those the run's seed draws. */
const meetCases = (
	seed: number
): {
	readonly floor: ReadonlyArray<MeetCase>
	readonly rotating: ReadonlyArray<MeetCase>
} => ({
	floor: sample(meetCaseGen, floorSeed("text/bytes meets"), 24),
	rotating: sample(meetCaseGen, rotatingSeed(seed, floorSeed("text/bytes meets")), 24)
})

/** A pattern as the program spells it. */
const patternText = (p: BytesPattern): string => {
	const { source, flags } = patternSource(p)
	return `str.regex(${jsonText(source)}, ${jsonText(flags)})`
}

/** The program's declarations of a side's text: its pattern, and its field, str.bytes over it or the pattern itself. */
const sideLines = (name: string, t: Text): ReadonlyArray<string> => [
	`export const ${name}Pattern = ${patternText(t.pattern)}`,
	t.bytes === undefined
		? `export const ${name} = ${name}Pattern`
		: `export const ${name} = str.bytes(${t.bytes}, ${name}Pattern)`,
	`export const ${name}Same: Same<typeof ${name}, typeof ${name}Pattern> = true`
]

/** The program's declarations of a case at a position: its sides, its relations and its schema. */
const caseLines = (c: MeetCase, at: number): ReadonlyArray<string> => [
	...sideLines(`S${at}`, c.source),
	...sideLines(`T${at}`, c.target),
	`export const A${at} = relation("A${at}", { id: uuid, t: S${at} }, ["id"])`,
	`export const B${at} = relation("B${at}", { u: T${at} }, ["u"])`,
	`export const Schema${at} = schema("Meets${at}", [A${at}, B${at}], [contained(on(A${at}, "t"), on(B${at}, "u"))])`
]

/** The program, for a file four directories below the repository root, and the floor's tally of what it reaches. */
export const bytesProgram = (
	seed: number
): {
	readonly source: string
	readonly situations: Situations<MeetFeature>
	readonly witnesses: Tally<"floor">
} => {
	const { floor, rotating } = meetCases(seed)
	const witnesses = tallyOf("floor")
	for (const c of floor) {
		witnesses.add(new Set(featuresOf(c)))
	}
	const lines = [
		'import { uuid } from "../../../../packages/engine/src/public/fields.ts"',
		'import { contained, on, relation, schema } from "../../../../packages/engine/src/public/schema.ts"',
		'import { str } from "../../../../packages/engine/src/public/text.ts"',
		"type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false",
		...Arr.flatMap([...floor, ...rotating], caseLines)
	]
	return {
		source: `${Arr.join(lines, "\n")}\n`,
		situations: meetFeatures,
		witnesses: witnesses.tally()
	}
}
