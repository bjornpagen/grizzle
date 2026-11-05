import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Array as Arr, DateTime, Effect, FileSystem, Option, pipe, String as Str } from "effect"
import { decodeMeta } from "#adapter/boundary/meta.ts"
import { refusalText } from "#cli/refusals.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { SchemaFingerprint } from "#compiler/core/ids.ts"
import { metaFileName, orderFolderFiles, writeMeta } from "#compiler/deploy/render/folder.ts"
import {
	findMarkers,
	noTransactionMarker,
	placeholderMarker,
	splitStatements
} from "#compiler/deploy/render/markers.ts"
import { snapshotFileName } from "#compiler/deploy/snapshot/types.ts"
import { placeholderToken } from "#compiler/sql/print.ts"
import {
	cli,
	cliClock,
	configName,
	unconnected,
	workspace,
	writeConfig
} from "#test/pg/cli/support.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"

/** The clock the in-process command lines of this file read. */
const nextNow = cliClock()

/**
 * `grizzle check` without a database: the offline gate an AI runs before
 * committing and CI runs on every push.
 *
 * - Every finding is reported at once, one per line with its fix: an unresolved marker with its file and line, an
 *   unreadable snapshot.json or meta.json, a broken chain, a statement that controls the transaction, a misplaced
 *   no-transaction marker, an illegal file or folder name, a stray entry; a generated, resolved directory passes.
 * - A renamed schema's first migration is refused as an unresolved data loss until its CREATE SCHEMA is written in.
 */
const at = (s: number) =>
	DateTime.makeUnsafe({
		year: 2026,
		month: 10,
		day: 14,
		hour: 12,
		minute: 0,
		second: s,
		millisecond: 0
	})

/** The lines of an output, each `<where>: <problem>; <fix>` for a finding. */
const lines = (text: string): ReadonlyArray<string> =>
	Arr.filter(Str.split(text, "\n"), (l) => l.length > 0)

const finding = (where: string, r: { readonly problem: string; readonly fix: string }) =>
	`${where}: ${r.problem}; ${r.fix}`

/** The path of `parts` joined by slashes. */
const join = (...parts: Array<string>): string => Arr.join(parts, "/")

/** The text of the file at `path`. */
const read = (path: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		return yield* fs.readFileString(path)
	})

/** Writes `text` to the file at `path`. */
const write = (path: string, text: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		yield* fs.writeFileString(path, text)
	})

/** The entries of the directory at `path`. */
const list = (path: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		return yield* fs.readDirectory(path)
	})

layer(NodeServices.layer, { excludeTestServices: true })("grizzle check", (it) => {
	it.effect("reports an unresolved marker by file and line until the reviewer resolves it", () =>
		Effect.gen(function* () {
			const ws = yield* workspace("check-marker")
			yield* writeConfig(ws, {
				schemas: [{ name: "ChkMark", fixture: "shop", version: 1, workload: "none" }],
				connection: unconnected
			})
			const first = yield* cli(ws, ["generate", configName, "--name", "init"], at(0))
			assert.equal(first.code, 0)
			yield* writeConfig(ws, {
				schemas: [{ name: "ChkMark", fixture: "shop", version: 2, workload: "none" }],
				connection: unconnected
			})
			const tier = yield* cli(ws, ["generate", configName, "--name", "tier"], at(1))
			assert.equal(tier.code, 0)
			const rel = `migrations/${identifierOf(identity.schema(parsedSchemaName("ChkMark")))}/20261014120001_tier`
			const folder = join(ws, rel)
			const folderFiles = yield* list(folder)
			const files = yield* Effect.forEach(
				succeeded(
					orderFolderFiles(
						Arr.map(
							Arr.filter(folderFiles, (f) => f !== metaFileName),
							(name) => ({ name })
						)
					)
				),
				({ file }) =>
					Effect.map(read(join(folder, file.name)), (text) => ({ name: file.name, text }))
			)
			const markers = Arr.flatMap(files, (f) =>
				Arr.map(findMarkers(f.text), (m) =>
					finding(`${rel}/${f.name}:${m.line}`, refusalText[m.kind])
				)
			)
			assert.ok(markers.length > 0)
			const marked = yield* cli(ws, ["check", configName], nextNow())
			assert.equal(marked.code, 1)
			assert.deepEqual(lines(marked.stderr), markers)
			for (const f of files) {
				yield* write(
					join(folder, f.name),
					pipe(
						Arr.join(
							Arr.filter(Str.split(f.text, "\n"), (l) => !Str.startsWith(placeholderMarker)(l)),
							"\n"
						),
						Str.replaceAll(placeholderToken, "3")
					)
				)
			}
			const resolved = yield* cli(ws, ["check", configName], nextNow())
			assert.equal(resolved.code, 0, resolved.stderr)
		})
	)

	it.effect(
		"refuses a renamed schema's first migration until the reviewer writes its CREATE SCHEMA in",
		() =>
			Effect.gen(function* () {
				const ws = yield* workspace("check-renamed")
				yield* writeConfig(ws, {
					schemas: [{ name: "ChkOld", fixture: "shop", version: 1, workload: "none" }],
					connection: unconnected
				})
				const first = yield* cli(ws, ["generate", configName, "--name", "init"], at(0))
				assert.equal(first.code, 0)
				yield* writeConfig(ws, {
					schemas: [{ name: "ChkNew", fixture: "shop", version: 1, workload: "none" }],
					connection: unconnected
				})
				const generated = yield* cli(ws, ["generate", configName, "--name", "init"], at(1))
				assert.equal(generated.code, 0, generated.stderr)
				const old = identifierOf(identity.schema(parsedSchemaName("ChkOld")))
				const rel = `migrations/${identifierOf(identity.schema(parsedSchemaName("ChkNew")))}/20261014120001_init`
				const files = yield* list(join(ws, rel))
				const setup = Option.getOrThrowWith(
					Arr.findFirst(files, (f) => Str.endsWith("-setup.sql")(f)),
					() => new Error("the first migration has a Prepare file")
				)
				const where = `${rel}/${setup}`
				assert.ok(
					Arr.some(
						lines(generated.stdout),
						(l) =>
							Str.startsWith(`${where}: data loss: `)(l) &&
							Str.includes(`"${old}"`)(l) &&
							Str.endsWith(refusalText.unresolvedLoss.fix)(l)
					),
					`generate lists the loss:\n${generated.stdout}`
				)
				const refused = yield* cli(ws, ["check", configName], nextNow())
				assert.equal(refused.code, 1)
				const tail = `: ${refusalText.unresolvedLoss.problem}; ${refusalText.unresolvedLoss.fix}`
				const [one, ...more] = Arr.filter(lines(refused.stderr), (l) =>
					Str.startsWith(`${where}: `)(l)
				)
				assert.ok(
					one !== undefined &&
						more.length === 0 &&
						Str.includes(`"${old}"`)(one) &&
						Str.endsWith(tail)(one),
					`check refuses the loss once, naming ${old}:\n${refused.stderr}`
				)
				const path = join(ws, where)
				const text = yield* read(path)
				yield* write(
					path,
					Arr.join(
						Arr.map(Str.split(text, "\n"), (l) =>
							Str.startsWith("-- CREATE SCHEMA ")(l) ? Str.slice("-- ".length)(l) : l
						),
						"\n"
					)
				)
				const decided = yield* cli(ws, ["check", configName], nextNow())
				assert.equal(decided.code, 0, decided.stderr)
			})
	)

	it.effect(
		"reports every tampering at once: snapshot.json, meta.json, the chain, illegal files and names",
		() =>
			Effect.gen(function* () {
				const ws = yield* workspace("check-tamper")
				yield* writeConfig(ws, {
					schemas: [{ name: "ChkTamp", fixture: "shop", version: 1, workload: "none" }],
					connection: unconnected
				})
				const first = yield* cli(ws, ["generate", configName, "--name", "init"], at(0))
				assert.equal(first.code, 0)
				const custom = yield* cli(ws, ["generate", configName, "--custom", "--name", "seed"], at(1))
				assert.equal(custom.code, 0)
				const rel = `migrations/${identifierOf(identity.schema(parsedSchemaName("ChkTamp")))}`
				const dir = join(ws, rel)
				const init = "20261014120000_init"
				const seed = "20261014120001_seed"
				const snapshot = join(dir, snapshotFileName)
				yield* write(snapshot, "{ not json\n")
				const seedMeta = join(dir, seed, metaFileName)
				const metaText = yield* read(seedMeta)
				const meta = succeeded(decodeMeta(metaText))
				/** A custom folder whose one snapshot is no previous target: the chain breaks there. */
				const elsewhere = SchemaFingerprint(Str.repeat(64)("0"))
				yield* write(
					seedMeta,
					succeeded(writeMeta({ ...meta, source: elsewhere, target: elsewhere }))
				)
				const initFiles = yield* list(join(dir, init))
				const structure = Option.getOrThrowWith(
					Arr.findFirst(initFiles, (f) => Str.endsWith("-structure.sql")(f)),
					() => new Error("the first migration has a Structure file")
				)
				const generatedStructure = yield* read(join(dir, init, structure))
				yield* write(
					join(dir, init, structure),
					`${generatedStructure}\nCOMMIT;\n${noTransactionMarker}\n`
				)
				yield* write(join(dir, seed, "notes.sql"), "SELECT 1;\n")
				const fs = yield* FileSystem.FileSystem
				yield* fs.makeDirectory(join(dir, "draft"))
				yield* write(join(dir, "draft", metaFileName), "{}")
				const all = yield* cli(ws, ["check", configName], nextNow())
				assert.equal(all.code, 1)
				const reported = lines(all.stderr)
				const structureText = yield* read(join(dir, init, structure))
				const structureLines = Str.split(structureText, "\n")
				const statements = splitStatements(Arr.join(structureLines, "\n")).length
				const expected = [
					finding(`${rel}/${snapshotFileName}`, refusalText.unreadableSnapshot),
					finding(`${rel}/draft`, refusalText.folderName),
					finding(`${rel}/draft/${metaFileName}`, refusalText.unreadableMeta),
					finding(`${rel}/${seed}/${metaFileName}`, refusalText.brokenChain),
					`${rel}/${init}/${structure}: statement ${statements} is COMMIT: ${refusalText.transactionControl.problem}; ${refusalText.transactionControl.fix}`,
					finding(
						`${rel}/${init}/${structure}:${structureLines.length - 1}`,
						refusalText.misplacedNoTransaction
					)
				]
				assert.deepEqual(
					Arr.filter(expected, (e) => !Arr.contains(reported, e)),
					[],
					Arr.join(reported, "\n")
				)
				assert.ok(
					Arr.some(
						reported,
						(l) =>
							Str.startsWith(`${rel}/${seed}: `)(l) &&
							Str.includes("notes.sql")(l) &&
							Str.endsWith(refusalText.fileName.fix)(l)
					),
					Arr.join(reported, "\n")
				)
			})
	)
})
