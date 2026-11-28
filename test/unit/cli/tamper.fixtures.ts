/** What the properties of tamper.test.ts read: its spaces, models and helpers. */

import { assert, assertVariant, containsEqual, defined } from "@bjornpagen/testing/assert"
import { boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import { type Need, NeedFailed } from "@bjornpagen/testing/property"
import {
	Array as Arr,
	Cause,
	Effect,
	FileSystem,
	Formatter,
	Option,
	Order,
	String as Str
} from "effect"
import { decodeMeta } from "#adapter/boundary/meta.ts"
import { migrationLocks } from "#adapter/public/locks.ts"
import { check, checkFiles } from "#cli/check.ts"
import { type ChainBreak, CliError, type CliStage, type TreeRefused } from "#cli/errors.ts"
import type { refusalText } from "#cli/refusals.ts"
import type { Json } from "#compiler/core/canonical.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { silentPhases } from "#compiler/core/phase.ts"
import { jsonText, trusted } from "#compiler/core/trusted.ts"
import {
	metaFileName,
	metaSeal,
	type MigrationMeta,
	writeMeta
} from "#compiler/deploy/render/folder.ts"
import { manifestFileName, snapshotFileName } from "#compiler/deploy/snapshot/types.ts"
import { defineConfig } from "#index.ts"
import { failed, succeeded } from "#test/support/assert.ts"
import { fixtureNeedBudget } from "#test/support/budgets.ts"
import { chunked, joined } from "#test/support/chunked.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { migrationFolders } from "#test/support/migrate/kit.ts"
import {
	cli,
	configName,
	resolvedConfig,
	specConfig,
	unconnected,
	workspace,
	writeConfig
} from "#test/support/pg/cli/support.ts"

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
	| "a fork, a custom folder first"
	| "a fork, a draft second"
	| "stray file"
	| "manifest parts beside it"
	| "a lone part of a migration file"

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
	"a fork, a custom folder first",
	"a fork, a draft second",
	"stray file",
	"manifest parts beside it",
	"a lone part of a migration file"
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

/** A directory under `base` holding `name`'s migrations after drafting each of `versions` in turn. */
const drafted = (base: string, label: string, name: string, versions: ReadonlyArray<1 | 2>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const dir = `${base}/${label}`
		yield* fs.makeDirectory(dir)
		for (const version of versions) {
			yield* writeConfig(dir, {
				schemas: [{ name, fixture: "shop", version: version, workload: "none" }],
				connection: unconnected
			})
			const generated = yield* cli(dir, ["generate", configName])
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
			readonly fault: Extract<BreakKind, "forked">
			readonly folder: string
			readonly previous: string
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
			readonly fault: Extract<TreeKind, "brokenParts">
			readonly file: string
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
		case "forked":
			return {
				tag: "ChainRefused",
				fault: fault.kind,
				folder: fault.folder,
				previous: fault.previous
			}
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
		case "brokenParts":
			return { tag: "TreeRefused", fault: fault.kind, file: fault.file }
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
		case "ContractEntryRefused":
		case "ConnectionRefused":
		case "ConnectionThrew":
		case "ConnectionEnvironmentRefused":
		case "TreeUnread":
		case "FolderExists":
		case "FolderUnwritten":
		case "SnapshotUnwritten":
		case "ServedUnwritten":
		case "FileTooLarge":
		case "MigrationsUnread":
		case "DraftInputUnread":
		case "SnapshotUnreadable":
		case "SnapshotFormat":
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

/** The committed directories a case copies (committedNeed): of one folder, of two, and of the other schema. */
interface Committed {
	readonly one: string
	readonly two: string
	readonly other: string
}

/**
 * The folder a line of work forked from `committed` before `folder` drafts beside it, copied into the schema directory
 * `into`, and its name: the custom migration `a` of the chain before it, the empty one's before the oldest folder, one's
 * before the newest of two, which the command line drafts at that chain's next second, `folder`'s own, its source its
 * target.
 */
const customFork = (
	committed: Committed,
	folders: ReadonlyArray<string>,
	folder: string,
	into: string
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const ws = yield* workspace("fork")
			if (folder !== folderAt(Arr.head(folders))) {
				yield* fs.copy(committed.one, ws, { overwrite: true })
			}
			yield* writeConfig(ws, {
				schemas: [{ name: "TamperShop", fixture: "shop", version: 1, workload: "none" }],
				connection: unconnected
			})
			const forked = yield* cli(ws, ["generate", configName, "--custom", "--name", "a"])
			assert.equal(forked.code, 0, `the fork drafts: ${forked.stderr}`)
			const entries = yield* fs.readDirectory(`${ws}/${schemaDir}`)
			const fork = folderAt(Arr.last(migrationFolders(entries)))
			yield* fs.copy(`${ws}/${schemaDir}/${fork}`, `${into}/${fork}`)
			return fork
		})
	)

/** Tampers with the copied workspace `dir`, `committed` the directories it and the other schema's are copies of. */
const tamper = (c: Case, dir: string, committed: Committed) =>
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
				const others = `${committed.other}/migrations/${otherSchema}`
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
				const read = succeeded(decodeMeta(chunked(text)))
				yield* fs.writeFileString(
					meta,
					joined(succeeded(writeMeta({ ...read, schema: otherSchema })))
				)
				const tampered: Tampered = {
					stage: "snapshot",
					named: { tag: "ChainRefused", fault: "foreignMeta", folder: newest, schema: otherSchema },
					finding: { kind: "unreadableMeta", where: newestMeta }
				}
				return tampered
			}
			case "meta.json source edited": {
				const text = yield* fs.readFileString(meta)
				const read = succeeded(decodeMeta(chunked(text)))
				yield* fs.writeFileString(
					meta,
					joined(succeeded(writeMeta({ ...read, source: read.target })))
				)
				const tampered: Tampered = {
					stage: "snapshot",
					named: { tag: "ChainRefused", fault: "brokenChain", folder: newest },
					finding: { kind: "brokenChain", where: newestMeta }
				}
				return tampered
			}
			case "a fork, a custom folder first": {
				const fork = yield* customFork(committed, folders, folder, schema)
				const tampered: Tampered = {
					stage: "snapshot",
					named: { tag: "ChainRefused", fault: "forked", folder, previous: fork },
					finding: { kind: "forkedChain", where: `${schemaDir}/${folder}` }
				}
				return tampered
			}
			case "a fork, a draft second": {
				const second = `${Str.slice(0, 15)(folder)}zz`
				yield* fs.copy(`${schema}/${folder}`, `${schema}/${second}`)
				const tampered: Tampered = {
					stage: "snapshot",
					named: { tag: "ChainRefused", fault: "forked", folder: second, previous: folder },
					finding: { kind: "forkedChain", where: `${schemaDir}/${second}` }
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
			case "manifest parts beside it": {
				yield* fs.copyFile(manifest, `${schema}/manifest.1.json`)
				yield* fs.copyFile(manifest, `${schema}/manifest.2.json`)
				const tampered: Tampered = {
					stage: "filesystem",
					named: { tag: "TreeRefused", fault: "brokenParts", file: manifestFileName },
					finding: unreadTree
				}
				return tampered
			}
			case "a lone part of a migration file": {
				const files = yield* fs.readDirectory(`${schema}/${folder}`)
				const sql = folderAt(
					Arr.head(Arr.sort(Arr.filter(files, Str.endsWith(".sql")), Order.String))
				)
				const stem = Str.slice(0, -".sql".length)(sql)
				yield* fs.rename(`${schema}/${folder}/${sql}`, `${schema}/${folder}/${stem}.1.sql`)
				const tampered: Tampered = {
					stage: "filesystem",
					named: { tag: "TreeRefused", fault: "brokenParts", file: sql },
					finding: unreadTree
				}
				return tampered
			}
		}
	})

/** One tampering of a copy of the committed directory, generated and checked. */
export const tampered = (x: Case, committed: Committed) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const ws = yield* workspace("tampered")
			yield* fs.copy(x.folders === 1 ? committed.one : committed.two, ws, { overwrite: true })
			const expected = yield* tamper(x, ws, committed)
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
			const generated = yield* cli(ws, ["generate", configName])
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
			const checked = yield* cli(ws, ["check", configName])
			assert.equal(checked.code, 1, `${label}: check passes`)
			const spec = yield* Effect.orDie(specConfig(ws))
			const read = yield* resolvedConfig(defineConfig(spec), `${ws}/${configName}`)
			const resolved = succeeded(read)
			const [schemaCheck] = yield* Effect.orDie(check(resolved, ws, silentPhases))
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

/**
 * A meta.json edited by hand under the seal grizzle wrote for it, as each of its readers meets it: one statement's
 * recorded digest changed, or the text of a decision, the loss a schema's first migration records beside an abandoned
 * schema, changed.
 */
export type MetaEdit = "a digest changed" | "a decision's text changed"

export const metaEdits: Arr.NonEmptyReadonlyArray<MetaEdit> = [
	"a digest changed",
	"a decision's text changed"
]

/** What a decision's text is edited by: words, a comment or whitespace written after it. */
const decisionSuffixes: Arr.NonEmptyReadonlyArray<string> = [
	' AUTHORIZATION "edited"',
	" -- edited",
	"  "
]

/** Where a case edits a meta.json each way (MetaEdit): the digest step it changes, by its place among the record's
 * digest steps (modulo their count), and the hex digit of it it changes; and what it writes after a decision's text. */
export interface MetaEditCase {
	readonly step: number
	readonly digit: number
	readonly suffix: string
}

export const metaEditGen: Gen<MetaEditCase> = (source) => ({
	step: source.draw(int(0, 255)),
	digit: source.draw(int(0, 63)),
	suffix: source.draw(element(decisionSuffixes))
})

/** A recorded digest with its digit at `at` changed, to 1 where it is 0 and to 0 otherwise: another digest of the same
 * form. */
const otherDigest = (digest: string, at: number): string =>
	`${Str.slice(0, at)(digest)}${Str.slice(at, at + 1)(digest) === "0" ? "1" : "0"}${Str.slice(at + 1)(digest)}`

/** A meta's value with `edit` made where `e` places it, the step of its record it names, which its record must hold. */
const editedMeta = (meta: MigrationMeta, edit: MetaEdit, e: MetaEditCase): unknown => {
	assertVariant(meta, "kind", "drafted", "a drafted folder's meta")
	const digests = Arr.flatMap(meta.files, (f) => Arr.filter(f.steps, (s) => s.kind === "digest"))
	assert.ok(Arr.isReadonlyArrayNonEmpty(digests), "the record holds a digest")
	const target = digests[e.step % digests.length]
	let decided = false
	const files = Arr.map(meta.files, (f) => ({
		...f,
		steps: Arr.map(f.steps, (s): unknown => {
			if (edit === "a digest changed" && s.kind === "digest" && s === target) {
				return { kind: "digest", digest: otherDigest(s.digest, e.digit) }
			}
			if (edit === "a decision's text changed" && s.kind === "loss" && !decided) {
				decided = true
				return { ...s, statement: `${s.statement}${e.suffix}` }
			}
			return s
		})
	}))
	assert.ok(edit === "a digest changed" || decided, "the record holds a decision")
	return { ...meta, files }
}

/** A drafted directory whose one folder holds a decision: TamperShop's first migration, drafted beside TamperOther's
 * directory, which the configuration no longer lists, so the folder records the loss of TamperOther's rows. */
const decidedDraft = (base: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const dir = `${base}/decided`
		yield* fs.makeDirectory(dir)
		for (const name of ["TamperOther", "TamperShop"]) {
			yield* writeConfig(dir, {
				schemas: [{ name, fixture: "shop", version: 1, workload: "none" }],
				connection: unconnected
			})
			const generated = yield* cli(dir, ["generate", configName])
			assert.equal(generated.code, 0, `${name} drafts`)
		}
		return dir
	})

/** The drafted directory every case edits a copy of (decidedDraft), built once per worker. */
export const decidedNeed = {
	key: "test/unit/cli/tamper.fixtures.ts decidedNeed",
	budget: fixtureNeedBudget,
	runNeeds: [],
	open: Effect.flatMap(workspace("decided"), decidedDraft).pipe(
		Effect.mapBoth({
			onFailure: (error) =>
				NeedFailed.make({
					need: "test/unit/cli/tamper.fixtures.ts decidedNeed",
					message: Cause.pretty(Cause.fail(error))
				}),
			onSuccess: (made) => Effect.succeed(made)
		})
	)
} as const satisfies Need<unknown>

/**
 * A copy of the decided directory whose folder's meta.json is edited by hand (editedMeta) under its seal, read by each
 * of meta.json's readers, which all decode it through its seal (boundary/meta.ts readMeta): generate's committed tree,
 * refused at `snapshot` with ChainRefused `unreadableMeta` naming the folder; check, and migrate's reading before it
 * connects (check.ts checkFiles), each finding `unreadableMeta` at the folder's meta.json, and migrate itself refused
 * before connecting; and the lock report (adapter/public/locks.ts migrationLocks), refused. The copy as drafted is read by every one of them first.
 */
export const metaEdited = (edit: MetaEdit, e: MetaEditCase, decided: string) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const ws = yield* workspace("meta-edited")
			yield* fs.copy(decided, ws, { overwrite: true })
			const schema = `${ws}/${schemaDir}`
			const entries = yield* fs.readDirectory(schema)
			const folder = folderAt(Arr.head(migrationFolders(entries)))
			const meta = `${schema}/${folder}/${metaFileName}`
			const metaWhere = `${schemaDir}/${folder}/${metaFileName}`
			const locks = migrationLocks(`${ws}/migrations`)
			const drafted = yield* Effect.result(locks)
			succeeded(drafted, "the lock report reads the drafted meta.json")
			const text = yield* fs.readFileString(meta)
			const original = succeeded(decodeMeta(chunked(text)), "the drafted meta.json")

			const seal = succeeded(metaSeal(original), "the drafted meta's seal")
			yield* fs.writeFileString(
				meta,
				jsonText(trusted<Json>({ meta: editedMeta(original, edit, e), seal }))
			)
			const spec = yield* Effect.orDie(specConfig(ws))
			const read = yield* resolvedConfig(defineConfig(spec), `${ws}/${configName}`)
			const resolved = succeeded(read, "the configuration")
			const unreadable: Named = { tag: "ChainRefused", fault: "unreadableMeta", folder }
			const generated = (yield* cli(ws, ["generate", configName])).report
			assert.ok(generated.outcome === "refused", `${edit}: generate ${generated.outcome}`)
			const refusal = generated.refusal
			assert.ok(refusal instanceof CliError, `${edit}: generate refused by ${refusal._tag}`)
			assert.deepEqual(
				{ stage: refusal.stage, named: namedOf(refusal.reason) },
				{ stage: "snapshot", named: unreadable },
				`${edit}: generate`
			)
			const finding: Finding = { kind: "unreadableMeta", where: metaWhere }
			const [checked] = yield* Effect.orDie(check(resolved, ws, silentPhases))
			const [filed] = yield* checkFiles(resolved, ws)
			for (const [reader, findings] of [
				["check", defined(checked, "the schema's check").findings],
				["migrate", defined(filed, "the schema's files").findings]
			] as const) {
				containsEqual(
					Arr.map(findings, (f) => ({ kind: f.kind, where: entryOf(f.where) })),
					finding,
					`${edit}: ${reader}`
				)
			}
			const migrated = (yield* cli(ws, ["migrate", configName])).report
			assert.deepEqual(
				{ outcome: migrated.outcome, code: migrated.code },
				{ outcome: "ran", code: 1 },
				`${edit}: migrate refused before connecting`
			)
			const edited = yield* Effect.result(locks)
			failed(edited, `${edit}: the lock report reads it`)
		})
	)
