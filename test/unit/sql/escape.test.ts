/**
 * The drift report's view of a difference (sql/escape.ts differenceShown, adapter/admission/drift.ts mismatchLine): two
 * descriptions of one key are shown by where they first differ and each around it, never as two whole texts, with
 * nothing invisible in them. WINDOW2 read two printed CHECKs of 395,593 characters as identical, since the one
 * character apart, a carriage return, moves a terminal's cursor.
 *
 * A case draws two texts that share a prefix and then differ, or one of which is a prefix of the other, of the runs the
 * escapes concern: C0 and C1 controls, DEL, the line and paragraph separators, a backslash and a backslash before an
 * escape's letter, and astral characters whose surrogate pairs share their first half; short texts and texts reaching
 * past the window on either side.
 *
 * Properties, for every pair:
 * - the difference is at the 1-based code point the two texts first differ at, and each text's length is its code
 *   points;
 * - each side's window holds no character sql/escape.ts escapes, so none is invisible;
 * - each window read back, as PostgreSQL's escape strings read its escapes, is the text's own run from a code point
 *   boundary at most the window's context before the difference to the end of the context after it, or to the text's
 *   ends where they are nearer, with an ellipsis exactly where it is cut.
 *
 * Oracle: the host's own reading of both texts by code points (Array.from) and of the escapes, a second implementation.
 *
 * Features: a carriage return at the difference, a control character and a backslash in a window, an astral character
 * before the difference, a window cut before and after, and one text a prefix of the other, each constructed while it is
 * pending.
 */

import { assert } from "@bjornpagen/testing/assert"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { differenceShown } from "#compiler/sql/escape.ts"
import {
	aims,
	holdsInvisible,
	pairGen,
	readBack,
	type ShownFeature,
	shownFeatures
} from "#test/unit/sql/escape.fixtures.ts"

/** The code units of context the report shows on either side of a difference, as sql/escape.ts states them. */
const context = 60

/** Two different texts are shown by the code point they first differ at, each around it, escaped so nothing is invisible and read back as its own run, cut with an ellipsis exactly where the window ends before a text does. */
export const twoDifferentTextsAreShownByTheCodePointTheyFirstDifferAtEachAroundItEscapedSoNothingIsInvisible =
	property.explore(aimed(pairGen, aims), {
		needs: {},
		situations: shownFeatures,
		check:
			(_, c: Case<ShownFeature>) =>
			({ first, second }) =>
				Effect.sync(() => {
					const a = Array.from(first)
					const b = Array.from(second)
					const at = Arr.findFirstIndex(a, (x, i) => x !== b[i])
					const differs = at._tag === "Some" ? at.value : a.length
					const shown = differenceShown(first, second)
					assert.equal(shown.at, differs + 1, "the difference is at the first code point apart")
					assert.deepEqual(
						shown.characters,
						{ first: a.length, second: b.length },
						"each text's length is its code points"
					)
					const units = Arr.join(Arr.take(a, differs), "").length
					for (const [text, window] of [
						[first, shown.first],
						[second, shown.second]
					] as const) {
						assert.ok(
							!holdsInvisible(window),
							`the window holds nothing invisible: ${Formatter.format(window)}`
						)
						const read = readBack(window)
						const s0 = Math.max(0, units - context)
						const e0 = Math.min(text.length, units + context)
						const boundary = (o: number) => Str.slice(0, o)(text).isWellFormed()
						const spans = Arr.flatMap([s0 - 1, s0], (from) =>
							Arr.flatMap([e0, e0 + 1], (to) =>
								from >= 0 &&
								to <= text.length &&
								boundary(from) &&
								boundary(to) &&
								Str.slice(from, to)(text) === read.text
									? [{ from, to }]
									: []
							)
						)
						const span = spans[0]
						assert.ok(
							span !== undefined,
							`the window is its text's run from the context before the difference to the context after it: ${Formatter.format(window)}`
						)
						assert.equal(
							read.before,
							span.from > 0,
							"an ellipsis before exactly where the window is cut"
						)
						assert.equal(
							read.after,
							span.to < text.length,
							"an ellipsis after exactly where the window is cut"
						)
						if (read.before) {
							c.note("a window cut before")
						}
						if (read.after) {
							c.note("a window cut after")
						}
						if (holdsInvisible(read.text)) {
							c.note("a control character in a window")
						}
						if (Str.includes("\\")(read.text)) {
							c.note("a backslash in a window")
						}
					}
					if (a[differs] === "\r" || b[differs] === "\r") {
						c.note("a carriage return at the difference")
					}
					if (Arr.some(Arr.take(a, differs), (ch) => ch.length === 2)) {
						c.note("an astral character before the difference")
					}
					if (differs === a.length || differs === b.length) {
						c.note("one text a prefix of the other")
					}
				}),
		oracle: {
			kind: "second-implementation",
			name: "the host's reading of both texts by code points and of the escapes, as PostgreSQL's escape strings read them"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/escape.ts",
				original: "escaped(text.slice(start, end))",
				replacement: "text.slice(start, end)",
				why: "A window shows its text raw, as the drift report printed both descriptions before 1fc5a519, so a carriage return moves the cursor and the two windows read alike."
			},
			{
				file: "packages/engine/src/sql/escape.ts",
				original: "\t\tat: charactersIn(first, d) + 1,",
				replacement: "\t\tat: charactersIn(first, d),",
				why: "The difference is named one character early."
			},
			{
				file: "packages/engine/src/sql/escape.ts",
				original: "\treturn d > 0 && isHighSurrogate(a.charCodeAt(d - 1)) ? d - 1 : d",
				replacement: "\treturn d",
				why: "Two astral characters that share a first surrogate are found apart at their second, so the difference is named one character late and a window may split the pair."
			}
		]
	})
