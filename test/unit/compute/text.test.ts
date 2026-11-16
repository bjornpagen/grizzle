/**
 * Compute's text terms: matches, concat, startsWith and endsWith, typed and lowered as a check and a query lower
 * them, and evaluated on the host (scalar/compute/evaluate.ts) and by the reference evaluator
 * (test/support/oracle/evaluate/catalog.ts).
 *
 * - matches: over every regex family's patterns and generated ones, some led by a code point either side of the
 *   surrogates, a literal pattern and a dictionary of two (a conditional of literals, the values a closed payload
 *   holds), both evaluators agree with ECMAScript's own test, the development oracle the text differential holds
 *   against PostgreSQL; the node's pattern table holds each value the pattern can take once, in code point order by
 *   the code points themselves, never UTF-16's, each with the ARE str.regex's own lowering prints for it; and the node
 *   refuses exactly where str.regex refuses one of its patterns.
 * - concat, startsWith and endsWith: by construction, a text that begins or ends with another, or a drawn pair; the
 *   host's string methods against the reference's code point walks, and the equation with a concatenation, which no
 *   lowering builds, against the concatenation itself.
 * - the refusals: a fault planted in a valid term, one for each refusal (a pattern past the compile space, outside the
 *   grammar, malformed or with no member, a pattern no measure bounds, a subject that is no text or unbounded in a
 *   query, concat in a query, a literal the builder refuses, a literal outside a guard's language), each by its
 *   reason and the place it states, and the term without its fault compiles; and the SQL `~` reads in the SQL the
 *   node lowers to: a pattern whose SQL is a text literal hands it that literal's ARE, and any other a CASE over the
 *   pattern's SQL with an arm per value it takes, one value read through a conditional among them, asserted by its
 *   structure.
 *
 * Features: each family and generated pattern, led either side of the surrogates, a literal and a dictionary pattern,
 * a match and a miss; each affix construction; each planted refusal; a literal's ARE, a CASE of one value and a
 * dictionary's CASE.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { regexMaxDepth } from "@grizzle/limits"
import { Array as Arr, Effect, Formatter } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { codePoints, codePointsText } from "#compiler/core/text.ts"
import { type ExprDesc, type GuardDesc, guardedExpr } from "#compiler/ir/desc.ts"
import { computeCore as Compute } from "#compiler/scalar/compute/builders.ts"
import type { CarrierValue } from "#compiler/scalar/compute/literal.ts"
import { matchAre } from "#compiler/scalar/regex/admit.ts"
import { parsePattern } from "#compiler/scalar/regex/parse.ts"
import { colorsOf, rawSize } from "#compiler/scalar/regex/space.ts"
import type { Expr } from "#compiler/sql/ast.ts"
import { lit, types } from "#compiler/sql/build.ts"
import { analyzeText } from "#compiler/text/refinement.ts"
import {
	assert,
	assertVariant,
	defined,
	refused,
	succeeded,
	throwsRefused,
	unorderedEqual
} from "#test/support/assert.ts"
import { baseParams, lowerWith, plainRender, sqlOf, testPg, v } from "#test/unit/compute/support.ts"
import {
	affix,
	type AffixFeature,
	areOf,
	boolColumn,
	boundedColumn,
	byCodePoints,
	computeDesc,
	escaped,
	type Fault,
	faults,
	matchCase,
	type MatchFeature,
	matchNode,
	outOfUnitOrder,
	pathOf,
	patternOf,
	plantedGen,
	type Row,
	type Spelling,
	spellingGen,
	text,
	textColumn,
	values,
	variable,
	vars
} from "#test/unit/compute/text.fixtures.ts"
import { jsMatcher } from "#test/unit/text/generators.ts"

/** Compute's text terms matches agrees with ECMAScript on the host and in the reference evaluator. */
export const computesTextTermsMatchesAgreesWithECMAScriptOnTheHostAndInTheReferenceEvaluator =
	property.explore(matchCase, {
		needs: {},
		situations: [
			"match",
			"no match",
			"dictionary of two",
			"sources out of code unit order",
			"refused with str.regex"
		] satisfies ReadonlyArray<Reached<MatchFeature>>,
		check: (_, k: Case<MatchFeature>) => (c) =>
			Effect.sync(() => {
				const lowered = lowerWith(
					"check",
					computeDesc("matches", variable("v"), patternOf(c)),
					{ v: textColumn, p: boolColumn },
					true,
					baseParams
				)
				const declaredRefused = Arr.some(
					c.sources,
					(s) => !analyzeText([{ source: s, flags: "u" }], SourceLoc("str.regex", [])).ok
				)
				assert.equal(!lowered.ok, declaredRefused, "refused exactly where str.regex refuses")
				if (!lowered.ok) {
					k.note("refused with str.regex")
					return
				}
				const node = matchNode(lowered.value.root.expr)
				const distinct = Arr.sort(Arr.dedupe(c.sources), byCodePoints)
				assert.deepEqual(
					Arr.fromIterable(node.patterns),
					distinct,
					"each value the pattern can take, once, in code point order"
				)
				if (outOfUnitOrder(distinct)) {
					k.note("sources out of code unit order")
				}
				for (const source of node.patterns) {
					const declared = analyzeText([{ source, flags: "u" }], SourceLoc("str.regex", []))
					if (declared.ok) {
						assert.equal(
							matchAre(source),
							declared.value.members[0].are,
							`the ARE str.regex prints for /${source}/u`
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
						new Map<string, CarrierValue>([
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
					"\t\t\treturn isString(a) && isString(b) ? Result.ok(patterns.matches(b, a)) : mismatch(op)",
				replacement:
					"\t\t\treturn isString(a) && isString(b) ? Result.ok(a.length > 0 && patterns.matches(b, a)) : mismatch(op)",
				why: "The host never matches the empty text; the matches property fails."
			}
		]
	})

/** Compute's text terms concat, startsWith and endsWith agree between the host and the reference's code points. */
export const computesTextTermsConcatStartsWithAndEndsWithAgreeBetweenTheHostAndTheReferencesCodePoints =
	property.explore(affix, {
		needs: {},
		situations: [
			"prefix held",
			"suffix held",
			"prefix refused",
			"suffix refused",
			"equation held",
			"equation refused"
		] satisfies ReadonlyArray<Reached<AffixFeature>>,
		check: (_, k: Case<AffixFeature>) => (a) =>
			Effect.sync(() => {
				const row: Row = new Map<string, CarrierValue>([
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
				assert.equal(starts.host, starts.reference, "startsWith on both sides")
				assert.equal(ends.host, ends.reference, "endsWith on both sides")
				if (a.kind === "prefix") {
					assert.equal(starts.host, true, "a text begins with what it was built from")
				}
				if (a.kind === "suffix") {
					assert.equal(ends.host, true, "a text ends with what it was built from")
				}
				k.note(starts.host === true ? "prefix held" : "prefix refused")
				k.note(ends.host === true ? "suffix held" : "suffix refused")
				const joined = check(computeDesc("concat", variable("p"), variable("r")), false)
				assert.equal(joined.host, `${a.part}${a.rest}`, "concat on the host")
				assert.equal(joined.reference, `${a.part}${a.rest}`, "concat in the reference")
				/** The equation, decided without building the concatenation (lower.ts concatEquation). */
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
			name: "the reference evaluator's code point walks, and texts built to begin or end so"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/evaluate.ts",
				original:
					"\t\t\treturn isString(a) && isString(b) ? Result.ok(a.endsWith(b)) : mismatch(op)",
				replacement:
					"\t\t\treturn isString(a) && isString(b) ? Result.ok(a.includes(b)) : mismatch(op)",
				why: "The host evaluates endsWith as includes; the affix property fails."
			}
		]
	})

/** Compute's text terms refuses each fault planted in a valid term by its reason and fields, and compiles the term without it. */
export const computesTextTermsRefusesEachFaultPlantedInAValidTermByItsReasonAndFieldsAndCompilesTheTermWithoutIt =
	property.explore(plantedGen, {
		needs: {},
		situations: faults satisfies ReadonlyArray<Reached<Fault>>,
		check: (_, k: Case<Fault>) => (p) =>
			Effect.sync(() => {
				k.note(p.fault)
				const label = Formatter.format(p)
				const subject = p.mode === "query" ? "b" : "v"
				const lowered = (desc: ExprDesc, mode: "check" | "query") =>
					lowerWith(mode, desc, vars, true, baseParams)
				/** The term reading `pattern` at the case's site, over `over`. */
				const read = (over: string, pattern: string): ExprDesc =>
					p.site === "matches"
						? computeDesc("matches", variable(over), text(pattern))
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
				const valid = read(subject, p.pattern)
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
						limit: regexMaxDepth.value,
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
						const { reason } = refusedBelow(read(subject, pastSpace), p.mode, "ResourceBound", [
							"pattern",
							"pattern"
						])
						assertVariant(reason, "_tag", "ResourceBound", label)
						assert.deepEqual(reason.bound, pastBound, label)
						compiles(valid, p.mode)
						return
					}
					case "a construct outside the grammar":
					case "a malformed pattern":
						refusedBelow(
							read(subject, `${p.pattern}${p.construct}`),
							p.mode,
							p.fault === "a malformed pattern" ? "MalformedDescription" : "UnsupportedOperation",
							["pattern", "pattern", codePoints(p.pattern).length]
						)
						compiles(valid, p.mode)
						return
					case "a pattern no text matches":
						refusedBelow(read(subject, emptied(p.pattern)), p.mode, "UnsupportedOperation", [
							"pattern",
							"pattern"
						])
						compiles(valid, p.mode)
						return
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
						compiles(computeDesc("matches", variable(subject), text(p.pattern)), mode)
						return
					}
					case "a subject that is no text":
						refusedBelow(read("n", p.pattern), p.mode, "MalformedDescription", [])
						compiles(valid, p.mode)
						return
					case "an unbounded subject in a query":
						refusedBelow(read("v", p.pattern), "query", "UnsupportedOperation", [])
						compiles(read("v", p.pattern), "check")
						compiles(read("b", p.pattern), "query")
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
					case "a literal past the compile space at the builder":
					case "a literal no text matches at the builder": {
						const planted =
							p.fault === "a literal past the compile space at the builder"
								? pastSpace
								: emptied(p.pattern)
						const error = throwsRefused(
							() => Compute.pattern(planted),
							p.fault === "a literal past the compile space at the builder"
								? "ResourceBound"
								: "UnsupportedOperation",
							label
						)
						assert.deepEqual(pathOf(error), ["pattern"], label)
						if (error.reason._tag === "ResourceBound") {
							assert.deepEqual(error.reason.bound, pastBound, label)
						}
						Compute.matches(v("v", testPg.text), Compute.pattern(p.pattern))
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
						const guard: GuardDesc = { kind: "matches", pattern: p.language.source }
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
					'\t\tif (this.env.mode === "query" && (bytes === undefined || bytes > regexTextMaxBytes.value)) {',
				replacement:
					'\t\tif (this.env.mode === "query" && (bytes !== undefined && bytes > regexTextMaxBytes.value)) {',
				why: "A query's matches over a subject no pattern bounds is admitted; the refusals' property fails."
			}
		]
	})

/** Compute's text terms hands `~` the ARE of every value its pattern takes, never a source. */
export const computesTextTermsHandsTheAREOfEveryValueItsPatternTakesNeverASource = property.explore(
	spellingGen,
	{
		needs: {},
		situations: [
			"a literal's ARE",
			"a CASE of one value",
			"a dictionary's CASE"
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
					Arr.sort(Arr.dedupe(spelling.sources), byCodePoints),
					"each distinct source once, in code point order"
				)
				const patternSql = sqlOf(defined(node.args[1], "the pattern operand"), plainRender)
				const sql = sqlOf(node, plainRender)
				if (sql.kind !== "binary" || sql.op !== "~") {
					return assert.fail(`a ~, not ${sql.kind}`)
				}
				if (patternSql.kind === "literal" && patternSql.value.kind === "text") {
					k.note("a literal's ARE")
					assert.deepEqual(
						sql.right,
						lit.text(areOf(patternSql.value.value), types.text),
						"a text literal pattern is its ARE's literal"
					)
					return
				}
				k.note(node.patterns.length === 1 ? "a CASE of one value" : "a dictionary's CASE")
				if (sql.right.kind !== "case") {
					return assert.fail(`a CASE, not ${sql.right.kind}`)
				}
				assert.deepEqual(sql.right.operand, patternSql, "the CASE reads the pattern once")
				assert.deepEqual(sql.right.else, patternSql, "its ELSE keeps an absent read's NULL")
				unorderedEqual(
					Arr.map(sql.right.whens, (w): ReadonlyArray<Expr> => [w.when, w.result]),
					Arr.map(node.patterns, (source): ReadonlyArray<Expr> => [
						lit.text(source, types.text),
						lit.text(areOf(source), types.text)
					]),
					"an arm per distinct source, its ARE beside it, in any order"
				)
			}),
		oracle: {
			kind: "specification",
			name: "the pattern operand's spelling (ops.ts patternOperand)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/expr/ops.ts",
				original: "\t\t\tresult: lit.text(matchAre(source), types.text)",
				replacement: "\t\t\tresult: lit.text(source, types.text)",
				why: "A CASE arm hands `~` its pattern's source rather than its ARE; the `~` property fails."
			}
		]
	}
)
