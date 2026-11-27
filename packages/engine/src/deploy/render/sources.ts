import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import { sha256Hex } from "#compiler/core/sha256.ts"
import { quoteIdent, wellFormed } from "#compiler/core/text.ts"
import type { RecordedSource } from "#compiler/deploy/admission/manifest.ts"
import type { DraftedFile } from "#compiler/deploy/render/folder.ts"
import { escapedValue } from "#compiler/sql/escape.ts"
import { type Lexeme, lexemesOf } from "#compiler/sql/lexer.ts"
import { printObjectName } from "#compiler/sql/print.ts"

/**
 * A drafted folder's functions held to its snapshot's records of them, by the bytes the folder writes.
 *
 * A committed snapshot records a PL/pgSQL function's and a declared function's source by its digest alone
 * (deploy/snapshot/recorded.ts RecordedFunction, RecordedDeclaredFunction), and the drift check holds the source
 * PostgreSQL stores of each, its pg_proc.prosrc, to that digest. PostgreSQL stores what the folder's CREATE FUNCTION
 * wrote, so a record that digests any text but that one drifts on every database the folder installs, at once, and
 * `grizzle check` regenerates both alike and passes. So generate reads every function its folder creates back off the
 * texts it writes, as PostgreSQL's scanner reads them (sql/lexer.ts), and holds the source each installs to the
 * snapshot's record: a record that digests another text is an internal compiler error, never a folder.
 */

/**
 * The function a CREATE FUNCTION's lexemes create, by its name as printObjectName prints it, and the source its body installs, PostgreSQL's
 * value of the constant after its AS, the first at no parenthesis's depth: a dollar-quoted body's text, or a string's
 * value, an escape string's read back (sql/escape.ts escapedValue), the spelling a drafted file gives a body holding a
 * character a text tool may rewrite (deploy/render/filed.ts). None for a statement that creates no function, nor for a
 * function whose body is an SQL-standard RETURN, whose statement a snapshot records whole.
 */
const createdSource = (
	lexemes: ReadonlyArray<Lexeme>
): { readonly name: string; readonly source: string } | undefined => {
	const words = (at: number, upper: ReadonlyArray<string>): boolean =>
		upper.every((u, i) => {
			const l = lexemes[at + i]
			return l?.kind === "word" && l.upper === u
		})
	if (!words(0, ["CREATE"])) {
		return undefined
	}
	const head = words(1, ["OR", "REPLACE", "FUNCTION"]) ? 4 : words(1, ["FUNCTION"]) ? 2 : undefined
	if (head === undefined) {
		return undefined
	}
	const schema = lexemes[head]
	const dot = lexemes[head + 1]
	const name = lexemes[head + 2]
	if (
		schema?.kind !== "quotedIdent" ||
		dot?.kind !== "punct" ||
		dot.text !== "." ||
		name?.kind !== "quotedIdent"
	) {
		defect("a CREATE FUNCTION grizzle wrote names its function by its schema and its name")
	}
	const printed = `${quoteIdent(schema.text)}.${quoteIdent(name.text)}`
	let depth = 0
	for (let i = head + 3; i < lexemes.length; i++) {
		const l = lexemes[i]
		if (l?.kind === "punct" && l.text === "(") {
			depth += 1
		} else if (l?.kind === "punct" && l.text === ")") {
			depth -= 1
		} else if (depth === 0 && l?.kind === "word" && l.upper === "RETURN") {
			return undefined
		} else if (depth === 0 && l?.kind === "word" && l.upper === "AS") {
			const body = lexemes[i + 1]
			if (body?.kind === "dollar") {
				return { name: printed, source: body.body }
			}
			if (body?.kind === "string" && body.prefix === "E") {
				return { name: printed, source: escapedValue(body.text) }
			}
			break
		}
	}
	defect(
		`the CREATE FUNCTION of ${printed} grizzle wrote holds its body as one constant after AS, or an SQL-standard RETURN`
	)
}

/**
 * Every source a drafted folder's files install, by its function's name as printObjectName prints it: each function's last CREATE FUNCTION's in the folder's
 * order, the one PostgreSQL holds once the folder applied, read off each statement as the file spells it from its first
 * token, every drafted statement's and every confirmed one's, which the migration runner sends as they stand.
 */
export const writtenSources = (files: ReadonlyArray<DraftedFile>): ReadonlyMap<string, string> => {
	const sources = new Map<string, string>()
	for (const file of files) {
		for (const step of file.steps) {
			const texts =
				step.kind === "statement"
					? [step.statement]
					: step.kind === "confirm"
						? step.statements
						: []
			for (const text of texts) {
				const created = createdSource(lexemesOf(text).lexemes)
				if (created !== undefined) {
					sources.set(created.name, created.source)
				}
			}
		}
	}
	return sources
}

/**
 * Holds every function a drafted folder creates to the snapshot's record of it, `recorded` (deploy/admission/manifest.ts
 * recordedSources): the SHA-256 of the source its last
 * CREATE FUNCTION in the folder installs (writtenSources) is the record's digest, for every recorded function the folder
 * creates. A record of another digest is an internal compiler error (the module header): the record digested a text
 * the folder does not hold, which the drift check would refuse on every database the folder installs.
 */
export const assertSourcesAsRecorded = (
	files: ReadonlyArray<DraftedFile>,
	recorded: ReadonlyArray<RecordedSource>
): void => {
	const written = writtenSources(files)
	for (const r of recorded) {
		const name = printObjectName(r.function)
		const source = written.get(name)
		if (source === undefined) {
			continue
		}
		const digest = sha256Hex(wellFormed(source))
		if (digest !== r.source) {
			defect(
				`the snapshot records the source of function ${name} by the digest ${r.source}, where the folder's CREATE FUNCTION installs a source of the digest ${digest}: a record digests the text its file writes`
			)
		}
	}
}
