import { regex } from "arkregex"
import { Array as Arr, Option, String as Str } from "effect"
import type { Lexeme, Lexemes, Opener } from "#compiler/sql/lexer.ts"

/**
 * PostgreSQL's scanner, src/backend/parser/scan.l of 19rc1, transcribed rule by rule as the reference the lexer
 * (sql/lexer.ts) is held to. Each state's rules are scan.l's patterns, written as regular expressions: at an offset
 * every rule is tried, the longest match wins and a tie goes to the rule scan.l states first, as flex decides, and each
 * rule's action is scan.l's, its yyless included. Nothing here is the lexer's: no rule, no scan, no character class.
 *
 * What PostgreSQL returns is read as the lexer's tokens: an identifier is a word, its ASCII letters raised; a quoted or
 * Unicode identifier, a string constant, a bit, hexadecimal, national, escape or Unicode string is its content, each
 * doubled quote read as one where its state reads one, a continued constant's segments joined, its escapes as written,
 * its prefix in capitals; NCHAR before a string, which N'' is, the one string N''; typecast, `..`, `:=` and the
 * punctuation of self are punct; every operator, a self character among them, is an operator; each number, its text.
 * A token PostgreSQL refuses, and a character it returns as {other} for its grammar to refuse, is a refused run from
 * the offset PostgreSQL reports it at to the end its rule matched, after which the scan goes on as psql's scanner
 * (psqlscan.l, whose rules and yyless are scan.l's) goes on past it. A quote or block comment the text never closes
 * ends the scan, its state named as the opener. An escape's value is never read, so a literal PostgreSQL refuses for
 * what an escape denotes is read as written.
 *
 * Where a statement ends is psql's, src/fe_utils/psqlscan.l of 19rc1, transcribed as its rules and its state are: its
 * "(", ")" and ";" rules, ahead of self, count the parentheses and end a statement at a semicolon outside every
 * parenthesis and every BEGIN block, read as the lexer's terminator; its {identifier} rule, and no other, tracks the
 * identifier (psqlscan_track_identifier), recording the statement's first eight in init_idents and counting BEGIN, CASE
 * and END in begin_depth once they spell CREATE [OR REPLACE] FUNCTION or PROCEDURE. Its rules for backslash commands
 * and variables are psql's script language, which a migration file never holds, and are not transcribed.
 */

/** A rule of a state: its name, as scan.l names it, and its pattern, which matches at an offset or not. */
interface Rule<N extends string> {
	readonly name: N
	readonly pattern: RegExp
}

/** The longest match of a state's rules at `at`, the first rule on a tie: its rule and its length. */
const longest = <N extends string>(
	rules: ReadonlyArray<Rule<N>>,
	text: string,
	at: number
): Option.Option<{ readonly name: N; readonly length: number }> =>
	Arr.reduce(rules, Option.none<{ readonly name: N; readonly length: number }>(), (best, rule) => {
		rule.pattern.lastIndex = at
		const match = rule.pattern.exec(text)
		const length = match === null ? 0 : match[0].length
		return length > 0 && (Option.isNone(best) || length > best.value.length)
			? Option.some({ name: rule.name, length })
			: best
	})

const rule = <N extends string>(name: N, pattern: RegExp): Rule<N> => ({ name, pattern })

/** The rules of the initial state, in scan.l's order. */
const initialRules = () =>
	[
		rule("whitespace", regex("(?:[ \\t\\n\\r\\f\\v]+|--[^\\n\\r]*)", "y")),
		rule("xcstart", regex("/\\*[~!@#^&|`?+\\-*/%<>=]*", "y")),
		rule("xbstart", regex("[bB]'", "y")),
		rule("xhstart", regex("[xX]'", "y")),
		rule("xnstart", regex("[nN]'", "y")),
		rule("xqstart", regex("'", "y")),
		rule("xestart", regex("[eE]'", "y")),
		rule("xusstart", regex("[uU]&'", "y")),
		rule("dolqdelim", regex("\\$(?:[A-Za-z\\x80-\\uFFFF_][A-Za-z\\x80-\\uFFFF_0-9]*)?\\$", "y")),
		rule("dolqfailed", regex("\\$[A-Za-z\\x80-\\uFFFF_][A-Za-z\\x80-\\uFFFF_0-9]*", "y")),
		rule("xdstart", regex('"', "y")),
		rule("xuistart", regex('[uU]&"', "y")),
		rule("xufailed", regex("[uU]&", "y")),
		rule("typecast", regex("::", "y")),
		rule("dot_dot", regex("\\.\\.", "y")),
		rule("colon_equals", regex(":=", "y")),
		rule("equals_greater", regex("=>", "y")),
		rule("less_equals", regex("<=", "y")),
		rule("greater_equals", regex(">=", "y")),
		rule("less_greater", regex("<>", "y")),
		rule("not_equals", regex("!=", "y")),
		rule("open_paren", regex("\\(", "y")),
		rule("close_paren", regex("\\)", "y")),
		rule("semicolon", regex(";", "y")),
		rule("self", regex("[,()\\[\\].;:+\\-*/%^<>=]", "y")),
		rule("operator", regex("[~!@#^&|`?+\\-*/%<>=]+", "y")),
		rule("param", regex("\\$[0-9]+", "y")),
		rule("param_junk", regex("\\$[0-9]+[A-Za-z\\x80-\\uFFFF_][A-Za-z\\x80-\\uFFFF_0-9$]*", "y")),
		rule("decinteger", regex("[0-9](?:_?[0-9])*", "y")),
		rule("hexinteger", regex("0[xX](?:_?[0-9A-Fa-f])+", "y")),
		rule("octinteger", regex("0[oO](?:_?[0-7])+", "y")),
		rule("bininteger", regex("0[bB](?:_?[01])+", "y")),
		rule("hexfail", regex("0[xX]_?", "y")),
		rule("octfail", regex("0[oO]_?", "y")),
		rule("binfail", regex("0[bB]_?", "y")),
		rule(
			"numeric",
			regex("(?:[0-9](?:_?[0-9])*\\.(?:[0-9](?:_?[0-9])*)?|\\.[0-9](?:_?[0-9])*)", "y")
		),
		rule("numericfail", regex("[0-9](?:_?[0-9])*\\.\\.", "y")),
		rule(
			"real",
			regex(
				"(?:[0-9](?:_?[0-9])*|[0-9](?:_?[0-9])*\\.(?:[0-9](?:_?[0-9])*)?|\\.[0-9](?:_?[0-9])*)[Ee][-+]?[0-9](?:_?[0-9])*",
				"y"
			)
		),
		rule(
			"realfail",
			regex(
				"(?:[0-9](?:_?[0-9])*|[0-9](?:_?[0-9])*\\.(?:[0-9](?:_?[0-9])*)?|\\.[0-9](?:_?[0-9])*)[Ee][-+]",
				"y"
			)
		),
		rule(
			"integer_junk",
			regex("[0-9](?:_?[0-9])*[A-Za-z\\x80-\\uFFFF_][A-Za-z\\x80-\\uFFFF_0-9$]*", "y")
		),
		rule(
			"numeric_junk",
			regex(
				"(?:[0-9](?:_?[0-9])*\\.(?:[0-9](?:_?[0-9])*)?|\\.[0-9](?:_?[0-9])*)[A-Za-z\\x80-\\uFFFF_][A-Za-z\\x80-\\uFFFF_0-9$]*",
				"y"
			)
		),
		rule(
			"real_junk",
			regex(
				"(?:[0-9](?:_?[0-9])*|[0-9](?:_?[0-9])*\\.(?:[0-9](?:_?[0-9])*)?|\\.[0-9](?:_?[0-9])*)[Ee][-+]?[0-9](?:_?[0-9])*[A-Za-z\\x80-\\uFFFF_][A-Za-z\\x80-\\uFFFF_0-9$]*",
				"y"
			)
		),
		rule("identifier", regex("[A-Za-z\\x80-\\uFFFF_][A-Za-z\\x80-\\uFFFF_0-9$]*", "y")),
		rule("other", regex("[\\s\\S]", "y"))
	] as const

/** The rules inside a block comment (scan.l's xc state), in order. */
const commentRules = () =>
	[
		rule("xcstart", regex("/\\*[~!@#^&|`?+\\-*/%<>=]*", "y")),
		rule("xcstop", regex("\\*+/", "y")),
		rule("xcinside", regex("[^*/]+", "y")),
		rule("op_chars", regex("[~!@#^&|`?+\\-*/%<>=]", "y"))
	] as const

/**
 * The rules inside a string constant of each state, in scan.l's order: xq and xus, xe, and xb and xh, each ending at
 * its quote.
 */
const standardRules = () =>
	[
		rule("quote", regex("'", "y")),
		rule("xqdouble", regex("''", "y")),
		rule("xqinside", regex("[^']+", "y"))
	] as const

const escapeRules = () =>
	[
		rule("quote", regex("'", "y")),
		rule("xqdouble", regex("''", "y")),
		rule("xeinside", regex("[^\\\\']+", "y")),
		rule("xeunicode", regex("\\\\(?:u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})", "y")),
		rule("xeunicodefail", regex("\\\\(?:u[0-9A-Fa-f]{0,3}|U[0-9A-Fa-f]{0,7})", "y")),
		rule("xeescape", regex("\\\\[^0-7]", "y")),
		rule("xeoctesc", regex("\\\\[0-7]{1,3}", "y")),
		rule("xehexesc", regex("\\\\x[0-9A-Fa-f]{1,2}", "y")),
		rule("any", regex("[^\\n]", "y"))
	] as const

const bitRules = () =>
	[rule("quote", regex("'", "y")), rule("xbinside", regex("[^']+", "y"))] as const

/** The rules inside a quoted identifier (xd and xui), in scan.l's order. */
const identifierRules = () =>
	[
		rule("xdstop", regex('"', "y")),
		rule("xddouble", regex('""', "y")),
		rule("xdinside", regex('[^"]+', "y"))
	] as const

/** The rules inside a dollar-quoted string (xdolq). */
const dollarRules = () =>
	[
		rule("dolqdelim", regex("\\$(?:[A-Za-z\\x80-\\uFFFF_][A-Za-z\\x80-\\uFFFF_0-9]*)?\\$", "y")),
		rule("dolqinside", regex("[^$]+", "y")),
		rule("dolqfailed", regex("\\$[A-Za-z\\x80-\\uFFFF_][A-Za-z\\x80-\\uFFFF_0-9]*", "y")),
		rule("any", regex("[\\s\\S]", "y"))
	] as const

/** What follows a string constant's closing quote and continues it: quotecontinue. */
const quoteContinue = () =>
	regex("(?:[ \\t\\f\\v]|--[^\\n\\r]*)*[\\n\\r](?:[ \\t\\n\\r\\f\\v]+|--[^\\n\\r]*[\\n\\r])*'", "y")

/** ASCII letters raised, every other character kept: how a word's keyword reading compares. */
const raised = (text: string): string =>
	Arr.join(
		Arr.map(Str.split(text, ""), (c) => (c >= "a" && c <= "z" ? Str.toUpperCase(c) : c)),
		""
	)

/** What psqlscan.l's action for a rule does besides echoing what it read: count a parenthesis, end a statement at a
 * semicolon, or track an identifier. */
type PsqlAction =
	| { readonly kind: "echo" | "open" | "close" | "semicolon" }
	| { readonly kind: "identifier"; readonly identifier: string }

/** Where a scan stands after one step: the offset it goes on from, with a lexeme or none and psql's action, or the
 * construct the text never closes, which ends it. */
type Scanned =
	| {
			readonly kind: "on"
			readonly next: number
			readonly lexeme: Option.Option<Lexeme>
			readonly psql: PsqlAction
	  }
	| { readonly kind: "unclosed"; readonly opener: Opener; readonly offset: number }

const on = (next: number, lexeme: Option.Option<Lexeme>): Scanned => ({
	kind: "on",
	next,
	lexeme,
	psql: { kind: "echo" }
})
const psqlOn = (next: number, lexeme: Lexeme, psql: PsqlAction): Scanned => ({
	kind: "on",
	next,
	lexeme: Option.some(lexeme),
	psql
})
const unclosedAt = (opener: Opener, offset: number): Scanned => ({
	kind: "unclosed",
	opener,
	offset
})
/** The run of `text` from `start` to `end`, refused: the scan goes on from its end. */
const refusedRun = (text: string, start: number, end: number): Scanned =>
	on(
		end,
		Option.some({
			kind: "refused",
			text: Str.slice(start, end)(text),
			message: "refused by scan.l",
			start
		})
	)

/** A string constant's state: which rules read its content, and whether its doubled quote is one quote. */
type StringState = "standard" | "escape" | "bit"

/**
 * The string constant whose content starts at `from`, in `state`: its content and the offset after it, segments joined
 * across each quotecontinue, or undefined when the text ends inside it.
 */
const stringFrom = (
	text: string,
	from: number,
	state: StringState
): { readonly content: string; readonly end: number } | undefined => {
	const rules = state === "escape" ? escapeRules() : state === "bit" ? bitRules() : standardRules()
	const continues = quoteContinue()
	let content = ""
	let at = from
	for (;;) {
		const step = longest<string>(rules, text, at)
		if (Option.isNone(step)) {
			return undefined
		}
		const read = Str.slice(at, at + step.value.length)(text)
		at += step.value.length
		if (step.value.name === "quote") {
			continues.lastIndex = at
			const continued = continues.exec(text)
			if (continued === null) {
				return { content, end: at }
			}
			at += continued[0].length
		} else {
			content += step.value.name === "xqdouble" ? "'" : read
		}
	}
}

/** The quoted identifier whose content starts at `from`: its content and end, or undefined unterminated. */
const identifierFrom = (
	text: string,
	from: number
): { readonly content: string; readonly end: number } | undefined => {
	const rules = identifierRules()
	let content = ""
	let at = from
	for (;;) {
		const step = longest<string>(rules, text, at)
		if (Option.isNone(step)) {
			return undefined
		}
		const read = Str.slice(at, at + step.value.length)(text)
		at += step.value.length
		if (step.value.name === "xdstop") {
			return { content, end: at }
		}
		content += step.value.name === "xddouble" ? '"' : read
	}
}

/** A string constant's token, or the string literal unclosed at `errorAt`. */
const stringToken = (
	text: string,
	start: number,
	from: number,
	state: StringState,
	prefix: string | undefined,
	errorAt: number
): Scanned => {
	const read = stringFrom(text, from, state)
	return read === undefined
		? unclosedAt("string literal", errorAt)
		: on(read.end, Option.some({ kind: "string", text: read.content, prefix, start }))
}

/** A quoted identifier's token, refused when empty, or the quoted identifier unclosed at its start. */
const identifierToken = (text: string, start: number, from: number): Scanned => {
	const read = identifierFrom(text, from)
	if (read === undefined) {
		return unclosedAt("quoted identifier", start)
	}
	return read.content === ""
		? refusedRun(text, start, read.end)
		: on(read.end, Option.some({ kind: "quotedIdent", text: read.content, start }))
}

/** A block comment from `start`, nested comments included: the offset after it, or the comment unclosed at `start`. */
const commentFrom = (text: string, start: number): Scanned => {
	const rules = commentRules()
	let depth = 1
	let at = start + 2
	while (depth > 0) {
		const step = longest<string>(rules, text, at)
		if (Option.isNone(step)) {
			return unclosedAt("block comment", start)
		}
		switch (step.value.name) {
			case "xcstart":
				depth += 1
				at += 2
				break
			case "xcstop":
				depth -= 1
				at += step.value.length
				break
			default:
				at += step.value.length
		}
	}
	return on(at, Option.none())
}

/** A dollar-quoted string opened by `tag` at `start`: its token, or the string unclosed at `start`. */
const dollarFrom = (text: string, start: number, tag: string): Scanned => {
	const rules = dollarRules()
	const bodyStart = start + tag.length
	let at = bodyStart
	for (;;) {
		const step = longest<string>(rules, text, at)
		if (Option.isNone(step)) {
			return unclosedAt("dollar-quoted string", start)
		}
		const read = Str.slice(at, at + step.value.length)(text)
		if (step.value.name === "dolqdelim" && read === tag) {
			return on(
				at + read.length,
				Option.some({
					kind: "dollar",
					tag,
					body: Str.slice(bodyStart, at)(text),
					bodyStart,
					start
				})
			)
		}
		at += step.value.name === "dolqdelim" ? read.length - 1 : read.length
	}
}

/** An operator run from `start`, cut as scan.l's operator action cuts it: its token and the offset after it. */
const operatorFrom = (start: number, run: string): Scanned => {
	const cut = Arr.getSomes([Str.indexOf("/*")(run), Str.indexOf("--")(run)])
	const nchars = Arr.reduce(cut, run.length, (n, k) => (k < n ? k : n))
	const signAt = (k: number): boolean => {
		const c = Str.slice(k, k + 1)(run)
		return c === "+" || c === "-"
	}
	const nonArithmetic = Arr.some(Str.split(Str.slice(0, nchars - 1)(run), ""), (c) =>
		Str.includes(c)("~!@#^&|`?%")
	)
	let chars = nchars
	if (chars > 1 && signAt(chars - 1) && !nonArithmetic) {
		chars -= 1
		while (chars > 1 && signAt(chars - 1)) {
			chars -= 1
		}
	}
	return on(start + chars, Option.some({ kind: "operator", text: Str.slice(0, chars)(run), start }))
}

const punctuation: ReadonlySet<string> = new Set([",", "(", ")", "[", "]", ".", ";", ":"])

const numberToken = (start: number, text: string): Scanned =>
	on(start + text.length, Option.some({ kind: "number", text, start }))

/** One step of the initial state at `at`. */
const stepAt = (text: string, at: number, rules: ReturnType<typeof initialRules>): Scanned => {
	const step = longest<(typeof rules)[number]["name"]>(rules, text, at)
	if (Option.isNone(step)) {
		return refusedRun(text, at, at + 1)
	}
	const read = Str.slice(at, at + step.value.length)(text)
	switch (step.value.name) {
		case "whitespace":
			return on(at + read.length, Option.none())
		case "xcstart":
			return commentFrom(text, at)
		case "xbstart":
		case "xhstart":
			return stringToken(text, at, at + 2, "bit", raised(Str.slice(0, 1)(read)), at)
		case "xnstart":
			return stringToken(text, at, at + 2, "standard", "N", at + 1)
		case "xqstart":
			return stringToken(text, at, at + 1, "standard", undefined, at)
		case "xestart":
			return stringToken(text, at, at + 2, "escape", "E", at)
		case "xusstart":
			return stringToken(text, at, at + 3, "standard", "U&", at)
		case "dolqdelim":
			return dollarFrom(text, at, read)
		case "xdstart":
			return identifierToken(text, at, at + 1)
		case "xuistart":
			return identifierToken(text, at, at + 3)
		case "xufailed":
			return on(
				at + 1,
				Option.some({ kind: "word", text: Str.slice(0, 1)(read), upper: "U", start: at })
			)
		case "typecast":
		case "dot_dot":
		case "colon_equals":
			return on(at + read.length, Option.some({ kind: "punct", text: read, start: at }))
		case "open_paren":
			return psqlOn(at + 1, { kind: "punct", text: read, start: at }, { kind: "open" })
		case "close_paren":
			return psqlOn(at + 1, { kind: "punct", text: read, start: at }, { kind: "close" })
		case "semicolon":
			return psqlOn(at + 1, { kind: "punct", text: read, start: at }, { kind: "semicolon" })
		case "equals_greater":
		case "less_equals":
		case "greater_equals":
		case "less_greater":
		case "not_equals":
			return on(at + read.length, Option.some({ kind: "operator", text: read, start: at }))
		case "self":
			return on(
				at + 1,
				Option.some({
					kind: punctuation.has(read) ? "punct" : "operator",
					text: read,
					start: at
				})
			)
		case "operator":
			return operatorFrom(at, read)
		case "param":
			return on(
				at + read.length,
				Option.some({ kind: "param", index: Number(Str.slice(1)(read)), start: at })
			)
		case "decinteger":
		case "hexinteger":
		case "octinteger":
		case "bininteger":
		case "numeric":
		case "real":
			return numberToken(at, read)
		case "numericfail":
		case "realfail":
			return numberToken(at, Str.slice(0, -2)(read))
		case "identifier":
			return psqlOn(
				at + read.length,
				{ kind: "word", text: read, upper: raised(read), start: at },
				{ kind: "identifier", identifier: read }
			)
		case "dolqfailed":
			return refusedRun(text, at, at + 1)
		case "param_junk":
		case "hexfail":
		case "octfail":
		case "binfail":
		case "integer_junk":
		case "numeric_junk":
		case "real_junk":
		case "other":
			return refusedRun(text, at, at + read.length)
	}
}

/** The length of init_idents (psqlscan_int.h). */
const initIdentsSize = 8

/** The keywords psqlscan_record_initial_keyword records by their first letter, lowercased or uppercased. */
const loweredKeywords: ReadonlySet<string> = new Set([
	"CREATE",
	"FUNCTION",
	"PROCEDURE",
	"OR",
	"REPLACE"
])
const raisedKeywords: ReadonlySet<string> = new Set(["COPY", "FROM", "STDIN", "STDOUT"])

/** What psqlscan_record_initial_keyword records for an identifier: its first letter, or "" for '\0'. */
const initialKeyword = (identifier: string): string => {
	const first = Str.slice(0, 1)(identifier)
	if (loweredKeywords.has(raised(identifier))) {
		return Str.toLowerCase(first)
	}
	return raisedKeywords.has(raised(identifier)) ? Str.toUpperCase(first) : ""
}

/** psqlscan_is_create_routine. */
const isCreateRoutine = (idents: ReadonlyArray<string>): boolean =>
	idents[0] === "c" &&
	(idents[1] === "f" ||
		idents[1] === "p" ||
		(idents[1] === "o" && idents[2] === "r" && (idents[3] === "f" || idents[3] === "p")))

/** psql's scan state of a statement (psqlscan_int.h), and its actions on what a rule read. */
class PsqlState {
	parenDepth = 0
	beginDepth = 0
	initIdentsCount = 0
	initIdents: Array<string> = Arr.replicate("", initIdentsSize)

	/** psqlscan_track_identifier. */
	trackIdentifier(identifier: string): void {
		if (this.parenDepth !== 0) {
			return
		}
		if (this.initIdentsCount === 0) {
			this.initIdents = Arr.replicate("", initIdentsSize)
		}
		if (this.initIdentsCount < initIdentsSize) {
			this.initIdents[this.initIdentsCount] = initialKeyword(identifier)
			this.initIdentsCount += 1
		}
		if (isCreateRoutine(this.initIdents)) {
			const word = raised(identifier)
			if (word === "BEGIN") {
				this.beginDepth += 1
			} else if (word === "CASE") {
				if (this.beginDepth >= 1) {
					this.beginDepth += 1
				}
			} else if (word === "END") {
				if (this.beginDepth > 0) {
					this.beginDepth -= 1
				}
			}
		}
	}

	/** The lexeme a rule's action leaves: its own, or the terminator of the statement a semicolon ends. */
	act(action: PsqlAction, lexeme: Lexeme): Lexeme {
		switch (action.kind) {
			case "echo":
				return lexeme
			case "open":
				this.parenDepth += 1
				return lexeme
			case "close":
				if (this.parenDepth > 0) {
					this.parenDepth -= 1
				}
				return lexeme
			case "semicolon":
				if (this.parenDepth === 0 && this.beginDepth === 0) {
					this.initIdentsCount = 0
					return { kind: "terminator", start: lexeme.start }
				}
				return lexeme
			case "identifier":
				this.trackIdentifier(action.identifier)
				return lexeme
		}
	}
}

/**
 * The lexemes PostgreSQL's scanner reads from `text`, as the lexer's, up to a quote or block comment it never closes,
 * each semicolon that ends a statement as psql's scanner reads it a terminator; a refused run's message is never
 * compared.
 */
export const scan = (text: string): Lexemes => {
	const rules = initialRules()
	const lexemes: Array<Lexeme> = []
	const psql = new PsqlState()
	let at = 0
	while (at < text.length) {
		const step = stepAt(text, at, rules)
		if (step.kind === "unclosed") {
			return { lexemes, unclosed: { opener: step.opener, offset: step.offset } }
		}
		if (Option.isSome(step.lexeme)) {
			lexemes.push(psql.act(step.psql, step.lexeme.value))
		}
		at = step.next
	}
	return { lexemes, unclosed: undefined }
}
