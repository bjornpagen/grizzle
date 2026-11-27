/**
 * indexesOf (packages/grizzle/src/adapter/public/compile.ts, deploy/snapshot/served.ts snapshotIndexes): over the JSON
 * value of a snapshot.json generate writes, it names each index the installation holds under the relation whose table
 * holds it and the index's name, with exactly the reasons the snapshot's manifest records for it
 * and its key columns in the order its statement lists them, each mapped through the relation's fields.
 *
 * The box, exhausted: a relation R declared at the root or at a level over it, with or without a candidate key over two
 * of its fields, with no containment out of it, a containment of a field in another relation's key, or one out of R's
 * rows a selection picks, which the law model carries in a law column, and with or without a stored derived relation
 * over R in a level above, R in a unit of its id, whose table is uniquely indexed on the key it proves. The oracle is the manifest
 * itself, read apart from the derived facts: each index object, a created or a derived relation's unique index by its
 * CREATE INDEX's key list, a primary key's and a unique key's by its constraint as its table's CREATE TABLE declares it
 * or its own ALTER TABLE adds it (its identity read by physical/obligations/graph.ts parseIdent, the manifest's one
 * reader of an identity), with the reasons it records, under the relation the snapshot's theory records for that table
 * (an ordinary one at its level's schema, a stored derived one by its table's identifier); each key column a field where the theory records one at that column, the fixture's derived
 * relation's table columns being its fields' own names, and otherwise a law column with the laws its manifest object
 * records; each with a B-tree's direction, or none for a span key's GiST.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case as CaseOf, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { readSnapshot } from "#adapter/boundary/snapshot.ts"
import { indexesOf } from "#adapter/public/compile.ts"
import {
	derivedOf,
	finishSnapshot,
	noWorkload,
	targetState,
	writeSnapshot
} from "#compiler/deploy/snapshot/build.ts"
import { lawChecks } from "#compiler/deploy/snapshot/violation.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { installationsOf, own, rostersOf } from "#compiler/schema/own.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { snapshotJson } from "#test/support/snapshot-json.ts"
import {
	byPlace,
	caseGen,
	type Compared,
	type Feature,
	lawColumnLaws,
	manifestIndexes,
	type Projected,
	relationAt,
	schemaOf
} from "#test/unit/deploy/indexes-of.fixtures.ts"

/** IndexesOf names each index's reasons and key columns, in order and mapped through its relation's fields, as the snapshot's manifest records them. */
export const indexesOfNamesEachIndexsReasonsAndKeyColumnsInOrderAndMappedThroughItsRelationsFieldsAsTheSnapshotsManifestRecordsThem =
	property.exhaust(finite(caseGen), {
		needs: {},
		situations: [
			"a level",
			"a key of two columns",
			"a referencing index",
			"a law column",
			"a derived key"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, k: CaseOf<Feature>) => (c) =>
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
				const content = succeeded(
					targetState({
						installation,
						workload: noWorkload,
						checks: lawChecks(installation)
					})
				)
				const snapshot = succeeded(finishSnapshot(content))
				const files = succeeded(writeSnapshot(snapshot, derivedOf(installation)))
				const read = succeeded(readSnapshot(files)).snapshot
				const laws = lawColumnLaws(content)
				const expected = Arr.sort(
					Arr.map(manifestIndexes(content), (index): Compared => {
						const r = relationAt(read, index.schema, index.table)
						return {
							relation: r.name,
							name: index.name,
							columns: Arr.map(index.keys, (key): Projected => {
								const field = r.fields.get(key.column)
								return field === undefined
									? {
											kind: "law",
											laws: defined(
												laws.get(`${index.schema}.${index.table}.${key.column}`),
												`the law column ${key.column}`
											),
											direction: key.direction
										}
									: { kind: "field", field, direction: key.direction }
							}),
							reasons: index.reasons
						}
					}),
					byPlace
				)
				const indexes = succeeded(indexesOf(snapshotJson(files.snapshot)))
				const actual = Arr.sort(
					Arr.flatMap([...indexes], ([relationName, named]) =>
						Arr.map([...named], ([name, index]): Compared => ({
							relation: relationName,
							name,
							columns: Arr.map(index.columns, (column): Projected => {
								switch (column.kind) {
									case "field":
										return { kind: "field", field: column.field, direction: column.direction }
									case "law":
										return { kind: "law", laws: column.laws, direction: column.direction }
									case "suffix":
										return { kind: column.kind, direction: column.direction }
								}
							}),
							reasons: index.reasons
						}))
					),
					byPlace
				)
				assert.deepEqual(actual, expected, "each index's columns and reasons")
				if (c.placement === "level") {
					k.note("a level")
				}
				if (c.keyed) {
					k.note("a key of two columns")
				}
				if (c.containment === "whole") {
					k.note("a referencing index")
				}
				if (Arr.some(actual, (i) => Arr.some(i.columns, (col) => col.kind === "law"))) {
					k.note("a law column")
				}
				if (c.derived) {
					k.note("a derived key")
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the manifest's index objects, their reasons and their statements' key columns, each under the relation the theory records for its table and mapped through its fields"
		},
		box: "R at the root or a level, with or without a two-column candidate key, no containment, a whole one or a selected one out of it, and with or without a stored derived relation over it",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/snapshot/build.ts",
				original: "\t\ton.indexes.set(name, { columns, reasons })",
				replacement: "\t\ton.indexes.set(name, { columns, reasons: reasons.slice(0, 1) })",
				why: "The derived facts record each index with its first reason alone."
			},
			{
				file: "packages/engine/src/deploy/snapshot/build.ts",
				original: "\t\ton.indexes.set(name, { columns, reasons })",
				replacement: "\t\ton.indexes.set(name, { columns: columns.toReversed(), reasons })",
				why: "An index's key columns are recorded in reverse order."
			}
		]
	})
