import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, int, map, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Engine from "#compiler/core/result.ts"
import { codePoints, codePointsText } from "#compiler/core/text.ts"
import type { ExprDesc, FieldDesc } from "#compiler/ir/desc.ts"
import { predicateTable, type ScalarExpr } from "#compiler/ir/expr.ts"
import { textOf } from "#compiler/ir/scalar.ts"
import { defaultOps } from "#compiler/lower/conservative/expr/ops.ts"
import { computeCore as Compute } from "#compiler/scalar/compute/builders.ts"
import { evaluateTable } from "#compiler/scalar/compute/evaluate.ts"
import type { CarrierValue } from "#compiler/scalar/compute/literal.ts"
import { regexMember } from "#compiler/scalar/regex/nfa.ts"
import { charMapOf, imageOf } from "#compiler/scalar/regex/translate.ts"
import type { Expr } from "#compiler/sql/ast.ts"
import { col, lit, types } from "#compiler/sql/build.ts"
import { analyzeText } from "#compiler/text/refinement.ts"
import { assert, defined, refused, succeeded, throwsRefused } from "#test/support/assert.ts"
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
	families,
	type Flags,
	jsAccepts,
	patternOver,
	stringsOver
} from "#test/unit/text/generators.ts"

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
 * - the refusals, a box of named invalid inputs, each by its reason.
 */

const textColumn: LeafBinding = { kind: "column", type: testPg.text.scalar }

const variable = (name: string): ExprDesc => ({ kind: "var", var: name })
const text = (value: string): ExprDesc => ({ kind: "literal", value, type: undefined })
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
				regexMember
			),
			(stop) => new Error(Formatter.format(stop))
		),
		"the host evaluates it"
	)
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
	texts: source.draw(array(stringsOver(translationAlphabet, 8), { min: 1, max: 16 }))
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
	 * A code point and four end-or-start tests, eight anchors, unanchored at the start: the exact image's prefix writes
	 * out two anchors more, past the eight PostgreSQL's compile space admits.
	 */
	const anchored =
		(alphabet: Arr.NonEmptyReadonlyArray<number>): Gen<readonly [string, Flags]> =>
		(s) => [
			`\\u{${s.draw(element(alphabet)).toString(16)}}${Arr.join(Arr.replicate("(?:$|^)", 4), "")}`,
			"u"
		]

	const imageCase: Gen<ImageCase> = (source) => {
		const family = source.draw(int(0, families.length - 1))
		const f = defined(families[family], "a family")
		const declared: Gen<readonly [string, Flags]> = weighted([
			[1, element(Arr.isReadonlyArrayNonEmpty(f.patterns) ? f.patterns : [["^$", "u"] as const])],
			[2, map(patternOver(f.alphabet), (p): readonly [string, Flags] => [p, "u"])],
			[1, (s): readonly [string, Flags] => ["^.*$", s.draw(boolean) ? "su" : "u"]],
			[1, anchored(f.alphabet)]
		])
		const [pattern, flags] = source.draw(declared)
		return {
			family,
			source: pattern,
			flags,
			map: source.draw(mapOver(f.alphabet)),
			texts: source.draw(array(stringsOver(f.alphabet, 5), { min: 1, max: 12 }))
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
							note: "a pattern of seven anchors unanchored at either end, whose exact image writes out nine, past the eight PostgreSQL's compile space admits: the pattern's own image types it",
							sketch: {
								family: 0,
								source: "0{1}(^)|((0))(($)|((((^)|(^)(^|$|\\d^)))))",
								flags: "u",
								map: { from: [0x30], to: [0x31] },
								texts: ["", "1", "21"]
							},
							draws: "",
							reaches: ["an exact image past the measures", "an image member", "a non-member"]
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
						const declared = analyzeText(c.source, c.flags, SourceLoc("str.regex", []))
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
						const exact = analyzeText(
							imageOf(
								operandText.regex,
								succeeded(charMapOf(codePointsText(c.map.from), codePointsText(c.map.to)))
							).exact,
							"u",
							SourceLoc("the exact image", [])
						).ok
						if (!exact) {
							k.note("an exact image past the measures")
						}
						const accepts = (value: string): boolean =>
							image.regex === "wildcard" || jsAccepts(image.regex.source, image.regex.flags, value)
						for (const t of c.texts) {
							const member = Arr.some(preimages(t, c.map), (p) => jsAccepts(c.source, c.flags, p))
							const where = `${Formatter.format(t)} under /${c.source}/${c.flags} mapped by ${Formatter.format(c.map)}`
							if (exact) {
								assert.equal(accepts(t), member, where)
							} else if (member) {
								assert.ok(accepts(t), where)
							}
							k.note(member ? "an image member" : "a non-member")
							if (member && !jsAccepts(c.source, c.flags, t)) {
								k.note("a member through a moved character")
							}
							if (!member && jsAccepts(c.source, c.flags, t)) {
								k.note("a match of the operand outside the image")
							}
						}
					})
			)
		)
	)

	/** A named invalid input, and the reason its refusal states. */
	type Invalid =
		| "from and to of two lengths"
		| "a repeated character of from"
		| "a column as from"
		| "a subject that is no text"
		| "translate in a query over an unbounded text"
		| "a query's translate spelled as pg_catalog's"
		| "a map of two lengths at the builder"
		| "a term as from at the builder"

	const invalid: Arr.NonEmptyReadonlyArray<Invalid> = [
		"from and to of two lengths",
		"a repeated character of from",
		"a column as from",
		"a subject that is no text",
		"translate in a query over an unbounded text",
		"a query's translate spelled as pg_catalog's",
		"a map of two lengths at the builder",
		"a term as from at the builder"
	]

	const vars: Readonly<Record<string, LeafBinding>> = {
		v: textColumn,
		w: textColumn,
		b: {
			kind: "column",
			type: testPg.regex("^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8}){0,3}$", "u").scalar
		},
		n: { kind: "column", type: testPg.integer.scalar }
	}

	it.effect("refuses each invalid input by its reason", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/compute/translate-refusals",
					generator: element(invalid),
					literal: Formatter.format,
					limit: invalid.length,
					box: "every named invalid input of translate and lowerAscii",
					oracle: { kind: "specification", name: "translate's map and its modes" },
					coverage: requiredInSpace<Invalid>(invalid),
					caseHang
				},
				(name, k) =>
					Effect.sync(() => {
						k.note(name)
						const lowered = (desc: ExprDesc, mode: "check" | "query") =>
							lowerWith(mode, desc, vars, false, baseParams)
						switch (name) {
							case "from and to of two lengths":
								refused(
									lowered(translation(variable("v"), text("ab"), text("c")), "check"),
									"MalformedDescription",
									"a shorter to would delete a character"
								)
								refused(
									lowered(translation(variable("v"), text("a"), text("bc")), "check"),
									"MalformedDescription",
									"a longer to states characters nothing maps to"
								)
								return
							case "a repeated character of from":
								refused(
									lowered(translation(variable("v"), text("aa"), text("bc")), "check"),
									"MalformedDescription"
								)
								succeeded(
									lowered(translation(variable("v"), text("ab"), text("cc")), "check"),
									"a repeated character of to"
								)
								return
							case "a column as from":
								refused(
									lowered(translation(variable("v"), variable("w"), text("a")), "check"),
									"MalformedDescription"
								)
								return
							case "a subject that is no text":
								refused(
									lowered(translation(variable("n"), text("1"), text("2")), "check"),
									"MalformedDescription"
								)
								return
							case "translate in a query over an unbounded text":
								refused(
									lowered(translation(variable("v"), text("A"), text("a")), "query"),
									"UnsupportedOperation"
								)
								succeeded(
									lowered(translation(variable("b"), text("A"), text("a")), "query"),
									"a query over a bounded text"
								)
								return
							case "a query's translate spelled as pg_catalog's": {
								/** A query over a bounded text holds the node, which SQL spells as translate over its map's literals. */
								const node = succeeded(
									lowered(translation(variable("b"), text("A"), text("a")), "query")
								).root.expr
								if (node.kind !== "op") {
									return assert.fail(`an op node, not ${node.kind}`)
								}
								const operands: ReadonlyArray<Expr> = [
									col("r0", "b"),
									lit.text("A", types.text),
									lit.text("a", types.text)
								]
								const sql = defined(defaultOps(node, operands), "the node's SQL")
								if (sql.kind !== "call" || sql.star) {
									return assert.fail(`a call, not ${sql.kind}`)
								}
								assert.deepEqual(
									sql.fn,
									{ kind: "builtin", name: "translate" },
									"pg_catalog's translate"
								)
								assert.deepEqual(sql.args, operands, "over the subject and the map")
								return
							}
							case "a map of two lengths at the builder":
								throwsRefused(
									() => Compute.translate(v("v", testPg.text), "ab", "c"),
									"MalformedDescription"
								)
								return
							case "a term as from at the builder":
								throwsRefused(
									() => Compute.translate(v("v", testPg.text), v("w", testPg.text), "c"),
									"MalformedDescription"
								)
								return
						}
					})
			)
		)
	)

	/** A cast whose proof rests on one language's inclusion in another, and what compiling it gives. */
	type Inclusion =
		| "an image inside the target"
		| "an image outside the target"
		| "an unrefined text"
		| "a contract over the target's text"
		| "a refinement past the analysis bounds"
		| "a parse past the analysis bounds"

	const inclusions: Arr.NonEmptyReadonlyArray<Inclusion> = [
		"an image inside the target",
		"an image outside the target",
		"an unrefined text",
		"a contract over the target's text",
		"a refinement past the analysis bounds",
		"a parse past the analysis bounds"
	]

	/** xs:normalizedString's value space: no tab, LF or CR, at most 200 characters. */
	const normalized: FieldDesc = { kind: "text", source: "^[^\\t\\n\\r]{0,200}$", flags: "su" }
	/** Two counted runs of up to 255 letters, whose own automaton passes the DFA's 2,048 states. */
	const wideWords = "^(?:[a-z]{0,255}x){2}$"
	/** Two runs of up to 200 digits, whose product with numeric(500, 250)'s form passes the DFA's 2,048 states. */
	const longDecimal = "^[0-9]{1,200}(?:\\.[0-9]{1,200})?$"

	const castVars: Readonly<Record<string, LeafBinding>> = {
		t: { kind: "column", type: testPg.regex("^.{0,200}$", "su").scalar },
		v: textColumn,
		e: { kind: "column", type: testPg.regex(wideWords, "u").scalar },
		d: { kind: "column", type: testPg.regex(longDecimal, "u").scalar }
	}

	const cast = (arg: ExprDesc, to: FieldDesc) =>
		lowerWith("check", { kind: "cast", arg, to }, castVars, false, baseParams)

	/** The patterns an undecided inclusion names, inner then outer: a ResourceBound naming any other fails. */
	const undecided = (refusal: CompileError): readonly [string, string] => {
		const reason = refusal.reason
		return reason._tag === "ResourceBound" && reason.bound.kind === "regexInclusion"
			? [reason.bound.inner, reason.bound.outer]
			: assert.fail(`an undecided inclusion, not ${refusal.message}`)
	}

	it.effect(
		"proves a cast into a refined text by language inclusion, and names the analysis bounds it cannot pass",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/compute/translate-inclusion",
						generator: element(inclusions),
						literal: Formatter.format,
						limit: inclusions.length,
						box: "a cast of a translation, of plain text and of patterns past the analysis bounds",
						oracle: { kind: "specification", name: "the contract and lexical preconditions" },
						coverage: requiredInSpace<Inclusion>(inclusions),
						caseHang
					},
					(name, k) =>
						Effect.sync(() => {
							k.note(name)
							switch (name) {
								case "an image inside the target":
									succeeded(
										cast(translation(variable("t"), text("\t\n\r"), text("   ")), normalized),
										"every tab, LF and CR becomes a space"
									)
									return
								case "an image outside the target":
									refused(
										cast(translation(variable("t"), text("\t"), text(" ")), normalized),
										"PartialOperation"
									)
									return
								case "an unrefined text":
									refused(cast(variable("v"), normalized), "PartialOperation")
									return
								case "a contract over the target's text":
									refused(
										cast(translation(variable("t"), text("\t\n\r"), text("   ")), {
											kind: "contract",
											name: "Short",
											base: normalized,
											predicate: {
												kind: "compare",
												op: "le",
												left: { kind: "compute", fn: "charLength", args: [{ kind: "value" }] },
												right: { kind: "literal", value: 10, type: undefined }
											},
											facts: []
										}),
										"PartialOperation",
										"the image lies in the contract's base, but nothing proves its predicate"
									)
									return
								case "a refinement past the analysis bounds":
									assert.deepEqual(
										undecided(
											refused(
												cast(variable("e"), { kind: "text", source: "^[a-x]*$", flags: "u" }),
												"ResourceBound"
											)
										),
										[`/${wideWords}/u`, "/^[a-x]*$/u"]
									)
									return
								case "a parse past the analysis bounds":
									assert.equal(
										undecided(
											refused(
												cast(variable("d"), { kind: "numeric", precision: 500, scale: 250 }),
												"ResourceBound"
											)
										)[0],
										`/${longDecimal}/u`
									)
									return
							}
						})
				)
			)
	)
})
