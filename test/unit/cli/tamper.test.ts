/**
 * A committed migrations directory tampered with, generated: generate refuses before writing anything, by the reason
 * that names the tampered entry, and check reports the entry.
 *
 * A case takes a committed directory of one or two drafted migrations and tampers with one entry, the newest or the
 * oldest folder where the tampering applies to either: the snapshot's files replaced by another schema's or removed,
 * or manifest.json removed from beside snapshot.json; a folder renamed out of `<YYYYMMDDHHMMSS>_<name>`, removed, or
 * holding a directory; a meta.json removed, malformed, naming another schema, or breaking the chain (a source that is
 * no previous target); a fork, a second folder at a folder's second as two lines of work on one chain draft it, a custom
 * migration of the chain before the folder sorting first, whose source is its target, so its links alone would pass it,
 * or a copy of the folder under a name sorting after it; a stray file beside the folders; two parts of manifest.json beside the whole file, or a
 * migration file renamed as a lone part of itself, neither a layout generate writes (deploy/render/parts.ts laidOutFiles). Every
 * kind of tampering runs in every case, on directories and folders the case draws.
 *
 * - **generate refuses by the entry's reason:** `grizzle generate` is refused, its CliError's reason the one the
 *   directory's reading gives the tampering, by its tag and the fields that name the entry (cli/files.ts TreeRefused,
 *   cli/committed.ts SnapshotForeign and ChainRefused), and the directory is byte for byte as it was.
 * - **check reports the entry:** `grizzle check` exits 1, and its findings (cli/check.ts check) hold the one the
 *   tampering is, by its kind and where it lies.
 *
 * Oracle: the specification of the committed directory's reading, restated per tampering (tamperingOf): the reason and
 * the fields a refusal names, and the finding check reports there; never a refusal's or a finding's prose.
 *
 * Features: each kind of tampering.
 *
 * A second property edits a drafted folder's meta.json by hand under the seal grizzle wrote for it, a statement's
 * recorded digest or a decision's text, and reads it with each of meta.json's readers: generate's committed tree,
 * check, migrate before it connects, and the lock report. Each refuses it, by the
 * reason or the finding that names the folder's meta.json, since every reader decodes meta.json through its seal and
 * none proves its record again.
 */
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect } from "effect"

import {
	casesGen,
	committedNeed,
	decidedNeed,
	type Kind,
	kinds,
	type MetaEdit,
	metaEdited,
	metaEditGen,
	metaEdits,
	tampered
} from "#test/unit/cli/tamper.fixtures.ts"

/**
 * A committed migrations directory tampered with, generated: generate refuses by the reason naming the entry and
 * writes nothing, and check reports it.
 *
 * Budget: its suite's count before the conversion (unit/cli/tamper: 2 independent cases and 0 steered, Vitest at
 * grizzle 4ca3036a). Every case tampers with both committed directories, of one folder and of two (casesGen), so each
 * kill turns its floor's one case red: at TEST_SEED=1 to 5 (toolchain-test run, 2026-11-16) every required kind is
 * reached and its three kills are killed. Its kept case is the fork a custom migration hides, which its search found
 * under the fork check's kill.
 */
export const aCommittedMigrationsDirectoryTamperedWithGeneratedGenerateRefusesByTheReasonNamingTheEntryAndWritesNothingAndCheckReportsIt =
	property.explore(casesGen, {
		needs: { committedNeed },
		situations: kinds satisfies ReadonlyArray<Reached<Kind>>,
		check:
			({ committedNeed }, c: Case<Kind>) =>
			(cases) =>
				Effect.gen(function* () {
					const committed = yield* committedNeed
					yield* Effect.forEach(
						cases,
						(x) =>
							Effect.andThen(
								Effect.sync(() => {
									c.note(x.kind)
								}),
								tampered(x, committed)
							),
						{ discard: true }
					)
				}),
		oracle: {
			kind: "specification",
			name: "the reason and the finding the committed directory's reading gives each tampering"
		},
		budget: { runs: 2, steered: 0 },
		kept: [
			{
				token: ReplayToken(
					"test/unit/cli/tamper.test.ts#aCommittedMigrationsDirectoryTamperedWithGeneratedGenerateRefusesByTheReasonNamingTheEntryAndWritesNothingAndCheckReportsIt:7fff.0:0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0"
				),
				reason:
					"under the fork check dropped (its kill), shrunk in 17 candidates: two folders at one second, the first a custom migration of the empty chain, 19700101000000_a beside 19700101000000_init, whose source is its target, so the chain links and generate drafted on the forked chain",
				since: "2026-11-26"
			}
		],
		kills: [
			{
				file: "packages/grizzle/src/cli/committed.ts",
				original: "\t\tconst newest = Arr.last(folders)",
				replacement: "\t\tconst newest = Arr.head(folders)",
				why: "A diverged chain names its oldest folder."
			},
			{
				file: "packages/grizzle/src/cli/check.ts",
				original: '\t\tat("chainEnd", path(snapshotFileName), refusalText.chainEnd.problem)\n',
				replacement: "",
				why: "check drops a chain that does not end at snapshot.json."
			},
			{
				file: "packages/grizzle/src/cli/committed.ts",
				original: "\t\tOption.isSome(before) && before.value.second === second\n",
				replacement: "\t\tfalse\n",
				why: "Two folders of one second are no fork: a custom migration forked before a folder, sorting first, its source its target, links, and generate drafts on the forked chain; a copy of a folder sorting after it is refused only as a broken chain."
			},
			{
				file: "packages/engine/src/deploy/render/folder.ts",
				original: "\t\t? timestampParts(timestamp)\n",
				replacement: "\t\t? undefined\n",
				why: "Operator mutant (boolean-return) at packages/engine/src/deploy/render/folder.ts:477 in isFolderName: `{\n\tconst timestamp = folderTimestamp(name)\n\tconst prefix = folderPrefix(timestam` becomes `{ return false }`; the property fails (lane CATCH, grizzle 0baff5d6)."
			},
			{
				file: "packages/engine/src/deploy/render/parts.ts",
				original:
					"\t\tif (whole.has(name) || ordered.length < 2 || ordered.some((p, i) => p.number !== i + 1)) {",
				replacement: "\t\tif (ordered.length < 2 || ordered.some((p, i) => p.number !== i + 1)) {",
				why: "Parts beside the whole file lay out a file too: manifest.json is read as its two parts joined, not refused by name."
			},
			{
				file: "packages/engine/src/deploy/render/parts.ts",
				original:
					"\t\tif (whole.has(name) || ordered.length < 2 || ordered.some((p, i) => p.number !== i + 1)) {",
				replacement: "\t\tif (whole.has(name) || ordered.some((p, i) => p.number !== i + 1)) {",
				why: "A lone part is read as its file whole, so a migration file renamed as one is read as the file and nothing is refused."
			}
		]
	})

/**
 * A meta.json edited by hand under its seal, generated: a recorded statement's digest changed at any digit, or a
 * decision's text changed by words, a comment or whitespace, is refused by every reader of meta.json (generate, check,
 * migrate and the lock report), each naming the folder's meta.json, where the folder as drafted reads.
 *
 * Budget: every case edits a copy of the drafted directory (decidedNeed) each way, where it draws, and runs the four
 * readers over each, so each kill turns its floor's one case red; four cases.
 */
export const aMetaJsonEditedByHandUnderItsSealIsRefusedByEveryReaderOfMetaJsonEachNamingTheFolder =
	property.explore(metaEditGen, {
		needs: { decidedNeed },
		situations: metaEdits satisfies ReadonlyArray<Reached<MetaEdit>>,
		check:
			({ decidedNeed }, c: Case<MetaEdit>) =>
			(e) =>
				Effect.gen(function* () {
					const decided = yield* decidedNeed
					yield* Effect.forEach(
						metaEdits,
						(edit) =>
							Effect.andThen(
								Effect.sync(() => {
									c.note(edit)
								}),
								metaEdited(edit, e, decided)
							),
						{ discard: true }
					)
				}),
		oracle: {
			kind: "specification",
			name: "every reader decodes meta.json through its seal: the refusal and the finding a meta.json that does not decode gives each reader"
		},
		budget: { runs: 4, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/boundary/meta.ts",
				original: '\treturn computed.ok && computed.value === file["seal"]',
				replacement: "\treturn computed.ok",
				why: "meta.json's seal is not checked: a meta.json edited by hand, a digest or a decision's text, is read as grizzle wrote it, and no reader proves its record again (lane META8)."
			}
		]
	})
