/**
 * EXECUTE follows what a role's statements evaluate, on PostgreSQL 19 (physical/ddl/roles.ts roleExecutes), over the
 * generated worlds of test/support/executes.ts: rosters, sets, a contract, laws whose CHECKs and generated columns cast
 * into their domains, and roles writing drawn relations.
 *
 * The oracle is the catalog's own record of what an object evaluates, independent of the installer: from every table a
 * role inserts into or updates, its views, its policies and the domains it holds USAGE on, through pg_depend's normal
 * dependencies on functions and types (a CHECK's, a default's or generated column's, an index's, a view's rule, a
 * policy's, a function body's), each table's columns' types and each domain's CHECKs and base type. For every role:
 *
 * - has_function_privilege holds of exactly the constants reached so, with every closed relation's constants, which its
 *   queries' closed reads call;
 * - its first insert into each table it writes, of a row every column domain admits, is refused by no missing
 *   privilege (42501): every function a CHECK or a generated column calls, through a cast into a domain or not, is
 *   granted.
 *
 * The required situation is a constant that only a written table's casts reach: the live-codes constant a set's bits
 * domain's CHECK calls, reached from a source writer's generated column of a containment selected by that set (see
 * test/support/executes.ts).
 *
 * Features: that constant, a role that writes nothing, and an insert that holds.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Record as Rec } from "effect"
import { handlesText } from "#compiler/ir/codes.ts"
import {
	type Feature,
	grantedSql,
	reachedSql,
	refusalAs,
	sorted
} from "#test/pg/physical/executes.fixtures.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import {
	buildExecutesWorld,
	constantsOf,
	type ExecutesWorld,
	executesWorldGen,
	type FieldSketch,
	installedRole,
	reachableConstants
} from "#test/support/executes.ts"
import { installMigrated } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A role's EXECUTE grants on PostgreSQL 19 hold of exactly the constants the catalog says its writes and reads evaluate, and refuse no first insert.
 *
 * Its pre-conversion budget: runs 16, coverage cases 16 (test/pg/physical/executes.test.ts at d8eed1786).
 */
export const aRolesEXECUTEGrantsOnPostgreSQL19HoldOfExactlyTheConstantsTheCatalogSaysItsWritesAndReadsEvaluateAndRefuseNoFirstInsert =
	property.explore(executesWorldGen, {
		needs: { substrate2: Substrate.installing },
		situations: [
			"a constant only a written table's casts reach",
			"a role that writes nothing",
			"an insert that holds"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ substrate2 }, c: Case<Feature>) =>
			(world: ExecutesWorld) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const substrate = yield* Substrate
						const owner = yield* substrate.session({ ...ownerSession(), label: "executes owner" })
						return yield* Effect.scoped(
							Effect.gen(function* () {
								const built = buildExecutesWorld(world, "Grants")
								const m = yield* installMigrated(built.schema, {
									label: "executes",
									logins: [built.login],
									extensions: [],
									ambient: ordinarySession
								})
								const i = m.installation
								const names = namesOf(m)
								const constants = constantsOf(i)
								const closedConstants = Arr.flatMap(Rec.values(i.owned.relations), (r) =>
									r.kind === "closedRelation"
										? Arr.map(i.names.closed(r.name).functions, (f) => f.name)
										: []
								)
								const codecOf = (roster: string) =>
									defined(
										Option.getOrUndefined(
											Arr.findFirst([...i.names.codes.rosters.values()], (x) => x.roster === roster)
										),
										`the codes of ${roster}`
									)
								/** A value every domain of the field admits: a live handle's code, the empty set, one. */
								const valueOf = (f: FieldSketch): string => {
									switch (f.kind) {
										case "code": {
											const roster = defined(built.rosters.get(f.roster), `the roster ${f.roster}`)
											return String(names.code(roster, roster.handles[0]))
										}
										case "set":
											return handlesText(codecOf(f.roster), [])
										case "count":
										case "plain":
											return "1"
										case "ref":
											return "00000000-0000-4000-8000-000000000002"
									}
								}
								for (const r of world.roles) {
									const installed = installedRole(i, r.name)
									const reached = yield* owner.values(reachedSql, [
										installed.role,
										i.names.schema,
										installed.schema
									])
									const granted = yield* owner.values(grantedSql, [installed.role, i.names.schema])
									const expected = new Set([
										...Arr.filter(
											Arr.map(reached, (row) => String(row[0])),
											(name) => constants.has(name)
										),
										...closedConstants
									])
									assert.deepEqual(
										sorted(
											Arr.filter(
												Arr.map(granted, (row) => String(row[0])),
												(name) => constants.has(name)
											)
										),
										sorted(expected),
										`the constants ${r.name} holds EXECUTE on, against the catalog's reach`
									)
									if (r.writes.length === 0) {
										c.note("a role that writes nothing")
									}
									const every = reachableConstants(i, installed, "every type")
									const own = reachableConstants(i, installed, "no written table's types")
									if (Arr.some([...every], (name) => !own.has(name))) {
										c.note("a constant only a written table's casts reach")
									}
									for (const written of r.writes) {
										const sketch = defined(
											Option.getOrUndefined(
												Arr.findFirst(world.relations, (x) => x.name === written)
											),
											`the relation ${written}`
										)
										const value = defined(built.relations.get(written), `the relation ${written}`)
										const columns = [
											names.column(value, "id"),
											...Arr.map(sketch.fields, (f) => names.column(value, f.name))
										]
										const refused = yield* refusalAs(
											owner,
											installed.role,
											`INSERT INTO ${names.table(value)} (${Arr.join(columns, ", ")}) VALUES (${Arr.join(
												Arr.map(columns, (_, k) => `$${k + 1}`),
												", "
											)})`,
											["00000000-0000-4000-8000-000000000001", ...Arr.map(sketch.fields, valueOf)]
										)
										assert.notDeepEqual(
											refused,
											Option.some("42501"),
											`${r.name}'s first insert into ${written} lacks no privilege`
										)
										if (Option.isNone(refused)) {
											c.note("an insert that holds")
										}
									}
								}
							})
						)
					}),
					Substrate,
					substrate2
				),
		oracle: {
			kind: "postgresql",
			name: "the catalog's own record of what each role's objects evaluate, through pg_depend, against has_function_privilege and a first insert"
		},
		budget: { runs: 16, steered: 16 },
		kept: [],
		kills: []
	})
