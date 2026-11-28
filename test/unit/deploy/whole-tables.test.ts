/**
 * A first migration and the installation's script create each table whole, by one path (physical/ddl/whole.ts
 * wholeTable, which the Differ's `created` tables and the script's wholeTables both state through): one CREATE TABLE,
 * the same statement in both, that states every column of the table and every key, exclusion and CHECK of it, its law
 * columns, drawn and generated, and its own constraints over them among them, where each created the table and then
 * added them by ALTER TABLE, which rewrote the empty table and built again every index it had (P5: a fresh pantry
 * install's 19 such statements took 57 s of its 188 s on a loaded machine). Only a foreign key, added after every
 * table, and what a CREATE TABLE cannot state stay an ALTER TABLE. So a first migration runs the installation's script
 * statement for statement (test/support/install-migrate.ts runsInstallScript).
 *
 * Oracle: the installation's objects, a second representation of each table: its table object's CREATE TABLE and each
 * ALTER TABLE its objects add after it, every law column and own constraint its own object there
 * (physical/ddl/tables.ts addNatives), whose columns and constraints the CREATE TABLE states, exactly.
 *
 * Features: a law column and a key or CHECK in its table's CREATE TABLE; a foreign key added after every table.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	judgedWhole,
	wholeCaseGen,
	type WholeFeature
} from "#test/support/unit/deploy/whole-tables.fixtures.ts"

/** A first migration creates each table of a family schema whole, as the installation's script does, every column and own constraint in its one CREATE TABLE. */
export const aFirstMigrationCreatesEachTableWholeEveryColumnAndOwnConstraintInItsOneCreateTable =
	property.explore(wholeCaseGen, {
		needs: {},
		budget: { runs: 60, steered: 200 },
		situations: [
			"a law column in its table's CREATE TABLE",
			"a key or CHECK in its table's CREATE TABLE",
			"a foreign key added after every table"
		] satisfies ReadonlyArray<Reached<WholeFeature>>,
		check: (_, c: Case<WholeFeature>) => (spec) => Effect.sync(() => judgedWhole(spec, c.note)),
		oracle: {
			kind: "second-implementation",
			name: "the installation's objects of each table: its table object's CREATE TABLE and every ALTER TABLE its objects add after it"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original: '\t\tconst created = slot === "structure" ? this.created.get(key) : undefined\n',
				replacement: "\t\tconst created = undefined\n",
				why: "A new table's law columns and own constraints go to its one ALTER TABLE after it, as the draft did before P5: its CREATE TABLE states none of them, an ALTER TABLE adds them, and the property fails."
			},
			{
				file: "packages/engine/src/physical/ddl/whole.ts",
				original: "\t\t\tconst rest = notInline(s.actions, created.get(nameKey(s.table)))\n",
				replacement: "\t\t\tconst rest = notInline(s.actions, undefined)\n",
				why: "The installation's script creates each table and then adds its law columns and own constraints by an ALTER TABLE each, as it did before the script took the Differ's path: its CREATE TABLE is not the first migration's, and the property fails."
			}
		]
	})
