import { regex } from "arkregex"
/**
 * A JavaScript tokenizer for the dependency audit. It reads the erased JavaScript that Node's type stripping
 * produces from each src/ module, so it needs no TypeScript syntax: types are blanked to spaces, positions
 * and lines are kept.
 *
 * It skips comments, keeps string and template text out of the code stream, and tells a regular expression literal
 * from a division the usual way: a `/` begins a regex where an expression may begin, after an operator, an opening
 * bracket, a comma, a statement keyword, or at the start of input; it is a division after a value.
 *
 * A `)` or `}` is a value only in an expression. After the `)` of a statement header (if, for, while, with, switch,
 * catch, a function's parameters) and after the `}` of a block, a statement begins, so a `/` there begins a regex.
 * The tokenizer tracks both: each `(` remembers whether it opens a header, and each `{` whether it opens a block,
 * which it does after a header's `)`, `=>`, else, do, try, finally, `;`, another block's `{` or `}`, or at the start
 * of input. A function expression's `}` is read as a block's, so a division right after one reads as a regex: an
 * extra finding or a lexing error, never a missed regex.
 */
import { Array as Arr, Data, Option, String as Str } from "effect"
export type TokenKind =
	| "ident"
	| "punct"
	| "string"
	| "number"
	| "regex"
	| "privateName"
	| "template"
	| "templateHead"

export interface Token {
	readonly kind: TokenKind
	readonly text: string
	readonly line: number
}

/** Identifiers after which a `/` begins an expression, so a regex literal. */
const expressionKeywords: ReadonlySet<string> = new Set([
	"return",
	"typeof",
	"instanceof",
	"in",
	"of",
	"new",
	"delete",
	"void",
	"throw",
	"case",
	"do",
	"else",
	"yield",
	"await",
	"extends"
])

const isIdentStart = (c: string): boolean =>
	regex("[A-Za-z_$\\\\]").test(c) || Option.exists(Str.charCodeAt(c, 0), (code) => code > 0x7f)

const isIdentPart = (c: string): boolean =>
	regex("[A-Za-z0-9_$\\\\]").test(c) || Option.exists(Str.charCodeAt(c, 0), (code) => code > 0x7f)
const isDigit = (c: string): boolean => c >= "0" && c <= "9"

/**
 * The punctuators longer than one character that change how the next token reads; every other character is a
 * one-character punctuator.
 */
const multi = ["?.", "...", "++", "--", "=>"] as const

/** Keywords whose parenthesized head is followed by a statement or a block, not by an operator. */
const headerKeywords: ReadonlySet<string> = new Set([
	"if",
	"for",
	"while",
	"with",
	"switch",
	"catch"
])

/** Keywords after which a `{` opens a block. */
const blockKeywords: ReadonlySet<string> = new Set(["else", "do", "try", "catch", "finally"])

/**
 * Whether the `(` about to be pushed opens a statement header: after a header keyword (for await included), or a
 * function's parameter list, `function (`, `function name(` or `function* name(`.
 */
const opensHeader = (tokens: ReadonlyArray<Token>): boolean => {
	const at = (back: number): Token | undefined => tokens[tokens.length - back]
	/** Any identifier, or the identifier `text`. */
	const ident = (t: Token | undefined): boolean => t?.kind === "ident"
	const word = (t: Token | undefined, text: string): boolean =>
		t?.kind === "ident" && t.text === text
	const prev = at(1)
	if (prev === undefined) {
		return false
	}
	if (ident(prev) && headerKeywords.has(prev.text)) {
		return true
	}
	if (word(prev, "await") && word(at(2), "for")) {
		return true
	}
	if (word(prev, "function")) {
		return true
	}
	if (ident(prev) && word(at(2), "function")) {
		return true
	}
	if (ident(prev) && at(2)?.kind === "punct" && at(2)?.text === "*" && word(at(3), "function")) {
		return true
	}
	return prev.kind === "punct" && prev.text === "*" && word(at(2), "function")
}

/** `statementAfter` holds the indices of the `)` and `}` tokens after which a statement begins. */
const regexAllowedAfter = (
	prev: Token | undefined,
	index: number,
	statementAfter: ReadonlySet<number>
): boolean => {
	if (prev === undefined) {
		return true
	}
	switch (prev.kind) {
		case "number":
		case "string":
		case "template":
		case "regex":
		case "privateName":
			return false
		case "templateHead":
			return true
		case "ident":
			return expressionKeywords.has(prev.text)
		case "punct":
			if (prev.text === ")" || prev.text === "}") {
				return statementAfter.has(index)
			}
			return !(prev.text === "]" || prev.text === "++" || prev.text === "--")
	}
}

/** Whether a `{` after this token opens a block rather than an object literal or a type. */
const opensBlock = (
	prev: Token | undefined,
	index: number,
	statementAfter: ReadonlySet<number>
): boolean => {
	if (prev === undefined) {
		return true
	}
	if (prev.kind === "ident") {
		return blockKeywords.has(prev.text)
	}
	if (prev.kind !== "punct") {
		return false
	}
	if (prev.text === ")") {
		return statementAfter.has(index)
	}
	return prev.text === ";" || prev.text === "{" || prev.text === "}" || prev.text === "=>"
}

class LexError extends Data.TaggedError("LexError")<{ readonly message: string }> {}

export const tokenize = (source: string): ReadonlyArray<Token> => {
	const tokens: Array<Token> = []
	/** One entry per open brace: a block's, an expression's (an object literal, a class body), or a substitution's. */
	const braces: Array<"block" | "expression" | "template"> = []
	/** One entry per open parenthesis: whether it opens a statement header. */
	const parens: Array<boolean> = []
	const statementAfter = new Set<number>()
	const last = (): Token | undefined => tokens[tokens.length - 1]
	let i = 0
	let line = 1
	const push = (kind: TokenKind, text: string, startLine: number) => {
		tokens.push({ kind, text, line: startLine })
	}
	const fail: (message: string) => never = (message) => {
		throw new LexError({ message: `line ${line}: ${message}` })
	}
	const newlines = (text: string) => {
		for (const c of text) {
			if (c === "\n") {
				line += 1
			}
		}
	}
	/** Scans template text from i, just after a backtick or a substitution's closing brace. */
	const template = (startLine: number, open: string) => {
		let j = i
		while (j < source.length) {
			const c = source[j]
			if (c === "\\") {
				j += 2
			} else if (c === "`") {
				const text = Str.slice(i, j + 1)(source)
				push("template", open + text, startLine)
				newlines(text)
				i = j + 1
				return
			} else if (c === "$" && source[j + 1] === "{") {
				const text = Str.slice(i, j + 2)(source)
				push("templateHead", open + text, startLine)
				newlines(text)
				braces.push("template")
				i = j + 2
				return
			} else {
				j += 1
			}
		}
		fail("unterminated template")
	}
	if (Str.startsWith("#!")(source)) {
		while (i < source.length && source[i] !== "\n") {
			i += 1
		}
	}
	for (let at = Str.charAt(source, i); Option.isSome(at); at = Str.charAt(source, i)) {
		const c = at.value
		const next = source[i + 1]
		if (c === "\n") {
			line += 1
			i += 1
		} else if (
			c === " " ||
			c === "\t" ||
			c === "\r" ||
			c === "\f" ||
			c === "\v" ||
			c === "\ufeff"
		) {
			i += 1
		} else if (c === "/" && next === "/") {
			while (i < source.length && source[i] !== "\n") {
				i += 1
			}
		} else if (c === "/" && next === "*") {
			const after = Str.indexOf("*/")(Str.slice(i + 2)(source))
			if (Option.isNone(after)) {
				fail("unterminated comment")
			}
			const end = i + 2 + after.value
			newlines(Str.slice(i, end + 2)(source))
			i = end + 2
		} else if (c === '"' || c === "'") {
			let j = i + 1
			while (j < source.length && source[j] !== c) {
				if (source[j] === "\\") {
					j += 1
				}
				if (source[j] === "\n") {
					fail("newline in a string")
				}
				j += 1
			}
			if (j >= source.length) {
				fail("unterminated string")
			}
			push("string", Str.slice(i + 1, j)(source), line)
			i = j + 1
		} else if (c === "`") {
			const startLine = line
			i += 1
			template(startLine, "`")
		} else if (c === "{") {
			braces.push(opensBlock(last(), tokens.length - 1, statementAfter) ? "block" : "expression")
			push("punct", c, line)
			i += 1
		} else if (c === "(") {
			parens.push(opensHeader(tokens))
			push("punct", c, line)
			i += 1
		} else if (c === ")") {
			const header = parens.pop()
			if (header === undefined) {
				fail("unbalanced parentheses")
			}
			push("punct", c, line)
			if (header) {
				statementAfter.add(tokens.length - 1)
			}
			i += 1
		} else if (c === "}") {
			const top = braces.pop()
			if (top === "template") {
				const startLine = line
				i += 1
				template(startLine, "}")
			} else {
				push("punct", c, line)
				if (top === "block") {
					statementAfter.add(tokens.length - 1)
				}
				i += 1
			}
		} else if (c === "/" && regexAllowedAfter(last(), tokens.length - 1, statementAfter)) {
			let j = i + 1
			let inClass = false
			while (j < source.length) {
				const d = source[j]
				if (d === "\n") {
					fail("newline in a regular expression literal")
				}
				if (d === "\\") {
					j += 1
				} else if (d === "[") {
					inClass = true
				} else if (d === "]") {
					inClass = false
				} else if (d === "/" && !inClass) {
					break
				}
				j += 1
			}
			if (j >= source.length) {
				fail("unterminated regular expression literal")
			}
			j += 1
			while (Option.exists(Str.charAt(source, j), (flag) => regex("[a-z]").test(flag))) {
				j += 1
			}
			push("regex", Str.slice(i, j)(source), line)
			i = j
		} else if (isDigit(c) || (c === "." && next !== undefined && isDigit(next))) {
			let j = i + 1
			for (let d = Str.charAt(source, j); Option.isSome(d); d = Str.charAt(source, j)) {
				if (regex("[0-9A-Za-z_.]").test(d.value)) {
					j += 1
				} else if (
					(d.value === "+" || d.value === "-") &&
					Option.exists(Str.charAt(source, j - 1), (before) => regex("[eE]").test(before)) &&
					!regex("^0[xX]").test(Str.slice(i, j)(source))
				) {
					j += 1
				} else {
					break
				}
			}
			push("number", Str.slice(i, j)(source), line)
			i = j
		} else if (c === "#" && next !== undefined && isIdentStart(next)) {
			let j = i + 1
			while (Option.exists(Str.charAt(source, j), isIdentPart)) {
				j += 1
			}
			push("privateName", Str.slice(i, j)(source), line)
			i = j
		} else if (isIdentStart(c)) {
			let j = i
			while (Option.exists(Str.charAt(source, j), isIdentPart)) {
				j += 1
			}
			push("ident", Str.slice(i, j)(source), line)
			i = j
		} else {
			const text = Option.getOrElse(
				Arr.findFirst(
					multi,
					(m) => Str.startsWith(m, i)(source) && !(m === "?." && isDigit(source[i + 2] ?? ""))
				),
				() => c
			)
			push("punct", text, line)
			i += text.length
		}
	}
	if (braces.length > 0) {
		fail("unbalanced braces")
	}
	if (parens.length > 0) {
		fail("unbalanced parentheses")
	}
	return tokens
}
