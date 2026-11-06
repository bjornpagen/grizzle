import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, int, map, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Engine from "#compiler/core/result.ts"
import type { ExprDesc } from "#compiler/ir/desc.ts"
import { predicateTable, type ScalarExpr } from "#compiler/ir/expr.ts"
import { defaultOps } from "#compiler/lower/conservative/expr/ops.ts"
import { computeCore as Compute } from "#compiler/scalar/compute/builders.ts"
import { evaluateTable } from "#compiler/scalar/compute/evaluate.ts"
import type { CarrierValue } from "#compiler/scalar/compute/literal.ts"
import { matchPattern } from "#compiler/scalar/regex/admit.ts"
import { regexMember } from "#compiler/scalar/regex/nfa.ts"
import type { Expr } from "#compiler/sql/ast.ts"
import { col } from "#compiler/sql/build.ts"
import { analyzeText } from "#compiler/text/refinement.ts"
import { assert, defined, refused, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { evaluate } from "#test/support/oracle/evaluate/catalog.ts"
import { patternMember } from "#test/support/oracle/reference/evaluate.ts"
import { baseParams, type LeafBinding, lowerWith, testPg, v } from "#test/unit/compute/support.ts"
import { families, jsAccepts, patternOver, stringsOver } from "#test/unit/text/generators.ts"

/**
 * Compute's text terms: matches, concat, startsWith and endsWith, typed and lowered as a check and a query lower
 * them, and evaluated on the host (scalar/compute/evaluate.ts) and by the reference evaluator
 * (test/support/oracle/evaluate/catalog.ts).
 *
 * - matches: over every regex family's patterns and generated ones, a literal pattern and a dictionary of two (a
 *   conditional of literals, the values a closed payload holds), both evaluators agree with ECMAScript's own test,
 *   the development oracle the text differential holds against PostgreSQL; the node's pattern table holds each value
 *   the pattern can take once, in code point order, each with the ARE str.regex's own lowering prints for it; and the
 *   node refuses only a pattern str.regex refuses too.
 * - concat, startsWith and endsWith: by construction, a text that begins or ends with another, or a drawn pair; the
 *   host's string methods against the reference's code point walks, and the equation with a concatenation, which no
 *   lowering builds, against the concatenation itself.
 * - the refusals, a box of named invalid inputs, each by its reason and its fields; and the SQL `~` reads, the ARE of
 *   a literal pattern and a CASE over a dictionary's sources, asserted by its structure.
 */

const textColumn: LeafBinding = { kind: "column", type: testPg.text.scalar }
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
					coverage: required<MatchFeature>(["match", "no match", "dictionary of two"], {
						cases: 400,
						sense: notesOnly
					}),
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
						if (!lowered.ok) {
							k.note("refused with str.regex")
							assert.ok(
								Arr.some(c.sources, (s) => !analyzeText(s, "u", SourceLoc("str.regex", [])).ok),
								`only a pattern str.regex refuses: ${lowered.error.message}`
							)
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

	/** A named invalid input, and the reason and fields its refusal states. */
	type Invalid =
		| "a pattern past the compile space"
		| "a pattern outside the grammar"
		| "a pattern no text matches"
		| "a column as the pattern"
		| "a parameter as the pattern"
		| "a computed pattern"
		| "a subject that is no text"
		| "concat in a query"
		| "a literal past the compile space at the builder"

	const invalid: Arr.NonEmptyReadonlyArray<Invalid> = [
		"a pattern past the compile space",
		"a pattern outside the grammar",
		"a pattern no text matches",
		"a column as the pattern",
		"a parameter as the pattern",
		"a computed pattern",
		"a subject that is no text",
		"concat in a query",
		"a literal past the compile space at the builder"
	]

	/** Past regexMaxClosurePairs: 255 optional a then 255 optional b, PostgreSQL's "too complex" at its budget's double. */
	const pastSpace = "(?:a?){255}(?:b?){255}c"

	const vars: Readonly<Record<string, LeafBinding>> = {
		v: textColumn,
		w: textColumn,
		n: { kind: "column", type: testPg.integer.scalar }
	}

	it.effect("refuses each invalid input by its reason and fields", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/compute/text-refusals",
					generator: element(invalid),
					literal: Formatter.format,
					limit: invalid.length,
					box: "every named invalid input of the text terms",
					oracle: { kind: "specification", name: "matches's admission and concat's modes" },
					coverage: requiredInSpace<Invalid>(invalid),
					caseHang
				},
				(name, k) =>
					Effect.sync(() => {
						k.note(name)
						const matching = (pattern: ExprDesc, mode: "check" | "query") =>
							lowerWith(mode, compute("matches", variable("v"), pattern), vars, true, baseParams)
						switch (name) {
							case "a pattern past the compile space": {
								const reason = refused(matching(text(pastSpace), "query"), "ResourceBound").reason
								assert.ok(
									reason._tag === "ResourceBound" &&
										reason.bound.kind === "regexCompileSpace" &&
										reason.bound.pattern === `/${pastSpace}/u`,
									"names the pattern"
								)
								return
							}
							case "a pattern outside the grammar":
								refused(matching(text("(?=a)b"), "check"), "UnsupportedOperation")
								refused(matching(text("a("), "check"), "MalformedDescription")
								return
							case "a pattern no text matches":
								refused(matching(text("[]"), "query"), "UnsupportedOperation")
								return
							case "a column as the pattern":
								refused(matching(variable("w"), "query"), "UnsupportedOperation")
								return
							case "a parameter as the pattern":
								refused(
									matching({ kind: "param", name: "p", type: testPg.text.desc }, "query"),
									"UnsupportedOperation"
								)
								return
							case "a computed pattern":
								refused(
									matching(compute("concat", text("^a"), text("b$")), "check"),
									"MalformedDescription"
								)
								refused(
									matching(compute("concat", variable("w"), text("b$")), "check"),
									"UnsupportedOperation"
								)
								return
							case "a subject that is no text":
								refused(
									lowerWith(
										"check",
										compute("matches", variable("n"), text("^1$")),
										vars,
										true,
										baseParams
									),
									"MalformedDescription"
								)
								return
							case "concat in a query":
								refused(
									lowerWith(
										"query",
										compute(
											"startsWith",
											compute("concat", variable("v"), variable("w")),
											text("a")
										),
										vars,
										true,
										baseParams
									),
									"UnsupportedOperation"
								)
								succeeded(
									lowerWith(
										"query",
										{
											kind: "compare",
											op: "ne",
											left: variable("v"),
											right: compute("concat", variable("w"), text("a"))
										},
										vars,
										true,
										baseParams
									),
									"an equation with a concatenation is a query's"
								)
								return
							case "a literal past the compile space at the builder": {
								const thrown = catchCompileError(() =>
									Compute.matches(v("v", testPg.text), pastSpace)
								)
								assert.ok(
									!thrown.ok && thrown.error.reason._tag === "ResourceBound",
									"the builder refuses the literal where the call is written"
								)
								return
							}
						}
					})
			)
		)
	)

	type Spelling = "a literal's ARE" | "a dictionary's CASE"

	it.effect("hands `~` the ARE of every value its pattern takes, never a source", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/compute/text-sql",
					generator: element(["a literal's ARE", "a dictionary's CASE"] as const),
					literal: Formatter.format,
					limit: 2,
					box: "a literal pattern and a dictionary of three values, one repeated",
					oracle: {
						kind: "specification",
						name: "the pattern operand's spelling (ops.ts patternOperand)"
					},
					coverage: requiredInSpace<Spelling>(["a literal's ARE", "a dictionary's CASE"]),
					caseHang
				},
				(spelling, k) =>
					Effect.sync(() => {
						k.note(spelling)
						const pattern: ExprDesc =
							spelling === "a literal's ARE"
								? text("^\\d+$")
								: {
										kind: "cond",
										pred: variable("p"),
										onTrue: text("^b$"),
										onFalse: {
											kind: "cond",
											pred: variable("p"),
											onTrue: text("^a.$"),
											onFalse: text("^b$")
										}
									}
						const node = matchNode(
							succeeded(
								lowerWith(
									"query",
									compute("matches", variable("v"), pattern),
									{ v: textColumn, p: boolColumn },
									true,
									baseParams
								)
							).root.expr
						)
						const operands: ReadonlyArray<Expr> = [col("r0", "v"), col("r0", "pattern")]
						const sql = defined(defaultOps(node, operands), "the node's SQL")
						if (sql.kind !== "binary" || sql.op !== "~") {
							return assert.fail(`a ~, not ${sql.kind}`)
						}
						const ares = Arr.map(
							node.patterns,
							(e) => succeeded(matchPattern(e.source, SourceLoc("pattern", []))).are
						)
						if (spelling === "a literal's ARE") {
							assert.deepEqual(sql.right, {
								kind: "literal",
								value: { kind: "text", value: defined(ares[0]) },
								type: sql.right.kind === "literal" ? sql.right.type : assert.fail("a literal")
							})
							return
						}
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
						assert.equal(node.patterns.length, 2, "the repeated source once")
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
