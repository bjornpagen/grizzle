/**
 * computeCore.translate and computeCore.lowerAscii, typed and lowered as a check lowers them, and evaluated on the host
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
 */

import { regexDfaMaxStates, regexDfaMaxWork } from "@bjornpagen/grizzle-text/regex/limits"
import { codePoints, codePointsText, collapsed } from "@bjornpagen/grizzle-text/text"
import { assert, assertVariant, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { array } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { ExprDesc, FieldDesc } from "#compiler/ir/desc.ts"
import type { OpenExpr } from "#compiler/ir/open.ts"
import { textInfoBounds, textOf, textPatterns } from "#compiler/ir/scalar.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { charMapOf, imageOf } from "#compiler/scalar/regex/translate.ts"
import { collapseSources } from "#compiler/scalar/regex/whitespace.ts"
import { AnalyzedPatterns, analyzeText } from "#compiler/text/refinement.ts"
import { refusalLoc, refused, succeeded, throwsRefused } from "#test/support/assert.ts"
import { textDesc } from "#test/support/fixtures/ir/desc.ts"
import { jsMatcher } from "#test/support/regex.ts"
import {
	baseParams,
	type LeafBinding,
	lowerWith,
	spelledExpr,
	testPg,
	v
} from "#test/unit/compute/support.ts"
import {
	byDefinition,
	castGen,
	collapseCase,
	collapsedTexts,
	type CollapseFeature,
	type CollapseImageFeature,
	collapsing,
	escapedPoint,
	type Fault,
	faults,
	imageCase,
	type ImageFeature,
	imageMembers,
	type TranslatedInclusion,
	isAsciiCapital,
	isXmlSpace,
	longestOf,
	mapped,
	plantedGen,
	preimages,
	spaceCharacter,
	text,
	textColumn,
	translation,
	translationCase,
	type TranslationFeature,
	values,
	variable,
	vars
} from "#test/unit/compute/translate.fixtures.ts"
import { stringsOver } from "#test/unit/text/generators.ts"

/** Text.translate and Text.lowerAscii translate and lowerAscii agree with the map on the host and in the reference. Its budget is its suite's before it was a property (test/unit/compute/translate.test.ts at 4ca3036a): 300 runs and 300 steered cases. */
export const computesTranslateAndLowerAsciiTranslateAndLowerAsciiAgreeWithTheMapOnTheHostAndInTheReference =
	property.explore(translationCase, {
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: [
			"a character replaced",
			"a character kept",
			"a supplementary character replaced",
			"a capital lowered",
			"a non-ASCII letter kept"
		] satisfies ReadonlyArray<Reached<TranslationFeature>>,
		check: (_, k: Case<TranslationFeature>) => (c) =>
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
						spelledExpr(computeCore.lowerAscii(v("v", testPg.text)).expr),
						{ v: textColumn },
						false,
						baseParams
					),
					"lowerAscii"
				).root.expr
				for (const s of c.texts) {
					const row = new Map<string, string>([["v", s]])
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
			}),
		oracle: {
			kind: "second-implementation",
			name: "the map applied by hand, character by character, and the reference evaluator"
		},
		kept: [],
		kills: [
			{
				file: "packages/text/src/regex/charset.ts",
				original: "[\n\tObject.freeze([minScalar, surrogateLo - 1] as const),\n\t",
				replacement: "[",
				why: "Operator mutant fd95941c1e at packages/text/src/regex/charset.ts:36 in <module>: `[  Object.freeze([minScalar, surrogateLo - 1] as const),  ` becomes `[`; the property fails (the census, lane TESTPOLICY2)."
			}
		]
	})

/** Text.translate and Text.lowerAscii types a translation as text of exactly the image of its operand's language. Its budget is its suite's before it was a property (test/unit/compute/translate.test.ts at 4ca3036a): 400 runs and 400 steered cases. */
export const computesTranslateAndLowerAsciiTypesATranslationAsTextOfExactlyTheImageOfItsOperandsLanguage =
	property.explore(imageCase, {
		needs: {},
		budget: { runs: 400, steered: 400 },
		situations: [
			"an image member",
			"a non-member",
			"a member through a moved character",
			"a match of the operand outside the image",
			"a bounded operand",
			"a wildcard operand",
			"an exact image past the measures"
		] satisfies ReadonlyArray<Reached<ImageFeature>>,
		check: (_, k: Case<ImageFeature>) => (c) =>
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
				if (textInfoBounds(operandText) !== undefined) {
					k.note("a bounded operand")
					assert.ok(textInfoBounds(image) !== undefined, "a bounded operand's image is bounded")
				}
				/**
				 * The exact image types the term wherever it fits PostgreSQL's regex compile space, the measures every
				 * refinement is admitted under; past them the pattern's own image does, which holds every value of the
				 * image and may hold more.
				 */
				const [operandPattern] = textPatterns(operandText)
				const exact = analyzeText(
					[
						{
							source: imageOf(
								operandPattern,
								succeeded(charMapOf(codePointsText(c.map.from), codePointsText(c.map.to))),
								new AnalyzedPatterns()
							).exact,
							flags: "u"
						}
					],
					SourceLoc("the exact image", [])
				).ok
				if (!exact) {
					k.note("an exact image past the measures")
				}
				const ofImage = Arr.map(textPatterns(image), (p) => jsMatcher(p.source, p.flags))
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
			}),
		oracle: {
			kind: "second-implementation",
			name: "ECMAScript's own test of the operand's pattern over every preimage"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/compute/translate.test.ts#computesTranslateAndLowerAsciiTypesATranslationAsTextOfExactlyTheImageOfItsOperandsLanguage:-:0.3.0.0.1.0.1.3.0.1.0.1.2.0.2.0.1"
				),
				reason:
					"a code point and a chain whose own image fits the depth measure and whose exact image, eight arcs deeper for the prefix and the suffix it writes out, passes it; the measure keeps half of PostgreSQL's measured stack edge free, so PostgreSQL itself still compiles that image: the pattern's own image types the term",
				since: "2026-11-08"
			}
		],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original:
					"\t\t\treturn analysis.patterns.language([exact]).ok\n\t\t\t\t? exact\n\t\t\t\t: { source: sources.within, flags: imageFlags }",
				replacement: "\t\t\treturn { source: sources.within, flags: imageFlags }",
				why: "A translation's type is the looser image even where the exact one is admitted; the image type property fails."
			}
		]
	})

/** Text.translate and Text.lowerAscii refuses each fault planted in a valid translation or collapse by its reason and place, and compiles the term without it. Its budget is its suite's before it was a property (test/unit/compute/translate.test.ts at 4ca3036a): 300 runs and 400 steered cases. */
export const computesTranslateAndLowerAsciiRefusesEachFaultPlantedInAValidTranslationOrCollapseByItsReasonAndPlaceAndCompilesTheTermWithoutIt =
	property.explore(plantedGen, {
		needs: {},
		budget: { runs: 300, steered: 400 },
		situations: faults satisfies ReadonlyArray<Reached<Fault>>,
		check: (_, k: Case<Fault>) => (p) =>
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
					assert.deepEqual(refusalLoc(refused(lowered(desc, mode), tag, label)).path, path, label)
				}
				const { from, to } = p.map
				const termOver = (over: string): ExprDesc =>
					p.term === "translate"
						? translation(variable(over), text(codePointsText(from)), text(codePointsText(to)))
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
									? computeCore.translate(
											v("v", testPg.text),
											v("w", testPg.text),
											codePointsText(to)
										)
									: computeCore.translate(
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
											? computeCore.translate(
													v("n", testPg.integer),
													codePointsText(from),
													codePointsText(to)
												)
											: computeCore.collapse(v("n", testPg.integer)),
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
			}),
		oracle: {
			kind: "specification",
			name: "translate's map, collapse's operand and their modes"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/regex/translate.ts",
				original: `\t\tif (map.has(source)) {\n\t\t\treturn Result.err(\n\t\t\t\t\`from holding each character once: \${JSON.stringify(codePointsText([source]))} is repeated, and PostgreSQL maps a repeated character by its first occurrence alone\`\n\t\t\t)\n\t\t}\n`,
				replacement: "",
				why: "A repeated character of from is admitted; the refusals' property fails."
			}
		]
	})

/** Text.translate and Text.lowerAscii proves a cast into a refined text exactly by the image's inclusion, and names the analysis bounds it cannot pass. Its budget is its suite's before it was a property (test/unit/compute/translate.test.ts at 4ca3036a): 200 runs and 400 steered cases. */
export const computesTranslateAndLowerAsciiProvesACastIntoARefinedTextExactlyByTheImagesInclusionAndNamesTheAnalysisBoundsItCannotPass =
	property.explore(castGen, {
		needs: {},
		budget: { runs: 200, steered: 400 },
		situations: [
			"an image inside the target",
			"an image outside the target",
			"a contract's predicate unproved",
			"any text outside the target",
			"a collapse inside the collapsed texts",
			"a refinement past the analysis bounds",
			"a parse past the analysis bounds"
		] satisfies ReadonlyArray<Reached<TranslatedInclusion>>,
		check:
			(_, k: Case<TranslatedInclusion>) =>
			([operand, target]) =>
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
					const cast = lowerWith("check", { kind: "cast", arg, to }, castVars, false, baseParams)
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
							[`/${past}/u`, regexDfaMaxStates, regexDfaMaxWork],
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
							[regexDfaMaxStates, regexDfaMaxWork],
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
				}),
		oracle: {
			kind: "second-implementation",
			name: "a finite language's members mapped, judged by ECMAScript's own test of the target"
		},
		kept: [],
		kills: [
			{
				file: "packages/text/src/regex/inclusion.ts",
				original: "\t\tif (first.accept && second?.accept !== true) {",
				replacement: "\t\tif (first.accept && second === undefined) {",
				why: "Inclusion takes an image member at a state the target does not accept as inside it; the casts by inclusion property fails."
			}
		]
	})

/** Text.translate and Text.lowerAscii collapse and replaceWhitespace agree with XML Schema's definition. Its budget is its suite's before it was a property (test/unit/compute/translate.test.ts at 4ca3036a): 200 runs and 200 steered cases. */
export const computesTranslateAndLowerAsciiCollapseAndReplaceWhitespaceAgreeWithXMLSchemasDefinition =
	property.explore(array(stringsOver(spaceCharacter, 10), { min: 1, max: 24 }), {
		needs: {},
		budget: { runs: 200, steered: 200 },
		situations: [
			"a run folded",
			"an end trimmed",
			"a no-break space kept",
			"a character replaced"
		] satisfies ReadonlyArray<Reached<CollapseFeature>>,
		check: (_, k: Case<CollapseFeature>) => (texts) =>
			Effect.sync(() => {
				const lowered = (term: { readonly expr: OpenExpr }) =>
					succeeded(
						lowerWith("check", spelledExpr(term.expr), { v: textColumn }, false, baseParams)
					).root.expr
				const collapse = lowered(computeCore.collapse(v("v", testPg.text)))
				const replace = lowered(computeCore.replaceWhitespace(v("v", testPg.text)))
				for (const s of texts) {
					const row = new Map<string, string>([["v", s]])
					const expected = byDefinition(s)
					const got = values(collapse, row)
					assert.equal(got.host, expected, `collapse on the host over ${Formatter.format(s)}`)
					assert.equal(
						got.reference,
						expected,
						`collapse in the reference over ${Formatter.format(s)}`
					)
					const replaced = codePointsText(Arr.map(codePoints(s), (c) => (isXmlSpace(c) ? 0x20 : c)))
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
					if (points.length > 0 && (isXmlSpace(points[0] ?? 0) || isXmlSpace(points.at(-1) ?? 0))) {
						k.note("an end trimmed")
					}
					if (Arr.contains(codePoints(expected), 0xa0)) {
						k.note("a no-break space kept")
					}
					if (replaced !== s) {
						k.note("a character replaced")
					}
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "XML Schema's definition by pieces, and the reference evaluator"
		},
		kept: [],
		kills: [
			{
				file: "packages/text/src/text.ts",
				original: "\tconst inner = trimmed(text)\n",
				replacement: "\tconst inner = text\n",
				why: "The host's collapse keeps a space for the white space at either end; the collapse property fails."
			}
		]
	})

/** Text.translate and Text.lowerAscii types a collapse as text holding its image within the operand's length bound. Its budget is its suite's before it was a property (test/unit/compute/translate.test.ts at 4ca3036a): 400 runs and 400 steered cases. */
export const computesTranslateAndLowerAsciiTypesACollapseAsTextHoldingItsImageWithinTheOperandsLengthBound =
	property.explore(collapseCase, {
		needs: {},
		budget: { runs: 400, steered: 400 },
		situations: [
			"an image member",
			"an image non-member",
			"an exact image",
			"a bounded image",
			"an image with no white space"
		] satisfies ReadonlyArray<Reached<CollapseImageFeature>>,
		check: (_, k: Case<CollapseImageFeature>) => (c) =>
			Effect.sync(() => {
				if (!analyzeText([{ source: c.source, flags: c.flags }], SourceLoc("str.regex", [])).ok) {
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
				const [operandPattern] = textPatterns(operandText)
				const chosen = defined(
					Arr.findFirst(
						collapseSources(
							operandPattern,
							textInfoBounds(operandText)?.length,
							new AnalyzedPatterns()
						),
						(s) => analyzeText([{ source: s.source, flags: s.flags }], SourceLoc("image", [])).ok
					).pipe(Option.getOrUndefined),
					"an admitted image"
				)
				const operandLength = textInfoBounds(operandText)?.length
				if (operandLength !== undefined && operandLength <= 257) {
					k.note("a bounded image")
					const imageLength = textInfoBounds(image)?.length
					assert.ok(
						imageLength !== undefined && imageLength <= operandLength,
						"collapse never lengthens, so the operand's bound holds"
					)
				}
				const ofImage = Arr.map(textPatterns(image), (p) => jsMatcher(p.source, p.flags))
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
					assert.equal(held, preimaged(t), `${Formatter.format(t)} under /${c.source}/${c.flags}`)
					k.note(held ? "an image member" : "an image non-member")
					if (held && !Arr.some(codePoints(t), isXmlSpace)) {
						k.note("an image with no white space")
					}
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "ECMAScript's own test of the operand's pattern and of the image's"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original:
					'\t\treturn analysis.kind === "unanalyzed" || text === undefined\n\t\t\t? node\n\t\t\t: this.restate(node, this.collapseType(text, analysis, at), node.actual, node.facts)',
				replacement: "\t\treturn node",
				why: "A collapse is typed as any text; the collapse type property fails."
			}
		]
	})
