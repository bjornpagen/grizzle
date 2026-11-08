/**
 * A PostgreSQL lexer for the statements of a migration file (deploy/render/markers.ts splitStatements) and the test
 * kernel's structural text audit (test/support/oracle/verify/sql.ts).
 *
 * The audit of emitted text is structural, not a keyword scan: it reasons over tokens, so `NULL` inside a quoted
 * identifier, a string literal, a dollar-quoted body or a comment is never mistaken for the keyword, and a keyword is
 * recognized only where it stands as a word. The token rules follow PostgreSQL's scanner (scan.l): quoted identifiers
 * with doubled quotes; standard-conforming strings with doubled quotes, prefixed strings (E'' with its
 * backslash escapes, B'' and X'', whose quote is never doubled, N'' and U&''), each continued by a quote after
 * whitespace that holds a newline; dollar quotes with optional tags; positional parameters; numbers in decimal, with
 * fractions and exponents, and in hexadecimal, octal and binary, their digits grouped by single underscores, refused
 * when an identifier runs on from them; operators with the trailing +/- rule; `::`, `..` and `:=`; and nested block
 * comments. An escape's value is never read: an E or U& literal's escapes stand as written, so the lexer judges where a
 * token ends, never whether PostgreSQL accepts what its escapes denote. It needs no RegExp (src/ constructs none).
 *
 * A text is read as lexemes (lexemesOf), each to the end scan.l's rule for it reaches: a token, or a run the scanner
 * reads whole and refuses, such as an empty quoted identifier, a number or parameter an identifier runs on from, a base
 * with no digit, a `$` that opens no dollar quote, or a character no rule reads. The reading goes on past a refused
 * run, as psql's scanner (psqlscan.l, whose rules are scan.l's) goes on to find where statements end; it ends only
 * where the text opens a quote or a block comment it never closes, whose end is unknown. What PostgreSQL accepts is
 * the tokens before the first refusal (lex).
 *
 * A semicolon ends a statement where psql's scanner ends one: outside every parenthesis, and outside the BEGIN blocks
 * of a routine's body (Statement), where it is the statement's terminator; anywhere else it is punctuation. psql's
 * backslash commands and variables are its own script language, which a migration file never holds, so a backslash
 * and a colon read as the server reads them.
 */
export type Token =
	| { readonly kind: "word"; readonly text: string; readonly upper: string; readonly start: number }
	| { readonly kind: "quotedIdent"; readonly text: string; readonly start: number }
	| {
			readonly kind: "string"
			readonly text: string
			readonly prefix: string | undefined
			readonly start: number
	  }
	| {
			readonly kind: "dollar"
			readonly tag: string
			readonly body: string
			readonly bodyStart: number
			readonly start: number
	  }
	| { readonly kind: "param"; readonly index: number; readonly start: number }
	| { readonly kind: "number"; readonly text: string; readonly start: number }
	| { readonly kind: "operator"; readonly text: string; readonly start: number }
	| { readonly kind: "punct"; readonly text: string; readonly start: number }

/** A run PostgreSQL's scanner reads to the end its rule reaches and refuses: its source text and why it is refused. */
export interface Refused {
	readonly kind: "refused"
	readonly text: string
	readonly message: string
	readonly start: number
}

/** A semicolon that ends a statement, as psql's scanner reads one (Statement). */
export interface Terminator {
	readonly kind: "terminator"
	readonly start: number
}

/** A run PostgreSQL's scanner reads to its end: a token, a run it refuses, or a statement's terminator. */
export type Lexeme = Token | Refused | Terminator

/** A word: what an identifier or a keyword reads as. */
type Word = Extract<Token, { readonly kind: "word" }>

/** A construct whose end the text must hold, as its opener reads it. */
export type Opener =
	| "block comment"
	| "quoted identifier"
	| "string literal"
	| "dollar-quoted string"

/** A construct the text opens at `offset` and never closes, which reads the rest of the text. */
export interface Unclosed {
	readonly opener: Opener
	readonly offset: number
}

/** The lexemes of a text, in order, and the construct it opens and never closes after them, or undefined. */
export interface Lexemes {
	readonly lexemes: ReadonlyArray<Lexeme>
	readonly unclosed: Unclosed | undefined
}

interface LexError {
	readonly offset: number
	readonly message: string
}

/** The tokens up to the first refusal, and the refusal, or undefined when PostgreSQL's scanner reads the whole text. */
export interface Lexed {
	readonly tokens: ReadonlyArray<Token>
	readonly error: LexError | undefined
}

/** The scanner reads UTF-16 code units, compared as numbers; a code unit past the end is NaN, which no class holds. */
const isAsciiLetter = (c: number): boolean => (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a)
const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39
const isOctalDigit = (c: number): boolean => c >= 0x30 && c <= 0x37
const isBinaryDigit = (c: number): boolean => c === 0x30 || c === 0x31
const isHexDigit = (c: number): boolean =>
	isDigit(c) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46)
/** PostgreSQL's ident_start and ident_cont: letters, underscore, and any non-ASCII byte. */
const isIdentStart = (c: number): boolean => isAsciiLetter(c) || c === underscore || c >= 0x80
const isIdentCont = (c: number): boolean => isIdentStart(c) || isDigit(c) || c === dollarSign
const isDollarTagCont = (c: number): boolean => isIdentStart(c) || isDigit(c)
const isNewline = (c: number): boolean => c === lineFeed || c === carriageReturn
/** PostgreSQL's non_newline_space: a space, a tab, a form feed or a vertical tab. */
const isNonNewlineSpace = (c: number): boolean =>
	c === 0x20 || c === 0x09 || c === 0x0c || c === 0x0b
const isSpace = (c: number): boolean => isNonNewlineSpace(c) || isNewline(c)

/** The code units of a class of characters. */
const unitsOf = (chars: string): ReadonlySet<number> =>
	new Set(Array.from(chars, (ch) => ch.charCodeAt(0)))
const operatorUnits = unitsOf("+-*/<>=~!@#%^&|`?")
const isOperatorChar = (c: number): boolean => operatorUnits.has(c)
/** An operator may end in + or - only if it contains one of these (scan.l). */
const nonArithmeticOperatorUnits = unitsOf("~!@#%^&|`?")
const punctuationUnits = unitsOf("()[],;.:")

const underscore = 0x5f
const dollarSign = 0x24
const doubleQuote = 0x22
const singleQuote = 0x27
const backslashUnit = 0x5c
const minus = 0x2d
const plus = 0x2b
const slash = 0x2f
const star = 0x2a
const dot = 0x2e
const colon = 0x3a
const equals = 0x3d
const ampersand = 0x26
const lineFeed = 0x0a
const carriageReturn = 0x0d
const zero = 0x30

/** ASCII uppercase: each a-z code unit raised, every other unit kept (a word with none is itself). */
const toUpperAscii = (text: string): string => {
	let out = ""
	let from = 0
	for (let k = 0; k < text.length; k++) {
		const c = text.charCodeAt(k)
		if (c >= 0x61 && c <= 0x7a) {
			out += text.slice(from, k) + String.fromCharCode(c - 32)
			from = k + 1
		}
	}
	return from === 0 ? text : out + text.slice(from)
}

/**
 * What one scanner step read at an index: a run to skip, a token or a refused run and its end, a word psql's scanner
 * reads as an identifier (psqlscan.l {identifier}) and its end, or a construct never closed.
 */
type Step =
	| { readonly kind: "skip"; readonly end: number }
	| { readonly kind: "lexeme"; readonly lexeme: Token | Refused; readonly end: number }
	| { readonly kind: "identifier"; readonly word: Word; readonly end: number }
	| { readonly kind: "unclosed"; readonly unclosed: Unclosed }

const at = (text: string, k: number): number => text.charCodeAt(k)
const skip = (end: number): Step => ({ kind: "skip", end })
const token = (read: Token, end: number): Step => ({ kind: "lexeme", lexeme: read, end })
const identifier = (word: Word, end: number): Step => ({ kind: "identifier", word, end })
/** The run of `text` from `start` to `end`, refused for `message`. */
const refused = (text: string, start: number, end: number, message: string): Step => ({
	kind: "lexeme",
	lexeme: { kind: "refused", text: text.slice(start, end), message, start },
	end
})
const unclosed = (opener: Opener, offset: number): Step => ({
	kind: "unclosed",
	unclosed: { opener, offset }
})

/** The index after the line comment at `from`: its end of line, a line feed or a carriage return, or the text's end. */
const lineEnd = (text: string, from: number): number => {
	let j = from + 2
	while (j < text.length && !isNewline(at(text, j))) {
		j += 1
	}
	return j
}

/**
 * -- comment to the end of its line, which a line feed or a carriage return ends (scan.l: comment is "--" and
 * non_newline, [^\n\r]), so a lone carriage return ends it as PostgreSQL does.
 */
const lineComment = (text: string, i: number): Step => skip(lineEnd(text, i))

const commentStartsAt = (text: string, j: number): boolean =>
	at(text, j) === minus && at(text, j + 1) === minus

/** A block comment, which nests. */
const blockComment = (text: string, i: number): Step => {
	let depth = 1
	let j = i + 2
	while (j < text.length && depth > 0) {
		if (at(text, j) === slash && at(text, j + 1) === star) {
			depth += 1
			j += 2
		} else if (at(text, j) === star && at(text, j + 1) === slash) {
			depth -= 1
			j += 2
		} else {
			j += 1
		}
	}
	return depth > 0 ? unclosed("block comment", i) : skip(j)
}

/**
 * The index of the quote that continues a string constant whose closing quote ends just before `from`, or undefined
 * when none does (scan.l quotecontinue): spaces and line comments on the closing quote's line, a newline, then spaces,
 * newlines and line comments each ended by a newline, then a quote.
 */
const continuation = (text: string, from: number): number | undefined => {
	let j = from
	for (;;) {
		if (isNonNewlineSpace(at(text, j))) {
			j += 1
		} else if (commentStartsAt(text, j)) {
			j = lineEnd(text, j)
		} else {
			break
		}
	}
	if (!isNewline(at(text, j))) {
		return undefined
	}
	j += 1
	for (;;) {
		if (isSpace(at(text, j))) {
			j += 1
		} else if (commentStartsAt(text, j) && isNewline(at(text, lineEnd(text, j)))) {
			j = lineEnd(text, j) + 1
		} else {
			break
		}
	}
	return at(text, j) === singleQuote ? j : undefined
}

/**
 * How a quoted token reads its content: the quote that closes it, whether a doubled quote is one quote of its content,
 * whether a backslash escapes the character after it, and whether a quote after whitespace holding a newline continues
 * it (scan.l: xd, xq and xus, xe, xb and xh).
 */
interface Quoting {
	readonly quote: number
	readonly doubled: boolean
	readonly backslash: boolean
	readonly continues: boolean
}

const identifierQuoting: Quoting = {
	quote: doubleQuote,
	doubled: true,
	backslash: false,
	continues: false
}
const standardQuoting: Quoting = {
	quote: singleQuote,
	doubled: true,
	backslash: false,
	continues: true
}
const escapeQuoting: Quoting = {
	quote: singleQuote,
	doubled: true,
	backslash: true,
	continues: true
}
const bitQuoting: Quoting = {
	quote: singleQuote,
	doubled: false,
	backslash: false,
	continues: true
}

/**
 * A quoted run from `open` (the index of the opening quote), read as `quoting` says, backslash escapes kept as written,
 * as the step `make` builds from its content and its end, or `opener` unclosed at `errorAt`. The content is the text
 * between the quotes with each doubled quote read as one and each continuation's segments joined, taken a run at a
 * time.
 */
const quotedToken = (
	text: string,
	open: number,
	quoting: Quoting,
	errorAt: number,
	opener: Opener,
	make: (content: string, end: number) => Step
): Step => {
	let content = ""
	let from = open + 1
	let j = open + 1
	while (j < text.length) {
		const c = at(text, j)
		if (quoting.backslash && c === backslashUnit && j + 1 < text.length) {
			j += 2
			continue
		}
		if (c === quoting.quote && quoting.doubled && at(text, j + 1) === quoting.quote) {
			content += text.slice(from, j + 1)
			j += 2
			from = j
			continue
		}
		if (c === quoting.quote) {
			content += text.slice(from, j)
			const next = quoting.continues ? continuation(text, j + 1) : undefined
			if (next === undefined) {
				return make(content, j + 1)
			}
			j = next + 1
			from = j
			continue
		}
		j += 1
	}
	return unclosed(opener, errorAt)
}

/** A quoted identifier from its opening quote at `open`, read from `start`: PostgreSQL refuses an empty one. */
const quotedIdent = (text: string, open: number, start: number): Step =>
	quotedToken(text, open, identifierQuoting, start, "quoted identifier", (content, end) =>
		content === ""
			? refused(text, start, end, "zero-length delimited identifier")
			: token({ kind: "quotedIdent", text: content, start }, end)
	)

/** A string constant from its opening quote at `open`, read from `start` with `prefix`. */
const stringConstant = (
	text: string,
	open: number,
	start: number,
	prefix: string | undefined,
	quoting: Quoting,
	errorAt: number
): Step =>
	quotedToken(text, open, quoting, errorAt, "string literal", (content, end) =>
		token({ kind: "string", text: content, prefix, start }, end)
	)

/** The index after the run of identifier characters from `from`, digits and `$` among them; `from` when none is there. */
const identContEnd = (text: string, from: number): number => {
	let j = from
	while (isIdentCont(at(text, j))) {
		j += 1
	}
	return j
}

/** The index after the identifier at `from`, which an identifier character begins, or `from` when none does. */
const identifierEnd = (text: string, from: number): number =>
	isIdentStart(at(text, from)) ? identContEnd(text, from + 1) : from

/** The `$` at `i`, refused alone: scan.l's dolqfailed gives back all but it, and {other} reads it. */
const strayDollar = (text: string, i: number): Step => refused(text, i, i + 1, "stray '$'")

/**
 * A positional parameter, $n, refused with the identifier that runs on from it; or a dollar quote, $tag$ ... $tag$; or
 * a stray `$`.
 */
const dollar = (text: string, i: number): Step => {
	if (isDigit(at(text, i + 1))) {
		let j = i + 1
		while (isDigit(at(text, j))) {
			j += 1
		}
		if (isIdentStart(at(text, j))) {
			return refused(text, i, identifierEnd(text, j), "trailing junk after parameter")
		}
		return token({ kind: "param", index: Number(text.slice(i + 1, j)), start: i }, j)
	}
	if (!isIdentStart(at(text, i + 1)) && at(text, i + 1) !== dollarSign) {
		return strayDollar(text, i)
	}
	let j = i + 1
	while (j < text.length && at(text, j) !== dollarSign && isDollarTagCont(at(text, j))) {
		j += 1
	}
	if (at(text, j) !== dollarSign) {
		return strayDollar(text, i)
	}
	const tag = text.slice(i, j + 1)
	const close = text.indexOf(tag, j + 1)
	if (close === -1) {
		return unclosed("dollar-quoted string", i)
	}
	return token(
		{ kind: "dollar", tag, body: text.slice(j + 1, close), bodyStart: j + 1, start: i },
		close + tag.length
	)
}

/**
 * A word, or the prefixed string it begins: E'...', B'...', X'...', N'...' and U&'...' are prefixed strings, U&"..." a
 * Unicode identifier. An unterminated one is refused where it begins, but N'...', which PostgreSQL reads as the word
 * NCHAR before a string, where its quote does. U& before neither quote is the word U, which psql's scanner reads as no
 * identifier (psqlscan.l xufailed); every other word is one.
 */
const word = (text: string, i: number): Step => {
	const j = identifierEnd(text, i)
	const spelled = text.slice(i, j)
	const upper = toUpperAscii(spelled)
	if (at(text, j) === singleQuote) {
		switch (upper) {
			case "E":
				return stringConstant(text, j, i, upper, escapeQuoting, i)
			case "B":
			case "X":
				return stringConstant(text, j, i, upper, bitQuoting, i)
			case "N":
				return stringConstant(text, j, i, upper, standardQuoting, j)
		}
	}
	const read: Word = { kind: "word", text: spelled, upper, start: i }
	if (upper === "U" && at(text, j) === ampersand) {
		const quote = at(text, j + 1)
		if (quote === singleQuote) {
			return stringConstant(text, j + 1, i, "U&", standardQuoting, i)
		}
		if (quote === doubleQuote) {
			return quotedIdent(text, j + 1, i)
		}
		return token(read, j)
	}
	return identifier(read, j)
}

/**
 * The index after the run of digits from `from` that `digit` admits, each group after the first joined by one
 * underscore; `from` when no digit is there.
 */
const digitGroupsEnd = (text: string, from: number, digit: (c: number) => boolean): number => {
	if (!digit(at(text, from))) {
		return from
	}
	let j = from + 1
	for (;;) {
		if (digit(at(text, j))) {
			j += 1
		} else if (at(text, j) === underscore && digit(at(text, j + 1))) {
			j += 2
		} else {
			return j
		}
	}
}

/** A non-decimal integer's digits after its base letter, which an underscore may also precede (0x_1F). */
const radixDigitsEnd = (text: string, from: number, digit: (c: number) => boolean): number =>
	at(text, from) === underscore && digit(at(text, from + 1))
		? digitGroupsEnd(text, from + 1, digit)
		: digitGroupsEnd(text, from, digit)

/** The digit class of each non-decimal integer's base letter, x, o and b in either case. */
const radixDigits: ReadonlyMap<number, (c: number) => boolean> = new Map([
	[0x78, isHexDigit],
	[0x58, isHexDigit],
	[0x6f, isOctalDigit],
	[0x4f, isOctalDigit],
	[0x62, isBinaryDigit],
	[0x42, isBinaryDigit]
])

/**
 * The width of a non-decimal integer's prefix, its 0 and its base letter.
 *
 * @formatConstant scan.l's hexinteger, octinteger and bininteger: 0, then x, o or b in either case, then the digits
 */
const radixPrefixWidth = 2

/**
 * The number from `i` refused with the identifier that runs on from it at `end`: the run reaches the end of the
 * identifier characters there, as scan.l's integer_junk, numeric_junk and real_junk do.
 */
const junk = (text: string, i: number, end: number): Step =>
	refused(text, i, identContEnd(text, end), "trailing junk after numeric literal")

/**
 * Whether an identifier runs on from the number from `i` that ends at `end` (scan.l integer_junk and its kin): one that
 * begins there, or one that begins inside the number's last run of identifier characters, at an underscore between its
 * digits, its exponent's e or its base's letter, and runs on past its end.
 */
const runsOn = (text: string, i: number, end: number): boolean => {
	if (isIdentStart(at(text, end))) {
		return true
	}
	if (!isIdentCont(at(text, end))) {
		return false
	}
	for (let k = end - 1; k >= i && isIdentCont(at(text, k)); k--) {
		if (isIdentStart(at(text, k))) {
			return true
		}
	}
	return false
}

/** The number token from `i` to `end`, refused when an identifier runs on from it. */
const numberTo = (text: string, i: number, end: number): Step =>
	runsOn(text, i, end)
		? junk(text, i, end)
		: token({ kind: "number", text: text.slice(i, end), start: i }, end)

/**
 * A number (scan.l decinteger, hexinteger, octinteger, bininteger, numeric and real): digit groups, a fraction unless
 * the dot begins `..`, and an exponent; or 0x, 0o or 0b and the digits of its base, refused with none. A number is
 * refused when an identifier runs on from it; an exponent marker that a sign ends and no digit follows is no exponent,
 * and the number ends before it.
 */
const numberAt = (text: string, i: number): Step => {
	const radix = at(text, i) === zero ? radixDigits.get(at(text, i + 1)) : undefined
	if (radix !== undefined) {
		const digitsFrom = i + radixPrefixWidth
		const end = radixDigitsEnd(text, digitsFrom, radix)
		return end === digitsFrom
			? refused(text, i, identContEnd(text, i), "invalid non-decimal integer")
			: numberTo(text, i, end)
	}
	const integer = digitGroupsEnd(text, i, isDigit)
	if (at(text, integer) === dot && at(text, integer + 1) === dot) {
		return token({ kind: "number", text: text.slice(i, integer), start: i }, integer)
	}
	const base = at(text, integer) === dot ? digitGroupsEnd(text, integer + 1, isDigit) : integer
	const marker = at(text, base)
	if (marker !== 0x65 && marker !== 0x45) {
		return numberTo(text, i, base)
	}
	const signed = at(text, base + 1) === plus || at(text, base + 1) === minus
	const digits = base + 1 + (signed ? 1 : 0)
	const exponentEnd = digitGroupsEnd(text, digits, isDigit)
	if (exponentEnd > digits) {
		return numberTo(text, i, exponentEnd)
	}
	return signed
		? token({ kind: "number", text: text.slice(i, base), start: i }, base)
		: junk(text, i, base)
}

/**
 * An operator: a run of operator characters that a comment start ends. Trailing + and - belong to the next token
 * unless the operator has a non-arithmetic character.
 */
const operatorAt = (text: string, i: number): Step => {
	let j = i
	let arithmetic = true
	while (
		j < text.length &&
		isOperatorChar(at(text, j)) &&
		!commentStartsAt(text, j) &&
		!(at(text, j) === slash && at(text, j + 1) === star)
	) {
		if (nonArithmeticOperatorUnits.has(at(text, j))) {
			arithmetic = false
		}
		j += 1
	}
	let end = j
	if (arithmetic) {
		while (end - i > 1 && (at(text, end - 1) === plus || at(text, end - 1) === minus)) {
			end -= 1
		}
	}
	return token({ kind: "operator", text: text.slice(i, end), start: i }, end)
}

/** The punctuation of two code units at `i`: `::`, `..` and `:=`, or undefined for none. */
const pairPunctuation = (c: number, next: number): string | undefined =>
	c === colon && next === colon
		? "::"
		: c === dot && next === dot
			? ".."
			: c === colon && next === equals
				? ":="
				: undefined

/** The scanner step at `i`, by the code unit there and the one after it. */
const stepAt = (text: string, i: number): Step => {
	const c = at(text, i)
	const next = at(text, i + 1)
	if (isSpace(c)) {
		return skip(i + 1)
	}
	if (commentStartsAt(text, i)) {
		return lineComment(text, i)
	}
	if (c === slash && next === star) {
		return blockComment(text, i)
	}
	if (c === doubleQuote) {
		return quotedIdent(text, i, i)
	}
	if (c === singleQuote) {
		return stringConstant(text, i, i, undefined, standardQuoting, i)
	}
	if (c === dollarSign) {
		return dollar(text, i)
	}
	if (isIdentStart(c)) {
		return word(text, i)
	}
	const pair = pairPunctuation(c, next)
	if (pair !== undefined) {
		return token({ kind: "punct", text: pair, start: i }, i + 2)
	}
	if (isDigit(c) || (c === dot && isDigit(next))) {
		return numberAt(text, i)
	}
	if (punctuationUnits.has(c)) {
		return token({ kind: "punct", text: text.charAt(i), start: i }, i + 1)
	}
	if (isOperatorChar(c)) {
		return operatorAt(text, i)
	}
	return refused(text, i, i + 1, `unexpected character ${JSON.stringify(text.charAt(i))}`)
}

/**
 * How far psql's scanner has read a statement's opening identifiers (psqlscan.l psqlscan_is_create_routine): CREATE,
 * then OR REPLACE or nothing, then FUNCTION or PROCEDURE opens a routine, and any other opening is none. In a routine it
 * counts the blocks open: BEGIN opens one, CASE one inside a block, and END closes the innermost.
 */
type Opening =
	| { readonly kind: "start" | "create" | "createOr" | "createOrReplace" | "none" }
	| { readonly kind: "routine"; readonly blocks: number }

/**
 * Where psql's scanner stands in a statement: the parentheses open, inside which it reads no identifier as one of the
 * opening's, and the opening. A semicolon outside every parenthesis and every block ends the statement.
 */
interface Statement {
	readonly parens: number
	readonly opening: Opening
}

const freshStatement: Statement = { parens: 0, opening: { kind: "start" } }
const noRoutine: Opening = { kind: "none" }
const routine: Opening = { kind: "routine", blocks: 0 }
const routineWords: ReadonlySet<string> = new Set(["FUNCTION", "PROCEDURE"])

/** A routine's blocks open after the identifier `upper`. */
const blocksAfter = (blocks: number, upper: string): number => {
	switch (upper) {
		case "BEGIN":
			return blocks + 1
		case "CASE":
			return blocks > 0 ? blocks + 1 : blocks
		case "END":
			return blocks > 0 ? blocks - 1 : blocks
		default:
			return blocks
	}
}

/** The opening after the identifier `upper`. */
const openingAfter = (opening: Opening, upper: string): Opening => {
	switch (opening.kind) {
		case "start":
			return upper === "CREATE" ? { kind: "create" } : noRoutine
		case "create":
			if (routineWords.has(upper)) {
				return routine
			}
			return upper === "OR" ? { kind: "createOr" } : noRoutine
		case "createOr":
			return upper === "REPLACE" ? { kind: "createOrReplace" } : noRoutine
		case "createOrReplace":
			return routineWords.has(upper) ? routine : noRoutine
		case "routine":
			return { kind: "routine", blocks: blocksAfter(opening.blocks, upper) }
		case "none":
			return opening
	}
}

/** The statement after an identifier psql's scanner reads: inside a parenthesis it stands where it stood. */
const afterIdentifier = (statement: Statement, upper: string): Statement =>
	statement.parens > 0 ? statement : { parens: 0, opening: openingAfter(statement.opening, upper) }

/** Whether a semicolon ends the statement: no parenthesis and no block of a routine is open. */
const ends = (statement: Statement): boolean =>
	statement.parens === 0 && (statement.opening.kind !== "routine" || statement.opening.blocks === 0)

/** A lexeme psql's scanner reads, and the statement it stands in after it. */
interface Read {
	readonly lexeme: Lexeme
	readonly statement: Statement
}

/**
 * What psql's scanner reads a token or a refused run as in `statement`: a parenthesis opens or closes one, never below
 * none; a semicolon that ends the statement is its terminator, after which the next statement starts fresh.
 */
const punctuated = (statement: Statement, t: Token | Refused): Read => {
	if (t.kind !== "punct") {
		return { lexeme: t, statement }
	}
	switch (t.text) {
		case "(":
			return { lexeme: t, statement: { ...statement, parens: statement.parens + 1 } }
		case ")":
			return { lexeme: t, statement: { ...statement, parens: Math.max(statement.parens - 1, 0) } }
		case ";":
			return ends(statement)
				? { lexeme: { kind: "terminator", start: t.start }, statement: freshStatement }
				: { lexeme: t, statement }
		default:
			return { lexeme: t, statement }
	}
}

/**
 * The lexemes of `text`, scanned step by step from its start, up to a construct it never closes, each semicolon that
 * ends a statement read as its terminator.
 */
export const lexemesOf = (text: string): Lexemes => {
	const lexemes: Array<Lexeme> = []
	let statement = freshStatement
	let i = 0
	while (i < text.length) {
		const step = stepAt(text, i)
		switch (step.kind) {
			case "unclosed":
				return { lexemes, unclosed: step.unclosed }
			case "skip":
				break
			case "identifier":
				lexemes.push(step.word)
				statement = afterIdentifier(statement, step.word.upper)
				break
			case "lexeme": {
				const read = punctuated(statement, step.lexeme)
				lexemes.push(read.lexeme)
				statement = read.statement
				break
			}
		}
		i = step.end
	}
	return { lexemes, unclosed: undefined }
}

/**
 * The tokens of `text` PostgreSQL's scanner reads before it first refuses it (lexemesOf), and that refusal: every
 * semicolon is punctuation to it, a statement's terminator among them.
 */
export const lex = (text: string): Lexed => {
	const read = lexemesOf(text)
	const tokens: Array<Token> = []
	for (const l of read.lexemes) {
		if (l.kind === "refused") {
			return { tokens, error: { offset: l.start, message: l.message } }
		}
		tokens.push(l.kind === "terminator" ? { kind: "punct", text: ";", start: l.start } : l)
	}
	return {
		tokens,
		error:
			read.unclosed === undefined
				? undefined
				: { offset: read.unclosed.offset, message: `unterminated ${read.unclosed.opener}` }
	}
}
