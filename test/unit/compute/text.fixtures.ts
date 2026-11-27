/** What the properties of text.test.ts read: its spaces, models and helpers. */

import * as Engine from "@bjornpagen/grizzle-text/base/result"
import { parsePattern } from "@bjornpagen/grizzle-text/regex/parse"
import { assert, assertNot, defined } from "@bjornpagen/testing/assert"
import {
	array,
	boolean,
	element,
	type Gen,
	int,
	map,
	uniqueKeys,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Formatter, Option, Order, String as Str } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { ExprDesc } from "#compiler/ir/desc.ts"
import { predicateTable, type ScalarExpr } from "#compiler/ir/expr.ts"
import type { PatternValue } from "#compiler/ir/pattern.ts"
import { compiledExpr, sqlNull, noParamLeaf } from "#compiler/scalar/compute/evaluate.ts"
import { matchAre, matchPattern } from "#compiler/scalar/regex/admit.ts"
import { ProgramPatterns, tablePatterns } from "#compiler/scalar/regex/patterns.ts"
import type { HostValue } from "#compiler/scalar/values/identity.ts"
import { refusalLoc, succeeded } from "#test/support/assert.ts"
import { spelled } from "#test/support/fixtures/ir/scalar.ts"
import type { ModelValue } from "#test/support/oracle/evaluate/catalog.ts"
import { evaluate } from "#test/support/oracle/evaluate/catalog.ts"
import { patternMember } from "#test/support/oracle/reference/evaluate.ts"
import { type LeafBinding, testPg } from "#test/unit/compute/support.ts"
import {
	admittedPatternOver,
	families,
	type FiniteLanguage,
	finiteLanguageOver,
	mostFiniteMembers,
	patternOver,
	stringsOver
} from "#test/unit/text/generators.ts"

export const textColumn: LeafBinding = { kind: "column", type: testPg.text.scalar }

/** A text whose pattern bounds its bytes, which a query's `~` reads (lower.ts regexReadable). */
export const boundedColumn: LeafBinding = {
	kind: "column",
	type: testPg.regex("^.{0,64}$", "su").scalar
}

export const boolColumn: LeafBinding = { kind: "column", type: testPg.boolean.scalar }

/** A case's text values and its condition, by the column each binds: values the host and the reference hold alike. */
export type Row = ReadonlyMap<string, string | boolean>

/** A lowered predicate's value over a row, on the host and by the reference evaluator. */
export const values = (
	root: ScalarExpr,
	row: Row
): { readonly host: HostValue; readonly reference: ModelValue } => {
	const table = predicateTable(root)
	const host = succeeded(
		Engine.mapError(
			compiledExpr(table)(
				{
					value: undefined,
					column: (ref) => row.get(ref.name),
					closed: () => undefined,
					param: noParamLeaf
				},
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

export const variable = (name: string): ExprDesc => ({ kind: "var", var: name })

export const text = (value: string): ExprDesc => ({ kind: "literal", value })

/** A Text.matches pattern literal: its pattern value. */
export const patternLiteral = (value: PatternValue): ExprDesc => ({ kind: "literal", value })

/** The pattern literal of `spelling`, admitted (spelled). */
const pattern = (spelling: string): ExprDesc => patternLiteral(spelled(spelling))

export const computeDesc = (
	fn: "matches" | "concat" | "startsWith" | "endsWith" | "contains",
	...args: ReadonlyArray<ExprDesc>
): ExprDesc => ({ kind: "compute", fn, args })

/** The node a lowered matches is: the op its lowering emits, its patterns beside its operands. */
export const matchNode = (root: ScalarExpr) => {
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

export type MatchFeature = "match" | "no match" | "dictionary of two" | "the empty language"

/** Code point order, by the code points themselves. */
const byCodePoints: Order.Order<string> = Order.mapInput(
	Order.Array(Order.Number),
	(text: string) =>
		Arr.map(Arr.fromIterable(text), (c) =>
			defined(Option.getOrUndefined(Str.codePointAt(0)(c)), "a code point")
		)
)

/**
 * The order a pattern table keeps its values in, as the specification states it: by their language's key, then by
 * their spelling, each in code point order.
 */
const byLanguage: Order.Order<PatternValue> = Order.combine(
	Order.mapInput(byCodePoints, (p: PatternValue) => p.pattern),
	Order.mapInput(byCodePoints, (p: PatternValue) => p.spelling)
)

/** The values a pattern table holds of `values`: each spelling once, by language (byLanguage). */
export const tableOf = (
	values: Arr.NonEmptyReadonlyArray<PatternValue>
): ReadonlyArray<PatternValue> =>
	Arr.sort(
		Arr.dedupeWith(values, (a, b) => a.spelling === b.spelling),
		byLanguage
	)

/** Code points either side of the surrogates, where UTF-16 code unit order and code point order part. */
const orderEdge = [0xd7ff, 0xe000, 0xffff, 0x10000, 0x10ffff] as const

export const matchCase: Gen<MatchCase> = (source) => {
	const fi = source.draw(int(0, families.length - 1))
	const family = defined(families[fi], "a family")
	const body: Gen<string> = weighted([
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
	/** A body led by an optional edge code point, which matches what the body matches. */
	const led: Gen<string> = (s) =>
		`${String.fromCodePoint(s.draw(element(orderEdge)))}?${s.draw(body)}`
	const pattern: Gen<string> = weighted([
		[1, body],
		[1, led]
	])
	const first = source.draw(pattern)
	const second = source.draw(boolean) ? [source.draw(pattern)] : []
	return {
		family: fi,
		sources: [first, ...second],
		strings: source.draw(array(stringsOver(element(family.alphabet), 8), { min: 1, max: 24 })),
		pick: source.draw(boolean)
	}
}

/**
 * The pattern a case states of its sources' pattern values: its literal, or a conditional over the condition column
 * choosing between two.
 */
export const casePattern = (values: Arr.NonEmptyReadonlyArray<PatternValue>): ExprDesc => {
	const [first, second] = values
	return second === undefined
		? patternLiteral(first)
		: {
				kind: "cond",
				pred: variable("p"),
				onTrue: patternLiteral(first),
				onFalse: patternLiteral(second)
			}
}

/**
 * A pair of texts: whether the first begins with the second, ends with it or holds it between two texts by construction,
 * or a drawn pair.
 */
interface Affix {
	readonly kind: "prefix" | "suffix" | "infix" | "drawn"
	readonly whole: string
	readonly part: string
	readonly rest: string
}

/** Code points that split a surrogate pair's halves from the BMP's highest, where UTF-16 order and code points part. */
const alphabet = [0x61, 0x62, 0xffff, 0x1f600, 0x1f601, 0x10ffff] as const

const affixText = stringsOver(element(alphabet), 4)

export const affix: Gen<Affix> = (source) => {
	const kind = source.draw(element(["prefix", "suffix", "infix", "drawn"] as const))
	const part = source.draw(affixText)
	const rest = source.draw(affixText)
	const whole =
		kind === "prefix"
			? `${part}${rest}`
			: kind === "suffix"
				? `${rest}${part}`
				: kind === "infix"
					? `${rest}${part}${source.draw(affixText)}`
					: source.draw(affixText)
	return { kind, whole, part, rest }
}

export type AffixFeature =
	| "prefix held"
	| "suffix held"
	| "prefix refused"
	| "suffix refused"
	| "containment held"
	| "containment refused"
	| "equation held"
	| "equation refused"

/** Whether a pattern under the flags u is the empty language: it parses, and no admitted text matches it (ir.ts never). */
export const emptyLanguage = (source: string): boolean => {
	const parsed = parsePattern(source, "u")
	return parsed.ok && parsed.value.kind === "never"
}

/** A fault planted in a valid text term, one for each refusal of the text terms. */
export type Fault =
	| "a pattern past the compile space"
	| "a construct outside the grammar"
	| "a malformed pattern"
	| "a pattern value of another spelling's key"
	| "a pattern no text matches"
	| "a column as the pattern"
	| "a parameter as the pattern"
	| "a computed pattern"
	| "a subject that is no text"
	| "an unbounded subject in a query"
	| "concat in a query"
	| "a literal past the compile space at the builder"
	| "a literal outside a match guard's language"

export const faults: Arr.NonEmptyReadonlyArray<Fault> = [
	"a pattern past the compile space",
	"a construct outside the grammar",
	"a malformed pattern",
	"a pattern value of another spelling's key",
	"a pattern no text matches",
	"a column as the pattern",
	"a parameter as the pattern",
	"a computed pattern",
	"a subject that is no text",
	"an unbounded subject in a query",
	"concat in a query",
	"a literal past the compile space at the builder",
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
 * Where a literal pattern is read: a match's (`Text.matches`), or a guard's (`Logic.when`), which reads the same
 * pattern and states its refusal one level below its own.
 */
type Site = "matches" | "when"

/**
 * A valid term and the fault planted in it: a pattern str.regex admits under the flags u over a family's alphabet, a
 * finite language of that alphabet a guard reads, the site and mode the term is lowered in, and the parts a fault
 * is built from, two of the family's code points and a count of copies whose pattern passes regexMaxDepth.
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

export const plantedGen: Gen<Planted> = (source) => {
	const { alphabet } = source.draw(element(families))
	const fault = source.draw(element(faults))
	return {
		fault,
		site: source.draw(element<Site>(["matches", "when"])),
		mode: source.draw(element(["check", "query"] as const)),
		pattern: source.draw(admittedPatternOver(alphabet)),
		language: source.draw(finiteLanguageOver(alphabet, mostFiniteMembers)),
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

export const vars: Readonly<Record<string, LeafBinding>> = {
	v: textColumn,
	w: textColumn,
	b: boundedColumn,
	n: { kind: "column", type: testPg.integer.scalar }
}

/** A code point as its braced escape, which means itself inside a class and out. */
export const escaped = (c: number): string => `\\u{${c.toString(16)}}`

/** The path of a refusal of a term lowered at the test's root. */
export const pathOf = (error: CompileError): ReadonlyArray<string | number> =>
	refusalLoc(error).path

export type Spelling =
	| "a literal's ARE"
	| "a conditional of one value"
	| "a conditional of two values"

/** A matches pattern, a literal or a conditional over the condition column, and the sources its literals state. */
interface PatternSpelling {
	readonly desc: ExprDesc
	readonly sources: Arr.NonEmptyReadonlyArray<string>
}

/** A pattern over `pool`: one of its sources, or within `depth` conditionals, a conditional between two such. */
const spellingOver = (
	pool: Arr.NonEmptyReadonlyArray<string>,
	depth: number
): Gen<PatternSpelling> => {
	const literal = map(element(pool), (s): PatternSpelling => ({ desc: pattern(s), sources: [s] }))
	if (depth === 0) {
		return literal
	}
	const inner = spellingOver(pool, depth - 1)
	return weighted<PatternSpelling>([
		[1, literal],
		[
			1,
			(source) => {
				const onTrue = source.draw(inner)
				const onFalse = source.draw(inner)
				return {
					desc: { kind: "cond", pred: variable("p"), onTrue: onTrue.desc, onFalse: onFalse.desc },
					sources: [...onTrue.sources, ...onFalse.sources]
				}
			}
		]
	])
}

/** A pattern over one admitted pattern or two distinct ones, two conditionals deep at most. */
export const spellingGen: Gen<PatternSpelling> = (source) => {
	const { alphabet } = source.draw(element(families))
	const [first, ...rest] = source.draw(
		uniqueKeys(admittedPatternOver(alphabet), { min: 1, max: 2 })
	)
	return source.draw(spellingOver([defined(first, "an admitted pattern"), ...rest], 2))
}

/** The ARE str.regex prints for an admitted pattern. */
export const areOf = (source: string): string =>
	matchAre(succeeded(matchPattern(source, SourceLoc("pattern", []))).spelling)
