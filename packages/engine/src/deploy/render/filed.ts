import { escapedPiece, escapeString, isUnfiled } from "#compiler/sql/escape.ts"
import { type Lexeme, lexemesOf } from "#compiler/sql/lexer.ts"

/**
 * A drafted statement as its migration file spells it: the printer's text (sql/print.ts), with each constant whose value
 * holds a character a text tool may rewrite (sql/escape.ts isUnfiled) spelled as an escape string of the same value. A
 * file read and written back by any such tool, Python's universal newlines, git's eol conversion or an editor that
 * normalizes line endings, so holds the constants it held, and the installation it applies is the one drafted.
 *
 * The constants are the string constants and dollar-quoted bodies PostgreSQL's scanner reads in the text (sql/lexer.ts),
 * each at the outermost level, so a function body is one constant, whose value is what PostgreSQL stores as the
 * function's source, and nothing inside it is respelled:
 *
 * - A string constant whose value holds one is E'<value>', escaped as PostgreSQL's escape strings read it, its quotes
 *   doubled, on one line. PostgreSQL parses it into the same constant as the raw spelling, and deparses that constant
 *   raw whatever its spelling (ruleutils.c simple_quote_literal), so either spelling installs one constant.
 * - A dollar-quoted body whose value holds one other than a line feed, which is its own layout, is the same value as an
 *   escape string continued line by line, one piece per line of the body, each but the last ending in \n: a string
 *   constant continued across a newline is one constant (scan.l quotecontinue), each piece read as the first is. Its
 *   value, the function's stored source, is the dollar-quoted body's, so a function installed from either spelling
 *   holds one source.
 *
 * Every other constant, and everything between constants, is the printer's text as it stands. A text whose every
 * constant holds no such character is itself. PostgreSQL 19 reads every standard string as standard_conforming_strings
 * on, its only setting, and an escape string reads alike under any setting.
 */
export const filed = (statement: string): string => {
	let out = ""
	let from = 0
	for (const lexeme of lexemesOf(statement).lexemes) {
		const spelling = respelled(lexeme)
		if (spelling !== undefined) {
			out += statement.slice(from, lexeme.start) + spelling.text
			from = spelling.end
		}
	}
	return from === 0 ? statement : out + statement.slice(from)
}

const lineFeed = 0x0a

/** Whether `text` holds a character isUnfiled holds; one other than a line feed, when line feeds are its layout. */
const holdsUnfiled = (text: string, layout: "inline" | "lines"): boolean => {
	for (let k = 0; k < text.length; k++) {
		const unit = text.charCodeAt(k)
		if (isUnfiled(unit) && !(layout === "lines" && unit === lineFeed)) {
			return true
		}
	}
	return false
}

/** A body as an escape string continued line by line: E, then one piece per line, each but the last ending in \n. */
const continuedPieces = (body: string): string => {
	const lines = body.split("\n")
	const last = lines.length - 1
	const pieces = lines.flatMap((line, i) =>
		i < last ? [escapedPiece(`${line}\n`)] : line === "" && i > 0 ? [] : [escapedPiece(line)]
	)
	return `E${pieces.join("\n")}`
}

/**
 * The spelling of a lexeme the file respells, to the end of its source, or none where the printer's stands: a standard
 * string constant or a dollar-quoted body holding an unfiled character; never a prefixed string, which the printer
 * writes as a bit string's hex digits or, for a constant holding a line feed inside a PL/pgSQL block, as its escape
 * string already (sql/escape.ts lineFeedsEscaped).
 */
const respelled = (lexeme: Lexeme): { readonly text: string; readonly end: number } | undefined => {
	switch (lexeme.kind) {
		case "string":
			return lexeme.prefix === undefined && holdsUnfiled(lexeme.text, "inline")
				? { text: escapeString(lexeme.text), end: lexeme.end }
				: undefined
		case "dollar":
			return holdsUnfiled(lexeme.body, "lines")
				? { text: continuedPieces(lexeme.body), end: lexeme.end }
				: undefined
		case "word":
		case "quotedIdent":
		case "param":
		case "number":
		case "operator":
		case "punct":
		case "refused":
		case "terminator":
			return undefined
	}
}
