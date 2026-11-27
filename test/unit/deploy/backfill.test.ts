/**
 * Adding a family to stored relations (rows-first §6), generated: the drafted migration's backfill data step draws every
 * value the family holds over the stored rows, after every column's ADD COLUMN under its placeholder default and before
 * any constraint reads them, and VALIDATE then proves it.
 *
 * - **The cases:** a counted family, an ordered one keyed by its member key or by its owner and index, one whose fold
 *   steps by each member's copy of the step of the member before it, a concat fold over an ordered family, and a family
 *   whose members the migration creates; over one to three owners and the members
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
 * - **The keyed tree:** pantry's Node drafted from a tree rooted at its document, its root replaced
 *   (test/support/migrate/keyed-tree.ts), whose derivations meet Node's rows at its new primary key: the backfill owes that key's check, and runs it ahead of
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
	foldFamilies,
	judgeBackfill,
	judgeReversal,
	kindChanges,
	notesOf,
	renamedFamilies,
	renamings,
	type Reversal,
	reversalGen,
	placedGen,
	type ClockedFeature,
	clockedGen,
	clockedNotes,
	judgeClocked,
	type JoinedFeature,
	joinedGen,
	joinedNotes,
	judgeJoined,
	storedKeyFates
} from "#test/unit/deploy/backfill.fixtures.ts"

/** Backfilling a family added to stored rows, generated draws every value its references state over any stored rows in any storage order, ends at the catalog its target installs from nothing, and adds its constraints after the backfill. Its budget is its suite's before it was a property (test/unit/deploy/backfill.test.ts at 4ca3036a): 200 runs and 300 steered cases. */
export const backfillingAFamilyAddedToStoredRowsGeneratedDrawsEveryValueItsReferencesStateOverAnyStoredRowsInAnyStorageOrderEndsAtTheCatalogItsTargetInstallsFromNothingAndAddsItsConstraintsAfterTheBackfill =
	property.explore(backfillGen, {
		needs: {},
		budget: { runs: 200, steered: 300 },
		situations: [
			...foldFamilies,
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
				original: '\t\t\t\t\t\tlit.int(1n, types.bigint)\n\t\t\t\t\t)\n\t\t\t\t: col("m", index),',
				replacement:
					'\t\t\t\t\t\tlit.int(0n, types.bigint)\n\t\t\t\t\t)\n\t\t\t\t: col("m", index),',
				why: "A counted family's indices are drawn from one, not zero (row_number() unshifted); the generated backfill's drawn values disagree with the references."
			},
			{
				file: "packages/engine/src/deploy/diff/backfill.ts",
				original: "\t\t...[...copies].filter((c) => added.has(c))\n",
				replacement: "\t\t...[...copies].filter(() => false)\n",
				why: "No family's scan draws a predecessor copy, and no stream does either: an ordered line's copy of the quantity before it keeps its placeholder, which the references state only at the first slot."
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
			},
			{
				file: "packages/engine/src/deploy/snapshot/build.ts",
				original: "\t\tactions.filter((a) => addedColumn(a) !== undefined).length",
				replacement:
					'\t\tactions.filter((a) => addedColumn(a) !== undefined && a.kind !== "addColumnDefault").length',
				why: "A drawn column added under its placeholder default spends no attribute number, as snapshot/build.ts addedColumns counted before it read plan.ts addedColumn; the recorded attribute numbers fall short of the ADD COLUMNs the SQL spells."
			}
		]
	})

/** Backfilling a family added to stored rows, generated removing a family keeps every row and drops its columns, leaving its fields to the caller keeps their values, and drawing over a caller's values draws them anew. Its budget is its suite's before it was a property (test/unit/deploy/backfill.test.ts at 4ca3036a): 100 runs and 100 steered cases. */
export const backfillingAFamilyAddedToStoredRowsGeneratedRemovingAFamilyKeepsEveryRowAndDropsItsColumnsLeavingItsFieldsToTheCallerKeepsTheirValuesAndDrawingOverACallersValuesDrawsThemAnew =
	property.explore(reversalGen, {
		needs: {},
		budget: { runs: 100, steered: 100 },
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
		kills: [
			{
				file: "packages/text/src/regex/ir.ts",
				original: 'if (typeof piece !== "string") {\n\t\t\treturn piece\n\t\t}',
				replacement: "{}",
				why: 'Operator mutant b363c73c35 at packages/text/src/regex/ir.ts:403 in settle: `if (typeof piece !== "string") {    return piece   }` becomes `{}`; the property fails (the census, lane TESTPOLICY2).'
			}
		]
	})

/** A place a migration adds to stored rows numbers each group by its `by` from 0, and each column a containment carries from it into stored rows takes the value of the row the previous containment named, with no placeholder, ending at the catalog its target installs from nothing. */
export const aPlaceAMigrationAddsToStoredRowsNumbersEachGroupByItsByFromZeroAndEachColumnAContainmentCarriesFromItTakesTheValueOfTheRowThePreviousContainmentNamed =
	property.explore(placedGen, {
		needs: {},
		budget: { runs: 100, steered: 100 },
		situations: [
			"a place over stored rows",
			"a place over a level",
			"a place carried into attempts and their values",
			"a group of three places",
			"places stored out of their order"
		] satisfies ReadonlyArray<Reached<BackfillFeature>>,
		check: (_, c: Case<BackfillFeature>) => (b) =>
			Effect.sync(() => {
				c.noteAll(notesOf(b))
				judgeBackfill(b)
			}),
		oracle: {
			kind: "specification",
			name: "each session's place the count of its group's sessions at an earlier stage, each attempt's and value's its session's, run against the catalog model of PostgreSQL executing the drafted migration"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/diff/backfill.ts",
				original:
					"\t\tput(place.relation, place.field.column, drawnOf(installation, zero, place.field.type))\n",
				replacement: "\t\tvoid place\n",
				why: "A place added to stored rows is no column the backfill draws, so its migration adds it at the reviewer's placeholder, the hand data step the place case's migration must not ask."
			},
			{
				file: "packages/engine/src/deploy/diff/backfill.ts",
				original: '\t\t\t\t\t\t\t\t[col("k", by.column)],\n',
				replacement: "\t\t\t\t\t\t\t\t[],\n",
				why: "A place's stored rows are numbered in no order, so a group stored out of its stages' order holds places that are not its stages' ranks."
			},
			{
				file: "packages/engine/src/deploy/diff/backfill.ts",
				original:
					"\t\t\t\t\t\t),\n\t\t\t\t\t\tlit.int(1n, types.bigint)\n\t\t\t\t\t),\n\t\t\t\t\tvalue\n",
				replacement:
					"\t\t\t\t\t\t),\n\t\t\t\t\t\tlit.int(0n, types.bigint)\n\t\t\t\t\t),\n\t\t\t\t\tvalue\n",
				why: "A place's stored rows are numbered from 1, so each group's first session is not at place 0."
			},
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original: "\t\tconst carry = this.carryOf(t, c)\n",
				replacement: "\t\tconst carry = undefined\n",
				why: "A column a containment carries into stored rows is the reviewer's, so the attempts' and the values' places are asked at a placeholder, the hand data step the migration must not ask."
			},
			{
				file: "packages/engine/src/deploy/diff/backfill.ts",
				original: '\t\t\ttargetKey: mapNonEmpty(carry.targetKey, (c) => col("t", c)),\n',
				replacement:
					'\t\t\ttargetKey: mapNonEmpty(carry.targetKey, () => col("t", carry.targetKey[0])),\n',
				why: "A carried column's rows are met at their first key column alone in every place, so an attempt meets no session or the wrong one, and holds NULL or another session's place."
			},
			{
				file: "packages/engine/src/deploy/diff/backfill.ts",
				original: "\treturn objectName(table.schema, table.name)\n",
				replacement: "\treturn objectName(installation.names.schema, table.name)\n",
				why: "A level's tables are named in the root's schema, so the backfill of a place over a level writes tables the level does not hold and its UPDATEs' generations are no stored relation's: the draft dies, as qti-database's ledger did."
			},
			{
				file: "packages/engine/src/deploy/diff/backfill.ts",
				original: "\t\t\tif (by === undefined || ran.has(nameKey(by.derivation.table))) {\n",
				replacement: "\t\t\tif (by === undefined) {\n",
				why: "A later UPDATE draws again every column an earlier one wrote that it reads, so the values' UPDATE derives the sessions' places and the attempts' carried n a second time, as follow-up 5's ledger draft does once per attempt sidecar."
			}
		]
	})

/** A clock a migration adds to stored rows of a unit whose head already counts on another clock of it leaves the unit's head at each key at the greatest instant the unit holds there, its new clock's rows' and its other clocks' alike. */
export const aClockThatJoinsAUnitsScopeOverStoredRowsLeavesTheUnitsHeadAtTheGreatestInstantTheUnitHoldsAtEachKey =
	property.explore(joinedGen, {
		needs: {},
		budget: { runs: 50, steered: 50 },
		situations: [
			"a clock joining its unit's head over stored rows",
			"a visit past the migration's instant",
			"a user of visits alone",
			"over no row"
		] satisfies ReadonlyArray<Reached<JoinedFeature>>,
		check: (_, c: Case<JoinedFeature>) => (joined) =>
			Effect.sync(() => {
				c.noteAll(joinedNotes(joined))
				judgeJoined(joined)
			}),
		oracle: {
			kind: "specification",
			name: "the unit's head at each user at the greatest instant of its visits and its sign-ins, each sign-in at the model's instant, and the target's fresh catalog, run against the catalog model of PostgreSQL executing the drafted migration"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original:
					"\t\t\t\t} else if (!sameRecord(before, o) || this.headJoined(before, o, v.create.table)) {\n",
				replacement: "\t\t\t\t} else if (!sameRecord(before, o)) {\n",
				why: "A unit's head a migration keeps stands where its stamps left it when a clock joins it over stored rows: the sign-ins' instants, the migration's, stand above it, so a later stamp of the unit could fall below them."
			}
		]
	})

/** A clock or an unordered place a migration adds to stored rows gives every one the migration's one value of it, the migration's instant or 0, where the new key holds the old one, with no placeholder, and is refused, naming both keys, where it does not. */
export const aClockOrAnUnorderedPlaceAMigrationAddsToStoredRowsGivesEveryOneItsOneValueWhereTheNewKeyHoldsTheOldOneAndIsRefusedWhereItDoesNot =
	property.explore(clockedGen, {
		needs: {},
		budget: { runs: 50, steered: 50 },
		situations: [
			"a clock added over stored rows",
			"a place added over stored rows",
			"over no row",
			"refused: the old key not held under a clock",
			"refused: the old key not held under a place"
		] satisfies ReadonlyArray<Reached<ClockedFeature>>,
		check: (_, c: Case<ClockedFeature>) => (clocked) =>
			Effect.sync(() => {
				c.noteAll(clockedNotes(clocked))
				judgeClocked(clocked)
			}),
		oracle: {
			kind: "specification",
			name: "every stored sign-in at the model's instant or at place 0 and the target's fresh catalog, or the refusal naming the head and both keys, run against the catalog model of PostgreSQL executing the drafted migration"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original: "\t\tconst stamped = this.stampedColumn(t, c)\n",
				replacement: "\t\tconst stamped = undefined\n",
				why: "A clock or an unordered place added to stored rows is the reviewer's, so its migration asks for it at a placeholder, the hand data step it must not ask."
			},
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original: "\t\tif (!held.every((column) => column !== c.name && key.includes(column))) {\n",
				replacement: "\t\tif (false) {\n",
				why: "A clock or an unordered place is added under a key that does not hold the old one, so the stored rows of one user would share the key at the migration's one value: the refused cases draft."
			}
		]
	})
