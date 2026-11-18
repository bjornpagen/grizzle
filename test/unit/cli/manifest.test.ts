/**
 * manifest.json's form, the record of the committed snapshot: `grizzle check` refuses a manifest.json of the form a
 * grizzle before records wrote and one whose sealed record is not the one the schemas compile to, each naming its fix,
 * and `grizzle generate` writes it back as the record, drafting no folder and leaving snapshot.json as it was; a
 * manifest.json edited by hand under its seal reads as no snapshot.
 *
 * A case takes the committed directory of one schema's first draft (derived.fixtures.ts baseNeed) and commits one
 * manifest.json beside its snapshot.json: the earlier form, every installed statement whole with its reasons, state and
 * phase and no seal, built of the draft's record and the content the schema compiles to; the record with an edge left
 * out, an edit no draft reads, sealed again; or that edit under the draft's seal. The oracle is the first draft itself:
 * the earlier form reads as the draft's record by the one conversion (boundary/snapshot.ts readSnapshot), check finds
 * exactly its earlierManifest finding, names refuses it at the stage manifest, and generate exits 0, writes no folder,
 * writes manifest.json back to the draft's bytes and leaves snapshot.json byte for byte, after which check passes; the
 * resealed edit is check's manifestRecord finding alone, which generate writes back the same way; and the hand edit is
 * check's unreadableSnapshot finding, which generate refuses at the stage snapshot, writing nothing.
 *
 * Oracle: the first draft's own snapshot.json and manifest.json.
 *
 * Features: each commit.
 */
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order, String as Str } from "effect"
import { readSnapshot } from "#adapter/boundary/snapshot.ts"
import { check } from "#cli/check.ts"
import { compileSchema } from "#cli/config.ts"
import { sameText } from "#compiler/core/canonical.ts"
import { manifestFileName, snapshotFileName } from "#compiler/deploy/snapshot/types.ts"
import { cliOver, configName, resolvedConfig, workspace } from "#test/pg/cli/support.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { at, baseNeed, config, schemaDir } from "#test/unit/cli/derived.fixtures.ts"
import {
	type Commit,
	commitSpace,
	contentOf,
	earlierManifest,
	editedManifest
} from "#test/unit/cli/manifest.fixtures.ts"

/** manifest.json's form: check refuses an earlier form and a record not the compile's, generate writes the record back drafting no folder, and a hand edit reads as no snapshot. */
export const manifestJsonCheckRefusesAnEarlierFormAndARecordNotTheCompilesAndGenerateWritesTheRecordBackDraftingNoFolder =
	property.exhaust(commitSpace, {
		box: "manifest.json of the earlier form, a record sealed again over an edit, and that edit under the draft's seal",
		needs: { baseNeed },
		situations: [
			"the earlier form",
			"a record not the compile's",
			"a hand edit"
		] satisfies ReadonlyArray<Reached<Commit>>,
		check:
			({ baseNeed }, c: Case<Commit>) =>
			(commit) =>
				Effect.gen(function* () {
					const { fs, base, snapshot, manifest, entries } = yield* baseNeed
					c.note(commit)
					const ws = yield* workspace("manifest-planted")
					yield* fs.copy(base, ws, { overwrite: true })
					const file = `${ws}/${schemaDir}/${manifestFileName}`
					const read = yield* resolvedConfig(config, `${ws}/${configName}`)
					const resolved = succeeded(read)
					const record = succeeded(readSnapshot({ snapshot, manifest }), "the draft's files read")
					const committed = (() => {
						switch (commit) {
							case "the earlier form":
								return Effect.map(
									Effect.flatMap(
										Effect.fromResult(
											compileSchema(defined(resolved.schemas[0], "the configuration's schema"))
										),
										(compiled) => contentOf(compiled, record.snapshot)
									),
									(content) => earlierManifest(manifest, content)
								)
							case "a record not the compile's":
								return Effect.succeed(editedManifest(snapshot, manifest, true))
							case "a hand edit":
								return Effect.succeed(editedManifest(snapshot, manifest, false))
						}
					})()
					const text = yield* committed
					yield* fs.writeFileString(file, text)
					const converted = readSnapshot({ snapshot, manifest: text })
					const [checked] = yield* check(resolved, ws)
					const kinds = Arr.map(defined(checked, "the schema's check").findings, (f) => f.kind)
					switch (commit) {
						case "the earlier form": {
							const earlier = succeeded(converted, "the earlier form reads")
							assert.equal(earlier.form, "earlier", "manifest.json reads as the earlier form")
							assert.ok(
								sameText(earlier.snapshot, record.snapshot),
								"the earlier form converts to the draft's record"
							)
							assert.deepEqual(kinds, ["earlierManifest"], Formatter.format(commit))
							const named = yield* cliOver(ws, config, ["names", configName], at(1))
							assert.equal(named.code, 1, named.stdout)
							assert.ok(
								Str.includes("refused at stage manifest")(named.stderr),
								`names refuses the earlier form at the stage manifest: ${named.stderr}`
							)
							break
						}
						case "a record not the compile's":
							assert.equal(succeeded(converted, "the resealed record reads").form, "recorded")
							assert.deepEqual(kinds, ["manifestRecord"], Formatter.format(commit))
							break
						case "a hand edit": {
							assert.ok(
								converted._tag === "Failure",
								"a hand edit under the draft's seal reads as no snapshot"
							)
							assert.deepEqual(kinds, ["unreadableSnapshot"], Formatter.format(commit))
							const refused = yield* cliOver(ws, config, ["generate", configName], at(2))
							assert.equal(refused.code, 1, refused.stdout)
							assert.ok(
								Str.includes("refused at stage snapshot")(refused.stderr),
								`generate refuses a hand edit at the stage snapshot: ${refused.stderr}`
							)
							const unwritten = yield* fs.readFileString(file)
							assert.equal(unwritten, text, "generate writes nothing")
							return
						}
					}
					const regenerated = yield* cliOver(ws, config, ["generate", configName], at(2))
					assert.equal(regenerated.code, 0, regenerated.stderr)
					const after = yield* fs.readDirectory(`${ws}/${schemaDir}`)
					assert.deepEqual(Arr.sort(after, Order.String), entries, "generate drafts no folder")
					const rewritten = yield* fs.readFileString(file)
					assert.equal(rewritten, manifest, "manifest.json is the draft's again")
					const standing = yield* fs.readFileString(`${ws}/${schemaDir}/${snapshotFileName}`)
					assert.equal(standing, snapshot, "snapshot.json stands")
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
				original: '\t\tObject.hasOwn(migration, "seal")',
				replacement: "\t\ttrue",
				why: "A manifest.json of the earlier form is read as a record whose seal it lacks, so it is refused as a hand edit rather than converted."
			},
			{
				file: "packages/grizzle/src/cli/generate.ts",
				original: '\t\t\t(committed.form === "earlier" ||\n',
				replacement: "\t\t\t(false ||\n",
				why: "generate drafts nothing from a manifest.json of the earlier form whose schema is unchanged, so it never writes the record in its place."
			},
			{
				file: "packages/engine/src/deploy/snapshot/build.ts",
				original:
					"\tcanonicalEquals(recordForm(committed, asValues), recordForm(computed, asValues), everyProperty)",
				replacement: "\ttrue",
				why: "A committed record is never held to the compile's, so a resealed record no draft reads stands."
			},
			{
				file: "packages/grizzle/src/adapter/boundary/snapshot.ts",
				original: "\t\t\tcomputed === seal",
				replacement: "\t\t\ttrue",
				why: "manifest.json's seal is never held to the digest of both files, so a hand edit under the draft's seal reads as a snapshot."
			}
		]
	})
