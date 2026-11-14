import { exhaust } from "@bjornpagen/testing/explore"
import { requiredInSpace } from "@bjornpagen/testing/features"
import { boolean, constant, type Gen, oneOf, subarray } from "@bjornpagen/testing/gen"
import { searched } from "@bjornpagen/testing/vitest"
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import {
	Array as Arr,
	DateTime,
	Effect,
	FileSystem,
	Formatter,
	Order,
	Record as Rec,
	Result
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
 * A case takes the committed directory of one schema's first draft and makes the facts its snapshot.json records stale
 * (Staling), every way over the members the draft records: the `derived` member removed, as a snapshot.json laid out
 * before its facts were derived holds none; or any of its members left out, every one of them included; or the closed
 * facts holding one of a relation the schema does not declare beside their own. The oracle is the first draft itself:
 * check finds exactly the one stale-facts finding; generate exits 0, writes no folder, leaves manifest.json byte for
 * byte, and writes snapshot.json back to the very bytes the first draft wrote; and check then passes. DbLayer.make's
 * parse refuses a snapshot.json that does not record every fact the layer reads as a MalformedArtifact at `derived`
 * naming the fix, never a crash, and reads one that records them all.
 *
 * Oracle: the first draft itself, its snapshot.json and manifest.json, which generate must write back.
 *
 * Plants (~/.cache/grizzle-release/BR04/plants): derived-facts-absent-hold.patch (a snapshot.json that records no
 * derived member holds the compile's facts).
 *
 * Features: the derived member removed, a member left out, every member left out, a foreign fact, and a foreign fact
 * beside every member.
 */

/**
 * How a case makes the draft's derived facts stale: the `derived` member removed whole; or kept with the recorded
 * members `dropped` left out and, at `foreign`, the closed facts holding a fact of a relation the schema does not
 * declare. A kept `derived` drops a member or holds the foreign fact, so every staling is stale.
 */
type Staling =
	| { readonly derived: "removed" }
	| { readonly derived: "kept"; readonly dropped: ReadonlyArray<string>; readonly foreign: boolean }

/** The member of `derived` that holds the closed facts, which a foreign fact is planted among. */
const closedMember = "closed"

/**
 * Every staling of facts that record `members`: the whole member removed, or each subset of them left out, the foreign
 * fact drawn where the closed facts are kept, and held where nothing is left out.
 */
const stalings = (members: ReadonlyArray<string>): Gen<Staling> =>
	oneOf<Staling>([
		constant({ derived: "removed" }),
		(source) => {
			const dropped = subarray(members)(source)
			const foreign = Arr.contains(dropped, closedMember)
				? false
				: dropped.length === 0 || boolean(source)
			return { derived: "kept", dropped, foreign }
		}
	])

/** What a staling leaves of the facts the layer reads: whether it records every one of them. */
const recordsEvery = (staling: Staling): boolean =>
	staling.derived === "kept" && staling.dropped.length === 0

/** What a staling does, as the search counts it. */
type Situation =
	| "the derived member removed"
	| "a member left out"
	| "every member left out"
	| "a foreign fact"
	| "a foreign fact beside every member"

/** The situations a staling of facts that record `members` reaches. */
const situationsOf = (
	staling: Staling,
	members: ReadonlyArray<string>
): ReadonlyArray<Situation> => {
	if (staling.derived === "removed") {
		return ["the derived member removed"]
	}
	const left: ReadonlyArray<Situation> =
		staling.dropped.length === 0
			? []
			: staling.dropped.length === members.length
				? ["a member left out", "every member left out"]
				: ["a member left out"]
	const foreign: ReadonlyArray<Situation> = !staling.foreign
		? []
		: staling.dropped.length === 0
			? ["a foreign fact", "a foreign fact beside every member"]
			: ["a foreign fact"]
	return [...left, ...foreign]
}

const shop = Object.freeze(shopV1("DerivedShop", "none"))
const ident = identifierOf(identity.schema(parsedSchemaName("DerivedShop")))
const schemaDir = `migrations/${ident}`

const config = defineConfig({
	schemas: [shop.schema],
	logins: [shop.server],
	migrations: "migrations",
	connection: () => offlineOwner
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

/** The derived facts snapshot.json records, by member, the closed facts by relation. */
type RecordedFacts = { readonly [member: string]: { readonly [key: string]: Json } }

/** snapshot.json's text with its derived facts made stale by `staling`. */
const staled = (text: string, staling: Staling): string => {
	const { derived: _recorded, ...rest } = trustedJson<{ readonly [key: string]: Json }>(text)
	if (staling.derived === "removed") {
		return jsonText(rest)
	}
	const { derived } = trustedJson<{ readonly derived: RecordedFacts }>(text)
	const kept = Rec.filter(derived, (_, member) => !Arr.contains(staling.dropped, member))
	return jsonText({
		...rest,
		derived: staling.foreign
			? { ...kept, [closedMember]: { ...kept[closedMember], Stale: { function: "stale" } } }
			: kept
	})
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
					const members = Rec.keys(
						trustedJson<{ readonly derived: RecordedFacts }>(snapshot).derived
					)
					return yield* exhaust(
						{
							suite: "unit/cli/derived-facts",
							generator: stalings(members),
							literal: Formatter.format,
							box: "a snapshot.json whose derived member is removed, or which leaves out any of the members the draft records, or whose closed facts hold one of a relation the schema lacks",
							oracle: {
								kind: "specification",
								name: "the first draft's own snapshot.json and manifest.json, which generate writes back"
							},
							coverage: requiredInSpace<Situation>([
								"the derived member removed",
								"a member left out",
								"every member left out",
								"a foreign fact",
								"a foreign fact beside every member"
							]),
							caseHang,
							concurrency: 1
						},
						(staling, c) =>
							Effect.scoped(
								Effect.gen(function* () {
									Arr.forEach(situationsOf(staling, members), (situation) => c.note(situation))
									const ws = yield* workspace("derived-planted")
									yield* fs.copy(base, ws, { overwrite: true })
									const file = `${ws}/${schemaDir}/${snapshotFileName}`
									const stale = staled(snapshot, staling)
									yield* fs.writeFileString(file, stale)
									const served = parseSnapshot(snapshotJson(stale), 0)
									if (recordsEvery(staling)) {
										assert.ok(
											Result.isSuccess(served),
											`DbLayer.make's parse reads facts that record every member: ${Formatter.format(served)}`
										)
									} else {
										assert.ok(
											Result.isFailure(served) &&
												served.failure.reason._tag === "MalformedArtifact" &&
												served.failure.reason.at[0] === "derived",
											`DbLayer.make's parse refuses ${Formatter.format(staling)} by name: ${Formatter.format(served)}`
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
										Formatter.format(staling)
									)
									const regenerated = yield* cliOver(ws, config, ["generate", configName], at(2))
									assert.equal(regenerated.code, 0, regenerated.stderr)
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
