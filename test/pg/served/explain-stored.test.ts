/**
 * A read of a stored derived relation explains: the served file names every index PostgreSQL holds on each table it
 * names, the stored relation's own among them, and the read's EXPLAIN and EXPLAIN ANALYZE each decode into a plan that
 * reads the relation's own table, named by the relation, the analyzed plan's root returning the rows the read answers.
 * An index of a stored relation's table the served file did not name refused each explain at its decode, as "statement
 * 0 answered rows grizzle cannot read": the snapshot gathered no index of a stored table's object, which adds its
 * primary key itself (deploy/snapshot/build.ts snapshotTablesOf).
 *
 * Box: a read of Kept, stored in a table of its own, at a document of no, one or two places.
 *
 * Oracle: PostgreSQL's catalog, the indexes it holds on each table the served file names, and the places the case
 * loads at the document the read binds, which the analyzed root returns.
 */

import { assert } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Record as Rec, Result } from "effect"
import { memberExplains } from "#adapter/db/handles.ts"
import type { Plan } from "#adapter/types/db.ts"
import {
	catalogIndexes,
	doc,
	factsOf,
	keptTemplate,
	places,
	programsOf,
	worldOf
} from "#test/pg/served/explain-stored.fixtures.ts"
import { loadMigrated } from "#test/support/install-migrate.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A plan node as far as what it reads: what it reads and its children. */
interface Reads {
	readonly on: Plan["on"]
	readonly children: ReadonlyArray<Reads>
}

/** The relations a plan's nodes read, its own and its children's. */
const readsOf = (plan: Reads): ReadonlyArray<string> => [
	...(plan.on.kind === "relation" || plan.on.kind === "index" ? [plan.on.relation] : []),
	...Arr.flatMap(plan.children, readsOf)
]

/** A read of a stored derived relation's EXPLAIN and EXPLAIN ANALYZE decode into plans over its table. */
export const aReadOfAStoredDerivedRelationExplainsOverItsTable = property.exhaust(
	finite((source) => source.draw(places)),
	{
		needs: Substrate.oneOf({ kept: keptTemplate }, Substrate.fresh),
		situations: [],
		check: (templates) => (n) =>
			Effect.scoped(
				Effect.gen(function* () {
					const taken = yield* templates.kept
					yield* Effect.provideService(
						Effect.gen(function* () {
							const substrate = yield* Substrate
							const installed = taken.value.installed
							yield* loadMigrated(installed, factsOf(n))
							const world = worldOf(installed.declared)
							yield* withServedDb(
								installed,
								world.server.roles.app,
								{},
								({ ctx: db, loadWithTables }) =>
									Effect.gen(function* () {
										const loaded = yield* loadWithTables(programsOf(installed.declared))
										const named = Arr.flatMap(Rec.toEntries(loaded.tables), ([schema, tables]) =>
											Arr.map(Rec.toEntries(tables), ([table, served]) => ({
												schema,
												table,
												served
											}))
										)
										assert.ok(
											Arr.some(named, (t) => t.served.relation === "Kept"),
											"the served file names Kept's table"
										)
										for (const { schema, table, served } of named) {
											const held = yield* catalogIndexes(substrate.admin, schema, table)
											assert.deepEqual(
												served.indexes,
												held,
												`the served file names every index PostgreSQL holds on ${served.relation}'s table`
											)
										}
										const explains = memberExplains(
											db,
											loaded.tables,
											member(loaded.members, "kept")
										)
										if (explains.kind !== "read") {
											return assert.fail("a read explains as a read")
										}
										const input = { params: { doc }, facts: {} }
										const planned = yield* Effect.result(explains.explain(input))
										if (Result.isFailure(planned)) {
											return assert.fail(
												`its EXPLAIN decodes: ${Formatter.format(planned.failure)}`
											)
										}
										const ran = yield* Effect.result(explains.explainAnalyze(input))
										if (Result.isFailure(ran)) {
											return assert.fail(
												`its EXPLAIN ANALYZE decodes: ${Formatter.format(ran.failure)}`
											)
										}
										for (const s of planned.success) {
											assert.ok(
												readsOf(s.plan).includes("Kept"),
												`its plan reads Kept's table: ${Formatter.format(s.plan)}`
											)
										}
										for (const s of ran.success) {
											assert.ok(
												readsOf(s.plan).includes("Kept"),
												`its analyzed plan reads Kept's table: ${Formatter.format(s.plan)}`
											)
											assert.equal(
												s.plan.actual.rows,
												n,
												"its analyzed root returned the places the document holds"
											)
										}
									})
							)
						}),
						Substrate,
						taken.substrate
					)
				})
			),
		oracle: {
			kind: "postgresql",
			name: "PostgreSQL's catalog, the indexes it holds on each table the served file names, and the places the case loads"
		},
		box: "a read of a stored derived relation at a document of no, one or two places",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/snapshot/build.ts",
				original:
					'\t\t\tcase "storedTable":\n\t\t\t\tindex(v.create.name, v.primaryKey.name, constraintKeys(v.primaryKey), o.reasons)\n\t\t\t\tbreak\n',
				replacement: '\t\t\tcase "storedTable":\n\t\t\t\tbreak\n',
				why: "A stored table's object adds its primary key itself, and the snapshot gathers no index of it, so the served file names none on Kept's table and each explain of a plan scanning that key refuses at its decode."
			}
		]
	}
)
