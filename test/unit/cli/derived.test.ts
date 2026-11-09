import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	DateTime,
	Effect,
	FileSystem,
	Formatter,
	Order,
	Result,
	String as Str
} from "effect"
import { parseSnapshot } from "#adapter/boundary/snapshot.ts"
import { check } from "#cli/check.ts"
import type { Json } from "#compiler/core/canonical.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { jsonText, trustedJson } from "#compiler/core/trusted.ts"
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
import { snapshotJson } from "#test/support/snapshot-json.ts"

/**
 * The derived runtime facts snapshot.json records beside the snapshot, outside its fingerprint, are held to the compile:
 * `grizzle check` refuses facts that are not the ones the schemas compile to, and `grizzle generate` writes snapshot.json
 * again with them, drafting no folder and leaving manifest.json and the fingerprint as they were.
 *
 * A case takes the committed directory of one schema's first draft and plants stale facts in its snapshot.json: the
 * `derived` member removed, as a snapshot.json laid out before its facts were derived holds none; emptied of its
 * members; without its FK cycles alone; or holding a fact of a relation the schema does not declare. The oracle is the first draft itself: check
 * finds exactly the one stale-facts finding; generate exits 0, writes no folder, leaves manifest.json byte for byte,
 * and writes snapshot.json back to the very bytes the first draft wrote; and check then passes. A snapshot.json that
 * does not record every fact the layer reads, as the first three plants leave it, is refused by DbLayer.make's parse as
 * a MalformedArtifact at the missing member of `derived` naming the fix, never a crash.
 */
const plants = ["removed", "emptied", "without cycles", "foreign"] as const
type Plant = (typeof plants)[number]

const shop = shopV1("DerivedShop", "none")
const ident = identifierOf(identity.schema(parsedSchemaName("DerivedShop")))
const schemaDir = `migrations/${ident}`

const config = defineConfig({
	schemas: [shop.schema],
	logins: [shop.server],
	migrations: "migrations",
	connection: offlineOwner
})

const at = (second: number) =>
	DateTime.makeUnsafe({
		year: 2026,
		month: 11,
		day: 9,
		hour: 12,
		minute: 0,
		second,
		millisecond: 0
	})

/** snapshot.json's text with its derived facts made stale by `plant`. */
const staled = (text: string, plant: Plant): string => {
	const { derived: _recorded, ...rest } = trustedJson<{ readonly [key: string]: Json }>(text)
	const { derived } = trustedJson<{ readonly derived: { readonly [key: string]: Json } }>(text)
	const { fkCycles: _cycles, ...withoutCycles } = derived
	switch (plant) {
		case "removed":
			return jsonText(rest)
		case "emptied":
			return jsonText({ ...rest, derived: {} })
		case "without cycles":
			return jsonText({ ...rest, derived: withoutCycles })
		case "foreign":
			return jsonText({
				...rest,
				derived: { ...derived, closed: { Stale: { function: "stale" } } }
			})
	}
}

layer(NodeServices.layer, { excludeTestServices: true })("derived runtime facts", (it) => {
	it.effect(
		"check refuses stale derived facts, and generate writes snapshot.json back with the compile's, drafting no folder",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem
					const base = yield* workspace("derived-base")
					const drafted = yield* cliOver(
						base,
						config,
						["generate", configName, "--name", "init"],
						at(0)
					)
					assert.equal(drafted.code, 0, drafted.stderr)
					const snapshot = yield* fs.readFileString(`${base}/${schemaDir}/${snapshotFileName}`)
					const manifest = yield* fs.readFileString(`${base}/${schemaDir}/${manifestFileName}`)
					const listed = yield* fs.readDirectory(`${base}/${schemaDir}`)
					const entries = Arr.sort(listed, Order.String)
					return yield* exhaust(
						{
							suite: "unit/cli/derived-facts",
							generator: element(plants),
							literal: Formatter.format,
							limit: plants.length,
							box: "a snapshot.json whose derived facts are removed, emptied or of a relation the schema lacks",
							oracle: {
								kind: "specification",
								name: "the first draft's own snapshot.json and manifest.json, which generate writes back"
							},
							coverage: requiredInSpace<Plant>(plants),
							caseHang
						},
						(plant, c) =>
							Effect.scoped(
								Effect.gen(function* () {
									c.note(plant)
									const ws = yield* workspace("derived-planted")
									yield* fs.copy(base, ws, { overwrite: true })
									const file = `${ws}/${schemaDir}/${snapshotFileName}`
									const stale = staled(snapshot, plant)
									yield* fs.writeFileString(file, stale)
									if (plant !== "foreign") {
										const served = parseSnapshot(snapshotJson(stale), 0)
										assert.ok(
											Result.isFailure(served) &&
												served.failure.reason._tag === "MalformedArtifact" &&
												served.failure.reason.at[0] === "derived" &&
												Str.includes("run grizzle generate")(served.failure.message),
											`DbLayer.make's parse refuses ${plant} facts by name: ${Formatter.format(served)}`
										)
									}
									const refused = yield* cliOver(ws, config, ["check", configName], at(1))
									assert.equal(refused.code, 1, refused.stdout)
									const read = yield* resolvedConfig(config, `${ws}/${configName}`)
									const resolved = succeeded(read)
									const [checked] = yield* check(resolved, ws)
									assert.deepEqual(
										Arr.map(defined(checked, "the schema's check").findings, (f) => f.kind),
										["derivedFacts"],
										plant
									)
									const regenerated = yield* cliOver(ws, config, ["generate", configName], at(2))
									assert.equal(regenerated.code, 0, regenerated.stderr)
									assert.ok(
										Str.includes(snapshotFileName)(regenerated.stdout),
										`generate names snapshot.json: ${regenerated.stdout}`
									)
									const after = yield* fs.readDirectory(`${ws}/${schemaDir}`)
									assert.deepEqual(
										Arr.sort(after, Order.String),
										entries,
										"generate drafts no folder"
									)
									const rewritten = yield* fs.readFileString(file)
									assert.equal(rewritten, snapshot, "snapshot.json is the draft's again")
									const kept = yield* fs.readFileString(`${ws}/${schemaDir}/${manifestFileName}`)
									assert.equal(kept, manifest, "manifest.json stands")
									const passed = yield* cliOver(ws, config, ["check", configName], at(3))
									assert.equal(passed.code, 0, passed.stderr)
								})
							)
					)
				})
			)
	)
})
