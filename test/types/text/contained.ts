import { buildNfa } from "@bjornpagen/grizzle-text/regex/nfa"
import { codePointsText } from "@bjornpagen/grizzle-text/text"
import { array, element, type Gen, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { analyzeText } from "#compiler/text/refinement.ts"
import { jsMatcher } from "#test/support/regex.ts"
import {
	batchOwned,
	caseOwned,
	type Entry,
	type Part,
	type Program
} from "#test/support/types/batch/batch.ts"
import {
	type Family,
	type Flags,
	families,
	patternOver,
	stringsOver,
	walkGen
} from "#test/support/unit/text/generators.ts"

/**
 * The containment programs of test/types/text/regex.test.ts: a case is one family of the regex differential tests
 * (test/support/unit/text/generators.ts) and two of its patterns, each handwritten or generated, each admitted one with the
 * members ECMAScript accepts among the case's strings over the family's alphabet and walks over the pattern's own host
 * NFA, assigned to `Infer<typeof str.regex(...)>`; and, where both are admitted, their conjunction by str.and with the
 * values both accept, assigned to `Infer<typeof str.and(...)>`. A program must typecheck with no diagnostic at all, so
 * typed authoring accepts every such admitted source and conjunction. A case reaches its family when an admitted pattern
 * of it takes a member, and the empty string when a handwritten one takes it.
 *
 * Beside the drawn cases, the kept patterns (keptPatterns), each with the members its inferred host type once refused:
 * ArkRegex wrote adjacent placeholders, of which TypeScript makes the first match exactly one code point, or read a
 * literal U+200B, its own marker, as an error ending the source or a class, or as an anchor (TEST_SEED=3860715490).
 */

/** A pattern as str.regex takes it. */
type Source = Readonly<{ source: string; flags: Flags }>

/** A pattern of a family: one of its handwritten patterns, or one generated over its alphabet. */
type Pattern = Source & Readonly<{ origin: "handwritten" | "generated" }>

/** A drawn pattern: admitted, with the members it accepts among the case's draws, or refused, which contains nothing. */
type Contained =
	| Readonly<{ kind: "admitted"; pattern: Pattern; members: ReadonlyArray<string> }>
	| Readonly<{ kind: "refused"; pattern: Pattern }>

/** A case: a family, two of its patterns, and the values both accept where both are admitted. */
export interface ContainedCase {
	readonly family: string
	readonly first: Contained
	readonly second: Contained
	readonly both: ReadonlyArray<string>
}

/** The most distinct walks of a host NFA a pattern takes members from. */
const walksTaken = 12

/** The most members a pattern takes. */
const membersTaken = 24

/** The most values a conjunction takes. */
const bothTaken = 12

/** A pattern of a family: one of its handwritten patterns, or one generated over its alphabet. */
const patternGen = (family: Family): Gen<Pattern> => {
	const generated: Gen<Pattern> = (source) => ({
		source: source.draw(patternOver(family.alphabet)),
		flags: source.draw(element(["u", "su"] as const)),
		origin: "generated"
	})
	const [first, ...rest] = family.patterns
	if (first === undefined) {
		return generated
	}
	const handwritten = element([first, ...rest])
	return weighted<Pattern>([
		[
			1,
			(source) => {
				const [patternSource, flags] = source.draw(handwritten)
				return { source: patternSource, flags, origin: "handwritten" }
			}
		],
		[1, generated]
	])
}

/** A pattern drawn with its members: those it accepts among `strings` and among walks of its own host NFA. */
const containedGen =
	(family: Family, strings: ReadonlyArray<string>): Gen<Contained> =>
	(source) => {
		const pattern = source.draw(patternGen(family))
		const analyzed = analyzeText([pattern], SourceLoc("str.regex", [family.name]))
		if (!analyzed.ok) {
			return { kind: "refused", pattern }
		}
		const walks = source.draw(
			array(walkGen(buildNfa(analyzed.value.members[0].ir)), { min: 0, max: walksTaken })
		)
		const own = Arr.dedupe(Arr.flatMap(walks, (w) => (w === undefined ? [] : [w])))
		const accepts = jsMatcher(pattern.source, pattern.flags)
		return {
			kind: "admitted",
			pattern,
			members: Arr.take(Arr.dedupe(Arr.filter([...strings, ...own], accepts)), membersTaken)
		}
	}

/**
 * A family, two of its patterns over strings of its alphabet, and the values both accept. The empty string, the member
 * a host type most easily drops, is offered to every pattern beside the drawn strings.
 */
export const containedCases: Gen<ContainedCase> = (source) => {
	const family = source.draw(element(families))
	const strings = [
		"",
		...source.draw(array(stringsOver(element(family.alphabet), 8), { min: 0, max: membersTaken }))
	]
	const first = source.draw(containedGen(family, strings))
	const second = source.draw(containedGen(family, strings))
	const both =
		first.kind === "admitted" && second.kind === "admitted"
			? Arr.take(
					Arr.filter(
						Arr.dedupe([...first.members, ...second.members, ...strings]),
						(v) =>
							jsMatcher(first.pattern.source, first.pattern.flags)(v) &&
							jsMatcher(second.pattern.source, second.pattern.flags)(v)
					),
					bothTaken
				)
			: []
	return { family: family.name, first, second, both }
}

/**
 * The situation of a case whose admitted handwritten pattern takes the empty string, the member a host type most easily
 * drops: the families' own patterns hold the empty string in finite hosts ("^$", "^a?$"), where a generated one rarely
 * does.
 */
const emptyMember = "the empty string, a member of a handwritten pattern"

/**
 * The situations: every family, which a witness reaches when an admitted pattern of it takes a member, and the empty
 * string taken as a member.
 */
export const containedSituations: Arr.NonEmptyReadonlyArray<string> = [
	...Arr.map(families, (family) => family.name),
	emptyMember
]

/**
 * What a case reaches: its family, when an admitted pattern of it takes a member, and the empty string as a member of a
 * handwritten pattern.
 */
export const containedNotes = (c: ContainedCase): ReadonlyArray<string> => {
	const admitted = Arr.flatMap([c.first, c.second], (p) => (p.kind === "admitted" ? [p] : []))
	return [
		...(Arr.some(admitted, (p) => Arr.isReadonlyArrayNonEmpty(p.members)) ? [c.family] : []),
		...(Arr.some(admitted, (p) => p.pattern.origin === "handwritten" && Arr.contains(p.members, ""))
			? [emptyMember]
			: [])
	]
}

/**
 * A string as a TypeScript literal on one line: JSON's spelling, with the two line terminators JSON leaves bare,
 * U+2028 and U+2029, escaped, so TypeScript's lines are the program's.
 */
const literal = (text: string): string =>
	Str.replaceAll("\u2029", "\\u2029")(Str.replaceAll("\u2028", "\\u2028")(jsonText(text)))

/** A pattern's declaration under `name` and each member assigned to its host type. */
const patternLines = (
	name: string,
	pattern: Source,
	members: ReadonlyArray<string>
): ReadonlyArray<string> => [
	`export const ${name} = str.regex(${literal(pattern.source)}, ${literal(pattern.flags)})`,
	...Arr.map(members, (v, i) => `export const ${name}_${i}: Infer<typeof ${name}> = ${literal(v)}`)
]

/** A case's lines: each admitted pattern with its members, then their conjunction with the values both accept. */
const caseLines = (c: ContainedCase, at: number): ReadonlyArray<string> => {
	const first = `p${at}_a`
	const second = `p${at}_b`
	const declared = (name: string, p: Contained): ReadonlyArray<string> =>
		p.kind === "admitted" ? patternLines(name, p.pattern, p.members) : []
	return [
		...declared(first, c.first),
		...declared(second, c.second),
		...(c.first.kind === "admitted" && c.second.kind === "admitted"
			? [
					`export const p${at}_and = str.and(${first}, ${second})`,
					...Arr.map(
						c.both,
						(v, i) => `export const p${at}_and_${i}: Infer<typeof p${at}_and> = ${literal(v)}`
					)
				]
			: [])
	]
}

/**
 * A program's imports, the batch's own: str and Infer, each exported again, so a batch whose cases read neither still
 * reads them.
 */
const headerOf = (entry: Entry): Part => ({
	owner: batchOwned,
	lines: [
		`import { str } from ${jsonText(entry("packages/engine/src/public/text.ts"))}`,
		`import type { Infer } from ${jsonText(entry("packages/engine/src/public/fields.ts"))}`,
		"export { str }",
		"export type { Infer }"
	]
})

/** The program over a batch's cases. */
export const containedProgram = (
	cases: Arr.NonEmptyReadonlyArray<ContainedCase>,
	entry: Entry
): Program => [
	{
		file: "contained.ts",
		parts: [
			headerOf(entry),
			...Arr.map(cases, (c, at) => ({ owner: caseOwned(at), lines: caseLines(c, at) }))
		]
	}
]

/** A kept pattern and the members its host type once refused. */
export type KeptPattern = Readonly<{ pattern: Source; members: ReadonlyArray<string> }>

/** The cells of keptPatterns, minted as a dictionary in its door (test/types/text/regex.dictionary.ts). */
export const keptPatternsItems: Arr.NonEmptyReadonlyArray<KeptPattern> = [
	{ pattern: { source: "(.|)a|b", flags: "su" }, members: ["a", "a\u{1659b}"] },
	{ pattern: { source: "^a+", flags: "u" }, members: ["a"] },
	{ pattern: { source: "\\D?\\.", flags: "u" }, members: ["."] },
	{ pattern: { source: "\\W{0,2}x", flags: "u" }, members: ["x"] },
	{ pattern: { source: "^(?:\\d?){2}$", flags: "u" }, members: [""] },
	{ pattern: { source: "^(?:a|\\d)+$", flags: "u" }, members: ["1a"] },
	{ pattern: { source: "\u200B", flags: "su" }, members: ["\u200B"] },
	{ pattern: { source: "[a\u200B]b", flags: "u" }, members: ["ab", "\u200Bb"] },
	{ pattern: { source: "a<\u200B\\^\u200B>b", flags: "u" }, members: ["a<\u200B^\u200B>b"] }
]

/** A kept pattern's lines, each member checked accepted by ECMAScript first: one it refuses is the box's own defect. */
const keptLines = (kept: KeptPattern, at: number): ReadonlyArray<string> => {
	const accepts = jsMatcher(kept.pattern.source, kept.pattern.flags)
	const refused = Arr.filter(kept.members, (v) => !accepts(v))
	if (Arr.isReadonlyArrayNonEmpty(refused)) {
		throw new Error(`${kept.pattern.source} does not accept ${Arr.join(refused, ", ")}`)
	}
	return patternLines(`kept${at}`, kept.pattern, kept.members)
}

/** The program over a batch of kept patterns. */
export const keptProgram = (
	cases: Arr.NonEmptyReadonlyArray<KeptPattern>,
	entry: Entry
): Program => [
	{
		file: "contained.ts",
		parts: [
			headerOf(entry),
			...Arr.map(cases, (kept, at) => ({ owner: caseOwned(at), lines: keptLines(kept, at) }))
		]
	}
]

/** A family's handwritten pattern, by its family. */
export type HandwrittenPattern = Readonly<{ family: Family; pattern: Source }>

/**
 * Every family's handwritten pattern the engine admits: the regex tests' own roster, each admitted one, since a refused
 * pattern has no host type to contain anything; refused when none is admitted.
 */
const handwritten = (): Arr.NonEmptyReadonlyArray<HandwrittenPattern> => {
	const roster = Arr.flatMap(families, (family) =>
		Arr.flatMap(family.patterns, ([source, flags]): ReadonlyArray<HandwrittenPattern> =>
			analyzeText([{ source, flags }], SourceLoc("str.regex", [family.name])).ok
				? [{ family, pattern: { source, flags } }]
				: []
		)
	)
	if (!Arr.isReadonlyArrayNonEmpty(roster)) {
		throw new Error("the regex families hold no handwritten pattern")
	}
	return roster
}

/** The cells of handwrittenPatterns, minted as a dictionary in its door (test/types/text/regex.dictionary.ts). */
export const handwrittenPatternsItems = handwritten()

/**
 * A handwritten pattern's members: the texts it accepts among the empty string and every text of one or two code points
 * of its family's alphabet, in that order, the first membersTaken of them.
 */
const handwrittenMembers = (cell: HandwrittenPattern): ReadonlyArray<string> => {
	const letters = Arr.map(cell.family.alphabet, (c) => codePointsText([c]))
	const candidates = [
		"",
		...letters,
		...Arr.flatMap(letters, (first) => Arr.map(letters, (second) => `${first}${second}`))
	]
	return Arr.take(
		Arr.filter(candidates, jsMatcher(cell.pattern.source, cell.pattern.flags)),
		membersTaken
	)
}

/** The program over a batch of handwritten patterns, each with its members. */
export const handwrittenProgram = (
	cases: Arr.NonEmptyReadonlyArray<HandwrittenPattern>,
	entry: Entry
): Program => [
	{
		file: "contained.ts",
		parts: [
			headerOf(entry),
			...Arr.map(cases, (cell, at) => ({
				owner: caseOwned(at),
				lines: patternLines(`h${at}`, cell.pattern, handwrittenMembers(cell))
			}))
		]
	}
]
