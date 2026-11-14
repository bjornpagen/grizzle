/**
 * The PostgreSQL lexer the text audit and the migration file's statement splitter run on (sql/lexer.ts): it is the
 * audit's eyes, so a token it misreads is a construct the audit cannot see. The oracle is PostgreSQL's own scanner,
 * scan.l transcribed rule by rule apart from the lexer (test/unit/sql/scan.ts): the lexer reads every text as the
 * scanner does, each lexeme's kind, content and offset, a refused run's extent among them, and the quote or comment it
 * never closes, and where; each semicolon that ends a statement where psql's scanner ends one (psqlscan.l, transcribed
 * beside scan.l), outside every parenthesis and every BEGIN block of a routine's body, is its terminator; and
 * PostgreSQL accepts the tokens before the first refusal (lex), every semicolon punctuation to it.
 *
 * - Every text of up to three characters over the characters the scanner's rules branch on, and every run of up to
 *   three tokens and separators written edge to edge, lex as the scanner reads them: the boundaries between tokens.
 * - Generated token sequences of every kind, written apart by whitespace and comments (nested block comments
 *   included), a string constant continued across newlines among them, its later segments read as its first, lex as
 *   the scanner reads them and back to the tokens drawn, each at the offset it was written at; an
 *   operator's run lexes as the scanner cuts it by its trailing + and - rule. A sequence whose last quoted token loses
 *   its closing quote is reported unterminated at that token's offset.
 * - Every statement the kernel's generator draws (sqlgen.ts statementGen), printed, lexes as the scanner reads it, with
 *   no error.
 * - Generated statements, CREATE [OR REPLACE] FUNCTION or PROCEDURE among them with BEGIN blocks, CASE expressions
 *   and parentheses nested in their bodies, semicolons inside each, and stray tokens of each kind between, end where
 *   psql's scanner ends them.
 *
 * Features: tokens, refused runs and what follows them, unclosed constructs, terminators and semicolons inside
 * parentheses; every token and separator kind; each statement kind ended.
 *
 * Plants, each failing its search: block comments that no longer nest (lexer-unnested, the round trip); an unclosed
 * construct reported one past its opening (lexer-unclosed-offset, the characters, the boundaries and the truncated
 * sequences); `::` read as two colons (lexer-cast-split, the printed statements); a semicolon inside parentheses ending
 * its statement (lexer-semicolon-parens, the statements).
 */
import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import {
	array,
	boolean,
	characterOf,
	codePoint,
	constant,
	element,
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
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import {
	type Lexed,
	type Lexeme,
	type Lexemes,
	lex,
	lexemesOf,
	type Token
} from "#compiler/sql/lexer.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { assert, nonEmpty } from "#test/support/assert.ts"
import { statementGen } from "#test/support/kernel/sqlgen.ts"
import { caseHang } from "#test/support/limits.ts"
import { sqlCatalog } from "#test/unit/sql/audit/catalog.ts"
import { scan } from "#test/unit/sql/scan.ts"

/** A text's lexemes, a refused run's message aside, and what it never closes: what the lexer and the scanner must
 * agree on. */
const readOf = (read: Lexemes) => ({
	lexemes: Arr.map(read.lexemes, (l) =>
		l.kind === "refused" ? { kind: l.kind, text: l.text, start: l.start } : l
	),
	unclosed: read.unclosed
})

/** The tokens before a reading's first refusal, and the offset of that refusal: what PostgreSQL accepts. */
const acceptedOf = (read: Lexemes) => {
	const tokens: Array<Token> = []
	for (const l of read.lexemes) {
		if (l.kind === "refused") {
			return { tokens, error: l.start }
		}
		tokens.push(l.kind === "terminator" ? { kind: "punct", text: ";", start: l.start } : l)
	}
	return { tokens, error: read.unclosed?.offset }
}

/** What lex reports: its tokens and the offset of its error. */
const lexedOf = (lexed: Lexed) => ({ tokens: lexed.tokens, error: lexed.error?.offset })

/** The lexer reads `text` exactly as PostgreSQL's scanner does, and accepts what the scanner accepts. */
const asScanned = (text: string): void => {
	const scanned = scan(text)
	assert.deepEqual(readOf(lexemesOf(text)), readOf(scanned), Formatter.format(text))
	assert.deepEqual(lexedOf(lex(text)), acceptedOf(scanned), Formatter.format(text))
}

/** The kind of token a rendering draws: what a case reached. */
type RenderedKind =
	| "word"
	| "quotedIdent"
	| "string"
	| "prefixed string"
	| "escape string"
	| "continued string"
	| "continued escape string"
	| "continued escape string ending in an escaped quote"
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

const shape = (t: Lexeme): string => {
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
		case "refused":
			return `r:${t.text}`
		case "terminator":
			return "t;"
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

/**
 * Whitespace that continues a string constant into the quote after it (scan.l quotecontinue): a line feed or a carriage
 * return, spaces and line comments before it, and spaces, newlines and line comments each ended by a newline after it.
 */
const continuation = element([
	" \n",
	"\n",
	"\r",
	"\r\n",
	" --c\n",
	"\n\t--c\n  ",
	"\t\n\n "
] as const)

/** A segment's content: quoted content, or a quote or a backslash, alone or last. */
const segmentContent = oneOf([content, element(["'", "\\", "it'", "a\\"] as const)])

/**
 * A string constant continued across a newline into one or two more segments, each read as its first segment is: a
 * standard string's quotes doubled, an escape string's backslashes and quotes escaped by a backslash, so a later
 * segment's escaped quote before its closing quote never closes it. The last segment may end in a quote, which an
 * escape string writes as that escaped quote. Its token's content is its segments' content, joined.
 */
const continuedString: Gen<Rendered> = (source) => {
	const escape = source.draw(boolean)
	const first = source.draw(segmentContent)
	const later = source.draw(
		array((inner) => [inner.draw(continuation), inner.draw(segmentContent)] as const, {
			min: 1,
			max: 2
		})
	)
	const quoteLast = source.draw(boolean)
	const written = (s: string): string =>
		escape
			? Str.replaceAll("'", "\\'")(Str.replaceAll("\\", "\\\\")(s))
			: Str.replaceAll("'", "''")(s)
	const segments = Arr.map(later, ([between, segment], i) => {
		const raw = quoteLast && i === later.length - 1 ? `${segment}'` : segment
		return { between, raw }
	})
	return {
		text: `${escape ? "E" : ""}'${written(first)}'${Arr.join(
			Arr.map(segments, ({ between, raw }) => `${between}'${written(raw)}'`),
			""
		)}`,
		expected: [
			`s${escape ? "E" : ""}:${Arr.join(
				Arr.map([first, ...Arr.map(segments, ({ raw }) => raw)], (raw) =>
					escape ? written(raw) : raw
				),
				""
			)}`
		],
		closing: "'",
		kind: escape
			? quoteLast
				? "continued escape string ending in an escaped quote"
				: "continued escape string"
			: "continued string"
	}
}

/**
 * A dollar-quoted string whose body neither holds its delimiter nor ends in a dollar, by construction: a body that ends
 * in a dollar takes a letter after it, and the tag is drawn among those whose delimiter the body does not hold.
 */
const dollar: Gen<Rendered> = map(
	(source) => {
		const drawnBody = source.draw(
			oneOf([content, element([" a $ b ", "$$", "'", "-- x", "$gz$"] as const)])
		)
		const body = Str.endsWith("$")(drawnBody) ? `${drawnBody}x` : drawnBody
		const tags = Arr.filter(
			["", "gz", "gz1", "x_"] as const,
			(tag) => !Str.includes(`$${tag}$`)(body)
		)
		return [source.draw(element(nonEmpty(tags, "a tag the body does not hold"))), body] as const
	},
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
 * A run of operator characters that starts no comment, by construction: no dash follows a dash and no star a slash.
 * The scanner cuts it into the operators of its trailing + and - rule: the oracle's cut is the expected one.
 */
const operator: Gen<Rendered> = map(
	(source) => {
		const length = source.draw(int(1, 4))
		let run = ""
		for (let at = 0; at < length; at += 1) {
			const previous = Str.slice(-1)(run)
			run += source.draw(
				characterOf(
					nonEmpty(
						Arr.filter(
							operatorChars,
							(ch) => !(previous === "-" && ch === "-") && !(previous === "/" && ch === "*")
						),
						"an operator character that opens no comment"
					)
				)
			)
		}
		return run
	},
	(text): Rendered => ({
		text,
		expected: Arr.map(scan(text).lexemes, shape),
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
	continuedString,
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
	t.kind === "string" ||
	t.kind === "prefixed string" ||
	t.kind === "escape string" ||
	t.kind === "continued string" ||
	t.kind === "continued escape string" ||
	t.kind === "continued escape string ending in an escaped quote"

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
 * The characters scan.l's and psqlscan.l's rules branch on: letters that begin a prefixed string or a base, e and E of
 * an exponent, an underscore and digits of each base, every quote, backslash and dollar, operator and punctuation
 * characters, the parentheses and the semicolon psql counts, the whitespace that ends a line comment or continues a
 * string, and one character past ASCII.
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
	")",
	";",
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

type BoundaryFeature =
	| "a token"
	| "two tokens"
	| "a refused run"
	| "a lexeme after a refused run"
	| "an unclosed construct"
	| "a continued string"
	| "a terminator"
	| "a semicolon inside parentheses"

/**
 * What a text the boxes lex reached: how many lexemes the scanner reads, a run it refuses and one it reads after that
 * run, a construct it never closes, two quoted segments across a newline read as one string constant, a statement's
 * terminator, and a semicolon psql reads inside parentheses, the only place a box of three reaches.
 */
const boundaryFeatures = (text: string): ReadonlyArray<BoundaryFeature> => {
	const read = scan(text)
	const [only, ...others] = read.lexemes
	const tokens = Arr.filter(read.lexemes, (l) => l.kind !== "refused")
	const refusal = Arr.findFirstIndex(read.lexemes, (l) => l.kind === "refused")
	return [
		...(tokens.length === 1 ? ["a token" as const] : []),
		...(tokens.length > 1 ? ["two tokens" as const] : []),
		...(Option.isSome(refusal) ? ["a refused run" as const] : []),
		...(Option.exists(refusal, (at) => at < read.lexemes.length - 1)
			? ["a lexeme after a refused run" as const]
			: []),
		...(read.unclosed === undefined ? [] : ["an unclosed construct" as const]),
		...(Arr.some(read.lexemes, (l) => l.kind === "terminator") ? ["a terminator" as const] : []),
		...(Arr.some(read.lexemes, (l) => l.kind === "punct" && l.text === ";")
			? ["a semicolon inside parentheses" as const]
			: []),
		...(only?.kind === "string" && others.length === 0 && Str.includes("'\n'")(text)
			? ["a continued string" as const]
			: [])
	]
}

/** Up to `most` elements drawn from `items`, as one text. */
const joined = (items: Arr.NonEmptyReadonlyArray<string>, most: number): Gen<string> =>
	map(array(element(items), { min: 0, max: most }), (parts) => Arr.join(parts, ""))

type PrintedFeature = Token["kind"]

const statementFeatures = [
	"a routine opened by CREATE OR REPLACE",
	"an opening that is no routine",
	"a semicolon inside parentheses",
	"a semicolon inside a BEGIN block",
	"a CASE inside a BEGIN block",
	"a BEGIN block inside another",
	"two statements"
] as const
type StatementFeature = (typeof statementFeatures)[number]

/** Text drawn, and what it reaches. */
interface Drawn {
	readonly text: string
	readonly reaches: ReadonlyArray<StatementFeature>
}

const drawnText = (text: string): Drawn => ({ text, reaches: [] })

/** What separates two parts: whitespace, a comment, or nothing, so a part may run into the next. */
const partSeparator = weighted([
	[2, constant(" ")],
	[1, constant("\n")],
	[1, constant("")],
	[1, constant("/**/")],
	[1, constant("--c\n")]
])

/** Parts, each after its separator. */
const partsText = (parts: ReadonlyArray<readonly [string, Drawn]>): Drawn => ({
	text: Arr.join(
		Arr.map(parts, ([between, part]) => `${between}${part.text}`),
		""
	),
	reaches: Arr.flatMap(parts, ([, part]) => part.reaches)
})

/**
 * A stray part: a word psql's scanner tracks, alone or spelled in another case, a parenthesis or a semicolon on its
 * own, a word that is no identifier to psql (U&), and quotes and comments that hide each of them.
 */
const strayGen: Gen<Drawn> = map(
	element([
		"x",
		"SELECT",
		"BEGIN",
		"begin",
		"CASE",
		"END",
		"end",
		"ATOMIC",
		"CREATE",
		"FUNCTION",
		"OR",
		"REPLACE",
		"PROCEDURE",
		"COPY",
		"(",
		")",
		";",
		"U&",
		"$",
		"'a;b)'",
		'"end"',
		"$$ ; ( $$",
		"/* ; ) */",
		"-- ;\n",
		"E'\\';'",
		"E''\n'\\';'",
		"[",
		"]"
	]),
	drawnText
)

/**
 * A body of up to four parts at `depth`, inside a BEGIN block or not: stray parts, a semicolon, parentheses holding a
 * body of their own, and, above depth 0, a BEGIN block or a CASE expression holding one, each ended by END.
 */
const bodyGen = (depth: number, inBlock: boolean): Gen<Drawn> => {
	const semicolon: Gen<Drawn> = constant({
		text: ";",
		reaches: inBlock ? ["a semicolon inside a BEGIN block"] : []
	})
	const parenthesized: Gen<Drawn> = map(
		(source) => source.draw(parenBodyGen(depth)),
		(inner): Drawn => ({ text: `(${inner.text})`, reaches: inner.reaches })
	)
	const block = (opener: "BEGIN" | "CASE"): Gen<Drawn> =>
		map(
			(source) => source.draw(bodyGen(depth - 1, true)),
			(inner): Drawn => ({
				text: `${opener} ${inner.text} END`,
				reaches: [
					...inner.reaches,
					...(inBlock
						? ([
								opener === "BEGIN" ? "a BEGIN block inside another" : "a CASE inside a BEGIN block"
							] as const)
						: [])
				]
			})
		)
	const part: Gen<Drawn> =
		depth > 0
			? weighted([
					[3, strayGen],
					[3, semicolon],
					[1, parenthesized],
					[2, block("BEGIN")],
					[1, block("CASE")]
				])
			: weighted([
					[3, strayGen],
					[3, semicolon],
					[1, parenthesized]
				])
	return map(
		array((source) => [source.draw(partSeparator), source.draw(part)] as const, { min: 0, max: 4 }),
		partsText
	)
}

/** What parentheses hold: stray parts and semicolons, each semicolon one psql reads inside them, and, above depth 0,
 * parentheses again. */
const parenBodyGen = (depth: number): Gen<Drawn> => {
	const semicolon = constant<Drawn>({ text: ";", reaches: ["a semicolon inside parentheses"] })
	const nested: Gen<Drawn> = map(
		(source) => source.draw(parenBodyGen(depth - 1)),
		(body): Drawn => ({ text: `(${body.text})`, reaches: body.reaches })
	)
	const inner: Gen<Drawn> =
		depth > 0
			? weighted([
					[3, strayGen],
					[2, semicolon],
					[1, nested]
				])
			: weighted([
					[3, strayGen],
					[2, semicolon]
				])
	return map(
		array((source) => [source.draw(partSeparator), source.draw(inner)] as const, {
			min: 0,
			max: 4
		}),
		partsText
	)
}

/** A statement's opening: CREATE [OR REPLACE] FUNCTION or PROCEDURE in any case, a near miss of it, or none. */
const openingGen: Gen<Drawn> = weighted([
	[
		3,
		map(
			element(["CREATE FUNCTION f()", "create procedure p (a int)", "CREATE U& FUNCTION f()"]),
			drawnText
		)
	],
	[
		2,
		map(
			element(["CREATE OR REPLACE FUNCTION f()", "Create Or Replace Procedure p"]),
			(text): Drawn => ({ text, reaches: ["a routine opened by CREATE OR REPLACE"] })
		)
	],
	[
		2,
		map(
			element([
				"CREATE OR FUNCTION f()",
				"CREATE TABLE t",
				"SELECT FUNCTION",
				"(CREATE) FUNCTION",
				"U&x"
			]),
			(text): Drawn => ({ text, reaches: ["an opening that is no routine"] })
		)
	],
	[1, constant(drawnText(""))]
])

/** Up to three statements, each an opening and a body two blocks deep, each but maybe the last ended by a semicolon. */
const statementsGen: Gen<Drawn> = map(
	array(
		(source) =>
			[
				source.draw(openingGen),
				source.draw(partSeparator),
				source.draw(bodyGen(2, false)),
				source.draw(element([";", ";\n", ""]))
			] as const,
		{ min: 1, max: 3 }
	),
	(statements): Drawn => ({
		text: Arr.join(
			Arr.map(
				statements,
				([opening, between, body, end]) => `${opening.text}${between}${body.text}${end}`
			),
			""
		),
		reaches: [
			...Arr.flatMap(statements, ([opening, , body]) => [...opening.reaches, ...body.reaches]),
			...(statements.length > 1 ? (["two statements"] as const) : [])
		]
	})
)

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
						box: "every text of up to three characters over the 31 that scan.l's and psqlscan.l's rules branch on",
						oracle: {
							kind: "second-implementation",
							name: "scan.l's and psqlscan.l's rules, transcribed apart"
						},
						coverage: requiredInSpace<BoundaryFeature>([
							"a token",
							"two tokens",
							"a refused run",
							"a lexeme after a refused run",
							"an unclosed construct",
							"a terminator",
							"a semicolon inside parentheses"
						]),
						caseHang,
						concurrency: 1
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
						box: "every run of up to three of 29 tokens and separators, written edge to edge",
						oracle: {
							kind: "second-implementation",
							name: "scan.l's and psqlscan.l's rules, transcribed apart"
						},
						coverage: requiredInSpace<BoundaryFeature>([
							"a token",
							"two tokens",
							"a refused run",
							"a lexeme after a refused run",
							"an unclosed construct",
							"a continued string"
						]),
						caseHang,
						concurrency: 1
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
							name: "scan.l's and psqlscan.l's rules, transcribed apart, and the tokens the sequence was rendered from"
						},
						coverage: required<RenderedKind | SeparatorKind>(
							[
								"word",
								"quotedIdent",
								"string",
								"prefixed string",
								"escape string",
								"continued string",
								"continued escape string",
								"continued escape string ending in an escaped quote",
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
							name: "scan.l's and psqlscan.l's rules, transcribed apart, and the offset the truncated token was rendered at"
						},
						coverage: required<RenderedKind>(
							[
								"quotedIdent",
								"string",
								"continued escape string ending in an escaped quote",
								"dollar"
							],
							{ cases: 300, sense: notesOnly }
						),
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
						oracle: {
							kind: "second-implementation",
							name: "scan.l's and psqlscan.l's rules, transcribed apart"
						},
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

	it.effect("ends every generated statement where psql's scanner ends it", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/sql/lex-statements",
					draw: drawn(statementsGen),
					literal: Formatter.format,
					oracle: {
						kind: "second-implementation",
						name: "scan.l's and psqlscan.l's rules and state, transcribed apart"
					},
					coverage: required<StatementFeature>(statementFeatures, { cases: 400, sense: notesOnly }),
					kept: [],
					runs: 400,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(drawnStatements, c) =>
					Effect.sync(() => {
						c.noteAll(drawnStatements.reaches)
						asScanned(drawnStatements.text)
					})
			)
		)
	)
})
