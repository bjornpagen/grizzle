/**
 * A PostgreSQL lexer for the statements of a migration file (deploy/render/markers.ts splitStatements) and the test
 * kernel's structural text audit (test/support/oracle/verify/sql.ts).
 *
 * The audit of emitted text is structural, not a keyword scan: it reasons over tokens, so `NULL` inside a quoted
 * identifier, a string literal, a dollar-quoted body or a comment is never mistaken for the keyword, and a keyword is
 * recognized only where it stands as a word. The token rules follow PostgreSQL's scanner (scan.l): quoted identifiers
 * with doubled quotes, standard-conforming strings with doubled quotes, prefixed strings (E'' with its backslash
 * escapes, B'', X'', N'', U&''), dollar quotes with optional tags, positional parameters, numbers, operators with the trailing +/- rule, and nested
 * block comments. It needs no RegExp (src/ constructs none).
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
/** PostgreSQL's ident_start and ident_cont: letters, underscore, and any non-ASCII byte. */
const isIdentStart = (c: number): boolean => isAsciiLetter(c) || c === underscore || c >= 0x80
const isIdentCont = (c: number): boolean => isIdentStart(c) || isDigit(c) || c === dollarSign
const isDollarTagCont = (c: number): boolean => isIdentStart(c) || isDigit(c)
const isSpace = (c: number): boolean =>
	c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0c || c === 0x0b

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
const ampersand = 0x26
const lineFeed = 0x0a
const carriageReturn = 0x0d

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

const stringPrefixes: ReadonlySet<string> = new Set(["E", "B", "X", "N"])

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

/** The index after the run of digits from `from`. */
const digitsEnd = (text: string, from: number): number => {
	let j = from
	while (isDigit(at(text, j))) {
		j += 1
	}
	return j
}

/** The index after the run of digits and underscores from `from`. */
const digitGroupsEnd = (text: string, from: number): number => {
	let j = from
	while (isDigit(at(text, j)) || at(text, j) === underscore) {
		j += 1
	}
	return j
}

/**
 * -- comment to the end of its line, which a line feed or a carriage return ends (scan.l: comment is "--" and
 * non_newline, [^\n\r]), so a lone carriage return ends it as PostgreSQL does.
 */
const lineComment = (text: string, i: number): Step => {
	let j = i + 2
	while (j < text.length && at(text, j) !== lineFeed && at(text, j) !== carriageReturn) {
		j += 1
	}
	return skip(j)
}

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
 * A quoted run from `open` (the index of the opening quote) with doubled-quote escapes, and with `backslash` a
 * backslash escaping the character after it (both kept as written), as the token `make` builds from its content, or
 * the error `unterminated` at `open`. The content is the text between the quotes with each doubled quote read as one,
 * taken a run at a time.
 */
const quotedToken = (
	text: string,
	open: number,
	quote: number,
	backslash: boolean,
	unterminated: string,
	make: (content: string) => Token
): Step => {
	let content = ""
	let from = open + 1
	let j = open + 1
	while (j < text.length) {
		const c = at(text, j)
		if (backslash && c === backslashUnit && j + 1 < text.length) {
			j += 2
			continue
		}
		if (c === quote && at(text, j + 1) === quote) {
			content += text.slice(from, j + 1)
			j += 2
			from = j
			continue
		}
		if (c === quote) {
			return token(make(content + text.slice(from, j)), j + 1)
		}
		j += 1
	}
	return error(open, unterminated)
}

/** A positional parameter, $n; or a dollar quote, $tag$ ... $tag$ or $$ ... $$. */
const dollar = (text: string, i: number): Step => {
	if (isDigit(at(text, i + 1))) {
		const j = digitsEnd(text, i + 1)
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
 * Unicode identifier.
 */
const word = (text: string, i: number): Step => {
	let j = i + 1
	while (j < text.length && isIdentCont(at(text, j))) {
		j += 1
	}
	const spelled = text.slice(i, j)
	const upper = toUpperAscii(spelled)
	if (stringPrefixes.has(upper) && at(text, j) === singleQuote) {
		return quotedToken(
			text,
			j,
			singleQuote,
			upper === "E",
			"unterminated string literal",
			(content) => ({
				kind: "string",
				text: content,
				prefix: upper,
				start: i
			})
		)
	}
	const quote = at(text, j + 1)
	if (
		upper === "U" &&
		at(text, j) === ampersand &&
		(quote === singleQuote || quote === doubleQuote)
	) {
		return quotedToken(text, j + 1, quote, false, "unterminated Unicode literal", (content) =>
			quote === singleQuote
				? { kind: "string", text: content, prefix: "U&", start: i }
				: { kind: "quotedIdent", text: content, start: i }
		)
	}
	return token({ kind: "word", text: spelled, upper, start: i }, j)
}

/** Whether an exponent marker starts at `j`: e or E, then a digit, or a sign and a digit. */
const exponentAt = (text: string, j: number): boolean =>
	(at(text, j) === 0x65 || at(text, j) === 0x45) &&
	(isDigit(at(text, j + 1)) ||
		((at(text, j + 1) === plus || at(text, j + 1) === minus) && isDigit(at(text, j + 2))))

/** A number: digit groups, a fraction unless the dot begins `..`, and an exponent. */
const numberAt = (text: string, i: number): Step => {
	let j = digitGroupsEnd(text, i)
	if (at(text, j) === dot && at(text, j + 1) !== dot) {
		j = digitGroupsEnd(text, j + 1)
	}
	if (exponentAt(text, j)) {
		j = digitsEnd(text, j + 2)
	}
	return token({ kind: "number", text: text.slice(i, j), start: i }, j)
}

/** Whether a comment starts at `j`, which ends an operator run. */
const commentAt = (text: string, j: number): boolean =>
	(at(text, j) === minus && at(text, j + 1) === minus) ||
	(at(text, j) === slash && at(text, j + 1) === star)

/**
 * An operator: a run of operator characters that a comment start ends. Trailing + and - belong to the next token
 * unless the operator has a non-arithmetic character.
 */
const operatorAt = (text: string, i: number): Step => {
	let j = i
	let arithmetic = true
	while (j < text.length && isOperatorChar(at(text, j)) && !commentAt(text, j)) {
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

/** The scanner step at `i`, by the code unit there and the one after it. */
const stepAt = (text: string, i: number): Step => {
	const c = at(text, i)
	const next = at(text, i + 1)
	if (isSpace(c)) {
		return skip(i + 1)
	}
	if (c === minus && next === minus) {
		return lineComment(text, i)
	}
	if (c === slash && next === star) {
		return blockComment(text, i)
	}
	if (c === doubleQuote) {
		return quotedToken(
			text,
			i,
			doubleQuote,
			false,
			"unterminated quoted identifier",
			(content) => ({
				kind: "quotedIdent",
				text: content,
				start: i
			})
		)
	}
	if (c === singleQuote) {
		return quotedToken(text, i, singleQuote, false, "unterminated string literal", (content) => ({
			kind: "string",
			text: content,
			prefix: undefined,
			start: i
		}))
	}
	if (c === dollarSign) {
		return dollar(text, i)
	}
	if (isIdentStart(c)) {
		return word(text, i)
	}
	if (isDigit(c) || (c === dot && isDigit(next))) {
		return numberAt(text, i)
	}
	if (c === colon && next === colon) {
		return token({ kind: "punct", text: "::", start: i }, i + 2)
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
