import { defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Option, String as Str } from "effect"
import { type Lexeme, lexemesOf } from "#compiler/sql/lexer.ts"

/**
 * The work PostgreSQL's PL/pgSQL compiler spends resolving a block's locations to line numbers, read off the block's
 * source as PostgreSQL stores it (pg_proc.prosrc, or a DO statement's body): the bytes plpgsql_location_to_lineno
 * walks, the rescans that walk restarts from the first byte, and the locations it is asked to resolve.
 */
export interface LineResolution {
	readonly scanned: number
	readonly rescans: number
	readonly requests: number
	/** The compound statements the block holds: its IFs, CASEs and FOR loops, each ELSIF and WHEN arm among them. */
	readonly compound: number
	/** Whether a compound statement holds another. */
	readonly nested: boolean
	/**
	 * The most one forward walk over every line and one rescan through the BEGIN's line, the block's own resolution,
	 * walk: the source's length and its final strchr, and every byte to the end of the BEGIN's line.
	 */
	readonly bound: number
}

/** A compound statement open while its body is read: its keyword's offset and its open branch's, an ELSIF or WHEN. */
interface Frame {
	readonly kind: "block" | "if" | "case" | "for"
	readonly at: number
	branch: number | undefined
}

const isWord = (l: Lexeme | undefined, upper: string): boolean =>
	l?.kind === "word" && l.upper === upper

const isEnd = (l: Lexeme | undefined): boolean =>
	l?.kind === "terminator" || (l?.kind === "punct" && l.text === ";")

/**
 * The index of the token after the header a compound statement's keyword opens, which ends at `keyword` (THEN, LOOP, or
 * a CASE's first WHEN, which the header leaves unread) outside every parenthesis and every CASE expression of the SQL
 * it holds.
 */
const headerEnd = (lexemes: ReadonlyArray<Lexeme>, from: number, keyword: string): number => {
	let parens = 0
	let cases = 0
	for (let i = from; i < lexemes.length; i++) {
		const l = defined(lexemes[i], "a lexeme")
		if (l.kind === "punct" && (l.text === "(" || l.text === "[")) {
			parens++
		} else if (l.kind === "punct" && (l.text === ")" || l.text === "]")) {
			parens--
		} else if (parens === 0 && isWord(l, "CASE")) {
			cases++
		} else if (parens === 0 && cases > 0 && isWord(l, "END")) {
			cases--
		} else if (parens === 0 && cases === 0 && isWord(l, keyword)) {
			return keyword === "WHEN" ? i : i + 1
		}
	}
	throw new Error(`a header never reaches its ${keyword}`)
}

/**
 * The offsets PL/pgSQL's grammar resolves to lines, in the order it resolves them (PostgreSQL 19.0,
 * src/pl/plpgsql/src/pl_gram.y): a declaration's and a simple statement's as it is read, an IF's, a CASE's and a FOR
 * loop's at its reduction, after every statement of its body, an ELSIF's and a WHEN arm's after its own body, and the
 * block's BEGIN last, after its END.
 */
const requestsOf = (
	source: string
): {
	readonly requests: ReadonlyArray<number>
	readonly compound: number
	readonly nested: boolean
} => {
	const lexemes = lexemesOf(source).lexemes
	const requests: Array<number> = []
	const stack: Array<Frame> = []
	let compound = 0
	let nested = false
	const open = (kind: Frame["kind"], at: number): void => {
		if (kind !== "block") {
			compound++
			nested ||= Arr.some(stack, (f) => f.kind !== "block")
		}
		stack.push({ kind, at, branch: undefined })
	}
	const closeBranch = (frame: Frame): void => {
		if (frame.branch !== undefined) {
			requests.push(frame.branch)
			frame.branch = undefined
		}
	}
	let i = 0
	while (i < lexemes.length) {
		const l = defined(lexemes[i], "a lexeme")
		const top = stack.at(-1)
		if (isWord(l, "DECLARE")) {
			i++
		} else if (isWord(l, "BEGIN")) {
			open("block", l.start)
			i++
		} else if (isWord(l, "IF")) {
			open("if", l.start)
			i = headerEnd(lexemes, i + 1, "THEN")
		} else if (isWord(l, "CASE")) {
			open("case", l.start)
			i = headerEnd(lexemes, i + 1, "WHEN")
		} else if (isWord(l, "FOR")) {
			open("for", l.start)
			i = headerEnd(lexemes, i + 1, "LOOP")
		} else if ((isWord(l, "ELSIF") || isWord(l, "WHEN")) && top !== undefined) {
			closeBranch(top)
			compound++
			top.branch = l.start
			i = headerEnd(lexemes, i + 1, "THEN")
		} else if (isWord(l, "ELSE") && top !== undefined) {
			closeBranch(top)
			i++
		} else if (isWord(l, "END")) {
			const frame = defined(stack.pop(), "an END closes what is open")
			closeBranch(frame)
			requests.push(frame.at)
			i += frame.kind === "block" ? 1 : 2
			if (isEnd(lexemes[i])) {
				i++
			}
		} else {
			requests.push(l.start)
			while (i < lexemes.length && !isEnd(lexemes[i])) {
				i++
			}
			i++
		}
	}
	return { requests, compound, nested }
}

/**
 * The line resolution of a block's `source`, as plpgsql_location_to_lineno performs it (PostgreSQL 19.0,
 * src/pl/plpgsql/src/pl_scanner.c): it holds the line it last resolved, walks forward line by line to a later location,
 * and for a location before that line's start begins again at the first byte (location_lineno_init), each line it
 * walks a strchr through the line and its line feed, or the string's end.
 */
export const lineResolution = (source: string): LineResolution => {
	const { requests, compound, nested } = requestsOf(source)
	const lines = Str.split(source, "\n")
	const starts = Arr.scan(lines, 0, (at, line) => at + line.length + 1)
	const last = lines.length - 1
	/** Where line `k` ends, at its line feed, or undefined for the last line, which ends at the string's end. */
	const endOf = (k: number): number | undefined =>
		k < last ? defined(starts[k], "a line's start") + defined(lines[k], "a line").length : undefined
	let scanned = 0
	let rescans = 0
	let line = 0
	const walk = (k: number): void => {
		line = k
		scanned += defined(lines[k], "a line").length + 1
	}
	walk(0)
	for (const location of requests) {
		if (location < defined(starts[line], "a line's start")) {
			rescans++
			walk(0)
		}
		for (let end = endOf(line); end !== undefined && location > end; end = endOf(line)) {
			walk(line + 1)
		}
	}
	const begin = defined(
		Arr.findFirst(lexemesOf(source).lexemes, (l) => isWord(l, "BEGIN")).pipe(Option.getOrUndefined),
		"a block's BEGIN"
	).start
	const beginLine = Arr.findLastIndex(starts, (at) => at <= begin).pipe(Option.getOrElse(() => 0))
	return {
		scanned,
		rescans,
		requests: requests.length,
		compound,
		nested,
		bound: source.length + 1 + defined(starts[beginLine + 1], "the line after the BEGIN's")
	}
}
