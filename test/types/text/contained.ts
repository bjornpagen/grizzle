import { type Situations, type Tally, tallyOf } from "@grizzle/testing/features"
import type { Gen } from "@grizzle/testing/gen"
import { floorSeed, rotatingSeed } from "@grizzle/testing/random"
import { sample } from "@grizzle/testing/source"
import { Array as Arr } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { buildNfa } from "#compiler/scalar/regex/nfa.ts"
import { analyzeText } from "#compiler/text/refinement.ts"
import {
	type Flags,
	families,
	jsAccepts,
	patternOver,
	stringsOver,
	walkGen
} from "#test/unit/text/generators.ts"

/**
 * The generated containment program of test/types/text: for every handwritten family pattern of the regex
 * differential tests and generated ones, it assigns the members ECMAScript accepts, from the family's strings and walks
 * over the pattern's own host NFA, to `Infer<typeof str.regex(...)>`, and for every kept pattern its kept members. It
 * must typecheck with no diagnostic at all, so typed authoring accepts every such admitted source. Each draw's label
 * gives a quarter of its patterns, strings and walks from its floor stream (`floorDraws`), the same on every run, and
 * the rest from its rotating stream under the run's seed (`rotatingDraws`), new on every run, so the program is the
 * same wherever one run generates it, in the type-test batch (test/types/batch) and in regex.test.ts. A family's
 * witnesses are the members a pattern the label fixes (a handwritten one, a floor-drawn one, a kept one) takes from
 * floor draws: regex.test.ts requires every family to have one, which no run seed moves.
 *
 * Patterns whose inferred host type once refused members the pattern accepts, each with those members: ArkRegex wrote
 * adjacent placeholders, of which TypeScript makes the first match exactly one code point.
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
	{ source: "^(?:a|\\d)+$", flags: "u", members: ["1a"] }
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
	Arr.dedupe(Arr.filter(values, (v) => jsAccepts(source, flags, v)))

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
		const strings = stringsOver(family.alphabet, 8)
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
		for (const [pi, { source, flags, origin }] of drawn.entries()) {
			/** Only admitted patterns: a refused one has no host type to contain anything. */
			const result = analyzeText(source, flags, SourceLoc("str.regex", [family.name, pi]))
			if (!result.ok) {
				continue
			}
			const walksLabel = `text/contained ${family.name} ${pi} walks`
			const walks = walkGen(buildNfa(result.value.ir))
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
		}
		witnesses.add(new Set(witnessed ? [family.name] : []))
	}
	for (const [ki, { source, flags, members }] of kept.entries()) {
		for (const v of members) {
			if (!jsAccepts(source, flags, v)) {
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
