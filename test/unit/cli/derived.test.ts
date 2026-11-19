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
 * Features: the derived member removed, a member left out, every member left out, a foreign fact, and a foreign fact
 * beside every member.
 */
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order, Result } from "effect"
import { parseSnapshot } from "#adapter/boundary/snapshot.ts"
import { check } from "#cli/check.ts"

import { manifestFileName, snapshotFileName } from "#compiler/deploy/snapshot/types.ts"
import { cliOver, configName, resolvedConfig, workspace } from "#test/pg/cli/support.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { snapshotJson } from "#test/support/snapshot-json.ts"
import {
	at,
	baseNeed,
	config,
	members,
	recordsEvery,
	schemaDir,
	type Situation,
	situationsOf,
	staled,
	stalingGen
} from "#test/unit/cli/derived.fixtures.ts"

/** Derived runtime facts: check refuses stale derived facts, and generate writes snapshot.json back with the compile's, drafting no folder. */
export const derivedRuntimeFactsCheckRefusesStaleDerivedFactsAndGenerateWritesSnapshotJsonBackWithTheCompilesDraftingNoFolder =
	property.exhaust(finite(stalingGen), {
		box: "a snapshot.json whose derived member is removed, or which leaves out any of the members the draft records, or whose closed facts hold one of a relation the schema lacks",
		needs: { baseNeed },
		situations: [
			"the derived member removed",
			"a member left out",
			"every member left out",
			"a foreign fact",
			"a foreign fact beside every member"
		] satisfies ReadonlyArray<Reached<Situation>>,
		check:
			({ baseNeed }, c: Case<Situation>) =>
			(staling) =>
				Effect.gen(function* () {
					const { fs, base, snapshot, manifest, entries } = yield* baseNeed
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
					assert.deepEqual(Arr.sort(after, Order.String), entries, "generate drafts no folder")
					const rewritten = yield* fs.readFileString(file)
					assert.equal(rewritten, snapshot, "snapshot.json is the draft's again")
					const kept = yield* fs.readFileString(`${ws}/${schemaDir}/${manifestFileName}`)
					assert.equal(kept, manifest, "manifest.json stands")
					const passed = yield* cliOver(ws, config, ["check", configName], at(3))
					assert.equal(passed.code, 0, passed.stderr)
				}),
		oracle: {
			kind: "specification",
			name: "the first draft's own snapshot.json and manifest.json, which generate writes back"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/snapshot/build.ts",
				original: "\tcanonicalEquals(recorded, derivedForm(computed))",
				replacement: "\trecorded === undefined || canonicalEquals(recorded, derivedForm(computed))",
				why: "A snapshot.json that records no derived member holds the compile's facts."
			},
			{
				file: "packages/engine/src/core/canonical.ts",
				original: '\t\tif (!value.startsWith("~")) {\n\t\t\treturn value\n\t\t}',
				replacement: "\t\t{}",
				why: 'Operator mutant (guard) at packages/engine/src/core/canonical.ts:1427 in <module>: `if (!value.startsWith("~")) {\n\t\t\treturn value\n\t\t}` becomes `{}`; the property fails (lane CATCH, grizzle 0baff5d6).'
			}
		]
	})
