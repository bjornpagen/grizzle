/** What the property of xsd-pattern.test.ts reads: its space of texts, Appendix F's patterns and others, and its SQL. */

import { assert } from "@bjornpagen/testing/assert"
import { array, constant, element, type Gen, int, oneOf, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Formatter, String as Str } from "effect"
import type { ExprDesc } from "#compiler/ir/desc.ts"
import { predicateTable } from "#compiler/ir/expr.ts"
import { libraryCreate } from "#compiler/physical/ddl/library.ts"
import { compiledExpr, noParamLeaf } from "#compiler/scalar/compute/evaluate.ts"
import { ProgramPatterns, tablePatterns } from "#compiler/scalar/regex/patterns.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { succeeded } from "#test/support/assert.ts"
import { baseParams, lowerWith, plainRender, renderSql } from "#test/unit/compute/support.ts"
import { textColumn } from "#test/unit/compute/text.fixtures.ts"
import { patternGen, refusedGen } from "#test/unit/text/xsd.fixtures.ts"

/** What drew a text of a batch, and how the reader judged it. */
export type XsdPatternFeature =
	| "a pattern of every construct"
	| "a construct outside the grammar"
	| "a pattern one character off"
	| "a run of the grammar's characters"
	| "nested groups"
	| "nested class subtractions"
	| "nesting past a thousand"
	| "a text the reader admits"
	| "a text the reader refuses"

/** A text of a batch and what drew it. */
export interface DrawnText {
	readonly text: string
	readonly features: ReadonlyArray<XsdPatternFeature>
}

/** The characters a pattern one character off gains, or a run is drawn from: each the grammar reads as itself. */
const grammarCharacters = [
	"\\",
	"[",
	"]",
	"(",
	")",
	"{",
	"}",
	"|",
	"?",
	"*",
	"+",
	"-",
	"^",
	",",
	".",
	"0",
	"2",
	"n",
	"s",
	"p",
	"a",
	"é",
	"😀"
] as const

/** A drawn pattern with one character inserted, removed or replaced at a drawn place. */
const offByOne: Gen<DrawnText> = (source) => {
	const pattern = Array.from(source.draw(patternGen).xsd)
	const at = source.draw(int(0, pattern.length))
	const edit = source.draw(element(["insert", "remove", "replace"] as const))
	const c = source.draw(element(grammarCharacters))
	const edited =
		edit === "insert"
			? [...pattern.slice(0, at), c, ...pattern.slice(at)]
			: [...pattern.slice(0, at), ...(edit === "replace" ? [c] : []), ...pattern.slice(at + 1)]
	return { text: Arr.join(edited, ""), features: ["a pattern one character off"] }
}

/** A run of up to sixteen of the grammar's characters and category names. */
const run: Gen<DrawnText> = (source) => ({
	text: Arr.join(
		source.draw(
			array(
				element([...grammarCharacters, "\\p{Lu}", "\\P{IsBasicLatin}", "-[", "{2,3}", "{3,2}"]),
				{
					min: 0,
					max: 16
				}
			)
		),
		""
	),
	features: ["a run of the grammar's characters"]
})

/**
 * Groups or class subtractions nested from one to nine deep, or from 1,000 to 2,000, each closed, or with one closing
 * bracket too few or too many: `((…(a){2}…){2}){2}`, a count at every level, and `[a-[b-[…]]]`.
 */
const nested: Gen<DrawnText> = (source) => {
	const deep = source.draw(element([false, true]))
	const depth = deep ? source.draw(int(1000, 2000)) : source.draw(int(1, 9))
	const closes = Math.max(
		depth +
			source.draw(
				weighted([
					[2, constant(0)],
					[1, constant(-1)],
					[1, constant(1)]
				])
			),
		0
	)
	const past: ReadonlyArray<XsdPatternFeature> = deep ? ["nesting past a thousand"] : []
	return source.draw(element(["groups", "subtractions"] as const)) === "groups"
		? {
				text: `${Str.repeat(depth)("(")}a${Str.repeat(closes)("){2}")}`,
				features: ["nested groups", ...past]
			}
		: {
				text: `[a${Str.repeat(depth - 1)("-[b")}${Str.repeat(closes)("]")}`,
				features: ["nested class subtractions", ...past]
			}
}

/** A batch of 16 to 48 texts, each drawn from one of the spaces. */
export const batchGen: Gen<Arr.NonEmptyReadonlyArray<DrawnText>> = (source) => {
	const drawn = source.draw(
		array(
			oneOf<DrawnText>([
				(s) => ({ text: s.draw(patternGen).xsd, features: ["a pattern of every construct"] }),
				(s) => ({
					text: s.draw(refusedGen).source,
					features: ["a construct outside the grammar"]
				}),
				offByOne,
				run,
				nested
			]),
			{ min: 16, max: 48 }
		)
	)
	return Arr.isReadonlyArrayNonEmpty(drawn) ? drawn : assert.fail("a batch of at least 16 texts")
}

const tested: ExprDesc = { kind: "compute", fn: "isXsdPattern", args: [{ kind: "var", var: "v" }] }

/** Xml.isPattern(v) as a check lowers it. */
const term = succeeded(
	lowerWith("check", tested, { v: textColumn }, false, baseParams),
	"Xml.isPattern lowers in a check over any text"
).root

/** The library function's CREATE in the session's pg_temp, where the term's SQL calls it (support.ts temporaryLibrary). */
export const createLibrary = printStatement(libraryCreate("pg_temp", "isXsdPattern"))

/** The term's SQL over a batch's texts, `$1` their JSON array, in their order: PostgreSQL's verdict on each. */
export const testedSql = `SELECT (${renderSql(term.expr, plainRender)})::text FROM jsonb_array_elements_text($1::text::jsonb) WITH ORDINALITY AS r0(v, ord) ORDER BY r0.ord`

/** The host evaluator's verdict on a text (scalar/compute/evaluate.ts), over the term the SQL holds. */
export const hostVerdict = (text: string): boolean => {
	const table = predicateTable(term.expr)
	const value = succeeded(
		compiledExpr(table)(
			{ value: undefined, column: () => text, closed: () => undefined, param: noParamLeaf },
			ProgramPatterns.of(tablePatterns(table))
		),
		"the host evaluates isXsdPattern"
	)
	return typeof value === "boolean"
		? value
		: assert.fail(`the host's verdict is a boolean, not ${Formatter.format(value)}`)
}
