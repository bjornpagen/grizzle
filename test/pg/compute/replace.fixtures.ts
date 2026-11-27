/**
 * What the property of replace.test.ts reads: its batches, Text.replace lowered at both sites, its SQL and the host's
 * and the reference evaluator's values.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { array, element, type Gen, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Formatter, String as Str } from "effect"
import type { ExprDesc } from "#compiler/ir/desc.ts"
import { predicateTable, type ScalarExpr } from "#compiler/ir/expr.ts"
import { textBoundsOf } from "#compiler/ir/scalar.ts"
import { compiledExpr, noParamLeaf } from "#compiler/scalar/compute/evaluate.ts"
import { ProgramPatterns, tablePatterns } from "#compiler/scalar/regex/patterns.ts"
import { succeeded } from "#test/support/assert.ts"
import { evaluate } from "#test/support/oracle/evaluate/catalog.ts"
import { patternMember } from "#test/support/oracle/reference/evaluate.ts"
import { baseParams, lowerWith, plainRender, renderSql } from "#test/unit/compute/support.ts"
import { boundedColumn, textColumn } from "#test/unit/compute/text.fixtures.ts"

/** A text, what it replaces and what it puts in each place. */
export interface ReplaceCase {
	readonly text: string
	readonly from: string
	readonly to: string
}

/** The characters texts are drawn of: the three a path segment escapes, one-, two- and four-byte characters. */
const characters = ["a", "%", "?", "#", "é", "😀"] as const

/** A text of `min` to `max` characters of the dictionary. */
const textOf =
	(min: number, max: number): Gen<string> =>
	(s) =>
		Arr.join(s.draw(array(element(characters), { min, max })), "")

/**
 * A case: a text of up to eight characters, a from of one character most often, else of two, now and then empty, and
 * a to of up to three, the empty one among them.
 */
const caseGen: Gen<ReplaceCase> = (s) => ({
	text: s.draw(textOf(0, 8)),
	from: s.draw(
		weighted<string>([
			[6, textOf(1, 1)],
			[2, textOf(2, 2)],
			[1, () => ""]
		])
	),
	to: s.draw(textOf(0, 3))
})

/** A batch of cases, each read in one statement. */
export const replaceBatch: Gen<Arr.NonEmptyReadonlyArray<ReplaceCase>> = (s) => {
	const [first, ...rest] = s.draw(array(caseGen, { min: 1, max: 24 }))
	return [defined(first, "a batch's first case"), ...rest]
}

/** The model: every occurrence of from in the text, left to right and none overlapping, replaced by to; none for an empty from. */
export const replaceModel = (c: ReplaceCase): string => {
	if (c.from === "") {
		return c.text
	}
	let rest = c.text
	let out = ""
	for (let at = Str.indexOf(c.from)(rest); at._tag === "Some"; at = Str.indexOf(c.from)(rest)) {
		out += `${Str.slice(0, at.value)(rest)}${c.to}`
		rest = Str.slice(at.value + c.from.length)(rest)
	}
	return `${out}${rest}`
}

/** Text.replace of the column `t` by the columns `f` and `r`. */
const replaceDesc: ExprDesc = {
	kind: "compute",
	fn: "replace",
	args: [
		{ kind: "var", var: "t" },
		{ kind: "var", var: "f" },
		{ kind: "var", var: "r" }
	]
}

/** Text.replace lowered at `mode` over three columns whose pattern bounds their bytes (boundedColumn), or over any texts. */
const replaceLowered = (mode: "query" | "check", bounded: boolean) =>
	lowerWith(
		mode,
		replaceDesc,
		bounded
			? { t: boundedColumn, f: boundedColumn, r: boundedColumn }
			: { t: textColumn, f: textColumn, r: textColumn },
		false,
		baseParams
	)

/**
 * The bound a lowered replace's term is within over the bounded columns: x's bytes, and for each occurrence of a from of
 * at least one byte, what to adds past it.
 */
const boundedBytes = (() => {
	const bytes = defined(
		boundedColumn.kind === "column" ? textBoundsOf(boundedColumn.type)?.bytes : undefined,
		"the bounded column's bytes"
	)
	return bytes + bytes * (bytes - 1)
})()

/** Every lowering the property reads: each site over the bounded columns, and a check over any texts. */
export const terms: ReadonlyArray<{ readonly label: string; readonly term: ScalarExpr }> = Arr.map(
	[
		["a query over bounded texts", "query", true],
		["a check over bounded texts", "check", true],
		["a check over any texts", "check", false]
	] as const,
	([label, mode, bounded]) => {
		const lowered = succeeded(replaceLowered(mode, bounded), `${label} holds replace`).root
		assert.equal(
			textBoundsOf(lowered.nominal)?.bytes,
			bounded ? boundedBytes : undefined,
			`${label}: replace's term is text within its bound`
		)
		return { label, term: lowered.expr }
	}
)

/** Text.replace lowered in a query over any texts, whose result no pattern bounds: refused. */
export const unboundedQuery = replaceLowered("query", false)

/** The SQL of every term over a batch's cases, `$1` their JSON, in their order. */
export const replaceSql = `SELECT ${Arr.join(
	Arr.map(terms, (t) => `(${renderSql(t.term, plainRender)})::text`),
	", "
)} FROM jsonb_to_recordset($1::text::jsonb) AS r0(ord int4, t text, f text, r text) ORDER BY r0.ord`

/** A case's columns, by name. */
const columnOf = (c: ReplaceCase, name: string): string =>
	name === "t" ? c.text : name === "f" ? c.from : c.to

/** The host evaluator's text of a lowered replace over a case (scalar/compute/evaluate.ts). */
export const hostReplace = (term: ScalarExpr, c: ReplaceCase): string => {
	const table = predicateTable(term)
	const value = succeeded(
		compiledExpr(table)(
			{
				value: undefined,
				column: (ref) => columnOf(c, ref.name),
				closed: () => undefined,
				param: noParamLeaf
			},
			ProgramPatterns.of(tablePatterns(table))
		),
		"the host evaluates replace"
	)
	return typeof value === "string"
		? value
		: assert.fail(`the host's replace is a text, not ${Formatter.format(value)}`)
}

/** The reference evaluator's text of a lowered replace over a case (test/support/oracle/evaluate/catalog.ts). */
export const referenceReplace = (term: ScalarExpr, c: ReplaceCase): string => {
	const value = evaluate(term, {
		kind: "row",
		column: (ref) => columnOf(c, ref.name),
		param: () => undefined,
		regexMember: patternMember
	})
	return value._tag === "Success" && typeof value.success === "string"
		? value.success
		: assert.fail(`the reference's replace is a text: ${Formatter.format(value)}`)
}

export type ReplaceFeature =
	| "one character by several"
	| "a character by none"
	| "two characters replaced"
	| "an empty from"
	| "no occurrence"
	| "a character beyond the Basic Multilingual Plane replaced"

/** The situations a case reaches. */
export const replaceFeatures = (c: ReplaceCase): ReadonlyArray<ReplaceFeature> => {
	const found = c.from !== "" && Str.includes(c.from)(c.text)
	const width = Array.from(c.from).length
	return [
		...(c.from === "" ? ["an empty from" as const] : []),
		...(c.from !== "" && !found ? ["no occurrence" as const] : []),
		...(found && width === 1 && Array.from(c.to).length > 1
			? ["one character by several" as const]
			: []),
		...(found && width === 1 && c.to === "" ? ["a character by none" as const] : []),
		...(found && width === 2 ? ["two characters replaced" as const] : []),
		...(found && Arr.some(Array.from(c.from), (ch) => ch.length > 1)
			? ["a character beyond the Basic Multilingual Plane replaced" as const]
			: [])
	]
}
