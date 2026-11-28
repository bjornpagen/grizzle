/**
 * What the property of cut.test.ts reads: its batches, Text.cutBefore and Text.cutFrom lowered at both sites, their SQL
 * and the host's and the reference evaluator's values.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { array, element, type Gen, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Formatter, Option } from "effect"
import type { ExprDesc } from "#compiler/ir/desc.ts"
import { predicateTable } from "#compiler/ir/expr.ts"
import { textBoundsOf } from "#compiler/ir/scalar.ts"
import { libraryCreate } from "#compiler/physical/ddl/library.ts"
import { compiledExpr, noParamLeaf } from "#compiler/scalar/compute/evaluate.ts"
import { ProgramPatterns, tablePatterns } from "#compiler/scalar/regex/patterns.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { succeeded } from "#test/support/assert.ts"
import { evaluate } from "#test/support/oracle/evaluate/catalog.ts"
import { patternMember } from "#test/support/oracle/reference/evaluate.ts"
import {
	baseParams,
	lowerWith,
	plainRender,
	renderSql
} from "#test/support/unit/compute/support.ts"
import { boundedColumn, textColumn } from "#test/support/unit/compute/text.fixtures.ts"

/** The two sides of a cut, each a library function of its own name. */
export const cuts = ["cutBefore", "cutFrom"] as const

export type Cut = (typeof cuts)[number]

/** A text and the characters it is cut at. */
export interface CutPair {
	readonly text: string
	readonly chars: string
}

/**
 * The characters texts and sets are drawn of: an href's delimiters, one-, two- and four-byte characters, the last a
 * pair of UTF-16 code units, and a percent.
 */
const characters = ["a", "?", "#", "/", "%", "é", "😀"] as const

/** A text of `min` to `max` characters of the dictionary. */
const textOf =
	(min: number, max: number): Gen<string> =>
	(s) =>
		Arr.join(s.draw(array(element(characters), { min, max })), "")

/** A pair: a text of up to seven characters, and a set of up to three, the empty set and a repeat among them. */
const pairGen: Gen<CutPair> = (s) => ({
	text: s.draw(textOf(0, 7)),
	chars: s.draw(
		weighted<string>([
			[8, textOf(1, 3)],
			[1, () => ""]
		])
	)
})

/** A batch of pairs, each cut by both functions, at both sites, in one statement. */
export const cutBatch: Gen<Arr.NonEmptyReadonlyArray<CutPair>> = (s) => {
	const [first, ...rest] = s.draw(array(pairGen, { min: 1, max: 24 }))
	return [defined(first, "a batch's first pair"), ...rest]
}

/** `fn` of the text column `t` at the set column `c`. */
const cutDesc = (fn: Cut): ExprDesc => ({
	kind: "compute",
	fn,
	args: [
		{ kind: "var", var: "t" },
		{ kind: "var", var: "c" }
	]
})

/**
 * `fn` lowered at `mode`, over a text whose pattern bounds its bytes, `^.{0,8}$`, or over any text: every site holds
 * it, and its term is text within the text's bytes, none where they are unbounded.
 */
export const cutLowered = (fn: Cut, mode: "query" | "check", bounded: boolean) => {
	const subject = bounded ? boundedColumn : textColumn
	const lowered = succeeded(
		lowerWith(mode, cutDesc(fn), { t: subject, c: textColumn }, false, baseParams),
		`${mode} holds ${fn} over ${bounded ? "a bounded" : "any"} text`
	).root
	assert.equal(
		textBoundsOf(lowered.nominal)?.bytes,
		subject.kind === "column" ? textBoundsOf(subject.type)?.bytes : undefined,
		`${mode}: ${fn}'s term is text within its subject's bytes`
	)
	return lowered.expr
}

/** Each cut's library function, created in the session's pg_temp, where the terms' SQL calls them. */
export const createLibrary = Arr.map(cuts, (fn) => printStatement(libraryCreate("pg_temp", fn)))

/** The SQL of `terms` over a batch's pairs, `$1` their JSON, in their order: each term's text of each pair. */
export const cutSql = (terms: ReadonlyArray<ReturnType<typeof cutLowered>>): string =>
	`SELECT ${Arr.join(
		Arr.map(terms, (t) => `(${renderSql(t, plainRender)})::text`),
		", "
	)} FROM jsonb_to_recordset($1::text::jsonb) AS r0(ord int4, t text, c text) ORDER BY r0.ord`

/** A pair's columns, by name. */
const columnOf = (pair: CutPair, name: string): string => (name === "t" ? pair.text : pair.chars)

/** The host evaluator's text of a lowered cut over a pair (scalar/compute/evaluate.ts). */
export const hostCut = (term: ReturnType<typeof cutLowered>, pair: CutPair): string => {
	const table = predicateTable(term)
	const value = succeeded(
		compiledExpr(table)(
			{
				value: undefined,
				column: (ref) => columnOf(pair, ref.name),
				closed: () => undefined,
				param: noParamLeaf
			},
			ProgramPatterns.of(tablePatterns(table))
		),
		"the host evaluates a cut"
	)
	return typeof value === "string"
		? value
		: assert.fail(`the host's cut is a text, not ${Formatter.format(value)}`)
}

/** The reference evaluator's text of a lowered cut over a pair (test/support/oracle/evaluate/catalog.ts). */
export const referenceCut = (term: ReturnType<typeof cutLowered>, pair: CutPair): string => {
	const value = evaluate(term, {
		kind: "row",
		column: (ref) => columnOf(pair, ref.name),
		param: () => undefined,
		regexMember: patternMember
	})
	return value._tag === "Success" && typeof value.success === "string"
		? value.success
		: assert.fail(`the reference's cut is a text: ${Formatter.format(value)}`)
}

export type CutFeature =
	| "a cut inside the text"
	| "a cut at the first character"
	| "no character of the set in the text"
	| "the set empty"
	| "a repeated character in the set"
	| "a character beyond the Basic Multilingual Plane before the cut"
	| "the cut at a character beyond the Basic Multilingual Plane"

/**
 * The model of a pair's cut: its text's code points, the place of the first one its set's code points hold, none where
 * they hold none, and the text before it and from it on, all of the text and the empty text where none is found.
 */
export const cutModel = (pair: CutPair) => {
	const points = Array.from(pair.text)
	const set = Array.from(pair.chars)
	const found = Arr.findFirstIndex(points, (p) => Arr.contains(set, p))
	const at = Option.getOrElse(found, () => points.length)
	return {
		points,
		set,
		found,
		cutBefore: Arr.join(points.slice(0, at), ""),
		cutFrom: Arr.join(points.slice(at), "")
	}
}

/** The situations a pair reaches: where its text is cut, and what its set holds. */
export const cutFeatures = (pair: CutPair): ReadonlyArray<CutFeature> => {
	const { points, set, found } = cutModel(pair)
	const wide = (p: string | undefined): boolean => p !== undefined && p.length > 1
	return [
		...(set.length === 0 ? ["the set empty" as const] : []),
		...(new Set(set).size < set.length ? ["a repeated character in the set" as const] : []),
		...Option.match(found, {
			onNone: () => ["no character of the set in the text" as const],
			onSome: (at) => [
				at === 0 ? ("a cut at the first character" as const) : ("a cut inside the text" as const),
				...(Arr.some(points.slice(0, at), wide)
					? ["a character beyond the Basic Multilingual Plane before the cut" as const]
					: []),
				...(wide(points[at])
					? ["the cut at a character beyond the Basic Multilingual Plane" as const]
					: [])
			]
		})
	]
}
