import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import {
	array,
	characterOf,
	codePoint,
	constant,
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
import { lex, type Lexed, type Token } from "#compiler/sql/lexer.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { assert, nonEmpty } from "#test/support/assert.ts"
import { statementGen } from "#test/support/kernel/sqlgen.ts"
import { caseHang } from "#test/support/limits.ts"
import { sqlCatalog } from "#test/unit/sql/audit/catalog.ts"
import { scan } from "#test/unit/sql/scan.ts"

/**
 * The PostgreSQL lexer the text audit and the migration file's statement splitter run on (sql/lexer.ts): it is the
 * audit's eyes, so a token it misreads is a construct the audit cannot see. The oracle is PostgreSQL's own scanner,
 * scan.l transcribed rule by rule apart from the lexer (test/unit/sql/scan.ts): the lexer reads every text as the
 * scanner does, each token's kind, content and offset, and the offset of the error it stops at.
 *
 * - Every text of up to three characters over the characters the scanner's rules branch on, and every run of up to
 *   three tokens and separators written edge to edge, lex as the scanner reads them: the boundaries between tokens.
 * - Generated token sequences of every kind, written apart by whitespace and comments (nested block comments
 *   included), lex as the scanner reads them and back to the tokens drawn, each at the offset it was written at; an
 *   operator's run lexes as the scanner cuts it by its trailing + and - rule. A sequence whose last quoted token loses
 *   its closing quote is reported unterminated at that token's offset.
 * - Every statement the kernel's generator draws (sqlgen.ts statementGen), printed, lexes as the scanner reads it, with
 *   no error.
 */

/** A lexed text's tokens and the offset of its error: what the lexer and the scanner must agree on. */
const readOf = (lexed: Lexed) => ({ tokens: lexed.tokens, error: lexed.error?.offset })

/** The lexer reads `text` exactly as PostgreSQL's scanner does. */
const asScanned = (text: string): void => {
	assert.deepEqual(readOf(lex(text)), readOf(scan(text)), Formatter.format(text))
}

/** The kind of token a rendering draws: what a case reached. */
type RenderedKind =
	| "word"
	| "quotedIdent"
	| "string"
	| "prefixed string"
	| "escape string"
	| "dollar"
	| "param"
	| "number"
	| "non-decimal number"
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

/** The ASCII letters, either case. */
const asciiLetters: Arr.NonEmptyReadonlyArray<string> = [
	...Arr.map(Arr.range(0x41, 0x5a), (point) => String.fromCodePoint(point)),
	...Arr.map(Arr.range(0x61, 0x7a), (point) => String.fromCodePoint(point))
]

/** An identifier's first character: an ASCII letter, an underscore, or a character past ASCII, which scan.l admits. */
const identStart: Gen<string> = weighted([
	[6, characterOf(asciiLetters)],
	[1, constant("_")],
	[2, oneOf([codePoint(0xa0, 0xd7ff), codePoint(0xe000, 0xfffd), codePoint(0x1_0000, 0x10_ffff)])]
])

/** A character an identifier continues with: a letter, a digit, an underscore, a dollar, or one past ASCII. */
const identCont: Gen<string> = weighted([
	[6, characterOf(asciiLetters)],
	[3, matching(regex("^[0-9_$]$"))],
	[1, codePoint(0xa0, 0xd7ff)]
])

/** A word: no prefixed string, since what follows it is a separator, never a quote. */
const word: Gen<Rendered> = (source) => {
	const text =
		source.draw(identStart) + Arr.join(source.draw(array(identCont, { min: 0, max: 6 })), "")
	return { text, expected: [`w:${upperAscii(text)}`], closing: undefined, kind: "word" }
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
		[1, element(["é", "\u{1f44d}\u{1f3fd}", "\u{1f1eb}\u{1f1f7}", "\u{1f469}‍\u{1f467}"] as const)]
	])

/** Quoted content: up to eight graphemes, never NUL. */
const content = string(grapheme(printableAscii), { min: 0, max: 8 })

/** Contents the lexer branches on inside quotes: a doubled quote, a comment opener, a dollar quote, a keyword. */
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
	grapheme(
		nonEmpty(
			Arr.filter(printableAscii, (c) => c !== "'" && c !== "\\"),
			"a character"
		)
	),
	{ min: 0, max: 8 }
)

/** A bit or hexadecimal string's digits, an N or U& string's unescaped content: each read as written. */
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

/**
 * An escape string: its content with each backslash and quote escaped by a backslash, which the lexer keeps as
 * written, so its token's content is the escaped text.
 */
const escapeString: Gen<Rendered> = map(content, (s): Rendered => {
	const escaped = Str.replaceAll("'", "\\'")(Str.replaceAll("\\", "\\\\")(s))
	return {
		text: `E'${escaped}'`,
		expected: [`sE:${escaped}`],
		closing: undefined,
		kind: "escape string"
	}
})

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

/** Up to three groups of one to three digits of a class, joined by single underscores (scan.l decinteger). */
const digitGroups = (digits: Gen<string>): Gen<string> =>
	map(array(string(digits, { min: 1, max: 3 }), { min: 1, max: 3 }), (groups) =>
		Arr.join(groups, "_")
	)

const decimalDigit = matching(regex("^[0-9]$"))

/**
 * A decimal number of scan.l's grammar: digit groups, or a fraction after them or alone, each maybe with an exponent.
 */
const decimal: Gen<Rendered> = (source) => {
	const integer = source.draw(digitGroups(decimalDigit))
	const mantissa = source.draw(
		element([
			integer,
			`${integer}.`,
			`${integer}.${source.draw(digitGroups(decimalDigit))}`,
			`.${source.draw(digitGroups(decimalDigit))}`
		])
	)
	const exponent = source.draw(
		oneOf([
			constant(""),
			map(
				(s) =>
					[
						s.draw(element(["e", "E"] as const)),
						s.draw(element(["", "+", "-"] as const)),
						s.draw(digitGroups(decimalDigit))
					] as const,
				([marker, sign, digits]) => `${marker}${sign}${digits}`
			)
		])
	)
	const text = `${mantissa}${exponent}`
	return { text, expected: [`n:${text}`], closing: undefined, kind: "number" }
}

/** A hexadecimal, octal or binary integer, an underscore maybe before its first digit (scan.l hexinteger and kin). */
const nonDecimal: Gen<Rendered> = (source) => {
	const [letter, digits] = source.draw(
		element([
			["x", matching(regex("^[0-9a-fA-F]$"))],
			["X", matching(regex("^[0-9a-fA-F]$"))],
			["o", matching(regex("^[0-7]$"))],
			["b", matching(regex("^[01]$"))]
		] as const)
	)
	const text = `0${letter}${source.draw(element(["", "_"] as const))}${source.draw(digitGroups(digits))}`
	return { text, expected: [`n:${text}`], closing: undefined, kind: "non-decimal number" }
}

/** The characters an operator is made of (scan.l op_chars). */
const operatorChars: Arr.NonEmptyReadonlyArray<string> = Str.split("~!@#^&|`?+-*/%<>=", "")

/**
 * A run of operator characters that starts no comment, which the scanner cuts into the operators of its trailing + and
 * - rule: the oracle's cut is the expected one.
 */
const operator: Gen<Rendered> = map(
	filter(
		string(characterOf(operatorChars), { min: 1, max: 4 }),
		(run) => !Str.includes("--")(run) && !Str.includes("/*")(run),
		10
	),
	(text): Rendered => ({
		text,
		expected: Arr.map(scan(text).tokens, shape),
		closing: undefined,
		kind: "operator"
	})
)

/** Every punctuation token: scan.l's self characters that are no operator, and typecast, dot_dot and colon_equals. */
const punct: Gen<Rendered> = map(
	element(["(", ")", "[", "]", ",", ";", ".", ":", "::", "..", ":="] as const),
	(p): Rendered => ({ text: p, expected: [`p:${p}`], closing: undefined, kind: "punct" })
)

const tokenGen: Gen<Rendered> = oneOf([
	word,
	quotedIdent,
	plainString,
	prefixedString,
	escapeString,
	dollar,
	parameter,
	decimal,
	nonDecimal,
	operator,
	punct
])

/** Comment text, never a comment's end or a nested opener's characters: letters, quotes, dollars and a keyword. */
const commentText = string(element(["a", " ", "'", '"', "$$", "NULL", "-", "é"] as const), {
	min: 0,
	max: 4
})

/** What a separator is: whitespace, a line comment and what ends it, or a block comment, nested or not. */
type SeparatorKind =
	| "whitespace"
	| "a line comment ended by a line feed"
	| "a line comment ended by a lone carriage return"
	| "a block comment"
	| "a nested block comment"

interface Separator {
	readonly text: string
	readonly kind: SeparatorKind
}

/**
 * What separates two tokens: whitespace, or a comment between whitespace, so no two tokens run together. A line
 * comment ends at a line feed or at a lone carriage return (scan.l), and the token after it is read; a block comment
 * nests up to two deep.
 */
const separator: Gen<Separator> = oneOf<Separator>([
	map(
		string(element([" ", "\t", "\n", "\r", "\f", "\v"] as const), { min: 1, max: 3 }),
		(text): Separator => ({ text, kind: "whitespace" })
	),
	map(
		(s) => [s.draw(commentText), s.draw(element(["\n", "\r\n", "\r"] as const))] as const,
		([text, end]): Separator => ({
			text: ` --${text}${end}`,
			kind:
				end === "\r"
					? "a line comment ended by a lone carriage return"
					: "a line comment ended by a line feed"
		})
	),
	map(
		(s) => [s.draw(commentText), s.draw(commentText), s.draw(int(0, 2))] as const,
		([outer, inner, depth]): Separator => ({
			text: ` /*${outer}${Str.repeat(depth)("/*")}${inner}${Str.repeat(depth)("*/")}${outer}*/ `,
			kind: depth === 0 ? "a block comment" : "a nested block comment"
		})
	)
])

/** A token sequence: its first token, then each further token after the separator before it. */
interface Sequence {
	readonly first: Rendered
	readonly rest: ReadonlyArray<{ readonly separator: Separator; readonly token: Rendered }>
}

const sequenceGen: Gen<Sequence> = (source) => ({
	first: source.draw(tokenGen),
	rest: source.draw(
		array((step) => ({ separator: step.draw(separator), token: step.draw(tokenGen) }), {
			min: 0,
			max: 12
		})
	)
})

const tokensOf = (s: Sequence): Arr.NonEmptyReadonlyArray<Rendered> => [
	s.first,
	...Arr.map(s.rest, (step) => step.token)
]

const isString = (t: Rendered): boolean =>
	t.kind === "string" || t.kind === "prefixed string" || t.kind === "escape string"

/**
 * The text of a sequence, the offset each token starts at, and the kinds of the separators written. Two strings are
 * separated by a space alone: whitespace holding a newline between two string constants continues the first (scan.l),
 * which the boundary box holds.
 */
const render = (
	s: Sequence
): {
	readonly text: string
	readonly starts: ReadonlyArray<number>
	readonly separators: ReadonlyArray<SeparatorKind>
} => {
	let text = s.first.text
	let previous = s.first
	const starts: Array<number> = [0]
	const separators: Array<SeparatorKind> = []
	for (const { separator: between, token } of s.rest) {
		if (isString(previous) && isString(token)) {
			text += " "
		} else {
			text += between.text
			separators.push(between.kind)
		}
		starts.push(text.length)
		text += token.text
		previous = token
	}
	return { text, starts, separators }
}

/**
 * The characters scan.l's rules branch on: letters that begin a prefixed string or a base, e and E of an exponent, an
 * underscore and digits of each base, every quote, backslash and dollar, operator and punctuation characters, and the
 * whitespace that ends a line comment or continues a string, and one character past ASCII.
 */
const boundaryCharacters: Arr.NonEmptyReadonlyArray<string> = [
	"a",
	"E",
	"B",
	"x",
	"N",
	"U",
	"&",
	"_",
	"0",
	"1",
	"8",
	".",
	"'",
	'"',
	"\\",
	"$",
	"+",
	"-",
	"*",
	"/",
	"<",
	"=",
	"!",
	":",
	"(",
	" ",
	"\n",
	"\r",
	"é"
]

/**
 * Tokens and separators the box writes edge to edge: each kind's shortest spellings, the prefixes and bases of string
 * constants and numbers, the starts and ends of every quote and comment, the pairs of punctuation, and the whitespace
 * that continues a string.
 */
const boundaryAtoms: Arr.NonEmptyReadonlyArray<string> = [
	"a",
	"E",
	"U&",
	"'a'",
	"''",
	"E'\\'",
	"B'1'",
	'"a"',
	'""',
	"$$",
	"$a$",
	"$1",
	"1",
	"1_",
	".5",
	"1.",
	"e",
	"e+",
	"0x",
	"+",
	"-",
	"*/",
	"/*",
	"::",
	":",
	"=",
	".",
	" ",
	"\n"
]

type BoundaryFeature = "a token" | "two tokens" | "an error" | "a continued string"

/**
 * What a text the boxes lex reached: how many tokens the scanner reads, its error, and two quoted segments across a
 * newline read as one string constant.
 */
const boundaryFeatures = (text: string): ReadonlyArray<BoundaryFeature> => {
	const read = scan(text)
	const [only, ...others] = read.tokens
	return [
		...(read.tokens.length === 1 ? ["a token" as const] : []),
		...(read.tokens.length > 1 ? ["two tokens" as const] : []),
		...(read.error === undefined ? [] : ["an error" as const]),
		...(only?.kind === "string" && others.length === 0 && Str.includes("'\n'")(text)
			? ["a continued string" as const]
			: [])
	]
}

/** Up to `most` elements drawn from `items`, as one text. */
const joined = (items: Arr.NonEmptyReadonlyArray<string>, most: number): Gen<string> =>
	map(array(element(items), { min: 0, max: most }), (parts) => Arr.join(parts, ""))

type PrintedFeature = Token["kind"]

describe("lex", () => {
	it.effect(
		"reads every text of up to three boundary characters as PostgreSQL's scanner does",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/sql/lex-characters",
						generator: joined(boundaryCharacters, 3),
						literal: Formatter.format,
						/** 29 characters, up to three of them: 25,260 texts; the limit guards only against their growth. */
						limit: 30_000,
						box: "every text of up to three characters over the 29 that scan.l's rules branch on",
						oracle: { kind: "second-implementation", name: "scan.l's rules, transcribed apart" },
						coverage: requiredInSpace<BoundaryFeature>(["a token", "two tokens", "an error"]),
						caseHang
					},
					(text, c) =>
						Effect.sync(() => {
							asScanned(text)
							c.noteAll(boundaryFeatures(text))
						})
				)
			)
	)

	it.effect(
		"reads every run of up to three tokens and separators edge to edge as PostgreSQL's scanner does",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/sql/lex-boundaries",
						generator: joined(boundaryAtoms, 3),
						literal: Formatter.format,
						/** 29 atoms, up to three of them: 25,260 runs; the limit guards only against their growth. */
						limit: 30_000,
						box: "every run of up to three of 29 tokens and separators, written edge to edge",
						oracle: { kind: "second-implementation", name: "scan.l's rules, transcribed apart" },
						coverage: requiredInSpace<BoundaryFeature>([
							"a token",
							"two tokens",
							"an error",
							"a continued string"
						]),
						caseHang
					},
					(text, c) =>
						Effect.sync(() => {
							asScanned(text)
							c.noteAll(boundaryFeatures(text))
						})
				)
			)
	)

	it.effect(
		"reads every generated token sequence as the scanner does, each token back at the offset it was rendered at",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/sql/lex-round-trip",
						draw: drawn(sequenceGen),
						literal: Formatter.format,
						oracle: {
							kind: "second-implementation",
							name: "scan.l's rules, transcribed apart, and the tokens the sequence was rendered from"
						},
						coverage: required<RenderedKind | SeparatorKind>(
							[
								"word",
								"quotedIdent",
								"string",
								"prefixed string",
								"escape string",
								"dollar",
								"param",
								"number",
								"non-decimal number",
								"operator",
								"punct",
								"whitespace",
								"a line comment ended by a line feed",
								"a line comment ended by a lone carriage return",
								"a block comment",
								"a nested block comment"
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
							const { text, starts, separators } = render(s)
							c.noteAll(separators)
							asScanned(text)
							const lexed = lex(text)
							assert.equal(lexed.error, undefined, text)
							const tokens = tokensOf(s)
							assert.deepEqual(
								Arr.map(lexed.tokens, shape),
								Arr.flatMap(tokens, (token) => token.expected),
								text
							)
							/** Each rendered token begins where its first lexed token starts. */
							let at = 0
							for (const [i, token] of tokens.entries()) {
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
						oracle: {
							kind: "second-implementation",
							name: "scan.l's rules, transcribed apart, and the offset the truncated token was rendered at"
						},
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
							asScanned(truncated)
							assert.equal(lex(truncated).error?.offset, text.length + 1, truncated)
							c.note(last.kind)
						})
				)
			)
	)

	it.effect(
		"reads every statement the kernel's generator draws, printed, as the scanner does",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/sql/lex-printed",
						draw: drawn(statementGen(sqlCatalog)),
						literal: Formatter.format,
						oracle: { kind: "second-implementation", name: "scan.l's rules, transcribed apart" },
						coverage: required<PrintedFeature>(
							["word", "quotedIdent", "string", "number", "param", "operator", "punct"],
							{ cases: 100, sense: notesOnly }
						),
						kept: [],
						runs: 100,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(statement, c) =>
						Effect.sync(() => {
							const text = printStatement(statement)
							asScanned(text)
							const lexed = lex(text)
							assert.equal(lexed.error, undefined, text)
							c.noteAll(Arr.map(lexed.tokens, (t) => t.kind))
						})
				)
			)
	)
})
