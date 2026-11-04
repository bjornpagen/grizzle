import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore, type Kept } from "@grizzle/testing/explore"
import { noCoverage, required, requiredInSpace } from "@grizzle/testing/features"
import { array, element, type Gen, int, map, oneOf, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Option, String as Str } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import { regexMaxNodes } from "#compiler/core/policy.ts"
import { parsePattern } from "#compiler/text/parse.ts"
import {
	accepts,
	analyzeLanguage,
	analyzeText,
	refinementBounds,
	type TextRefinement,
	textLimits
} from "#compiler/text/refinement.ts"
import { assert, nonEmpty } from "#test/support/assert.ts"
import { pickGen } from "#test/support/pick.ts"
import {
	type Flags,
	families,
	finitePatternOver,
	flagsGen,
	jsAccepts,
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
	const result = analyzeText(source, flags, loc)
	if (!result.ok) {
		throw new Error(`/${source}/${flags}: ${result.error.message}`)
	}
	return result.value
}

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).length
const codePointLength = (value: string): number => Arr.fromIterable(value).length

/**
 * A family, a pattern over its alphabet, flags, and strings over its alphabet. One pattern in ten is an anchored
 * alternation of literals, a finite language, which the general patterns all but never are.
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
				[1, finitePatternOver(family.alphabet)]
			])
		),
		flags: source.draw(flagsGen),
		strings: source.draw(array(stringsOver(family.alphabet, 8), { min: 1, max: 24 }))
	}
}

/**
 * The language a generated pattern recognizes may be empty, which analyzeText refuses; a generated pattern may also
 * exceed the compile-space budgets (ResourceBound), most often by its anchors. Both are refusals, not lowerings, so the
 * membership checks skip them; the refusals themselves are pinned in parse.test.ts. Emptiness is the language's own
 * classification (refinement.ts analyzeLanguage), never a refusal's text.
 */
const refineOrEmpty = (source: string, flags: Flags): TextRefinement | "empty" | "bound" => {
	const result = analyzeText(source, flags, loc)
	if (result.ok) {
		return result.value
	}
	if (result.error.reason._tag === "ResourceBound") {
		return "bound"
	}
	const limits = textLimits(regexMaxNodes)
	const parsed = parsePattern(source, flags, limits)
	if (parsed.ok && analyzeLanguage(parsed.value, limits).kind === "empty") {
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
		note: "V8 in Node 26.11 misses an unanchored match of a class reaching the supplementary planes followed by $ under the u flag, so the ECMAScript development oracle (jsAccepts) refused U+10FFFF for /[^]$/u; jsAccepts spells the search as ^[\\s\\S]*?(?:source)",
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
					const found = Arr.findFirst(
						[
							"",
							...points,
							...pairs,
							...Arr.map(points, (a) => Str.repeat(9)(a)),
							String.fromCodePoint(0xe000),
							String.fromCodePoint(0x10ffff)
						],
						(x) => !jsAccepts(p.source, p.flags, x)
					)
					if (Option.isNone(found)) {
						throw new Error(`${p.label} refuses no planted candidate`)
					}
					const s = found.value
					return {
						note: `${p.label} on ${JSON.stringify(s)}`,
						sketch: [p, { witness: false, s }],
						draws: "",
						reaches: [`${p.label} refuses`]
					}
				}
			)
			const familyCaseGen: Gen<FamilyCase> = oneOf(
				Arr.map(admitted, (p): Gen<FamilyCase> => {
					const drawnString = oneOf<FamilyCase[1]>([
						map(stringsOver(p.family.alphabet, 8), (s) => ({ witness: false, s })),
						map(walkGen(p.r.nfa), (s) => ({ witness: true, s }))
					])
					return (source) => [p, source.draw(drawnString)]
				})
			)
			return searched(
				ctx,
				explore(
					{
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
						caseHang: Duration.minutes(2)
					},
					([p, drawnString], c) =>
						Effect.sync(() => {
							if (drawnString.s === undefined) {
								return
							}
							const js = jsAccepts(p.source, p.flags, drawnString.s)
							const label = `${p.label} on ${Formatter.format(drawnString.s)}`
							assert.equal(accepts(p.r, drawnString.s), js, label)
							if (drawnString.witness) {
								assert.equal(js, true, `${label}: a witness is a member`)
							}
							c.note(`${p.label} ${js ? "accepts" : "refuses"}`)
						})
				)
			)
		}
	)

	it.effect("on 2,000 generated patterns", (ctx) =>
		searched(
			ctx,
			explore(
				{
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
					caseHang: Duration.minutes(2)
				},
				({ source, flags, strings, walks }, c) =>
					Effect.sync(() => {
						const r = refineOrEmpty(source, flags)
						if (r === "bound") {
							return
						}
						c.note(r === "empty" ? "empty" : "admitted")
						for (const s of strings) {
							const expected = jsAccepts(source, flags, s)
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
							const w = walk(r.nfa, tape, walkLength)
							if (w === undefined) {
								continue
							}
							c.note("witness")
							assert.equal(jsAccepts(source, flags, w), true)
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
						caseHang: Duration.minutes(2)
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
					caseHang: Duration.minutes(2)
				},
				({ source, flags, strings }, c) =>
					Effect.sync(() => {
						const r = refineOrEmpty(source, flags)
						if (r === "empty" || r === "bound") {
							return
						}
						const check = r.check
						if (check.kind === "tautology") {
							c.note("tautology")
							for (const s of strings) {
								assert.equal(jsAccepts(source, flags, s), true)
							}
						}
						if (check.kind === "finite") {
							c.note("finite")
							for (const m of check.members) {
								assert.equal(jsAccepts(source, flags, m), true)
							}
							for (const s of strings) {
								assert.equal(check.members.includes(s), jsAccepts(source, flags, s))
							}
							assert.equal(new Set(check.members).size, check.members.length)
						}
						const bounds = refinementBounds(r)
						if (bounds !== undefined) {
							c.note("bounded")
							for (const s of strings) {
								if (jsAccepts(source, flags, s)) {
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
					caseHang: Duration.minutes(2)
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
						for (const s of strings) {
							assert.equal(jsAccepts(a, flags, s), jsAccepts(b, flags, s))
						}
					})
			)
		)
	)
})

describe("language-equivalent spellings share one canonical key", () => {
	/** Spellings of one language each: a handwritten edge dictionary, like the families. */
	type Group = 0 | 1 | 2 | 3 | 4 | 5
	type Spelling = readonly [source: string, flags: Flags]
	const groups: Arr.NonEmptyReadonlyArray<readonly [Group, Arr.NonEmptyReadonlyArray<Spelling>]> = [
		[
			0,
			[
				["^(?:draft|published)$", "u"],
				["^(published|draft)$", "u"],
				["^(?:dra(?:ft)|publ(i)shed)$", "su"],
				["^draft$|^published$", "u"]
			]
		],
		[
			1,
			[
				["^\\d{2}-\\d{7}$", "u"],
				["^[0-9][0-9]-[0-9]{7}$", "u"],
				["^[0-9]{2}-[0-9]{6}\\d$", "su"]
			]
		],
		[
			2,
			[
				["^[a-z][a-z0-9-]*$", "u"],
				["^[a-z](?:[a-z]|[0-9]|-)*$", "u"],
				["^[a-z][-a-z0-9]{0,}$", "su"]
			]
		],
		[
			3,
			[
				["^.*$", "su"],
				["", "u"],
				["^[^]*$", "u"],
				["a*", "u"],
				["()", "u"]
			]
		],
		[
			4,
			[
				["draft", "u"],
				["(?:draft)", "su"],
				["dra(f)t", "u"]
			]
		],
		[
			5,
			[
				["^\\w+$", "u"],
				["^[A-Za-z0-9_]+$", "u"],
				["^[_\\da-zA-Z]+$", "u"],
				["^\\w\\w*$", "su"]
			]
		]
	]

	/**
	 * An ordered pair of two members: the first any member, the second any other, so every ordered pair of two is one
	 * case and an enumeration discards none.
	 */
	const twoOf =
		<A>(members: Arr.NonEmptyReadonlyArray<A>): Gen<readonly [A, A]> =>
		(source) => {
			const first = source.draw(int(0, members.length - 1))
			const second = source.draw(int(0, members.length - 2))
			return [
				Arr.getUnsafe(members, first),
				Arr.getUnsafe(members, second < first ? second : second + 1)
			] as const
		}

	it.effect("gives every two spellings in a group one key", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/text/spelling-groups",
					generator: oneOf(
						Arr.map(groups, ([group, spellings]) =>
							map(twoOf(spellings), (pair) => [group, pair] as const)
						)
					),
					literal: Formatter.format,
					/** The space: every ordered pair of two members of a group, 12 + 6 + 6 + 20 + 6 + 12. */
					limit: 62,
					coverage: requiredInSpace<`group ${Group}`>(
						Arr.map(groups, ([group]): `group ${Group}` => `group ${group}`)
					),
					caseHang: Duration.minutes(2)
				},
				([group, [[aSource, aFlags], [bSource, bFlags]]], c) =>
					Effect.sync(() => {
						c.note(`group ${group}`)
						assert.equal(refine(aSource, aFlags).key, refine(bSource, bFlags).key)
					})
			)
		)
	)
})
