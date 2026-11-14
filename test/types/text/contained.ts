import { type Situations, type Tally, tallyOf } from "@bjornpagen/testing/features"
import type { Gen } from "@bjornpagen/testing/gen"
import { element } from "@bjornpagen/testing/gen"
import { floorSeed, rotatingSeed } from "@bjornpagen/testing/random"
import { sample } from "@bjornpagen/testing/source"
import { Array as Arr } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { buildNfa } from "#compiler/scalar/regex/nfa.ts"
import { analyzeText } from "#compiler/text/refinement.ts"
import {
	type Flags,
	families,
	jsMatcher,
	patternOver,
	stringsOver,
	walkGen
} from "#test/unit/text/generators.ts"

/**
 * The generated containment program of test/types/text: for every handwritten family pattern of the regex
 * differential tests and generated ones, it assigns the members ECMAScript accepts, from the family's strings and walks
 * over the pattern's own host NFA, to `Infer<typeof str.regex(...)>`, and for every kept pattern its kept members;
 * and each admitted pattern joined with the next by str.and, the values both accept, to `Infer<typeof str.and(...)>`. It
 * must typecheck with no diagnostic at all, so typed authoring accepts every such admitted source and conjunction. Each draw's label
 * gives a quarter of its patterns, strings and walks from its floor stream (`floorDraws`), the same on every run, and
 * the rest from its rotating stream under the run's seed (`rotatingDraws`), new on every run, so the program is the
 * same wherever one run generates it, in the type-test batch (test/types/batch) and in regex.test.ts. A family's
 * witnesses are the members a pattern the label fixes (a handwritten one, a floor-drawn one, a kept one) takes from
 * floor draws: regex.test.ts requires every family to have one, which no run seed moves.
 *
 * Patterns whose inferred host type once refused members the pattern accepts, each with those members: ArkRegex wrote
 * adjacent placeholders, of which TypeScript makes the first match exactly one code point, or read a literal U+200B,
 * its own marker, as an error ending the source or a class, or as an anchor (TEST_SEED=3860715490).
 */
const kept: ReadonlyArray<{
	readonly source: string
	readonly flags: Flags
	readonly members: ReadonlyArray<string>
}> = [
	{ source: "(.|)a|b", flags: "su", members: ["a", "a\u{1659b}"] },
	{ source: "^a+", flags: "u", members: ["a"] },
	{ source: "\\D?\\.", flags: "u", members: ["."] },
	{ source: "\\W{0,2}x", flags: "u", members: ["x"] },
	{ source: "^(?:\\d?){2}$", flags: "u", members: [""] },
	{ source: "^(?:a|\\d)+$", flags: "u", members: ["1a"] },
	{ source: "\u200B", flags: "su", members: ["\u200B"] },
	{ source: "[a\u200B]b", flags: "u", members: ["ab", "\u200Bb"] },
	{ source: "a<\u200B\\^\u200B>b", flags: "u", members: ["a<\u200B^\u200B>b"] }
]

/** `count` values of `generator` from the floor stream of `label`: the same values on every run. */
const floorDraws = <A>(label: string, generator: Gen<A>, count: number): ReadonlyArray<A> =>
	sample(generator, floorSeed(label), count)

/**
 * `count` values of `generator` from the rotating stream of `label` under the run's seed: every process of one run draws
 * the same values, and every run draws new ones.
 */
const rotatingDraws = <A>(
	seed: number,
	label: string,
	generator: Gen<A>,
	count: number
): ReadonlyArray<A> => sample(generator, rotatingSeed(seed, floorSeed(label)), count)

/** A pattern of the program, and whether the suite's labels fix it (a witness) or the run's seed drew it (a sample). */
type Drawn = Readonly<{ source: string; flags: Flags; origin: "witness" | "sample" }>

/**
 * The containment program, the situations it requires (every family, by name, contributes a witness), and the tally
 * of the families whose witnesses contributed a member: what regex.test.ts judges with unreachedOf.
 */
export interface Contained {
	readonly source: string
	readonly families: Situations<string>
	readonly witnesses: Tally<"floor">
}

/** The distinct members of a pattern among drawn values, in the order they were drawn. */
const acceptedOf = (source: string, flags: Flags, values: ReadonlyArray<string>) =>
	Arr.dedupe(Arr.filter(values, jsMatcher(source, flags)))

/** The first twelve distinct walks of a host NFA, a walk that got stuck none. */
const ownOf = (walks: ReadonlyArray<string | undefined>): ReadonlyArray<string> =>
	Arr.take(Arr.dedupe(Arr.flatMap(walks, (w) => (w === undefined ? [] : [w]))), 12)

/**
 * The program under the run's seed, for a file four directories below the repository root
 * (test/types/text/<scratch>/contained.ts).
 */
export const containedProgram = (seed: number): Contained => {
	const lines = [
		'import { str } from "../../../../packages/engine/src/public/text.ts"',
		'import type { Infer } from "../../../../packages/engine/src/public/fields.ts"'
	]
	const witnesses = tallyOf("floor")
	for (const [fi, family] of families.entries()) {
		let witnessed = false
		const stringsLabel = `text/contained ${family.name} strings`
		const strings = stringsOver(element(family.alphabet), 8)
		const floorStrings = floorDraws(stringsLabel, strings, 100)
		const rotatingStrings = rotatingDraws(seed, stringsLabel, strings, 300)
		const patternsLabel = `text/contained ${family.name} patterns`
		const generatedFlags = (i: number): Flags => (i % 2 === 0 ? "u" : "su")
		const drawn: ReadonlyArray<Drawn> = [
			...Arr.map(family.patterns, ([source, flags]): Drawn => ({
				source,
				flags,
				origin: "witness"
			})),
			...Arr.map(
				floorDraws(patternsLabel, patternOver(family.alphabet), 4),
				(source, i): Drawn => ({ source, flags: generatedFlags(i), origin: "witness" })
			),
			...Arr.map(
				rotatingDraws(seed, patternsLabel, patternOver(family.alphabet), 12),
				(source, i): Drawn => ({ source, flags: generatedFlags(i), origin: "sample" })
			)
		]
		/** The family's admitted patterns, each with the drawn members it was assigned, for the conjunctions below. */
		const admitted: Array<{
			readonly name: string
			readonly source: string
			readonly flags: Flags
			readonly members: ReadonlyArray<string>
		}> = []
		for (const [pi, { source, flags, origin }] of drawn.entries()) {
			/** Only admitted patterns: a refused one has no host type to contain anything. */
			const result = analyzeText([{ source, flags }], SourceLoc("str.regex", [family.name, pi]))
			if (!result.ok) {
				continue
			}
			const walksLabel = `text/contained ${family.name} ${pi} walks`
			const walks = walkGen(buildNfa(result.value.members[0].ir))
			const fixed = acceptedOf(source, flags, [
				...floorStrings,
				...ownOf(floorDraws(walksLabel, walks, 120))
			])
			const sampled = acceptedOf(source, flags, [
				...rotatingStrings,
				...ownOf(rotatingDraws(seed, walksLabel, walks, 360))
			])
			const members = Arr.take(Arr.dedupe([...fixed, ...sampled]), 24)
			witnessed = witnessed || (origin === "witness" && Arr.isReadonlyArrayNonEmpty(fixed))
			const name = `p${fi}_${pi}`
			lines.push(`export const ${name} = str.regex(${jsonText(source)}, ${jsonText(flags)})`)
			for (const [i, v] of members.entries()) {
				lines.push(`export const ${name}_${i}: Infer<typeof ${name}> = ${jsonText(v)}`)
			}
			admitted.push({ name, source, flags, members })
		}
		for (const [ai, a] of admitted.entries()) {
			const b = admitted[ai + 1]
			if (b === undefined) {
				continue
			}
			const ofA = jsMatcher(a.source, a.flags)
			const ofB = jsMatcher(b.source, b.flags)
			const both = Arr.take(
				Arr.filter(
					Arr.dedupe([...a.members, ...b.members, ...floorStrings]),
					(v) => ofA(v) && ofB(v)
				),
				12
			)
			const name = `${a.name}_and`
			lines.push(`export const ${name} = str.and(${a.name}, ${b.name})`)
			for (const [i, v] of both.entries()) {
				lines.push(`export const ${name}_${i}: Infer<typeof ${name}> = ${jsonText(v)}`)
			}
		}
		witnesses.add(new Set(witnessed ? [family.name] : []))
	}
	for (const [ki, { source, flags, members }] of kept.entries()) {
		const ofKept = jsMatcher(source, flags)
		for (const v of members) {
			if (!ofKept(v)) {
				throw new Error(`${source} does not accept ${v}`)
			}
		}
		const name = `kept${ki}`
		lines.push(`export const ${name} = str.regex(${jsonText(source)}, ${jsonText(flags)})`)
		for (const [i, v] of members.entries()) {
			lines.push(`export const ${name}_${i}: Infer<typeof ${name}> = ${jsonText(v)}`)
		}
	}
	return {
		source: `${Arr.join(lines, "\n")}\n`,
		families: Arr.map(families, (family) => family.name),
		witnesses: witnesses.tally()
	}
}
