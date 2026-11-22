/** What the properties of split.test.ts read: its spaces, models and helpers. */

import { deepEquals, nonEmpty } from "@bjornpagen/testing/assert"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	string,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Option, String as Str } from "effect"
import type { StatementToken } from "#compiler/deploy/render/markers.ts"
import { placeholderToken } from "#compiler/sql/print.ts"

export const splitFeatures = [
	"a dollar-quote tag outside ASCII",
	"a run PostgreSQL refuses",
	"a block comment left open",
	"a semicolon inside parentheses",
	"a parenthesis left open",
	"a semicolon inside a BEGIN block",
	"a BEGIN block inside another",
	"a CASE inside a BEGIN block",
	"a routine opened by CREATE OR REPLACE",
	"a string continued across a newline",
	"an escape string continued across a newline",
	"an escaped quote ending an escape string's later segment"
] as const
export type SplitFeature = (typeof splitFeatures)[number]

/** A piece of a statement: its text, whether it makes the statement substantive (a comment does not), and what it
 * reaches.
 */
interface Item {
	readonly text: string
	readonly substantive: boolean
	readonly reaches: ReadonlyArray<SplitFeature>
}

/**
 * What an item is to quote continuation (scan.l quotecontinue: a string constant, then whitespace holding a newline and
 * maybe line comments, then a quote, continues the constant): a string constant that opens with its quote, one that
 * opens with a prefix, a line comment, which the continuation crosses and which ends in a newline, or anything else,
 * which ends it.
 */
type Continuation = "quote string" | "prefixed string" | "line comment" | "other"

/** An item as a join meets it (spaced). */
interface Part extends Item {
	readonly continuation: Continuation
}

const token = (generator: Gen<string>): Gen<Part> =>
	map(generator, (text) => ({ text, substantive: true, reaches: [], continuation: "other" }))

const comment = (generator: Gen<string>): Gen<Part> =>
	map(generator, (text) => ({ text, substantive: false, reaches: [], continuation: "other" }))

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
const operatorGen = element(["+", "<>", "=", "-", "/", "*", "::", ",", "."])
/** A standard string's content: its quote doubled, and a backslash that escapes nothing. */
const standardContent = joined(trickyBut(["'"], ["''", "\\"]), 4)
/** An escape string's content: its quote doubled or escaped, and a backslash escaped. */
const escapedContent = joined(trickyBut(["'"], ["''", "\\'", "\\\\"]), 4)

const stringGen = map(standardContent, (s) => `'${s}'`)

const escapedGen: Gen<string> = (source) =>
	`${source.draw(element(["E", "e"]))}'${source.draw(escapedContent)}'`

/** A string constant drawn as one item, and how a join meets it. */
const stringPart = (generator: Gen<string>, continuation: Continuation): Gen<Part> =>
	map(generator, (text) => ({ text, substantive: true, reaches: [], continuation }))

/** Whitespace that continues a string constant into the quote after it: a newline, maybe spaces and line comments. */
const continuationGen = element(["\n", " \n", "\n  ", " --c ;\n", "\n--c\n\t"])

/**
 * A string constant continued across a newline into one or two more segments, each read as its first segment is: a
 * standard string's with backslashes that escape nothing, an escape string's (E'') with backslash escapes, so a later
 * segment's `\'` before its closing quote is an escaped quote and the closing quote is the next.
 */
const continuedGen: Gen<Part> = (source) => {
	const escape = source.draw(boolean)
	const content = escape ? escapedContent : standardContent
	const first = source.draw(content)
	const later = source.draw(
		array((inner) => [inner.draw(continuationGen), inner.draw(content)] as const, {
			min: 1,
			max: 2
		})
	)
	const escapedQuoteEnds = escape && Arr.some(later, ([, segment]) => Str.endsWith("\\'")(segment))
	return {
		text: `${escape ? "E" : ""}'${first}'${Arr.join(
			Arr.map(later, ([between, segment]) => `${between}'${segment}'`),
			""
		)}`,
		substantive: true,
		reaches: escape
			? [
					"an escape string continued across a newline",
					...(escapedQuoteEnds
						? (["an escaped quote ending an escape string's later segment"] as const)
						: [])
				]
			: ["a string continued across a newline"],
		continuation: escape ? "prefixed string" : "quote string"
	}
}

const quotedGen = map(joined(trickyBut(['"'], ['""']), 4), (s) => `"${s}"`)

/** A dollar quote's tag, and what it reaches: one outside ASCII reaches its feature. */
interface Tag {
	readonly text: string
	readonly reaches: ReadonlyArray<SplitFeature>
}

/** The dollar-quote tags a part draws among, the ASCII ones and those outside it, each equally often. */
const tags: ReadonlyArray<Tag> = [
	...Arr.map(["", "x", "tag", "_b1"], (text): Tag => ({ text, reaches: [] })),
	...Arr.map(["función", "ß"], (text): Tag => ({
		text,
		reaches: ["a dollar-quote tag outside ASCII"]
	}))
]

/**
 * A dollar-quoted part whose body never spells its own closing tag, by construction: the body is drawn first, and the tag
 * among those whose close first meets the body's end.
 */
const dollarGen: Gen<Part> = map(
	(source) => {
		const body = source.draw(joined(element(Arr.appendAll(tricky, ["$", "$y$"])), 4))
		const tag = source.draw(
			element(
				nonEmpty(
					Arr.filter(tags, (t) =>
						Option.exists(
							Str.indexOf(`$${t.text}$`)(`${body}$${t.text}$`),
							(at) => at === body.length
						)
					),
					"a tag the body does not spell"
				)
			)
		)
		return { close: `$${tag.text}$`, reaches: tag.reaches, body }
	},
	({ close, body, reaches }): Part => ({
		text: `${close}${body}${close}`,
		substantive: true,
		reaches,
		continuation: "other"
	})
)

/** A run PostgreSQL's scanner reads whole and refuses, whitespace after it: an empty quoted identifier, plain or
 * Unicode; a number or a parameter an identifier runs on from; a base with no digit of its own; a `$` that opens no
 * dollar quote, alone or before a word; and a character no rule reads. */
const refusedGen: Gen<Part> = map(
	element(['""', 'U&""', "1x", "1e", "0x", "0b2", "$1a", "$", "$x", "\\", "{"]),
	(text): Part => ({
		text,
		substantive: true,
		reaches: ["a run PostgreSQL refuses"],
		continuation: "other"
	})
)

const lineCommentGen: Gen<Part> = map(joined(trickyBut(["\n"], []), 4), (s) => ({
	text: `--${s}\n`,
	substantive: false,
	reaches: [],
	continuation: "line comment"
}))

const blockCommentGen = map(
	joined(trickyBut(["/*", "*/"], ["/* inner ; */"]), 3),
	(s) => `/*${s}*/`
)

const itemGen: Gen<Part> = weighted([
	[4, token(wordGen)],
	[1, token(numberGen)],
	[1, token(paramGen)],
	[2, token(operatorGen)],
	[2, stringPart(stringGen, "quote string")],
	[2, stringPart(escapedGen, "prefixed string")],
	[2, continuedGen],
	[2, token(quotedGen)],
	[2, dollarGen],
	[2, refusedGen],
	[2, lineCommentGen],
	[2, comment(blockCommentGen)]
])

const spaceGen = element([" ", "\n", "\t", "  "])

/**
 * How far a join has come toward continuing a string constant: past none, past one on its own line, or past one and a
 * newline, where a quote would continue it.
 */
type Reach = "none" | "string" | "string and newline"

/** The reach past a part: a string constant starts one, a line comment carries one past its newline. */
const reachPast = (reach: Reach, continuation: Continuation): Reach => {
	switch (continuation) {
		case "quote string":
		case "prefixed string":
			return "string"
		case "line comment":
			return reach === "none" ? "none" : "string and newline"
		case "other":
			return "none"
	}
}

/** The reach after a part, then the whitespace after it. */
const reachAfter = (reach: Reach, part: Part, space: string): Reach => {
	const after = reachPast(reach, part.continuation)
	return after === "string" && Str.includes("\n")(space) ? "string and newline" : after
}

/**
 * Up to `max` parts, each followed by whitespace, as one item: substantive when one of them is. A quote that would
 * continue a string constant drawn before it is set apart by an empty block comment, so each string drawn is the
 * constant PostgreSQL reads.
 */
const spaced = (parts: Gen<Part>, max: number): Gen<Item> =>
	map(
		array((source) => [source.draw(parts), source.draw(spaceGen)] as const, { min: 0, max }),
		(drawn) => {
			let text = ""
			let reach: Reach = "none"
			for (const [part, space] of drawn) {
				const apart =
					part.continuation === "quote string" && reach === "string and newline" ? "/**/" : ""
				text += `${apart}${part.text}${space}`
				reach = reachAfter(reach, part, space)
			}
			return {
				text,
				substantive: Arr.some(drawn, ([part]) => part.substantive),
				reaches: Arr.flatMap(drawn, ([part]) => part.reaches)
			}
		}
	)

/** A semicolon that ends no statement, and what it reaches. */
const innerSemicolon = (reached: SplitFeature): Gen<Part> =>
	constant<Part>({ text: ";", substantive: true, reaches: [reached], continuation: "other" })

/** Parentheses holding items, semicolons and, `depth` deep, parentheses again. */
const parenGen = (depth: number): Gen<Part> => {
	const semicolon = innerSemicolon("a semicolon inside parentheses")
	const inner: Gen<Part> =
		depth > 0
			? weighted([
					[4, itemGen],
					[2, semicolon],
					[1, (source) => source.draw(parenGen(depth - 1))]
				])
			: weighted([
					[4, itemGen],
					[2, semicolon]
				])
	return map(spaced(inner, 4), (held): Part => ({
		text: `( ${held.text})`,
		substantive: true,
		reaches: held.reaches,
		continuation: "other"
	}))
}

/** What a statement holds outside every parenthesis: items, parentheses, and a `)` that closes none. */
const outerItemGen: Gen<Part> = weighted([
	[10, itemGen],
	[2, parenGen(2)],
	[1, token(constant(")"))]
])

/** A plain statement: its items, each followed by whitespace. */
const plainGen: Gen<Item> = spaced(outerItemGen, 5)

/**
 * The body of a BEGIN block `depth` deep: items, semicolons that end no statement, and, deeper, BEGIN blocks and CASE
 * expressions, each ended by END.
 */
const blockBodyGen = (depth: number): Gen<Item> => {
	const semicolon = innerSemicolon("a semicolon inside a BEGIN block")
	const nested = (opener: "BEGIN" | "CASE", reached: SplitFeature): Gen<Part> =>
		map(
			(source) => source.draw(blockBodyGen(depth - 1)),
			(body): Part => ({
				text: `${opener} ${body.text}END`,
				substantive: true,
				reaches: [reached, ...body.reaches],
				continuation: "other"
			})
		)
	const part: Gen<Part> =
		depth > 0
			? weighted([
					[4, outerItemGen],
					[3, semicolon],
					[1, nested("BEGIN", "a BEGIN block inside another")],
					[1, nested("CASE", "a CASE inside a BEGIN block")]
				])
			: weighted([
					[4, outerItemGen],
					[3, semicolon]
				])
	return spaced(part, 4)
}

/** A routine whose body is a BEGIN ATOMIC block, CREATE [OR REPLACE] FUNCTION or PROCEDURE in any case. */
const routineGen: Gen<Item> = map(
	(source) =>
		[
			source.draw(
				weighted<Item>([
					[
						2,
						token(
							element(["CREATE FUNCTION f() RETURNS int LANGUAGE sql", "create procedure p(a int)"])
						)
					],
					[
						1,
						map(
							element([
								"CREATE OR REPLACE FUNCTION f(x text) RETURNS text",
								"Create Or Replace Procedure p()"
							]),
							(text): Item => ({
								text,
								substantive: true,
								reaches: ["a routine opened by CREATE OR REPLACE"]
							})
						)
					]
				])
			),
			source.draw(blockBodyGen(2)),
			source.draw(spaceGen)
		] as const,
	([opening, body, space]): Item => ({
		text: `${opening.text} BEGIN ATOMIC ${body.text}END${space}`,
		substantive: true,
		reaches: [...opening.reaches, ...body.reaches]
	})
)

/** A statement's text, whether it is one, and what it reaches: a plain statement, or a routine. */
const pieceGen: Gen<Item> = weighted([
	[4, plainGen],
	[1, routineGen]
])

/** A quote or a parenthesis the last statement opens and never closes, which it takes the rest of the file into, an
 * escape string continued into a segment whose only quote its backslash escapes among them; or a block comment, nested
 * or not, left open, which is no statement. */
const unterminatedGen: Gen<Item> = weighted([
	[4, token(element(["'it ; is", '"a ; b', "E'\\' ; x", "$q$ ; body"]))],
	[
		1,
		map(constant("( a ; b"), (text): Item => ({
			text,
			substantive: true,
			reaches: ["a parenthesis left open"]
		}))
	],
	[
		1,
		map(constant("( E''\n'\\' ) ; x"), (text): Item => ({
			text,
			substantive: true,
			reaches: ["an escape string continued across a newline"]
		}))
	],
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

export const fileGen: Gen<SplitFile> = (source) => ({
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

/** A drafted statement's token: one of the scanner's, or a placeholder the reviewer fills. */
type DraftToken =
	| { readonly kind: "hole" }
	| { readonly kind: "token"; readonly text: string; readonly is: TokenKind }

type TokenKind = "word" | "string" | "other"

/** The words a draft holds and a planted edit swaps in: none the placeholder, each its own in any case. */
const draftWords: Arr.NonEmptyReadonlyArray<string> = ["SELECT", "x", "col$1", "_t9", "función"]

/** A drafted token that is no placeholder. */
type ScannedToken = Extract<DraftToken, { readonly kind: "token" }>

const scannedTokenGen: Gen<ScannedToken> = weighted([
	[3, map(element(draftWords), (text): ScannedToken => ({ kind: "token", text, is: "word" }))],
	[2, map(stringGen, (text): ScannedToken => ({ kind: "token", text, is: "string" }))],
	[
		2,
		map(
			weighted([
				[1, numberGen],
				[1, paramGen],
				[1, operatorGen]
			]),
			(text): ScannedToken => ({ kind: "token", text, is: "other" })
		)
	]
])

const hole: DraftToken = { kind: "hole" }

const draftTokenGen: Gen<DraftToken> = weighted<DraftToken>([
	[7, scannedTokenGen],
	[2, constant(hole)]
])

/** What a reviewer fills a placeholder with: a value, its parentheses and brackets balanced. */
const fillGen = element(["1", "'v'", "(1, 2)", "f(a)", "ARRAY[1, 2]", "x + 1"])

/** A drafted statement, the fill of each of its placeholders, and the token a planted edit changes. */
interface Draft {
	readonly tokens: Arr.NonEmptyReadonlyArray<DraftToken>
	readonly fills: ReadonlyArray<string>
	readonly edited: number
}

/** A draft of drawn tokens, a fill for each, and any of its tokens edited. */
const anyDraftGen: Gen<Draft> = (source) => {
	const drafted = nonEmpty(
		source.draw(array(draftTokenGen, { min: 1, max: 6 })),
		"a draft's tokens"
	)
	return {
		tokens: drafted,
		fills: source.draw(array(fillGen, { min: drafted.length, max: drafted.length })),
		edited: source.draw(int(0, drafted.length - 1))
	}
}

/**
 * A draft whose edited token stands between two placeholders, the second filled by that token and a value after it:
 * bare, so the placeholders absorb the edit, the first taking its own fill and the edited token and the second the
 * value; or in parentheses, which only runs whose parentheses do not balance would absorb it across.
 */
const absorbingDraftGen: Gen<Draft> = (source) => {
	const before = source.draw(array(draftTokenGen, { min: 0, max: 2 }))
	const editedToken = source.draw(scannedTokenGen)
	const parenthesized = source.draw(boolean)
	const drafted = nonEmpty(
		[...before, hole, editedToken, hole, ...source.draw(array(draftTokenGen, { min: 0, max: 1 }))],
		"a draft's tokens"
	)
	const absorbing = before.length + 2
	return {
		tokens: drafted,
		fills: Arr.map(
			source.draw(array(fillGen, { min: drafted.length, max: drafted.length })),
			(fill, i) =>
				i !== absorbing
					? fill
					: parenthesized
						? `(${editedToken.text} ${fill})`
						: `${editedToken.text} ${fill}`
		),
		edited: before.length + 1
	}
}

export const draftGen: Gen<Draft> = weighted([
	[3, anyDraftGen],
	[1, absorbingDraftGen]
])

/** Another token in place of a drafted one: a word for another word, a string for another string, a word otherwise. */
export const editOf = (token: ScannedToken): string => {
	switch (token.is) {
		case "word":
			return Str.toUpperCase(token.text) === "SELECT" ? "x" : "SELECT"
		case "string":
			return `${token.text}'w'`
		case "other":
			return "x"
	}
}

/** A drafted statement's token as the second implementation reads it: the placeholder token a hole, any other itself. */
type Slot = { readonly kind: "hole" } | { readonly kind: "token"; readonly token: StatementToken }

const placeholderUpper = Str.toUpperCase(placeholderToken)

export const slotOf = (t: StatementToken): Slot =>
	t.kind === "word" && t.upper === placeholderUpper ? { kind: "hole" } : { kind: "token", token: t }

/** What a token does to the parentheses and brackets open: opens one, closes one, or neither. */
const nesting = (t: StatementToken): number => {
	if (t.kind !== "punct") {
		return 0
	}
	switch (t.text) {
		case "(":
		case "[":
			return 1
		case ")":
		case "]":
			return -1
		default:
			return 0
	}
}

/** The offsets a nonempty run of `written` from `at` a hole takes can end at. */
type RunEnds = (written: ReadonlyArray<StatementToken>, at: number) => ReadonlyArray<number>

/** Runs whose parentheses and brackets never close more than they opened and are all closed at their end. */
export const balancedRunEnds: RunEnds = (written, at) => {
	const ends: Array<number> = []
	let depth = 0
	for (const [n, t] of written.slice(at).entries()) {
		depth += nesting(t)
		if (depth < 0) {
			return ends
		}
		if (depth === 0) {
			ends.push(at + n + 1)
		}
	}
	return ends
}

/** Runs of any tokens. */
export const anyRunEnds: RunEnds = (written, at) => Arr.map(written.slice(at), (_, n) => at + n + 1)

/** The offsets a slot read from `at` can end at: a token slot past the same token, a hole past each run it takes. */
const slotEnds = (
	slot: Slot,
	written: ReadonlyArray<StatementToken>,
	at: number,
	runEnds: RunEnds
): ReadonlyArray<number> => {
	switch (slot.kind) {
		case "token":
			return deepEquals(written[at], slot.token) ? [at + 1] : []
		case "hole":
			return runEnds(written, at)
	}
}

/**
 * Whether some filling of a draft's holes, each by a run `runEnds` admits, is the written statement: the offsets each
 * prefix of the draft's slots can end at in the written tokens, carried forward slot by slot from the start, reach the
 * end.
 */
export const fillable = (
	slots: ReadonlyArray<Slot>,
	written: ReadonlyArray<StatementToken>,
	runEnds: RunEnds
): boolean => {
	let ends: ReadonlySet<number> = new Set([0])
	for (const slot of slots) {
		ends = new Set(
			Arr.flatMap(Arr.fromIterable(ends), (at) => slotEnds(slot, written, at, runEnds))
		)
	}
	return ends.has(written.length)
}

export type WrittenFeature =
	| "a placeholder filled"
	| "a word edited"
	| "a string edited"
	| "another token edited"
	| "a string kept"
	| "an edit the placeholders absorb"
	| "an edit only unbalanced runs absorb"
	| "a draft recorded by its digest, respelled as drafted"
	| "a draft recorded by its digest, edited"
