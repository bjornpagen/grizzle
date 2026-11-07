import { layer } from "@effect/vitest"
import { assertInstanceOf } from "@effect/vitest/utils"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { constant, element, type Gen, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Layer, Option } from "effect"
import { dbContext } from "#adapter/db/context.ts"
import { OpenError, ReadFailure } from "#adapter/errors/execution.ts"
import {
	type AdmissionMismatch,
	AdmissionRefused,
	type AdmissionStage,
	MissingCapability
} from "#adapter/errors/failures.ts"
import { Db } from "#adapter/public/db.ts"
import { makeReader, poolExecutor, type ReaderValue } from "#adapter/reader/reader.ts"
import { isCompileError } from "#compiler/core/errors.ts"
import { emptyFingerprint } from "#compiler/deploy/snapshot/build.ts"
import { ledgerTableName } from "#compiler/physical/ddl/ledger.ts"
import { pg, uuid, Vector } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { printRoleSetting, quoteIdent, quoteString } from "#compiler/sql/print.ts"
import {
	type RoleDefaultParameter,
	type RoleDefaultSetting,
	roleDefaults
} from "#test/pg/adapter/support.ts"
import { bareDatabase, installed } from "#test/pg/reads/support.ts"
import { assert, assertVariant, defined, unorderedEqual } from "#test/support/assert.ts"
import * as search from "#test/support/fixtures/api/search.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { t1, workFacts } from "#test/support/fixtures/golden/work.ts"
import { installMigratedIn as installIn } from "#test/support/install-migrate.ts"
import { caseHang } from "#test/support/limits.ts"
import { testTypeSchema } from "#test/support/sql.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { loginLayerIn } from "#test/support/worlds.ts"

/**
 * The ledger mismatch of a database that holds no ledger of `schema`: its latest complete target is the schema's empty
 * snapshot.
 */
const noLedger = (schema: string): Shown => [
	"ledger",
	`ledger ${schema}.${ledgerTableName} latest complete target`,
	emptyFingerprint(schema)
]

const builtinCUtf8 =
	"ENCODING 'UTF8' LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8' LOCALE 'C.UTF-8'"

/**
 * A query whose relation parameter carries a vector, over Work, which stores none: its arrays name
 * vector_ext.vector(3), so the template requires the vector extension in the vector schema, and the role USAGE on it,
 * which Work's roles, reading no vector, never hold.
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
 * A value admission must refuse for each role default an installation stores, as ALTER ROLE ... SET spells it:
 * PostgreSQL's own search path, no extra float digits, PostgreSQL's own date style, bytea's escape format, the C locale.
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
 * The database an open is admitted against: the one Work and Search were installed in, with pgvector; a libc database
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

/**
 * An open that admission may admit: every role default kept, the schema opened in a database that holds it, Work's
 * in the one it was installed in or the builtin one, Search's in the one it was installed in.
 */
const admissibleGen: Gen<OpenCase> = (source) => {
	const schema = source.draw(element(["Work", "Search"] as const))
	return {
		schema,
		database:
			schema === "Work"
				? source.draw(element<OpenDatabase>(["installed", "builtin without pgvector"]))
				: "installed",
		defaults: Arr.map(roleDefaults, (setting): OpenCase["defaults"][number] => ({
			setting,
			change: "kept"
		}))
	}
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

const openCaseGen: Gen<OpenCase> = weighted<OpenCase>([
	[1, admissibleGen],
	[2, anyOpenGen]
])

type OpenFeature =
	| `role default ${Exclude<DefaultChange, "kept">} ${RoleDefaultParameter}`
	| "Work admitted"
	| "Search admitted"
	| "refused at locale"
	| "refused at capability"
	| "refused at settings"
	| "a vector probe answered"
	| "a vector probe refused, its extension absent"
	| "a vector probe refused, its schema not the role's to use"
	| "a task read"

const openFeatures: Arr.NonEmptyReadonlyArray<OpenFeature> = [
	...Arr.flatMap(["reset", "wrong"] as const, (change) =>
		Arr.map(roleDefaults, (setting): OpenFeature => `role default ${change} ${setting.parameter}`)
	),
	"Work admitted",
	"Search admitted",
	"refused at locale",
	"refused at capability",
	"refused at settings",
	"a vector probe answered",
	"a vector probe refused, its extension absent",
	"a vector probe refused, its schema not the role's to use",
	"a task read"
]

/** A mismatch as a case compares it: its stage, its check and, but for a setting's, the value observed. */
type Shown = readonly [stage: AdmissionStage, check: string, observed: string]

/** A setting's observed value is the catalog's spelling of it, which the model does not restate. */
const shown = (m: AdmissionMismatch): Shown => [
	m.stage,
	m.check,
	m.stage === "settings" ? "" : m.observed
]

/**
 * Admission's verdict on an open, as README "Connecting" and "Errors and outcomes" state it: every mismatch of the
 * stages judged, the first in admission's order its stage, none for an admitted open. The locale, capability and ledger
 * stages are judged together; a database whose ledger mismatches is judged no further, so its settings are not; and
 * every role default changed is one settings mismatch of the login's role.
 */
const mismatchesOf = (c: OpenCase, loginRole: string, schema: string): ReadonlyArray<Shown> => {
	const holdsSchema =
		c.database === "installed" || (c.database === "builtin without pgvector" && c.schema === "Work")
	const locale: ReadonlyArray<Shown> =
		c.database === "libc"
			? [
					["locale", "database locale provider", "c"],
					["locale", "database builtin locale", ""]
				]
			: []
	const capability: ReadonlyArray<Shown> =
		c.schema === "Search" && c.database !== "installed"
			? [["capability", "extension vector", "<not installed>"]]
			: []
	const ledger: ReadonlyArray<Shown> = holdsSchema ? [] : [noLedger(schema)]
	const settings: ReadonlyArray<Shown> = holdsSchema
		? Arr.flatMap(c.defaults, (d): ReadonlyArray<Shown> =>
				d.change === "kept"
					? []
					: [["settings", `role ${loginRole} default ${d.setting.parameter}`, ""]]
			)
		: []
	return [...locale, ...capability, ...ledger, ...settings]
}

/**
 * Db.open and minimal admission on PostgreSQL 19, over drawn opens: the schema (Work, or Search, whose embeddings need
 * pgvector), the database (the one both were installed in, with pgvector; a libc one holding neither; a builtin
 * C.UTF-8 one without pgvector where Work is installed too), and each role default the installation stores on the
 * opened login kept, removed or stored wrong, read from the catalog, so a missing extra_float_digits = 1 is refused even
 * where the server's own default makes the effective value right; one arm draws only opens a database may admit.
 *
 * The oracle is admission's contract, as a model of its mismatches (mismatchesOf): a refusal is OpenError whose
 * AdmissionRefused holds every mismatch of the stages judged, at the first stage in admission's order, a libc
 * database's locale (PostgreSQL's spellings: provider 'c', a NULL datlocale read as the empty string), a schema's
 * extension the database lacks, a database without the schema's ledger, which holds its empty snapshot, and each role
 * default changed; an open with none is admitted. A query whose relation parameter carries a vector needs pgvector
 * installed in the vector schema and its role's USAGE on that schema: an admitted Search Db, whose role reads vectors,
 * names its vector schema and answers one; an admitted Work Db reads a task, present exactly where its facts were
 * loaded, and is refused one at its compile, before any SQL, the extension absent from the builtin database and the
 * schema not its role's to use in the other: execute and get ReadFailure{capability} with MissingCapability, db.compile
 * its CompileError, and the database's sessions as they were.
 *
 * The opens a role, token or claims refuse, and the faultless opens of roles reading contexts, are the worlds model's
 * (test/pg/world-model); a password Effect's failure is the connection suite's.
 */
export const openSuite = (): void => {
	layer(Substrate.layer)("Db.open and minimal admission", (it) => {
		it.effect(
			"refuses a drawn open at its first stage with a mismatch, holding every mismatch judged, and admits the rest, whose reads meet their capability before any SQL",
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
									name: "admission's stages and mismatches, as a model of each open's verdict"
								}
							},
							(c, k) =>
								Effect.gen(function* () {
									const database = databaseOf(c.database)
									const loginRole =
										c.schema === "Work"
											? work.installed.as(work.server).role
											: searching.installed.as(searching.server).role
									const schemaName =
										c.schema === "Work" ? work.installed.schema : searching.installed.schema
									yield* Effect.forEach(
										c.defaults,
										(d) => changedDefault(loginRole, d.setting, d.change),
										{ discard: true }
									)
									const opened =
										c.schema === "Work"
											? yield* Effect.result(
													Effect.flatMap(Db.open(work.server.roles.app, {}), (db) =>
														Effect.gen(function* () {
															const context = defined(dbContext(db), "an opened Db's context")
															const reader: ReaderValue = makeReader(context, poolExecutor(context))
															const hasVector = c.database === "installed"
															assert.equal(context.installedExtensions.has("vector"), hasVector)
															const found = yield* Effect.orDie(reader.get(W.Task, { id: t1 }))
															assert.equal(
																Option.isSome(found),
																c.database === "installed",
																"a task is found exactly where the facts were loaded"
															)
															k.note("a task read")
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
															const compiled = yield* Effect.flip(
																Effect.scoped(db.compile(vectorProbe))
															)
															if (!isCompileError(compiled)) {
																return assert.fail("the probe's compile fails with a CompileError")
															}
															assert.equal(compiled.reason._tag, "UnsupportedOperation")
															const after = yield* activity
															assert.deepEqual(after, before)
															k.note(
																hasVector
																	? "a vector probe refused, its schema not the role's to use"
																	: "a vector probe refused, its extension absent"
															)
															k.note("Work admitted")
														})
													).pipe(
														withLayer(
															Layer.fresh(loginLayerIn(database, work.installed, work.server))
														)
													)
												)
											: yield* Effect.result(
													Effect.flatMap(Db.open(searching.server.roles.app, {}), (db) =>
														Effect.gen(function* () {
															assert.equal(
																dbContext(db)?.artifacts.names.vectorSchema,
																testTypeSchema("vector_ext")
															)
															const found = yield* db.get(search.Document, {
																id: "00000000-0000-4000-8000-000000000001"
															})
															assert.equal(found._tag, "None")
															const probed = yield* Effect.flatMap(
																db.execute(searchProbe, { qs }),
																(r) => r.collect
															)
															assert.deepEqual(probed, [])
															k.note("a vector probe answered")
															k.note("Search admitted")
														}).pipe(Effect.orDie)
													).pipe(
														withLayer(
															Layer.fresh(
																loginLayerIn(database, searching.installed, searching.server)
															)
														)
													)
												)
									const expected = mismatchesOf(c, loginRole, schemaName)
									const [first] = expected
									if (first === undefined) {
										assertVariant(opened, "_tag", "Success", "an open with no mismatch is admitted")
										return
									}
									assertVariant(opened, "_tag", "Failure", "an open with a mismatch is refused")
									const error = opened.failure
									assertInstanceOf(error, OpenError)
									assert.equal(error.stage, first[0])
									const reason = error.reason
									assertInstanceOf(reason, AdmissionRefused)
									unorderedEqual(Arr.map(reason.mismatches, shown), expected)
									if (
										first[0] === "locale" ||
										first[0] === "capability" ||
										first[0] === "settings"
									) {
										k.note(`refused at ${first[0]}`)
									}
									for (const d of c.defaults) {
										if (d.change !== "kept" && first[0] === "settings") {
											k.note(`role default ${d.change} ${d.setting.parameter}`)
										}
									}
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
