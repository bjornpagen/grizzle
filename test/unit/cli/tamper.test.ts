import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { boolean, element, type Gen } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	DateTime,
	Duration,
	Effect,
	FileSystem,
	Formatter,
	Option,
	Order,
	String as Str
} from "effect"
import { decodeMeta } from "#adapter/boundary/meta.ts"
import type { CliStage } from "#cli/errors.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { metaFileName, writeMeta } from "#compiler/deploy/render/folder.ts"
import { snapshotFileName } from "#compiler/deploy/snapshot/types.ts"
import { cli, cliClock, viaDatabaseUrl, workspace, writeConfig } from "#test/pg/cli/support.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"

/** The clock the in-process command lines of this file read. */
const nextNow = cliClock()

/**
 * A committed migrations directory tampered with, generated: generate refuses before writing anything, naming the
 * tampered entry, and check reports it.
 *
 * A case takes a committed directory of one or two drafted migrations and tampers with one entry, the newest or the
 * oldest folder where the tampering applies to either: snapshot.json replaced by another schema's or removed;
 * a folder renamed out of `<YYYYMMDDHHMMSS>_<name>`, removed, or holding a directory; a meta.json removed, malformed,
 * naming another schema, or breaking the chain (a source that is no previous target); a stray
 * file beside the folders. `grizzle generate` must refuse at the stage that reads the
 * entry, its reason naming the entry, and leave the directory byte for byte as it was; `grizzle check` must fail,
 * naming the entry too. Every kind of tampering runs in every run, on directories and folders the run seed draws.
 */
type Kind =
	| "snapshot of another schema"
	| "snapshot removed"
	| "folder misnamed"
	| "folder removed"
	| "directory in a folder"
	| "meta.json removed"
	| "meta.json malformed"
	| "meta.json of another schema"
	| "meta.json source edited"
	| "stray file"

const kinds: Arr.NonEmptyReadonlyArray<Kind> = [
	"snapshot of another schema",
	"snapshot removed",
	"folder misnamed",
	"folder removed",
	"directory in a folder",
	"meta.json removed",
	"meta.json malformed",
	"meta.json of another schema",
	"meta.json source edited",
	"stray file"
]

interface Case {
	readonly folders: 1 | 2
	readonly kind: Kind
	/** The folder a folder or meta.json tampering applies to. */
	readonly newest: boolean
}

/** The rest of a case of one kind: the directory and the folder tampered with. */
const shapeGen: Gen<Omit<Case, "kind">> = (source) => ({
	folders: source.draw(element<1 | 2>([1, 2])),
	newest: source.draw(boolean)
})

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

/** A directory under `base` holding `name`'s migrations after drafting each of `versions` in turn. */
const drafted = (base: string, label: string, name: string, versions: ReadonlyArray<1 | 2>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const dir = `${base}/${label}`
		yield* fs.makeDirectory(dir)
		for (const [i, version] of versions.entries()) {
			yield* writeConfig(dir, {
				schemas: [{ name, fixture: "shop", version: version, workload: "none" }],
				connection: viaDatabaseUrl
			})
			const generated = yield* cli(dir, ["generate"], at(i), {})
			assert.equal(generated.code, 0, `${label} drafts version ${version}`)
		}
		return dir
	})

/** Every entry under `dir` with its text, a directory's empty, so a refusal that writes anything is caught. */
const contents = (dir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const out: Array<readonly [string, string]> = []
		const entries = yield* fs.readDirectory(dir, { recursive: true })
		for (const entry of Arr.sort(entries, Order.String)) {
			const full = `${dir}/${entry}`
			const info = yield* fs.stat(full)
			if (info.type === "Directory") {
				out.push([`${entry}/`, ""])
				continue
			}
			const text = yield* fs.readFileString(full)
			out.push([entry, text])
		}
		return out
	})

const schemaDir = `migrations/${identifierOf(identity.schema(parsedSchemaName("TamperShop")))}`

/**
 * What generate's refusal of a tampered workspace must name and the stage it refuses at, and the entry check's
 * findings must name.
 */
interface Tampered {
	readonly names: string
	readonly stage: CliStage
	readonly entry: string
}

/** The folder at `found`, which every case's directory holds: one or two drafted migrations. */
const folderAt = (found: Option.Option<string>): string =>
	Option.getOrThrowWith(found, () => new Error("a committed directory holds a drafted folder"))

/** Tampers with the copied workspace `dir`, `other` the other schema's committed directory. */
const tamper = (c: Case, dir: string, other: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const schema = `${dir}/${schemaDir}`
		const entries = yield* fs.readDirectory(schema)
		const folders = Arr.sort(
			Arr.filter(entries, (n) => n !== snapshotFileName),
			Order.String
		)
		const newest = folderAt(Arr.last(folders))
		const oldest = folderAt(Arr.head(folders))
		const folder = c.newest ? newest : oldest
		const snapshot = `${schema}/${snapshotFileName}`
		const meta = `${schema}/${newest}/${metaFileName}`
		switch (c.kind) {
			case "snapshot of another schema": {
				yield* fs.copyFile(
					`${other}/migrations/${identifierOf(identity.schema(parsedSchemaName("TamperOther")))}/${snapshotFileName}`,
					snapshot
				)
				const tampered: Tampered = {
					names: "TamperOther",
					stage: "snapshot",
					entry: snapshotFileName
				}
				return tampered
			}
			case "snapshot removed": {
				yield* fs.remove(snapshot)
				const tampered: Tampered = { names: newest, stage: "snapshot", entry: snapshotFileName }
				return tampered
			}
			case "folder misnamed": {
				const misnamed = Str.slice(15)(folder)
				yield* fs.rename(`${schema}/${folder}`, `${schema}/${misnamed}`)
				const tampered: Tampered = { names: misnamed, stage: "snapshot", entry: misnamed }
				return tampered
			}
			case "folder removed": {
				yield* fs.remove(`${schema}/${newest}`, { recursive: true })
				const tampered: Tampered = {
					names: c.folders === 1 ? snapshotFileName : oldest,
					stage: "snapshot",
					entry: snapshotFileName
				}
				return tampered
			}
			case "directory in a folder": {
				yield* fs.makeDirectory(`${schema}/${folder}/notes`)
				const tampered: Tampered = { names: "notes", stage: "filesystem", entry: "notes" }
				return tampered
			}
			case "meta.json removed": {
				yield* fs.remove(`${schema}/${folder}/${metaFileName}`)
				const tampered: Tampered = { names: folder, stage: "filesystem", entry: folder }
				return tampered
			}
			case "meta.json malformed": {
				yield* fs.writeFileString(meta, "{ not json\n")
				const tampered: Tampered = { names: newest, stage: "snapshot", entry: newest }
				return tampered
			}
			case "meta.json of another schema": {
				const otherSchema = identifierOf(identity.schema(parsedSchemaName("TamperOther")))
				const text = yield* fs.readFileString(meta)
				const read = succeeded(decodeMeta(text))
				yield* fs.writeFileString(meta, succeeded(writeMeta({ ...read, schema: otherSchema })))
				const tampered: Tampered = { names: otherSchema, stage: "snapshot", entry: newest }
				return tampered
			}
			case "meta.json source edited": {
				const text = yield* fs.readFileString(meta)
				const read = succeeded(decodeMeta(text))
				yield* fs.writeFileString(meta, succeeded(writeMeta({ ...read, source: read.target })))
				const tampered: Tampered = { names: newest, stage: "snapshot", entry: newest }
				return tampered
			}
			case "stray file": {
				yield* fs.writeFileString(`${schema}/notes.txt`, "review later\n")
				const tampered: Tampered = { names: "notes.txt", stage: "filesystem", entry: "notes.txt" }
				return tampered
			}
		}
	})

/** One tampering of a copy of the committed directory, generated and checked. */
const tampered = (
	x: Case,
	committed: { readonly one: string; readonly two: string; readonly other: string }
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const ws = yield* workspace("tampered")
			yield* fs.copy(x.folders === 1 ? committed.one : committed.two, ws, { overwrite: true })
			const { names, stage, entry } = yield* tamper(x, ws, committed.other)
			yield* writeConfig(ws, {
				schemas: [
					{
						name: "TamperShop",
						fixture: "shop",
						version: x.folders === 1 ? 2 : 1,
						workload: "none"
					}
				],
				connection: viaDatabaseUrl
			})
			const before = yield* contents(ws)
			const generated = yield* cli(ws, ["generate"], at(9), {})
			const label = Formatter.format(x)
			assert.equal(generated.code, 1, `${label}: generate succeeds\n${generated.stdout}`)
			assert.ok(
				Str.includes(`refused at stage ${stage} `)(generated.stderr),
				`${label}: ${generated.stderr}`
			)
			assert.ok(
				Str.includes(names)(generated.stderr),
				`${label}: ${generated.stderr} does not name ${names}`
			)
			const after = yield* contents(ws)
			assert.deepEqual(after, before, `${label}: generate wrote`)
			const checked = yield* cli(ws, ["check"], nextNow(), {})
			assert.equal(checked.code, 1, `${label}: check passes`)
			assert.ok(
				Str.includes(entry)(checked.stderr),
				`${label}: ${checked.stderr} does not name ${entry}`
			)
		})
	)

layer(NodeServices.layer, { excludeTestServices: true })(
	"a committed migrations directory tampered with, generated",
	(it) => {
		it.effect("generate refuses naming the entry and writes nothing, and check reports it", (ctx) =>
			Effect.gen(function* () {
				/** The committed directories every case copies: the schema's after one and after two drafts, and another's. */
				const base = yield* workspace("tamper")
				const committed = {
					one: yield* drafted(base, "one", "TamperShop", [1]),
					two: yield* drafted(base, "two", "TamperShop", [1, 2]),
					other: yield* drafted(base, "other", "TamperOther", [1])
				}
				yield* searched(
					ctx,
					explore(
						{
							suite: "unit/cli/tamper",
							draw: drawn((source): ReadonlyArray<Case> =>
								Arr.map(kinds, (kind) => ({ ...source.draw(shapeGen), kind }))
							),
							literal: Formatter.format,
							coverage: required<Kind>(kinds, { cases: 2, sense: notesOnly }),
							kept: [],
							runs: 2,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang: Duration.minutes(2)
						},
						(cases, c) =>
							Effect.forEach(
								cases,
								(x) =>
									Effect.andThen(
										Effect.sync(() => {
											c.note(x.kind)
										}),
										tampered(x, committed)
									),
								{ discard: true }
							)
					)
				)
			})
		)
	}
)
