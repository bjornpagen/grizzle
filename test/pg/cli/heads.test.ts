/**
 * A schema whose relations hold heads, a clock's and a place's (physical/ddl/stamps.ts), through the command line on
 * PostgreSQL 19: each version is generated, migrated, checked for drift and migrated again, and every command passes.
 * Each head is two objects of the manifest, its table and its stamp function, one catalog object each, so the drift
 * check owns every fact of both: where the stamp function was the head table's object's, a fresh installation drifted at
 * once by an "unexpected function" and its next migrate refused (metis's PIN 2 at grizzle dfc9f60ed). The history is
 * the first version alone, or the first then a version that regroups the place, its head's table and stamp function
 * made again over rows Slot may hold, and swaps in Event's key over other columns, an index built under a temporary
 * name and renamed into place.
 *
 * Every folder is drafted under the two rules of physical/obligations/created.ts: an object of the manifest creates
 * only itself and what lies within it, and a folder leaves standing only what the target's manifest holds.
 *
 * Oracle: the command line's exit codes, every one 0, the drift check's comparison of PostgreSQL's catalog with the
 * snapshot among them.
 *
 * Features: a fresh installation's heads, a head made again, a key swapped in.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { assertPassed, historyGen, runHistory } from "#test/pg/cli/heads.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

type HeadsFeature = "a fresh installation's heads" | "a head made again" | "a key swapped in"

/** A schema holding heads generates, migrates, passes the drift check and migrates again at every version of its history. */
export const aSchemaHoldingHeadsGeneratesMigratesPassesDriftAndMigratesAgainAtEveryVersion =
	property.exhaust(finite(historyGen), {
		needs: { caseSubstrate: Substrate.fresh(baseSubstrate) },
		box: "the first version alone, or the first then the regrouped one",
		situations: [
			"a fresh installation's heads",
			"a head made again",
			"a key swapped in"
		] satisfies ReadonlyArray<Reached<HeadsFeature>>,
		check:
			({ caseSubstrate }, c: Case<HeadsFeature>) =>
			(history) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const runs = yield* runHistory(history)
						c.note("a fresh installation's heads")
						if (history.includes("regrouped")) {
							c.note("a head made again")
							c.note("a key swapped in")
						}
						assertPassed(runs)
					}),
					Substrate,
					Effect.map(caseSubstrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "postgresql",
			name: "the command line's exit codes over PostgreSQL's catalog, the drift check's comparison with the snapshot among them"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/stamps.ts",
				original: "\t\t\t\tddl: [headTable(b, head, tableName, key), revokeTable],\n",
				replacement:
					"\t\t\t\tddl: [headTable(b, head, tableName, key), revokeTable, fn, revokeFunction],\n",
				why: "A head's object creates its stamp function too, a catalog object it is not: the installation's compile refuses it (physical/obligations/created.ts assertCreatesOwned), where a fresh installation of it drifted at once."
			},
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original:
					'\t\t\t\t\tconstraint: c.kind === "primaryKey" ? "PRIMARY KEY" : "UNIQUE",\n\t\t\t\t\tindex\n',
				replacement:
					'\t\t\t\t\tconstraint: c.kind === "primaryKey" ? "PRIMARY KEY" : "UNIQUE",\n\t\t\t\t\tindex: c.name\n',
				why: "A moved key is attached by its own name, not by the index built for it under its temporary name: the folder leaves that index standing, no object of the target's manifest, which generate refuses (physical/obligations/created.ts assertFolderCreatesHeld)."
			},
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original: "\t\tconst dropped = this.headsDropped.has(before.ident)\n",
				replacement: "\t\tconst dropped = false\n",
				why: "A head made again is taken to have left its stamp function standing: the head's change drops the function before its table, and the function's own visit drops it again, which no longer stands, so the migration fails."
			}
		]
	})
