/**
 * Text's terms: matches, concat, startsWith, endsWith and contains, typed and lowered as a check and a query lower
 * them, and evaluated on the host (scalar/compute/evaluate.ts) and by the reference evaluator
 * (test/support/oracle/evaluate/catalog.ts).
 *
 * - matches: over every regex family's patterns and generated ones, some led by a code point either side of the
 *   surrogates, a literal pattern and a dictionary of two (a conditional of literals, the values a closed payload
 *   holds), both evaluators agree with ECMAScript's own test, the development oracle the text differential holds
 *   against PostgreSQL; the node's pattern table holds each value the pattern can take once, in code point order by
 *   the code points themselves, never UTF-16's, each with the ARE str.regex's own lowering prints for it; and the node
 *   refuses exactly where str.regex refuses one of its patterns for what it is, a pattern of the empty language
 *   matching no text where str.regex refuses it as a type of no value.
 * - concat, startsWith, endsWith and contains: by construction, a text that begins or ends with another or holds it
 *   between two texts, or a drawn pair; the host's string methods against the reference's code point walks, and the
 *   equation with a concatenation, which no lowering builds, against the concatenation itself.
 * - the refusals: a fault planted in a valid term, one for each refusal (a pattern past the compile space, outside the
 *   grammar or malformed, a guard's pattern with no member, a pattern no measure bounds, a subject that is no text or
 *   unbounded in a query, concat in a query, a literal the builder refuses, a literal outside a guard's language), each by its
 *   reason and the place it states, and the term without its fault compiles; and the SQL `~` reads in the SQL the
 *   node lowers to: a pattern whose SQL is a text literal hands it that literal's ARE, and any other a CASE over the
 *   pattern's SQL with an arm per value it takes, one value read through a conditional among them, asserted by its
 *   structure.
 *
 * Features: each family and generated pattern, led either side of the surrogates, a literal and a dictionary pattern,
 * a match and a miss; each affix construction; each planted refusal; a literal's ARE, a CASE of one value and a
 * dictionary's CASE.
 */

import { parsePattern } from "@bjornpagen/grizzle-text/regex/parse"
import { codePoints, codePointsText } from "@bjornpagen/grizzle-text/text"
import { assert, assertVariant, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import {
	decodeDesc,
	type ExprDesc,
	type GuardDesc,
	guardedExpr,
	literalPattern
} from "#compiler/ir/desc.ts"
import { regexMaxDepth, colorsOf, rawSize } from "#compiler/ir/pattern-space.ts"
import { admitSpelling, type PatternValue } from "#compiler/ir/pattern.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { matchAre } from "#compiler/scalar/regex/admit.ts"
import type { Expr } from "#compiler/sql/ast.ts"
import { lit, types } from "#compiler/sql/build.ts"
import { analyzeText } from "#compiler/text/refinement.ts"
import { refused, succeeded, throwsRefused } from "#test/support/assert.ts"
import { spelled } from "#test/support/fixtures/ir/scalar.ts"
import { jsMatcher } from "#test/support/regex.ts"
import {
	baseParams,
	lowerWith,
	plainRender,
	sqlOf,
	testPg,
	v
} from "#test/support/unit/compute/support.ts"
import {
	affix,
	type AffixFeature,
	areOf,
	boolColumn,
	boundedColumn,
	computeDesc,
	emptyLanguage,
	escaped,
	type Fault,
	faults,
	matchCase,
	type MatchFeature,
	matchNode,
	casePattern,
	pathOf,
	patternLiteral,
	plantedGen,
	type Row,
	type Spelling,
	spellingGen,
	tableOf,
	text,
	textColumn,
	values,
	variable,
	vars
} from "#test/support/unit/compute/text.fixtures.ts"

/** Text's terms matches agrees with ECMAScript on the host and in the reference evaluator. Its budget is its suite's before it was a property (test/unit/compute/text.test.ts at 4ca3036a): 400 runs and 400 steered cases. */
export const computesTextTermsMatchesAgreesWithECMAScriptOnTheHostAndInTheReferenceEvaluator =
	property.explore(matchCase, {
		needs: {},
		budget: { runs: 400, steered: 400 },
		situations: [
			"match",
			"no match",
			"dictionary of two",
			"the empty language"
		] satisfies ReadonlyArray<Reached<MatchFeature>>,
		check: (_, k: Case<MatchFeature>) => (c) =>
			Effect.sync(() => {
				/** A source str.regex refuses for what it is, not for the empty language, which a match holds of no text. */
				const declaredRefused = Arr.some(
					c.sources,
					(s) =>
						!analyzeText([{ source: s, flags: "u" }], SourceLoc("str.regex", [])).ok &&
						!emptyLanguage(s)
				)
				const admitted = Arr.map(c.sources, admitSpelling)
				assert.equal(
					!Arr.every(admitted, (a) => a.ok),
					declaredRefused,
					"a pattern value admitted exactly where str.regex admits the pattern for what it is, not for its empty language"
				)
				const spellings = Arr.flatMap(admitted, (a) => (a.ok ? [a.value] : []))
				if (!Arr.isReadonlyArrayNonEmpty(spellings) || spellings.length !== c.sources.length) {
					return
				}
				const lowered = succeeded(
					lowerWith(
						"check",
						computeDesc("matches", variable("v"), casePattern(spellings)),
						{ v: textColumn, p: boolColumn },
						true,
						baseParams
					)
				)
				if (Arr.some(c.sources, emptyLanguage)) {
					k.note("the empty language")
				}
				const node = matchNode(lowered.root.expr)
				assert.deepEqual(
					Arr.fromIterable(node.patterns),
					Arr.fromIterable(tableOf(spellings)),
					"each value the pattern can take, once, by its language and then its spelling"
				)
				for (const value of node.patterns) {
					const declared = analyzeText(
						[{ source: value.spelling, flags: "u" }],
						SourceLoc("str.regex", [])
					)
					if (declared.ok) {
						assert.equal(
							matchAre(value.spelling),
							declared.value.members[0].are,
							`the ARE str.regex prints for /${value.spelling}/u`
						)
						assert.equal(
							value.pattern,
							declared.value.digest,
							`the language key str.regex's type of /${value.spelling}/u is keyed by`
						)
					}
				}
				if (c.sources.length === 2) {
					k.note("dictionary of two")
				}
				const chosen = c.pick || c.sources.length === 1 ? c.sources[0] : defined(c.sources[1])
				const ofChosen = jsMatcher(chosen, "u")
				for (const s of c.strings) {
					const expected = ofChosen(s)
					const { host, reference } = values(
						node,
						new Map<string, string | boolean>([
							["v", s],
							["p", c.pick]
						])
					)
					assert.equal(host, expected, `the host on /${chosen}/u over ${Formatter.format(s)}`)
					assert.equal(
						reference,
						expected,
						`the reference on /${chosen}/u over ${Formatter.format(s)}`
					)
					k.note(expected ? "match" : "no match")
				}
			}),
		oracle: { kind: "second-implementation", name: "ECMAScript's own RegExp test" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/evaluate.ts",
				original:
					'\t\t\t\tResult.ok(patterns.matches(hostOf("text", b(args)), hostOf("text", a(args))))',
				replacement:
					'\t\t\t\tResult.ok(hostOf("text", a(args)).length > 0 && patterns.matches(hostOf("text", b(args)), hostOf("text", a(args))))',
				why: "The host never matches the empty text; the matches property fails."
			}
		]
	})

/** Text's terms concat, startsWith, endsWith and contains agree between the host and the reference's code points. Its budget is its suite's before it was a property (test/unit/compute/text.test.ts at 4ca3036a): 600 runs and 600 steered cases. */
export const computesTextTermsConcatStartsWithEndsWithAndContainsAgreeBetweenTheHostAndTheReferencesCodePoints =
	property.explore(affix, {
		needs: {},
		budget: { runs: 600, steered: 600 },
		situations: [
			"prefix held",
			"suffix held",
			"prefix refused",
			"suffix refused",
			"containment held",
			"containment refused",
			"equation held",
			"equation refused"
		] satisfies ReadonlyArray<Reached<AffixFeature>>,
		check: (_, k: Case<AffixFeature>) => (a) =>
			Effect.sync(() => {
				const row: Row = new Map<string, string | boolean>([
					["w", a.whole],
					["p", a.part],
					["r", a.rest]
				])
				const check = (desc: ExprDesc, predicate: boolean) =>
					values(
						succeeded(
							lowerWith(
								"check",
								desc,
								{ w: textColumn, p: textColumn, r: textColumn },
								predicate,
								baseParams
							),
							Formatter.format(desc)
						).root.expr,
						row
					)
				const starts = check(computeDesc("startsWith", variable("w"), variable("p")), true)
				const ends = check(computeDesc("endsWith", variable("w"), variable("p")), true)
				assert.equal<unknown>(starts.host, starts.reference, "startsWith on both sides")
				assert.equal<unknown>(ends.host, ends.reference, "endsWith on both sides")
				if (a.kind === "prefix") {
					assert.equal(starts.host, true, "a text begins with what it was built from")
				}
				if (a.kind === "suffix") {
					assert.equal(ends.host, true, "a text ends with what it was built from")
				}
				k.note(starts.host === true ? "prefix held" : "prefix refused")
				k.note(ends.host === true ? "suffix held" : "suffix refused")
				const holds = check(computeDesc("contains", variable("w"), variable("p")), true)
				assert.equal<unknown>(holds.host, holds.reference, "contains on both sides")
				if (a.kind !== "drawn") {
					assert.equal(holds.host, true, "a text holds what it was built around")
				}
				k.note(holds.host === true ? "containment held" : "containment refused")
				const joined = check(computeDesc("concat", variable("p"), variable("r")), false)
				assert.equal(joined.host, `${a.part}${a.rest}`, "concat on the host")
				assert.equal(joined.reference, `${a.part}${a.rest}`, "concat in the reference")
				/** The equation, decided without building the concatenation (typing.ts concatEquation). */
				const equation = check(
					{
						kind: "compare",
						op: "eq",
						left: variable("w"),
						right: computeDesc("concat", variable("p"), variable("r"))
					},
					true
				)
				const built = a.whole === `${a.part}${a.rest}`
				assert.equal(equation.host, built, "the equation on the host")
				assert.equal(equation.reference, built, "the equation in the reference")
				k.note(built ? "equation held" : "equation refused")
			}),
		oracle: {
			kind: "second-implementation",
			name: "the reference evaluator's code point walks, and texts built to begin, end or hold so"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/evaluate.ts",
				original:
					'\t\t\treturn (args) => Result.ok(hostOf("text", a(args)).endsWith(hostOf("text", b(args))))',
				replacement:
					'\t\t\treturn (args) => Result.ok(hostOf("text", a(args)).includes(hostOf("text", b(args))))',
				why: "The host evaluates endsWith as includes; the affix property fails."
			},
			{
				file: "packages/engine/src/scalar/compute/evaluate.ts",
				original:
					'\t\t\treturn (args) => Result.ok(hostOf("text", a(args)).includes(hostOf("text", b(args))))',
				replacement:
					'\t\t\treturn (args) => Result.ok(hostOf("text", a(args)).startsWith(hostOf("text", b(args))))',
				why: "The host evaluates contains as startsWith, so a text holding its part past its start is refused; the affix property fails."
			}
		]
	})

/** Text's terms refuses each fault planted in a valid term by its reason and fields, and compiles the term without it. Its budget is its suite's before it was a property (test/unit/compute/text.test.ts at 4ca3036a): 400 runs and 400 steered cases. */
export const computesTextTermsRefusesEachFaultPlantedInAValidTermByItsReasonAndFieldsAndCompilesTheTermWithoutIt =
	property.explore(plantedGen, {
		needs: {},
		budget: { runs: 400, steered: 400 },
		situations: faults satisfies ReadonlyArray<Reached<Fault>>,
		check: (_, k: Case<Fault>) => (p) =>
			Effect.sync(() => {
				k.note(p.fault)
				const label = Formatter.format(p)
				const subject = p.mode === "query" ? "b" : "v"
				const lowered = (desc: ExprDesc, mode: "check" | "query") =>
					lowerWith(mode, desc, vars, true, baseParams)
				/** The term reading the pattern value `pattern` at the case's site, over `over`. */
				const read = (over: string, pattern: PatternValue): ExprDesc =>
					p.site === "matches"
						? computeDesc("matches", variable(over), patternLiteral(pattern))
						: {
								kind: "when",
								guard: { kind: "matches", pattern },
								subject: variable(over),
								proved: {
									kind: "compare",
									op: "eq",
									left: variable(over),
									right: variable(over)
								},
								otherwise: { kind: "literal", value: false }
							}
				const admitted = spelled(p.pattern)
				const valid = read(subject, admitted)
				/**
				 * The decode of the valid term with its pattern value forged to the spelling `spelling` and the valid
				 * key, refused where the literal stands, the valid term decoded.
				 */
				const forgedRefused = (spelling: string): void => {
					const error = refused(
						decodeDesc("expr", read(subject, { pattern: admitted.pattern, spelling })),
						"MalformedDescription",
						label
					)
					assert.deepEqual(
						pathOf(error),
						p.site === "matches" ? ["args", 1, "value"] : ["guard", "pattern"],
						label
					)
					succeeded(decodeDesc("expr", valid), `${label} decoded`)
				}
				/** The refusal of the faulted term at `path` below the site, for `tag`. */
				const refusedBelow = (
					faulted: ExprDesc,
					mode: "check" | "query",
					tag: CompileError["reason"]["_tag"],
					path: ReadonlyArray<string | number>
				): CompileError => {
					const error = refused(lowered(faulted, mode), tag, label)
					assert.deepEqual(pathOf(error), [p.site, ...path], label)
					return error
				}
				const compiles = (desc: ExprDesc, mode: "check" | "query"): void => {
					succeeded(lowered(desc, mode), `${label} without its fault`)
				}
				const pastSpace = `(?:(?:[${escaped(p.point)}${escaped(p.other)}]{1,255}){255}){${p.copies}}`
				const pastIr = succeeded(parsePattern(pastSpace, "u"), pastSpace)
				assert.ok(pastIr.kind !== "never", pastSpace)
				const pastBound = {
					kind: "regexCompileSpace",
					pattern: `/${pastSpace}/u`,
					measure: {
						kind: "depth",
						limit: regexMaxDepth,
						needed: rawSize(pastIr, colorsOf(pastIr)).depth
					}
				} as const
				const emptied = (pattern: string): string => {
					switch (p.emptying) {
						case "a code point after the end":
							return `(?:${pattern})$${escaped(p.point)}`
						case "a code point before the start":
							return `${escaped(p.point)}^(?:${pattern})`
						case "an empty class":
							return `(?:${pattern})[]`
					}
				}
				switch (p.fault) {
					case "a pattern past the compile space": {
						/**
						 * A pattern value is admitted where it is made: computeCore.pattern refuses one past the compile
						 * space (a literal past the compile space at the builder), and so does a decode.
						 */
						const refusal = admitSpelling(pastSpace)
						assert.ok(!refusal.ok, label)
						assertVariant(refusal.error, "kind", "compileSpace", label)
						assert.deepEqual(refusal.error.measure, pastBound.measure, label)
						forgedRefused(pastSpace)
						compiles(valid, p.mode)
						return
					}
					case "a construct outside the grammar":
					case "a malformed pattern": {
						const faulted = `${p.pattern}${p.construct}`
						const error = throwsRefused(
							() => computeCore.pattern(faulted),
							p.fault === "a malformed pattern" ? "MalformedDescription" : "UnsupportedOperation",
							label
						)
						assert.deepEqual(pathOf(error), ["pattern", codePoints(p.pattern).length], label)
						forgedRefused(faulted)
						compiles(valid, p.mode)
						return
					}
					case "a pattern value of another spelling's key":
						forgedRefused(`(?:${p.pattern})${escaped(p.point)}`)
						compiles(valid, p.mode)
						return
					case "a pattern no text matches": {
						/**
						 * A match of the empty language holds of no text, and compiles; a guard of it would read its
						 * subject as text of no value in its branch, which the text analysis refuses there.
						 */
						const faulted = read(subject, spelled(emptied(p.pattern)))
						if (p.site === "matches") {
							compiles(faulted, p.mode)
							return
						}
						const error = refused(lowered(faulted, p.mode), "UnsupportedOperation", label)
						assert.deepEqual(pathOf(error), ["pattern"], label)
						compiles(valid, p.mode)
						return
					}
					case "a column as the pattern":
					case "a parameter as the pattern":
					case "a computed pattern": {
						/** A query refuses a concatenation before it reads the pattern (concat in a query). */
						const mode = p.fault === "a computed pattern" ? "check" : p.mode
						const pattern: ExprDesc =
							p.fault === "a column as the pattern"
								? variable("w")
								: p.fault === "a parameter as the pattern"
									? { kind: "param", name: "p", type: testPg.text.desc }
									: computeDesc("concat", variable("w"), text(p.pattern))
						const error = refused(
							lowered(computeDesc("matches", variable(subject), pattern), mode),
							"UnsupportedOperation",
							label
						)
						assert.deepEqual(pathOf(error), ["matches", "pattern"], label)
						compiles(computeDesc("matches", variable(subject), patternLiteral(admitted)), mode)
						return
					}
					case "a subject that is no text":
						refusedBelow(read("n", admitted), p.mode, "MalformedDescription", [])
						compiles(valid, p.mode)
						return
					case "an unbounded subject in a query":
						refusedBelow(read("v", admitted), "query", "UnsupportedOperation", [])
						compiles(read("v", admitted), "check")
						compiles(read("b", admitted), "query")
						return
					case "concat in a query": {
						const affix = computeDesc(
							"startsWith",
							computeDesc("concat", variable(subject), variable("w")),
							text(codePointsText([p.point]))
						)
						const error = refused(lowered(affix, "query"), "UnsupportedOperation", label)
						assert.deepEqual(pathOf(error), ["startsWith", 0, "concat"], label)
						compiles(affix, "check")
						return
					}
					case "a literal past the compile space at the builder": {
						const error = throwsRefused(
							() => computeCore.pattern(pastSpace),
							"ResourceBound",
							label
						)
						assert.deepEqual(pathOf(error), ["pattern"], label)
						assertVariant(error.reason, "_tag", "ResourceBound", label)
						assert.deepEqual(error.reason.bound, pastBound, label)
						computeCore.matches(v("v", testPg.text), computeCore.pattern(p.pattern))
						return
					}
					case "a literal outside a match guard's language": {
						/**
						 * Inside a guard's branch a match of a literal pattern retypes its subject as text of the
						 * pattern's language, so a literal compared with it there is judged by that language: the
						 * longest member and one more code point is none, and a member is.
						 */
						const longest = Arr.reduce(p.language.members, "", (a, m) =>
							codePoints(m).length > codePoints(a).length ? m : a
						)
						const guard: GuardDesc = { kind: "matches", pattern: spelled(p.language.source) }
						const guarded = (literal: string): ExprDesc => ({
							kind: "when",
							guard,
							subject: variable(subject),
							proved: {
								kind: "compare",
								op: "eq",
								left: guardedExpr(guard, variable(subject)),
								right: text(literal)
							},
							otherwise: { kind: "literal", value: false }
						})
						const error = refused(
							lowered(guarded(`${longest}${codePointsText([p.point])}`), p.mode),
							"ContractLiteral",
							label
						)
						assert.deepEqual(pathOf(error), ["when", "proved", "eq", "right"], label)
						compiles(guarded(longest), p.mode)
						return
					}
				}
			}),
		oracle: { kind: "specification", name: "matches's admission and concat's modes" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/lower.ts",
				original:
					'\t\tif (this.env.mode === "query" && (bytes === undefined || bytes > regexTextMaxBytes)) {',
				replacement:
					'\t\tif (this.env.mode === "query" && (bytes !== undefined && bytes > regexTextMaxBytes)) {',
				why: "A query's matches over a subject no pattern bounds is admitted; the refusals' property fails."
			}
		]
	})

/** Text's terms hands `~` the ARE of every value its pattern takes, never a source: a literal's ARE, and a conditional of them each arm's ARE in its place, no CASE of sources. Its budget is its suite's before it was a property (test/unit/compute/text.test.ts at 4ca3036a): 100 runs and 100 steered cases. */
export const computesTextTermsHandsTheAREOfEveryValueItsPatternTakesNeverASource = property.explore(
	spellingGen,
	{
		needs: {},
		budget: { runs: 100, steered: 100 },
		situations: [
			"a literal's ARE",
			"a conditional of one value",
			"a conditional of two values"
		] satisfies ReadonlyArray<Reached<Spelling>>,
		check: (_, k: Case<Spelling>) => (spelling) =>
			Effect.sync(() => {
				const node = matchNode(
					succeeded(
						lowerWith(
							"query",
							computeDesc("matches", variable("v"), spelling.desc),
							{ v: boundedColumn, p: boolColumn },
							true,
							baseParams
						)
					).root.expr
				)
				assert.deepEqual(
					Arr.fromIterable(node.patterns),
					Arr.fromIterable(tableOf(Arr.map(spelling.sources, spelled))),
					"each distinct spelling once, by its language and then its spelling"
				)
				const sql = sqlOf(node, plainRender)
				if (sql.kind !== "binary" || sql.op !== "~") {
					return assert.fail(`a ~, not ${sql.kind}`)
				}
				k.note(
					spelling.desc.kind !== "cond"
						? "a literal's ARE"
						: node.patterns.length === 1
							? "a conditional of one value"
							: "a conditional of two values"
				)
				/** The pattern as `~` must read it: each literal its ARE's literal, a conditional each arm's in its place. */
				const expected = (desc: ExprDesc, at: Expr): void => {
					if (desc.kind !== "cond") {
						const value = desc.kind === "literal" ? literalPattern(desc.value) : undefined
						assert.ok(value !== undefined, "a literal pattern")
						assert.deepEqual(
							at,
							lit.text(areOf(value.spelling), types.text),
							"a literal pattern is its ARE's literal"
						)
						return
					}
					if (at.kind !== "case" || at.operand !== undefined) {
						return assert.fail(`a conditional's searched CASE, not ${at.kind}`)
					}
					const [arm, ...more] = at.whens
					assert.equal(more.length, 0, "one condition")
					expected(desc.onTrue, defined(arm, "the condition's arm").result)
					expected(desc.onFalse, at.else)
				}
				expected(spelling.desc, sql.right)
			}),
		oracle: {
			kind: "specification",
			name: "the pattern's own structure, each literal its ARE (lower/conservative/expr/index.ts patternAre)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/expr/index.ts",
				original:
					"\t\t\treturn lit.text(matchAre(lowering.spelling(pattern.value.value.spelling)), types.text)",
				replacement:
					"\t\t\treturn lit.text(lowering.spelling(pattern.value.value.spelling), types.text)",
				why: "A literal pattern hands `~` its source rather than its ARE; the `~` property fails."
			}
		]
	}
)
