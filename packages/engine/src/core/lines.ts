import { type CompileError, resourceBound } from "#compiler/core/errors.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"

/**
 * The one representation of a multi-line text grizzle builds: SQL statements, drafted migration files, snapshot.json and
 * meta.json. A writer writes each line once, in order, through a view that carries its indentation; nothing returns
 * lines for a parent to splice, so a text's size is never the arity of a call.
 *
 * Where a writer writes: lines in order, each appended once, at the indentation of the view it goes through.
 */
export interface Lines {
	/** Appends `text` as the next line, at this view's indentation. */
	line(text: string): void
	/** The same lines, one level deeper. */
	nested(): Lines
}

/** Lines on their own rows: each behind the view's indentation, `unit` deeper per level. */
export class BlockLines implements Lines {
	readonly #out: Array<string>
	readonly #unit: string
	readonly #indent: string

	constructor(out: Array<string>, unit: string, indent: string) {
		this.#out = out
		this.#unit = unit
		this.#indent = indent
	}

	line(text: string): void {
		this.#out.push(`${this.#indent}${text}`)
	}

	nested(): Lines {
		return new BlockLines(this.#out, this.#unit, `${this.#indent}${this.#unit}`)
	}
}

/** Lines on one row: each one part of it, joined by a space; nesting adds nothing. */
export class InlineLines implements Lines {
	readonly #out: Array<string>

	constructor(out: Array<string>) {
		this.#out = out
	}

	line(text: string): void {
		this.#out.push(text)
	}

	nested(): Lines {
		return this
	}
}

/**
 * Lines written as SQL line comments into `base`: every physical line, a literal's embedded line breaks included, behind
 * `-- ` and then the view's indentation, so no commented line can reach the scanner as SQL. PostgreSQL's scanner ends a
 * line comment at a line feed or a carriage return (scan.l non_newline), so a carriage return is followed by `-- ` too.
 */
export class CommentedLines implements Lines {
	readonly #base: Lines
	readonly #unit: string
	readonly #indent: string

	constructor(base: Lines, unit: string, indent: string) {
		this.#base = base
		this.#unit = unit
		this.#indent = indent
	}

	line(text: string): void {
		for (const physical of `${this.#indent}${text}`.replaceAll("\r", "\r-- ").split("\n")) {
			this.#base.line(`-- ${physical}`)
		}
	}

	nested(): Lines {
		return new CommentedLines(this.#base, this.#unit, `${this.#indent}${this.#unit}`)
	}
}

/** The one row `write` writes. */
export const inlineText = (write: (out: Lines) => void): string => {
	const out: Array<string> = []
	write(new InlineLines(out))
	return out.join(" ")
}

/** `open`, the parts joined by `separator`, and `close`; ResourceBound (text) when that would be longer than `limit`. */
export const enclosedWithin = (
	limit: number,
	at: SourceLoc,
	open: string,
	parts: ReadonlyArray<string>,
	separator: string,
	close: string
): Result.Result<string, CompileError> => {
	let needed = open.length + close.length + Math.max(parts.length - 1, 0) * separator.length
	for (const part of parts) {
		needed += part.length
	}
	return needed > limit
		? Result.err(resourceBound(at, { kind: "text", limit, needed }))
		: Result.ok(`${open}${parts.join(separator)}${close}`)
}

/**
 * The text `write` writes, its lines joined by newlines; ResourceBound (text) at `at` when it would be longer than
 * `limit`, measured before it is built.
 */
export const textOf = (
	limit: number,
	unit: string,
	at: SourceLoc,
	write: (out: Lines) => void
): Result.Result<string, CompileError> => {
	const out: Array<string> = []
	write(new BlockLines(out, unit, ""))
	return enclosedWithin(limit, at, "", out, "\n", "")
}
