/**
 * A PostgreSQL lexer for the statements of a migration file (deploy/render/markers.ts splitStatements) and the test
 * kernel's structural text audit (test/support/oracle/verify/sql.ts).
 *
 * The audit of emitted text is structural, not a keyword scan: it reasons over tokens, so `NULL` inside a quoted
 * identifier, a string literal, a dollar-quoted body or a comment is never mistaken for the keyword, and a keyword is
 * recognized only where it stands as a word. The token rules follow PostgreSQL's scanner (scan.l): quoted identifiers
 * with doubled quotes, never empty; standard-conforming strings with doubled quotes, prefixed strings (E'' with its
 * backslash escapes, B'' and X'', whose quote is never doubled, N'' and U&''), each continued by a quote after
 * whitespace that holds a newline; dollar quotes with optional tags; positional parameters; numbers in decimal, with
 * fractions and exponents, and in hexadecimal, octal and binary, their digits grouped by single underscores, refused
 * when an identifier runs on from them; operators with the trailing +/- rule; `::`, `..` and `:=`; and nested block
 * comments. An escape's value is never read: an E or U& literal's escapes stand as written, so the lexer judges where a
 * token ends, never whether PostgreSQL accepts what its escapes denote. It needs no RegExp (src/ constructs none).
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

interface LexError {
	readonly offset: number
	readonly message: string
}

/** The tokens up to the first error, and the error, or undefined when the whole text lexed. */
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

/** What one scanner step read at an index: a run to skip, a token, or the error that stops the lexer. */
type Step =
	| { readonly kind: "skip"; readonly end: number }
	| { readonly kind: "token"; readonly token: Token; readonly end: number }
	| { readonly kind: "error"; readonly error: LexError }

const at = (text: string, k: number): number => text.charCodeAt(k)
const skip = (end: number): Step => ({ kind: "skip", end })
const token = (read: Token, end: number): Step => ({ kind: "token", token: read, end })
const error = (offset: number, message: string): Step => ({
	kind: "error",
	error: { offset, message }
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
	return depth > 0 ? error(i, "unterminated block comment") : skip(j)
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
 * as the step `make` builds from its content and its end, or the error `unterminated` at `errorAt`. The content is the
 * text between the quotes with each doubled quote read as one and each continuation's segments joined, taken a run at
 * a time.
 */
const quotedToken = (
	text: string,
	open: number,
	quoting: Quoting,
	errorAt: number,
	unterminated: string,
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
	return error(errorAt, unterminated)
}

/** A quoted identifier from its opening quote at `open`, read from `start`: PostgreSQL refuses an empty one. */
const quotedIdent = (text: string, open: number, start: number): Step =>
	quotedToken(
		text,
		open,
		identifierQuoting,
		start,
		"unterminated quoted identifier",
		(content, end) =>
			content === ""
				? error(start, "zero-length delimited identifier")
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
	quotedToken(text, open, quoting, errorAt, "unterminated string literal", (content, end) =>
		token({ kind: "string", text: content, prefix, start }, end)
	)

/** The index after the identifier at `from`, which an identifier character begins, or `from` when none does. */
const identifierEnd = (text: string, from: number): number => {
	if (!isIdentStart(at(text, from))) {
		return from
	}
	let j = from + 1
	while (j < text.length && isIdentCont(at(text, j))) {
		j += 1
	}
	return j
}

/** A positional parameter, $n, refused when an identifier runs on from it; or a dollar quote, $tag$ ... $tag$. */
const dollar = (text: string, i: number): Step => {
	if (isDigit(at(text, i + 1))) {
		let j = i + 1
		while (isDigit(at(text, j))) {
			j += 1
		}
		if (isIdentStart(at(text, j))) {
			return error(i, "trailing junk after parameter")
		}
		return token({ kind: "param", index: Number(text.slice(i + 1, j)), start: i }, j)
	}
	if (!isIdentStart(at(text, i + 1)) && at(text, i + 1) !== dollarSign) {
		return error(i, "stray '$'")
	}
	let j = i + 1
	while (j < text.length && at(text, j) !== dollarSign && isDollarTagCont(at(text, j))) {
		j += 1
	}
	if (at(text, j) !== dollarSign) {
		return error(i, "stray '$'")
	}
	const tag = text.slice(i, j + 1)
	const close = text.indexOf(tag, j + 1)
	if (close === -1) {
		return error(i, "unterminated dollar-quoted string")
	}
	return token(
		{ kind: "dollar", tag, body: text.slice(j + 1, close), bodyStart: j + 1, start: i },
		close + tag.length
	)
}

/**
 * A word, or the prefixed string it begins: E'...', B'...', X'...', N'...' and U&'...' are prefixed strings, U&"..." a
 * Unicode identifier. An unterminated one is refused where it begins, but N'...', which PostgreSQL reads as the word
 * NCHAR before a string, where its quote does.
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
	if (upper === "U" && at(text, j) === ampersand) {
		const quote = at(text, j + 1)
		if (quote === singleQuote) {
			return stringConstant(text, j + 1, i, "U&", standardQuoting, i)
		}
		if (quote === doubleQuote) {
			return quotedIdent(text, j + 1, i)
		}
	}
	return token({ kind: "word", text: spelled, upper, start: i }, j)
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

const junk = (i: number): Step => error(i, "trailing junk after numeric literal")

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
		? junk(i)
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
		return end === digitsFrom ? error(i, "invalid non-decimal integer") : numberTo(text, i, end)
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
	return signed ? token({ kind: "number", text: text.slice(i, base), start: i }, base) : junk(i)
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
	return error(i, `unexpected character ${JSON.stringify(text.charAt(i))}`)
}

/** The tokens of `text`, scanned step by step from its start, up to the first error. */
export const lex = (text: string): Lexed => {
	const tokens: Array<Token> = []
	let i = 0
	while (i < text.length) {
		const step = stepAt(text, i)
		if (step.kind === "error") {
			return { tokens, error: step.error }
		}
		if (step.kind === "token") {
			tokens.push(step.token)
		}
		i = step.end
	}
	return { tokens, error: undefined }
}
