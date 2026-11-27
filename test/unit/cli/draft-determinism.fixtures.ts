/** What the property of draft-determinism.test.ts reads: its space, its runs of the bin and the trees they write. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { aimed, boolean, constant, element, type Gen, map, weighted } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, FileSystem, Option, Order, String as Str } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { configName, type ConfigSpec, unconnected, writeConfig } from "#test/pg/cli/support.ts"
import {
	binIn,
	type Cwd,
	firstFrom,
	otherConfigName,
	type Project,
	projectOf,
	type RunEnv,
	type RunFeature,
	runNotes,
	runPairGen
} from "#test/support/bin-runs.ts"
import { digitsOf, millisOf, type Second, secondAt, secondGen } from "#test/support/calendar.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { migrationFolders } from "#test/support/migrate/kit.ts"

/** The declared schema every run drafts: the CLI fixture's shop (test/pg/cli/fixture.ts). */
const schemaName = "DraftDet"

/** The schema's directory under a project, `migrations/<its PostgreSQL schema>`. */
const schemaDir = `migrations/${identifierOf(identity.schema(parsedSchemaName(schemaName)))}`

/** How the committed chain's one folder is named when the second folder is drafted on it. */
type Committed =
	| { readonly kind: "as drafted" }
	| { readonly kind: "by a clock"; readonly second: Second }

/** The second folder: the shop's next version drafted, or a custom folder of the committed snapshot. */
type SecondFolder = "drafted" | "custom"

/**
 * A case: two runs' processes, each in a time zone and a locale of its own and a project at a path of its own, which
 * draft the shop from nothing and then a second folder on the committed chain; the first folder named by `--name` or
 * after its change, the chain's one folder renamed to a second a clock once wrote, or not, and the second project's
 * migrations directory holding a hidden directory with a snapshot.json beside the schema's, or not.
 */
interface Drafting {
	readonly runs: readonly [RunEnv, RunEnv]
	readonly named: boolean
	readonly committed: Committed
	readonly second: SecondFolder
	readonly hidden: boolean
}

/** A second a clock wrote a folder at: any second the calendar's edges favour, its year short of 9999's last second. */
const clockSecondGen: Gen<Second> = map(secondGen, (s) =>
	s.year === 9999 ? { ...s, year: 9998 } : s
)

const draftingGen: Gen<Drafting> = (source) => ({
	runs: source.draw(runPairGen),
	named: source.draw(boolean),
	committed: source.draw(
		weighted<Committed>([
			[1, constant({ kind: "as drafted" })],
			[1, map(clockSecondGen, (second) => ({ kind: "by a clock", second }))]
		])
	),
	second: source.draw(element(["drafted", "custom"] as const)),
	hidden: source.draw(boolean)
})

/** A drafting whose first run runs from `cwd`. */
const fromCwd = (cwd: Cwd): Gen<Drafting> =>
	map(draftingGen, (d) => ({ ...d, runs: firstFrom(d.runs, cwd) }))

/**
 * Two runs drafting one source, each drawn on its own (draftingGen), or, for a witness while a situation is pending, a
 * drafting aimed at it: its first folder named, its second custom or drafted, its chain's folder renamed to a clock's
 * second or left as drafted, a run from each directory, or a project nested under a segment with a space.
 */
export const draftingSpace = aimed(draftingGen, [
	["a folder named by --name", map(draftingGen, (d) => ({ ...d, named: true }))],
	["a custom second folder", map(draftingGen, (d) => ({ ...d, second: "custom" as const }))],
	["a drafted second folder", map(draftingGen, (d) => ({ ...d, second: "drafted" as const }))],
	[
		"a second folder after the epoch's",
		map(draftingGen, (d) => ({ ...d, committed: { kind: "as drafted" as const } }))
	],
	[
		"a second folder after a clock's second",
		(source): Drafting => ({
			...source.draw(draftingGen),
			committed: { kind: "by a clock", second: source.draw(clockSecondGen) }
		})
	],
	["run from the project", fromCwd("the project")],
	["run from the workspace", fromCwd("the workspace")],
	["run from the checkout", fromCwd("the checkout")],
	[
		"a project nested in a path with a space",
		map(draftingGen, (d) => ({
			...d,
			runs: [{ ...d.runs[0], nesting: ["with space"] }, d.runs[1]] as const
		}))
	],
	["a hidden directory with a snapshot.json", map(draftingGen, (d) => ({ ...d, hidden: true }))],
	[
		"a configuration file of another name",
		map(draftingGen, (d) => ({
			...d,
			runs: [{ ...d.runs[0], config: otherConfigName }, d.runs[1]] as const
		}))
	]
])

export type DraftFeature =
	| "a folder named by --name"
	| "a second folder after the epoch's"
	| "a second folder after a clock's second"
	| "a custom second folder"
	| "a drafted second folder"
	| "a hidden directory with a snapshot.json"
	| RunFeature

export const draftFeatures: Arr.NonEmptyReadonlyArray<DraftFeature> = [
	"a folder named by --name",
	"a second folder after the epoch's",
	"a second folder after a clock's second",
	"a custom second folder",
	"a drafted second folder",
	"run from the project",
	"run from the workspace",
	"run from the checkout",
	"a project nested in a path with a space",
	"a hidden directory with a snapshot.json",
	"a configuration file of another name"
]

const draftNotes = (d: Drafting): ReadonlyArray<DraftFeature> => [
	...(d.named ? (["a folder named by --name"] as const) : []),
	d.committed.kind === "as drafted"
		? "a second folder after the epoch's"
		: "a second folder after a clock's second",
	d.second === "custom" ? "a custom second folder" : "a drafted second folder",
	...(d.hidden ? (["a hidden directory with a snapshot.json"] as const) : []),
	...runNotes(d.runs)
]

/**
 * The hidden directory a case leaves in the second project's migrations directory, as an editor or a backup leaves one:
 * it holds a snapshot.json, which a visible directory of a schema the configuration does not list would be an abandoned
 * schema's (cli/generate.ts abandonedSchemas), but no command reads a hidden entry.
 */
const hiddenDirectory = ".stash"

/** The shop at `version`, its login serving its full workload, migrated nowhere. */
const specAt = (version: 1 | 2): ConfigSpec => ({
	schemas: [{ name: schemaName, fixture: "shop", version, workload: "full" }],
	connection: unconnected
})

/** `p`'s project configured with the shop at `version`, its configuration file under the name its env gives it. */
const configured = (p: Project, version: 1 | 2) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		yield* writeConfig(p.dir, specAt(version))
		if (p.env.config !== configName) {
			yield* fs.rename(`${p.dir}/${configName}`, `${p.dir}/${p.env.config}`)
		}
	})

/**
 * Every file under a project's migrations directory, by its path there, with its bytes in base64, but the case's hidden
 * directory's: what a draft wrote.
 */
const treeOf = (p: Project) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const root = `${p.dir}/migrations`
		const entries = yield* fs.readDirectory(root, { recursive: true })
		const files: Array<readonly [string, string]> = []
		const drafted = Arr.filter(entries, (e) => !Str.startsWith(`${hiddenDirectory}/`)(e))
		for (const entry of Arr.sort(drafted, Order.String)) {
			const info = yield* fs.stat(`${root}/${entry}`)
			if (info.type === "File") {
				const bytes = yield* fs.readFile(`${root}/${entry}`)
				files.push([entry, Buffer.from(bytes).toString("base64")])
			}
		}
		return files
	})

/** The folders a project's schema directory holds, in name order. */
const foldersOf = (p: Project) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const entries = yield* fs.readDirectory(`${p.dir}/${schemaDir}`)
		return migrationFolders(entries)
	})

/** The two projects' trees are one, byte for byte, and their newest folder is stamped `stamp`: its name. */
const sameDraft = (a: Project, b: Project, stamp: string, step: string) =>
	Effect.gen(function* () {
		const treeA = yield* treeOf(a)
		const treeB = yield* treeOf(b)
		assert.deepEqual(treeB, treeA, `${step}: the two runs' trees`)
		const folders = yield* foldersOf(a)
		const newest = defined(Option.getOrUndefined(Arr.last(folders)), `${step}: a folder`)
		assert.ok(
			Str.startsWith(`${stamp}_`)(newest),
			`${step}: the folder ${newest} is stamped ${stamp}, the committed chain's next`
		)
		return newest
	})

/**
 * Drafts the shop from nothing in two projects, each run in its own process, time zone and locale from where its case
 * runs it, and then a second folder on the committed chain, the one folder renamed to a clock's second first where the
 * case says: after each, the two projects' trees are one, byte for byte, folder names included, the newest folder
 * stamped the epoch, then the second after the chain's one folder's.
 */
export const draftTwice = (checkout: string, d: Drafting, c: Case<DraftFeature>) =>
	Effect.scoped(
		Effect.gen(function* () {
			c.noteAll(draftNotes(d))
			const fs = yield* FileSystem.FileSystem
			const [envA, envB] = d.runs
			const a = yield* projectOf(envA)
			const b = yield* projectOf(envB)
			for (const p of [a, b]) {
				yield* configured(p, 1)
			}
			if (d.hidden) {
				yield* fs.makeDirectory(`${b.dir}/migrations/${hiddenDirectory}`, { recursive: true })
				yield* fs.writeFileString(`${b.dir}/migrations/${hiddenDirectory}/snapshot.json`, "{}\n")
			}
			const firstArgv = d.named ? ["--name", "first"] : []
			for (const p of [a, b]) {
				yield* binIn(checkout, p, "generate", firstArgv, [], {})
			}
			const first = yield* sameDraft(a, b, digitsOf(secondAt(0)), "the first folder")
			const committed =
				d.committed.kind === "as drafted"
					? first
					: `${digitsOf(d.committed.second)}${Str.slice(14)(first)}`
			if (committed !== first) {
				for (const p of [a, b]) {
					yield* fs.rename(`${p.dir}/${schemaDir}/${first}`, `${p.dir}/${schemaDir}/${committed}`)
				}
			}
			const after = d.committed.kind === "as drafted" ? secondAt(0) : d.committed.second
			const secondArgv = d.second === "custom" ? ["--custom", "--name", "second"] : []
			for (const p of [a, b]) {
				if (d.second === "drafted") {
					yield* configured(p, 2)
				}
				yield* binIn(checkout, p, "generate", secondArgv, [], {})
			}
			yield* sameDraft(a, b, digitsOf(secondAt(millisOf(after) + 1000)), "the second folder")
		})
	)
