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
 *
 * Plant (~/.cache/grizzle-release/BR06/plants): render-markers-crlf-kept (a line's carriage return kept, so a marker
 * line ending in CRLF reads as none).
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, boolean, constant, element, type Gen, map, weighted } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { regex } from "arkregex"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import { refusalText } from "#cli/refusals.ts"
import { markerLine } from "#cli/run.ts"
import {
	confirmMarker,
	findMarkers,
	isNoTransaction,
	noTransactionMarker,
	placeholderMarker
} from "#compiler/deploy/render/markers.ts"
import { placeholderToken } from "#compiler/sql/print.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

type MarkerFeature =
	| "a placeholder marker line"
	| "a confirm marker line"
	| "a token in a word"
	| "a token in a string spanning lines"
	| "a token in a quoted identifier"
	| "a token in a dollar-quoted body"
	| "a run PostgreSQL refuses"
	| "a token in a run PostgreSQL refuses"
	| "a token in a line comment, uncounted"
	| "a token in a line comment after a run PostgreSQL refuses, uncounted"
	| "a token in a block comment spanning lines, uncounted"
	| "a token in a nested block comment, uncounted"
	| "a token past an unterminated quote"
	| "a token past an unterminated block comment"
	| "a marker line inside a block comment"
	| "a file run statement by statement"
	| "a no-transaction marker below the first line"
	| "CRLF line ends"

/** A piece of a line's text, and whether a placeholder token in it counts. */
interface Piece {
	readonly text: string
	readonly counted: boolean
	readonly feature: MarkerFeature | undefined
}

/** A drawn file: its lines, each with whether it holds a counted token and the features it reaches. */
interface Line {
	readonly text: string
	readonly counted: boolean
	readonly features: ReadonlyArray<MarkerFeature>
}

/** A token, or none, in text that holds no quote, comment opener or semicolon of its own. */
const tokenOrNot: Gen<string> = element(["", placeholderToken, `x${placeholderToken}y`])

const plainWords = element([
	"SELECT 1",
	'ALTER TABLE "s"."t" ADD COLUMN "c" integer DEFAULT',
	"x = 2"
])

/** A piece of SQL a scanner reads, holding a counted token or not. */
const sqlPiece: Gen<Piece> = weighted<Piece>([
	[1, map(plainWords, (text) => ({ text, counted: false, feature: undefined }))],
	[
		1,
		map(element([placeholderToken, `a${placeholderToken}`, `${placeholderToken}9`]), (text) => ({
			text,
			counted: true,
			feature: "a token in a word"
		}))
	],
	[
		1,
		map(tokenOrNot, (inner) => ({
			text: `"q${inner}"`,
			counted: inner.length > 0,
			feature: inner.length > 0 ? "a token in a quoted identifier" : undefined
		}))
	],
	[
		1,
		map(tokenOrNot, (inner) => ({
			text: `'it''s ${inner}'`,
			counted: inner.length > 0,
			feature: undefined
		}))
	],
	[
		1,
		map(tokenOrNot, (inner) => ({
			text: `$x$ ${inner} $x$`,
			counted: inner.length > 0,
			feature: inner.length > 0 ? "a token in a dollar-quoted body" : undefined
		}))
	],
	[
		1,
		map(tokenOrNot, (inner) => ({
			text: `/* /* ${inner} */ ${inner} */`,
			counted: false,
			feature: inner.length > 0 ? "a token in a nested block comment, uncounted" : undefined
		}))
	],
	[
		1,
		map(element(['""', "1x", "$", "\\"]), (text) => ({
			text,
			counted: false,
			feature: "a run PostgreSQL refuses"
		}))
	],
	[
		1,
		map(constant(`1${placeholderToken}`), (text) => ({
			text,
			counted: true,
			feature: "a token in a run PostgreSQL refuses"
		}))
	]
])

/** Whether a piece is a run PostgreSQL's scanner reads whole and refuses. */
const refusedPiece = (p: Piece): boolean =>
	p.feature === "a run PostgreSQL refuses" || p.feature === "a token in a run PostgreSQL refuses"

const indent = element(["", "  ", "\t"])

/** A line of SQL pieces, maybe ending in a line comment that holds a token, which never counts. */
const sqlLine: Gen<Line> = (source) => {
	const pieces = source.draw(array(sqlPiece, { min: 1, max: 3 }))
	const comment = source.draw(element(["", " -- note", ` -- ${placeholderToken}`]))
	const text = `${source.draw(indent)}${Arr.join(
		Arr.map(pieces, (p) => p.text),
		" "
	)};${comment}`
	return {
		text,
		counted: Arr.some(pieces, (p) => p.counted),
		features: [
			...Arr.flatMap(pieces, (p) => (p.feature === undefined ? [] : [p.feature])),
			...(Str.includes(placeholderToken)(comment)
				? (["a token in a line comment, uncounted"] as const)
				: []),
			...(Str.includes(placeholderToken)(comment) && Arr.some(pieces, refusedPiece)
				? (["a token in a line comment after a run PostgreSQL refuses, uncounted"] as const)
				: [])
		]
	}
}

/** A marker line, of either kind, after its indentation, with what it says after the marker or nothing. */
const markerLineGen: Gen<Line> = (source) => {
	const placeholder = source.draw(boolean)
	const said = source.draw(element(["", ": supply the value", " a holder set aside"]))
	return {
		text: `${source.draw(indent)}${placeholder ? placeholderMarker : confirmMarker}${said}`,
		counted: false,
		features: [placeholder ? "a placeholder marker line" : "a confirm marker line"]
	}
}

/** Lines inside a construct that spans them: plain text, a token, or a marker line, never a closing quote or comment. */
const innerLines: Gen<ReadonlyArray<string>> = array(
	weighted([
		[3, element(["inside", "", `a ${placeholderToken} b`])],
		[1, map(markerLineGen, (l) => l.text)]
	]),
	{ min: 0, max: 2 }
)

/**
 * A construct spanning lines: a string constant, whose tokens count, or a block comment, whose tokens do not, each
 * between SQL before and after it on its first and last lines.
 */
const spanning: Gen<ReadonlyArray<Line>> = (source) => {
	const comment = source.draw(boolean)
	const open = comment ? "/*" : "'"
	const close = comment ? "*/" : "'"
	const before = source.draw(sqlPiece)
	const after = source.draw(sqlPiece)
	const first = source.draw(tokenOrNot)
	const inner = source.draw(innerLines)
	const last = source.draw(tokenOrNot)
	const inside = !comment
	const holds = (text: string) => inside && Str.includes(placeholderToken)(text)
	const feature: MarkerFeature = comment
		? "a token in a block comment spanning lines, uncounted"
		: "a token in a string spanning lines"
	const reached = (text: string): ReadonlyArray<MarkerFeature> =>
		Str.includes(placeholderToken)(text) ? [feature] : []
	return [
		{
			text: `${before.text} ${open}${first}`,
			counted: before.counted || holds(first),
			features: reached(first)
		},
		...Arr.map(inner, (text) => ({
			text,
			counted: holds(text),
			features: [
				...reached(text),
				...(comment &&
				(Str.startsWith(placeholderMarker)(Str.trimStart(text)) ||
					Str.startsWith(confirmMarker)(Str.trimStart(text)))
					? (["a marker line inside a block comment"] as const)
					: [])
			]
		})),
		{
			text: `${last}${close} ${after.text};`,
			counted: after.counted || holds(last),
			features: reached(last)
		}
	]
}

/** The file's end past an unterminated quote or block comment: every token from there counts, comment or not. */
const unterminated: Gen<ReadonlyArray<Line>> = (source) => {
	const opener = source.draw(element(["'", '"', "$y$", "/*"]))
	const before = source.draw(sqlPiece)
	const rest = source.draw(
		array(element(["tail", `-- ${placeholderToken}`, `/* ${placeholderToken} */`]), {
			min: 0,
			max: 2
		})
	)
	const feature: MarkerFeature =
		opener === "/*"
			? "a token past an unterminated block comment"
			: "a token past an unterminated quote"
	const reached = (text: string): ReadonlyArray<MarkerFeature> =>
		Str.includes(placeholderToken)(text) ? [feature] : []
	return [
		{ text: `${before.text} ${opener}`, counted: before.counted, features: [] },
		...Arr.map(rest, (text) => ({
			text,
			counted: Str.includes(placeholderToken)(text),
			features: reached(text)
		}))
	]
}

/** The first line: the no-transaction marker, maybe with trailing space, or a near miss of it, or a line of the body. */
const firstLineGen: Gen<ReadonlyArray<Line>> = weighted([
	[
		2,
		map(
			element([
				noTransactionMarker,
				`${noTransactionMarker}  `,
				`${noTransactionMarker}\t`,
				` ${noTransactionMarker}`,
				`${noTransactionMarker} x`,
				`SELECT 1; ${noTransactionMarker}`
			]),
			(text): ReadonlyArray<Line> => [{ text, counted: false, features: [] }]
		)
	],
	[1, constant([])]
])

interface File {
	readonly lines: ReadonlyArray<Line>
	readonly crlf: boolean
}

const fileGen: Gen<File> = (source) => {
	const first = source.draw(firstLineGen)
	const body = source.draw(
		array(
			weighted<ReadonlyArray<Line>>([
				[4, map(sqlLine, (l) => [l])],
				[2, map(markerLineGen, (l) => [l])],
				[2, spanning],
				[
					1,
					constant([
						{
							text: noTransactionMarker,
							counted: false,
							features: ["a no-transaction marker below the first line"]
						}
					])
				]
			]),
			{ min: 0, max: 4 }
		)
	)
	const tail = source.draw(
		weighted([
			[3, constant([])],
			[1, unterminated]
		])
	)
	return { lines: [...first, ...Arr.flatten(body), ...tail], crlf: source.draw(boolean) }
}

const textOf = (f: File): string =>
	Arr.join(
		Arr.map(f.lines, (l) => l.text),
		f.crlf ? "\r\n" : "\n"
	)

/** What the model reads of a line: a marker by its text, else a placeholder by a counted token. */
const markerOf = (line: Line): "placeholder" | "confirm" | undefined => {
	const text = Str.trimStart(line.text)
	if (Str.startsWith(placeholderMarker)(text) || line.counted) {
		return "placeholder"
	}
	return Str.startsWith(confirmMarker)(text) ? "confirm" : undefined
}

/** The no-transaction marker, then nothing but spaces, tabs or a carriage return. */
const noTransactionLine = regex("^-- grizzle: no-transaction[ \\t\\r]*$")

describe("a migration file's markers, generated", () => {
	it.effect(
		"are found on exactly the lines the model reads, generate prints each with its own kind's fix, and a file runs statement by statement exactly when its first line is the marker",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/deploy/markers",
						draw: drawn(fileGen),
						literal: Formatter.format,
						oracle: {
							kind: "second-implementation",
							name: "a file drawn as pieces whose scanner reading is known by construction, and the marker rules read line by line"
						},
						coverage: required<MarkerFeature>(
							[
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
							],
							{ cases: 600, sense: notesOnly }
						),
						kept: [],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(file, c) =>
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
								Arr.map(found, (m) =>
									markerLine("migrations/s/f", { file: "01-structure.sql", ...m })
								),
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
						})
				)
			)
	)
})
