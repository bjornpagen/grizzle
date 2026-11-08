import { describe, it } from "@effect/vitest"
import { drawn, explore, type Kept } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	constant,
	element,
	filter,
	type Gen,
	map,
	string,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import { splitStatements } from "#compiler/deploy/render/markers.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

const splitFeatures = [
	"a dollar-quote tag outside ASCII",
	"a run PostgreSQL refuses",
	"a block comment left open"
] as const
type SplitFeature = (typeof splitFeatures)[number]

/** A piece of a statement: its text, whether it makes the statement substantive (a comment does not), and what it
 * reaches.
 *
 * Splitting a no-transaction migration file into the statements that run one by one, generated: a file is drawn as
 * its statements, each a run of PostgreSQL tokens and comments joined by whitespace, so the split it must yield is
 * known. Every semicolon that is not a statement's end sits where PostgreSQL's scanner does not end a statement: in a
 * string constant (standard, with doubled quotes and backslashes that escape nothing, or E'' with backslash escapes),
 * a quoted identifier, a dollar-quoted body whose tag may be any identifier PostgreSQL allows (non-ASCII letters
 * among them), a line comment, or a nested block comment. Identifiers carry `$`, positional parameters appear beside
 * dollar quotes, and a piece that holds only comments and whitespace is no statement. A run the scanner reads whole
 * and refuses (an empty quoted identifier, junk after a number or a parameter, a base with no digit, a stray `$`, a
 * character no rule reads) is part of its statement, and the split goes on after it. Each statement keeps its leading
 * comments and loses its terminator; a file whose last statement opens a quote it never closes keeps the rest of the
 * file as that statement, and a block comment left open, nested or not, adds no statement of its own. */
interface Item {
	readonly text: string
	readonly substantive: boolean
	readonly reaches: ReadonlyArray<SplitFeature>
}

const token = (generator: Gen<string>): Gen<Item> =>
	map(generator, (text) => ({ text, substantive: true, reaches: [] }))

const comment = (generator: Gen<string>): Gen<Item> =>
	map(generator, (text) => ({ text, substantive: false, reaches: [] }))

/** Up to `max` parts joined: four reach every pair of tricky parts beside each other. */
const joined = (parts: Gen<string>, max: number): Gen<string> => string(parts, { min: 0, max })

/** What PostgreSQL never ends a statement inside, each holding what would end one outside. */
const tricky: Arr.NonEmptyReadonlyArray<string> = [
	"a",
	";",
	"--",
	"/*",
	"*/",
	"$$",
	"$x$",
	"'",
	'"',
	" ",
	"\n",
	"é"
]

/** The tricky parts but those `drop` names, which never names the first, and `more`. */
const trickyBut = (drop: ReadonlyArray<string>, more: ReadonlyArray<string>): Gen<string> =>
	element([
		Arr.headNonEmpty(tricky),
		...Arr.filter(Arr.tailNonEmpty(tricky), (p) => !drop.includes(p)),
		...more
	])

const wordGen = element([
	"SELECT",
	"CREATE",
	"INDEX",
	"x",
	"e",
	"E",
	"col$1",
	"a$b",
	"_t9",
	"función",
	"ß"
])
const numberGen = element(["1", "2.5", "1e3", ".5"])
const paramGen = element(["$1", "$12"])
const operatorGen = element(["+", "<>", "=", "-", "/", "*", "::", "(", ")", ",", "."])
const stringGen = map(joined(trickyBut(["'"], ["''", "\\"]), 4), (s) => `'${s}'`)

const escapedGen: Gen<string> = (source) => {
	const prefix = source.draw(element(["E", "e"]))
	const s = source.draw(joined(trickyBut(["'"], ["''", "\\'", "\\\\"]), 4))
	return `${prefix}'${s}'`
}

const quotedGen = map(joined(trickyBut(['"'], ['""']), 4), (s) => `"${s}"`)

/** A dollar quote's tag, and what it reaches: one outside ASCII reaches its feature. */
interface Tag {
	readonly text: string
	readonly reaches: ReadonlyArray<SplitFeature>
}

const tagGen: Gen<Tag> = weighted([
	[4, map(element(["", "x", "tag", "_b1"]), (text): Tag => ({ text, reaches: [] }))],
	[
		2,
		map(element(["función", "ß"]), (text): Tag => ({
			text,
			reaches: ["a dollar-quote tag outside ASCII"]
		}))
	]
])

const dollarGen: Gen<Item> = map(
	filter(
		(source) => {
			const tag = source.draw(tagGen)
			return {
				close: `$${tag.text}$`,
				reaches: tag.reaches,
				body: source.draw(joined(element(Arr.appendAll(tricky, ["$", "$y$"])), 4))
			}
		},
		({ close, body }) =>
			Option.exists(Str.indexOf(close)(`${body}${close}`), (at) => at === body.length),
		10
	),
	({ close, body, reaches }): Item => ({
		text: `${close}${body}${close}`,
		substantive: true,
		reaches
	})
)

/** A run PostgreSQL's scanner reads whole and refuses, whitespace after it: an empty quoted identifier, plain or
 * Unicode; a number or a parameter an identifier runs on from; a base with no digit of its own; a `$` that opens no
 * dollar quote, alone or before a word; and a character no rule reads. */
const refusedGen: Gen<Item> = map(
	element(['""', 'U&""', "1x", "1e", "0x", "0b2", "$1a", "$", "$x", "\\", "{"]),
	(text): Item => ({ text, substantive: true, reaches: ["a run PostgreSQL refuses"] })
)

const lineCommentGen = map(joined(trickyBut(["\n"], []), 4), (s) => `--${s}\n`)

const blockCommentGen = map(
	joined(trickyBut(["/*", "*/"], ["/* inner ; */"]), 3),
	(s) => `/*${s}*/`
)

const itemGen: Gen<Item> = weighted([
	[4, token(wordGen)],
	[1, token(numberGen)],
	[1, token(paramGen)],
	[2, token(operatorGen)],
	[2, token(stringGen)],
	[2, token(escapedGen)],
	[2, token(quotedGen)],
	[2, dollarGen],
	[2, refusedGen],
	[2, comment(lineCommentGen)],
	[2, comment(blockCommentGen)]
])

const spaceGen = element([" ", "\n", "\t", "  "])

/** A statement's text, whether it is one, and what it reaches: its items, each followed by whitespace. */
const pieceGen: Gen<Item> = map(
	array((source) => [source.draw(itemGen), source.draw(spaceGen)] as const, { min: 0, max: 5 }),
	(items) => ({
		text: Arr.join(
			Arr.map(items, ([item, space]) => `${item.text}${space}`),
			""
		),
		substantive: Arr.some(items, ([item]) => item.substantive),
		reaches: Arr.flatMap(items, ([item]) => item.reaches)
	})
)

/** A quote the last statement opens and never closes, which it takes the rest of the file into; or a block comment,
 * nested or not, left open, which is no statement. */
const unterminatedGen: Gen<Item> = weighted([
	[4, token(element(["'it ; is", '"a ; b', "E'\\' ; x", "$q$ ; body"]))],
	[
		1,
		map(element(["/* ; x", "/* a /* b */ ; c"]), (text): Item => ({
			text,
			substantive: false,
			reaches: ["a block comment left open"]
		}))
	]
])

/** A file: its statements, each with the whitespace after its terminator, whether the last is terminated, and the
 * quote or comment it may open and never close. */
interface SplitFile {
	readonly pieces: ReadonlyArray<readonly [Item, string]>
	readonly terminated: boolean
	readonly unterminated: Item | null
}

const fileGen: Gen<SplitFile> = (source) => ({
	pieces: source.draw(
		array((inner) => [inner.draw(pieceGen), inner.draw(spaceGen)] as const, { min: 1, max: 4 })
	),
	terminated: source.draw(boolean),
	unterminated: source.draw(
		weighted<Item | null>([
			[1, constant(null)],
			[3, unterminatedGen]
		])
	)
})

const keptSplits: ReadonlyArray<Kept<SplitFile, SplitFeature>> = [
	{
		note: "a dollar quote tagged ß split at its semicolon",
		sketch: {
			pieces: [
				[
					{ text: "$ß$$ß$ ", substantive: true, reaches: ["a dollar-quote tag outside ASCII"] },
					" "
				],
				[{ text: "", substantive: false, reaches: [] }, " "]
			],
			terminated: false,
			unterminated: null
		},
		draws: "",
		reaches: ["a dollar-quote tag outside ASCII"]
	},
	{
		note: "an empty quoted identifier ends no reading: its statement ends at the semicolon after it",
		sketch: {
			pieces: [[{ text: '"" ', substantive: true, reaches: ["a run PostgreSQL refuses"] }, " "]],
			terminated: true,
			unterminated: null
		},
		draws: "",
		reaches: ["a run PostgreSQL refuses"]
	}
]

describe("splitting a no-transaction file into its statements, generated", () => {
	it.effect("splits exactly at the semicolons that end statements", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "second-implementation",
						name: "a file drawn as its statements, whose split is known by construction"
					},
					suite: "unit/deploy/split",
					draw: drawn(fileGen),
					literal: Formatter.format,
					coverage: required<SplitFeature>(splitFeatures, { cases: 500, sense: notesOnly }),
					kept: keptSplits,
					runs: 500,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				({ pieces, terminated, unterminated }, c) =>
					Effect.sync(() => {
						c.noteAll(Arr.flatMap(pieces, ([piece]) => piece.reaches))
						c.noteAll(unterminated === null ? [] : unterminated.reaches)
						const texts = Arr.map(pieces, ([piece, space], i) =>
							i < pieces.length - 1 || terminated ? `${piece.text};${space}` : piece.text
						)
						const expected = Arr.map(
							Arr.filter(pieces, ([piece]) => piece.substantive),
							([piece]) => Str.trim(piece.text)
						)
						const text =
							unterminated === null
								? Arr.join(texts, "")
								: `${Arr.join(texts, "")}${unterminated.text}`
						if (unterminated !== null) {
							/** The unclosed quote or comment takes the rest of the file into the statement it is in, which
							 * is one when the quote or that statement's text before it is. */
							const last = pieces.at(-1)
							const continues = !terminated && last?.[0].substantive === true
							const open =
								terminated || last === undefined
									? unterminated.text
									: `${last[0].text}${unterminated.text}`
							if (continues) {
								expected.pop()
							}
							if (continues || unterminated.substantive) {
								expected.push(Str.trim(open))
							}
						}
						assert.deepEqual(splitStatements(text), expected, Formatter.format(text))
					})
			)
		)
	)
})
