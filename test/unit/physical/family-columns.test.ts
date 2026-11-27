/**
 * The columns and references a family installs (physical/ddl/tables.ts), against the law model's natives, a second
 * representation of what the installation must hold.
 *
 * Each case draws a family schema (test/support/families/fill.ts: relations with a generated field or none, ordered and
 * counted families and trees between them, folds and copies on their axes), one the fill reference admits, beside a
 * roster and a relation Item with a closed id over it; and a login holding a role that writes a drawn set of the
 * relations whole, a role that writes each relation of another drawn set through a query entry of all its fields, so
 * its writes are column grants, or a role that reads Item through a query entry, so its view decodes the closed id,
 * at least one of them.
 *
 * - a role declared with a query entry over a tree's relation is refused, `writeUnwritable` at its first such entry with
 *   `keyHoldsFamily` naming `start`, first by name whichever of the role's lists names it (ir/desc.ts writtenNames): a tree's relation is keyed by its root fields and its drawn start (fill.ts
 *   keyOfRelation), which no fact through an entry states (README "Writing through a role"); a role whose entries
 *   write no tree's relation is declared, and the installation's clerk writes exactly the drawn relations of no tree;
 * - every installed statement keeps the emission discipline (oracle/verify checkedStatements), a decoding query entry's
 *   view included;
 * - every law column, drawn or generated, is its own object of one `ALTER TABLE ... ADD COLUMN` after its table, a drawn
 *   one a plain column with no generation, so NOT NULL like every column, and every role that writes its table through
 *   column grants holds INSERT on it (D13, D14); a generated field is GENERATED ALWAYS AS (e) STORED and holds no
 *   INSERT grant; a table holds INSERT column grants exactly where a query entry writes its relation;
 * - every foreign key is installed ON UPDATE CASCADE exactly where its native cascades (a family's owner axis), and
 *   DEFERRABLE INITIALLY DEFERRED exactly where its native defers; a PERIOD foreign key takes its native's deferral and
 *   never an action.
 *
 * A family's first migration drafting, and a family added to relations that stand, are the families' suites'
 * (test/pg/fin, which installs each drawn family through its first migration) and the backfill's
 * (test/unit/deploy/backfill.test.ts, which drafts and runs every drawn family added to stored rows).
 *
 * Oracles: the law model's natives, a second representation of what the installation must hold, and the emission
 * audit (oracle/verify). Every drawn specification is one the fill reference admits, by construction
 * (test/support/families/fill.ts admittedFillSpecGen).
 *
 * Features: a drawn law column, alone and written by a query entry; a generated field, alone and written by a query
 * entry; a cascading and a deferred foreign key; a decoding view; a relation written whole; a tree's relation written
 * through a query entry refused when declared.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property as propertyOf, ReplayToken } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	familyCaseGen,
	type FamilyFeature,
	property,
	resolve
} from "#test/unit/physical/family-columns.fixtures.ts"

/** A family's columns and references keep the emission discipline, and drawn law columns, generated fields and foreign key actions follow their natives, whatever roles write them. Its budget is its suite's before it was a property (test/unit/physical/family-columns.test.ts at 4ca3036a): 60 runs and 200 steered cases. */
export const aFamilysColumnsAndReferencesKeepTheEmissionDisciplineAndDrawnLawColumnsGeneratedFieldsAndForeignKeyActionsFollowTheirNativesWhateverRolesWriteThem =
	propertyOf.explore(familyCaseGen, {
		needs: {},
		budget: { runs: 60, steered: 200 },
		situations: [
			"a drawn law column",
			"a drawn law column a query entry writes",
			"a generated field",
			"a generated field a query entry writes",
			"a cascading foreign key",
			"a deferred foreign key",
			"a decoding view",
			"a relation written whole",
			"a tree's relation written through a query entry refused when declared"
		] satisfies ReadonlyArray<Reached<FamilyFeature>>,
		check: (_, c: Case<FamilyFeature>) => (sketch) =>
			Effect.gen(function* () {
				const value = resolve(sketch)
				return yield* property(value, c)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the law model's natives, and the emission audit"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/physical/family-columns.test.ts#aFamilysColumnsAndReferencesKeepTheEmissionDisciplineAndDrawnLawColumnsGeneratedFieldsAndForeignKeyActionsFollowTheirNativesWhateverRolesWriteThem:-:8.0.1.0.0.0.0.0.0.0.0.0.2.1.0.0.2.0.1.2.0.0.0.0.2.2.0.0"
				),
				reason:
					"two trees' relations a clerk writes through query entries, R0 open in its write list and R1 closed in its insert list, each refused by the drawn start its key holds: the refusal names R0Entry, the least by name, where a check of the insert list first named R1Entry (main 38a1b476)",
				since: "2026-11-26"
			}
		],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/tables.ts",
				original: '\tcascade: "CASCADE",',
				replacement: "\tcascade: undefined,",
				why: "No foreign key cascades on update."
			},
			{
				file: "packages/engine/src/schema/entry.ts",
				original: "\tif (drawnKey !== undefined) {",
				replacement: '\tif (drawnKey !== undefined && drawnKey !== "start") {',
				why: "A query entry whose key holds a tree's drawn start is admitted."
			},
			{
				file: "packages/engine/src/ir/desc.ts",
				original: "\t\t.toSorted((a, b) => compareCodePoints(a.name, b.name))",
				replacement: "\t\t.toSorted(() => 0)",
				why: "A role's writes checked list by list, its insert list before its write list: a clerk whose open tree's relation R0 and closed tree's relation R1 are both refused is refused at R1Entry, the entry its list puts first, not the least by name."
			}
		]
	})
