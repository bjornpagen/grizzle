/** What the properties of attach.test.ts read: its spaces, models and helpers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import {
	array,
	codePoint,
	element,
	type Gen,
	int,
	map,
	oneOf,
	string,
	weighted
} from "@bjornpagen/testing/gen"
import { regex } from "arkregex"
import { Array as Arr, Option, pipe, String as Str } from "effect"
import { fusedElement, type FusedLayout } from "#compiler/runtime/lower/fused.ts"
import { T } from "#test/support/unit/lower/conservative/fixtures.ts"
import { present } from "#test/support/unit/lower/support.ts"

/**
 * PostgreSQL's array_out of text elements: an element is double-quoted when it is empty, holds a delimiter, brace,
 * quote, backslash or whitespace, or spells NULL in any case, with `"` and `\` backslash-escaped inside the quotes.
 */
export const quoted = (e: string): boolean =>
	e === "" || regex('[{},"\\\\ \\t\\n\\r\\v\\f]', "u").test(e) || Str.toUpperCase(e) === "NULL"

export const arrayOut = (elements: ReadonlyArray<string>): string =>
	`{${Arr.join(
		Arr.map(elements, (e) =>
			quoted(e) ? `"${pipe(Str.replaceAll("\\", "\\\\")(e), Str.replaceAll('"', '\\"'))}"` : e
		),
		","
	)}}`

/** PostgreSQL's escape_json: `"` and `\` escaped, \b \f \n \r \t by name, every other control character as \u00xx. */
const jsonString = (text: string): string => {
	let out = '"'
	for (const ch of text) {
		const control = Option.filter(Str.charCodeAt(ch, 0), (code) => code < 0x20)
		if (ch === '"') {
			out += '\\"'
		} else if (ch === "\\") {
			out += "\\\\"
		} else if (ch === "\b") {
			out += "\\b"
		} else if (ch === "\f") {
			out += "\\f"
		} else if (ch === "\n") {
			out += "\\n"
		} else if (ch === "\r") {
			out += "\\r"
		} else if (ch === "\t") {
			out += "\\t"
		} else if (Option.isSome(control)) {
			out += `\\u${pipe(control.value.toString(16), Str.padStart(4, "0"))}`
		} else {
			out += ch
		}
	}
	return `${out}"`
}

/** jsonb_out of an object whose values are strings, keyed f1..fn in field order. */
const jsonbObject = (values: ReadonlyArray<string>): string =>
	`{${Arr.join(
		Arr.map(values, (v, i) => `"f${i + 1}": ${jsonString(v)}`),
		", "
	)}}`

/**
 * One grapheme: printable ASCII, Latin, Greek and Cyrillic letters, CJK ideographs, emoji, and a Latin letter
 * decomposed into its base and combining mark. No control character, as no grapheme is one.
 */
const graphemeGen: Gen<string> = weighted([
	[2, codePoint(0x20, 0x7e)],
	[1, codePoint(0xa0, 0x2ff)],
	[1, codePoint(0x370, 0x4ff)],
	[2, codePoint(0x4e00, 0x9fff)],
	[1, codePoint(0x1f300, 0x1f64f)],
	[1, map(codePoint(0xc0, 0x17f), Str.normalize("NFD"))]
])

/** Texts PostgreSQL treats specially in an array or a JSON string, beside arbitrary ones. */
export const textGen: Gen<string> = oneOf([
	string(graphemeGen, { min: 0, max: 6 }),
	element([
		"",
		"NULL",
		"null",
		"NuLl",
		" ",
		"a b",
		'"',
		"\\",
		"{",
		"}",
		",",
		"\u0001\u001f",
		"\n\t\r",
		"😀 é",
		"1.50"
	])
])

/**
 * A fused attachment's layout: the child heading, each column an element field or correlated to a parent column, in a
 * drawn order; the children's element texts; and the parent row's texts, the correlated columns among them.
 */
interface FusedCase {
	readonly layout: FusedLayout
	readonly parentAt: (column: string) => number
	readonly parent: ReadonlyArray<string>
	readonly children: ReadonlyArray<ReadonlyArray<string>>
}

export const fusedCaseGen: Gen<FusedCase> = (source) => {
	const roles = source.draw(
		array(element<"element" | "correlated">(["element", "correlated"]), { min: 0, max: 4 })
	)
	const parentFirst = source.draw(int(0, 2))
	const children = source.draw(int(0, 3))
	const layout: FusedLayout = {
		columns: Arr.map(roles, (role, i) => ({
			column: { name: `c${i}`, type: T.text },
			source: role === "element" ? { from: "element" } : { from: "parent", parent: `p_c${i}` }
		}))
	}
	const fields = fusedElement(layout)
	/** The parent row: some leading columns of its own, then the correlated ones. */
	const parentColumns = [
		...Arr.map(indices(parentFirst), (i) => `own${i}`),
		...Arr.flatMap(layout.columns, (c) => (c.source.from === "parent" ? [c.source.parent] : []))
	]
	const parent = source.draw(
		array(textGen, { min: parentColumns.length, max: parentColumns.length })
	)
	const rows = source.draw(
		array(array(textGen, { min: fields.length, max: fields.length }), {
			min: children,
			max: children
		})
	)
	return {
		layout,
		parentAt: (column) => parentColumns.indexOf(column),
		parent,
		children: rows
	}
}

/**
 * The fused column PostgreSQL writes for the children: their element texts, as text[] for one field, as jsonb[] of
 * objects for several, and one `true` each for none.
 */
export const fusedColumn = (c: FusedCase): string => {
	const width = fusedElement(c.layout).length
	return arrayOut(
		Arr.map(c.children, (texts) =>
			width === 0
				? "true"
				: width === 1
					? present(texts[0], "the element text")
					: jsonbObject(texts)
		)
	)
}

export type FusedFeature =
	| "no element field"
	| "one element field"
	| "several element fields"
	| "correlated"
	| "no child"
