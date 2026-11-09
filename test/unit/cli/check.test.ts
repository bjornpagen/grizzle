import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { boolean, constant, type Gen, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { regex } from "arkregex"
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
import type { refusalText } from "#cli/refusals.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { SchemaFingerprint } from "#compiler/core/ids.ts"
import { metaFileName, writeMeta } from "#compiler/deploy/render/folder.ts"
import { noTransactionMarker, placeholderMarker } from "#compiler/deploy/render/markers.ts"
import { manifestFileName, snapshotFileName } from "#compiler/deploy/snapshot/types.ts"
import { defineConfig } from "#index.ts"
import { shopV1 } from "#test/pg/cli/fixture.ts"
import {
	cliOver,
	configName,
	offlineOwner,
	resolvedConfig,
	workspace
} from "#test/pg/cli/support.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"

/**
 * `grizzle check` reports every finding at once, one per entry, never stopping at the first, generated: a committed
 * directory of one schema (its first draft, `init`, and a custom folder after it, `seed`) with a drawn set of faults
 * planted into it, and check's findings must be exactly the set the planted faults name, each at its entry.
 *
 * - **The faults:** snapshot.json unreadable; a folder's meta.json unreadable, or off the chain (its source no previous
 *   target); a statement that controls the transaction; a no-transaction marker below a file's first line; a file of no
 *   `NN-<words>.sql` name; a folder of no `<YYYYMMDDHHMMSS>_<name>` name, whose meta.json is no meta; a placeholder
 *   marker left; a stray entry beside the folders.
 * - **The model:** each fault is its own finding at its own entry, but for what the documented chain walk implies: the
 *   walk stops at the first folder whose meta.json is not the schema's link, so a later folder off the chain is no
 *   finding of its own; and a stray entry leaves the directory unread, its one finding. check exits 1 exactly when
 *   it finds anything; that a clean directory passes is the project suite's (project.test.ts).
 */
type MetaFault = "sound" | "unreadable" | "off the chain"

interface Planted {
	readonly stray: boolean
	readonly snapshot: boolean
	readonly init: MetaFault
	readonly seed: MetaFault
	readonly transactionControl: boolean
	readonly noTransaction: boolean
	readonly fileName: boolean
	readonly folderName: boolean
	readonly placeholder: boolean
}

const metaFaultGen: Gen<MetaFault> = weighted([
	[2, constant("sound")],
	[1, constant("unreadable")],
	[1, constant("off the chain")]
])

const plantedGen: Gen<Planted> = (source) => ({
	stray: source.draw(
		weighted([
			[5, constant(false)],
			[1, constant(true)]
		])
	),
	snapshot: source.draw(boolean),
	init: source.draw(metaFaultGen),
	seed: source.draw(metaFaultGen),
	transactionControl: source.draw(boolean),
	noTransaction: source.draw(boolean),
	fileName: source.draw(boolean),
	folderName: source.draw(boolean),
	placeholder: source.draw(boolean)
})

/** A finding as the model states it: its kind, and the entry it names, a line apart. */
interface Finding {
	readonly kind: keyof typeof refusalText
	readonly entry: string
}

type CheckFeature =
	| "a stray entry alone"
	| "four findings at once"
	| "a later folder off the chain the walk never reaches"
	| Exclude<Finding["kind"], "strayEntry">
	| "strayEntry"

const shop = shopV1("ChkAll", "none")
const ident = identifierOf(identity.schema(parsedSchemaName("ChkAll")))
const schemaDir = `migrations/${ident}`
const init = "20261012120000_init"
const seed = "20261012120001_seed"

/** The files of init the faults edit, by name, as its draft numbers them: its Setup, Structure and Publish files. */
interface Layout {
	readonly setup: string
	readonly structure: string
	readonly publish: string
}

/** The file of init's files whose name ends in `-<phase>.sql`. */
const phaseFile = (files: ReadonlyArray<string>, phase: string): string =>
	defined(
		Arr.findFirst(files, (f) => Str.endsWith(`-${phase}.sql`)(f)).pipe(Option.getOrUndefined),
		`init's ${phase} file`
	)

/** What check must find for a planted set, in no order. */
const findingsOf = (p: Planted, layout: Layout): ReadonlyArray<Finding> => {
	if (p.stray) {
		return [{ kind: "strayEntry", entry: schemaDir }]
	}
	const metaFinding = (folder: string, fault: MetaFault): ReadonlyArray<Finding> => {
		switch (fault) {
			case "sound":
				return []
			case "unreadable":
				return [{ kind: "unreadableMeta", entry: `${schemaDir}/${folder}/${metaFileName}` }]
			case "off the chain":
				return [{ kind: "brokenChain", entry: `${schemaDir}/${folder}/${metaFileName}` }]
		}
	}
	return [
		...(p.snapshot
			? [{ kind: "unreadableSnapshot", entry: `${schemaDir}/${snapshotFileName}` } as const]
			: []),
		...metaFinding(init, p.init),
		...(p.init === "sound" || p.seed === "unreadable" ? metaFinding(seed, p.seed) : []),
		...(p.transactionControl
			? [{ kind: "transactionControl", entry: `${schemaDir}/${init}/${layout.structure}` } as const]
			: []),
		...(p.noTransaction
			? [
					{
						kind: "misplacedNoTransaction",
						entry: `${schemaDir}/${init}/${layout.publish}`
					} as const
				]
			: []),
		...(p.placeholder
			? [{ kind: "placeholder", entry: `${schemaDir}/${init}/${layout.setup}` } as const]
			: []),
		...(p.fileName ? [{ kind: "fileName", entry: `${schemaDir}/${seed}` } as const] : []),
		...(p.folderName
			? ([
					{ kind: "folderName", entry: `${schemaDir}/draft` },
					{ kind: "unreadableMeta", entry: `${schemaDir}/draft/${metaFileName}` }
				] as const)
			: [])
	]
}

/** A fingerprint no folder reaches. */
const stranger = SchemaFingerprint(Str.repeat(64)("0"))

/** The text with `line` appended as its last line. */
const appended = (text: string, line: string): string =>
	`${Str.endsWith("\n")(text) ? text : `${text}\n`}${line}\n`

/** Plants the faults into the committed directory of the workspace `ws`. */
const plant = (ws: string, p: Planted, layout: Layout) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const dir = `${ws}/${schemaDir}`
		const edit = (path: string, f: (text: string) => string) =>
			Effect.flatMap(fs.readFileString(path), (text) => fs.writeFileString(path, f(text)))
		const metaOf = (folder: string, fault: MetaFault) => {
			const path = `${dir}/${folder}/${metaFileName}`
			switch (fault) {
				case "sound":
					return Effect.void
				case "unreadable":
					return fs.writeFileString(path, "{ not json\n")
				case "off the chain":
					return edit(path, (text) => {
						const meta = succeeded(decodeMeta(text), "a committed meta.json")
						return succeeded(
							writeMeta(
								meta.kind === "custom"
									? { ...meta, source: stranger, target: stranger }
									: { ...meta, source: stranger }
							)
						)
					})
			}
		}
		if (p.stray) {
			yield* fs.writeFileString(`${dir}/notes.txt`, "review later\n")
		}
		if (p.snapshot) {
			yield* fs.writeFileString(`${dir}/${snapshotFileName}`, "{ not json\n")
		}
		yield* metaOf(init, p.init)
		yield* metaOf(seed, p.seed)
		if (p.transactionControl) {
			yield* edit(`${dir}/${init}/${layout.structure}`, (text) => appended(text, "COMMIT;"))
		}
		if (p.noTransaction) {
			yield* edit(`${dir}/${init}/${layout.publish}`, (text) => appended(text, noTransactionMarker))
		}
		if (p.placeholder) {
			yield* edit(`${dir}/${init}/${layout.setup}`, (text) =>
				appended(text, `${placeholderMarker}: supply the value`)
			)
		}
		if (p.fileName) {
			yield* fs.writeFileString(`${dir}/${seed}/notes.sql`, "SELECT 1;\n")
		}
		if (p.folderName) {
			yield* fs.makeDirectory(`${dir}/draft`)
			yield* fs.writeFileString(`${dir}/draft/${metaFileName}`, "{}")
		}
	})

/** A finding's line, after its entry's path. */
const lineSuffix = regex(":[0-9]+$")

/** The entry a finding's `where` names: its path, without a line. */
const entryOf = (where: string): string => Str.replace(lineSuffix, "")(where)

const config = defineConfig({
	schemas: [shop.schema],
	logins: [shop.server],
	migrations: "migrations",
	connection: offlineOwner
})

const at = (second: number) =>
	DateTime.makeUnsafe({
		year: 2026,
		month: 10,
		day: 12,
		hour: 12,
		minute: 0,
		second,
		millisecond: 0
	})

const notesOf = (p: Planted, found: ReadonlyArray<Finding>): ReadonlyArray<CheckFeature> => [
	...Arr.dedupe(Arr.map(found, (f) => f.kind)),
	...(p.stray ? (["a stray entry alone"] as const) : []),
	...(Arr.dedupe(Arr.map(found, (f) => f.kind)).length >= 4
		? (["four findings at once"] as const)
		: []),
	...(!p.stray && p.init !== "sound" && p.seed === "off the chain"
		? (["a later folder off the chain the walk never reaches"] as const)
		: [])
]

layer(NodeServices.layer, { excludeTestServices: true })("grizzle check", (it) => {
	it.effect(
		"reports every planted fault at once, each at its entry, exactly as the chain walk implies, and exits 1 exactly when it finds one",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem
					const base = yield* workspace("check-base")
					const drafted = yield* cliOver(
						base,
						config,
						["generate", configName, "--name", "init"],
						at(0)
					)
					assert.equal(drafted.code, 0, drafted.stderr)
					const custom = yield* cliOver(
						base,
						config,
						["generate", configName, "--custom", "--name", "seed"],
						at(1)
					)
					assert.equal(custom.code, 0, custom.stderr)
					const committed = yield* fs.readDirectory(`${base}/${schemaDir}`)
					assert.deepEqual(Arr.sort(committed, Order.String), [
						init,
						seed,
						manifestFileName,
						snapshotFileName
					])
					const files = yield* fs.readDirectory(`${base}/${schemaDir}/${init}`)
					const layout: Layout = {
						setup: phaseFile(files, "setup"),
						structure: phaseFile(files, "structure"),
						publish: phaseFile(files, "publish")
					}
					return yield* explore(
						{
							suite: "unit/cli/check-at-once",
							draw: drawn(plantedGen),
							literal: Formatter.format,
							oracle: {
								kind: "specification",
								name: "each planted fault's own finding at its own entry, as the documented chain walk reaches it"
							},
							coverage: required<CheckFeature>(
								[
									"a stray entry alone",
									"four findings at once",
									"a later folder off the chain the walk never reaches",
									"strayEntry",
									"unreadableSnapshot",
									"unreadableMeta",
									"brokenChain",
									"transactionControl",
									"misplacedNoTransaction",
									"placeholder",
									"fileName",
									"folderName"
								],
								{ cases: 120, sense: notesOnly }
							),
							kept: [],
							runs: 40,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(p, c) =>
							Effect.scoped(
								Effect.gen(function* () {
									const ws = yield* workspace("check-planted")
									yield* fs.copy(base, ws, { overwrite: true })
									yield* plant(ws, p, layout)
									const expected = findingsOf(p, layout)
									c.noteAll(notesOf(p, expected))
									const ran = yield* cliOver(ws, config, ["check", configName], at(2))
									assert.equal(ran.code, expected.length > 0 ? 1 : 0, ran.stderr)
									const read = yield* resolvedConfig(config, `${ws}/${configName}`)
									const resolved = succeeded(read)
									const [checked] = yield* check(resolved, ws)
									const byEntry = (findings: ReadonlyArray<Finding>) =>
										Arr.sort(
											Arr.map(findings, (f) => `${f.kind} ${f.entry}`),
											Order.String
										)
									assert.deepEqual(
										byEntry(
											Arr.map(defined(checked, "the schema's check").findings, (f) => ({
												kind: f.kind,
												entry: entryOf(f.where)
											}))
										),
										byEntry(expected),
										Formatter.format(p)
									)
								})
							)
					)
				})
			)
	)
})
