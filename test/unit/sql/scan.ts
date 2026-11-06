import { regex } from "arkregex"
import { Array as Arr, Option, String as Str } from "effect"
import type { Lexed, Token } from "#compiler/sql/lexer.ts"

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
 * A token PostgreSQL refuses, and a character it returns as {other} for its grammar to refuse, is the error at the
 * offset PostgreSQL reports it at. An escape's value is never read, so a literal PostgreSQL refuses for what an escape
 * denotes is read as written.
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

/** Where a scan stands after one step: the offset it goes on from, with a token or none, or the error that ends it. */
type Scanned =
	| { readonly kind: "on"; readonly next: number; readonly token: Option.Option<Token> }
	| { readonly kind: "error"; readonly offset: number }

const on = (next: number, token: Option.Option<Token>): Scanned => ({ kind: "on", next, token })
const refusedAt = (offset: number): Scanned => ({ kind: "error", offset })

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

/** A string constant's token, or its error: unterminated at `errorAt`. */
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
		? refusedAt(errorAt)
		: on(read.end, Option.some({ kind: "string", text: read.content, prefix, start }))
}

/** A quoted identifier's token, or its error: unterminated or empty, at its start. */
const identifierToken = (text: string, start: number, from: number): Scanned => {
	const read = identifierFrom(text, from)
	return read === undefined || read.content === ""
		? refusedAt(start)
		: on(read.end, Option.some({ kind: "quotedIdent", text: read.content, start }))
}

/** A block comment from `start`, nested comments included: the offset after it, or its error at `start`. */
const commentFrom = (text: string, start: number): Scanned => {
	const rules = commentRules()
	let depth = 1
	let at = start + 2
	while (depth > 0) {
		const step = longest<string>(rules, text, at)
		if (Option.isNone(step)) {
			return refusedAt(start)
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

/** A dollar-quoted string opened by `tag` at `start`: its token, or its error at `start`. */
const dollarFrom = (text: string, start: number, tag: string): Scanned => {
	const rules = dollarRules()
	const bodyStart = start + tag.length
	let at = bodyStart
	for (;;) {
		const step = longest<string>(rules, text, at)
		if (Option.isNone(step)) {
			return refusedAt(start)
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
		return refusedAt(at)
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
			return on(
				at + read.length,
				Option.some({ kind: "word", text: read, upper: raised(read), start: at })
			)
		case "dolqfailed":
		case "param_junk":
		case "hexfail":
		case "octfail":
		case "binfail":
		case "integer_junk":
		case "numeric_junk":
		case "real_junk":
		case "other":
			return refusedAt(at)
	}
}

/**
 * The tokens PostgreSQL's scanner reads from `text`, up to the error it stops at, as the lexer's tokens; the error's
 * message is scan.l's rule, never compared.
 */
export const scan = (text: string): Lexed => {
	const rules = initialRules()
	const tokens: Array<Token> = []
	let at = 0
	while (at < text.length) {
		const step = stepAt(text, at, rules)
		if (step.kind === "error") {
			return { tokens, error: { offset: step.offset, message: "refused by scan.l" } }
		}
		if (Option.isSome(step.token)) {
			tokens.push(step.token.value)
		}
		at = step.next
	}
	return { tokens, error: undefined }
}
