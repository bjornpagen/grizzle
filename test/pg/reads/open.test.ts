/**
 * Db.open on PostgreSQL 19, over drawn opens: the schema (Work; Search, whose embeddings need pgvector; or Stamps, with
 * a drawn stamp), the database (the one all three were installed in, with pgvector; a libc one holding none; a builtin
 * C.UTF-8 one without pgvector where Work is installed too), and each role default the installation stores on the
 * opened login kept, removed or stored wrong.
 *
 * The oracle is README "Deploying": Db.open contacts nothing and checks nothing of the database, so every open yields a
 * Db, whatever the database or the login's stored defaults. A read through it on a database that holds the schema's
 * installation answers as the facts loaded there say, under every stored default, since every session of the login's
 * pool sends the defaults again as its startup options. A stamp's read sees them: its day, which DateStyle spells, its
 * float8 ratio, most of whose values need more than the 15 digits extra_float_digits 0 prints, and its bytes, which
 * bytea_output spells, each read back exactly as stored under each of those defaults stored wrong (a required pair).
 * On a database that holds none, the read's fence refuses it, the
 * ledger's lock finding no schema of the installation (3F000). A query whose relation parameter carries a vector names
 * pgvector's type in the vector schema, which grizzle checks nothing of: a Search Db, whose role holds USAGE on it,
 * answers one where its schema is installed; Work's served file holds one too, compiled as any program, and PostgreSQL
 * refuses it at the call, a `failed` CallError: where pgvector is installed the role holds no USAGE on its schema
 * (42501), and where it is not the schema does not exist (3F000). Each login is served from its
 * file as the installation compiled it, on a DbLayer of the case's database.
 *
 * The opens a role, token or claims refuse are the worlds model's (test/pg/world-model); a password Effect's failure is
 * the connection suite's.
 *
 * - Features: each role default reset and stored wrong, each schema read, a stamp read under each of its output
 *   styles stored wrong, a read refused at the fence, and a vector probe answered and refused.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Layer, Option, Result, type Scope } from "effect"
import { Db } from "#adapter/public/db.ts"
import {
	anyOpenGen,
	builtinCUtf8,
	byteaText,
	changedDefault,
	holdsSchema,
	layerIn,
	noLedger,
	type OpenFeature,
	openFeatures,
	qs,
	searchProbe,
	Stamp,
	stampDefaults,
	stampId,
	Stamps,
	vectorProbe
} from "#test/pg/reads/open.fixtures.ts"
import { bareDatabase, installed } from "#test/pg/reads/support.ts"
import { assert } from "#test/support/assert.ts"
import { oneOf as oneRow, rowsOf } from "#test/support/calls.ts"
import * as search from "#test/support/fixtures/api/search.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { t1, workFacts } from "#test/support/fixtures/golden/work.ts"
import { installMigratedIn as installIn } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import type { SqlError } from "#test/support/pg.ts"
import { testTypeSchema } from "#test/support/sql.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * Db.open yields a Db whatever the database, whose reads meet the fence, the stored defaults pinned by the startup options, and PostgreSQL's judgement of the types they name.
 *
 * Its pre-conversion budget: runs 16, coverage cases 64 (test/pg/reads/open.test.ts at d8eed1786).
 */
export const dbOpenYieldsADbWhateverTheDatabaseWhoseReadsMeetTheFenceTheStoredDefaultsPinnedByTheStartupOptionsAndPostgreSQLsJudgementOfTheTypesTheyName =
	property.explore(anyOpenGen, {
		needs: { substrate: Substrate.installing },
		situations: openFeatures satisfies ReadonlyArray<Reached<OpenFeature>>,
		check:
			({ substrate }, k: Case<OpenFeature>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const s = yield* Substrate
						/**
						 * The database the case reads its target in, made for the case as it draws it: its target's own, a
						 * libc one holding none, or a builtin one without pgvector, holding Work for a Work target alone
						 * (`installTarget`), the one schema whose read there the case judges as held.
						 */
						const databaseFor = (
							installedIn: string,
							installTarget: (builtin: string) => Effect.Effect<void, never, Substrate>
						): Effect.Effect<string, SqlError, Substrate | Scope.Scope> => {
							switch (c.database) {
								case "installed":
									return Effect.succeed(installedIn)
								case "libc":
									return bareDatabase("bare", "ENCODING 'UTF8' LOCALE_PROVIDER libc LOCALE 'C'")
								case "builtin without pgvector":
									return Effect.tap(bareDatabase("bare", builtinCUtf8), installTarget)
							}
						}
						/**
						 * The target's login with its drawn stored defaults: the case changes the login itself, which is
						 * the cluster's, so its fixture is installed for the case alone, and only the target's.
						 */
						const withDefaults = (loginRole: string) =>
							Effect.gen(function* () {
								yield* Effect.forEach(
									c.defaults,
									(d) => changedDefault(loginRole, d.setting, d.change),
									{ discard: true }
								)
								for (const d of c.defaults) {
									if (d.change !== "kept") {
										k.note(`role default ${d.change} ${d.setting.parameter}`)
									}
								}
							})
						if (c.target.schema === "Stamps") {
							const stamp = c.target.stamp
							const stamping = yield* installed(
								Stamps,
								{},
								{ label: "real", programs: { stamp: Stamp } }
							)
							const stampNames = namesOf(stamping.installed)
							const database = yield* databaseFor(stamping.installed.database, () => Effect.void)
							yield* withDefaults(stamping.installed.as(stamping.server).role)
							yield* Effect.orDie(
								replaceRows(s.admin, installationGroup(stampNames), [
									{
										sql: `INSERT INTO ${stampNames.table(Stamp)} (${stampNames.column(Stamp, "id")}, ${stampNames.column(Stamp, "day")}, ${stampNames.column(Stamp, "ratio")}, ${stampNames.column(Stamp, "blob")}) VALUES ($1::uuid, $2::date, $3::float8, $4::bytea)`,
										params: [stampId, stamp.day, String(stamp.ratio), byteaText(stamp.blob)]
									}
								])
							)
							yield* Effect.flatMap(Db.open(stamping.served.login.roles.app, {}), (db) =>
								Effect.gen(function* () {
									const found = yield* Effect.result(
										oneRow(db.workload.stamp.once({ params: { id: stampId }, facts: {} }))
									)
									if (!holdsSchema(c)) {
										assert.ok(Result.isFailure(found), `a read of ${c.database}`)
										noLedger(found.failure)
										k.note("a read refused at the fence, the database without the schema's ledger")
										return
									}
									assert.ok(Result.isSuccess(found), `a read of ${c.database}`)
									const read = found.success
									if (Option.isNone(read)) {
										return assert.fail("the stored stamp reads back")
									}
									assert.deepEqual(
										{
											day: read.value.day,
											ratio: read.value.ratio,
											blob: Arr.fromIterable(read.value.blob)
										},
										{ day: stamp.day, ratio: stamp.ratio, blob: Arr.fromIterable(stamp.blob) },
										"the stamp reads back as stored, whatever the login's stored output styles"
									)
									k.note("Stamps read")
									for (const d of c.defaults) {
										if (
											d.change === "wrong" &&
											Arr.some(stampDefaults, (p) => p === d.setting.parameter)
										) {
											k.pair(`role default wrong ${d.setting.parameter}`, "Stamps read")
										}
									}
								})
							).pipe(Effect.orDie, withLayer(Layer.fresh(layerIn(database, stamping))))
							return
						}
						if (c.target.schema === "Work") {
							const work = yield* installed(W.Work, workFacts, {
								label: "real",
								programs: { task: W.Task, vectorProbe }
							})
							const database = yield* databaseFor(work.installed.database, (builtin) =>
								installIn(builtin, work.installed)
							)
							yield* withDefaults(work.installed.as(work.server).role)
							yield* Effect.flatMap(Db.open(work.served.login.roles.app, {}), (db) =>
								Effect.gen(function* () {
									const found = yield* Effect.result(
										oneRow(db.workload.task.once({ params: { id: t1 }, facts: {} }))
									)
									if (holdsSchema(c)) {
										assert.ok(Result.isSuccess(found), `a read of ${c.database}`)
										assert.equal(
											Option.isSome(found.success),
											c.database === "installed",
											"a task is found exactly where the facts were loaded"
										)
										k.note("Work read")
									} else {
										assert.ok(Result.isFailure(found), `a read of ${c.database}`)
										noLedger(found.failure)
										k.note("a read refused at the fence, the database without the schema's ledger")
									}
									if (!holdsSchema(c)) {
										return
									}
									/**
									 * The probe names vector_ext.vector(3): where pgvector is installed the role holds no USAGE
									 * on its schema (42501), and where it is not the schema does not exist (3F000).
									 */
									const read = yield* Effect.flip(
										rowsOf(db.workload.vectorProbe.once({ params: { qs }, facts: {} }))
									)
									assert.equal(
										read.kind,
										"failed",
										`the server refused the vector probe on ${c.database}`
									)
									k.note("a vector probe refused by PostgreSQL")
								})
							).pipe(Effect.orDie, withLayer(Layer.fresh(layerIn(database, work))))
							return
						}
						const searching = yield* installed(
							search.Search,
							{},
							{
								label: "real",
								programs: { document: search.Document, searchProbe }
							}
						)
						const database = yield* databaseFor(searching.installed.database, () => Effect.void)
						yield* withDefaults(searching.installed.as(searching.server).role)
						yield* Effect.flatMap(Db.open(searching.served.login.roles.app, {}), (db) =>
							Effect.gen(function* () {
								assert.equal(searching.installed.names.vectorSchema, testTypeSchema("vector_ext"))
								const found = yield* Effect.result(
									oneRow(
										db.workload.document.once({
											params: { id: "00000000-0000-4000-8000-000000000001" },
											facts: {}
										})
									)
								)
								if (!holdsSchema(c)) {
									assert.ok(Result.isFailure(found), `a read of ${c.database}`)
									noLedger(found.failure)
									k.note("a read refused at the fence, the database without the schema's ledger")
									return
								}
								assert.ok(Result.isSuccess(found), `a read of ${c.database}`)
								assert.equal(found.success._tag, "None")
								const probed = yield* Effect.orDie(
									rowsOf(db.workload.searchProbe.once({ params: { qs }, facts: {} }))
								)
								assert.deepEqual(probed, [])
								k.note("a vector probe answered")
								k.note("Search read")
							})
						).pipe(Effect.orDie, withLayer(Layer.fresh(layerIn(database, searching))))
					}).pipe(Effect.scoped),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "Db.open yields a Db whatever the database; its reads meet the fence and PostgreSQL's judgement of the types they name"
		},
		budget: { runs: 16, steered: 64 },
		kept: [],
		kills: []
	})
