/**
 * The `<schema>.__migrations` ledger's state as `grizzle migrate` reads it (deploy/ledger/ledger.ts ledgerState),
 * generated: the rows any sequence of applies leaves, in any order the rows statement could return them, and the damage
 * no apply leaves.
 *
 * - **The model:** an apply records each folder in name order, the folder row in the transaction of its first file (or
 *   alone for a folder of no file) and each file's row in that file's own transaction, every row carrying the folder's
 *   source, target and file count. A folder is complete exactly when every one of its files has a row, the latest
 *   target is the last complete folder's (the empty snapshot's before any), and only the last folder may be partial,
 *   since a failed apply stops there. A drafted folder reaches a new snapshot; a custom one keeps its source, and one of
 *   no file completes on its folder row alone.
 * - **Planted damage, refused as MalformedArtifact naming the folder:** a folder's file rows without its folder row; a
 *   partial folder that another folder follows; one row of a folder disagreeing with its folder row on the source, the
 *   target or the file count.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { ledgerState } from "#compiler/deploy/ledger/ledger.ts"
import { artifactRefusal, assert, defined, refused, succeeded } from "#test/support/assert.ts"
import {
	empty,
	type LedgerFeature,
	ledgerGen,
	modelState,
	notesOf,
	plantedRows
} from "#test/unit/deploy/ledger.fixtures.ts"

/** The ledger's state is the model's for every ledger an apply leaves, in any row order, and refuses every damage no apply leaves, naming its folder. */
export const theLedgersStateIsTheModelsForEveryLedgerAnApplyLeavesInAnyRowOrderAndRefusesEveryDamageNoApplyLeavesNamingItsFolder =
	property.explore(ledgerGen, {
		needs: {},
		situations: [
			"an empty ledger",
			"a custom folder of no file",
			"a custom folder of files",
			"a partial folder",
			"a partial folder of its folder row alone",
			"three complete folders",
			"folder row removed",
			"partial before another",
			"a row disagreeing on its source",
			"a row disagreeing on its target",
			"a row disagreeing on its files"
		] satisfies ReadonlyArray<Reached<LedgerFeature>>,
		check: (_, c: Case<LedgerFeature>) => (l) =>
			Effect.sync(() => {
				c.noteAll(notesOf(l))
				const read = ledgerState(plantedRows(l), empty)
				const d = l.damage
				if (d.kind === "none") {
					assert.deepEqual(succeeded(read), modelState(l.folders))
					return
				}
				const refusal = artifactRefusal(refused(read, "MalformedArtifact"))
				assert.deepEqual(
					[refusal.artifact, refusal.at],
					["ledger", [defined(l.folders[d.folder], "the damaged folder").name]],
					"the refusal names the damaged folder"
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "a model of what each apply records, folder by folder, and the damage planted into its rows"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/ledger/ledger.ts",
				original: "\t\tfor (const [name, list] of [...byFolder.entries()].toSorted(byName)) {",
				replacement: "\t\tfor (const [name, list] of [...byFolder.entries()]) {",
				why: "The folders are read in the order the rows arrived, not by name."
			}
		]
	})
