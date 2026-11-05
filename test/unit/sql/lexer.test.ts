import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	characterOf,
	codePoint,
	element,
	filter,
	type Gen,
	int,
	map,
	oneOf,
	string,
	weighted
} from "@grizzle/testing/gen"
import { matching } from "@grizzle/testing/pattern"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { regex } from "arkregex"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { lex, type Token } from "#compiler/sql/lexer.ts"
import { assert, nonEmpty } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

/**
 * The PostgreSQL lexer the text audit runs on (scan.l token rules): it is the audit's eyes, so a token it misreads is
 * a construct the audit cannot see.
 *
 * Generated token sequences of every kind, rendered with whitespace and comments (nested block comments included)
 * between them, lex back to the same tokens, each starting at the offset it was rendered at. Operators follow scan.l's
 * trailing + and - rule: an operator spelling lexes as the tokens the rule splits it into. A sequence whose last quoted
 * token loses its closing quote is reported unterminated at that token's offset.
 *
 * The kind of token a rendering draws: what a case reached.
 */
type RenderedKind =
	| "word"
	| "quotedIdent"
	| "string"
	| "prefixed string"
	| "dollar"
	| "param"
	| "number"
	| "operator"
	| "punct"

/** A token as the lexer must read it, and its rendering. */
interface Rendered {
	readonly text: string
	readonly expected: ReadonlyArray<string>
	/** The closing a truncation removes, when the token is quoted and its contents do not hold the closing. */
	readonly closing: string | undefined
	readonly kind: RenderedKind
}

const upperAscii = (text: string): string =>
	Arr.join(
		Arr.map(Str.split(text, ""), (c) => (c >= "a" && c <= "z" ? Str.toUpperCase(c) : c)),
		""
	)

const shape = (t: Token): string => {
	switch (t.kind) {
		case "word":
			return `w:${t.upper}`
		case "quotedIdent":
			return `q:${t.text}`
		case "string":
			return t.prefix === undefined ? `s:${t.text}` : `s${t.prefix}:${t.text}`
		case "dollar":
			return `d${t.tag}:${t.body}`
		case "param":
			return `$${t.index}`
		case "number":
			return `n:${t.text}`
		case "operator":
			return `o:${t.text}`
		case "punct":
			return `p:${t.text}`
	}
}

const word: Gen<Rendered> = (source) => {
	const head = source.draw(
		element(["a", "Z", "_", "ü", "select", "NULL", "coalesce", "is"] as const)
	)
	const tail = source.draw(matching(regex("^[a-z0-9_$]{0,6}$")))
	return {
		text: head + tail,
		expected: [`w:${upperAscii(head + tail)}`],
		closing: undefined,
		kind: "word"
	}
}

/** The printable ASCII characters, quotes, backslash and dollar among them. */
const printableAscii: Arr.NonEmptyReadonlyArray<string> = [
	" ",
	...Arr.map(Arr.range(0x21, 0x7e), (point) => String.fromCodePoint(point))
]

/**
 * One grapheme of quoted content, never NUL: printable ASCII most often, since quotes, backslashes and dollars are
 * what the lexer reads, then a scalar of the rest of the Basic Multilingual Plane, an astral scalar, or a grapheme of
 * several code points.
 */
const grapheme = (ascii: Arr.NonEmptyReadonlyArray<string>): Gen<string> =>
	weighted([
		[4, characterOf(ascii)],
		[2, oneOf([codePoint(0xa0, 0xd7ff), codePoint(0xe000, 0xfffd)])],
		[1, codePoint(0x1_0000, 0x10_ffff)],
		[
			1,
			element([
				"e\u0301",
				"\u{1f44d}\u{1f3fd}",
				"\u{1f1eb}\u{1f1f7}",
				"\u{1f469}\u200d\u{1f467}"
			] as const)
		]
	])

/** Quoted content: up to eight graphemes, never NUL. */
const content = string(grapheme(printableAscii), { min: 0, max: 8 })

const quotedIdent: Gen<Rendered> = map(
	oneOf([
		string(grapheme(printableAscii), { min: 1, max: 8 }),
		element(['a"b', '""', "NULL", "-- x", "/* x"] as const)
	]),
	(s): Rendered => ({
		text: `"${Str.replaceAll('"', '""')(s)}"`,
		expected: [`q:${s}`],
		closing: Str.includes('"')(s) ? undefined : '"',
		kind: "quotedIdent"
	})
)

const plainString: Gen<Rendered> = map(
	oneOf([content, element(["it's", "''", "NULL", "-- x", "$$"] as const)]),
	(s): Rendered => ({
		text: `'${Str.replaceAll("'", "''")(s)}'`,
		expected: [`s:${s}`],
		closing: Str.includes("'")(s) ? undefined : "'",
		kind: "string"
	})
)

/** Content an N or U& string holds unescaped: no quote and no backslash. */
const unescaped = string(
	grapheme(nonEmpty(Arr.filter(printableAscii, (c) => c !== "'" && c !== "\\"))),
	{ min: 0, max: 8 }
)

const prefixedString: Gen<Rendered> = map(
	oneOf<readonly ["B" | "X" | "N" | "U&", string]>([
		map(matching(regex("^[01]{0,8}$")), (s) => ["B", s] as const),
		map(matching(regex("^[0-9a-f]{0,8}$")), (s) => ["X", s] as const),
		map(unescaped, (s) => ["N", s] as const),
		map(unescaped, (s) => ["U&", s] as const)
	]),
	([prefix, s]): Rendered => ({
		text: `${prefix}'${s}'`,
		expected: [`s${prefix}:${s}`],
		closing: undefined,
		kind: "prefixed string"
	})
)

/** A dollar-quoted string whose body neither holds its delimiter nor ends in a dollar, drawn again until it does not. */
const dollar: Gen<Rendered> = map(
	filter(
		(source) =>
			[
				source.draw(element(["", "gz", "gz1", "x_"] as const)),
				source.draw(oneOf([content, element([" a $ b ", "$$", "'", "-- x", "$gz$"] as const)]))
			] as const,
		([tag, body]) => !Str.includes(`$${tag}$`)(body) && !Str.endsWith("$")(body),
		10
	),
	([tag, body]): Rendered => ({
		text: `$${tag}$${body}$${tag}$`,
		expected: [`d$${tag}$:${body}`],
		closing: `$${tag}$`,
		kind: "dollar"
	})
)

const parameter: Gen<Rendered> = map(int(1, 99_999), (n): Rendered => ({
	text: `$${n}`,
	expected: [`$${n}`],
	closing: undefined,
	kind: "param"
}))

const numberToken: Gen<Rendered> = map(
	element(["0", "12", "1.5", ".5", "1e3", "1.5e-3", "2E+10", "007"] as const),
	(n): Rendered => ({ text: n, expected: [`n:${n}`], closing: undefined, kind: "number" })
)

/**
 * Operator spellings and the tokens scan.l splits them into: an operator may end in + or - only when it holds one of
 * ~ ! @ # % ^ & | ` ?.
 */
const operatorSpellings: Arr.NonEmptyReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
	["=", ["o:="]],
	["<>", ["o:<>"]],
	["<=", ["o:<="]],
	["||", ["o:||"]],
	["@>", ["o:@>"]],
	["&&", ["o:&&"]],
	["-|-", ["o:-|-"]],
	["@-", ["o:@-"]],
	["=-", ["o:=", "o:-"]],
	["<+", ["o:<", "o:+"]],
	["*", ["o:*"]],
	["~~", ["o:~~"]]
]

const operator: Gen<Rendered> = map(element(operatorSpellings), ([text, expected]): Rendered => ({
	text,
	expected,
	closing: undefined,
	kind: "operator"
}))

const punct: Gen<Rendered> = map(
	element(["(", ")", "[", "]", ",", ";", ".", "::"] as const),
	(p): Rendered => ({ text: p, expected: [`p:${p}`], closing: undefined, kind: "punct" })
)

const tokenGen: Gen<Rendered> = oneOf([
	word,
	quotedIdent,
	plainString,
	prefixedString,
	dollar,
	parameter,
	numberToken,
	operator,
	punct
])

/**
 * What separates two tokens: whitespace, or a comment between whitespace, so no two tokens run together. A line
 * comment ends at a line feed or at a lone carriage return (scan.l), and the token after it is read.
 */
const lineCommentToCarriageReturn = " -- NULL ' $$\r"
const separator = element([
	" ",
	"\n",
	"\t ",
	" -- NULL ' \" $$\n",
	lineCommentToCarriageReturn,
	" /* x /* NULL */ y */ ",
	"\r\n"
] as const)

interface Sequence {
	readonly tokens: Arr.NonEmptyReadonlyArray<Rendered>
	readonly separators: ReadonlyArray<string>
}

const sequenceGen: Gen<Sequence> = (source) => ({
	tokens: [source.draw(tokenGen), ...source.draw(array(tokenGen, { min: 0, max: 12 }))],
	separators: source.draw(array(separator, { min: 13, max: 13 }))
})

const isString = (t: Rendered | undefined): boolean =>
	t?.kind === "string" || t?.kind === "prefixed string"

/**
 * The text of a sequence and the offset each token starts at. Two strings are separated by a space alone: whitespace
 * holding a newline between two string constants continues the first (scan.l), which is not what is drawn here.
 */
const render = (s: Sequence): { readonly text: string; readonly starts: ReadonlyArray<number> } => {
	let text = ""
	const starts: Array<number> = []
	for (const [i, t] of s.tokens.entries()) {
		if (i > 0) {
			text += isString(s.tokens[i - 1]) && isString(t) ? " " : (s.separators[i - 1] ?? " ")
		}
		starts.push(text.length)
		text += t.text
	}
	return { text, starts }
}

describe("lex", () => {
	it.effect(
		"reads every generated token sequence back, each token at the offset it was rendered at",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/sql/lex-round-trip",
						draw: drawn(sequenceGen),
						literal: Formatter.format,
						coverage: required<RenderedKind | "a line comment ended by a lone carriage return">(
							[
								"word",
								"quotedIdent",
								"string",
								"prefixed string",
								"dollar",
								"param",
								"number",
								"operator",
								"punct",
								"a line comment ended by a lone carriage return"
							],
							{ cases: 400, sense: notesOnly }
						),
						kept: [],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(s, c) =>
						Effect.sync(() => {
							const { text, starts } = render(s)
							if (Str.includes(lineCommentToCarriageReturn)(text)) {
								c.note("a line comment ended by a lone carriage return")
							}
							const lexed = lex(text)
							assert.equal(lexed.error, undefined, text)
							assert.deepEqual(
								Arr.map(lexed.tokens, shape),
								Arr.flatMap(s.tokens, (token) => token.expected),
								text
							)
							/** Each rendered token begins where its first lexed token starts. */
							let at = 0
							for (const [i, token] of s.tokens.entries()) {
								assert.equal(lexed.tokens[at]?.start, starts[i], `${token.kind} in ${text}`)
								at += token.expected.length
								c.note(token.kind)
							}
						})
				)
			)
	)

	it.effect(
		"reports a quoted token that lost its closing quote as unterminated, at its own offset",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/sql/lex-truncated",
						draw: drawn((source) => [source.draw(sequenceGen), source.draw(tokenGen)] as const),
						literal: Formatter.format,
						coverage: required<RenderedKind>(["quotedIdent", "string", "dollar"], {
							cases: 300,
							sense: notesOnly
						}),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([s, last], c) =>
						Effect.sync(() => {
							const closing = last.closing
							if (closing === undefined) {
								return
							}
							const { text } = render(s)
							const truncated = `${text} ${Str.slice(0, last.text.length - closing.length)(last.text)}`
							const lexed = lex(truncated)
							assert.equal(lexed.error?.offset, text.length + 1, truncated)
							c.note(last.kind)
						})
				)
			)
	)
})
