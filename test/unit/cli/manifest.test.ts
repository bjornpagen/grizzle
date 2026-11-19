import { assert, defined } from "@bjornpagen/testing/assert"
/**
 * A committed snapshot's two files as `grizzle check` and `grizzle generate` read them: a pair of another format than
 * this grizzle's (core/format.ts artifactFormat), whether snapshot.json records none, as every grizzle before formats
 * wrote, or manifest.json carries a seal of those grizzles' domain, reads as no snapshot, which check finds and generate
 * refuses at the stage snapshot, writing nothing; a sealed record that is not the one the schemas compile to is check's
 * finding, which generate writes back as the record, drafting no folder and leaving snapshot.json as it was; and a
 * manifest.json edited by hand under its seal reads as no snapshot.
 *
 * A case takes the committed directory of one schema's first draft (derived.fixtures.ts baseNeed) and commits one file
 * beside the other: snapshot.json without its format; manifest.json sealed under the earlier domain `manifest`; the
 * record with an edge left out, an edit no draft reads, sealed again; or that edit under the draft's seal. The oracle
 * is the first draft itself: each earlier form and the hand edit are check's unreadableSnapshot finding alone, which
 * generate refuses at the stage snapshot, writing nothing; and the resealed edit is check's manifestRecord finding
 * alone, which generate writes back to the draft's bytes, after which check passes.
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
import { manifestFileName, snapshotFileName } from "#compiler/deploy/snapshot/types.ts"
import { cliOver, configName, resolvedConfig, workspace } from "#test/pg/cli/support.ts"
import { succeeded } from "#test/support/assert.ts"
import { at, baseNeed, config, schemaDir } from "#test/unit/cli/derived.fixtures.ts"
import {
	type Commit,
	commitSpace,
	earlierSealed,
	editedManifest,
	unformatted
} from "#test/unit/cli/manifest.fixtures.ts"

/** A pair of another format reads as no snapshot, which check finds and generate refuses writing nothing; a record not the compile's is check's finding, which generate writes back drafting no folder; and a hand edit reads as no snapshot. */
export const aPairOfAnotherFormatReadsAsNoSnapshotARecordNotTheCompilesIsWrittenBackDraftingNoFolderAndAHandEditReadsAsNoSnapshot =
	property.exhaust(commitSpace, {
		box: "snapshot.json of no format, manifest.json under the earlier seal's domain, a record sealed again over an edit, and that edit under the draft's seal",
		needs: { baseNeed },
		situations: [
			"an earlier format",
			"an earlier format's seal",
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
					const manifestFile = `${ws}/${schemaDir}/${manifestFileName}`
					const snapshotFile = `${ws}/${schemaDir}/${snapshotFileName}`
					const read = yield* resolvedConfig(config, `${ws}/${configName}`)
					const resolved = succeeded(read)
					const pair = ((): { readonly snapshot: string; readonly manifest: string } => {
						switch (commit) {
							case "an earlier format":
								return { snapshot: unformatted(snapshot), manifest }
							case "an earlier format's seal":
								return { snapshot, manifest: earlierSealed(snapshot, manifest) }
							case "a record not the compile's":
								return { snapshot, manifest: editedManifest(snapshot, manifest, true) }
							case "a hand edit":
								return { snapshot, manifest: editedManifest(snapshot, manifest, false) }
						}
					})()
					yield* fs.writeFileString(snapshotFile, pair.snapshot)
					yield* fs.writeFileString(manifestFile, pair.manifest)
					const converted = readSnapshot(pair)
					const [checked] = yield* check(resolved, ws)
					const kinds = Arr.map(defined(checked, "the schema's check").findings, (f) => f.kind)
					if (commit !== "a record not the compile's") {
						assert.ok(converted._tag === "Failure", `${commit} reads as no snapshot`)
						assert.deepEqual(kinds, ["unreadableSnapshot"], Formatter.format(commit))
						const refused = yield* cliOver(ws, config, ["generate", configName], at(2))
						assert.equal(refused.code, 1, refused.stdout)
						assert.ok(
							Str.includes("refused at stage snapshot")(refused.stderr),
							`generate refuses ${commit} at the stage snapshot: ${refused.stderr}`
						)
						const snapshotAfter = yield* fs.readFileString(snapshotFile)
						const manifestAfter = yield* fs.readFileString(manifestFile)
						assert.equal(snapshotAfter, pair.snapshot, "generate writes nothing")
						assert.equal(manifestAfter, pair.manifest, "generate writes nothing")
						return
					}
					succeeded(converted, "the resealed record reads")
					assert.deepEqual(kinds, ["manifestRecord"], Formatter.format(commit))
					const regenerated = yield* cliOver(ws, config, ["generate", configName], at(2))
					assert.equal(regenerated.code, 0, regenerated.stderr)
					const after = yield* fs.readDirectory(`${ws}/${schemaDir}`)
					assert.deepEqual(Arr.sort(after, Order.String), entries, "generate drafts no folder")
					const rewritten = yield* fs.readFileString(manifestFile)
					assert.equal(rewritten, manifest, "manifest.json is the draft's again")
					const standing = yield* fs.readFileString(snapshotFile)
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
				original: "\tif (!isArtifactFormat(format)) {",
				replacement: "\tif (false) {",
				why: "A snapshot.json that records no format, as an earlier grizzle wrote it, is joined as this grizzle's, so check passes it and generate drafts from it."
			},
			{
				file: "packages/engine/src/deploy/snapshot/build.ts",
				original: `\tdigest(\`manifest-\${artifactFormat}\`, value, everyProperty)`,
				replacement: '\tdigest("manifest", value, everyProperty)',
				why: "The seal is digested under the domain earlier formats sealed in, so a manifest.json sealed by an earlier grizzle reads as this format's record."
			},
			{
				file: "packages/engine/src/deploy/snapshot/build.ts",
				original:
					"\tcanonicalEquals(recordForm(committed, asValues), recordForm(computed, asValues))",
				replacement: "\ttrue",
				why: "A committed record is never held to the compile's, so a resealed record no draft reads stands."
			},
			{
				file: "packages/grizzle/src/adapter/boundary/snapshot.ts",
				original: "\t\tcomputed === seal",
				replacement: "\t\ttrue",
				why: "manifest.json's seal is never held to the digest of both files, so a hand edit under the draft's seal reads as a snapshot."
			}
		]
	})
