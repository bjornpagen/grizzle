/**
 * A found row's one text (program/text.ts rowTextOver, rowText, the shell's) over a box of rows of a query of two
 * refined texts, a set over a roster, a numeric of scale 2 and a head literal: rows whose texts concatenated without
 * frames meet ("ab" then "c", "a" then "bc"), a set's members in two orders, and a numeric in two spellings. Each row's
 * text equals another's exactly when the rows are one row, value for value under each type's equality.
 *
 * Oracle: each type's equality on the host values: a text's identity, a set's membership, a Decimal's `equals`.
 *
 * Features: none; the box is exhausted.
 */
import { assert } from "@bjornpagen/testing/assert"
import { element, finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import { rowText } from "#adapter/public/host.ts"
import { succeeded } from "#test/support/assert.ts"
import { sameRow, type TextRow, textQuery, textRows } from "#test/unit/program/row-text.fixtures.ts"

/** Two found rows have one text exactly when they are one row, whatever their values' spellings. */
export const aFoundRowsTextIsOneTextPerRowValueForValue = property.exhaust(
	finite((source) => source.draw(element(textRows))),
	{
		needs: {},
		situations: [],
		check: () => (row: TextRow) =>
			Effect.sync(() => {
				const text = succeeded(rowText(textQuery), "the query's rows have a text")
				const mine = succeeded(text(row), "a row of the query has its text")
				for (const other of textRows) {
					const theirs = succeeded(text(other), "a row of the query has its text")
					assert.equal(
						mine === theirs,
						sameRow(row, other),
						`${Formatter.format(row)} and ${Formatter.format(other)}: ${mine} against ${theirs}`
					)
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "each type's equality on the host values: a text's identity, a set's membership, a Decimal's equals"
		},
		box: "every row of words a, ab and b, names '', c and bc, the sets {}, {Low}, {Low, Mid} and {Mid, Low}, and the numerics 1.5 and 1.50",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/runtime/read/text.ts",
				original: `const framed = (text: string): string => \`\${text.length}:\${text}\``,
				replacement: "const framed = (text: string): string => text",
				why: "Texts are joined unframed, so the row of word ab and name c and the row of word a and name bc have one text."
			},
			{
				file: "packages/engine/src/runtime/read/text.ts",
				original: "\t\t\tconst handles = handleList(rosterOf(column.roster))",
				replacement:
					"\t\t\tconst handles = (value: unknown) => Result.ok(value instanceof Set ? [...value].map(String) : [])",
				why: "A set's handles are written in the order the caller's Set holds them, not its roster's declared order: {Low, Mid} and {Mid, Low}, one set, are two texts."
			}
		]
	}
)
