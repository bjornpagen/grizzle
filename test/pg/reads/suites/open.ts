import { layer } from "@effect/vitest"
import { assertInstanceOf } from "@effect/vitest/utils"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { constant, element, type Gen, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Layer, Option, Result } from "effect"
import { openDbContext } from "#adapter/db/open.ts"
import { ReadFailure } from "#adapter/errors/execution.ts"
import { MissingCapability, ServerError } from "#adapter/errors/failures.ts"
import { makeReader, poolExecutor, type ReaderValue } from "#adapter/reader/reader.ts"
import { isCompileError } from "#compiler/core/errors.ts"
import { pg, uuid, Vector } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
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
import { installMigratedIn as installIn } from "#test/support/install-migrate.ts"
import { caseHang } from "#test/support/limits.ts"
import { testTypeSchema } from "#test/support/sql.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { loginLayerIn } from "#test/support/worlds.ts"

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
 * The database a Db is opened against: the one Work and Search were installed in, with pgvector; a libc database holding
 * neither; or a builtin C.UTF-8 database without pgvector, where Work is installed too.
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

const openCaseGen: Gen<OpenCase> = anyOpenGen

type OpenFeature =
	| `role default ${Exclude<DefaultChange, "kept">} ${RoleDefaultParameter}`
	| "Work read"
	| "Search read"
	| "a read refused at the fence, the database without the schema's ledger"
	| "a vector probe answered"
	| "a vector probe refused before any SQL"

const openFeatures: Arr.NonEmptyReadonlyArray<OpenFeature> = [
	...Arr.flatMap(["reset", "wrong"] as const, (change) =>
		Arr.map(roleDefaults, (setting): OpenFeature => `role default ${change} ${setting.parameter}`)
	),
	"Work read",
	"Search read",
	"a read refused at the fence, the database without the schema's ledger",
	"a vector probe answered",
	"a vector probe refused before any SQL"
]

/** Whether a case's database holds its schema's installation. */
const holdsSchema = (c: OpenCase): boolean =>
	c.database === "installed" || (c.database === "builtin without pgvector" && c.schema === "Work")

/**
 * Db.open on PostgreSQL 19, over drawn opens: the schema (Work, or Search, whose embeddings need pgvector), the database
 * (the one both were installed in, with pgvector; a libc one holding neither; a builtin C.UTF-8 one without pgvector
 * where Work is installed too), and each role default the installation stores on the opened login kept, removed or
 * stored wrong.
 *
 * The oracle is README "Deploying": Db.open contacts nothing and checks nothing of the database, so every open yields a
 * Db, whatever the database or the login's stored defaults. A read through it on a database that holds the schema's
 * installation answers as the facts loaded there say, under every stored default, since every session of the login's
 * pool sends the defaults again as its startup options; on a database that holds none, the read's fence refuses it, the
 * ledger's lock finding no ledger (42P01). A query whose relation parameter carries a vector needs pgvector installed by
 * the snapshot in the vector schema: a Search Db, whose snapshot installs it, answers one where its schema is installed;
 * a Work Db, whose snapshot does not, is refused one at its compile, before any SQL: execute and get ReadFailure
 * {capability} with MissingCapability, db.compile its CompileError, and the database's sessions as they were.
 *
 * The opens a role, token or claims refuse are the worlds model's (test/pg/world-model); a password Effect's failure is
 * the connection suite's.
 */
export const openSuite = (): void => {
	layer(Substrate.layer)("Db.open", (it) => {
		it.effect(
			"yields a Db whatever the database, whose reads meet the fence, the stored defaults pinned by the startup options, and their capability before any SQL",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const s = yield* Substrate
						const work = yield* installed(W.Work, workFacts, { label: "real", extensions: [] })
						const searching = yield* installed(search.Search, {}, { label: "real", extensions: [] })
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
						/** A read the fence refused because the database holds no ledger of the schema. */
						const noLedger = (error: unknown): void => {
							assertInstanceOf(error, ReadFailure)
							assertInstanceOf(error.reason, ServerError)
							assert.equal(error.reason.sqlstate, "42P01")
						}
						return yield* explore(
							{
								suite: "reads/open",
								draw: drawn(openCaseGen),
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
									name: "Db.open yields a Db whatever the database; its reads meet the fence and their capability"
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
										yield* Effect.flatMap(
											openDbContext(work.server.roles.app, {}),
											({ db, ctx: context }) =>
												Effect.gen(function* () {
													const reader: ReaderValue = makeReader(context, poolExecutor(context))
													assert.equal(context.installedExtensions.has("vector"), false)
													const found = yield* Effect.result(reader.get(W.Task, { id: t1 }))
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
													const activity = s.admin.queryValues(
														"SELECT a.pid::text, a.state, a.query, a.state_change::text FROM pg_catalog.pg_stat_activity AS a WHERE a.datname = $1::name AND a.usename = $2::name ORDER BY a.pid",
														[database, loginRole]
													)
													const before = yield* activity
													const read = yield* Effect.flip(reader.execute(vectorProbe, { qs }))
													assertInstanceOf(read, ReadFailure)
													assertInstanceOf(read.reason, MissingCapability)
													assert.equal(read.stage, "capability")
													const got = yield* Effect.flip(reader.get(vectorProbe, { qs }))
													assertInstanceOf(got, ReadFailure)
													assertInstanceOf(got.reason, MissingCapability)
													assert.equal(got.stage, "capability")
													const compiled = yield* Effect.flip(Effect.scoped(db.compile(vectorProbe)))
													if (!isCompileError(compiled)) {
														return assert.fail("the probe's compile fails with a CompileError")
													}
													assert.equal(compiled.reason._tag, "UnsupportedOperation")
													const after = yield* activity
													assert.deepEqual(after, before)
													k.note("a vector probe refused before any SQL")
												})
										).pipe(
											Effect.orDie,
											withLayer(Layer.fresh(loginLayerIn(database, work.installed, work.server)))
										)
										return
									}
									yield* Effect.flatMap(
										openDbContext(searching.server.roles.app, {}),
										({ db, ctx: dbCtx }) =>
											Effect.gen(function* () {
												assert.equal(dbCtx.artifacts.names.vectorSchema, testTypeSchema("vector_ext"))
												const found = yield* Effect.result(
													db.get(search.Document, { id: "00000000-0000-4000-8000-000000000001" })
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
													Effect.flatMap(db.execute(searchProbe, { qs }), (r) => r.collect)
												)
												assert.deepEqual(probed, [])
												k.note("a vector probe answered")
												k.note("Search read")
											})
									).pipe(
										Effect.orDie,
										withLayer(
											Layer.fresh(loginLayerIn(database, searching.installed, searching.server))
										)
									)
								})
						)
					}).pipe(Effect.scoped)
				)
		)
	})
}

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
