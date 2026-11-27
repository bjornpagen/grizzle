/**
 * A generated file is one text laid out in parts under a bound (deploy/render/parts.ts): generate writes manifest.json
 * and each file of a migration folder whole where it is within the bound and else as its parts (laidOut, grizzle-text
 * partsOf), each within it, and every reader reads the one text again (cli/files.ts readSchemaTree,
 * adapter/boundary/files.ts readLaidOut). A file an application imports whole is refused past the bound
 * (cli/files.ts unsplitWithin).
 *
 * Properties, per case. Cuts: a drawn text, of blocks of lines of runs of ASCII, two-byte, three-byte and astral
 * characters, or one whose only blank line straddles the seam between two of its chunks, and a drawn bound: its parts
 * are a reference cutter's, which cuts the whole string greedily, each part the longest start within the bound that ends
 * after its last blank line, else after its last line feed, else after its last whole code point; each part is within
 * the bound; the parts joined are the text; and the part entries of its file name lay out that one file. Files: a drafted
 * folder's meta.json and SQL files and two snapshots' files in turn, staged and put in place by generate's writers
 * (cli/files.ts stageFolder, stageSnapshotFiles, commitFolder, commitSnapshotFiles) under a drawn bound:
 * every entry but snapshot.json is within the bound, each entry is the one laidOut names, and the schema's directory
 * reads back every text as written, the second manifest whole, none of the first left; and the imported files are
 * refused, by the first past the bound, exactly where one is. Oracles: a second implementation of the cutter over the
 * whole string; the texts as written (identity). Kills: a part past the bound; a cut that does not prefer a blank line;
 * a blank line across a chunk seam missed; the first manifest's parts left beside the second's.
 *
 * Features: a text in several parts; a line longer than the bound; a blank line across a chunk seam; a manifest whose
 * parts change in number; an imported file past the bound.
 */

import { chunksOf, chunkUnits, joinedParts, partsOf } from "@bjornpagen/grizzle-text/chunks"
import { utf8Length } from "@bjornpagen/grizzle-text/utf8"
import { assert, defined } from "@bjornpagen/testing/assert"
import { array, codePoint, element, type Gen, int, oneOf } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import {
	Array as Arr,
	Effect,
	FileSystem,
	Option,
	Order,
	Path,
	Result,
	String as Str
} from "effect"
import {
	commitFolder,
	commitSnapshotFiles,
	readSchemaTree,
	stageFolder,
	stageSnapshotFiles,
	stagingArea,
	unsplitWithin
} from "#cli/files.ts"
import { SchemaFingerprint } from "#compiler/core/ids.ts"
import { wellFormed } from "#compiler/core/text.ts"
import { metaFileName, type MigrationFolder } from "#compiler/deploy/render/folder.ts"
import { laidOut, laidOutFiles } from "#compiler/deploy/render/parts.ts"
import { manifestFileName, snapshotFileName } from "#compiler/deploy/snapshot/types.ts"
import { joined } from "#test/support/chunked.ts"

/** A run of one character: ASCII, two-byte, three-byte or astral. */
const runGen: Gen<string> = (source) =>
	Str.repeat(source.draw(int(1, 40)))(
		source.draw(
			oneOf([
				codePoint(0x21, 0x7e),
				codePoint(0x80, 0x7ff),
				codePoint(0x800, 0xd7ff),
				codePoint(0x10000, 0x10ffff)
			])
		)
	)

/** A line: runs of characters, possibly none. */
const lineGen: Gen<string> = (source) =>
	Arr.join(source.draw(array(runGen, { min: 0, max: 4 })), "")

/** A text of blocks of lines, the blocks parted by blank lines, as a drafted file's statements are. */
const blocksGen: Gen<string> = (source) =>
	Arr.join(
		Arr.map(source.draw(array(array(lineGen, { min: 1, max: 5 }), { min: 0, max: 6 })), (lines) =>
			Arr.join(lines, "\n")
		),
		"\n\n"
	)

/** A drawn text and the bound its parts are cut under. */
interface CutCase {
	readonly text: string
	readonly bound: number
}

/**
 * A text whose one blank line straddles its first chunk seam: ASCII up to a unit before the seam, the blank line's two
 * line feeds on either side of it, then lines with no blank line, under a bound that reaches past it, so the coarsest
 * joint within the bound is the blank line across the seam.
 */
const seamGen: Gen<CutCase> = (source) => {
	const tail = Arr.join(
		source.draw(array(element(["xx", "yyy", "zzzz"]), { min: 30, max: 60 })),
		"\n"
	)
	return {
		text: `${Str.repeat(chunkUnits - 1)("a")}\n\n${tail}`,
		bound: chunkUnits + 1 + source.draw(int(1, 60))
	}
}

const cutCaseGen: Gen<CutCase> = oneOf([
	(source) => ({ text: source.draw(blocksGen), bound: source.draw(int(4, 300)) }),
	seamGen
])

/**
 * The reference cutter: the whole string cut greedily, each part the longest start of what is left within `bound`
 * bytes, ending after its last blank line, else after its last line feed, else after its last whole code point.
 */
const referenceParts = (text: string, bound: number): ReadonlyArray<string> => {
	const parts: Array<string> = []
	let rest = text
	while (utf8Length(rest) > bound) {
		let units = 0
		let bytes = 0
		for (const ch of rest) {
			const width = utf8Length(ch)
			if (bytes + width > bound) {
				break
			}
			bytes += width
			units += Str.length(ch)
		}
		const window = Str.slice(0, units)(rest)
		const cut = Option.getOrElse(
			Option.orElse(
				Option.map(Str.lastIndexOf("\n\n")(window), (at) => at + 2),
				() => Option.map(Str.lastIndexOf("\n")(window), (at) => at + 1)
			),
			() => units
		)
		parts.push(Str.slice(0, cut)(rest))
		rest = Str.slice(cut)(rest)
	}
	parts.push(rest)
	return parts
}

type CutSituation =
	| "a text in several parts"
	| "a line longer than the bound"
	| "a blank line across a chunk seam"

/** A text's parts under a bound are the reference cutter's, each within the bound, together the text. */
export const aTextsPartsUnderABoundAreTheReferenceCuttersEachWithinTheBoundTogetherTheText =
	property.explore(cutCaseGen, {
		needs: {},
		situations: [
			"a text in several parts",
			"a line longer than the bound",
			"a blank line across a chunk seam"
		],
		check: (_, c: Case<CutSituation>) => (x: CutCase) =>
			Effect.sync(() => {
				const text = chunksOf(wellFormed(x.text))
				const parts = partsOf(text, x.bound)
				const expected = referenceParts(x.text, x.bound)
				const cut: ReadonlyArray<string> = Arr.map(parts, (part) => joined(part))
				assert.deepEqual(cut, expected, "the parts are the reference cutter's")
				for (const [i, part] of parts.entries()) {
					const bytes = utf8Length(joined(part))
					assert.ok(bytes <= x.bound, `part ${i} holds ${bytes} bytes, past ${x.bound}`)
					if (i < parts.length - 1 && !Str.endsWith("\n")(joined(part))) {
						c.note("a line longer than the bound")
					}
				}
				assert.equal(joined(joinedParts(parts)), x.text, "the parts joined are the text")
				if (parts.length > 1) {
					c.note("a text in several parts")
				}
				if (text.length > 1 && Arr.some(expected, (p) => Str.length(p) === chunkUnits + 1)) {
					c.note("a blank line across a chunk seam")
				}
				const entries = laidOut("04-validate.sql", text, x.bound)
				const files = laidOutFiles(Arr.map(entries, (e) => e.entry))
				assert.ok(files.ok, "the entries lay out a file")
				assert.deepEqual(
					files.value,
					[{ name: "04-validate.sql", entries: Arr.map(entries, (e) => e.entry) }],
					"the entries lay out the one file, in order"
				)
			}),
		oracle: { kind: "second-implementation", name: "a greedy cutter over the whole string" },
		kept: [],
		kills: [
			{
				file: "packages/text/src/chunks.ts",
				original: "\t\tif (bytes + size <= bound) {",
				replacement: "\t\tif (bytes + size <= bound + 4) {",
				why: "A part takes a piece past the bound: it holds more bytes than the file may."
			},
			{
				file: "packages/text/src/chunks.ts",
				original: '\t\tconst cut = lastEnding(pieces, "\\n\\n") ?? lastEnding(pieces, "\\n")',
				replacement: '\t\tconst cut = lastEnding(pieces, "\\n")',
				why: "A part ends at its last line feed though a blank line lies within the bound, so a statement is cut in two where it could stand whole."
			},
			{
				file: "packages/text/src/chunks.ts",
				original: 'piece.startsWith("\\n")) {',
				replacement: 'piece.startsWith("\\n") && false) {',
				why: "A blank line whose two line feeds lie in two chunks is no joint, so the cut depends on where the chunks fall and passes the blank line."
			}
		]
	})

/** A drawn installation's generated texts and the bound they are written under. */
interface FilesCase {
	readonly bound: number
	readonly meta: string
	readonly sql: ReadonlyArray<string>
	readonly manifests: readonly [string, string]
	readonly snapshot: string
}

const filesCaseGen: Gen<FilesCase> = (source) => ({
	bound: source.draw(int(4, 400)),
	meta: source.draw(blocksGen),
	sql: source.draw(array(blocksGen, { min: 0, max: 4 })),
	manifests: [source.draw(blocksGen), source.draw(blocksGen)],
	snapshot: source.draw(blocksGen)
})

type FilesSituation = "a manifest whose parts change in number" | "an imported file past the bound"

/** generate's writers lay every file out within the bound, and the schema's directory reads back what they wrote. */
export const generatesWritersLayEveryFileOutWithinTheBoundAndTheDirectoryReadsBackWhatTheyWrote =
	property.explore(filesCaseGen, {
		needs: {},
		situations: ["a manifest whose parts change in number", "an imported file past the bound"],
		check: (_, c: Case<FilesSituation>) => (x: FilesCase) =>
			Effect.scoped(
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem
					const path = yield* Path.Path
					const text = (t: string) => chunksOf(wellFormed(t))
					const directory = yield* fs.makeTempDirectoryScoped({ prefix: "grizzle-laid-out-" })
					const files = Arr.map(x.sql, (t, i) => ({
						name: `${Str.padStart(2, "0")(String(i + 1))}-validate.sql`,
						text: text(t)
					}))
					const folder: MigrationFolder = {
						name: "20261123000000_init",
						meta: {
							kind: "custom",
							schemaName: "s",
							schema: "s",
							source: SchemaFingerprint(Str.repeat(64)("0")),
							target: SchemaFingerprint(Str.repeat(64)("0")),
							laws: { schemas: [], constraintToLaw: { tables: {}, domains: {} } }
						},
						metaText: text(x.meta),
						files
					}
					const [first, second] = x.manifests
					const putSnapshotFiles = (manifest: string) =>
						Effect.scoped(
							Effect.gen(function* () {
								const staging = yield* stagingArea("s", directory, directory)
								const parts = yield* stageSnapshotFiles(
									"s",
									staging,
									{ snapshot: text(x.snapshot), manifest: text(manifest) },
									x.bound
								)
								yield* commitSnapshotFiles("s", staging, parts)
							})
						)
					yield* Effect.scoped(
						Effect.gen(function* () {
							const staging = yield* stagingArea("s", directory, directory)
							yield* stageFolder("s", staging, folder, x.bound)
							yield* commitFolder("s", staging, folder.name)
						})
					)
					yield* putSnapshotFiles(first)
					yield* putSnapshotFiles(second)
					const counts = Arr.map(
						x.manifests,
						(m) => laidOut(manifestFileName, text(m), x.bound).length
					)
					if (counts[0] !== counts[1]) {
						c.note("a manifest whose parts change in number")
					}
					const folderPath = path.join(directory, folder.name)
					const expectedEntries = (name: string, t: string) =>
						Arr.map(laidOut(name, text(t), x.bound), (e) => e.entry)
					const onDisk = yield* fs.readDirectory(folderPath)
					assert.deepEqual(
						Arr.sort(onDisk, Order.String),
						Arr.sort(
							[
								...expectedEntries(metaFileName, x.meta),
								...Arr.flatMap(x.sql, (t, i) => expectedEntries(defined(files[i]).name, t))
							],
							Order.String
						),
						"the folder holds the entries laidOut names"
					)
					for (const entry of onDisk) {
						const bytes = (yield* fs.stat(path.join(folderPath, entry))).size
						assert.ok(Number(bytes) <= x.bound, `${entry} holds ${bytes} bytes, past ${x.bound}`)
					}
					const top = yield* fs.readDirectory(directory)
					assert.deepEqual(
						Arr.sort(top, Order.String),
						Arr.sort(
							[folder.name, snapshotFileName, ...expectedEntries(manifestFileName, second)],
							Order.String
						),
						"the schema's directory holds the second manifest's entries alone"
					)
					for (const entry of Arr.filter(top, (e) => e !== snapshotFileName && e !== folder.name)) {
						const bytes = (yield* fs.stat(path.join(directory, entry))).size
						assert.ok(Number(bytes) <= x.bound, `${entry} holds ${bytes} bytes, past ${x.bound}`)
					}
					const tree = yield* readSchemaTree("s", directory)
					const snapshotFiles = Option.getOrThrow(tree.snapshotFiles)
					assert.equal(
						joined(snapshotFiles.manifest),
						second,
						"manifest.json reads back as written"
					)
					assert.equal(joined(snapshotFiles.snapshot), x.snapshot, "snapshot.json reads back")
					const [read] = tree.folders
					assert.equal(joined(defined(read).metaText), x.meta, "meta.json reads back as written")
					assert.deepEqual(
						Arr.map(defined(read).files, (f) => ({ name: f.name, text: joined(f.text) })),
						Arr.map(files, (f) => ({ name: f.name, text: joined(f.text) })),
						"each SQL file reads back as written"
					)
					const imported = [
						{ file: snapshotFileName, text: text(x.snapshot) },
						...Arr.map(x.sql, (t, i) => ({ file: `served/l${String(i)}.json`, text: text(t) }))
					]
					const past = Arr.findFirst(imported, (f) => utf8Length(joined(f.text)) > x.bound)
					const outcome = yield* Effect.result(unsplitWithin("s", imported, x.bound))
					if (Option.isSome(past)) {
						c.note("an imported file past the bound")
					}
					assert.deepEqual(
						Result.isFailure(outcome)
							? Option.some(
									outcome.failure.reason._tag === "FileTooLarge"
										? outcome.failure.reason.file
										: outcome.failure.reason._tag
								)
							: Option.none(),
						Option.map(past, (f) => f.file),
						"the first imported file past the bound is refused, by its path"
					)
				})
			),
		oracle: { kind: "specification", name: "the texts as written, and the entries laidOut names" },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/cli/files.ts",
				original: "\t\t\tif (isEntryOf(entry, manifestFileName) && !kept.has(entry)) {",
				replacement: "\t\t\tif (false) {",
				why: "The first manifest's entries stay beside the second's: its whole file beside the parts is refused, and a part past the second's count is read as more of it."
			}
		]
	})
