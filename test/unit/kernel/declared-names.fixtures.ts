/** What the properties of declared-names.test.ts read: its spaces, models and helpers. */

import { maxIdentifierBytes } from "@bjornpagen/grizzle-engine/core/identity"
import { characterOf, element, type Gen, int, string, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"
import { nonEmpty } from "#test/support/assert.ts"

const lowercase = nonEmpty(Arr.fromIterable("abcdefghijklmnopqrstuvwxyz"), "lowercase letters")

const uppercase = nonEmpty(Arr.fromIterable("ABCDEFGHIJKLMNOPQRSTUVWXYZ"), "capital letters")

const digits = nonEmpty(Arr.fromIterable("0123456789"), "digits")

/** A segment as declared and as its conversion spells it. */
interface Segment {
	readonly declared: string
	readonly converted: string
}

/** A word: a capital and `length - 1` lowercase letters. */
const wordOf =
	(length: number): Gen<Segment> =>
	(source) => {
		const declared = `${source.draw(characterOf(uppercase))}${source.draw(string(characterOf(lowercase), { min: length - 1, max: length - 1 }))}`
		return { declared, converted: Str.toLowerCase(declared) }
	}

/** A run of two to four capitals, which a following word's capital ends. */
const acronym: Gen<Segment> = (source) => {
	const declared = source.draw(string(characterOf(uppercase), { min: 2, max: 4 }))
	return { declared, converted: Str.toLowerCase(declared) }
}

/** A run of one to three digits. */
const digitRun: Gen<Segment> = (source) => {
	const declared = source.draw(string(characterOf(digits), { min: 1, max: 3 }))
	return { declared, converted: declared }
}

type Kind = "word" | "acronym" | "digits"

/**
 * How a segment joins the one before it: an underscore always splits; with nothing between, the boundary rule must
 * split them, which it does unless both are digit runs or both acronyms, or an acronym runs into a digit-free acronym.
 */
const joined = (before: Kind, after: Kind, underscore: boolean): string =>
	underscore || (before === after && before !== "word") ? "_" : ""

/** A declared name of words, acronyms and digit runs whose conversion is `target` bytes, its first segment a word. */
export const nameOf =
	(target: number): Gen<{ readonly declared: string; readonly converted: string }> =>
	(source) => {
		const first = source.draw(wordOf(source.draw(int(2, 8))))
		let declared = first.declared
		const converted: Array<string> = [first.converted]
		let before: Kind = "word"
		const length = () => Arr.reduce(converted, converted.length - 1, (n, s) => n + s.length)
		while (target - length() > 12) {
			const kind = source.draw(element(["word", "acronym", "digits"] as const))
			const segment = source.draw(
				kind === "word" ? wordOf(source.draw(int(2, 8))) : kind === "acronym" ? acronym : digitRun
			)
			declared += `${joined(before, kind, source.draw(element([false, true] as const)))}${segment.declared}`
			converted.push(segment.converted)
			before = kind
		}
		const last = source.draw(wordOf(Math.max(2, target - length() - 1)))
		declared += `${joined(before, "word", source.draw(element([false, true] as const)))}${last.declared}`
		converted.push(last.converted)
		return { declared, converted: Arr.join(converted, "_") }
	}

/** A conversion's length around the limit: mostly within two bytes of it, sometimes well under or past. */
export const targetGen: Gen<number> = weighted<number>([
	[4, int(maxIdentifierBytes - 2, maxIdentifierBytes + 2)],
	[1, int(20, maxIdentifierBytes + 12)]
])

export type LimitFeature =
	| "under the limit"
	| "at the limit"
	| "one byte past"
	| "far past"
	| "two at the limit apart"

export const situationOf = (bytes: number): LimitFeature =>
	bytes < maxIdentifierBytes
		? "under the limit"
		: bytes === maxIdentifierBytes
			? "at the limit"
			: bytes === maxIdentifierBytes + 1
				? "one byte past"
				: "far past"

/** PostgreSQL 19's system columns, as src/backend/catalog/heap.c spells its SysAtt: every table and materialized view
 * holds them, and refuses a column declared under one (42701). */
export const pgSystemColumns = ["ctid", "xmin", "cmin", "xmax", "cmax", "tableoid"] as const

/** A field name as declared beside a system column, and its conversion. */
export interface FieldNamed {
	readonly declared: string
	readonly converted: string
}

/** Each spelling of a system column whose conversion is the column's own: lowercase, a capital first, all capitals. */
const systemSpellingGen: Gen<FieldNamed> = (source) => {
	const column = source.draw(element(pgSystemColumns))
	const declared = source.draw(element([column, Str.capitalize(column), Str.toUpperCase(column)]))
	return { declared, converted: column }
}

/** A name one step from a system column's whose conversion is another: a digit after it, a letter before it, or the
 * column cut in two segments. */
const nearSpellingGen: Gen<FieldNamed> = (source) => {
	const column = source.draw(element(pgSystemColumns))
	const digit = source.draw(characterOf(digits))
	const letter = source.draw(characterOf(lowercase))
	const cut = source.draw(int(1, column.length - 1))
	return source.draw(
		element([
			{ declared: `${column}${digit}`, converted: `${column}_${digit}` },
			{ declared: `${letter}${column}`, converted: `${letter}${column}` },
			{
				declared: `${Str.slice(0, cut)(column)}_${Str.slice(cut)(column)}`,
				converted: `${Str.slice(0, cut)(column)}_${Str.slice(cut)(column)}`
			}
		])
	)
}

/** A field name: a system column's spelled any way its conversion keeps, one a step from one, or any short name. */
export const fieldNamedGen: Gen<FieldNamed> = weighted<FieldNamed>([
	[2, systemSpellingGen],
	[2, nearSpellingGen],
	[1, nameOf(12)]
])

export type SystemColumnFeature = `${(typeof pgSystemColumns)[number]} refused` | "admitted"
