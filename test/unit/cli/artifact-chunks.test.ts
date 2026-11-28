/**
 * Every artifact generate writes is a text held as its chunks (grizzle-text TextChunks), and each reader of it reads its
 * chunks as it would read the whole text: the chunks joined are the text the string writers write (core/canonical.ts
 * writeCanonicalJson, core/lines.ts textOf), the JSON reader's value of a JSON artifact is JSON.parse's, a file's bytes
 * held to the chunks part where the whole arrays part, and the marker and statement scanners read a SQL file's chunks as
 * its text.
 *
 * Property, per case: the served-levels box (test/unit/cli/served-levels.fixtures.ts: Reports over Work, a login over each
 * level running a drawn set of ChangeSets) drafted from the empty snapshot as generate drafts it (cli/generate.ts
 * draftSchema, snapshotFilesOf, eachServedFile). Its artifacts: meta.json and every NN-*.sql of the folder, snapshot.json,
 * manifest.json, each login's served file and its OpenAPI document. For each: every chunk nonempty, well-formed and
 * within the bound; a JSON artifact's text is the string writer's of its own value (a served file and a document: the
 * canonical JSON and a newline; a tab-laid file: its lines joined by line feeds, textOf's), and readJson of its chunks
 * and of the text cut anywhere is JSON.parse's value of the text, value for value; its bytes held to the chunks are the
 * same, and a copy with one byte changed parts at that byte; a SQL file's markers, statements, mode and lines read
 * through a view of its chunks are the text's. Oracles: JSON.parse and the whole-text readers (differential), the
 * string writers (second implementation). Kills: a chunked line writer that drops the first line feed; a JSON reader that
 * builds a record's members in reverse; a parting placed at the start of the block that differs (a copy is held in two
 * blocks, the second starting before its changed byte).
 *
 * Features: an artifact of several chunks; a served file. A draft from the empty snapshot holds no marker, so a SQL
 * file's markers read through a view are none here; test/unit/text/chunks.test.ts reads drawn SQL files with markers.
 */
import {
	ByteMatch,
	ChunkView,
	chunkBytes,
	chunkUnits,
	readJson,
	type TextChunks
} from "@bjornpagen/grizzle-text/chunks"
import { assert, defined } from "@bjornpagen/testing/assert"
import { type Gen, int } from "@bjornpagen/testing/gen"
import { type Case as CaseOf, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import { compileSchema, resolveConfig } from "#cli/config.ts"
import { draftSchema, eachServedFile, snapshotFilesOf } from "#cli/generate.ts"
import { type Json, writeCanonicalJson } from "#compiler/core/canonical.ts"
import { chunkedTextOf, textOf } from "#compiler/core/lines.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { silentPhases } from "#compiler/core/phase.ts"
import { trusted } from "#compiler/core/trusted.ts"
import {
	findMarkers,
	isNoTransaction,
	splitStatements,
	textLines
} from "#compiler/deploy/render/markers.ts"
import { emptySnapshot } from "#compiler/deploy/snapshot/build.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { login } from "#compiler/public/schema.ts"
import { defineConfig } from "#index.ts"
import { Reports, Work } from "#test/support/agreement/changeset-schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { joined } from "#test/support/chunked.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { offlineOwner } from "#test/support/pg/cli/support.ts"
import { agreesWithParse, cutAt, cutsGen } from "#test/support/unit/text/chunks.fixtures.ts"
import {
	caseGen as boxGen,
	counts,
	file,
	programsOf,
	reportsWriter,
	workWriter
} from "#test/unit/cli/served-levels.fixtures.ts"

/** A case of the served-levels box. */
type BoxCase = typeof boxGen extends Gen<infer C> ? C : never

/** A drafted box, the cuts each artifact is read through, and the byte each copy changes. */
interface ArtifactCase {
	readonly box: BoxCase
	readonly cuts: ReadonlyArray<number>
	readonly changed: number
}

const caseGen: Gen<ArtifactCase> = (source) => ({
	box: source.draw(boxGen),
	cuts: source.draw(cutsGen(1 << 30)),
	changed: source.draw(int(0, 1 << 30))
})

type Feature = "an artifact of several chunks" | "a served file"

/** How an artifact's text is written whole: as canonical JSON and a newline, as tab-laid lines, or as SQL lines. */
type Layout = "canonical" | "lines" | "sql"

/** Each chunk within the bound, and the text the string writer writes of the same thing. */
const holdsItsWriter = (text: TextChunks, layout: Layout, what: string): string => {
	for (const chunk of text) {
		assert.ok(
			chunk.length > 0 && chunk.length <= chunkUnits && chunk.isWellFormed(),
			`${what}: a chunk`
		)
	}
	const whole = joined(text)
	const lines = Arr.fromIterable(textLines(new ChunkView(text)))
	const write = (out: { line(text: string): void }) => {
		for (const line of lines) {
			out.line(line)
		}
	}
	switch (layout) {
		case "canonical": {
			const value = readJson(text)
			assert.ok(value.ok, `${what} reads as JSON`)
			const canonical = succeeded(writeCanonicalJson(trusted<Json>(value.value)))
			assert.equal(
				whole,
				`${canonical}\n`,
				`${what} is the canonical text of its value and a newline`
			)
			break
		}
		case "lines":
		case "sql":
			if (!Str.includes("\r")(whole)) {
				const at = SourceLoc(what, [])
				assert.equal(
					joined(chunkedTextOf("\t", write)),
					succeeded(textOf(1 << 30, "\t", at, write)),
					`${what}'s lines written as chunks are textOf's text`
				)
			}
	}
	return whole
}

/** The bytes of `whole` held to the text's chunks: the same, and a copy with the byte at `changed` changed. */
const holdsItsBytes = (text: TextChunks, whole: string, changed: number, what: string): void => {
	const bytes = new TextEncoder().encode(whole)
	const same = new ByteMatch(chunkBytes(text))
	same.next(bytes)
	assert.deepEqual(same.end(), { kind: "same" }, `${what}: its bytes are its chunks'`)
	if (bytes.length === 0) {
		return
	}
	{
		const at = changed % bytes.length
		const copy = bytes.slice()
		copy[at] = (copy[at] ?? 0) ^ 0x01
		const parted = new ByteMatch(chunkBytes(text))
		const block = Math.floor(at / 2)
		parted.next(copy.subarray(0, block))
		parted.next(copy.subarray(block))
		assert.deepEqual(
			parted.end(),
			{ kind: "differ", at },
			`${what}: a copy parts at the byte it changes`
		)
	}
}

/** Generate's artifacts read as their chunks are read as their whole texts. */
export const generatesArtifactsReadAsTheirChunksAreReadAsTheirWholeTexts = property.explore(
	caseGen,
	{
		needs: {},
		situations: ["an artifact of several chunks", "a served file"],
		check: (_, notes: CaseOf<Feature>) => (c) =>
			Effect.gen(function* () {
				const writer = workWriter()
				const reporter = reportsWriter()
				const below = login(Work, "app", [writer], {
					workload: [workload(writer, programsOf(c.box.below, writer))]
				})
				const above = login(Reports, "reports", [reporter], {
					workload: [workload(reporter, { ...programsOf(c.box.above, reporter), counts })]
				})
				const config = yield* resolveConfig(
					defineConfig({
						schemas: [Reports],
						logins: [below, above],
						migrations: "migrations",
						rolePrefixBytes: 0,
						connection: () => offlineOwner
					}),
					file
				)
				const configured = defined(config.schemas[0], "the configured schema")
				const compiled = yield* Effect.fromResult(compileSchema(configured))
				const draft = yield* draftSchema(
					compiled,
					emptySnapshot({ schemaName: configured.declared, schema: configured.ident }),
					[],
					noDeclarations,
					silentPhases
				)
				const files = yield* snapshotFilesOf(compiled, draft)
				const served = yield* eachServedFile(
					compiled,
					draft,
					draft.served,
					silentPhases,
					Effect.succeed
				)
				const json: ReadonlyArray<readonly [string, TextChunks, Layout]> = [
					["meta.json", draft.folder.metaText, "lines"],
					["snapshot.json", files.snapshot, "lines"],
					["manifest.json", files.manifest, "lines"],
					...Arr.flatMap(served, (e) => [
						[`served/${e.login}.json`, e.text, "canonical"] as const,
						[`openapi/${e.login}.json`, e.openapi, "canonical"] as const
					])
				]
				if (served.length > 0) {
					notes.note("a served file")
				}
				for (const [what, text, layout] of json) {
					if (text.length > 1) {
						notes.note("an artifact of several chunks")
					}
					const whole = holdsItsWriter(text, layout, what)
					agreesWithParse(whole, readJson(text), what)
					agreesWithParse(
						whole,
						readJson(
							cutAt(
								whole,
								Arr.map(c.cuts, (k) => k % (whole.length + 1))
							)
						),
						`${what}, cut`
					)
					holdsItsBytes(text, whole, c.changed, what)
				}
				for (const f of draft.folder.files) {
					const whole = holdsItsWriter(f.text, "sql", f.name)
					holdsItsBytes(f.text, whole, c.changed, f.name)
					const view = new ChunkView(f.text)
					assert.deepEqual(findMarkers(view), findMarkers(whole), `${f.name}: its markers`)
					assert.deepEqual(
						splitStatements(view),
						splitStatements(whole),
						`${f.name}: its statements`
					)
					assert.equal(isNoTransaction(view), isNoTransaction(whole), `${f.name}: its mode`)
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "JSON.parse, the whole-text readers and the string writers over each artifact's whole text"
		},
		budget: { runs: 12, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/lines.ts",
				original: "\t\tif (this.#lines > 0) {",
				replacement: "\t\tif (this.#lines > 1) {",
				why: "The chunked line writer drops the line feed after a file's first line, so its text is not textOf's."
			},
			{
				file: "packages/text/src/chunks.ts",
				original: "\t\t\tvalue = Object.fromEntries(top.members)",
				replacement: "\t\t\tvalue = Object.fromEntries(top.members.toReversed())",
				why: "The JSON reader builds a record's members in reverse, so its keys stand in another order than JSON.parse's, and a repeated key keeps its first value."
			},
			{
				file: "packages/text/src/chunks.ts",
				original: "\t\t\t\tthis.#matched += same",
				replacement: "\t\t\t\t\tthis.#matched += 0",
				why: "A parting inside a block is placed at the block's start, before the byte that differs."
			}
		]
	}
)
