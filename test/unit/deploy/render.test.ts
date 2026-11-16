/**
 * A migration file's markers, generated (deploy/render/markers.ts): a file is drawn as its lines, each built from
 * pieces whose reading is known by construction, so where a placeholder token counts is known without a scanner.
 *
 * - **Markers:** a line is a placeholder when, past its leading whitespace, it starts with the placeholder marker, or
 *   when it holds the placeholder token in SQL PostgreSQL's scanner reads: a word (the token alone or inside one), a
 *   string constant, a quoted identifier, a dollar-quoted body, each of which may span lines, or a run the scanner reads
 *   whole and refuses, such as junk after a number; never in a line comment or a block comment, nested or spanning
 *   lines, and a comment after a refused run, such as `""`, is still a comment. From an unterminated quote or block
 *   comment to the end, nothing is known to be a comment, so every token there counts. Otherwise a line that starts
 *   with the confirm marker is a confirm. A marker line counts by its text wherever it stands, inside a comment or a
 *   string too. Lines end in `\n` or `\r\n`.
 * - **generate's line:** each marker prints as its file, its line, its kind and its own kind's fix (cli/run.ts
 *   markerLine), so a confirm is never told to fill a placeholder.
 * - **No transaction:** a file runs statement by statement exactly when its first line is the no-transaction marker,
 *   trailing spaces, tabs and a carriage return aside; the marker anywhere else, or after text, is no marker.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import { refusalText } from "#cli/refusals.ts"
import { markerLine } from "#cli/run.ts"
import { findMarkers, isNoTransaction } from "#compiler/deploy/render/markers.ts"
import { assert } from "#test/support/assert.ts"
import {
	fileGen,
	type MarkerFeature,
	markerOf,
	noTransactionLine,
	textOf
} from "#test/unit/deploy/render.fixtures.ts"

/** A migration file's markers, generated are found on exactly the lines the model reads, generate prints each with its own kind's fix, and a file runs statement by statement exactly when its first line is the marker. Its budget is its suite's before it was a property (test/unit/deploy/render.test.ts at 4ca3036a): 400 runs and 600 steered cases. */
export const aMigrationFilesMarkersGeneratedAreFoundOnExactlyTheLinesTheModelReadsGeneratePrintsEachWithItsOwnKindsFixAndAFileRunsStatementByStatementExactlyWhenItsFirstLineIsTheMarker =
	property.explore(fileGen, {
		needs: {},
		budget: { runs: 400, steered: 600 },
		situations: [
			"a placeholder marker line",
			"a confirm marker line",
			"a token in a word",
			"a token in a string spanning lines",
			"a token in a quoted identifier",
			"a token in a dollar-quoted body",
			"a run PostgreSQL refuses",
			"a token in a run PostgreSQL refuses",
			"a token in a line comment, uncounted",
			"a token in a line comment after a run PostgreSQL refuses, uncounted",
			"a token in a block comment spanning lines, uncounted",
			"a token in a nested block comment, uncounted",
			"a token past an unterminated quote",
			"a token past an unterminated block comment",
			"a marker line inside a block comment",
			"a file run statement by statement",
			"a no-transaction marker below the first line",
			"CRLF line ends"
		] satisfies ReadonlyArray<Reached<MarkerFeature>>,
		check: (_, c: Case<MarkerFeature>) => (file) =>
			Effect.sync(() => {
				const text = textOf(file)
				c.noteAll(
					Arr.flatMap(file.lines, (l, i) =>
						Arr.filter(
							l.features,
							(f) => i > 0 || f !== "a no-transaction marker below the first line"
						)
					)
				)
				if (file.crlf && file.lines.length > 1) {
					c.note("CRLF line ends")
				}
				const expected = Arr.flatMap(file.lines, (l, i) => {
					const kind = markerOf(l)
					return kind === undefined ? [] : [{ kind, line: i + 1 }]
				})
				const found = findMarkers(text)
				assert.deepEqual(found, expected, Formatter.format(text))
				assert.deepEqual(
					Arr.map(found, (m) => markerLine("migrations/s/f", { file: "01-structure.sql", ...m })),
					Arr.map(
						found,
						(m) =>
							`migrations/s/f/01-structure.sql:${m.line}: ${m.kind}: ${refusalText[m.kind].fix}`
					),
					"each marker prints with its own kind's fix"
				)
				const statementwise = Option.exists(Arr.head(Str.split(text, "\n")), (first) =>
					noTransactionLine.test(first)
				)
				if (statementwise) {
					c.note("a file run statement by statement")
				}
				assert.equal(isNoTransaction(text), statementwise, Formatter.format(text))
			}),
		oracle: {
			kind: "second-implementation",
			name: "a file drawn as pieces whose scanner reading is known by construction, and the marker rules read line by line"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/render/markers.ts",
				original: "\treturn firstLine.trimEnd() === noTransactionMarker",
				replacement: '\treturn firstLine.replace(/[ \\t]*$/, "") === noTransactionMarker',
				why: "The no-transaction line's carriage return is kept, so a no-transaction marker line ending in CRLF reads as none; the no-transaction property fails."
			}
		]
	})
