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
 * - Plants: ~/.cache/grizzle-release/BR08/plants/open-startup-options-dropped.patch, a pool whose sessions send no
 *   startup options, reads a stamp under a wrong stored style; and
 *   ~/.cache/grizzle-release/BR08/plants/open-vector-schema-granted-to-every-role.patch, every role granted USAGE on
 *   the vector schema, answers Work's vector probe; each must turn the property red.
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { type Reached, required } from "@grizzle/testing/features"
import { bytes as bytesGen, constant, type Gen, int, oneOf, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Layer, Option, Result, String as Str } from "effect"
import { Db } from "#adapter/public/db.ts"
import type { CallError } from "#compiler/live/index.ts"
import { bytes, date, pg, uuid, Vector } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { type AnyLogin, relation, schema } from "#compiler/public/schema.ts"
import { printRoleSetting, quoteIdent, quoteString } from "#compiler/sql/print.ts"
import {
	type RoleDefaultParameter,
	type RoleDefaultSetting,
	roleDefaults
} from "#test/pg/adapter/support.ts"
import { bareDatabase, installed } from "#test/pg/reads/support.ts"
import { assert } from "#test/support/assert.ts"
import { oneOf as oneRow, rowsOf } from "#test/support/calls.ts"
import * as search from "#test/support/fixtures/api/search.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { t1, workFacts } from "#test/support/fixtures/golden/work.ts"
import { type Installed, installMigratedIn as installIn } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { sourcedDbLayer } from "#test/support/live-layer.ts"
import { clusterConnection, clusterPool } from "#test/support/pg.ts"
import type { ServedFixture } from "#test/support/served-db.ts"
import { testTypeSchema } from "#test/support/sql.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
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
 * A schema whose every read depends on the session's output styles: a date, which DateStyle spells; a float8, which
 * extra_float_digits rounds; and bytes, which bytea_output spells. Its key is the stamp's id.
 */
const Stamp = relation("Stamp", { id: uuid, day: date, ratio: pg.float8, blob: bytes }, ["id"])
const Stamps = schema("Stamps", [Stamp], [])

/** The one stamp a case stores. */
const stampId = "00000000-0000-4000-8000-0000000000aa"

/** A stamp's values: a day as its ISO 8601 text, a ratio and its bytes. */
interface StampRow {
	readonly day: `${string}-${string}-${string}`
	readonly ratio: number
	readonly blob: Uint8Array
}

/** Two digits of a month or a day, four of a year. */
const padded = (n: number, width: number): string => Str.padStart(width, "0")(String(n))

/**
 * A stamp drawn whole: any day of the years 1 to 9999 (the 28 days every month has), a ratio of two whole numbers, most
 * of which need more than 15 significant digits, and up to eight bytes of any value.
 */
const stampGen: Gen<StampRow> = (source) => ({
	day: `${padded(source.draw(int(1, 9999)), 4)}-${padded(source.draw(int(1, 12)), 2)}-${padded(source.draw(int(1, 28)), 2)}`,
	ratio: source.draw(int(-999, 999)) / source.draw(int(1, 999)),
	blob: source.draw(bytesGen({ min: 0, max: 8 }))
})

/** The bytes' text as a bytea input reads it: hex. */
const byteaText = (blob: Uint8Array): string =>
	`\\x${Arr.join(
		Arr.map(Array.from(blob), (b) => Str.padStart(2, "0")(b.toString(16))),
		""
	)}`

/** The role defaults a stamp's read depends on. */
const stampDefaults = [
	"DateStyle",
	"extra_float_digits",
	"bytea_output"
] as const satisfies ReadonlyArray<RoleDefaultParameter>

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

/** What an open reads: Work, Search (whose Document embeddings need pgvector), or Stamps with the stamp it stores. */
type OpenTarget =
	| Readonly<{ schema: "Work" }>
	| Readonly<{ schema: "Search" }>
	| Readonly<{ schema: "Stamps"; stamp: StampRow }>

/**
 * One open: what it reads, the database, and each of the login's role defaults in the installation's own order
 * (roleDefaults).
 */
interface OpenCase {
	readonly target: OpenTarget
	readonly database: OpenDatabase
	readonly defaults: ReadonlyArray<{
		readonly setting: RoleDefaultSetting
		readonly change: DefaultChange
	}>
}

/** Any open: any schema, any database, the one it was installed in most often, and each role default changed or not. */
const anyOpenGen: Gen<OpenCase> = (source) => ({
	target: source.draw(
		oneOf<OpenTarget>([
			constant({ schema: "Work" }),
			constant({ schema: "Search" }),
			(stamps) => ({ schema: "Stamps", stamp: stamps.draw(stampGen) })
		])
	),
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
	| "Stamps read"
	| "a read refused at the fence, the database without the schema's ledger"
	| "a vector probe answered"
	| "a vector probe refused by PostgreSQL"

const openFeatures: Arr.NonEmptyReadonlyArray<Reached<OpenFeature>> = [
	...Arr.flatMap(["reset", "wrong"] as const, (change) =>
		Arr.map(roleDefaults, (setting): OpenFeature => `role default ${change} ${setting.parameter}`)
	),
	...Arr.map(stampDefaults, (parameter): Reached<OpenFeature> => [
		`role default wrong ${parameter}`,
		"Stamps read"
	]),
	"Work read",
	"Stamps read",
	"Search read",
	"a read refused at the fence, the database without the schema's ledger",
	"a vector probe answered",
	"a vector probe refused by PostgreSQL"
]

/** Whether a case's database holds its schema's installation. */
const holdsSchema = (c: OpenCase): boolean =>
	c.database === "installed" ||
	(c.database === "builtin without pgvector" && c.target.schema === "Work")

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
					const stamping = yield* installed(
						Stamps,
						{},
						{ label: "real", extensions: [], programs: { stamp: Stamp } }
					)
					const s = yield* Substrate
					const stampNames = namesOf(stamping.installed)
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
						sourcedDbLayer(o.installed, {
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
					const noLedger = (error: CallError): void =>
						assert.equal(
							error.kind,
							"failed",
							"the server refused the read: no schema of the ledger"
						)
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
									c.target.schema === "Work"
										? work.installed.as(work.server).role
										: c.target.schema === "Search"
											? searching.installed.as(searching.server).role
											: stamping.installed.as(stamping.server).role
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
								if (c.target.schema === "Stamps") {
									const stamp = c.target.stamp
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
												k.note(
													"a read refused at the fence, the database without the schema's ledger"
												)
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
								yield* Effect.flatMap(Db.open(searching.served.login.roles.app, {}), (db) =>
									Effect.gen(function* () {
										assert.equal(
											searching.installed.names.vectorSchema,
											testTypeSchema("vector_ext")
										)
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
											k.note(
												"a read refused at the fence, the database without the schema's ledger"
											)
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
