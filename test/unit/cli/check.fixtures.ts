/** What the properties of check.test.ts read: its spaces, models and helpers. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { boolean, constant, type Gen, weighted } from "@bjornpagen/testing/gen"
import { type Need, NeedFailed } from "@bjornpagen/testing/property"
import { regex } from "arkregex"
import { Array as Arr, Cause, Effect, FileSystem, Option, Order, String as Str } from "effect"
import { decodeMeta } from "#adapter/boundary/meta.ts"
import type { refusalText } from "#cli/refusals.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { SchemaFingerprint } from "#compiler/core/ids.ts"
import { metaFileName, writeMeta } from "#compiler/deploy/render/folder.ts"
import { noTransactionMarker, placeholderMarker } from "#compiler/deploy/render/markers.ts"
import { snapshotFileName } from "#compiler/deploy/snapshot/types.ts"
import { defineConfig } from "#index.ts"
import { succeeded } from "#test/support/assert.ts"
import { fixtureNeedBudget } from "#test/support/budgets.ts"
import { chunked, joined } from "#test/support/chunked.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { besideFolders } from "#test/support/migrate/kit.ts"
import { shopV1 } from "#test/support/pg/cli/fixture.ts"
import { cliOver, configName, offlineOwner, workspace } from "#test/support/pg/cli/support.ts"

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

export const plantedGen: Gen<Planted> = (source) => ({
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

export type CheckFeature =
	| "a stray entry alone"
	| "four findings at once"
	| "a later folder off the chain the walk never reaches"
	| Exclude<Finding["kind"], "strayEntry">
	| "strayEntry"

const shop = Object.freeze(shopV1("ChkAll", "none"))

const ident = identifierOf(identity.schema(parsedSchemaName("ChkAll")))

const schemaDir = `migrations/${ident}`

/** The first folder the command line drafts, at the epoch, the second of a chain of none (cli/timestamp.ts). */
const init = "19700101000000_init"

/** The custom folder it drafts after init, a second later. */
const seed = "19700101000001_seed"

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
export const findingsOf = (p: Planted, layout: Layout): ReadonlyArray<Finding> => {
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

/** Writes the faults into the committed directory of the workspace `ws`. */
export const plant = (ws: string, p: Planted, layout: Layout) =>
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
						const meta = succeeded(decodeMeta(chunked(text)), "a committed meta.json")
						return joined(
							succeeded(
								writeMeta(
									meta.kind === "custom"
										? { ...meta, source: stranger, target: stranger }
										: { ...meta, source: stranger }
								)
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
export const entryOf = (where: string): string => Str.replace(lineSuffix, "")(where)

export const config = defineConfig({
	schemas: [shop.schema],
	logins: [shop.server],
	migrations: "migrations",
	rolePrefixBytes: 0,
	connection: () => offlineOwner
})

export const notesOf = (p: Planted, found: ReadonlyArray<Finding>): ReadonlyArray<CheckFeature> => [
	...Arr.dedupe(Arr.map(found, (f) => f.kind)),
	...(p.stray ? (["a stray entry alone"] as const) : []),
	...(Arr.dedupe(Arr.map(found, (f) => f.kind)).length >= 4
		? (["four findings at once"] as const)
		: []),
	...(!p.stray && p.init !== "sound" && p.seed === "off the chain"
		? (["a later folder off the chain the walk never reaches"] as const)
		: [])
]

/** What the search built once before its cases (fs, base, layout), now once per worker: every case on it reads them. */
export const fsNeed = {
	key: "test/unit/cli/check.fixtures.ts fsNeed",
	budget: fixtureNeedBudget,
	runNeeds: [],
	open: Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const base = yield* workspace("check-base")
		const drafted = yield* cliOver(base, config, ["generate", configName, "--name", "init"])
		assert.equal(drafted.code, 0, drafted.stderr)
		const custom = yield* cliOver(base, config, [
			"generate",
			configName,
			"--custom",
			"--name",
			"seed"
		])
		assert.equal(custom.code, 0, custom.stderr)
		const committed = yield* fs.readDirectory(`${base}/${schemaDir}`)
		assert.deepEqual(
			Arr.sort(committed, Order.String),
			Arr.sort([init, seed, ...besideFolders], Order.String)
		)
		const files = yield* fs.readDirectory(`${base}/${schemaDir}/${init}`)
		const layout: Layout = {
			setup: phaseFile(files, "setup"),
			structure: phaseFile(files, "structure"),
			publish: phaseFile(files, "publish")
		}
		return { fs, base, layout }
	}).pipe(
		Effect.mapBoth({
			onFailure: (error) =>
				NeedFailed.make({
					need: "test/unit/cli/check.fixtures.ts fsNeed",
					message: Cause.pretty(Cause.fail(error))
				}),
			onSuccess: (made) => Effect.succeed(made)
		})
	)
} as const satisfies Need<unknown>
