/**
 * Compute.translate and Compute.lowerAscii, typed and lowered as a check lowers them, and evaluated on the host
 * (scalar/compute/evaluate.ts) and by the reference evaluator (test/support/oracle/evaluate/catalog.ts).
 *
 * - translation: over a drawn map and texts that mix ASCII, other BMP and supplementary code points, both evaluators
 *   give the map applied character by character, and lowerAscii lowers A to Z alone, every other character, non-ASCII
 *   included, passing through unchanged.
 * - the image type: over every regex family's patterns and generated ones, a drawn map's term is text of exactly the
 *   image of the operand's language: a text is a member of the image type exactly when one of its preimages under the
 *   map is a member of the operand's, which ECMAScript's own test of both patterns decides; and an operand whose
 *   pattern bounds its length keeps the bound.
 * - the refusals: a fault planted in a valid translation or collapse, one for each refusal (a map of two lengths, a
 *   repeated character of from, a character no text holds, a term as from or to, a subject that is no text, each at the
 *   builder too, and a translation's subject unbounded in a query, which a collapse of the same subject compiles), each
 *   by its reason and the place it states, and the term without its fault compiles.
 * - casts by inclusion: a translated finite language, its image exactly its members mapped, cast into a drawn text
 *   type compiles exactly when ECMAScript's test of the target holds of every image member; a contract's predicate,
 *   which no language proves, refuses the cast; a collapse is cast into the collapsed texts; any text is no refined
 *   text's; and a language whose own automaton passes the analysis bounds is refused naming them, as text and as a
 *   numeric's lexical form, as is a translated language whose inclusion passes them. Its languages are drawn within
 *   castMembers, a search budget.
 * - collapse and replaceWhitespace: over texts dense in XML's four white space characters beside ones XML does not
 *   count (no-break space, line separator), both evaluators agree with XML Schema's definition, pieces cut at every run
 *   and joined by one space; the term's type holds every collapse of a value of the operand's, exactly the image where
 *   collapseSources says it is, within the operand's length bound; its refusals and its SQL by structure.
 *
 * Oracles: the map applied character by character; ECMAScript's own test of the operand's and the image's patterns;
 * each refusal's reason and place; ECMAScript's test of the target over every image member; XML Schema's whiteSpace
 * collapse; collapseSources' exactness.
 *
 * Features: as each search names them, every route of every property.
 *
 * Plants: compute-translate-units (a translation reads UTF-16 units), compute-translate-image-loose (a translation's
 * type the looser image even where the exact one is admitted), compute-translate-repeat-admitted (a repeated character
 * of from admitted), compute-inclusion-outer-accept-ignored (an image member at a state the target does not accept
 * taken as inside it), compute-collapse-leading-space (a collapse keeps a space for leading white space),
 * compute-collapse-image-wildcard (a collapse typed as any text).
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	proportional,
	shuffled,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import { regexDfaMaxStates, regexDfaMaxWork } from "#compiler/core/limits.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Engine from "#compiler/core/result.ts"
import { codePoints, codePointsText, collapsed } from "#compiler/core/text.ts"
import type { ExprDesc, FieldDesc } from "#compiler/ir/desc.ts"
import { predicateTable, type ScalarExpr } from "#compiler/ir/expr.ts"
import type { OpenExpr } from "#compiler/ir/open.ts"
import { textOf, textPatterns } from "#compiler/ir/scalar.ts"
import { computeCore as Compute } from "#compiler/scalar/compute/builders.ts"
import { evaluateTable, sqlNull } from "#compiler/scalar/compute/evaluate.ts"
import type { CarrierValue } from "#compiler/scalar/compute/literal.ts"
import { CompilePatterns, ProgramPatterns, tablePatterns } from "#compiler/scalar/regex/patterns.ts"
import { charMapOf, imageOf } from "#compiler/scalar/regex/translate.ts"
import { collapseSources } from "#compiler/scalar/regex/whitespace.ts"
import { analyzeText } from "#compiler/text/refinement.ts"
import {
	assert,
	assertNot,
	assertVariant,
	defined,
	refusalLoc,
	refused,
	succeeded,
	throwsRefused
} from "#test/support/assert.ts"
import { textDesc } from "#test/support/fixtures/ir/desc.ts"
import { caseHang } from "#test/support/limits.ts"
import { evaluate } from "#test/support/oracle/evaluate/catalog.ts"
import { patternMember } from "#test/support/oracle/reference/evaluate.ts"
import {
	baseParams,
	type LeafBinding,
	lowerWith,
	spelledExpr,
	testPg,
	v
} from "#test/unit/compute/support.ts"
import {
	type FiniteLanguage,
	families,
	finiteLanguageOver,
	type Flags,
	jsMatcher,
	patternOver,
	stringsOver
} from "#test/unit/text/generators.ts"

const textColumn: LeafBinding = { kind: "column", type: testPg.text.scalar }

const variable = (name: string): ExprDesc => ({ kind: "var", var: name })
const text = (value: string): ExprDesc => ({ kind: "literal", value })
const collapsing = (subject: ExprDesc): ExprDesc => ({
	kind: "compute",
	fn: "collapse",
	args: [subject]
})
const translation = (subject: ExprDesc, from: ExprDesc, to: ExprDesc): ExprDesc => ({
	kind: "compute",
	fn: "translate",
	args: [subject, from, to]
})

/** A lowered term's value over a row, on the host and by the reference evaluator. */
const values = (
	root: ScalarExpr,
	row: ReadonlyMap<string, CarrierValue>
): { readonly host: CarrierValue; readonly reference: CarrierValue } => {
	const table = predicateTable(root)
	const host = succeeded(
		Engine.mapError(
			evaluateTable(
				table.exprs,
				table.root,
				{ value: undefined, column: (ref) => row.get(ref.name), closed: () => undefined },
				ProgramPatterns.of(tablePatterns(table))
			),
			(stop) => new Error(Formatter.format(stop))
		),
		"the host evaluates it"
	)
	assertNot(host, sqlNull, "the host's value is a value, no operand being NULL")
	const reference = evaluate(root, {
		kind: "row",
		column: (ref) => row.get(ref.name),
		param: () => undefined,
		regexMember: patternMember
	})
	if (reference._tag !== "Success") {
		return assert.fail(`the reference evaluates it: ${Formatter.format(reference.failure)}`)
	}
	return { host, reference: reference.success }
}

/** The map applied by hand: each character of from, by its position, to to's; every other character itself. */
const mapped = (value: string, from: ReadonlyArray<number>, to: ReadonlyArray<number>): string =>
	codePointsText(
		Arr.map(codePoints(value), (c) => {
			const at = from.indexOf(c)
			return at < 0 ? c : defined(to[at])
		})
	)

/** A map over an alphabet: from distinct code points, to any of the alphabet's, position for position. */
interface MapCase {
	readonly from: ReadonlyArray<number>
	readonly to: ReadonlyArray<number>
}

const mapOver =
	(alphabet: Arr.NonEmptyReadonlyArray<number>): Gen<MapCase> =>
	(source) => {
		const from = Arr.dedupe(source.draw(array(element(alphabet), { min: 0, max: 4 })))
		const to = Arr.map(from, () => source.draw(element(alphabet)))
		return { from, to }
	}

/**
 * Tab, LF and CR beside the space they become in xs:normalizedString, the ASCII letters lowerAscii's edges are, their
 * neighbours @, [, ` and {, Latin-1 capital and small E acute, which lowerAscii keeps, and BMP's last and a
 * supplementary code point, where UTF-16 and code points part.
 */
const translationAlphabet: Arr.NonEmptyReadonlyArray<number> = [
	0x09, 0x0a, 0x0d, 0x20, 0x40, 0x41, 0x42, 0x5a, 0x5b, 0x60, 0x61, 0x7a, 0x7b, 0xc9, 0xe9, 0xffff,
	0x1f600
]

interface TranslationCase {
	readonly map: MapCase
	readonly texts: ReadonlyArray<string>
}

type TranslationFeature =
	| "a character replaced"
	| "a character kept"
	| "a supplementary character replaced"
	| "a capital lowered"
	| "a non-ASCII letter kept"

const translationCase: Gen<TranslationCase> = (source) => ({
	map: source.draw(mapOver(translationAlphabet)),
	texts: source.draw(array(stringsOver(element(translationAlphabet), 8), { min: 1, max: 16 }))
})

/** The ASCII capitals, which lowerAscii lowers, and nothing else. */
const isAsciiCapital = (c: number): boolean => c >= 0x41 && c <= 0x5a

describe("Compute's translate and lowerAscii", () => {
	it.effect("translate and lowerAscii agree with the map on the host and in the reference", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/compute/translate-values",
					draw: drawn(translationCase),
					literal: Formatter.format,
					oracle: {
						kind: "second-implementation",
						name: "the map applied by hand, character by character, and the reference evaluator"
					},
					coverage: required<TranslationFeature>(
						[
							"a character replaced",
							"a character kept",
							"a supplementary character replaced",
							"a capital lowered",
							"a non-ASCII letter kept"
						],
						{ cases: 300, sense: notesOnly }
					),
					kept: [],
					runs: 300,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(c, k) =>
					Effect.sync(() => {
						const from = codePointsText(c.map.from)
						const to = codePointsText(c.map.to)
						const term = succeeded(
							lowerWith(
								"check",
								translation(variable("v"), text(from), text(to)),
								{ v: textColumn },
								false,
								baseParams
							),
							"a drawn map"
						).root.expr
						const folded = succeeded(
							lowerWith(
								"check",
								spelledExpr(Compute.lowerAscii(v("v", testPg.text)).expr),
								{ v: textColumn },
								false,
								baseParams
							),
							"lowerAscii"
						).root.expr
						for (const s of c.texts) {
							const row = new Map<string, CarrierValue>([["v", s]])
							const expected = mapped(s, c.map.from, c.map.to)
							const got = values(term, row)
							assert.equal(got.host, expected, `the host over ${Formatter.format(s)}`)
							assert.equal(got.reference, expected, `the reference over ${Formatter.format(s)}`)
							for (const cp of codePoints(s)) {
								const at = c.map.from.indexOf(cp)
								k.note(at >= 0 && c.map.to[at] !== cp ? "a character replaced" : "a character kept")
								if (at >= 0 && cp > 0xffff && c.map.to[at] !== cp) {
									k.note("a supplementary character replaced")
								}
							}
							const lowered = values(folded, row)
							const lowerExpected = codePointsText(
								Arr.map(codePoints(s), (cp) => (isAsciiCapital(cp) ? cp + 0x20 : cp))
							)
							assert.equal(
								lowered.host,
								lowerExpected,
								`lowerAscii on the host over ${Formatter.format(s)}`
							)
							assert.equal(
								lowered.reference,
								lowerExpected,
								`lowerAscii in the reference over ${Formatter.format(s)}`
							)
							if (Arr.some(codePoints(s), isAsciiCapital)) {
								k.note("a capital lowered")
							}
							if (Arr.contains(codePoints(s), 0xc9)) {
								k.note("a non-ASCII letter kept")
							}
						}
					})
			)
		)
	)

	/** One case of the image search: a family, its pattern and flags, a map over its alphabet, and the texts probed. */
	interface ImageCase {
		readonly family: number
		readonly source: string
		readonly flags: Flags
		readonly map: MapCase
		readonly texts: ReadonlyArray<string>
	}

	type ImageFeature =
		| "an image member"
		| "a non-member"
		| "a member through a moved character"
		| "a match of the operand outside the image"
		| "a bounded operand"
		| "a wildcard operand"
		| "an exact image past the measures"

	/**
	 * A code point and a chain of plain code points at the edge of the depth grizzle holds a pattern to (core/limits.ts
	 * regexMaxDepth): the pattern and its own image fit the measure for every last run up to 196, and the exact image,
	 * eight arcs deeper for the prefix and the suffix of any text it writes out around a pattern unanchored at either
	 * end, passes it from a last run of 189. Each such case compiles a pattern of some 16,000 positions, so the arm is
	 * drawn rarely.
	 */
	const deep =
		(alphabet: Arr.NonEmptyReadonlyArray<number>): Gen<readonly [string, Flags]> =>
		(s) => [
			`\\u{${s.draw(element(alphabet)).toString(16)}}(?:a{255}){61}b{${s.draw(int(189, 196))}}`,
			"u"
		]

	const imageCase: Gen<ImageCase> = (source) => {
		const family = source.draw(int(0, families.length - 1))
		const f = defined(families[family], "a family")
		const declared: Gen<readonly [string, Flags]> = weighted([
			[4, element(Arr.isReadonlyArrayNonEmpty(f.patterns) ? f.patterns : [["^$", "u"] as const])],
			[8, map(patternOver(f.alphabet), (p): readonly [string, Flags] => [p, "u"])],
			[4, (s): readonly [string, Flags] => ["^.*$", s.draw(boolean) ? "su" : "u"]],
			[1, deep(f.alphabet)]
		])
		const [pattern, flags] = source.draw(declared)
		return {
			family,
			source: pattern,
			flags,
			map: source.draw(mapOver(f.alphabet)),
			texts: source.draw(array(stringsOver(element(f.alphabet), 5), { min: 1, max: 12 }))
		}
	}

	/**
	 * Every text the map takes to `value`: at each character, the character itself where the map does not move it, and
	 * each character of from the map takes to it.
	 */
	const preimages = (value: string, c: MapCase): ReadonlyArray<string> =>
		Arr.reduce(codePoints(value), [""], (prefixes: ReadonlyArray<string>, cp) => {
			const own = c.from.includes(cp) ? [] : [String.fromCodePoint(cp)]
			const moved = Arr.flatMap(c.from, (f, i) => (c.to[i] === cp ? [String.fromCodePoint(f)] : []))
			return Arr.flatMap(prefixes, (p) => Arr.map([...own, ...moved], (x) => `${p}${x}`))
		})

	it.effect("types a translation as text of exactly the image of its operand's language", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/compute/translate-image",
					draw: drawn(imageCase),
					literal: Formatter.format,
					oracle: {
						kind: "second-implementation",
						name: "ECMAScript's own test of the operand's pattern over every preimage"
					},
					coverage: required<ImageFeature>(
						[
							"an image member",
							"a non-member",
							"a member through a moved character",
							"a match of the operand outside the image",
							"a bounded operand",
							"a wildcard operand",
							"an exact image past the measures"
						],
						{ cases: 400, sense: notesOnly }
					),
					kept: [
						{
							note: "a code point and a chain whose own image fits the depth measure and whose exact image, eight arcs deeper for the prefix and the suffix it writes out, passes it; the measure keeps half of PostgreSQL's measured stack edge free, so PostgreSQL itself still compiles that image: the pattern's own image types the term",
							sketch: {
								family: 0,
								source: "\\u{30}(?:a{255}){61}b{189}",
								flags: "u",
								map: { from: [0x30], to: [0x31] },
								texts: ["", "1", "21"]
							},
							draws: "",
							reaches: ["an exact image past the measures", "a non-member"]
						}
					],
					runs: 400,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(c, k) =>
					Effect.sync(() => {
						const declared = analyzeText(
							[{ source: c.source, flags: c.flags }],
							SourceLoc("str.regex", [])
						)
						if (!declared.ok) {
							return
						}
						if (declared.value.check.kind === "tautology") {
							k.note("a wildcard operand")
						}
						const operand = testPg.regex(c.source, c.flags)
						const term = succeeded(
							lowerWith(
								"check",
								translation(
									variable("v"),
									text(codePointsText(c.map.from)),
									text(codePointsText(c.map.to))
								),
								{ v: { kind: "column", type: operand.scalar } },
								false,
								baseParams
							),
							`a map over /${c.source}/${c.flags}`
						).root
						const image = defined(textOf(term.nominal), "the image is text")
						const operandText = defined(textOf(operand.scalar))
						if (operandText.lengthBound !== undefined) {
							k.note("a bounded operand")
							assert.ok(image.lengthBound !== undefined, "a bounded operand's image is bounded")
						}
						/**
						 * The exact image types the term wherever it fits PostgreSQL's regex compile space, the measures every
						 * refinement is admitted under; past them the pattern's own image does, which holds every value of the
						 * image and may hold more.
						 */
						const [operandPattern] = textPatterns(operandText.regex)
						const exact = analyzeText(
							[
								{
									source: imageOf(
										operandPattern,
										succeeded(charMapOf(codePointsText(c.map.from), codePointsText(c.map.to))),
										new CompilePatterns()
									).exact,
									flags: "u"
								}
							],
							SourceLoc("the exact image", [])
						).ok
						if (!exact) {
							k.note("an exact image past the measures")
						}
						const ofImage = Arr.map(textPatterns(image.regex), (p) => jsMatcher(p.source, p.flags))
						const accepts = (value: string): boolean => Arr.every(ofImage, (m) => m(value))
						const ofOperand = jsMatcher(c.source, c.flags)
						for (const t of c.texts) {
							const member = Arr.some(preimages(t, c.map), ofOperand)
							const where = `${Formatter.format(t)} under /${c.source}/${c.flags} mapped by ${Formatter.format(c.map)}`
							if (exact) {
								assert.equal(accepts(t), member, where)
							} else if (member) {
								assert.ok(accepts(t), where)
							}
							k.note(member ? "an image member" : "a non-member")
							if (member && !ofOperand(t)) {
								k.note("a member through a moved character")
							}
							if (!member && ofOperand(t)) {
								k.note("a match of the operand outside the image")
							}
						}
					})
			)
		)
	)

	/** A fault planted in a valid translation or collapse, one for each refusal of the two. */
	type Fault =
		| "a to shorter than from"
		| "a to longer than from"
		| "a repeated character of from"
		| "a character no text holds"
		| "a term as from"
		| "a term as to"
		| "a subject that is no text"
		| "an unbounded subject in a query"
		| "a map of two lengths at the builder"
		| "a repeated character at the builder"
		| "a term as from at the builder"
		| "a subject that is no text at the builder"

	const faults: Arr.NonEmptyReadonlyArray<Fault> = [
		"a to shorter than from",
		"a to longer than from",
		"a repeated character of from",
		"a character no text holds",
		"a term as from",
		"a term as to",
		"a subject that is no text",
		"an unbounded subject in a query",
		"a map of two lengths at the builder",
		"a repeated character at the builder",
		"a term as from at the builder",
		"a subject that is no text at the builder"
	]

	/**
	 * The faults only a translation meets: its map's, and a subject unbounded in a query, which a collapse reads by
	 * replace alone.
	 */
	const translateFaults: ReadonlySet<Fault> = new Set<Fault>([
		"an unbounded subject in a query",
		"a to shorter than from",
		"a to longer than from",
		"a repeated character of from",
		"a character no text holds",
		"a term as from",
		"a term as to",
		"a map of two lengths at the builder",
		"a repeated character at the builder",
		"a term as from at the builder"
	])

	/**
	 * A valid term and the fault planted in it: a translation by a map Compute.translate admits, or a collapse, lowered as
	 * a check or a query, and two code points a fault is built from beside a code point no text holds, NUL or a lone
	 * surrogate.
	 */
	interface Planted {
		readonly fault: Fault
		readonly term: "translate" | "collapse"
		readonly mode: "check" | "query"
		readonly map: MapCase
		readonly point: number
		readonly other: number
		readonly unheld: number
	}

	const plantedGen: Gen<Planted> = (source) => {
		const fault = source.draw(element(faults))
		return {
			fault,
			term: translateFaults.has(fault)
				? "translate"
				: source.draw(element(["translate", "collapse"] as const)),
			mode: source.draw(element(["check", "query"] as const)),
			map: source.draw(mapOver(translationAlphabet)),
			point: source.draw(element(translationAlphabet)),
			other: source.draw(element(translationAlphabet)),
			unheld: source.draw(element([0x0, 0xd800, 0xdfff]))
		}
	}

	const vars: Readonly<Record<string, LeafBinding>> = {
		v: textColumn,
		w: textColumn,
		b: {
			kind: "column",
			type: testPg.regex("^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8}){0,3}$", "u").scalar
		},
		n: { kind: "column", type: testPg.integer.scalar }
	}

	it.effect(
		"refuses each fault planted in a valid translation or collapse by its reason and place, and compiles the term without it",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/compute/translate-refusals",
						draw: drawn(plantedGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "translate's map, collapse's operand and their modes"
						},
						coverage: required<Fault>(faults, { cases: 400, sense: notesOnly }),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(p, k) =>
						Effect.sync(() => {
							k.note(p.fault)
							const label = Formatter.format(p)
							const subject = p.mode === "query" ? "b" : "v"
							const lowered = (desc: ExprDesc, mode: "check" | "query") =>
								lowerWith(mode, desc, vars, false, baseParams)
							const compiles = (desc: ExprDesc, mode: "check" | "query"): void => {
								succeeded(lowered(desc, mode), `${label} without its fault`)
							}
							/** The refusal of a term for `tag`, stated at `path`. */
							const refusedWith = (
								desc: ExprDesc,
								mode: "check" | "query",
								tag: CompileError["reason"]["_tag"],
								path: ReadonlyArray<string | number>
							): void => {
								assert.deepEqual(
									refusalLoc(refused(lowered(desc, mode), tag, label)).path,
									path,
									label
								)
							}
							const { from, to } = p.map
							const termOver = (over: string): ExprDesc =>
								p.term === "translate"
									? translation(
											variable(over),
											text(codePointsText(from)),
											text(codePointsText(to))
										)
									: collapsing(variable(over))
							const valid = termOver(subject)
							/** A translation by `f` to `t`, each a list of code points, as translate's two text literals. */
							const mapOf = (f: ReadonlyArray<number>, t: ReadonlyArray<number>): ExprDesc =>
								translation(variable(subject), text(codePointsText(f)), text(codePointsText(t)))
							const head = from[0] ?? p.point
							switch (p.fault) {
								case "a to shorter than from":
									refusedWith(
										from.length > 0 ? mapOf(from, to.slice(0, -1)) : mapOf([p.point], []),
										p.mode,
										"MalformedDescription",
										["translate"]
									)
									break
								case "a to longer than from":
									refusedWith(mapOf(from, [...to, p.point]), p.mode, "MalformedDescription", [
										"translate"
									])
									break
								case "a repeated character of from":
									refusedWith(
										mapOf([...from, head, head], [...to, p.point, p.other]),
										p.mode,
										"MalformedDescription",
										["translate"]
									)
									break
								case "a character no text holds":
									refusedWith(
										mapOf([...from, p.unheld], [...to, p.point]),
										p.mode,
										"MalformedDescription",
										["translate"]
									)
									break
								case "a term as from":
								case "a term as to": {
									const literal = text(codePointsText(p.fault === "a term as from" ? to : from))
									refusedWith(
										p.fault === "a term as from"
											? translation(variable(subject), variable("w"), literal)
											: translation(variable(subject), literal, variable("w")),
										p.mode,
										"MalformedDescription",
										["translate", p.fault === "a term as from" ? 1 : 2]
									)
									break
								}
								case "a subject that is no text":
									refusedWith(termOver("n"), p.mode, "MalformedDescription", [p.term])
									break
								case "an unbounded subject in a query":
									refusedWith(termOver("v"), "query", "UnsupportedOperation", [p.term])
									compiles(termOver("v"), "check")
									compiles(collapsing(variable("v")), "query")
									break
								case "a map of two lengths at the builder":
								case "a repeated character at the builder":
								case "a term as from at the builder": {
									const [f, t]: readonly [ReadonlyArray<number>, ReadonlyArray<number>] =
										p.fault === "a repeated character at the builder"
											? [
													[...from, head, head],
													[...to, p.point, p.other]
												]
											: [from, [...to, p.point]]
									const error = throwsRefused(
										() =>
											p.fault === "a term as from at the builder"
												? Compute.translate(
														v("v", testPg.text),
														v("w", testPg.text),
														codePointsText(to)
													)
												: Compute.translate(
														v("v", testPg.text),
														codePointsText(f),
														codePointsText(t)
													),
										"MalformedDescription",
										label
									)
									assert.deepEqual(
										refusalLoc(error).path,
										p.fault === "a term as from at the builder" ? [] : ["translate"],
										label
									)
									break
								}
								case "a subject that is no text at the builder":
									assert.deepEqual(
										refusalLoc(
											throwsRefused(
												() =>
													p.term === "translate"
														? Compute.translate(
																v("n", testPg.integer),
																codePointsText(from),
																codePointsText(to)
															)
														: Compute.collapse(v("n", testPg.integer)),
												"MalformedDescription",
												label
											)
										).path,
										[p.term],
										label
									)
									break
							}
							compiles(valid, p.mode)
						})
				)
			)
	)

	/**
	 * The operand of a cast: the image of a finite language under a drawn map (its members mapped, which its exact image
	 * type holds and nothing else), a collapse of a finite language or of any text, any text, or a language whose own
	 * automaton passes the analysis bounds, `^[xy]*x[xy]{n}$`, x and y two code points.
	 */
	type Operand =
		| {
				readonly kind: "a translated language"
				readonly language: FiniteLanguage
				readonly map: MapCase
		  }
		| { readonly kind: "a collapsed language"; readonly language: FiniteLanguage }
		| { readonly kind: "a collapse of any text" }
		| { readonly kind: "any text" }
		| {
				readonly kind: "a language past the bounds"
				readonly x: number
				readonly y: number
				readonly count: number
		  }

	/**
	 * What it is cast to: a text type, a contract over one whose predicate bounds the length below the image's longest
	 * member, so nothing proves it, the collapsed texts, every text with no tab, LF or CR and a space only between two
	 * other characters, or a numeric, whose lexical form the operand is parsed into.
	 */
	type Target =
		| { readonly kind: "a text type"; readonly source: string }
		| {
				readonly kind: "a contract over a text type"
				readonly source: string
				readonly below: number
		  }
		| { readonly kind: "the collapsed texts" }
		| { readonly kind: "a numeric"; readonly precision: number; readonly scale: number }

	/** The members of an operand's image, where a finite language's image has them. */
	const imageMembers = (operand: Operand): ReadonlyArray<string> | undefined => {
		switch (operand.kind) {
			case "a translated language":
				return Arr.map(operand.language.members, (m) => mapped(m, operand.map.from, operand.map.to))
			case "a collapsed language":
				return Arr.map(operand.language.members, collapsed)
			case "a collapse of any text":
			case "any text":
			case "a language past the bounds":
				return undefined
		}
	}

	/** A code point as its braced escape, which means itself inside a class and out. */
	const escapedPoint = (c: number): string => `\\u{${c.toString(16)}}`

	/** A text as the alternation arm that spells it, each code point its braced escape. */
	const spelled = (value: string): string => Arr.join(Arr.map(codePoints(value), escapedPoint), "")

	/**
	 * A text type a drawn image is or is not inside: every text over its code points, or exactly its members, each with
	 * one of them dropped half the time and more of the alphabet's added.
	 */
	const textTarget =
		(image: ReadonlyArray<string>): Gen<string> =>
		(source) => {
			const drop = source.draw(boolean)
			if (source.draw(boolean)) {
				const points = Arr.dedupe(Arr.flatMap(image, codePoints))
				const kept = drop ? points.slice(1) : points
				const more = source.draw(array(element(translationAlphabet), { min: 0, max: 3 }))
				return `^[${Arr.join(Arr.map([...kept, ...more], escapedPoint), "")}]*$`
			}
			const members = Arr.dedupe(image)
			const kept = drop ? members.slice(1) : members
			const more = source.draw(
				array(stringsOver(element(translationAlphabet), 3), { min: 0, max: 3 })
			)
			return `^(?:${Arr.join(Arr.map([...kept, ...more], spelled), "|")})$`
		}

	/**
	 * The collapsed texts, every text with no tab, LF or CR and a space only between two other characters, the collapse of
	 * any text a member; within `length` characters where a bound is given, which the collapse of a text that long keeps.
	 */
	const collapsedTexts = (length: number | undefined): string =>
		length === undefined
			? "^(?:[^ \\t\\n\\r]+(?: [^ \\t\\n\\r]+)*)?$"
			: length === 0
				? "^$"
				: length === 1
					? "^[^ \\t\\n\\r]?$"
					: `^(?:[^ \\t\\n\\r](?:[^\\t\\n\\r]{0,${length - 2}}[^ \\t\\n\\r])?)?$`

	/** The longest member of a finite language, in code points. */
	const longestOf = (members: ReadonlyArray<string>): number =>
		Arr.reduce(members, 0, (most, m) => Math.max(most, codePoints(m).length))

	/**
	 * The most members a cast's finite language holds: a search budget, no claim. A target is spelled from the image's
	 * members, so a larger language mostly passes the analysis bounds, where the property sees only the refusal that
	 * names them, and a case past it costs much and judges little.
	 */
	const castMembers = 64

	const castGen: Gen<readonly [Operand, Target]> = (source) => {
		const language = source.draw(finiteLanguageOver(translationAlphabet, castMembers))
		const operand = source.draw(
			weighted<Operand>([
				[
					4,
					(s) => ({
						kind: "a translated language",
						language,
						map: s.draw(mapOver(translationAlphabet))
					})
				],
				[2, () => ({ kind: "a collapsed language", language })],
				[1, () => ({ kind: "a collapse of any text" })],
				[1, () => ({ kind: "any text" })],
				[
					1,
					(s) => {
						const [x, y] = s.draw(shuffled(translationAlphabet, { min: 2, max: 2 }))
						return {
							kind: "a language past the bounds",
							x: defined(x, "a first code point"),
							y: defined(y, "a second code point"),
							count: s.draw(int(11, 13))
						}
					}
				]
			])
		)
		const image = imageMembers(operand) ?? language.members
		const longest = longestOf(image)
		const target = source.draw(
			weighted<Target>([
				[4, (s) => ({ kind: "a text type", source: s.draw(textTarget(image)) })],
				[
					1,
					(s) => ({
						kind: "a contract over a text type",
						source: s.draw(textTarget(image)),
						below: longest - 1
					})
				],
				[1, () => ({ kind: "the collapsed texts" })],
				[
					1,
					(s) => ({ kind: "a numeric", precision: s.draw(int(20, 60)), scale: s.draw(int(0, 10)) })
				]
			])
		)
		return [operand, target] as const
	}

	type Inclusion =
		| "an image inside the target"
		| "an image outside the target"
		| "a contract's predicate unproved"
		| "any text outside the target"
		| "a collapse inside the collapsed texts"
		| "a refinement past the analysis bounds"
		| "a parse past the analysis bounds"

	it.effect(
		"proves a cast into a refined text exactly by the image's inclusion, and names the analysis bounds it cannot pass",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/compute/translate-inclusion",
						draw: drawn(castGen),
						literal: Formatter.format,
						oracle: {
							kind: "second-implementation",
							name: "a finite language's members mapped, judged by ECMAScript's own test of the target"
						},
						coverage: required<Inclusion>(
							[
								"an image inside the target",
								"an image outside the target",
								"a contract's predicate unproved",
								"any text outside the target",
								"a collapse inside the collapsed texts",
								"a refinement past the analysis bounds",
								"a parse past the analysis bounds"
							],
							{ cases: 400, sense: notesOnly }
						),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([operand, target], k) =>
						Effect.sync(() => {
							const label = Formatter.format([operand, target])
							const past =
								operand.kind === "a language past the bounds"
									? `^[${escapedPoint(operand.x)}${escapedPoint(operand.y)}]*${escapedPoint(operand.x)}[${escapedPoint(operand.x)}${escapedPoint(operand.y)}]{${operand.count}}$`
									: "^.*$"
							const finite =
								operand.kind === "a translated language" || operand.kind === "a collapsed language"
									? operand.language
									: undefined
							const castVars: Readonly<Record<string, LeafBinding>> = {
								t: { kind: "column", type: testPg.regex(finite?.source ?? past, "u").scalar },
								v: textColumn
							}
							const arg: ExprDesc =
								operand.kind === "a translated language"
									? translation(
											variable("t"),
											text(codePointsText(operand.map.from)),
											text(codePointsText(operand.map.to))
										)
									: operand.kind === "a collapsed language"
										? collapsing(variable("t"))
										: operand.kind === "a collapse of any text"
											? collapsing(variable("v"))
											: operand.kind === "any text"
												? variable("v")
												: variable("t")
							/** The text type a target states, the collapsed texts within a collapsed language's longest member. */
							const textTypeOf = (source: string, flags: "u" | "su"): FieldDesc =>
								textDesc(source, flags)
							const collapsedTarget = collapsedTexts(
								operand.kind === "a collapsed language"
									? longestOf(operand.language.members)
									: undefined
							)
							const to: FieldDesc =
								target.kind === "a text type"
									? textTypeOf(target.source, "u")
									: target.kind === "a contract over a text type"
										? {
												kind: "contract",
												name: "Short",
												base: textTypeOf(target.source, "u"),
												predicate: {
													kind: "compare",
													op: "le",
													left: { kind: "compute", fn: "charLength", args: [{ kind: "value" }] },
													right: { kind: "literal", value: target.below }
												},
												facts: []
											}
										: target.kind === "the collapsed texts"
											? textTypeOf(collapsedTarget, "su")
											: { kind: "numeric", precision: target.precision, scale: target.scale }
							const cast = lowerWith(
								"check",
								{ kind: "cast", arg, to },
								castVars,
								false,
								baseParams
							)
							if (target.kind === "a contract over a text type") {
								refused(cast, "PartialOperation", label)
								k.note("a contract's predicate unproved")
								return
							}
							if (operand.kind === "a language past the bounds") {
								const { reason } = refused(cast, "ResourceBound", label)
								assertVariant(reason, "_tag", "ResourceBound", label)
								assertVariant(reason.bound, "kind", "regexInclusion", label)
								assert.deepEqual(
									[reason.bound.inner, reason.bound.states, reason.bound.work],
									[`/${past}/u`, regexDfaMaxStates.value, regexDfaMaxWork.value],
									label
								)
								if (target.kind === "a numeric") {
									k.note("a parse past the analysis bounds")
									return
								}
								k.note("a refinement past the analysis bounds")
								assert.equal(
									reason.bound.outer,
									target.kind === "a text type" ? `/${target.source}/u` : `/${collapsedTarget}/su`,
									label
								)
								return
							}
							if (target.kind === "the collapsed texts") {
								if (
									operand.kind === "a collapsed language" ||
									operand.kind === "a collapse of any text"
								) {
									succeeded(cast, label)
									k.note("a collapse inside the collapsed texts")
								}
								return
							}
							if (target.kind === "a numeric") {
								return
							}
							if (operand.kind === "any text") {
								refused(cast, "PartialOperation", label)
								k.note("any text outside the target")
								return
							}
							const image = imageMembers(operand)
							if (image === undefined) {
								return
							}
							if (!cast.ok && cast.error.reason._tag === "ResourceBound") {
								const { reason } = refused(cast, "ResourceBound", label)
								assertVariant(reason, "_tag", "ResourceBound", label)
								assertVariant(reason.bound, "kind", "regexInclusion", label)
								assert.deepEqual(
									[reason.bound.states, reason.bound.work],
									[regexDfaMaxStates.value, regexDfaMaxWork.value],
									label
								)
								k.note("a refinement past the analysis bounds")
								return
							}
							const inside = Arr.every(image, jsMatcher(target.source, "u"))
							if (operand.kind === "a collapsed language") {
								if (cast.ok) {
									assert.equal(inside, true, `${label}: a proved collapse lies in its target`)
								}
								return
							}
							if (inside) {
								succeeded(cast, label)
								k.note("an image inside the target")
							} else {
								refused(cast, "PartialOperation", label)
								k.note("an image outside the target")
							}
						})
				)
			)
	)

	/** XML's four white space characters beside no-break space and line separator, which XML does not count, and letters. */
	const spaceAlphabet: Arr.NonEmptyReadonlyArray<number> = [
		0x09, 0x0a, 0x0d, 0x20, 0x61, 0x62, 0xa0, 0x2028, 0xe9, 0x1f600
	]

	/** A character of the alphabet, the space twice as often as each other one. */
	const spaceCharacter: Gen<number> = proportional(
		Arr.map(spaceAlphabet, (point) => [point === 0x20 ? 2 : 1, constant(point)] as const)
	)

	/** XML Schema's collapse as its definition reads: pieces cut at every run of white space, the empty ones dropped. */
	const byDefinition = (value: string): string =>
		Arr.join(
			Arr.filter(
				Arr.reduce(codePoints(value), [""], (pieces: ReadonlyArray<string>, c) =>
					isXmlSpace(c)
						? [...pieces, ""]
						: [...pieces.slice(0, -1), `${pieces.at(-1) ?? ""}${String.fromCodePoint(c)}`]
				),
				(piece) => piece.length > 0
			),
			" "
		)

	const isXmlSpace = (c: number): boolean => c === 0x09 || c === 0x0a || c === 0x0d || c === 0x20

	type CollapseFeature =
		| "a run folded"
		| "an end trimmed"
		| "a no-break space kept"
		| "a character replaced"

	it.effect("collapse and replaceWhitespace agree with XML Schema's definition", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/compute/collapse-values",
					draw: drawn(array(stringsOver(spaceCharacter, 10), { min: 1, max: 24 })),
					literal: Formatter.format,
					oracle: {
						kind: "second-implementation",
						name: "XML Schema's definition by pieces, and the reference evaluator"
					},
					coverage: required<CollapseFeature>(
						["a run folded", "an end trimmed", "a no-break space kept", "a character replaced"],
						{ cases: 200, sense: notesOnly }
					),
					kept: [],
					runs: 200,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(texts, k) =>
					Effect.sync(() => {
						const lowered = (term: { readonly expr: OpenExpr }) =>
							succeeded(
								lowerWith("check", spelledExpr(term.expr), { v: textColumn }, false, baseParams)
							).root.expr
						const collapse = lowered(Compute.collapse(v("v", testPg.text)))
						const replace = lowered(Compute.replaceWhitespace(v("v", testPg.text)))
						for (const s of texts) {
							const row = new Map<string, CarrierValue>([["v", s]])
							const expected = byDefinition(s)
							const got = values(collapse, row)
							assert.equal(got.host, expected, `collapse on the host over ${Formatter.format(s)}`)
							assert.equal(
								got.reference,
								expected,
								`collapse in the reference over ${Formatter.format(s)}`
							)
							const replaced = codePointsText(
								Arr.map(codePoints(s), (c) => (isXmlSpace(c) ? 0x20 : c))
							)
							const r = values(replace, row)
							assert.equal(r.host, replaced, `replace on the host over ${Formatter.format(s)}`)
							assert.equal(
								r.reference,
								replaced,
								`replace in the reference over ${Formatter.format(s)}`
							)
							const points = codePoints(s)
							if (
								Arr.some(points, (c, i) => isXmlSpace(c) && i > 0 && isXmlSpace(points[i - 1] ?? 0))
							) {
								k.note("a run folded")
							}
							if (
								points.length > 0 &&
								(isXmlSpace(points[0] ?? 0) || isXmlSpace(points.at(-1) ?? 0))
							) {
								k.note("an end trimmed")
							}
							if (Arr.contains(codePoints(expected), 0xa0)) {
								k.note("a no-break space kept")
							}
							if (replaced !== s) {
								k.note("a character replaced")
							}
						}
					})
			)
		)
	)

	/** One case of the collapse image: a pattern over an alphabet dense in white space, and the texts probed. */
	interface CollapseCase {
		readonly source: string
		readonly flags: Flags
		readonly texts: ReadonlyArray<string>
	}

	type CollapseImageFeature =
		| "an image member"
		| "an image non-member"
		| "an exact image"
		| "a bounded image"
		| "an image with no white space"

	const collapseCase: Gen<CollapseCase> = (source) => {
		const declared: Gen<readonly [string, Flags]> = weighted([
			[4, map(patternOver(spaceAlphabet), (p): readonly [string, Flags] => [p, "u"])],
			[1, (s): readonly [string, Flags] => ["^.*$", s.draw(boolean) ? "su" : "u"]],
			[1, (s): readonly [string, Flags] => [`^.{0,${s.draw(int(0, 12))}}$`, "su"]],
			[
				1,
				element([
					["^[ab]{1,6}$", "u"],
					["^[ \\ta]*$", "u"],
					["^ *$", "u"]
				] as const)
			]
		])
		const [pattern, flags] = source.draw(declared)
		return {
			source: pattern,
			flags,
			texts: source.draw(array(stringsOver(spaceCharacter, 8), { min: 1, max: 16 }))
		}
	}

	it.effect("types a collapse as text holding its image within the operand's length bound", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/compute/collapse-image",
					draw: drawn(collapseCase),
					literal: Formatter.format,
					oracle: {
						kind: "second-implementation",
						name: "ECMAScript's own test of the operand's pattern and of the image's"
					},
					coverage: required<CollapseImageFeature>(
						[
							"an image member",
							"an image non-member",
							"an exact image",
							"a bounded image",
							"an image with no white space"
						],
						{ cases: 400, sense: notesOnly }
					),
					kept: [],
					runs: 400,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(c, k) =>
					Effect.sync(() => {
						if (
							!analyzeText([{ source: c.source, flags: c.flags }], SourceLoc("str.regex", [])).ok
						) {
							return
						}
						const operand = testPg.regex(c.source, c.flags)
						const term = succeeded(
							lowerWith(
								"check",
								{ kind: "compute", fn: "collapse", args: [variable("v")] },
								{ v: { kind: "column", type: operand.scalar } },
								false,
								baseParams
							),
							`a collapse of /${c.source}/${c.flags}`
						).root
						const image = defined(textOf(term.nominal), "the image is text")
						const operandText = defined(textOf(operand.scalar))
						const [operandPattern] = textPatterns(operandText.regex)
						const chosen = defined(
							Arr.findFirst(
								collapseSources(operandPattern, operandText.lengthBound, new CompilePatterns()),
								(s) =>
									analyzeText([{ source: s.source, flags: s.flags }], SourceLoc("image", [])).ok
							).pipe(Option.getOrUndefined),
							"an admitted image"
						)
						if (operandText.lengthBound !== undefined && operandText.lengthBound <= 257) {
							k.note("a bounded image")
							assert.ok(
								image.lengthBound !== undefined && image.lengthBound <= operandText.lengthBound,
								"collapse never lengthens, so the operand's bound holds"
							)
						}
						const ofImage = Arr.map(textPatterns(image.regex), (p) => jsMatcher(p.source, p.flags))
						const accepts = (value: string): boolean => Arr.every(ofImage, (m) => m(value))
						const ofOperand = jsMatcher(c.source, c.flags)
						const members = Arr.filter(c.texts, ofOperand)
						for (const m of members) {
							assert.ok(
								accepts(collapsed(m)),
								`the collapse of ${Formatter.format(m)} under /${c.source}/${c.flags}`
							)
						}
						if (!chosen.exact) {
							return
						}
						k.note("an exact image")
						/**
						 * Whether some value of the operand's language collapses to `t`, where the image is exact: the empty
						 * text alone for a language of white space only, and otherwise a text that is its own collapse and has
						 * a preimage among itself and itself with every space one white space character, which is every
						 * preimage the exact cases need (a language with no white space, and every text over an alphabet).
						 */
						const preimaged = (t: string): boolean =>
							chosen.source === "^$"
								? t === ""
								: collapsed(t) === t &&
									Arr.some(
										[t, ...Arr.map(["\t", "\n", "\r"], (w) => Str.replaceAll(" ", w)(t))],
										ofOperand
									)
						for (const t of [...c.texts, ...Arr.map(members, collapsed)]) {
							const held = accepts(t)
							assert.equal(
								held,
								preimaged(t),
								`${Formatter.format(t)} under /${c.source}/${c.flags}`
							)
							k.note(held ? "an image member" : "an image non-member")
							if (held && !Arr.some(codePoints(t), isXmlSpace)) {
								k.note("an image with no white space")
							}
						}
					})
			)
		)
	)
})
