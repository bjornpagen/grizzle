/**
 * The attachment shape's converter, which reads a fused column back (runtime/lower/fused.ts fusedTexts, arrayElements): over
 * drawn layouts and children, a fused column as PostgreSQL writes it (array_out over the element texts, or over
 * jsonb_out objects keyed f1..fn, or one `true` per child of correlated columns only) reads back as each child's texts
 * in the child heading's order, the correlated ones copied from the parent row; and arrayElements reads every
 * array_out text as the kernel's strict reading does. The fused and pipelined statements' rows are the optimized
 * differential's on PostgreSQL (test/pg/oracle/optimized), and their decoding through the public boundary the public
 * differential's (test/pg/oracle/public).
 *
 * Oracle: a model of PostgreSQL's array_out and jsonb_out (a round trip: the texts the model writes read back as
 * written), and the kernel's strict array reading (a second implementation). The texts PostgreSQL treats specially
 * (empty, NULL in any case, delimiters, quotes, backslashes, control characters) are named cases beside drawn ones.
 *
 * Features: no, one and several element fields, a correlated column, no child; an empty array and a quoted element.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { array } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Result } from "effect"
import { outputTextOf } from "#compiler/core/decoder.ts"
import type { Cell } from "#compiler/core/wire.ts"
import { arrayElements, fusedElement, fusedTexts } from "#compiler/runtime/lower/fused.ts"
import { strictArrayText } from "#test/support/kernel/strict.ts"
import { present } from "#test/support/unit/lower/support.ts"
import { outputRows, outputText } from "#test/support/wire.ts"
import {
	arrayOut,
	fusedCaseGen,
	fusedColumn,
	type FusedFeature,
	quoted,
	textGen
} from "#test/unit/lower/shapes/attach.fixtures.ts"

/**
 * The fused attachment codec reads each child's texts back from the column PostgreSQL writes, the correlated ones from
 * the parent row.
 *
 * Budget: 200 runs and 200 steered cases, what its suite stated before it became a property
 * (test/unit/lower/shapes/attach.test.ts:208 at 8cad5bce, its runs and its coverage's cases).
 */
export const theFusedAttachmentCodecReadsEachChildsTextsBackFromTheColumnPostgreSQLWritesTheCorrelatedOnesFromTheParentRow =
	property.explore(fusedCaseGen, {
		needs: {},
		budget: { runs: 200, steered: 200 },
		situations: [
			"no element field",
			"one element field",
			"several element fields",
			"correlated",
			"no child"
		] satisfies ReadonlyArray<Reached<FusedFeature>>,
		check: (_, note: Case<FusedFeature>) => (c) =>
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
							: present(c.parent[c.parentAt(source.parent)], `the parent text of ${column.name}`)
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
			}),
		oracle: {
			kind: "universal",
			name: "a model of array_out and jsonb_out over the children's texts reads back as written"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/runtime/lower/fused.ts",
				original: "\t\tarrayElements(text).map((e) => {",
				replacement: "\t\tarrayElements(text).toReversed().map((e) => {",
				why: "fusedTexts reads a fused column's children back in reverse order; the round-trip search fails."
			},
			{
				file: "packages/engine/src/runtime/lower/fused.ts",
				original:
					"\t\tvalue += text.slice(start, backslash) + text.slice(backslash + 1, backslash + 2)",
				replacement: "\t\tvalue += text.slice(start, backslash + 2)",
				why: "arrayElements keeps a quoted element's escaping backslashes; the round-trip and the strict-reading searches fail."
			}
		]
	})

/**
 * The fused attachment codec reads every array_out text as the strict reading does.
 *
 * Budget: 200 runs and 200 steered cases, what its suite stated before it became a property
 * (test/unit/lower/shapes/attach.test.ts:286 at 8cad5bce, its runs and its coverage's cases).
 */
export const theFusedAttachmentCodecReadsEveryArrayOutTextAsTheStrictReadingDoes = property.explore(
	array(textGen, { min: 0, max: 5 }),
	{
		needs: {},
		budget: { runs: 200, steered: 200 },
		situations: ["empty", "quoted"] satisfies ReadonlyArray<Reached<"empty" | "quoted">>,
		check: (_, note: Case<"empty" | "quoted">) => (elements) =>
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
			}),
		oracle: {
			kind: "second-implementation",
			name: "a model of array_out read back, and the kernel's strict array reading"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/runtime/lower/fused.ts",
				original:
					"\t\tvalue += text.slice(start, backslash) + text.slice(backslash + 1, backslash + 2)",
				replacement: "\t\tvalue += text.slice(start, backslash + 2)",
				why: "arrayElements keeps a quoted element's escaping backslashes; the round-trip and the strict-reading searches fail."
			}
		]
	}
)
