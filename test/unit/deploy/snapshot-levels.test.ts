/**
 * snapshot.json records each level's laws as an outcome names them (deploy/snapshot/types.ts SnapshotLevel), so a law
 * whose side selects by a literal carries that literal, whose type member is absent, into the snapshot. The writer lays
 * each law out as one canonical value, as it lays out an installed statement, so the file and the fingerprint agree by
 * construction.
 *
 * The box, exhausted: a key over a side of R selected by a comparison of each kind of field R holds (a 64-bit integer,
 * a text, a boolean, a uuid, a closed id over the root's roster) with a literal of it, R declared at the root or at a
 * level over it, which records the key among the upper level's laws. The oracle is the snapshot itself: the text writeSnapshot writes reads back
 * (boundary/snapshot.ts readSnapshot, which refuses a text whose content is not its recorded fingerprint) as a snapshot
 * of the fingerprint written, every level recording the laws written; and what DbLayer.make serves of the file's JSON
 * value over each of its levels (boundary/snapshot.ts parseSnapshot) is exactly those members of what the file reads
 * back as: its fingerprint, its levels' schemas, the laws of the levels above the served one, its constraint-to-law map
 * and its codes.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case as CaseOf, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { parseSnapshot, readSnapshot } from "#adapter/boundary/snapshot.ts"
import {
	codebookOf,
	derivedHolds,
	derivedOf,
	finishSnapshot,
	targetState,
	writeSnapshot
} from "#compiler/deploy/snapshot/build.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { lawChecks } from "#compiler/deploy/snapshot/violation.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { installationsOf, own, rostersOf } from "#compiler/schema/own.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { snapshotJson } from "#test/support/snapshot-json.ts"
import { caseGen, type Placement, schemaOf } from "#test/unit/deploy/snapshot-levels.fixtures.ts"

/** Snapshot.json reads back as the snapshot written, of the same fingerprint, whatever literal a level's law selects by. */
export const snapshotJsonReadsBackAsTheSnapshotWrittenOfTheSameFingerprintWhateverLiteralALevelsLawSelectsBy =
	property.exhaust(finite(caseGen), {
		needs: {},
		situations: ["root", "level"] satisfies ReadonlyArray<Reached<Placement>>,
		check: (_, k: CaseOf<Placement>) => (c) =>
			Effect.sync(() => {
				const owned = succeeded(own(defined(schemaDescOf(schemaOf(c)), "the case's description")))
				const installation = succeeded(
					compileInstallation(
						owned,
						completeInstallOptions(
							owned,
							installationsOf(owned),
							[],
							[],
							firstCodebook(rostersOf(owned))
						)
					)
				)
				const snapshot = succeeded(
					finishSnapshot(
						succeeded(
							targetState({
								installation,
								workload: noWorkload,
								checks: lawChecks(installation)
							})
						)
					)
				)
				const files = succeeded(writeSnapshot(snapshot, derivedOf(installation)))
				const committed = succeeded(readSnapshot(files))
				const read = committed.snapshot
				assert.ok(
					derivedHolds(committed.derived, derivedOf(installation)),
					"the derived facts written are the compile's"
				)
				const lawsOf = (levels: typeof snapshot.levels) =>
					Arr.map(levels, (l) => Arr.map(l.laws, (law) => law.law))
				const codesOf = (book: ReturnType<typeof codebookOf>) =>
					Arr.map([...book.rosters.values()], (codec) => [codec.roster, codec.codes])
				assert.equal(read.fingerprint, snapshot.fingerprint)
				assert.deepEqual(lawsOf(read.levels), lawsOf(snapshot.levels))
				for (const level of read.levels.keys()) {
					const served = succeeded(parseSnapshot(snapshotJson(files.snapshot), level))
					assert.equal(served.fingerprint, read.fingerprint)
					assert.deepEqual(
						served.schemas,
						Arr.map(read.levels, (l) => l.schema)
					)
					assert.deepEqual(
						served.above,
						Arr.map(read.levels.slice(level + 1), (l) => ({ name: l.name, laws: l.laws }))
					)
					assert.deepEqual(served.constraintToLaw, read.constraintToLaw)
					assert.deepEqual(codesOf(served.codes), codesOf(codebookOf(read)))
					assert.deepEqual<unknown>(
						[...served.derived.closed],
						Arr.map([...derivedOf(installation).closed], ([name, c]) => [
							name,
							{
								...c,
								payload: Arr.map(c.payload, (p) =>
									p.dictionary === undefined ? { field: p.field, radix: p.radix } : p
								)
							}
						])
					)
					assert.deepEqual(served.derived.fkCycles, installation.laws.fkCycles)
				}
				k.note(c.placement)
			}),
		oracle: {
			kind: "specification",
			name: "the written snapshot reads back as itself, its fingerprint and its levels' laws"
		},
		box: "a key over a side selected by a literal of each field kind, stated at the root or at a level above it",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/snapshot/served.ts",
				original: "\tconst first = level + 1",
				replacement: "\tconst first = level + 2",
				why: "The served levels above the one served start a level late (snapshot/served.ts servedSnapshot)."
			},
			{
				file: "packages/engine/src/deploy/snapshot/build.ts",
				original: "\t\t\t\t\t\t\t\towned.levels.slice(0, i + 1).map((l) => l.fingerprint)",
				replacement: "\t\t\t\t\t\t\t\towned.levels.slice(0, i).map((l) => l.fingerprint)",
				why: "A lower level is owned alone without its own fingerprint, which its owner hashed (schema/own.ts ownLevel); its snapshot is refused."
			}
		]
	})
