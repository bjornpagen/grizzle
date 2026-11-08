import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import {
	array,
	codePoint,
	element,
	type Gen,
	int,
	map,
	oneOf,
	string,
	subarray,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	pipe,
	Record as Rec,
	Result,
	String as Str
} from "effect"
import { indices } from "#compiler/core/array.ts"
import { conservativeMeta, type NodeOf, type RelNode } from "#compiler/ir/rel.ts"
import {
	arrayElements,
	type FusedLayout,
	fusedElement,
	fusedTexts
} from "#compiler/lower/shapes/attach/decode.ts"
import { chooseAttachment } from "#compiler/lower/shapes/attach/index.ts"
import { assert } from "#test/support/assert.ts"
import { strictArrayText } from "#test/support/kernel/strict.ts"
import { caseHang } from "#test/support/limits.ts"
import { Q, Reading, T } from "#test/unit/lower/conservative/fixtures.ts"
import { present } from "#test/unit/lower/support.ts"

import { regex } from "arkregex"
import { outputTextOf } from "#compiler/core/decoder.ts"
import type { Cell } from "#compiler/core/wire.ts"
import { outputRows, outputText } from "#test/support/wire.ts"
/**
 * The attachment shape: the fusion rule and the converter that reads a fused column back. The fused and pipelined
 * statements' rows are the optimized differential's on PostgreSQL (test/pg/oracle/optimized), and their decoding
 * through the public boundary the public differential's (test/pg/oracle/public).
 *
 * - The fusion rule (attach/index.ts chooseAttachment): a child fuses exactly when its parent's rows read an
 *   approximate search, whatever its width, and pipelines otherwise, whatever its width: no field count decides the
 *   form. Exhausted over every correlated Reading column, every set of further child fields and both parent readings.
 * - The converter (attach/decode.ts fusedTexts, arrayElements): over drawn layouts and children, a fused column as
 *   PostgreSQL writes it (array_out over the element texts, or over jsonb_out objects keyed f1..fn, or one `true` per
 *   child of correlated columns only) reads back as each child's texts in the child heading's order, the correlated
 *   ones copied from the parent row; and arrayElements reads every array_out text as the kernel's strict reading does.
 */

const attachOf = (node: RelNode): NodeOf<"Attach"> => {
	if (node.kind !== "Attach") {
		throw new Error("an attachment")
	}
	return node
}

type ReadingColumn = "id" | "value" | "price" | "paid" | "ok"
const readingColumns: Arr.NonEmptyReadonlyArray<ReadingColumn> = [
	"id",
	"value",
	"price",
	"paid",
	"ok"
]

/** Readings attached to the readings of one value of `correlated`, the child binding it and `fields`. */
const readingsBy = (correlated: ReadingColumn, fields: ReadonlyArray<ReadingColumn>) => {
	const q = new Q()
	const parent = q.region([
		{ source: q.base(Reading, conservativeMeta), bind: { [correlated]: "p" }, constants: {} }
	])
	const child = q.region([
		{
			source: q.base(Reading, conservativeMeta),
			bind: Rec.fromEntries(Arr.map([correlated, ...fields], (c) => [c, c])),
			constants: {}
		}
	])
	return q.build(q.attach(parent, child, "readings", [["p", correlated]], "array", undefined))
}

describe("the attachment fusion rule", () => {
	it.effect(
		"fuses a child exactly when its parent's rows read an approximate search, at any width",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: { kind: "unstated" },
						oracle: { kind: "unstated" },
						suite: "unit/lower/shapes/attach/fusion",
						literal: Formatter.format,
						/** Every correlated column, every set of the other columns as further child fields, both parents. */
						generator: (source) => {
							const correlated = source.draw(element(readingColumns))
							return {
								correlated,
								fields: source.draw(subarray(Arr.filter(readingColumns, (f) => f !== correlated))),
								parents: source.draw(element<"exact" | "approximate">(["exact", "approximate"]))
							}
						},
						limit: 160,
						coverage: requiredInSpace<"fused" | "pipelined">(["fused", "pipelined"]),
						caseHang
					},
					({ correlated, fields, parents }, c) =>
						Effect.sync(() => {
							const built = readingsBy(correlated, fields)
							const expected = parents === "approximate" ? "fused" : "pipelined"
							assert.equal(chooseAttachment(attachOf(built.dag.roots[0]), parents), expected)
							c.note(expected)
						})
				)
			)
	)
})

/**
 * PostgreSQL's array_out of text elements: an element is double-quoted when it is empty, holds a delimiter, brace,
 * quote, backslash or whitespace, or spells NULL in any case, with `"` and `\` backslash-escaped inside the quotes.
 */
const quoted = (e: string): boolean =>
	e === "" || regex('[{},"\\\\ \\t\\n\\r\\v\\f]', "u").test(e) || Str.toUpperCase(e) === "NULL"

const arrayOut = (elements: ReadonlyArray<string>): string =>
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
const textGen: Gen<string> = oneOf([
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

const fusedCaseGen: Gen<FusedCase> = (source) => {
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
const fusedColumn = (c: FusedCase): string => {
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

type FusedFeature =
	| "no element field"
	| "one element field"
	| "several element fields"
	| "correlated"
	| "no child"

describe("the fused attachment codec", () => {
	it.effect(
		"reads each child's texts back from the column PostgreSQL writes, the correlated ones from the parent row",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/lower/shapes/attach/fused-texts",
						literal: Formatter.format,
						kept: [],
						draw: drawn(fusedCaseGen),
						runs: 200,
						shrink: completeShrink,
						coverage: required<FusedFeature>(
							[
								"no element field",
								"one element field",
								"several element fields",
								"correlated",
								"no child"
							],
							{ cases: 200, sense: notesOnly }
						),
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, note) =>
						Effect.sync(() => {
							const element = fusedElement(c.layout)
							const expected = Arr.map(c.children, (texts) =>
								Arr.map(c.layout.columns, ({ column, source }) =>
									source.from === "element"
										? present(
												texts[
													Option.getOrThrowWith(
														Arr.findFirstIndex(element, (e) => e.name === column.name),
														() => new Error("a column the case's own heading holds")
													)
												],
												`the text of ${column.name}`
											)
										: present(
												c.parent[c.parentAt(source.parent)],
												`the parent text of ${column.name}`
											)
								)
							)
							const parentCell = (column: string) => (row: ReadonlyArray<Cell>) =>
								outputTextOf(present(row[c.parentAt(column)], `the parent text of ${column}`))
							assert.deepEqual(
								fusedTexts(c.layout, parentCell)(
									outputText(fusedColumn(c)),
									Arr.map(c.parent, outputText)
								),
								outputRows(expected)
							)
							note.note(
								element.length === 0
									? "no element field"
									: element.length === 1
										? "one element field"
										: "several element fields"
							)
							if (Arr.some(c.layout.columns, (x) => x.source.from === "parent")) {
								note.note("correlated")
							}
							if (c.children.length === 0) {
								note.note("no child")
							}
						})
				)
			)
	)

	it.effect("reads every array_out text as the strict reading does", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: { kind: "unstated" },
					suite: "unit/lower/shapes/attach/array-text",
					literal: Formatter.format,
					kept: [],
					draw: drawn(array(textGen, { min: 0, max: 5 })),
					runs: 200,
					shrink: completeShrink,
					coverage: required<"empty" | "quoted">(["empty", "quoted"], {
						cases: 200,
						sense: notesOnly
					}),
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(elements, note) =>
					Effect.sync(() => {
						const text = arrayOut(elements)
						assert.deepEqual(arrayElements(text), elements)
						assert.deepEqual(strictArrayText(text), Result.succeed(arrayElements(text)))
						if (elements.length === 0) {
							note.note("empty")
						}
						if (Arr.some(elements, quoted)) {
							note.note("quoted")
						}
					})
			)
		)
	)
})
