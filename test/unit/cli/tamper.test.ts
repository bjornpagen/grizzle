/**
 * A committed migrations directory tampered with, generated: generate refuses before writing anything, by the reason
 * that names the tampered entry, and check reports the entry.
 *
 * A case takes a committed directory of one or two drafted migrations and tampers with one entry, the newest or the
 * oldest folder where the tampering applies to either: the snapshot's files replaced by another schema's or removed,
 * or manifest.json removed from beside snapshot.json; a folder renamed out of `<YYYYMMDDHHMMSS>_<name>`, removed, or
 * holding a directory; a meta.json removed, malformed, naming another schema, or breaking the chain (a source that is
 * no previous target); a stray file beside the folders. Every kind of tampering runs in every case, on directories and
 * folders the case draws.
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
 */
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { cliClock, workspace } from "#test/pg/cli/support.ts"
import { casesGen, drafted, type Kind, kinds, tampered } from "#test/unit/cli/tamper.fixtures.ts"

/** A committed migrations directory tampered with, generated: generate refuses by the reason naming the entry and writes nothing, and check reports it. */
export const aCommittedMigrationsDirectoryTamperedWithGeneratedGenerateRefusesByTheReasonNamingTheEntryAndWritesNothingAndCheckReportsIt =
	property.explore(casesGen, {
		needs: {},
		situations: kinds satisfies ReadonlyArray<Reached<Kind>>,
		check: (_, c: Case<Kind>) => (cases) =>
			Effect.gen(function* () {
				const nextNow = cliClock()
				const base = yield* workspace("tamper")
				const committed = {
					one: yield* drafted(base, "one", "TamperShop", [1]),
					two: yield* drafted(base, "two", "TamperShop", [1, 2]),
					other: yield* drafted(base, "other", "TamperOther", [1])
				}
				yield* Effect.forEach(
					cases,
					(x) =>
						Effect.andThen(
							Effect.sync(() => {
								c.note(x.kind)
							}),
							tampered(x, committed, nextNow)
						),
					{ discard: true }
				)
			}),
		oracle: {
			kind: "specification",
			name: "the reason and the finding the committed directory's reading gives each tampering"
		},
		kept: [],
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
			}
		]
	})
