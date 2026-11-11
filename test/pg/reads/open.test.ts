/**
 * Db.open on PostgreSQL 19, over drawn opens: the schema (Work, or Search, whose embeddings need pgvector), the
 * database (the one both were installed in, with pgvector; a libc one holding neither; a builtin C.UTF-8 one without
 * pgvector where Work is installed too), and each role default the installation stores on the opened login kept,
 * removed or stored wrong.
 *
 * The oracle is README "Deploying": Db.open contacts nothing and checks nothing of the database, so every open yields a
 * Db, whatever the database or the login's stored defaults. A read through it on a database that holds the schema's
 * installation answers as the facts loaded there say, under every stored default, since every session of the login's
 * pool sends the defaults again as its startup options; on a database that holds none, the read's fence refuses it, the
 * ledger's lock finding no schema of the installation (3F000). A query whose relation parameter carries a vector names
 * pgvector's type in the vector schema, which grizzle checks nothing of: a Search Db, whose role holds USAGE on it,
 * answers one where its schema is installed; Work's served file holds one too, compiled as any program, and PostgreSQL
 * refuses it at the call, a ReadFailure with the server's ServerError: where pgvector is installed the role holds no
 * USAGE on its schema (42501), and where it is not the schema does not exist (3F000). Each login is served from its
 * file as the installation compiled it, on a DbLayer of the case's database.
 *
 * The opens a role, token or claims refuse are the worlds model's (test/pg/world-model); a password Effect's failure is
 * the connection suite's.
 *
 * - Features: each role default reset and stored wrong, each schema read, a read refused at the fence, and a vector
 *   probe answered and refused.
 * - Plant: ~/.cache/grizzle-release/BR08/plants/open-vector-schema-granted-to-every-role.patch, every role granted
 *   USAGE on the vector schema, answers Work's vector probe and must turn the property red.
 */
import { layer } from "@effect/vitest"
import { assertInstanceOf } from "@effect/vitest/utils"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { constant, element, type Gen, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Layer, Option, Result } from "effect"
import { ReadFailure } from "#adapter/errors/execution.ts"
import { ServerError } from "#adapter/errors/failures.ts"
import { Db } from "#adapter/public/db.ts"
import { DbLayer } from "#adapter/public/layer.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { pg, uuid, Vector } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import type { AnyLogin } from "#compiler/public/schema.ts"
import { printRoleSetting, quoteIdent, quoteString } from "#compiler/sql/print.ts"
import {
	type RoleDefaultParameter,
	type RoleDefaultSetting,
	roleDefaults
} from "#test/pg/adapter/support.ts"
import { bareDatabase, installed } from "#test/pg/reads/support.ts"
import { assert } from "#test/support/assert.ts"
import * as search from "#test/support/fixtures/api/search.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { t1, workFacts } from "#test/support/fixtures/golden/work.ts"
import { type Installed, installMigratedIn as installIn } from "#test/support/install-migrate.ts"
import { caseHang } from "#test/support/limits.ts"
import { clusterConnection, clusterPool } from "#test/support/pg.ts"
import type { ServedFixture } from "#test/support/served-db.ts"
import { testTypeSchema } from "#test/support/sql.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { testVerify } from "#test/support/worlds.ts"

const builtinCUtf8 =
	"ENCODING 'UTF8' LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8' LOCALE 'C.UTF-8'"

/**
 * A query whose relation parameter carries a vector, over Work, which stores none: its arrays name
 * vector_ext.vector(3), so the template requires the vector extension in the vector schema, which Work's snapshot never
 * installs.
 */
const vectorProbe = query(W.Work).rule((r) => {
	const wanted = r.relation("qs", { id: uuid, e: pg.vector(3) })
	const { id, kind } = v(W.Task, "task")
	return r.match(wanted, { id }).match(W.Task, { id, kind }).find({ id, kind })
})

/**
 * The same probe over Search, whose role reads its embeddings' vectors and so holds USAGE on the vector schema: a
 * database with pgvector answers it.
 */
const searchProbe = query(search.Search).rule((r) => {
	const wanted = r.relation("qs", { id: uuid, e: pg.vector(3) })
	const { id, title } = v(search.Document, "document")
	return r.match(wanted, { id }).match(search.Document, { id, title }).find({ id, title })
})

/**
 * A value other than the installation's for each role default it stores, as ALTER ROLE ... SET spells it: PostgreSQL's
 * own search path, no extra float digits, PostgreSQL's own date style, bytea's escape format, the C locale.
 */
const wrongRoleDefault: { readonly [P in RoleDefaultParameter]: string } = {
	search_path: `${quoteIdent("$user")}, ${quoteIdent("public")}`,
	extra_float_digits: quoteString("0"),
	DateStyle: quoteString("Postgres, MDY"),
	bytea_output: quoteString("escape"),
	lc_monetary: quoteString("C"),
	lc_numeric: quoteString("C"),
	lc_time: quoteString("C")
}

/**
 * The database a Db is opened against: the one Work and Search were installed in, with pgvector; a libc database
 * holding neither; or a builtin C.UTF-8 database without pgvector, where Work is installed too.
 */
type OpenDatabase = "installed" | "libc" | "builtin without pgvector"

/** What a role default of the opened login is when the open runs: as installed, removed, or set to a wrong value. */
type DefaultChange = "kept" | "reset" | "wrong"

/**
 * One open: the schema, Work or Search (whose Document embeddings need pgvector), the database, and each of the
 * login's role defaults in the installation's own order (roleDefaults).
 */
interface OpenCase {
	readonly schema: "Work" | "Search"
	readonly database: OpenDatabase
	readonly defaults: ReadonlyArray<{
		readonly setting: RoleDefaultSetting
		readonly change: DefaultChange
	}>
}

/** Any open: either schema, any database, the one it was installed in most often, and each role default changed or not. */
const anyOpenGen: Gen<OpenCase> = (source) => ({
	schema: source.draw(element(["Work", "Search"] as const)),
	database: source.draw(
		weighted<OpenDatabase>([
			[2, constant("installed")],
			[1, constant("libc")],
			[1, constant("builtin without pgvector")]
		])
	),
	defaults: Arr.map(roleDefaults, (setting) => ({
		setting,
		change: source.draw(
			weighted<DefaultChange>([
				[2, constant("kept")],
				[1, constant("reset")],
				[1, constant("wrong")]
			])
		)
	}))
})

type OpenFeature =
	| `role default ${Exclude<DefaultChange, "kept">} ${RoleDefaultParameter}`
	| "Work read"
	| "Search read"
	| "a read refused at the fence, the database without the schema's ledger"
	| "a vector probe answered"
	| "a vector probe refused by PostgreSQL"

const openFeatures: Arr.NonEmptyReadonlyArray<OpenFeature> = [
	...Arr.flatMap(["reset", "wrong"] as const, (change) =>
		Arr.map(roleDefaults, (setting): OpenFeature => `role default ${change} ${setting.parameter}`)
	),
	"Work read",
	"Search read",
	"a read refused at the fence, the database without the schema's ledger",
	"a vector probe answered",
	"a vector probe refused by PostgreSQL"
]

/** Whether a case's database holds its schema's installation. */
const holdsSchema = (c: OpenCase): boolean =>
	c.database === "installed" || (c.database === "builtin without pgvector" && c.schema === "Work")

layer(Substrate.layer)("Db.open", (it) => {
	it.effect(
		"yields a Db whatever the database, whose reads meet the fence, the stored defaults pinned by the startup options, and PostgreSQL's judgement of the types they name",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const work = yield* installed(W.Work, workFacts, {
						label: "real",
						extensions: [],
						programs: { task: W.Task, vectorProbe }
					})
					const searching = yield* installed(
						search.Search,
						{},
						{
							label: "real",
							extensions: [],
							programs: { document: search.Document, searchProbe }
						}
					)
					/** The DbLayer of a fixture's served login in `database`, as an application builds it. */
					const layerIn = <L extends AnyLogin>(
						database: string,
						o: {
							readonly installed: Installed
							readonly server: L
							readonly served: ServedFixture<L>
						}
					) =>
						DbLayer.make({
							...clusterConnection(
								o.installed.cluster,
								database,
								o.installed.as(o.server).password
							),
							pool: clusterPool,
							login: o.served.login,
							verify: testVerify
						})
					const libc = yield* bareDatabase(
						"bare",
						"ENCODING 'UTF8' LOCALE_PROVIDER libc LOCALE 'C'"
					)
					const builtin = yield* bareDatabase("bare", builtinCUtf8)
					yield* installIn(builtin, work.installed)
					const databaseOf = (d: OpenDatabase): string => {
						switch (d) {
							case "installed":
								return work.installed.database
							case "libc":
								return libc
							case "builtin without pgvector":
								return builtin
						}
					}
					/** The probe's vector field's carrier: three dimensions. */
					const e = Vector.make(Float32Array.of(1, 0, 0), 3)
					const qs = [{ id: t1, e }]
					/** A read the fence refused: the database holds no schema of the installation, so no ledger. */
					const noLedger = (error: unknown): void => {
						assertInstanceOf(error, ReadFailure)
						assertInstanceOf(error.reason, ServerError)
						assert.equal(error.reason.sqlstate, sqlstates.invalidSchemaName)
					}
					return yield* explore(
						{
							suite: "reads/open",
							draw: drawn(anyOpenGen),
							literal: Formatter.format,
							kept: [],
							runs: 16,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							coverage: required<OpenFeature>(openFeatures, { cases: 64, sense: notesOnly }),
							caseHang,
							oracle: {
								kind: "specification",
								name: "Db.open yields a Db whatever the database; its reads meet the fence and PostgreSQL's judgement of the types they name"
							}
						},
						(c, k) =>
							Effect.gen(function* () {
								const database = databaseOf(c.database)
								const loginRole =
									c.schema === "Work"
										? work.installed.as(work.server).role
										: searching.installed.as(searching.server).role
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
								if (c.schema === "Work") {
									yield* Effect.flatMap(Db.open(work.served.login.roles.app, {}), (db) =>
										Effect.gen(function* () {
											const found = yield* Effect.result(db.workload.task.get({ id: t1 }))
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
												k.note(
													"a read refused at the fence, the database without the schema's ledger"
												)
											}
											if (!holdsSchema(c)) {
												return
											}
											/**
											 * The probe names vector_ext.vector(3): where pgvector is installed the role holds no USAGE
											 * on its schema (42501), and where it is not the schema does not exist (3F000).
											 */
											const refusedBy =
												c.database === "installed"
													? sqlstates.insufficientPrivilege
													: sqlstates.invalidSchemaName
											const read = yield* Effect.flip(db.workload.vectorProbe.execute({ qs }))
											assertInstanceOf(read, ReadFailure)
											assertInstanceOf(read.reason, ServerError)
											assert.equal(read.reason.sqlstate, refusedBy)
											k.note("a vector probe refused by PostgreSQL")
										})
									).pipe(Effect.orDie, withLayer(Layer.fresh(layerIn(database, work))))
									return
								}
								yield* Effect.flatMap(Db.open(searching.served.login.roles.app, {}), (db) =>
									Effect.gen(function* () {
										assert.equal(
											searching.installed.names.vectorSchema,
											testTypeSchema("vector_ext")
										)
										const found = yield* Effect.result(
											db.workload.document.get({ id: "00000000-0000-4000-8000-000000000001" })
										)
										if (!holdsSchema(c)) {
											assert.ok(Result.isFailure(found), `a read of ${c.database}`)
											noLedger(found.failure)
											k.note(
												"a read refused at the fence, the database without the schema's ledger"
											)
											return
										}
										assert.ok(Result.isSuccess(found), `a read of ${c.database}`)
										assert.equal(found.success._tag, "None")
										const probed = yield* Effect.orDie(
											Effect.flatMap(db.workload.searchProbe.execute({ qs }), (r) => r.collect)
										)
										assert.deepEqual(probed, [])
										k.note("a vector probe answered")
										k.note("Search read")
									})
								).pipe(Effect.orDie, withLayer(Layer.fresh(layerIn(database, searching))))
							})
					)
				}).pipe(Effect.scoped)
			)
	)
})

/**
 * Changes the login role's default `setting` as `change` says, for the case's scope: removed, or stored with a wrong
 * value, and stored again as the installation stores it when the case ends.
 */
const changedDefault = (loginRole: string, setting: RoleDefaultSetting, change: DefaultChange) =>
	Effect.gen(function* () {
		if (change === "kept") {
			return
		}
		const s = yield* Substrate
		const role = quoteIdent(loginRole)
		const parameter = quoteIdent(setting.parameter)
		yield* Effect.acquireRelease(
			s.admin.query(
				change === "reset"
					? `ALTER ROLE ${role} RESET ${parameter}`
					: `ALTER ROLE ${role} SET ${parameter} = ${wrongRoleDefault[setting.parameter]}`,
				[]
			),
			() => Effect.orDie(s.admin.query(`ALTER ROLE ${role} SET ${printRoleSetting(setting)}`, []))
		)
	})
