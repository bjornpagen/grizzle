/**
 * A committed migrations directory tampered with, generated: generate refuses before writing anything, by the reason
 * that names the tampered entry, and check reports the entry.
 *
 * A case takes a committed directory of one or two drafted migrations and tampers with one entry, the newest or the
 * oldest folder where the tampering applies to either: the snapshot's files replaced by another schema's or removed,
 * or manifest.json removed from beside snapshot.json; a folder renamed out of `<YYYYMMDDHHMMSS>_<name>`, removed, or
 * holding a directory; a meta.json removed, malformed, naming another schema, or breaking the chain (a source that is
 * no previous target); a stray file beside the folders. Every kind of tampering runs in every case, on directories and
 * folders the case draws.
 *
 * - **generate refuses by the entry's reason:** `grizzle generate` is refused, its CliError's reason the one the
 *   directory's reading gives the tampering, by its tag and the fields that name the entry (cli/files.ts TreeRefused,
 *   cli/committed.ts SnapshotForeign and ChainRefused), and the directory is byte for byte as it was.
 * - **check reports the entry:** `grizzle check` exits 1, and its findings (cli/check.ts check) hold the one the
 *   tampering is, by its kind and where it lies.
 *
 * Oracle: the specification of the committed directory's reading, restated per tampering (tamperingOf): the reason and
 * the fields a refusal names, and the finding check reports there; never a refusal's or a finding's prose.
 *
 * Plants (~/.cache/grizzle-release/BR04/plants): tamper-diverged-oldest.patch (a diverged chain names its oldest folder),
 * tamper-no-chain-end.patch (check drops a chain that does not end at snapshot.json).
 *
 * Features: each kind of tampering.
 */
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
	Effect,
	FileSystem,
	Formatter,
	Option,
	Order,
	String as Str
} from "effect"
import { decodeMeta } from "#adapter/boundary/meta.ts"
import { check } from "#cli/check.ts"
import { type ChainBreak, CliError, type CliStage, type TreeRefused } from "#cli/errors.ts"
import type { refusalText } from "#cli/refusals.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { metaFileName, writeMeta } from "#compiler/deploy/render/folder.ts"
import { manifestFileName, snapshotFileName } from "#compiler/deploy/snapshot/types.ts"
import { defineConfig } from "#index.ts"
import {
	cli,
	cliClock,
	configName,
	resolvedConfig,
	specConfig,
	unconnected,
	workspace,
	writeConfig
} from "#test/pg/cli/support.ts"
import { assert, containsEqual, defined, succeeded } from "#test/support/assert.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { migrationFolders } from "#test/support/migrate/kit.ts"

/** The clock the in-process command lines of this file read. */
const nextNow = cliClock()

type Kind =
	| "snapshot of another schema"
	| "snapshot removed"
	| "manifest.json removed"
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
	"manifest.json removed",
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
				connection: unconnected
			})
			const generated = yield* cli(dir, ["generate", configName], at(i))
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
const otherSchema = identifierOf(identity.schema(parsedSchemaName("TamperOther")))

/** A path's last segment: the entry a refusal reads a folder at. */
const lastSegment = (path: string): string =>
	Option.getOrElse(Arr.last(Str.split(path, "/")), () => path)

/** A chain break's kind, and a tree fault's, as cli/errors.ts names them. */
type BreakKind = ChainBreak["kind"]
type TreeKind = TreeRefused["fault"]["kind"]

/**
 * What a refusal names, by its reason's tag and the fields that name the tampered entry: every reason this file's
 * tamperings meet, and any other by its tag alone, which no tampering expects. A folder a directory's reading names
 * by its path is its last segment.
 */
type Named =
	| { readonly tag: "SnapshotForeign"; readonly schemaName: string }
	| {
			readonly tag: "ChainRefused"
			readonly fault: Extract<BreakKind, "misnamed" | "unreadableMeta" | "brokenChain" | "diverged">
			readonly folder: string
	  }
	| {
			readonly tag: "ChainRefused"
			readonly fault: Extract<BreakKind, "foreignMeta">
			readonly folder: string
			readonly schema: string
	  }
	| { readonly tag: "ChainRefused"; readonly fault: Extract<BreakKind, "unreached"> }
	| {
			readonly tag: "TreeRefused"
			readonly fault: Extract<TreeKind, "halfSnapshot">
			readonly missing: string
	  }
	| {
			readonly tag: "TreeRefused"
			readonly fault: Extract<TreeKind, "strayEntry">
			readonly entry: string
	  }
	| {
			readonly tag: "TreeRefused"
			readonly fault: Extract<TreeKind, "notAFile">
			readonly folder: string
			readonly entry: string
	  }
	| {
			readonly tag: "TreeRefused"
			readonly fault: Extract<TreeKind, "noMeta">
			readonly folder: string
	  }
	| {
			readonly tag: "TreeRefused"
			readonly fault: Extract<TreeKind, "notDirectory" | "strayServed" | "strayDocument">
	  }
	| { readonly tag: "another reason"; readonly reason: CliError["reason"]["_tag"] }

/** What a chain break names. */
const brokenAt = (fault: ChainBreak): Named => {
	switch (fault.kind) {
		case "misnamed":
		case "unreadableMeta":
		case "brokenChain":
		case "diverged":
			return { tag: "ChainRefused", fault: fault.kind, folder: fault.folder }
		case "foreignMeta":
			return { tag: "ChainRefused", fault: fault.kind, folder: fault.folder, schema: fault.schema }
		case "unreached":
			return { tag: "ChainRefused", fault: fault.kind }
	}
}

/** What a tree fault names. */
const strayAt = (fault: TreeRefused["fault"]): Named => {
	switch (fault.kind) {
		case "halfSnapshot":
			return { tag: "TreeRefused", fault: fault.kind, missing: fault.missing }
		case "strayEntry":
			return { tag: "TreeRefused", fault: fault.kind, entry: fault.entry }
		case "notAFile":
			return {
				tag: "TreeRefused",
				fault: fault.kind,
				folder: lastSegment(fault.folder),
				entry: fault.entry
			}
		case "noMeta":
			return { tag: "TreeRefused", fault: fault.kind, folder: lastSegment(fault.folder) }
		case "notDirectory":
		case "strayServed":
		case "strayDocument":
			return { tag: "TreeRefused", fault: fault.kind }
	}
}

/** What a CliError's reason names. */
const namedOf = (reason: CliError["reason"]): Named => {
	switch (reason._tag) {
		case "SnapshotForeign":
			return { tag: reason._tag, schemaName: reason.found.schemaName }
		case "ChainRefused":
			return brokenAt(reason.fault)
		case "TreeRefused":
			return strayAt(reason.fault)
		case "ArgumentsRefused":
		case "MigrationNameRefused":
		case "DeclarationRefused":
		case "SchemaChoiceRefused":
		case "ConfigMissing":
		case "ConfigUnloaded":
		case "ExportRefused":
		case "SettingRefused":
		case "SchemaEntryRefused":
		case "LoginEntryRefused":
		case "ConnectionRefused":
		case "ConnectionThrew":
		case "ConnectionEnvironmentRefused":
		case "TreeUnread":
		case "FolderExists":
		case "FolderUnwritten":
		case "SnapshotUnwritten":
		case "ServedUnwritten":
		case "MigrationsUnread":
		case "SnapshotUnreadable":
		case "RosterReordered":
		case "DraftRefused":
		case "ServedRefused":
			return { tag: "another reason", reason: reason._tag }
	}
}

/** A finding as check states it: its kind, and the entry it lies at, a line apart. */
interface Finding {
	readonly kind: keyof typeof refusalText
	readonly where: string
}

/** The entry a finding's `where` names: its path, without a line. */
const entryOf = (where: string): string => {
	const [path] = Str.split(where, ":")
	return path
}

/**
 * What a tampering must come to: the stage generate refuses at and what its reason names, and the finding check
 * reports.
 */
interface Tampered {
	readonly stage: CliStage
	readonly named: Named
	readonly finding: Finding
}

/** Where a committed directory's tree fault lies for check: the schema's directory, left unread. */
const unreadTree: Finding = { kind: "strayEntry", where: schemaDir }

/** Where check reports a chain that does not end at snapshot.json. */
const chainEnd: Finding = { kind: "chainEnd", where: `${schemaDir}/${snapshotFileName}` }

/** The folder at `found`, which every case's directory holds: one or two drafted migrations. */
const folderAt = (found: Option.Option<string>): string =>
	Option.getOrThrowWith(found, () => new Error("a committed directory holds a drafted folder"))

/** Tampers with the copied workspace `dir`, `other` the other schema's committed directory. */
const tamper = (c: Case, dir: string, other: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const schema = `${dir}/${schemaDir}`
		const entries = yield* fs.readDirectory(schema)
		const folders = migrationFolders(entries)
		const newest = folderAt(Arr.last(folders))
		const oldest = folderAt(Arr.head(folders))
		const folder = c.newest ? newest : oldest
		const snapshot = `${schema}/${snapshotFileName}`
		const manifest = `${schema}/${manifestFileName}`
		const meta = `${schema}/${newest}/${metaFileName}`
		const newestMeta = `${schemaDir}/${newest}/${metaFileName}`
		switch (c.kind) {
			case "snapshot of another schema": {
				const others = `${other}/migrations/${otherSchema}`
				yield* fs.copyFile(`${others}/${snapshotFileName}`, snapshot)
				yield* fs.copyFile(`${others}/${manifestFileName}`, manifest)
				const tampered: Tampered = {
					stage: "snapshot",
					named: { tag: "SnapshotForeign", schemaName: "TamperOther" },
					finding: { kind: "unreadableSnapshot", where: `${schemaDir}/${snapshotFileName}` }
				}
				return tampered
			}
			case "snapshot removed": {
				yield* fs.remove(snapshot)
				yield* fs.remove(manifest)
				const tampered: Tampered = {
					stage: "snapshot",
					named: { tag: "ChainRefused", fault: "diverged", folder: newest },
					finding: chainEnd
				}
				return tampered
			}
			case "manifest.json removed": {
				yield* fs.remove(manifest)
				const tampered: Tampered = {
					stage: "filesystem",
					named: { tag: "TreeRefused", fault: "halfSnapshot", missing: manifestFileName },
					finding: unreadTree
				}
				return tampered
			}
			case "folder misnamed": {
				const misnamed = Str.slice(15)(folder)
				yield* fs.rename(`${schema}/${folder}`, `${schema}/${misnamed}`)
				const tampered: Tampered = {
					stage: "snapshot",
					named: { tag: "ChainRefused", fault: "misnamed", folder: misnamed },
					finding: { kind: "folderName", where: `${schemaDir}/${misnamed}` }
				}
				return tampered
			}
			case "folder removed": {
				yield* fs.remove(`${schema}/${newest}`, { recursive: true })
				const tampered: Tampered = {
					stage: "snapshot",
					named:
						c.folders === 1
							? { tag: "ChainRefused", fault: "unreached" }
							: { tag: "ChainRefused", fault: "diverged", folder: oldest },
					finding: chainEnd
				}
				return tampered
			}
			case "directory in a folder": {
				yield* fs.makeDirectory(`${schema}/${folder}/notes`)
				const tampered: Tampered = {
					stage: "filesystem",
					named: { tag: "TreeRefused", fault: "notAFile", folder, entry: "notes" },
					finding: unreadTree
				}
				return tampered
			}
			case "meta.json removed": {
				yield* fs.remove(`${schema}/${folder}/${metaFileName}`)
				const tampered: Tampered = {
					stage: "filesystem",
					named: { tag: "TreeRefused", fault: "noMeta", folder },
					finding: unreadTree
				}
				return tampered
			}
			case "meta.json malformed": {
				yield* fs.writeFileString(meta, "{ not json\n")
				const tampered: Tampered = {
					stage: "snapshot",
					named: { tag: "ChainRefused", fault: "unreadableMeta", folder: newest },
					finding: { kind: "unreadableMeta", where: newestMeta }
				}
				return tampered
			}
			case "meta.json of another schema": {
				const text = yield* fs.readFileString(meta)
				const read = succeeded(decodeMeta(text))
				yield* fs.writeFileString(meta, succeeded(writeMeta({ ...read, schema: otherSchema })))
				const tampered: Tampered = {
					stage: "snapshot",
					named: { tag: "ChainRefused", fault: "foreignMeta", folder: newest, schema: otherSchema },
					finding: { kind: "unreadableMeta", where: newestMeta }
				}
				return tampered
			}
			case "meta.json source edited": {
				const text = yield* fs.readFileString(meta)
				const read = succeeded(decodeMeta(text))
				yield* fs.writeFileString(meta, succeeded(writeMeta({ ...read, source: read.target })))
				const tampered: Tampered = {
					stage: "snapshot",
					named: { tag: "ChainRefused", fault: "brokenChain", folder: newest },
					finding: { kind: "brokenChain", where: newestMeta }
				}
				return tampered
			}
			case "stray file": {
				yield* fs.writeFileString(`${schema}/notes.txt`, "review later\n")
				const tampered: Tampered = {
					stage: "filesystem",
					named: { tag: "TreeRefused", fault: "strayEntry", entry: "notes.txt" },
					finding: unreadTree
				}
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
			const expected = yield* tamper(x, ws, committed.other)
			yield* writeConfig(ws, {
				schemas: [
					{
						name: "TamperShop",
						fixture: "shop",
						version: x.folders === 1 ? 2 : 1,
						workload: "none"
					}
				],
				connection: unconnected
			})
			const before = yield* contents(ws)
			const generated = yield* cli(ws, ["generate", configName], at(9))
			const label = Formatter.format(x)
			const report = generated.report
			assert.ok(report.outcome === "refused", `${label}: generate ${report.outcome}`)
			const refusal = report.refusal
			assert.ok(refusal instanceof CliError, `${label}: refused by ${refusal._tag}`)
			assert.deepEqual(
				{ stage: refusal.stage, named: namedOf(refusal.reason) },
				{ stage: expected.stage, named: expected.named },
				label
			)
			const after = yield* contents(ws)
			assert.deepEqual(after, before, `${label}: generate wrote`)
			const checked = yield* cli(ws, ["check", configName], nextNow())
			assert.equal(checked.code, 1, `${label}: check passes`)
			const spec = yield* Effect.orDie(specConfig(ws))
			const read = yield* resolvedConfig(defineConfig(spec), `${ws}/${configName}`)
			const resolved = succeeded(read)
			const [schemaCheck] = yield* Effect.orDie(check(resolved, ws))
			containsEqual(
				Arr.map(defined(schemaCheck, "the schema's check").findings, (f) => ({
					kind: f.kind,
					where: entryOf(f.where)
				})),
				expected.finding,
				label
			)
		})
	)

layer(NodeServices.layer, { excludeTestServices: true })(
	"a committed migrations directory tampered with, generated",
	(it) => {
		it.effect(
			"generate refuses by the reason naming the entry and writes nothing, and check reports it",
			(ctx) =>
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
								oracle: {
									kind: "specification",
									name: "the reason and the finding the committed directory's reading gives each tampering"
								},
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
								caseHang
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
