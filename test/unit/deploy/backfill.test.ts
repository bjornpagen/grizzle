/**
 * Adding a family to stored relations (rows-first §6), generated: the drafted migration's backfill data step draws every
 * value the family holds over the stored rows, after every column's ADD COLUMN under its placeholder default and before
 * any constraint reads them, and VALIDATE then proves it.
 *
 * - **The cases:** a counted family, an ordered one keyed by its member key or by its owner and index, a concat fold
 *   over an ordered family, and a family whose members the migration creates; over one to three owners and the members
 *   drawn for them, keyed apart, stored in a drawn order, their steps across negatives, zero and positives, so the
 *   backfill meets empty families, families of one and longer predecessor chains; pieces of text beyond ASCII and empty
 *   ones. A tree is keyed by its drawn start, so its stored rows are a tree already: the folds and copies a migration
 *   adds to one are test/pg/migrate/backfill.test.ts's, over rows PostgreSQL holds.
 * - **Counted and ordered:** each member's hidden index, ‹i› = row_number() OVER (PARTITION BY g ORDER BY its key) − 1,
 *   its copy of the count, and a sum fold's before and after as running sums in ‹i› order; the owner's count and end;
 *   each copy an axis carries its target's value: an owner's, a predecessor's (the base at the first slot), a last
 *   member's (the base for an empty family).
 * - **Concat:** each member's running text over its family in slot order, its before its predecessor's after, the empty
 *   text at slot 0, the owner's end its last member's after.
 * - **Reversals:** removing a family drops its law columns and natives, and its fields as declared, keeping every row; a
 *   field its caller wrote that the target draws is drawn anew over the caller's values; one the target leaves to its
 *   caller keeps its drawn values.
 * - **Reshaped:** a family drawn over stored rows that a later migration renames, declared: its owner relation, its count
 *   or both, which name its law columns (counted; ordered over hidden accumulators; ordered over named ones); or whose
 *   kind it changes, counted to ordered over a new drawn index, or ordered to counted, its index left to its caller
 *   with the values drawn; or whose fold over named accumulators it moves into a new owner field, the old end dropped or
 *   left to its caller. Every value the family holds after it is the reference's over the stored rows in key order, as
 *   it was drawn.
 * - **A stored key's fate:** an ordered family keyed by its order and a new drawn index, added by a migration that
 *   declares the key the lines were stored by, which the backfill orders and joins them by, renamed to a fresh name,
 *   swapped with another field, renamed along a chain or dropped, its column standing until the migration's removals:
 *   every fate migrates and draws every value the reference states over the stored lines in that key's order.
 *
 * - **The keyed tree:** pantry's Node drafted from the old-form tree's frozen snapshot (test/support/migrate/keyed-tree.ts),
 *   whose derivations meet Node's rows at its new primary key: the backfill owes that key's check, and runs it ahead of
 *   every UPDATE (test/support/migrate/probes.ts owedKeyChecks, missingKeyChecks). Its rows are
 *   test/pg/migrate/cutover.test.ts's to judge, and its cost test/pg/migrate/backfill-cost.test.ts's.
 * - **Every draft's backfill** reads no row once per row, recurs nowhere, and writes each table by one UPDATE
 *   (test/support/migrate/probes.ts perRowReads, recursions, rewrittenTables).
 *
 * - **The judge:** the catalog model of PostgreSQL (test/support/migrate/interpret.ts) runs the drafted migration
 *   statement by statement over the stored rows, and its catalog afterwards must be the target's installed from
 *   nothing; NP's reference fold (test/support/families/fold.ts) of each owner's members in key order and a naive left
 *   fold of each owner's pieces state every drawn value.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	type BackfillFeature,
	backfillGen,
	endMoves,
	judgeBackfill,
	judgeReversal,
	kindChanges,
	notesOf,
	renamedFamilies,
	renamings,
	type Reversal,
	reversalGen,
	storedKeyFates
} from "#test/unit/deploy/backfill.fixtures.ts"

/** Backfilling a family added to stored rows, generated draws every value its references state over any stored rows in any storage order, ends at the catalog its target installs from nothing, and adds its constraints after the backfill. */
export const backfillingAFamilyAddedToStoredRowsGeneratedDrawsEveryValueItsReferencesStateOverAnyStoredRowsInAnyStorageOrderEndsAtTheCatalogItsTargetInstallsFromNothingAndAddsItsConstraintsAfterTheBackfill =
	property.explore(backfillGen, {
		needs: {},
		situations: [
			"counted",
			"ordered by line",
			"ordered by order and index",
			"concat",
			"new members",
			"an owner with no member",
			"an owner of three members",
			"members stored out of key order",
			"a negative step",
			"a piece beyond ASCII",
			"an empty piece",
			...Arr.map(renamedFamilies, (f) => `renamed: ${f}` as const),
			...Arr.map(renamings, (r) => `renamed: ${r}` as const),
			...kindChanges,
			...Arr.map(endMoves, (m) => `end moved: ${m}` as const),
			...Arr.map(storedKeyFates, (f) => `stored key ${f}` as const),
			"a keyed tree owing a key check"
		] satisfies ReadonlyArray<Reached<BackfillFeature>>,
		check: (_, c: Case<BackfillFeature>) => (b) =>
			Effect.sync(() => {
				c.noteAll(notesOf(b))
				judgeBackfill(b)
			}),
		oracle: {
			kind: "second-implementation",
			name: "NP's reference fold and a naive left fold over the stored rows in key order, run against the catalog model of PostgreSQL executing the drafted migration"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/diff/backfill.ts",
				original:
					'\t\tover("row_number", [], window(partition, key.map(tableCol), false)),\n\t\tlit.int(1n, types.bigint)',
				replacement:
					'\t\tover("row_number", [], window(partition, key.map(tableCol), false)),\n\t\tlit.int(0n, types.bigint)',
				why: "A counted family's indices are drawn from one, not zero (row_number() unshifted); the generated backfill's drawn values disagree with the references."
			},
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original: "\t\t})\n\t\tfor (const c of checks) {",
				replacement: "\t\t})\n\t\tfor (const c of checks.slice(checks.length)) {",
				why: "The backfill pushes none of the key checks its derivations owe; the keyed tree's check that the backfill checks every key it relies on fails."
			},
			{
				file: "packages/engine/src/deploy/diff/backfill.ts",
				original: "\t\tconst key = nameKey(n.derivation.table)",
				replacement: `\t\tconst key = \`\${nameKey(n.derivation.table)}\\u0000\${n.name}\``,
				why: "The backfill writes a table once per derivation, not by one UPDATE; the check that the backfill writes each table's rows by one UPDATE fails."
			}
		]
	})

/** Backfilling a family added to stored rows, generated removing a family keeps every row and drops its columns, leaving its fields to the caller keeps their values, and drawing over a caller's values draws them anew. */
export const backfillingAFamilyAddedToStoredRowsGeneratedRemovingAFamilyKeepsEveryRowAndDropsItsColumnsLeavingItsFieldsToTheCallerKeepsTheirValuesAndDrawingOverACallersValuesDrawsThemAnew =
	property.explore(reversalGen, {
		needs: {},
		situations: [
			"a counted family removed",
			"left to its caller",
			"drawn anew over the caller's values"
		] satisfies ReadonlyArray<Reached<Reversal["kind"]>>,
		check: (_, c: Case<Reversal["kind"]>) => (r) =>
			Effect.sync(() => {
				c.note(r.kind)
				judgeReversal(r)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the catalog model of PostgreSQL running each migration, against the first schema's fresh catalog and the stored rows"
		},
		kept: [],
		kills: []
	})
