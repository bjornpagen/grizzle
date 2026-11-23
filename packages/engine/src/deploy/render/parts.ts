/**
 * The layout of a generated file in parts: a migration folder's meta.json and SQL files and a snapshot's manifest.json are
 * each one text, which `grizzle generate` writes as that text whole where it is within generatedFileMaxBytes and else as
 * its parts (laidOut), each within it, and which every reader reads as the one text again, its parts joined in order
 * (laidOutFiles, the shell's adapter/boundary/files.ts readLaidOut), before anything reads it: a seal, a digest the
 * ledger records, a statement. A file an application imports whole by its path (snapshot.json, a login's served file and
 * OpenAPI document) is laid out in no parts; generate refuses one past the bound (the shell's cli/files.ts
 * unsplitWithin).
 */
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { partsOf, type TextChunks } from "@bjornpagen/grizzle-text/chunks"
import { compareCodePoints, isAsciiDigits } from "@bjornpagen/grizzle-text/text"

/**
 * The most bytes one file generate writes holds: GitHub warns at a push of any file larger, and refuses a file past twice
 * it, so a migrations directory generate wrote is pushed as it stands, whatever the size of its installation.
 *
 * @limitKind published
 * @owner GitHub's repositories (github.com)
 * @unit bytes
 * @scope each file of a migrations directory a commit adds or updates: each part of a laid-out file, and each file an
 *   application imports whole
 * @constraint advisory threshold
 * @source https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github
 * @quote If you attempt to add or update a file that is larger than 50 MiB, you will receive a warning from Git.
 * @verified 2026-11-23
 */
export const generatedFileMaxBytes = 50 * 2 ** 20

/**
 * The entry of part `number`, from 1, of a file named `name` laid out in parts: `<stem>.<number><extension>`, the
 * extension the name from its last `.` on (`manifest.2.json`, `04-validate.3.sql`), so a part keeps its file's extension,
 * which an editor and a reviewer read it by.
 *
 * @formatConstant a part's entry: its file's stem, `.`, its number from 1 in decimal, then its file's extension
 */
const partEntry = (name: string, number: number): string => {
	const dot = name.lastIndexOf(".")
	return `${name.slice(0, dot)}.${String(number)}${name.slice(dot)}`
}

/**
 * The file an entry is a part of, and the part's number (partEntry), or none for an entry with no part's name: a number
 * from 1, decimal digits with no leading zero, between the stem and the extension. No file grizzle writes, and no file
 * a reviewer may add, has a stem ending in such a number (a migration file's stem is `NN-<words>`), so an entry is a part
 * or a whole file by its name alone.
 */
const partOf = (entry: string): { readonly name: string; readonly number: number } | undefined => {
	const dot = entry.lastIndexOf(".")
	const before = entry.lastIndexOf(".", dot - 1)
	const digits = entry.slice(before + 1, dot)
	return before > 0 &&
		digits !== "" &&
		!digits.startsWith("0") &&
		isAsciiDigits(digits, 0, digits.length)
		? { name: `${entry.slice(0, before)}${entry.slice(dot)}`, number: Number(digits) }
		: undefined
}

/** Whether `entry` is the file `name` whole or one of its parts (partEntry). */
export const isEntryOf = (entry: string, name: string): boolean =>
	entry === name || partOf(entry)?.name === name

/** An entry of a laid-out file as generate writes it: its name in its directory, and its text. */
export interface LaidOutEntry {
	readonly entry: string
	readonly text: TextChunks
}

/**
 * The entries a generated file named `name` is written as, none longer than `bound` bytes (generatedFileMaxBytes, which
 * generate writes by): the file whole under its name where it is within the bound, else each of its parts
 * (grizzle-text partsOf, each cut at the text's coarsest joint within the bound) under its part's entry (partEntry).
 */
export const laidOut = (
	name: string,
	text: TextChunks,
	bound: number
): ReadonlyArray<LaidOutEntry> => {
	const parts = partsOf(text, bound)
	return parts.length === 1
		? [{ entry: name, text }]
		: parts.map((part, i) => ({ entry: partEntry(name, i + 1), text: part }))
}

/** A file of a directory as generate laid it out: its name, and its one entry, the file whole, or its parts' entries,
 * in order. */
export interface LaidOutFile {
	readonly name: string
	readonly entries: ReadonlyArray<string>
}

/**
 * The files a directory's entries lay out (LaidOutFile), in the code point order of their names: each entry with no
 * part's name (partOf) a file whole, and the parts of one name together, in their numbers' order. A file in parts is
 * parts 1 to n, n at least two, with no whole file of its name beside them, as laidOut writes it; any other set of parts
 * (one missing, one alone, or parts beside the whole file) is refused by the file's name.
 */
export const laidOutFiles = (
	entries: ReadonlyArray<string>
): Result.Result<ReadonlyArray<LaidOutFile>, { readonly name: string }> => {
	const parts = new Map<string, Array<{ readonly entry: string; readonly number: number }>>()
	const whole = new Set<string>()
	for (const entry of entries) {
		const part = partOf(entry)
		if (part === undefined) {
			whole.add(entry)
		} else {
			parts.getOrInsertComputed(part.name, () => []).push({ entry, number: part.number })
		}
	}
	const files: Array<LaidOutFile> = [...whole].map((name) => ({ name, entries: [name] }))
	for (const [name, of] of parts) {
		const ordered = of.toSorted((a, b) => a.number - b.number)
		if (whole.has(name) || ordered.length < 2 || ordered.some((p, i) => p.number !== i + 1)) {
			return Result.err({ name })
		}
		files.push({ name, entries: ordered.map((p) => p.entry) })
	}
	return Result.ok(files.toSorted((a, b) => compareCodePoints(a.name, b.name)))
}
