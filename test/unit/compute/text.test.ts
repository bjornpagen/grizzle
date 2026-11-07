import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, element, filter, type Gen, int, map, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import { regexMaxPositions } from "#compiler/core/limits.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Engine from "#compiler/core/result.ts"
import { codePoints, codePointsText, compareCodePoints } from "#compiler/core/text.ts"
import type { ExprDesc } from "#compiler/ir/desc.ts"
import { predicateTable, type ScalarExpr } from "#compiler/ir/expr.ts"
import { defaultOps } from "#compiler/lower/conservative/expr/ops.ts"
import { computeCore as Compute } from "#compiler/scalar/compute/builders.ts"
import { evaluateTable, sqlNull } from "#compiler/scalar/compute/evaluate.ts"
import type { CarrierValue } from "#compiler/scalar/compute/literal.ts"
import { matchPattern } from "#compiler/scalar/regex/admit.ts"
import { ProgramPatterns, tablePatterns } from "#compiler/scalar/regex/patterns.ts"
import type { Expr } from "#compiler/sql/ast.ts"
import { col } from "#compiler/sql/build.ts"
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
import { caseHang } from "#test/support/limits.ts"
import { evaluate } from "#test/support/oracle/evaluate/catalog.ts"
import { patternMember } from "#test/support/oracle/reference/evaluate.ts"
import { baseParams, type LeafBinding, lowerWith, testPg, v } from "#test/unit/compute/support.ts"
import {
	type FiniteLanguage,
	families,
	finiteLanguageOver,
	jsAccepts,
	patternOver,
	stringsOver
} from "#test/unit/text/generators.ts"

/**
 * Compute's text terms: matches, concat, startsWith and endsWith, typed and lowered as a check and a query lower
 * them, and evaluated on the host (scalar/compute/evaluate.ts) and by the reference evaluator
 * (test/support/oracle/evaluate/catalog.ts).
 *
 * - matches: over every regex family's patterns and generated ones, a literal pattern and a dictionary of two (a
 *   conditional of literals, the values a closed payload holds), both evaluators agree with ECMAScript's own test,
 *   the development oracle the text differential holds against PostgreSQL; the node's pattern table holds each value
 *   the pattern can take once, in code point order, each with the ARE str.regex's own lowering prints for it; and the
 *   node refuses exactly where str.regex refuses one of its patterns.
 * - concat, startsWith and endsWith: by construction, a text that begins or ends with another, or a drawn pair; the
 *   host's string methods against the reference's code point walks, and the equation with a concatenation, which no
 *   lowering builds, against the concatenation itself.
 * - the refusals: a fault planted in a valid term, one for each refusal (a pattern past the compile space, outside the
 *   grammar, malformed or with no member, a pattern no measure bounds, a subject that is no text or unbounded in a
 *   query, concat in a query, a literal the builder refuses, a literal outside a guard's language), each by its
 *   reason and the place it states, and the term without its fault compiles; and the SQL `~` reads, the ARE of a
 *   drawn literal pattern and a CASE over a drawn dictionary's sources, asserted by its structure.
 */

const textColumn: LeafBinding = { kind: "column", type: testPg.text.scalar }
/** A text whose pattern bounds its bytes, which a query's `~` reads (lower.ts regexReadable). */
const boundedColumn: LeafBinding = { kind: "column", type: testPg.regex("^.{0,64}$", "su").scalar }
const boolColumn: LeafBinding = { kind: "column", type: testPg.boolean.scalar }

/** A case's text values and its condition, by the column each binds. */
type Row = ReadonlyMap<string, CarrierValue>

/** A lowered predicate's value over a row, on the host and by the reference evaluator. */
const values = (
	root: ScalarExpr,
	row: Row
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

const variable = (name: string): ExprDesc => ({ kind: "var", var: name })
const text = (value: string): ExprDesc => ({ kind: "literal", value, type: undefined })
const compute = (
	fn: "matches" | "concat" | "startsWith" | "endsWith",
	...args: ReadonlyArray<ExprDesc>
): ExprDesc => ({ kind: "compute", fn, args })

/** The node a lowered matches is: the op its lowering emits, its patterns beside its operands. */
const matchNode = (root: ScalarExpr) => {
	if (root.kind !== "op" || !("patterns" in root)) {
		return assert.fail(`a matches node, not ${root.kind}`)
	}
	return root
}

/** One case of the matches search: a family, its one or two patterns, the batch, and the condition's value. */
interface MatchCase {
	readonly family: number
	readonly sources: Arr.NonEmptyReadonlyArray<string>
	readonly strings: ReadonlyArray<string>
	readonly pick: boolean
}

type MatchFeature = "match" | "no match" | "dictionary of two" | "refused with str.regex"

const matchCase: Gen<MatchCase> = (source) => {
	const fi = source.draw(int(0, families.length - 1))
	const family = defined(families[fi], "a family")
	const pattern: Gen<string> = weighted([
		[
			1,
			map(
				element(
					Arr.isReadonlyArrayNonEmpty(family.patterns) ? family.patterns : [["^$", "u"] as const]
				),
				([s]) => s
			)
		],
		[2, patternOver(family.alphabet)]
	])
	const first = source.draw(pattern)
	const second = source.draw(boolean) ? [source.draw(pattern)] : []
	return {
		family: fi,
		sources: [first, ...second],
		strings: source.draw(array(stringsOver(family.alphabet, 8), { min: 1, max: 24 })),
		pick: source.draw(boolean)
	}
}

/** The pattern a case states: its literal, or a conditional over the condition column choosing between two. */
const patternOf = (c: MatchCase): ExprDesc => {
	const [first, second] = c.sources
	return second === undefined
		? text(first)
		: { kind: "cond", pred: variable("p"), onTrue: text(first), onFalse: text(second) }
}

describe("Compute's text terms", () => {
	it.effect("matches agrees with ECMAScript on the host and in the reference evaluator", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/compute/text-matches",
					draw: drawn(matchCase),
					literal: Formatter.format,
					oracle: { kind: "second-implementation", name: "ECMAScript's own RegExp test" },
					coverage: required<MatchFeature>(
						["match", "no match", "dictionary of two", "refused with str.regex"],
						{ cases: 400, sense: notesOnly }
					),
					kept: [],
					/** Every family drawn about forty times, a quarter of them a dictionary of two. */
					runs: 400,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(c, k) =>
					Effect.sync(() => {
						const lowered = lowerWith(
							"check",
							compute("matches", variable("v"), patternOf(c)),
							{ v: textColumn, p: boolColumn },
							true,
							baseParams
						)
						const declaredRefused = Arr.some(
							c.sources,
							(s) => !analyzeText(s, "u", SourceLoc("str.regex", [])).ok
						)
						assert.equal(!lowered.ok, declaredRefused, "refused exactly where str.regex refuses")
						if (!lowered.ok) {
							k.note("refused with str.regex")
							return
						}
						const node = matchNode(lowered.value.root.expr)
						const distinct = Arr.sort(Arr.dedupe(c.sources), Order.String)
						assert.deepEqual(
							Arr.map(node.patterns, (e) => e.source),
							distinct,
							"each value the pattern can take, once"
						)
						for (const entry of node.patterns) {
							const declared = analyzeText(entry.source, "u", SourceLoc("str.regex", []))
							if (declared.ok) {
								assert.equal(
									entry.are,
									declared.value.are,
									`the ARE str.regex prints for /${entry.source}/u`
								)
							}
						}
						if (c.sources.length === 2) {
							k.note("dictionary of two")
						}
						const chosen = c.pick || c.sources.length === 1 ? c.sources[0] : defined(c.sources[1])
						for (const s of c.strings) {
							const expected = jsAccepts(chosen, "u", s)
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
					})
			)
		)
	)

	/** A pair of texts: whether the first begins or ends with the second by construction, or a drawn pair. */
	interface Affix {
		readonly kind: "prefix" | "suffix" | "drawn"
		readonly whole: string
		readonly part: string
		readonly rest: string
	}

	/** Code points that split a surrogate pair's halves from the BMP's highest, where UTF-16 order and code points part. */
	const alphabet = [0x61, 0x62, 0xffff, 0x1f600, 0x1f601, 0x10ffff] as const
	const affixText = stringsOver(alphabet, 4)
	const affix: Gen<Affix> = (source) => {
		const kind = source.draw(element(["prefix", "suffix", "drawn"] as const))
		const part = source.draw(affixText)
		const rest = source.draw(affixText)
		const whole =
			kind === "prefix"
				? `${part}${rest}`
				: kind === "suffix"
					? `${rest}${part}`
					: source.draw(affixText)
		return { kind, whole, part, rest }
	}

	type AffixFeature =
		| "prefix held"
		| "suffix held"
		| "prefix refused"
		| "suffix refused"
		| "equation held"
		| "equation refused"

	it.effect(
		"concat, startsWith and endsWith agree between the host and the reference's code points",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/compute/text-affixes",
						draw: drawn(affix),
						literal: Formatter.format,
						oracle: {
							kind: "second-implementation",
							name: "the reference evaluator's code point walks, and texts built to begin or end so"
						},
						coverage: required<AffixFeature>(
							[
								"prefix held",
								"suffix held",
								"prefix refused",
								"suffix refused",
								"equation held",
								"equation refused"
							],
							{ cases: 600, sense: notesOnly }
						),
						kept: [],
						runs: 600,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(a, k) =>
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
							const starts = check(compute("startsWith", variable("w"), variable("p")), true)
							const ends = check(compute("endsWith", variable("w"), variable("p")), true)
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
							const joined = check(compute("concat", variable("p"), variable("r")), false)
							assert.equal(joined.host, `${a.part}${a.rest}`, "concat on the host")
							assert.equal(joined.reference, `${a.part}${a.rest}`, "concat in the reference")
							/** The equation, decided without building the concatenation (lower.ts concatEquation). */
							const equation = check(
								{
									kind: "compare",
									op: "eq",
									left: variable("w"),
									right: compute("concat", variable("p"), variable("r"))
								},
								true
							)
							const built = a.whole === `${a.part}${a.rest}`
							assert.equal(equation.host, built, "the equation on the host")
							assert.equal(equation.reference, built, "the equation in the reference")
							k.note(built ? "equation held" : "equation refused")
						})
				)
			)
	)

	/** A fault planted in a valid text term, one for each refusal of the text terms. */
	type Fault =
		| "a pattern past the compile space"
		| "a construct outside the grammar"
		| "a malformed pattern"
		| "a pattern no text matches"
		| "a column as the pattern"
		| "a parameter as the pattern"
		| "a computed pattern"
		| "a subject that is no text"
		| "an unbounded subject in a query"
		| "concat in a query"
		| "a literal past the compile space at the builder"
		| "a literal no text matches at the builder"
		| "a literal outside a match guard's language"

	const faults: Arr.NonEmptyReadonlyArray<Fault> = [
		"a pattern past the compile space",
		"a construct outside the grammar",
		"a malformed pattern",
		"a pattern no text matches",
		"a column as the pattern",
		"a parameter as the pattern",
		"a computed pattern",
		"a subject that is no text",
		"an unbounded subject in a query",
		"concat in a query",
		"a literal past the compile space at the builder",
		"a literal no text matches at the builder",
		"a literal outside a match guard's language"
	]

	/**
	 * Constructs ECMAScript reads and the admitted grammar does not, and syntax errors, each refused at its own first
	 * code point wherever it is planted: the dictionaries of the parser's two refusals.
	 */
	const outsideGrammar = [
		"(?=x)",
		"(?!x)",
		"(?<=x)",
		"(?<!x)",
		"\\b",
		"\\B",
		"\\s",
		"\\S",
		"\\p{L}",
		"(?<n>x)",
		"(?i:x)",
		"\\0"
	] as const
	const malformed = ["(", ")", "["] as const

	/** How a planted pattern is left with no member: a code point after its end, one before its start, an empty class. */
	type Emptying = "a code point after the end" | "a code point before the start" | "an empty class"

	/**
	 * Where a literal pattern is read: a match's (`Compute.matches`), or a guard's (`Compute.when`), which reads the same
	 * pattern and states its refusal one level below its own.
	 */
	type Site = "matches" | "when"

	/**
	 * A valid term and the fault planted in it: a pattern str.regex admits under the flags u over a family's alphabet, a
	 * finite language of that alphabet a guard reads, the site and mode the term is lowered in, and the parts a fault
	 * is built from, two of the family's code points and a count of copies past regexMaxPositions.
	 */
	interface Planted {
		readonly fault: Fault
		readonly site: Site
		readonly mode: "check" | "query"
		readonly pattern: string
		readonly language: FiniteLanguage
		readonly point: number
		readonly other: number
		readonly copies: number
		readonly construct: string
		readonly emptying: Emptying
	}

	const plantedGen: Gen<Planted> = (source) => {
		const { alphabet } = source.draw(element(families))
		const fault = source.draw(element(faults))
		return {
			fault,
			site: source.draw(element<Site>(["matches", "when"])),
			mode: source.draw(element(["check", "query"] as const)),
			pattern: source.draw(
				filter(patternOver(alphabet), (p) => matchPattern(p, SourceLoc("pattern", [])).ok, 16)
			),
			language: source.draw(finiteLanguageOver(alphabet)),
			point: source.draw(element(alphabet)),
			other: source.draw(element(alphabet)),
			copies: source.draw(int(17, 24)),
			construct: source.draw(
				fault === "a malformed pattern" ? element(malformed) : element(outsideGrammar)
			),
			emptying: source.draw(
				element<Emptying>([
					"a code point after the end",
					"a code point before the start",
					"an empty class"
				])
			)
		}
	}

	const vars: Readonly<Record<string, LeafBinding>> = {
		v: textColumn,
		w: textColumn,
		b: boundedColumn,
		n: { kind: "column", type: testPg.integer.scalar }
	}

	/** A code point as its braced escape, which means itself inside a class and out. */
	const escaped = (c: number): string => `\\u{${c.toString(16)}}`

	/** The path of a refusal of a term lowered at the test's root. */
	const pathOf = (error: CompileError): ReadonlyArray<string | number> => refusalLoc(error).path

	it.effect(
		"refuses each fault planted in a valid term by its reason and fields, and compiles the term without it",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/compute/text-refusals",
						draw: drawn(plantedGen),
						literal: Formatter.format,
						oracle: { kind: "specification", name: "matches's admission and concat's modes" },
						coverage: required<Fault>(faults, { cases: 400, sense: notesOnly }),
						kept: [],
						runs: 400,
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
								lowerWith(mode, desc, vars, true, baseParams)
							/** The term reading `pattern` at the case's site, over `over`. */
							const read = (over: string, pattern: string): ExprDesc =>
								p.site === "matches"
									? compute("matches", variable(over), text(pattern))
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
											otherwise: { kind: "literal", value: false, type: undefined }
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
							const pastSpace = `(?:[${escaped(p.point)}${escaped(p.other)}]{1,255}){${p.copies}}`
							const pastBound = {
								kind: "regexCompileSpace",
								pattern: `/${pastSpace}/u`,
								measure: {
									kind: "positions",
									limit: regexMaxPositions.value,
									needed: 255 * p.copies
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
									const { reason } = refusedBelow(
										read(subject, pastSpace),
										p.mode,
										"ResourceBound",
										["pattern", "pattern"]
									)
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
										p.fault === "a malformed pattern"
											? "MalformedDescription"
											: "UnsupportedOperation",
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
												: compute("concat", variable("w"), text(p.pattern))
									const error = refused(
										lowered(compute("matches", variable(subject), pattern), mode),
										"UnsupportedOperation",
										label
									)
									assert.deepEqual(pathOf(error), ["matches", "pattern"], label)
									compiles(compute("matches", variable(subject), text(p.pattern)), mode)
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
									const affix = compute(
										"startsWith",
										compute("concat", variable(subject), variable("w")),
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
										() => Compute.matches(v("v", testPg.text), planted),
										p.fault === "a literal past the compile space at the builder"
											? "ResourceBound"
											: "UnsupportedOperation",
										label
									)
									assert.deepEqual(pathOf(error), ["pattern", "pattern"], label)
									if (error.reason._tag === "ResourceBound") {
										assert.deepEqual(error.reason.bound, pastBound, label)
									}
									Compute.matches(v("v", testPg.text), p.pattern)
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
									const guarded = (literal: string): ExprDesc => ({
										kind: "when",
										guard: { kind: "matches", pattern: p.language.source },
										subject: variable(subject),
										proved: {
											kind: "compare",
											op: "eq",
											left: variable(subject),
											right: text(literal)
										},
										otherwise: { kind: "literal", value: false, type: undefined }
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
						})
				)
			)
	)

	type Spelling = "a literal's ARE" | "a dictionary's CASE"

	/** One pattern, or a dictionary of two distinct ones read through three values, the first repeated. */
	const spellingGen: Gen<readonly [string, ...ReadonlyArray<string>]> = (source) => {
		const { alphabet } = source.draw(element(families))
		const admitted = filter(
			patternOver(alphabet),
			(p) => matchPattern(p, SourceLoc("pattern", [])).ok,
			16
		)
		const first = source.draw(admitted)
		return source.draw(boolean)
			? [first, source.draw(filter(admitted, (p) => p !== first, 16))]
			: [first]
	}

	it.effect("hands `~` the ARE of every value its pattern takes, never a source", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/compute/text-sql",
					draw: drawn(spellingGen),
					literal: Formatter.format,
					oracle: {
						kind: "specification",
						name: "the pattern operand's spelling (ops.ts patternOperand)"
					},
					coverage: required<Spelling>(["a literal's ARE", "a dictionary's CASE"], {
						cases: 100,
						sense: notesOnly
					}),
					kept: [],
					runs: 100,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				([first, second], k) =>
					Effect.sync(() => {
						const pattern: ExprDesc =
							second === undefined
								? text(first)
								: {
										kind: "cond",
										pred: variable("p"),
										onTrue: text(first),
										onFalse: {
											kind: "cond",
											pred: variable("p"),
											onTrue: text(second),
											onFalse: text(first)
										}
									}
						const node = matchNode(
							succeeded(
								lowerWith(
									"query",
									compute("matches", variable("v"), pattern),
									{ v: boundedColumn, p: boolColumn },
									true,
									baseParams
								)
							).root.expr
						)
						const distinct = Arr.sort(
							second === undefined ? [first] : [first, second],
							compareCodePoints
						)
						assert.deepEqual(
							Arr.map(node.patterns, (e) => e.source),
							distinct,
							"each distinct source once, in code point order"
						)
						const ares = Arr.map(
							node.patterns,
							(e) => succeeded(matchPattern(e.source, SourceLoc("pattern", []))).are
						)
						const operands: ReadonlyArray<Expr> = [col("r0", "v"), col("r0", "pattern")]
						const sql = defined(defaultOps(node, operands), "the node's SQL")
						if (sql.kind !== "binary" || sql.op !== "~") {
							return assert.fail(`a ~, not ${sql.kind}`)
						}
						if (second === undefined) {
							k.note("a literal's ARE")
							assert.deepEqual(sql.right, {
								kind: "literal",
								value: { kind: "text", value: defined(ares[0]) },
								type: sql.right.kind === "literal" ? sql.right.type : assert.fail("a literal")
							})
							return
						}
						k.note("a dictionary's CASE")
						if (sql.right.kind !== "case") {
							return assert.fail(`a CASE, not ${sql.right.kind}`)
						}
						const patternSql = defined(operands[1], "the pattern's SQL")
						assert.deepEqual(sql.right.operand, patternSql, "the CASE reads the pattern once")
						assert.deepEqual(sql.right.else, patternSql, "its ELSE keeps an absent read's NULL")
						assert.deepEqual(
							Arr.map(sql.right.whens, (w): ReadonlyArray<Expr> => [w.when, w.result]),
							Arr.map(node.patterns, (e, i): ReadonlyArray<Expr> => [
								{
									kind: "literal",
									value: { kind: "text", value: e.source },
									type: textType(sql.right)
								},
								{
									kind: "literal",
									value: { kind: "text", value: defined(ares[i]) },
									type: textType(sql.right)
								}
							]),
							"an arm per distinct source, its ARE beside it"
						)
					})
			)
		)
	)
})

/** The text type a CASE's arms are literals of. */
const textType = (e: Expr) => {
	if (e.kind !== "case") {
		return assert.fail("a CASE")
	}
	const [first] = e.whens
	return first.when.kind === "literal" ? first.when.type : assert.fail("a literal arm")
}
