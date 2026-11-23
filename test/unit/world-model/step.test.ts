/**
 * The worlds model's step function by itself, over the docs installation: from its initial state over a generated
 * reality, a walk of generated actions under swarm weights, each answered by every branch `step` allows and continued
 * along one of them.
 *
 * - Every branch of every step keeps every invariant `invariantsOf` judges: the laws hold on reality, no pooled
 *   connection keeps a role or claims, no session holds another login's role, and a whole entry shows exactly reality.
 * - Every outcome agrees with itself as the real system shows it; rows and read-backs agree as keyed sets: reordered rows agree, and rows missing a fact, or repeating one, do not, nor does a read-back
 *   repeating a row of its rows or its delta.
 * - The walks reach every action kind, so each kind's branches are judged.
 *
 * The installation's names are the compiler's, read once: the model's semantics, not the compiler, is under test.
 *
 * The migration folders: from an installation over the docs base to another, or to it with one native law added, the
 * files the model drafts (model/session/migrate.ts folderFiles) are the phases, in order and number, of the folder
 * grizzle's generate drafts (execute/catalog.ts draftedPhases).
 *
 * Oracles: the specification for the step (invariantsOf, and the model's outcome as the real system shows it, read
 * back by observedNext); a second implementation for the folders, grizzle's generate. Features: every action kind,
 * rows and read-backs compared as keyed sets; a worlds change, none, and a new law.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { draftedPhases } from "#test/support/worlds/execute/catalog.ts"
import { installedNames } from "#test/support/worlds/execute/names.ts"
import { actionGen } from "#test/support/worlds/generate/action.ts"
import { docsInstall } from "#test/support/worlds/model/bases/docs.ts"
import { invariantsOf } from "#test/support/worlds/model/invariants.ts"
import { changesWorlds } from "#test/support/worlds/model/session/catalog.ts"
import { folderFiles } from "#test/support/worlds/model/session/migrate.ts"
import { initialState, observedNext, settle, step } from "#test/support/worlds/model/step.ts"
import {
	checkReadBacksAsKeyedSets,
	checkRowsAsKeyedSets,
	depth,
	type FolderFeature,
	migrationGen,
	names,
	phaseOf,
	type StepFeature,
	stepFeatures,
	walkGen
} from "#test/unit/world-model/step.fixtures.ts"

/**
 * The worlds model's step keeps every invariant on every branch and agrees with its own outcomes.
 *
 * Budget: its suite's count before the conversion (unit/world-model/step: 150 independent cases and 0 steered, Vitest
 * at grizzle 4ca3036a).
 */
export const theWorldsModelsStepKeepsEveryInvariantOnEveryBranchAndAgreesWithItsOwnOutcomes =
	property.explore(walkGen, {
		needs: {},
		situations: stepFeatures satisfies ReadonlyArray<Reached<StepFeature>>,
		check:
			(_, c: Case<StepFeature>) =>
			({ reality, weights }) =>
				Effect.sync(() => {
					let state = initialState(docsInstall, names, reality)
					assert.deepEqual(invariantsOf(state), [], "the initial state")
					for (let i = 0; i < depth; i++) {
						const action = c.draw(actionGen(state, weights))
						c.note(`step:${action.kind}`)
						const branches = Arr.map(step(state, action), (s) => settle(s, installedNames))
						for (const b of branches) {
							assert.deepEqual(
								invariantsOf(b.next),
								[],
								`a branch of ${action.kind} observing ${b.observation.kind}`
							)
							const shown = b.observation
							assert.ok(
								observedNext(b, shown) !== undefined,
								`${b.observation.kind} agrees with itself as the real system shows it`
							)
							if (b.observation.kind === "rows" && shown.kind === "rows") {
								c.note("rows compared as keyed sets")
								checkRowsAsKeyedSets(b, shown)
							}
							if (shown.kind === "applied" && checkReadBacksAsKeyedSets(b, shown)) {
								c.note("read-backs compared as keyed sets")
							}
						}
						state = c.draw(element(branches)).next
					}
				}),
		oracle: {
			kind: "specification",
			name: "invariantsOf on every branch, and each outcome read back by observedNext as the real system shows it"
		},
		budget: { runs: 150, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/text/src/regex/subset.ts",
				original: `subset.kind === "done"\n\t\t? "done"\n\t\t: \`\${subset.initial ? "i" : "n"}\${[...subset.configs].toSorted((a, b) => a - b).join(",")}\``,
				replacement: `subset.kind === "done" ? \`\${subset.initial ? "i" : "n"}\${[...subset.configs].toSorted((a, b) => a - b).join(",")}\` : "done"`,
				why: "Census mutant 8d79a8a065 (packages/text/src/regex/subset.ts subsetKey), restated on the counting automaton's configurations: every subset but the sink is keyed as the sink, and the sink by its configurations; the property fails (the census, lane TESTPOLICY2; restated by lane TEXTSPEC)."
			}
		]
	})

/**
 * The worlds model's migration folders drafts a folder's files in the order and number grizzle's generate drafts them.
 *
 * Budget: its suite's count before the conversion (unit/world-model/folder files: 30 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const theWorldsModelsMigrationFoldersDraftsAFoldersFilesInTheOrderAndNumberGrizzlesGenerateDraftsThem =
	property.explore(migrationGen, {
		needs: {},
		situations: ["worlds change", "no worlds change", "a new law"] satisfies ReadonlyArray<
			Reached<FolderFeature>
		>,
		check:
			(_, c: Case<FolderFeature>) =>
			({ from, to }) =>
				Effect.gen(function* () {
					const drafted = yield* Effect.orDie(draftedPhases(from, to, "worlds_files"))
					assert.deepEqual(
						drafted,
						Arr.map(folderFiles(from, to), phaseOf),
						"the folder's files, by phase"
					)
					c.note(changesWorlds(from, to) ? "worlds change" : "no worlds change")
					if (to.base.laws.length > from.base.laws.length) {
						c.note("a new law")
					}
				}),
		oracle: {
			kind: "second-implementation",
			name: "the phases of the folder grizzle's generate drafts"
		},
		budget: { runs: 30, steered: 0 },
		kept: [
			{
				token: ReplayToken(
					"test/unit/world-model/step.test.ts#theWorldsModelsMigrationFoldersDraftsAFoldersFilesInTheOrderAndNumberGrizzlesGenerateDraftsThem:-:0.1.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.1.0.1.0.0.0.0.2.0.0.0.0.1.9"
				),
				reason:
					"a check added on Doc under beta, which reads Doc whole: Structure adds the check NOT VALID and keeps beta's view over Doc's unchanged columns, Validate validates the check, and no Publish file follows",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/unit/world-model/step.test.ts#theWorldsModelsMigrationFoldersDraftsAFoldersFilesInTheOrderAndNumberGrizzlesGenerateDraftsThem:-:4.0.1.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.1.0.0.0.0.0.1.1"
				),
				reason:
					"a key added on Doc beneath alpha's view of the derived OrgDocs: the derived relation's keys, its materialized view's unique indexes, change no world object, so the folder drafts no Structure: Indexes declares the statistics the new key changes, the index is built concurrently, and Publish writes its comment",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/unit/world-model/step.test.ts#theWorldsModelsMigrationFoldersDraftsAFoldersFilesInTheOrderAndNumberGrizzlesGenerateDraftsThem:-:0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0"
				),
				reason:
					"a key added on Org under alpha's whole view of Org (VALIDCOST at 770e3588e, seed 0x73ac3c43, case 15): Org's columns stand, so the view is kept (5bdae3758's sameRead) and the folder builds the index and attaches the key, no Structure",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/unit/world-model/step.test.ts#theWorldsModelsMigrationFoldersDraftsAFoldersFilesInTheOrderAndNumberGrizzlesGenerateDraftsThem:-:o.2.1.1.1.0.1.2.2.0.1.1.0.1.0.0.0.0.0.1.1.0.1.1.1.1.0.1.1.1.0.1.0.0.0.0.0.1.0.3.0.0.1.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.6"
				),
				reason:
					"a key added on Note(doc) under beta's query view over a Note of one literal doc: the compile now proves the arm's rows unique by it, a proof that prints nothing, so the view prints the same statement and is kept",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/unit/world-model/step.test.ts#theWorldsModelsMigrationFoldersDraftsAFoldersFilesInTheOrderAndNumberGrizzlesGenerateDraftsThem:-:6.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.1.0.1.0.0.0.1.0.1.8.0.0.0.0.1.0.0.0.0.1.6"
				),
				reason:
					"a key added on Note(doc) under alpha's query view: the compile drops the view's DISTINCT by it, so the view's statement changes and Structure creates it again, which the model reads off the compiled statement",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/unit/world-model/step.test.ts#theWorldsModelsMigrationFoldersDraftsAFoldersFilesInTheOrderAndNumberGrizzlesGenerateDraftsThem:-:k.1.0.1.0.0.1.0.0.0.0.0.0.0.0.1.0.1.0.0.0.0.0.0.2.0.0.0.1.0.0.0.1.0.0.0.0.1.0.0.0.0.0.4.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0"
				),
				reason:
					"alpha's query view of OrgDocs reads a literal doc where it read any: Structure drops the view, creates it again and grants it right there, and no Publish file follows, alpha's other grants standing",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/unit/world-model/step.test.ts#theWorldsModelsMigrationFoldersDraftsAFoldersFilesInTheOrderAndNumberGrizzlesGenerateDraftsThem:-:1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0"
				),
				reason:
					"alpha reads Org whole where it read a query view of it: Structure drops the query's view and creates Org's, and Publish revokes the new view from PUBLIC, which no previous revoke took",
				since: "2026-11-19"
			}
		],
		kills: [
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original: "\t\t\t\t\tthis.regrantWorld(v)\n",
				replacement: "",
				why: "A world object Structure creates again is granted in Publish rather than right after it, so its role reads nothing of it between the two files and the kept case recreating alpha's view of OrgDocs drafts a Publish file; this property fails."
			},
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original: "\t\t\t\tif (this.worldWithin(v)) {",
				replacement: "\t\t\t\tif (false) {",
				why: "A held role's world object is created again in Publish, where Structure dropped it, so the kept case recreating alpha's view of OrgDocs drafts a Publish file the model says it does not; this property fails."
			},
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original:
					"\tif (samePrinted(was, now)) {\n\t\treturn true\n\t}\n\tconst [before] = was.ddl",
				replacement:
					"\tif (sameRecord(was, now)) {\n\t\treturn true\n\t}\n\tconst [before] = was.ddl",
				why: "A world object whose compile states a proof of its rows that prints nothing reads as changed (diff.ts sameRead by the record): the kept case's view, printing the same statement, is dropped and created again in Structure; this property fails."
			},
			{
				file: "packages/text/src/text.ts",
				original:
					"export const isAsciiDigit = (unit: number): boolean => unit >= 0x30 && unit <= 0x39",
				replacement:
					"export const isAsciiDigit = (unit: number): boolean => unit >= 0x30 && unit <= 58",
				why: "Operator mutant (bound) at packages/engine/src/sql/lexer.ts:103 in isDigit: `0x39` becomes `58`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})
