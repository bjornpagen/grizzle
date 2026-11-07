import { floorPopulation, type Situations } from "@grizzle/testing/features"
import { codePoint, element, type Gen, int, string } from "@grizzle/testing/gen"
import { floorSeed, rotatingSeed } from "@grizzle/testing/random"
import { sample, type Source } from "@grizzle/testing/source"
import { Array as Arr } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"

/**
 * The testing library's vocabulary contract (@grizzle/testing features and explore): a suite's situations are a closed
 * union of literal names, so a misspelt name is a type error, never a requirement nothing can meet. The oracle is
 * membership in the drawn vocabulary: a required situation, a pair, a note and a kept case's reaches typecheck
 * exactly when every name they hold is a member, the situations are at least one, a kept case reaches one at least,
 * and the vocabulary is a union of literals, never `string`.
 *
 * A case draws a vocabulary of short lowercase names and, beside its members, a stranger long enough that no member
 * is within the checker's spelling suggestion of it, so a stranger's refusal is the plain one. Each probe stands on a
 * line of its own, under its refusal's directive where the oracle refuses it: no situation at the call (TS2345); a
 * required situation outside the vocabulary, or any of an open one, at the first situation where that one is refused
 * (TS2322), the checker reading the list's first situation by its own place, and at the call where only a later one
 * is (TS2345), the checker reading the rest as one element type; a note or a pair outside the vocabulary at the call
 * (TS2345); and a kept case reaching a stranger or nothing at its reaches (TS2322).
 */
const faults = [
	"a required stranger",
	"no situation",
	"an open vocabulary",
	"a stranger noted",
	"a stranger paired",
	"a kept stranger",
	"a kept case reaching nothing"
] as const
type Fault = (typeof faults)[number]

export type VocabularyNote = Fault | "admitted" | "a required pair"

/** One case: its vocabulary, a stranger, each probe's names, and the fault it plants, if any. */
interface VocabularyCase {
	readonly members: Arr.NonEmptyReadonlyArray<string>
	readonly stranger: string
	readonly required: ReadonlyArray<string | readonly [string, string]>
	readonly note: string
	readonly pair: readonly [string, string]
	readonly reaches: ReadonlyArray<string>
	readonly open: boolean
	readonly fault: Fault | undefined
}

const member: Gen<string> = string(codePoint(0x61, 0x7a), { min: 3, max: 6 })
const strangerGen: Gen<string> = string(codePoint(0x61, 0x7a), { min: 14, max: 16 })

const coin = (source: Source, odds: number): boolean => source.draw(int(1, odds)) === 1

const caseGen: Gen<VocabularyCase> = (source) => {
	const first = source.draw(member)
	const rest = Arr.map(Arr.range(1, source.draw(int(1, 3))), () => source.draw(member))
	const members: Arr.NonEmptyReadonlyArray<string> = [
		first,
		...Arr.filter(Arr.dedupe(rest), (m) => m !== first)
	]
	const stranger = source.draw(strangerGen)
	const pick = (): string => source.draw(element(members))
	const fault = coin(source, 3) ? source.draw(element(faults)) : undefined
	const situation = (): string | readonly [string, string] =>
		coin(source, 3) ? [pick(), pick()] : pick()
	const required = Arr.map(Arr.range(1, source.draw(int(1, 3))), situation)
	const at = source.draw(int(0, required.length))
	return {
		members,
		stranger,
		required:
			fault === "no situation"
				? []
				: fault === "a required stranger"
					? [...Arr.take(required, at), stranger, ...Arr.drop(required, at)]
					: required,
		note: fault === "a stranger noted" ? stranger : pick(),
		pair: fault === "a stranger paired" ? [pick(), stranger] : [pick(), pick()],
		reaches:
			fault === "a kept case reaching nothing"
				? []
				: fault === "a kept stranger"
					? [pick(), stranger]
					: [pick()],
		open: fault === "an open vocabulary",
		fault
	}
}

const notesOf = (c: VocabularyCase): ReadonlyArray<VocabularyNote> => [
	c.fault ?? "admitted",
	...(Arr.some(c.required, (s) => typeof s !== "string") ? ["a required pair" as const] : [])
]

/** The situations the floor's witnesses reach: every fault, an admitted case and a required pair. */
export const vocabularyRequired: Situations<VocabularyNote> = [
	"admitted",
	"a required pair",
	...faults
]

/** The cases the run's own stream draws, beside the floor's witnesses. */
export const vocabularyCount = 60

const vocabularyLabel = "types/harness vocabulary"

export const vocabularyWitnesses = () =>
	floorPopulation(vocabularyLabel, caseGen, vocabularyCount, notesOf)

const situationSource = (s: string | readonly [string, string]): string =>
	typeof s === "string" ? jsonText(s) : `[${jsonText(s[0])}, ${jsonText(s[1])}]`

/** Whether a situation names only members of the case's closed vocabulary. */
const admits = (c: VocabularyCase, s: string | readonly [string, string]): boolean =>
	!c.open &&
	(typeof s === "string"
		? Arr.contains(c.members, s)
		: Arr.contains(c.members, s[0]) && Arr.contains(c.members, s[1]))

/** One case's statements: its vocabulary, and each probe under its refusal's directive. */
const blockOf = (c: VocabularyCase, i: number): ReadonlyArray<string> => {
	const directive = (refused: boolean, line: string): ReadonlyArray<string> =>
		refused ? [line] : []
	const [first, ...later] = c.required
	const firstRefused = first !== undefined && !admits(c, first)
	const laterRefused = Arr.some(later, (s) => !admits(c, s))
	return [
		`type V${i} = ${c.open ? "string" : Arr.join(Arr.map(c.members, jsonText), " | ")}`,
		...directive(
			first === undefined,
			"// @ts-expect-error -- TS2345: a requirement names one situation at least"
		),
		...directive(
			!firstRefused && laterRefused,
			"// @ts-expect-error -- TS2345: a required situation outside the vocabulary"
		),
		`export const q${i} = required<V${i}>([`,
		...Arr.flatMap(c.required, (s, at) => [
			...directive(
				at === 0 && firstRefused,
				c.open
					? "\t// @ts-expect-error -- TS2322: a requirement takes literal names, never string"
					: "\t// @ts-expect-error -- TS2322: a required situation outside the vocabulary"
			),
			`\t${situationSource(s)},`
		]),
		"], { cases: 1, sense: notesOnly })",
		...directive(
			c.fault === "a stranger noted",
			"// @ts-expect-error -- TS2345: a note outside the suite's vocabulary"
		),
		`export const n${i} = (c: Case<V${i}>) => c.note(${jsonText(c.note)})`,
		...directive(
			c.fault === "a stranger paired",
			"// @ts-expect-error -- TS2345: a pair outside the suite's vocabulary"
		),
		`export const r${i} = (c: Case<V${i}>) => c.pair(${jsonText(c.pair[0])}, ${jsonText(c.pair[1])})`,
		`export const k${i}: Kept<number, V${i}> = {`,
		'\tnote: "a kept case",',
		"\tsketch: 3,",
		'\tdraws: "",',
		...directive(
			c.fault === "a kept stranger" || c.fault === "a kept case reaching nothing",
			"\t// @ts-expect-error -- TS2322: a kept case reaches one feature at least, each of the vocabulary"
		),
		`\treaches: [${Arr.join(Arr.map(c.reaches, jsonText), ", ")}]`,
		"}",
		""
	]
}

/** The program over the run's cases: one module. */
export const vocabularyModule = (seed: number): string =>
	Arr.join(
		[
			"// Generated by test/types/harness/vocabulary.ts: the testing library's vocabulary contract.",
			'import type { Case, Kept } from "@grizzle/testing/explore"',
			'import { required } from "@grizzle/testing/features"',
			'import { notesOnly } from "@grizzle/testing/sense"',
			"",
			...Arr.flatMap(
				[
					...vocabularyWitnesses().values,
					...sample(caseGen, rotatingSeed(seed, floorSeed(vocabularyLabel)), vocabularyCount)
				],
				blockOf
			)
		],
		"\n"
	)
