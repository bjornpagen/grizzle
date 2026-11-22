/**
 * generate writes each file's text a run at a time (cli/files.ts writeText, textRuns), each run UTF-8 encoded alone, and
 * the file's bytes are exactly the whole text's UTF-8, whatever the runs: no run ends between the two halves of a
 * surrogate pair, which encoded apart are two U+FFFD, never the character.
 *
 * Property, per case: a drawn text of characters from ASCII, the two-byte, three-byte and astral planes, and a drawn
 * run length of one to eight code units: the runs joined are the text, their encodings together are the text's UTF-8,
 * and the text written by writeText to a file reads back as those bytes. Oracle: specification, the text's UTF-8 as
 * TextEncoder writes it whole. Kill: a run ends wherever its length falls, between a pair's halves among them.
 *
 * Features: a run that would split a surrogate pair.
 */

import { assert } from "@bjornpagen/testing/assert"
import { codePoint, type Gen, int, oneOf, string } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, FileSystem, Option, Path, String as Str } from "effect"
import { textRuns, writeText } from "#cli/files.ts"

/** A text and the run length its writing is cut at. */
interface Written {
	readonly text: string
	readonly units: number
}

const writtenGen: Gen<Written> = (source) => ({
	text: source.draw(
		string(
			oneOf([
				codePoint(0x20, 0x7e),
				codePoint(0x80, 0x7ff),
				codePoint(0x800, 0xd7ff),
				codePoint(0x10000, 0x10ffff)
			]),
			{ min: 0, max: 40 }
		)
	),
	units: source.draw(int(1, 8))
})

const utf8 = new TextEncoder()

/** The bytes of `parts`, one after another. */
const joined = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
	const out = new Uint8Array(Arr.reduce(parts, 0, (n, p) => n + p.length))
	let at = 0
	for (const p of parts) {
		out.set(p, at)
		at += p.length
	}
	return out
}

/** A text written a run at a time is its UTF-8, run by run and on disk. */
export const aTextWrittenARunAtATimeIsItsUtf8RunByRunAndOnDisk = property.explore(writtenGen, {
	needs: {},
	situations: ["a run that would split a surrogate pair"],
	check: (_, c: Case<"a run that would split a surrogate pair">) => (w) =>
		Effect.gen(function* () {
			const runs = [...textRuns(w.text, w.units)]
			for (let at = w.units; at < w.text.length; at += w.units) {
				const unit = Option.getOrElse(Str.charCodeAt(w.text, at - 1), () => 0)
				if (unit >= 0xd800 && unit <= 0xdbff) {
					c.note("a run that would split a surrogate pair")
				}
			}
			assert.equal(Arr.join(runs, ""), w.text, "the runs joined are the text")
			const whole = utf8.encode(w.text)
			assert.deepEqual(
				joined(Arr.map(runs, (run) => utf8.encode(run))),
				whole,
				"the runs' encodings together are the text's UTF-8"
			)
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const read = yield* Effect.scoped(
				Effect.gen(function* () {
					const directory = yield* fs.makeTempDirectoryScoped({ prefix: "grizzle-write-text-" })
					const file = path.join(directory, "text")
					yield* writeText(file, w.text)
					return yield* fs.readFile(file)
				})
			)
			assert.deepEqual(new Uint8Array(read), whole, "the file holds the text's UTF-8")
		}),
	oracle: { kind: "specification", name: "the text's UTF-8 as TextEncoder writes it whole" },
	kept: [],
	kills: [
		{
			file: "packages/grizzle/src/cli/files.ts",
			original: "\t\tif (end < text.length && last >= 0xd800 && last <= 0xdbff) {",
			replacement: "\t\tif (end < 0 && last >= 0xd800 && last <= 0xdbff) {",
			why: "A run ends wherever its length falls, between a surrogate pair's halves among them, so each half encodes alone as U+FFFD and the file is not the text's UTF-8."
		}
	]
})
