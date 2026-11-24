import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order, String as Str } from "effect"
import { readSnapshot } from "#adapter/boundary/snapshot.ts"
import { check } from "#cli/check.ts"
import { formatOf } from "#compiler/core/format.ts"
/**
 * A committed snapshot's two files as `grizzle check`, `grizzle generate` and `grizzle names` read them: a
 * snapshot.json of another format than this grizzle's (core/format.ts formatOf, the format's number and the record's
 * shape), one that records none, the format before this grizzle's or the one after it, or the number alone, as a draft
 * of d76a61066 records it, is check's snapshotFormat finding alone, carrying the format it records and this grizzle's,
 * its fix the installation drafted afresh, and generate and names refuse it at the stage format, writing nothing
 * (cli/committed.ts SnapshotFormat, the one refusal every command reads); a manifest.json sealed under a domain that
 * names no format, one edited by hand under its seal, and a record of another shape relabelled with this grizzle's
 * format, sealed under format 8's number, read as no snapshot, check's unreadableSnapshot finding alone, which generate
 * refuses at the stage snapshot; a sealed record that is not the one the schemas compile to is check's manifestRecord
 * finding, which generate writes back as the record, drafting no folder and leaving snapshot.json as it was; and a
 * record of this format holding an object of a kind this grizzle does not install, the database default a grizzle
 * before e1eb4f524 installed or an advanceFunction, reads as no snapshot, as a hand edit does (deploy/snapshot/build.ts
 * recordedSnapshot): a kind's removal is a change of the format, so no record of this one holds it.
 *
 * A case takes the committed directory of one schema's first draft (derived.fixtures.ts baseNeed) and commits one file
 * beside the other: snapshot.json of no format, of the format before this grizzle's or after it; both files as a draft
 * of format 3 left them, its constants recorded with no language, sealed under format 3's domain, which the format
 * check refuses before anything reads its record; both files as d76a61066 drafted them, qti-pie's pantry among them,
 * its declared statistics recording no dependencies, sealed under format 8's domain, snapshot.json recording the number
 * alone or this grizzle's format; manifest.json sealed under the earlier domain `manifest`; the record with an edge
 * left out, an edit no draft reads, sealed again; that edit under the draft's seal; or the record with a former
 * database default or an advanceFunction object its first, sealed again.
 *
 * Oracle: the first draft's own snapshot.json and manifest.json, and the format each commit records.
 *
 * Features: each commit.
 */
import { silentPhases } from "#compiler/core/phase.ts"
import { manifestFileName, snapshotFileName } from "#compiler/deploy/snapshot/types.ts"
import { cliOver, configName, resolvedConfig, workspace } from "#test/pg/cli/support.ts"
import { succeeded } from "#test/support/assert.ts"
import { chunked } from "#test/support/chunked.ts"
import { at, baseNeed, config, schemaDir } from "#test/unit/cli/derived.fixtures.ts"
import {
	type Commit,
	commitSpace,
	d76a61066Draft,
	formatlessSealed,
	editedManifest,
	formatCommits,
	formatThree,
	formatted,
	recordHolding
} from "#test/unit/cli/manifest.fixtures.ts"

/** A snapshot.json of another format is check's format finding, carrying the formats, which generate and names refuse at the stage format writing nothing; a seal naming no format and a hand edit read as no snapshot; and a record not the compile's is check's finding, which generate writes back drafting no folder. */
export const aSnapshotOfAnotherFormatIsItsOwnFindingASealNamingNoFormatOrAHandEditReadsAsNoSnapshotAndARecordNotTheCompilesIsWrittenBack =
	property.exhaust(commitSpace, {
		box: "snapshot.json of no format, of the format before this grizzle's and of the one after it, a draft of format 3, manifest.json under the earlier seal's domain, a record sealed again over an edit, that edit under the draft's seal, a record holding a former database default or an object of a removed kind, each sealed again, and d76a61066's draft, of format 8's number and relabelled with this grizzle's format",
		needs: { baseNeed },
		situations: [
			"format none",
			"the format before",
			"the format after",
			"a format 3 draft",
			"a seal naming no format",
			"a record not the compile's",
			"a hand edit",
			"a former database default",
			"a removed kind",
			"a d76a61066 draft",
			"a d76a61066 record under this format"
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
							case "format none":
							case "the format before":
							case "the format after":
								return { snapshot: formatted(snapshot, formatCommits[commit]), manifest }
							case "a format 3 draft":
								return formatThree(snapshot, manifest)
							case "a seal naming no format":
								return { snapshot, manifest: formatlessSealed(snapshot, manifest) }
							case "a record not the compile's":
								return { snapshot, manifest: editedManifest(snapshot, manifest, true) }
							case "a hand edit":
								return { snapshot, manifest: editedManifest(snapshot, manifest, false) }
							case "a former database default":
								return { snapshot, manifest: recordHolding(snapshot, manifest, "former") }
							case "a removed kind":
								return { snapshot, manifest: recordHolding(snapshot, manifest, "removed") }
							case "a d76a61066 draft":
								return d76a61066Draft(snapshot, manifest, false)
							case "a d76a61066 record under this format":
								return d76a61066Draft(snapshot, manifest, true)
						}
					})()
					yield* fs.writeFileString(snapshotFile, pair.snapshot)
					yield* fs.writeFileString(manifestFile, pair.manifest)
					const converted = readSnapshot({
						snapshot: chunked(pair.snapshot),
						manifest: chunked(pair.manifest)
					})

					const [checked] = yield* check(resolved, ws, silentPhases)
					const findings = defined(checked, "the schema's check").findings
					const kinds = Arr.map(findings, (f) => f.kind)
					if (
						commit === "format none" ||
						commit === "the format before" ||
						commit === "the format after" ||
						commit === "a format 3 draft" ||
						commit === "a d76a61066 draft"
					) {
						const recorded = formatCommits[commit]
						assert.deepEqual(
							Arr.map(findings, (f) =>
								f.kind === "snapshotFormat"
									? { kind: f.kind, recorded: f.recorded, expected: f.expected }
									: { kind: f.kind }
							),
							[{ kind: "snapshotFormat", recorded, expected: formatOf.snapshot }],
							`check finds ${commit} as the format it records, against this grizzle's`
						)
						for (const command of ["generate", "names"] as const) {
							const refused = yield* cliOver(ws, config, [command, configName], at(2))
							assert.equal(refused.code, 1, refused.stdout)
							assert.ok(
								Str.includes("refused at stage format")(refused.stderr),
								`${command} refuses ${commit} at the stage format: ${refused.stderr}`
							)
						}
						const snapshotLeft = yield* fs.readFileString(snapshotFile)
						const manifestLeft = yield* fs.readFileString(manifestFile)
						assert.equal(snapshotLeft, pair.snapshot, "nothing writes snapshot.json")
						assert.equal(manifestLeft, pair.manifest, "nothing writes manifest.json")
						return
					}
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
				original: "\t\tif (!isInstalledKind(o.kind)) {",
				replacement: "\t\tif (false) {",
				why: "A record holding an object of a kind this grizzle does not install is read as its snapshot, so a reader that switches on the kind meets undefined, as check over qti-pie's pantry met its database default (TypeError: Cannot read properties of undefined (reading 'kind'))."
			},
			{
				file: "packages/engine/src/core/format.ts",
				original: "\trecorded === formatOf[file]",
				replacement: "\trecorded === formatOf[file] || recorded === artifactFormat",
				why: "A file recording the format's number alone accepted, as format 8 recorded it: d76a61066's draft, its declared statistics recording no dependencies, passes the format check, so check meets it as an unreadable record, whose fix restores it from git, where it is a format this grizzle drafts afresh."
			},
			{
				file: "packages/engine/src/deploy/snapshot/build.ts",
				original: '\tif (!isFormatOf("snapshot", format)) {',
				replacement: "\tif (false) {",
				why: "A snapshot.json that records no format, as an earlier grizzle wrote it, or another, is joined as this grizzle's, so check passes it and generate drafts from it."
			},
			{
				file: "packages/grizzle/src/cli/committed.ts",
				original: '\t\t\treason._tag === "ArtifactFormat"',
				replacement: "\t\t\tfalse",
				why: "A snapshot of another format is folded back into an unreadable one: check finds unreadableSnapshot, whose fix restores the files from git, and generate refuses at the stage snapshot."
			},
			{
				file: "packages/engine/src/deploy/snapshot/build.ts",
				original: `\tdigest(\`manifest-\${formatOf.snapshot}\`, value, everyProperty)`,
				replacement: '\tdigest("manifest", value, everyProperty)',
				why: "The seal is digested under a domain that names no format, so a manifest.json sealed so reads as this format's record."
			},
			{
				file: "packages/engine/src/deploy/snapshot/build.ts",
				original: `\tdigest(\`manifest-\${formatOf.snapshot}\`, value, everyProperty)`,
				replacement: '\tdigest("manifest-8", value, everyProperty)',
				why: "The seal ignoring the record's shape: d76a61066's record relabelled with this grizzle's format seals under format 8's number, so check trusts it and fails reading a declared statistic of no dependencies inside grizzle (TypeError: Cannot read properties of undefined (reading 'map'))."
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
