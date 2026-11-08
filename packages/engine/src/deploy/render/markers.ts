import { appendAll } from "#compiler/core/array.ts"
import { type Lexeme, lex, lexemesOf, type Token } from "#compiler/sql/lexer.ts"
import { placeholderToken } from "#compiler/sql/print.ts"

export const noTransactionMarker = "-- grizzle: no-transaction"
export const placeholderMarker = "-- grizzle: placeholder"
/** A confirm: statements the reviewer keeps whole or removes whole, drafted below this line, which says why and how. */
export const confirmMarker = "-- grizzle: confirm"
/** A loss: a statement that loses stored data, drafted commented below this line, which says what it loses and how to
 * decide it. The decision is the statement itself, written in or left out (`lossDecisions`), so the
 * line is no marker `grizzle migrate` refuses: it may stay. */
export const lossMarker = "-- grizzle: data loss"

/** Character classes, spelled out: the compiler constructs no RegExp. */
export const isDigit = (ch: string | undefined): boolean =>
	ch !== undefined && ch >= "0" && ch <= "9"

/** The lines of a text, a trailing carriage return dropped from each. */
const textLines = (text: string): ReadonlyArray<string> =>
	text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))

/** Lowercase ASCII letters and digits in words joined by single `_` or `-`. */
export const isWords = (text: string): boolean => {
	let separator = true
	for (const ch of text) {
		const joins = ch === "_" || ch === "-"
		if (joins ? separator : !(isDigit(ch) || (ch >= "a" && ch <= "z"))) {
			return false
		}
		separator = joins
	}
	return !separator
}

type MarkerKind = "placeholder" | "confirm"

interface FoundMarker {
	readonly kind: MarkerKind
	/** 1-based line number. */
	readonly line: number
}

/** The offsets of the placeholder token in `text` at or after `from`, in order, at most `limit` of them. */
const tokenOffsets = (text: string, from: number, limit: number): ReadonlyArray<number> => {
	const out: Array<number> = []
	for (let at = from; at < text.length && out.length < limit; at++) {
		if (text.startsWith(placeholderToken, at)) {
			out.push(at)
		}
	}
	return out
}

/** A lexeme's text, holding as many placeholder tokens as the lexeme's source: a quoted identifier's or a string
 * constant's content reads each doubled quote as one, which never joins or splits a placeholder token, since it holds
 * no quote; a dollar-quoted string is its tags and body; a positional parameter is `$` and digits; a refused run is its
 * source; a terminator is its semicolon. */
const lexemeText = (t: Lexeme): string => {
	switch (t.kind) {
		case "word":
		case "quotedIdent":
		case "string":
		case "number":
		case "operator":
		case "punct":
		case "refused":
			return t.text
		case "dollar":
			return `${t.tag}${t.body}${t.tag}`
		case "param":
			return ""
		case "terminator":
			return ";"
	}
}

/** The 0-based lines holding a placeholder token in the SQL of `text`: in a lexeme PostgreSQL's scanner reads, a run
 * it refuses among them, never in a line or block comment. A lexeme's source begins at its start, so the placeholder
 * tokens its text holds are the first that many from there. Past a quote or block comment the text never closes
 * nothing is known to be a comment, so every placeholder token there counts. */
const placeholderLines = (text: string): ReadonlySet<number> => {
	if (!text.includes(placeholderToken)) {
		return new Set()
	}
	const { lexemes, unclosed } = lexemesOf(text)
	const offsets: Array<number> = []
	for (const t of lexemes) {
		const held = tokenOffsets(lexemeText(t), 0, Number.POSITIVE_INFINITY).length
		if (held > 0) {
			appendAll(offsets, tokenOffsets(text, t.start, held))
		}
	}
	if (unclosed !== undefined) {
		appendAll(offsets, tokenOffsets(text, unclosed.offset, Number.POSITIVE_INFINITY))
	}
	const lines = new Set<number>()
	let line = 0
	let scanned = 0
	for (const at of offsets) {
		for (; scanned < at; scanned++) {
			line += text[scanned] === "\n" ? 1 : 0
		}
		lines.add(line)
	}
	return lines
}

/** Every unresolved placeholder and confirm in a file's text: a line that starts with a marker, or holds a
 * placeholder token in its SQL.
 *
 * The markers of drafted migration files, and the reading of a file `grizzle migrate` runs.
 *
 * - `-- grizzle: no-transaction` as a file's first line: each statement of the file runs alone.
 * - A placeholder: a drafted value the generator cannot invent, which the reviewer must supply. It is
 *   the bare token `__GRIZZLE_PLACEHOLDER__` where the value goes, which no SQL accepts as a value (PostgreSQL reads it
 *   as a column reference, refused in DEFAULT), preceded by a `-- grizzle: placeholder` line that says what to supply.
 * - A confirm: a `-- grizzle: confirm` line before drafted statements the reviewer keeps whole or removes whole, such
 *   as a holder renamed aside.
 * - A loss: a `-- grizzle: data loss` line above a commented statement that loses stored data, which the reviewer
 *   writes in to accept the loss; meta.json records it, and `grizzle check` reads the decision from the SQL.
 *
 * A reviewed statement is compared with a drafted one as PostgreSQL's scanner reads both (statementTokens, writtenAs),
 * never as text.
 *
 * `grizzle migrate` refuses a file that still contains a placeholder token in its SQL or either marker line, before any
 * statement of its folder runs (findMarkers). A reviewer resolves a marker by supplying the value or confirming the
 * statements, and then deletes the marker line. A token in a comment is no placeholder: a commented loss may hold one,
 * and it becomes SQL, with its placeholder line, only when the reviewer uncomments it. */
export const findMarkers = (text: string): ReadonlyArray<FoundMarker> => {
	const out: Array<FoundMarker> = []
	const placeholders = placeholderLines(text)
	for (const [i, raw] of textLines(text).entries()) {
		const line = raw.trimStart()
		if (line.startsWith(placeholderMarker) || placeholders.has(i)) {
			out.push({ kind: "placeholder", line: i + 1 })
		} else if (line.startsWith(confirmMarker)) {
			out.push({ kind: "confirm", line: i + 1 })
		}
	}
	return out
}

/** Whether a file runs statement by statement: its first line is exactly the no-transaction marker, trailing spaces
 * aside. */
export const isNoTransaction = (text: string): boolean => {
	const end = text.indexOf("\n")
	const firstLine = end === -1 ? text : text.slice(0, end)
	return firstLine.trimEnd() === noTransactionMarker
}

/** The statements of a file, for a no-transaction file that runs each alone: the text split at the terminators psql's
 * scanner reads (lexemesOf), so a semicolon in a comment, a quoted identifier, a string constant, a dollar-quoted body,
 * a parenthesis or the BEGIN block of a routine's body never splits, and pieces that hold only comments and whitespace
 * dropped. Each statement keeps its leading comments and loses its terminator. A run the scanner refuses, such as
 * `""`, is part of its statement, which PostgreSQL then refuses alone when it runs. A quote or comment the text opens
 * and never closes takes the rest of the text into the piece it starts, which PostgreSQL then refuses when it runs; a
 * block comment left open is no statement of its own. */
export const splitStatements = (text: string): ReadonlyArray<string> => {
	const { lexemes, unclosed } = lexemesOf(text)
	const out: Array<string> = []
	let start = 0
	let substantive = false
	for (const t of lexemes) {
		const ends = t.kind === "terminator"
		if (ends && substantive) {
			out.push(text.slice(start, t.start).trim())
		}
		if (ends) {
			start = t.start + 1
		}
		substantive = !ends
	}
	if (substantive || (unclosed !== undefined && unclosed.opener !== "block comment")) {
		out.push(text.slice(start).trim())
	}
	return out
}

/** A token of a statement as PostgreSQL's scanner reads it, in the form two statements are compared in: an unquoted
 * word by its ASCII uppercase form, since PostgreSQL folds an unquoted word's case, keyword or name; a quoted
 * identifier and a string constant by their content, the string with its prefix, so a doubled quote and its escape
 * compare alike; a dollar-quoted string by its body, since its tag only quotes it; every other token by its text; and
 * what the scanner could not read, from where it stopped, as one unread rest. Whitespace and comments are no tokens. A
 * quoted identifier is never an unquoted word: `"current_user"` names a column where `current_user` calls a function. */
export type StatementToken =
	| { readonly kind: "word"; readonly upper: string }
	| {
			readonly kind: "quotedIdent" | "number" | "operator" | "punct" | "unread"
			readonly text: string
	  }
	| { readonly kind: "string"; readonly prefix: string | undefined; readonly text: string }
	| { readonly kind: "dollar"; readonly body: string }
	| { readonly kind: "param"; readonly index: number }

/** One token in the form two statements are compared in. */
const statementToken = (t: Token): StatementToken => {
	switch (t.kind) {
		case "word":
			return { kind: "word", upper: t.upper }
		case "quotedIdent":
		case "number":
		case "operator":
		case "punct":
			return { kind: t.kind, text: t.text }
		case "string":
			return { kind: "string", prefix: t.prefix, text: t.text }
		case "dollar":
			return { kind: "dollar", body: t.body }
		case "param":
			return { kind: "param", index: t.index }
	}
}

/** The tokens of a statement (StatementToken), as `grizzle check` compares a reviewed statement with a drafted one. */
export const statementTokens = (statement: string): ReadonlyArray<StatementToken> => {
	const { tokens, error } = lex(statement)
	const out = tokens.map((t) => statementToken(t))
	return error === undefined
		? out
		: [...out, { kind: "unread", text: statement.slice(error.offset) }]
}

const sameToken = (a: StatementToken, b: StatementToken): boolean => {
	switch (a.kind) {
		case "word":
			return b.kind === "word" && a.upper === b.upper
		case "quotedIdent":
		case "number":
		case "operator":
		case "punct":
		case "unread":
			return b.kind === a.kind && a.text === b.text
		case "string":
			return b.kind === "string" && a.prefix === b.prefix && a.text === b.text
		case "dollar":
			return b.kind === "dollar" && a.body === b.body
		case "param":
			return b.kind === "param" && a.index === b.index
	}
}

const placeholderUpper = placeholderToken.toUpperCase()

/** Whether a drafted token is the placeholder token, a hole the reviewer's value fills. */
const isHole = (t: StatementToken): boolean => t.kind === "word" && t.upper === placeholderUpper

/** Whether tokens nest their parentheses and brackets, as a value's do. */
const balanced = (tokens: ReadonlyArray<StatementToken>): boolean => {
	let depth = 0
	for (const t of tokens) {
		if (t.kind !== "punct") {
			continue
		}
		if (t.text === "(" || t.text === "[") {
			depth++
		} else if (t.text === ")" || t.text === "]") {
			depth--
		}
		if (depth < 0) {
			return false
		}
	}
	return depth === 0
}

/** Whether a written statement is a drafted one (both statementTokens): token for token, each placeholder token of the
 * drafted statement filled by one token or more whose parentheses and brackets balance, the value the reviewer wrote
 * there. A drafted statement without a placeholder is written exactly when the tokens are the same. */
export const writtenAs = (
	drafted: ReadonlyArray<StatementToken>,
	written: ReadonlyArray<StatementToken>
): boolean => {
	/** Whether the drafted tokens from `i` are written from `j`: alike up to the next hole, then the hole filled by each
	 * balanced run in turn. */
	const from = (i: number, j: number): boolean => {
		let n = 0
		for (;;) {
			const d = drafted[i + n]
			if (d === undefined) {
				return j + n === written.length
			}
			if (isHole(d)) {
				break
			}
			const w = written[j + n]
			if (w === undefined || !sameToken(d, w)) {
				return false
			}
			n++
		}
		const at = j + n
		for (let k = at + 1; k <= written.length; k++) {
			if (balanced(written.slice(at, k)) && from(i + n + 1, k)) {
				return true
			}
		}
		return false
	}
	return from(0, 0)
}
