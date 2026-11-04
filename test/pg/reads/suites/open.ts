import { layer } from "@effect/vitest"
import { assertInstanceOf } from "@effect/vitest/utils"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Context, Duration, Effect, Formatter, Layer, Schema } from "effect"
import { dbContext } from "#adapter/db/context.ts"
import { openDb } from "#adapter/db/open.ts"
import { OpenError, ReadFailure } from "#adapter/errors/execution.ts"
import {
	AdmissionRefused,
	type ClaimFault,
	ClaimRefused,
	CredentialError,
	MissingCapability,
	RoleOutsideLayers,
	TokenError
} from "#adapter/errors/failures.ts"
import { Db } from "#adapter/public/db.ts"
import { DbLayer as DbLayerValue } from "#adapter/public/layer.ts"
import { makeReader, poolExecutor, type ReaderValue } from "#adapter/reader/reader.ts"
import type { DbLayerService, DbLayerOf } from "#adapter/types/layer.ts"
import { isCompileError } from "#compiler/core/errors.ts"
import { builtMark } from "#compiler/core/phantom.ts"
import { emptyFingerprint } from "#compiler/deploy/snapshot/build.ts"
import { ledgerTableName } from "#compiler/physical/ddl/ledger.ts"
import { pg, uuid, Vector } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { context, login, role, schema } from "#compiler/public/schema.ts"
import { printRoleSetting, quoteIdent, quoteString } from "#compiler/sql/print.ts"
import type { AnyLogin, AnyLoginRole, AnyRole } from "#compiler/types/schema/world.ts"
import {
	type RoleDefault,
	type RoleDefaultSetting,
	roleDefaults
} from "#test/pg/adapter/support.ts"
import { bareDatabase, installed } from "#test/pg/reads/support.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined, unorderedEqual } from "#test/support/assert.ts"
import { pgPin } from "#test/support/env.ts"
import * as search from "#test/support/fixtures/api/search.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { a2, t1, t4, t7, workFacts } from "#test/support/fixtures/golden/work.ts"
import {
	installMigratedIn as installIn,
	installMigrated as install,
	loadMigrated as load
} from "#test/support/install-migrate.ts"
import { decodeJson } from "#test/support/json.ts"
import { testTypeSchema } from "#test/support/sql.ts"
import { Substrate, type SubstrateShape } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { fullWorld, loginLayer, loginLayerIn, testVerify, tokenOf } from "#test/support/worlds.ts"

/**
 * The facts a claims setting holds, as the JSON value it spells: its contract is the decoded facts of the contexts the
 * role reads, whatever the text's key order or spacing.
 */
const decodeSetting = decodeJson(Schema.Unknown)
const settingFacts = (text: string | undefined): unknown => decodeSetting(text ?? "")

const openError = (error: unknown): OpenError => {
	assertInstanceOf(error, OpenError)
	return error
}

const mismatchChecks = (error: OpenError): ReadonlyArray<string> => {
	const reason = error.reason
	assertInstanceOf(reason, AdmissionRefused)
	return Arr.map(reason.mismatches, (m) => m.check)
}

const mismatches = (error: OpenError): ReadonlyArray<readonly [string, string, string]> => {
	const reason = error.reason
	assertInstanceOf(reason, AdmissionRefused)
	return Arr.map(reason.mismatches, (m) => [m.stage, m.check, m.observed] as const)
}

/**
 * The ledger mismatch of a database that holds no ledger of `schema`: its latest complete target is the schema's empty
 * snapshot.
 */
const noLedger = (schema: string): readonly [string, string, string] => [
	"ledger",
	`ledger ${schema}.${ledgerTableName} latest complete target`,
	emptyFingerprint(schema)
]

const builtinCUtf8 =
	"ENCODING 'UTF8' LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8' LOCALE 'C.UTF-8'"

/**
 * A query whose relation parameter carries a vector, over Work, which stores none: its recordset's definition list
 * names vector_ext.vector(3), so the template requires the vector extension in the vector schema.
 */
const vectorProbe = query(W.Work).rule((r) => {
	const wanted = r.relation("qs", { id: uuid, e: pg.vector(3) })
	const { id, kind } = v(W.Task, "task")
	return r.match(wanted, { id }).match(W.Task, { id, kind }).find({ id, kind })
})

/**
 * A value admission must refuse for each role default Publish stores, as ALTER ROLE ... SET spells it: PostgreSQL's own
 * search path, jit on, no extra float digits, the C locale.
 */
const wrongRoleDefault: { readonly [P in RoleDefault]: string } = {
	search_path: `${quoteIdent("$user")}, ${quoteIdent("public")}`,
	jit: quoteString("on"),
	extra_float_digits: quoteString("0"),
	lc_monetary: quoteString("C"),
	lc_numeric: quoteString("C"),
	lc_time: quoteString("C"),
	lc_messages: quoteString("C")
}

/** The member's context: the account a session acts for, read from the payload's `member` claim object. */
const Member = context("Member", { account: uuid }, { claim: "member" })

/**
 * Work's worlds for the open suite, over the schema they are given: its full world; an auditor reading Account whole in
 * a login of its own; a member whose query entry is the tasks of the account its claims name, in a login of its own.
 */
const openWorlds = (Work: W.WorkNamed<string>) => {
	const full = fullWorld(Work)
	const auditor = role(Work, "auditor", { Account: W.Account })
	const myTasks = query(Work).rule((r) => {
		const { id, account, kind } = v(W.Task, "task")
		return r.match(W.Task, { id, account, kind }).match(Member, { account }).find({ id, kind })
	})
	const member = role(Work, "member", { MyTask: myTasks })
	return {
		...full,
		auditor,
		ops: login(Work, "ops", [auditor]),
		member,
		web: login(Work, "web", [member])
	}
}

/**
 * A service the context holds under a key no layer is stored under: what lets an open whose role no provided layer
 * serves typecheck, so the run time is what refuses it.
 */
const unserved = <R>(): Context.Service<DbLayerService<R>, DbLayerService<R>> =>
	Context.Service<DbLayerService<R>, DbLayerService<R>>("@bjornpagen/grizzle/test/unserved")

/** The DbLayer of `login` in the substrate's database, given `snapshot`, its password the Effect `password`. */
const layerWithPassword = <L extends AnyLogin>(
	substrate: SubstrateShape,
	loginValue: L,
	snapshot: { readonly fingerprint: string },
	password: Effect.Effect<never, CredentialError>
): Layer.Layer<DbLayerOf<L>, OpenError> =>
	DbLayerValue.make({
		login: loginValue,
		snapshot,
		host: pgPin.host,
		port: pgPin.port,
		database: substrate.database,
		password,
		tls: { ca: substrate.cluster.caPem },
		verify: testVerify
	})

/** Every claims payload a member's open is given, by what grizzle makes of it. */
type PayloadFault = ClaimFault["kind"]

/**
 * Every way a Db.open of the worked example (or, for a vector column, of the search example) can be refused, one stage
 * each, with the faultless opens. The role-default faults remove each default Publish stores on the login role, or store
 * it wrong.
 */
type OpenCase =
	| { readonly kind: "admitted" }
	| { readonly kind: "claims admitted" }
	| { readonly kind: "absent claim object admitted" }
	| { readonly kind: "vector column admitted" }
	| { readonly kind: "role of another login" }
	| { readonly kind: "not a role" }
	| { readonly kind: "token refused" }
	| { readonly kind: "payload refused"; readonly fault: PayloadFault }
	| {
			readonly kind: "role default"
			readonly change: "reset" | "wrong"
			readonly setting: RoleDefaultSetting
	  }
	| { readonly kind: "libc database" }
	| { readonly kind: "vector column without pgvector" }
	| { readonly kind: "failing password" }

type OpenFeature =
	| Exclude<OpenCase["kind"], "role default" | "payload refused">
	| `payload refused ${PayloadFault}`
	| `role default ${"reset" | "wrong"} ${RoleDefault}`

const featureOf = (openCase: OpenCase): OpenFeature => {
	switch (openCase.kind) {
		case "payload refused":
			return `payload refused ${openCase.fault}`
		case "role default":
			return `role default ${openCase.change} ${openCase.setting.parameter}`
		case "admitted":
		case "claims admitted":
		case "absent claim object admitted":
		case "vector column admitted":
		case "role of another login":
		case "not a role":
		case "token refused":
		case "libc database":
		case "vector column without pgvector":
		case "failing password":
			return openCase.kind
	}
}

/** The payload of each fault, and of the faultless opens: a member claim object for a2, an absent one. */
const faultPayload: { readonly [F in PayloadFault]: unknown } = {
	notAnObject: { member: "a2" },
	missing: { member: {} },
	refused: { member: { account: "not a uuid" } }
}

const roleDefaultCases: Arr.NonEmptyReadonlyArray<OpenCase> = Arr.flatMap(
	["reset", "wrong"] as const,
	(change) =>
		Arr.map(roleDefaults, (setting): OpenCase => ({
			kind: "role default",
			change,
			setting
		}))
)

/**
 * The faults first and the faultless opens last, so no admission a layer reuses precedes a refusal: an exhaustive
 * check runs a list's values in its order.
 */
const openCases: Arr.NonEmptyReadonlyArray<OpenCase> = [
	{ kind: "role of another login" },
	{ kind: "not a role" },
	{ kind: "token refused" },
	{ kind: "payload refused", fault: "notAnObject" },
	{ kind: "payload refused", fault: "missing" },
	{ kind: "payload refused", fault: "refused" },
	...roleDefaultCases,
	{ kind: "libc database" },
	{ kind: "vector column without pgvector" },
	{ kind: "failing password" },
	{ kind: "admitted" },
	{ kind: "claims admitted" },
	{ kind: "absent claim object admitted" },
	{ kind: "vector column admitted" }
]

const openFeatures: Arr.NonEmptyReadonlyArray<OpenFeature> = Arr.map(openCases, featureOf)

/**
 * Db.open and minimal admission on PostgreSQL 19, exhaustively over the ways an open can be refused, one stage each:
 *
 * - role: a role whose login's layer the context does not hold, before any connection; a value no login(...) reached
 *   is the schema stage;
 * - token: a token the layer's verify refuses, and verified payloads that do not decode through the role's contexts (a
 *   claim object that is no object, a field missing from it, a value its field's encoder refuses), each before any
 *   connection, the verifier's TokenError for its own refusal and ClaimRefused for grizzle's;
 * - roleDefaults: each default Publish stores on the login role, its search_path among them, removed or stored with a
 *   wrong value, read from the catalog, so a missing jit = off or extra_float_digits = 1 is refused even where the
 *   server's own default makes the effective value right;
 * - locale: a libc database, with PostgreSQL's own spellings (provider 'c', a NULL datlocale read as the empty string);
 * - capability: a schema with a vector column on a builtin C.UTF-8 database without pgvector;
 * - each refusal's reason holds every mismatch of the stages judged, a later stage's included: the bare databases of
 *   locale and capability hold no ledger of the schema, so their ledger holds the schema's empty snapshot, not the one
 *   given (README, "Errors and outcomes": an AdmissionRefused holds every mismatch, at the first stage that has one);
 * - credential: a password Effect that fails, with the CredentialError as its reason, before any connection;
 *
 * and the faultless opens: of the worked example's full role, of a role whose query entry reads a context, whose reads
 * deliver exactly the facts its claims select, the claims setting holding only the decoded facts, and of an absent claim
 * object, which opens with no fact; and of a schema with a vector column, whose extension the vector schema holds. A
 * capability a query needs that the admitted database lacks, such as pgvector for a relation parameter's vector column,
 * is found when the query compiles, before any SQL.
 */
export const openSuite = (): void => {
	layer(Substrate.layer)("Db.open and minimal admission", (it) => {
		it.effect(
			"refuses each open fault at its stage with its reason, before connecting where nothing needs the server, and admits the faultless open",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const s = yield* Substrate
						const declared = openWorlds(W.Work)
						const done = yield* install(W.Work, {
							ambient: ordinarySession,
							label: "real",
							extensions: [],
							logins: [declared.server, declared.ops, declared.web]
						})
						yield* load(done, workFacts)
						const worlds = openWorlds(schema(done.schema, W.Work.relations, W.Work.statements))
						const searching = yield* installed(search.Search, {}, { label: "real", extensions: [] })
						const serverRole = done.as(worlds.server).role
						/** The backends of a login's role: a refusal before connecting leaves none. */
						const backendsOf = (loginValue: AnyLogin) =>
							s.admin.queryValues(
								"SELECT pg_catalog.count(*)::text FROM pg_catalog.pg_stat_activity WHERE usename = $1::name",
								[done.as(loginValue).role]
							)
						/** The OpenError a refused open fails with. */
						const refusal = <A, E, R>(open: Effect.Effect<A, E, R>) =>
							Effect.map(Effect.flip(open), openError)
						const openApp = Db.open(worlds.server.roles.app, {})
						/**
						 * datlocprovider is 'c' for libc, and the NULL datlocale of a libc database is read as
						 * the empty string.
						 */
						const openMember = (payload: unknown) =>
							Db.open(worlds.web.roles.member, { token: tokenOf(payload) })
						return yield* exhaust(
							{
								suite: "reads/open",
								generator: element(openCases),
								literal: Formatter.format,
								limit: 32,
								coverage: requiredInSpace<OpenFeature>(openFeatures),
								caseHang: Duration.minutes(2)
							},
							(openCase, c) =>
								Effect.gen(function* () {
									switch (openCase.kind) {
										case "admitted": {
											const db = yield* openApp.pipe(
												withLayer(Layer.fresh(loginLayer(done, worlds.server)))
											)
											/**
											 * The setting holds only the decoded facts of the contexts the role reads.
											 */
											const opened = dbContext(db)
											assert.equal(opened?.role.name, "app")
											assert.equal(opened?.prologue.role, done.role(worlds.app))
											assert.deepEqual(settingFacts(opened?.prologue.claims), {})
											break
										}
										case "claims admitted": {
											yield* Effect.gen(function* () {
												const db = yield* openMember({ member: { account: a2 }, other: "ignored" })
												assert.deepEqual(settingFacts(dbContext(db)?.prologue.claims), {
													Member: { account: a2 }
												})
												const mine = query(worlds.member).rule((r) => {
													const { id } = v(worlds.member.relations.MyTask, "myTask")
													return r.match(worlds.member.relations.MyTask, { id }).find({ id })
												})
												const rows = yield* Effect.flatMap(db.execute(mine, {}), (r) => r.collect)
												/**
												 * The member's world is the tasks of a2, from the facts the fixture loads.
												 */
												const expected = Arr.map(
													Arr.filter(workFacts.Task, (t) => t.account === a2),
													(t) => t.id
												)
												unorderedEqual(expected, [t4, t7])
												unorderedEqual(
													Arr.map(rows, (row) => row.id),
													expected
												)
											}).pipe(Effect.scoped, withLayer(Layer.fresh(loginLayer(done, worlds.web))))
											break
										}
										case "absent claim object admitted": {
											yield* Effect.gen(function* () {
												const db = yield* openMember({})
												assert.deepEqual(settingFacts(dbContext(db)?.prologue.claims), {})
												const mine = query(worlds.member).rule((r) => {
													const { id } = v(worlds.member.relations.MyTask, "myTask")
													return r.match(worlds.member.relations.MyTask, { id }).find({ id })
												})
												const rows = yield* Effect.flatMap(db.execute(mine, {}), (r) => r.collect)
												assert.deepEqual(rows, [])
											}).pipe(Effect.scoped, withLayer(Layer.fresh(loginLayer(done, worlds.web))))
											break
										}
										case "vector column admitted": {
											yield* Effect.gen(function* () {
												const db = yield* Db.open(searching.server.roles.app, {})
												assert.equal(
													dbContext(db)?.artifacts.names.vectorSchema,
													testTypeSchema("vector_ext")
												)
												const found = yield* db.get(search.Document, {
													id: "00000000-0000-4000-8000-000000000001"
												})
												assert.equal(found._tag, "None")
											}).pipe(withLayer(Layer.fresh(searching.layer)))
											break
										}
										case "role of another login": {
											/**
											 * The auditor is in ops, whose layer the context does not hold: the server's does, and
											 * the auditor's requirement is held under a key no layer is stored under.
											 */
											const error = yield* refusal(
												Db.open(worlds.ops.roles.auditor, {}).pipe(
													withLayer(loginLayer(done, worlds.server)),
													Effect.provideService(unserved<typeof worlds.auditor>(), {})
												)
											)
											assert.equal(error.stage, "role")
											assert.deepEqual(
												error.reason,
												RoleOutsideLayers.make({ role: "auditor", login: "ops" })
											)
											assert.deepEqual(yield* backendsOf(worlds.ops), [["0"]])
											break
										}
										case "not a role": {
											/**
											 * A JavaScript caller's value no login(...) reached, which only the members of a role
											 * reached through its login describe: a copy of the server's app.
											 */
											const fake: AnyLoginRole = {
												...builtMark,
												kind: "loginRole",
												role: worlds.app,
												login: worlds.server
											}
											const error = yield* refusal(
												openDb(fake, { token: tokenOf({}) }).pipe(
													withLayer(loginLayer(done, worlds.server)),
													Effect.provideService(unserved<AnyRole>(), {})
												)
											)
											assert.equal(error.stage, "schema")
											break
										}
										case "token refused": {
											/** testVerify refuses a token that holds no JSON text, as its own TokenError. */
											const error = yield* refusal(
												Db.open(worlds.web.roles.member, { token: "not json" }).pipe(
													withLayer(Layer.fresh(loginLayer(done, worlds.web)))
												)
											)
											assert.equal(error.stage, "token")
											assertInstanceOf(error.reason, TokenError)
											assert.deepEqual(yield* backendsOf(worlds.web), [["0"]])
											break
										}
										case "payload refused": {
											const error = yield* refusal(
												openMember(faultPayload[openCase.fault]).pipe(
													withLayer(Layer.fresh(loginLayer(done, worlds.web)))
												)
											)
											assert.equal(error.stage, "token")
											const fault: ClaimFault =
												openCase.fault === "notAnObject"
													? { kind: "notAnObject" }
													: { kind: openCase.fault, field: "account" }
											assert.deepEqual(
												error.reason,
												ClaimRefused.make({ context: "Member", fault })
											)
											assert.deepEqual(yield* backendsOf(worlds.web), [["0"]])
											break
										}
										case "role default": {
											/**
											 * Admission reads the login role's own defaults from the catalog: a missing one is
											 * refused even where the server's default makes the effective value right (jit,
											 * extra_float_digits).
											 */
											const { setting } = openCase
											const parameter = quoteIdent(setting.parameter)
											const loginRole = quoteIdent(serverRole)
											yield* Effect.acquireRelease(
												s.admin.query(
													openCase.change === "reset"
														? `ALTER ROLE ${loginRole} RESET ${parameter}`
														: `ALTER ROLE ${loginRole} SET ${parameter} = ${wrongRoleDefault[setting.parameter]}`,
													[]
												),
												() =>
													Effect.orDie(
														s.admin.query(
															`ALTER ROLE ${loginRole} SET ${printRoleSetting(setting)}`,
															[]
														)
													)
											)
											const error = yield* refusal(
												openApp.pipe(withLayer(Layer.fresh(loginLayer(done, worlds.server))))
											)
											assert.equal(error.stage, "settings")
											assert.deepEqual(mismatchChecks(error), [
												`role ${serverRole} default ${setting.parameter}`
											])
											break
										}
										case "libc database": {
											const database = yield* bareDatabase(
												"bare",
												"ENCODING 'UTF8' LOCALE_PROVIDER libc LOCALE 'C'"
											)
											const error = yield* refusal(
												openApp.pipe(withLayer(loginLayerIn(database, done, worlds.server)))
											)
											assert.equal(error.stage, "locale")
											assert.deepEqual(mismatches(error), [
												["locale", "database locale provider", "c"],
												["locale", "database builtin locale", ""],
												noLedger(done.schema)
											])
											break
										}
										case "vector column without pgvector": {
											const database = yield* bareDatabase("bare", builtinCUtf8)
											const error = yield* refusal(
												Db.open(searching.server.roles.app, {}).pipe(
													withLayer(loginLayerIn(database, searching.installed, searching.server))
												)
											)
											assert.equal(error.stage, "capability")
											assert.deepEqual(mismatches(error), [
												["capability", "extension vector", "<not installed>"],
												noLedger(searching.installed.schema)
											])
											break
										}
										case "failing password": {
											const failing = layerWithPassword(
												s,
												worlds.server,
												done.snapshot,
												Effect.fail(CredentialError.make({ cause: "provider unavailable" }))
											)
											const error = yield* refusal(openApp.pipe(withLayer(failing)))
											assert.equal(error.stage, "credential")
											assertInstanceOf(error.reason, CredentialError)
											assert.deepEqual(yield* backendsOf(worlds.server), [["0"]])
											break
										}
									}
									c.note(featureOf(openCase))
								})
						)
					}).pipe(Effect.scoped)
				)
		)

		it.effect("a query that needs an extension the database lacks fails before any SQL", () =>
			Effect.gen(function* () {
				const s = yield* Substrate
				const opened = yield* installed(W.Work, workFacts, { label: "real", extensions: [] })
				/** The probe's vector field's carrier: three dimensions. */
				const e = Vector.make(Float32Array.of(1, 0, 0), 3)
				const qs = [{ id: t1, e }]
				yield* Effect.gen(function* () {
					const db = yield* Db.open(opened.server.roles.app, {})
					assert.equal(dbContext(db)?.installedExtensions.get("vector"), "vector_ext")
					const context = defined(dbContext(db), "the opened Db's context")
					const handle = yield* makeReader(context, poolExecutor(context)).compile(vectorProbe)
					const template = handle.compiled.template
					assert.deepEqual(template.requirements.extensions, ["vector"])
					assert.deepEqual(template.requirements.extensionSchemas, { vector: "vector_ext" })
				}).pipe(Effect.scoped, withLayer(opened.layer))
				/**
				 * A builtin C.UTF-8 database without it, where Work is installed too, admits Work, which stores no vector;
				 * the probe's relation parameter still names vector_ext.vector, so its read is refused before a session is
				 * even acquired.
				 */
				const database = yield* bareDatabase("bare", builtinCUtf8)
				yield* installIn(database, opened.installed)
				yield* Effect.gen(function* () {
					const db = yield* Db.open(opened.server.roles.app, {})
					assert.equal(dbContext(db)?.installedExtensions.has("vector"), false)
					const activity = () =>
						s.admin.queryValues(
							"SELECT a.pid::text, a.state, a.query, a.state_change::text FROM pg_catalog.pg_stat_activity AS a WHERE a.datname = $1::name AND a.usename = $2::name ORDER BY a.pid",
							[database, opened.installed.as(opened.server).role]
						)
					const before = yield* activity()
					assert.equal(before.length, 1)
					const read = yield* Effect.flip(db.execute(vectorProbe, { qs }))
					assertInstanceOf(read, ReadFailure)
					assertInstanceOf(read.reason, MissingCapability)
					assert.equal(read.stage, "capability")
					/**
					 * get's signature takes only a query proved at most one row; the probe is not, and the reader runtime
					 * db.get runs refuses its capability before it reads the proof.
					 */
					const context = defined(dbContext(db), "the opened Db's context")
					const reader: ReaderValue = makeReader(context, poolExecutor(context))
					const got = yield* Effect.flip(reader.get(vectorProbe, { qs }))
					assertInstanceOf(got, ReadFailure)
					assertInstanceOf(got.reason, MissingCapability)
					assert.equal(got.stage, "capability")
					const compiled = yield* Effect.flip(Effect.scoped(db.compile(vectorProbe)))
					if (!isCompileError(compiled)) {
						return assert.fail("the probe's compile fails with a CompileError")
					}
					assert.equal(compiled.reason._tag, "UnsupportedOperation")
					assert.deepEqual(yield* activity(), before)
				}).pipe(Effect.scoped, withLayer(loginLayerIn(database, opened.installed, opened.server)))
			}).pipe(Effect.scoped)
		)
	})
}
