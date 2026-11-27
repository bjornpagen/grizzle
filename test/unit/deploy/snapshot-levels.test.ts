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
 * and its codes; and nothing of a snapshot.json that records no format, or another, is served.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case as CaseOf, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order } from "effect"
import { parseSnapshot, readSnapshot } from "#adapter/boundary/snapshot.ts"
import { trusted } from "#compiler/core/trusted.ts"
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
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { jsonOf } from "#test/support/chunked.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import { snapshotJson } from "#test/support/snapshot-json.ts"
import {
	caseGen,
	installationOf,
	type LeveledFeature,
	leveledFeatures,
	leveledGen,
	leveledSchemas,
	type Placement,
	schemaOf
} from "#test/unit/deploy/snapshot-levels.fixtures.ts"

/** Snapshot.json reads back as the snapshot written, of the same fingerprint, whatever literal a level's law selects by. */
export const snapshotJsonReadsBackAsTheSnapshotWrittenOfTheSameFingerprintWhateverLiteralALevelsLawSelectsBy =
	property.exhaust(finite(caseGen), {
		needs: {},
		situations: ["root", "level"] satisfies ReadonlyArray<Reached<Placement>>,
		check: (_, k: CaseOf<Placement>) => (c) =>
			Effect.sync(() => {
				const installation = installationOf(schemaOf(c))
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
				const { format: _format, ...unformatted } = trusted<{
					readonly [key: string]: unknown
				}>(jsonOf(files.snapshot))

				assert.ok(
					parseSnapshot(unformatted, 0)._tag === "Failure" &&
						parseSnapshot({ ...unformatted, format: 0 }, 0)._tag === "Failure",
					"a snapshot.json of no format, or of another, serves nothing"
				)
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
				original: '\tif (!isFormatOf("snapshot", json[formatKey])) {',
				replacement: "\tif (false) {",
				why: "An application serves a snapshot.json of no format, or of another, as this grizzle's."
			},
			{
				file: "packages/engine/src/deploy/snapshot/served.ts",
				original: "\tconst first = level + 1",
				replacement: "\tconst first = level + 2",
				why: "The served levels above the one served start a level late (snapshot/served.ts servedSnapshot)."
			}
		]
	})

/**
 * Each level records the laws its schema, owned alone over the levels below it, states that the level below it does
 * not, and targetState reads them off the installation's theory: it checks no schema and builds no theory of a lower
 * level (deploy/snapshot/build.ts levelsOf).
 *
 * The box, exhausted: Z at the root and A at the level over it, A contained in Z, the contract Cents typing a field of
 * Z, of A or of both (A's name ordered first, so ownership meets A's use first), and a key statement over Z at the root
 * or over A at the level. The oracle is the specification: each level's schema value owned and compiled alone, its
 * theory's laws less the level below it's.
 */
export const eachLevelRecordsTheLawsItsSchemaAloneStatesThatTheLevelBelowDoesNotAndTargetStateBuildsNoTheory =
	property.exhaust(finite(leveledGen), {
		needs: {},
		situations: [
			"Cents used at root",
			"Cents used at level",
			"Cents used at both",
			"a key at root",
			"a key at level"
		] satisfies ReadonlyArray<Reached<LeveledFeature>>,
		check: (_, k: CaseOf<LeveledFeature>) => (c) =>
			Effect.gen(function* () {
				const { root, level } = leveledSchemas(c)
				const installation = installationOf(level)
				const checks = lawChecks(installation)
				const [state, built] = yield* callCounts(
					Effect.sync(() => succeeded(targetState({ installation, workload: noWorkload, checks }))),
					{
						theories: {
							file: "packages/engine/src/analysis/theory/theory.ts",
							name: "buildTheory"
						},
						checked: { file: "packages/engine/src/analysis/schema.ts", name: "checkedSchema" }
					}
				)
				assert.equal(built.theories, 0, "targetState builds no theory: it reads the installation's")
				assert.equal(built.checked, 0, "targetState checks no schema of a lower level")
				const stated = (s: AnySchema) =>
					Arr.map(installationOf(s).laws.theory.laws, (law) => law.id)
				const below = stated(root)
				assert.deepEqual(
					Arr.map(state.levels, (l) => Arr.map(l.laws, (law): string => law.law)),
					Arr.map([below, Arr.filter(stated(level), (id) => !below.includes(id))], (ids) =>
						Arr.sort(ids, Order.String)
					),
					"each level records the laws its schema alone states that the level below it does not"
				)
				for (const feature of leveledFeatures(c)) {
					k.note(feature)
				}
			}),
		oracle: {
			kind: "specification",
			name: "each level's schema value compiled alone, its theory's laws less the level below it's"
		},
		box: "Z at the root, A at the level contained in Z, Cents typing Z, A or both, a key at the root or the level",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/schema/own.ts",
				original: "\t\t\tstatementLevels: ordered.map((s) => s.level),",
				replacement: "\t\t\tstatementLevels: ordered.map(() => 0),",
				why: "Every statement is the root's: the level's containment and key are recorded among the root's laws."
			},
			{
				file: "packages/engine/src/schema/own.ts",
				original: "\t\t} else if (level < prior.level) {",
				replacement: "\t\t} else if (false) {",
				why: "A contract is at the level of the first relation by name that uses it, A's above Z's: Cents, which Z at the root uses, is recorded among the level's laws."
			},
			{
				file: "packages/engine/src/deploy/snapshot/build.ts",
				original:
					'\t\t\tlaw.detail.kind === "contract" ? [[law.id, law.detail.owned.level] as const] : []',
				replacement: '\t\t\tlaw.detail.kind === "contract" ? [[law.id, 0] as const] : []',
				why: "Every contract's law is the root's: Cents, which only the level's A uses, is recorded among the root's laws."
			},
			{
				file: "packages/engine/src/deploy/snapshot/build.ts",
				original: "\t\t...theory.primaryKeys.map((p) => [p.law.id, p.relation.level] as const),",
				replacement: "\t\t...theory.primaryKeys.map((p) => [p.law.id, 0] as const),",
				why: "Every primary key is the root's: A's, which the level declares, is recorded among the root's laws."
			}
		]
	})
