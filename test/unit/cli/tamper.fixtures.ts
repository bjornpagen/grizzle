/** What the properties of tamper.test.ts read: its spaces, models and helpers. */

import { assert, containsEqual, defined } from "@bjornpagen/testing/assert"
import { boolean, type Gen } from "@bjornpagen/testing/gen"
import { type Need, NeedFailed } from "@bjornpagen/testing/property"
import {
	Array as Arr,
	Cause,
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
	configName,
	resolvedConfig,
	specConfig,
	unconnected,
	workspace,
	writeConfig
} from "#test/pg/cli/support.ts"
import { succeeded } from "#test/support/assert.ts"
import { fixtureNeedBudget } from "#test/support/budgets.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { migrationFolders } from "#test/support/migrate/kit.ts"

export type Kind =
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

export const kinds: Arr.NonEmptyReadonlyArray<Kind> = [
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

/** The committed directories a tampering applies to: of one drafted folder, and of two. */
const folderCounts = [1, 2] as const

/**
 * A case: every kind of tampering on each committed directory, of one folder and of two, the folder tampered with
 * drawn. Every case holds a chain of two folders under every kind, so what tells a chain's newest folder from its
 * oldest (a diverged chain's, a removed folder's) is in every case, the floor's first among them.
 */
export const casesGen: Gen<ReadonlyArray<Case>> = (source) =>
	Arr.flatMap(kinds, (kind) =>
		Arr.map(folderCounts, (folders) => ({ folders, kind, newest: source.draw(boolean) }))
	)

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
		case "SnapshotFormat":
		case "RosterReordered":
		case "DraftRefused":
		case "ServedRefused":
		case "UpgradeRefused":
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

/**
 * One tampering of a copy of the committed directory, generated and checked, its check run at the case's own clock's
 * next reading.
 */
export const tampered = (
	x: Case,
	committed: { readonly one: string; readonly two: string; readonly other: string },
	nextNow: () => DateTime.Utc
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

/** What the search built once before its cases (committed), now once per worker: every case on it reads it. */
export const committedNeed = {
	key: "test/unit/cli/tamper.fixtures.ts committedNeed",
	budget: fixtureNeedBudget,
	runNeeds: [],
	open: Effect.gen(function* () {
		const base = yield* workspace("tamper")
		const committed = {
			one: yield* drafted(base, "one", "TamperShop", [1]),
			two: yield* drafted(base, "two", "TamperShop", [1, 2]),
			other: yield* drafted(base, "other", "TamperOther", [1])
		}
		return committed
	}).pipe(
		Effect.mapBoth({
			onFailure: (error) =>
				NeedFailed.make({
					need: "test/unit/cli/tamper.fixtures.ts committedNeed",
					message: Cause.pretty(Cause.fail(error))
				}),
			onSuccess: (made) => Effect.succeed(made)
		})
	)
} as const satisfies Need<unknown>
