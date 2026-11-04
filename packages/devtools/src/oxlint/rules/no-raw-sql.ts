import { Array as Arr, Schema, String as Str } from "effect"
import { configured, isFileAt } from "#oxlint/rule.ts"

/** The source directories whose code holds no SQL text, and the modules there that write it. */
const Options = Schema.Struct({
	sources: Schema.Array(Schema.String),
	writers: Schema.Array(Schema.String)
})

const MESSAGE =
	"SQL is printed from an AST by the engine's printer, never written as text: this string holds a cast as SQL text spells it, outside any quoted SQL string, identifier or comment."

/** The position after the quote that closes a quoted run opened before `from`: a doubled quote is the quote itself. */
const closing = (text: string, from: number, quote: string): number => {
	let at = from
	while (at < text.length) {
		if (text[at] === quote) {
			if (text[at + 1] !== quote) {
				return at + 1
			}
			at += 2
		} else {
			at += 1
		}
	}
	return text.length
}

/** The position after a block comment opened before `from`: block comments nest. */
const commentEnd = (text: string, from: number): number => {
	let depth = 1
	let at = from
	while (at < text.length && depth > 0) {
		if (text[at] === "/" && text[at + 1] === "*") {
			depth += 1
			at += 2
		} else if (text[at] === "*" && text[at + 1] === "/") {
			depth -= 1
			at += 2
		} else {
			at += 1
		}
	}
	return at
}

const isTagStart = (ch: string | undefined): boolean =>
	ch !== undefined && ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_")

const isTagPart = (ch: string | undefined): boolean =>
	isTagStart(ch) || (ch !== undefined && ch >= "0" && ch <= "9")

/** The length of the dollar-quote tag opening at `at`, `$$` or `$tag$`; 0 where a `$` opens no quote, as a
 * parameter's does. */
const dollarTagLength = (text: string, at: number): number => {
	if (text[at + 1] === "$") {
		return 2
	}
	if (!isTagStart(text[at + 1])) {
		return 0
	}
	let end = at + 1
	while (isTagPart(text[end])) {
		end += 1
	}
	return text[end] === "$" ? end + 1 - at : 0
}

/** Whether the `length` characters at `at` are the ones at `from`. */
const sameRun = (text: string, at: number, from: number, length: number): boolean => {
	for (let i = 0; i < length; i++) {
		if (text[at + i] !== text[from + i]) {
			return false
		}
	}
	return true
}

/** The position after the tag that closes a dollar-quoted body whose `length`-character tag opens at `open`. */
const dollarEnd = (text: string, open: number, length: number): number => {
	for (let at = open + length; at < text.length; at++) {
		if (text[at] === "$" && sameRun(text, at, open, length)) {
			return at + length
		}
	}
	return text.length
}

/** The position after the line a line comment at `from` ends. */
const lineEnd = (text: string, from: number): number => {
	for (let at = from; at < text.length; at++) {
		if (text[at] === "\n") {
			return at + 1
		}
	}
	return text.length
}

/**
 * Whether `text`, read as SQL as PostgreSQL's scanner reads it, holds a `::` token: outside its quoted strings and
 * identifiers, its dollar-quoted bodies and its comments.
 */
const holdsCast = (text: string): boolean => {
	let at = 0
	while (at < text.length) {
		const ch = text[at]
		const next = text[at + 1]
		const tag = ch === "$" ? dollarTagLength(text, at) : 0
		if (ch === "'" || ch === '"') {
			at = closing(text, at + 1, ch)
		} else if (ch === "-" && next === "-") {
			at = lineEnd(text, at + 2)
		} else if (ch === "/" && next === "*") {
			at = commentEnd(text, at + 2)
		} else if (tag > 0) {
			at = dollarEnd(text, at, tag)
		} else if (ch === ":" && next === ":") {
			return true
		} else {
			at += 1
		}
	}
	return false
}

/** Whether a file lies in one of the directories, at a "/" boundary. */
const isUnder = (filename: string, directories: ReadonlyArray<string>): boolean =>
	Arr.some(
		directories,
		(directory) =>
			Str.startsWith(`${directory}/`)(filename) || Str.includes(`/${directory}/`)(filename)
	)

/**
 * SQL written as text in a source: a string literal or a template literal whose text, its interpolations standing for
 * one neutral character each, holds a cast as PostgreSQL's scanner reads it. Every SQL text a source sends or shows is
 * printed from an AST by the engine's printer, which is the one writer, beside the lexer that reads it.
 */
export const noRawSql = configured(Options, (context, options) => {
	if (
		!isUnder(context.filename, options.sources) ||
		Arr.some(options.writers, (writer) => isFileAt(context.filename, writer))
	) {
		return {}
	}
	return {
		Literal: (node) => {
			if (typeof node.value === "string" && holdsCast(node.value)) {
				context.report({ node, message: MESSAGE })
			}
		},
		TemplateLiteral: (node) => {
			if (
				holdsCast(
					Arr.join(
						Arr.map(node.quasis, (q) => q.value.raw),
						"0"
					)
				)
			) {
				context.report({ node, message: MESSAGE })
			}
		}
	}
})
