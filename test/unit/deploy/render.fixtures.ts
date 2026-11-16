/** What the properties of render.test.ts read: its spaces, models and helpers. */

import { array, boolean, constant, element, type Gen, map, weighted } from "@bjornpagen/testing/gen"
import { regex } from "arkregex"
import { Array as Arr, String as Str } from "effect"
import {
	confirmMarker,
	noTransactionMarker,
	placeholderMarker
} from "#compiler/deploy/render/markers.ts"
import { placeholderToken } from "#compiler/sql/print.ts"

export type MarkerFeature =
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

export const fileGen: Gen<File> = (source) => {
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

export const textOf = (f: File): string =>
	Arr.join(
		Arr.map(f.lines, (l) => l.text),
		f.crlf ? "\r\n" : "\n"
	)

/** What the model reads of a line: a marker by its text, else a placeholder by a counted token. */
export const markerOf = (line: Line): "placeholder" | "confirm" | undefined => {
	const text = Str.trimStart(line.text)
	if (Str.startsWith(placeholderMarker)(text) || line.counted) {
		return "placeholder"
	}
	return Str.startsWith(confirmMarker)(text) ? "confirm" : undefined
}

/** The no-transaction marker, then nothing but spaces, tabs or a carriage return. */
export const noTransactionLine = regex("^-- grizzle: no-transaction[ \\t\\r]*$")
