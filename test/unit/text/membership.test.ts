import { describe, it } from "@effect/vitest"
import { drawn, explore, type Kept } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import {
	array,
	element,
	filter,
	type Gen,
	map,
	oneOf,
	shuffled,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import { codePoints } from "#compiler/core/text.ts"
import { buildNfa } from "#compiler/scalar/regex/nfa.ts"
import { parsePattern } from "#compiler/scalar/regex/parse.ts"
import { analyzeText, type TextRefinement } from "#compiler/text/refinement.ts"
import { assert, nonEmpty } from "#test/support/assert.ts"
import { accepts, analyzeLanguage } from "#test/support/fixtures/ir/scalar.ts"
import { caseHang } from "#test/support/limits.ts"
import { pickGen } from "#test/support/pick.ts"
import { refinementBounds } from "#test/support/text.ts"
import {
	type Flags,
	families,
	finiteLanguageOver,
	flagsGen,
	jsMatcher,
	patternOver,
	stringsOver,
	walk,
	walkGen,
	walkLength,
	walkTape
} from "#test/unit/text/generators.ts"
import {
	type PlantedFeature,
	plantedFault,
	plantedFeature,
	plantedTextGen,
	plantedValue
} from "#test/unit/values/support.ts"

/**
 * Host membership and the bounded language proofs, against ECMAScript as the development oracle.
 *
 * The host NFA must agree with `new RegExp(source, flags).test` on every admitted pattern and admitted string. Every
 * fact the analysis claims must hold on the same samples: a tautology accepts every string, a finite language is
 * exactly its members, a bound bounds every member, and equal canonical keys never disagree. RegExp appears only here,
 * never under src/.
 */
const loc = SourceLoc("str.regex", ["test"])

const refine = (source: string, flags: Flags): TextRefinement => {
	const result = analyzeText([{ source, flags }], loc)
	if (!result.ok) {
		throw new Error(`/${source}/${flags}: ${result.error.message}`)
	}
	return result.value
}

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).length
const codePointLength = (value: string): number => Arr.fromIterable(value).length

/**
 * A family, a pattern over its alphabet, flags, and strings over its alphabet. One pattern in ten spells a finite
 * language, which the general patterns all but never are.
 */
const caseGen: Gen<{
	readonly source: string
	readonly flags: Flags
	readonly strings: ReadonlyArray<string>
}> = (source) => {
	const family = source.draw(element(families))
	return {
		source: source.draw(
			weighted([
				[9, patternOver(family.alphabet)],
				[1, map(finiteLanguageOver(family.alphabet), (language) => language.source)]
			])
		),
		flags: source.draw(flagsGen),
		strings: source.draw(array(stringsOver(family.alphabet, 8), { min: 1, max: 24 }))
	}
}

/**
 * The language a generated pattern recognizes may be empty, which analyzeText refuses; a generated pattern may also
 * exceed the compile-space budgets (ResourceBound), most often by its anchors. Both are refusals, not lowerings, so the
 * membership checks skip them; the refusals themselves are pinned in parse.test.ts and compile-space.test.ts. Emptiness is the language's own
 * classification (the IR fixtures' analyzeLanguage), never a refusal's text.
 */
const refineOrEmpty = (source: string, flags: Flags): TextRefinement | "empty" | "bound" => {
	const result = analyzeText([{ source, flags }], loc)
	if (result.ok) {
		return result.value
	}
	if (result.error.reason._tag === "ResourceBound") {
		return "bound"
	}
	const parsed = parsePattern(source, flags)
	if (parsed.ok && analyzeLanguage(parsed.value).kind === "empty") {
		return "empty"
	}
	throw new Error(`/${source}/${flags}: ${result.error.message}`)
}

/**
 * A generated case as a person promotes it from a failure report: the pattern, its flags, strings over the family's
 * alphabet, and walk tapes, resolved against the pattern's NFA in the property into members of its own language.
 */
interface PatternSketch {
	readonly source: string
	readonly flags: Flags
	readonly strings: ReadonlyArray<string>
	readonly walks: ReadonlyArray<ReadonlyArray<number>>
}

type GeneratedFeature = "admitted" | "empty" | "witness"

const patternSketchGen: Gen<PatternSketch> = (source) => {
	const family = source.draw(element(families))
	return {
		source: source.draw(patternOver(family.alphabet)),
		flags: source.draw(flagsGen),
		strings: source.draw(array(stringsOver(family.alphabet, 8), { min: 1, max: 24 })),
		walks: source.draw(array(array(pickGen, { min: 0, max: walkTape }), { min: 0, max: 8 }))
	}
}

const kept: ReadonlyArray<Kept<PatternSketch, GeneratedFeature>> = [
	{
		note: "V8 in Node 26.11 misses an unanchored match of a class reaching the supplementary planes followed by $ under the u flag, so the ECMAScript development oracle (jsMatcher) refused U+10FFFF for /[^]$/u; jsMatcher spells the search as ^[\\s\\S]*?(?:source)",
		sketch: { source: "[^]$", flags: "u", strings: ["\u{10FFFF}"], walks: [] },
		draws: "",
		reaches: ["admitted"]
	}
]

/** The handwritten family patterns, each feature a pattern's label: its family, its source and its flags. */
type FamilyFeature = `${string} accepts` | `${string} refuses`

describe("host NFA membership equals ECMAScript", () => {
	it.effect(
		"on the handwritten family patterns, over their families' strings and walks of their own NFA, every pattern accepting and refusing",
		(ctx) => {
			/** Each admitted pattern with its NFA, and the label its features carry. */
			const patterns = Arr.flatMap(families, (family) =>
				Arr.flatMap(family.patterns, ([source, flags]) => {
					const r = refineOrEmpty(source, flags)
					assert.notEqual(r, "bound", `${family.name} /${source}/${flags} is admitted or empty`)
					return typeof r === "string"
						? []
						: [{ family, source, flags, r, label: `${family.name} /${source}/${flags}` }]
				})
			)
			const admitted = nonEmpty(patterns, "the families hold admitted patterns")
			/**
			 * Planted: each pattern that is no tautology on the first string it refuses among the empty string, its family's
			 * code points alone, in pairs and nine times over, and two code points outside every family's alphabet, since a
			 * pattern's share of the cases meets a refused string only a few times a run for some.
			 */
			type FamilyCase = [
				(typeof patterns)[number],
				{ readonly witness: boolean; readonly s: string | undefined }
			]
			const refusals = Arr.map(
				Arr.filter(patterns, (p) => p.r.check.kind !== "tautology"),
				(p): Kept<FamilyCase, FamilyFeature> => {
					const points = Arr.map(p.family.alphabet, (c) => String.fromCodePoint(c))
					const pairs = Arr.flatMap(points, (a) => Arr.map(points, (b) => `${a}${b}`))
					const ofPattern = jsMatcher(p.source, p.flags)
					const found = Arr.findFirst(
						[
							"",
							...points,
							...pairs,
							...Arr.map(points, (a) => Str.repeat(9)(a)),
							String.fromCodePoint(0xe000),
							String.fromCodePoint(0x10ffff)
						],
						(x) => !ofPattern(x)
					)
					if (Option.isNone(found)) {
						throw new Error(`${p.label} refuses no planted candidate`)
					}
					const s = found.value
					return {
						note: `${p.label} on ${Formatter.format(s)}`,
						sketch: [p, { witness: false, s }],
						draws: "",
						reaches: [`${p.label} refuses`]
					}
				}
			)
			/**
			 * Each refusing pattern's planted refused string, by its label: the string a steered case tries where its
			 * pattern's refusal is still pending, so a few of the pattern's cases reach it rather than leave it to chance.
			 */
			const plantedRefusal = new Map(
				Arr.map(refusals, (k): readonly [string, FamilyCase[1]] => [k.sketch[0].label, k.sketch[1]])
			)
			const familyCaseGen: Gen<FamilyCase> = oneOf(
				Arr.map(admitted, (p): Gen<FamilyCase> => {
					const drawnString = oneOf<FamilyCase[1]>([
						map(stringsOver(p.family.alphabet, 8), (s) => ({ witness: false, s })),
						map(walkGen(buildNfa(p.r.members[0].ir)), (s) => ({ witness: true, s }))
					])
					return (source) => [p, source.draw(drawnString)]
				})
			)
			return searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/text/membership-families",
						draw: drawn(familyCaseGen),
						literal: Formatter.format,
						coverage: required<FamilyFeature>(
							[
								...Arr.map(
									nonEmpty(patterns, "the families' admitted patterns"),
									(p): FamilyFeature => `${p.label} accepts`
								),
								...Arr.map(
									Arr.filter(patterns, (p) => p.r.check.kind !== "tautology"),
									(p): FamilyFeature => `${p.label} refuses`
								)
							],
							{ cases: 6000, sense: notesOnly }
						),
						kept: refusals,
						runs: 6000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([p, drawnString], c) =>
						Effect.sync(() => {
							const subject = Option.getOrElse(
								Option.flatMap(c.steering, (pending) =>
									pending.has(`${p.label} refuses`)
										? Option.fromNullishOr(plantedRefusal.get(p.label))
										: Option.none()
								),
								() => drawnString
							)
							if (subject.s === undefined) {
								return
							}
							const js = jsMatcher(p.source, p.flags)(subject.s)
							const label = `${p.label} on ${Formatter.format(subject.s)}`
							assert.equal(accepts(p.r, subject.s), js, label)
							if (subject.witness) {
								assert.equal(js, true, `${label}: a witness is a member`)
							}
							c.note(`${p.label} ${js ? "accepts" : "refuses"}`)
						})
				)
			)
		}
	)

	it.effect("on generated patterns", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: { kind: "unstated" },
					suite: "unit/text/membership-5129793",
					draw: drawn(patternSketchGen),
					literal: Formatter.format,
					coverage: required<GeneratedFeature>(["admitted", "empty", "witness"], {
						cases: 2000,
						sense: notesOnly
					}),
					kept,
					runs: 2000,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				({ source, flags, strings, walks }, c) =>
					Effect.sync(() => {
						const r = refineOrEmpty(source, flags)
						if (r === "bound") {
							return
						}
						c.note(r === "empty" ? "empty" : "admitted")
						const ofPattern = jsMatcher(source, flags)
						for (const s of strings) {
							const expected = ofPattern(s)
							if (r === "empty") {
								assert.equal(expected, false)
							} else {
								assert.equal(accepts(r, s), expected)
							}
						}
						if (r === "empty") {
							return
						}
						for (const tape of walks) {
							const w = walk(buildNfa(r.members[0].ir), tape, walkLength)
							if (w === undefined) {
								continue
							}
							c.note("witness")
							assert.equal(ofPattern(w), true)
							assert.equal(accepts(r, w), true)
						}
					})
			)
		)
	)

	/** Every handwritten family pattern. */
	const familyPatterns = nonEmpty(
		Arr.flatMap(families, (family) => family.patterns),
		"the families hold patterns"
	)

	it.effect(
		"accepts no string that is not admitted text, under every family's patterns, and the tautology every admitted one",
		(ctx) => {
			const tautology = refine("^.*$", "su")
			return searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/text/membership-admitted",
						draw: drawn(
							(source) =>
								[source.draw(plantedTextGen), source.draw(element(familyPatterns))] as const
						),
						literal: Formatter.format,
						coverage: required<PlantedFeature>(
							["live", "nul middle", "lone high middle", "lone low middle", "reversed pair middle"],
							{ cases: 1000, sense: notesOnly }
						),
						kept: [],
						runs: 1000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([planted, [source, flags]], c) =>
						Effect.sync(() => {
							const value = plantedValue(planted)
							if (typeof value !== "string") {
								return
							}
							c.note(plantedFeature(planted))
							const admitted = plantedFault(planted) === undefined
							assert.equal(accepts(tautology, value), admitted)
							const r = refineOrEmpty(source, flags)
							if (!admitted && typeof r !== "string") {
								assert.equal(accepts(r, value), false, `/${source}/${flags}`)
							}
						})
				)
			)
		}
	)
})

describe("every claimed fact holds on the samples", () => {
	it.effect("tautologies accept, finite languages are exactly their members, bounds bound", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: { kind: "unstated" },
					suite: "unit/text/membership-4604227",
					draw: drawn(caseGen),
					literal: Formatter.format,
					coverage: required<"tautology" | "finite" | "bounded">(
						["tautology", "finite", "bounded"],
						{ cases: 2000, sense: notesOnly }
					),
					kept: [],
					runs: 2000,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				({ source, flags, strings }, c) =>
					Effect.sync(() => {
						const r = refineOrEmpty(source, flags)
						if (r === "empty" || r === "bound") {
							return
						}
						const check = r.check
						const ofPattern = jsMatcher(source, flags)
						if (check.kind === "tautology") {
							c.note("tautology")
							for (const s of strings) {
								assert.equal(ofPattern(s), true)
							}
						}
						if (check.kind === "finite") {
							c.note("finite")
							for (const m of check.members) {
								assert.equal(ofPattern(m), true)
							}
							for (const s of strings) {
								assert.equal(check.members.includes(s), ofPattern(s))
							}
							assert.equal(new Set(check.members).size, check.members.length)
						}
						const bounds = refinementBounds(r)
						if (bounds !== undefined) {
							c.note("bounded")
							for (const s of strings) {
								if (ofPattern(s)) {
									assert.ok(codePointLength(s) <= bounds.length)
									assert.ok(utf8Bytes(s) <= bounds.bytes)
								}
							}
						}
					})
			)
		)
	)

	it.effect("equal canonical keys never disagree", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: { kind: "unstated" },
					suite: "unit/text/membership-4932953",
					draw: drawn((source) => {
						const family = source.draw(element(families))
						return {
							a: source.draw(patternOver(family.alphabet)),
							b: source.draw(patternOver(family.alphabet)),
							flags: source.draw(flagsGen),
							strings: source.draw(array(stringsOver(family.alphabet, 8), { min: 1, max: 24 }))
						}
					}),
					literal: Formatter.format,
					coverage: noCoverage,
					kept: [],
					runs: 2000,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				({ a, b, flags, strings }) =>
					Effect.sync(() => {
						const x = refineOrEmpty(a, flags)
						const y = refineOrEmpty(b, flags)
						if (
							x === "empty" ||
							y === "empty" ||
							x === "bound" ||
							y === "bound" ||
							x.key !== y.key
						) {
							return
						}
						assert.equal(x.digest, y.digest)
						const ofA = jsMatcher(a, flags)
						const ofB = jsMatcher(b, flags)
						for (const s of strings) {
							assert.equal(ofA(s), ofB(s))
						}
					})
			)
		)
	)
})

describe("language-equivalent spellings share one canonical key", () => {
	/** A spelling of a finite language as the alternation of its members, each code point its braced escape. */
	const memberSpelling = (members: ReadonlyArray<string>): string =>
		`^(?:${Arr.join(
			Arr.map(members, (m) =>
				Arr.join(
					Arr.map(codePoints(m), (c) => `\\u{${c.toString(16)}}`),
					""
				)
			),
			"|"
		)})$`

	/**
	 * A finite language of at most 48 members over a family's alphabet, its pattern's flags, and its members in a drawn
	 * order under flags of their own: two spellings of one language, which share no syntax but its anchors.
	 */
	const twoSpellings: Gen<{
		readonly language: { readonly source: string; readonly flags: Flags }
		readonly members: { readonly source: string; readonly flags: Flags }
		readonly count: number
		readonly withEmpty: boolean
	}> = (source) => {
		const { alphabet } = source.draw(element(families))
		const language = source.draw(
			filter(finiteLanguageOver(alphabet), (l) => l.members.length <= 48, 8)
		)
		const order = source.draw(
			shuffled(language.members, { min: language.members.length, max: language.members.length })
		)
		return {
			language: { source: language.source, flags: source.draw(flagsGen) },
			members: { source: memberSpelling(order), flags: source.draw(flagsGen) },
			count: language.members.length,
			withEmpty: language.members.includes("")
		}
	}

	type SpellingFeature = "one member" | "several members" | "the empty text a member"

	it.effect(
		"gives a finite language's pattern and the alternation of its members in any order one key",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/text/spelling-pairs",
						draw: drawn(twoSpellings),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "a finite language's members, which its pattern's construction gives"
						},
						coverage: required<SpellingFeature>(
							["one member", "several members", "the empty text a member"],
							{ cases: 400, sense: notesOnly }
						),
						kept: [],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ language, members, count, withEmpty }, c) =>
						Effect.sync(() => {
							c.note(count === 1 ? "one member" : "several members")
							if (withEmpty) {
								c.note("the empty text a member")
							}
							assert.equal(
								refine(language.source, language.flags).key,
								refine(members.source, members.flags).key,
								`/${language.source}/${language.flags} and /${members.source}/${members.flags}`
							)
						})
				)
			)
	)
})
