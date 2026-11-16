import type { Situations } from "@bjornpagen/testing/features"
import { codePoint, element, type Gen, int, string } from "@bjornpagen/testing/gen"
import type { Source } from "@bjornpagen/testing/source"
import { Array as Arr } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import { upTo } from "#test/support/up-to.ts"
import { batchOwned, caseOwned, type Program } from "#test/types/batch/batch.ts"

/**
 * The testing library's vocabulary contract (@bjornpagen/testing features and explore): a suite's situations are a closed
 * union of literal names, so a misspelt name is a type error, never a requirement nothing can meet. The oracle is
 * membership in the drawn vocabulary: a required situation, a pair, a note and a kept case's reaches typecheck
 * exactly when every name they hold is a member, the situations are at least one, a kept case reaches one at least,
 * and the vocabulary is a union of literals, never `string`.
 *
 * A case draws a vocabulary of short lowercase names and, beside its members, a stranger longer than every member, so
 * never one. Each probe stands on one line, under a `refused` directive exactly where the oracle refuses it: the
 * contract is that the probe does not compile, whichever diagnostic the checker elaborates it to.
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
export interface VocabularyCase {
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

/** A stranger: longer than every member, so no member is one. */
const strangerGen: Gen<string> = string(codePoint(0x61, 0x7a), { min: 7, max: 9 })

const coin = (source: Source, odds: number): boolean => source.draw(int(1, odds)) === 1

/** A drawn vocabulary, a stranger to it, each probe's names, and the fault it plants, if any. */
export const vocabularyCases: Gen<VocabularyCase> = (source) => {
	const first = source.draw(member)
	const rest = Arr.map(
		upTo(source.draw(int(1, 3)), (i) => i + 1),
		() => source.draw(member)
	)
	const members: Arr.NonEmptyReadonlyArray<string> = [
		first,
		...Arr.filter(Arr.dedupe(rest), (m) => m !== first)
	]
	const stranger = source.draw(strangerGen)
	const pick = (): string => source.draw(element(members))
	const fault = coin(source, 3) ? source.draw(element(faults)) : undefined
	const situation = (): string | readonly [string, string] =>
		coin(source, 3) ? [pick(), pick()] : pick()
	const required = Arr.map(
		upTo(source.draw(int(1, 3)), (i) => i + 1),
		situation
	)
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

/** What a case reaches: its fault, or admitted, and a required pair. */
export const vocabularyNotes = (c: VocabularyCase): ReadonlyArray<VocabularyNote> => [
	c.fault ?? "admitted",
	...(Arr.some(c.required, (s) => typeof s !== "string") ? ["a required pair" as const] : [])
]

/** The situations the witnesses reach: every fault, an admitted case and a required pair. */
export const vocabularyRequired: Situations<VocabularyNote> = [
	"admitted",
	"a required pair",
	...faults
]

const situationSource = (s: string | readonly [string, string]): string =>
	typeof s === "string" ? jsonText(s) : `[${jsonText(s[0])}, ${jsonText(s[1])}]`

/** Whether a situation names only members of the case's closed vocabulary. */
const admits = (c: VocabularyCase, s: string | readonly [string, string]): boolean =>
	!c.open &&
	(typeof s === "string"
		? Arr.contains(c.members, s)
		: Arr.contains(c.members, s[0]) && Arr.contains(c.members, s[1]))

/** One case's statements: its vocabulary, then each probe on one line, refused where the oracle refuses it. */
const blockOf = (c: VocabularyCase, i: number): ReadonlyArray<string> => {
	const probe = (refused: boolean, why: string, line: string): ReadonlyArray<string> => [
		...(refused ? [`// @ts-expect-error -- refused: ${why}`] : []),
		line
	]
	return [
		`type V${i} = ${c.open ? "string" : Arr.join(Arr.map(c.members, jsonText), " | ")}`,
		...probe(
			!Arr.isReadonlyArrayNonEmpty(c.required) || !Arr.every(c.required, (s) => admits(c, s)),
			"a requirement names one situation at least, each a literal of the vocabulary",
			`export const q${i} = required<V${i}>([${Arr.join(Arr.map(c.required, situationSource), ", ")}], { cases: 1, sense: notesOnly })`
		),
		...probe(
			c.fault === "a stranger noted",
			"a note outside the suite's vocabulary",
			`export const n${i} = (c: Case<V${i}>) => c.note(${jsonText(c.note)})`
		),
		...probe(
			c.fault === "a stranger paired",
			"a pair outside the suite's vocabulary",
			`export const r${i} = (c: Case<V${i}>) => c.pair(${jsonText(c.pair[0])}, ${jsonText(c.pair[1])})`
		),
		...probe(
			c.fault === "a kept stranger" || c.fault === "a kept case reaching nothing",
			"a kept case reaches one feature at least, each of the vocabulary",
			`export const k${i}: Kept<number, V${i}> = { note: "a kept case", sketch: 3, draws: "", reaches: [${Arr.join(Arr.map(c.reaches, jsonText), ", ")}] }`
		),
		""
	]
}

/** The vocabulary contract's imports, each a library module a block reads. */
const vocabularyImports: ReadonlyArray<string> = [
	"// Generated by test/types/harness/vocabulary.ts: the testing library's vocabulary contract.",
	'import type { Case, Kept } from "@bjornpagen/testing/explore"',
	'import { required } from "@bjornpagen/testing/features"',
	'import { notesOnly } from "@bjornpagen/testing/sense"',
	""
]

/** The program over a batch's vocabularies: one module, each case a block, the library's imports the batch's own. */
export const vocabularyProgram = (cases: Arr.NonEmptyReadonlyArray<VocabularyCase>): Program => [
	{
		file: "index.ts",
		parts: [
			{ owner: batchOwned, lines: vocabularyImports },
			...Arr.map(cases, (c, at) => ({ owner: caseOwned(at), lines: blockOf(c, at) }))
		]
	}
]
