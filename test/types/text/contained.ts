import type { Gen } from "@grizzle/testing/gen"
import { floorSeed, rotatingSeed } from "@grizzle/testing/random"
import { sample } from "@grizzle/testing/source"
import { Array as Arr } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
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
 * must typecheck with no diagnostic at all, so typed authoring accepts every such admitted source. Its draws come from
 * the rotating stream of each draw's label under the run's seed (`drawsOf`), so the program is the same wherever one
 * run generates it, in the type-test batch (test/types/batch) and in regex.test.ts, which reads what each family
 * contributed, and every run draws a new one.
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
	{ source: "\\D?\\.", flags: "u", members: ["."] }
]

/**
 * `count` values of `generator` from the rotating stream of `label` under the run's seed: every process of one run draws
 * the same values, and every run draws new ones.
 */
const drawsOf = <A>(
	seed: number,
	label: string,
	generator: Gen<A>,
	count: number
): ReadonlyArray<A> => sample(generator, rotatingSeed(seed, floorSeed(label)), count)

/** What one family contributed: its admitted patterns and the members assigned to them. */
export interface FamilyContained {
	readonly family: string
	readonly patterns: number
	readonly values: number
}

export interface Contained {
	readonly source: string
	readonly families: ReadonlyArray<FamilyContained>
}

/**
 * The program under the run's seed, for a file four directories below the repository root
 * (test/types/text/<scratch>/contained.ts).
 */
export const containedProgram = (seed: number): Contained => {
	const lines = [
		'import { str } from "../../../../packages/engine/src/public/text.ts"',
		'import type { Infer } from "../../../../packages/engine/src/public/fields.ts"'
	]
	const contributed: Array<FamilyContained> = []
	for (const [fi, family] of families.entries()) {
		let patterns = 0
		let values = 0
		const strings = drawsOf(
			seed,
			`text/contained ${family.name} strings`,
			stringsOver(family.alphabet, 8),
			400
		)
		const generated = Arr.map(
			drawsOf(seed, `text/contained ${family.name} patterns`, patternOver(family.alphabet), 16),
			(source, i): readonly [string, Flags] => [source, i % 2 === 0 ? "u" : "su"]
		)
		for (const [pi, [source, flags]] of [...family.patterns, ...generated].entries()) {
			/** Only admitted patterns: a refused one has no host type to contain anything. */
			const result = analyzeText(source, flags, SourceLoc("str.regex", [family.name, pi]))
			if (!result.ok) {
				continue
			}
			/**
			 * The pattern's own members: the first 12 distinct walks of 480 over its host NFA, a walk that got stuck none.
			 */
			const walks = drawsOf(
				seed,
				`text/contained ${family.name} ${pi} walks`,
				walkGen(result.value.nfa),
				480
			)
			const own = [...new Set(Arr.flatMap(walks, (w) => (w === undefined ? [] : [w])))].slice(0, 12)
			const members = [
				...new Set(Arr.filter([...strings, ...own], (v) => jsAccepts(source, flags, v)))
			].slice(0, 24)
			const name = `p${fi}_${pi}`
			lines.push(
				`export const ${name} = str.regex(${JSON.stringify(source)}, ${JSON.stringify(flags)})`
			)
			for (const [i, v] of members.entries()) {
				lines.push(`export const ${name}_${i}: Infer<typeof ${name}> = ${JSON.stringify(v)}`)
			}
			patterns += 1
			values += members.length
		}
		contributed.push({ family: family.name, patterns, values })
	}
	for (const [ki, { source, flags, members }] of kept.entries()) {
		for (const v of members) {
			if (!jsAccepts(source, flags, v)) {
				throw new Error(`${source} does not accept ${v}`)
			}
		}
		const name = `kept${ki}`
		lines.push(
			`export const ${name} = str.regex(${JSON.stringify(source)}, ${JSON.stringify(flags)})`
		)
		for (const [i, v] of members.entries()) {
			lines.push(`export const ${name}_${i}: Infer<typeof ${name}> = ${JSON.stringify(v)}`)
		}
	}
	contributed.push({
		family: "kept",
		patterns: kept.length,
		values: Arr.reduce(kept, 0, (n, k) => n + k.members.length)
	})
	return { source: `${Arr.join(lines, "\n")}\n`, families: contributed }
}
