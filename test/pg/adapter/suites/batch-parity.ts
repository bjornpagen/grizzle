import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { noCoverage } from "@grizzle/testing/features"
import { array, element, type Gen, int, map, weighted } from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Cause, Duration, Effect, Exit, Formatter, Result } from "effect"
import {
	type BatchOutcome,
	type BatchStatement,
	type FlightFailure,
	type FlightStatement,
	runFramed,
	writeFrame
} from "#adapter/wire/batch.ts"
import { type ServerStatement, serverStatement } from "#adapter/wire/session.ts"
import { indices } from "#compiler/core/array.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { assert, failureOf } from "#test/support/assert.ts"
import { fenceSql, prologueIn } from "#test/support/flight/model.ts"
import { wild } from "#test/support/kernel/naming.ts"
import { testSql } from "#test/support/sql.ts"
import { fixtureGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { freshSchema, Substrate } from "#test/support/substrate/substrate.ts"
import { tappedSession, type WireWindow } from "#test/support/wire-tap.ts"

/**
 * One session whose traffic the tap records, running flights framed as a Db's write: one transaction, its prologue
 * right after BEGIN.
 */
interface TappedSession {
	readonly batch: (
		statements: ReadonlyArray<FlightStatement>
	) => Effect.Effect<ReadonlyArray<BatchOutcome>, FlightFailure>
	/** Releases server statements, as their owner does (wire/session.ts SessionPool.release). */
	readonly release: (statements: ReadonlyArray<ServerStatement>) => void
	readonly retired: () => boolean
	readonly mark: () => number
	readonly since: (mark: number) => WireWindow
	readonly cancels: () => number
}

/** A flight is one turn of the conversation, and its answer ends with a ReadyForQuery whose status is `status`. */
const assertOneRoundTrip = (window: WireWindow, status: string): void => {
	assert.equal(window.roundTrips, 1, "one round trip")
	assert.deepEqual(window.backend.at(-1), { type: "Z", status }, "a ReadyForQuery ends the answer")
}

/** The primary key of the table `t`, a constraint the test names itself. */
const tKey = wild.constraint("t_key")

/**
 * The schema's table `t`, its one table and so the group a reset truncates (substrate/replace.ts), its sequence `seq`,
 * and a tapped session to the substrate's target as the owner.
 */
const fixture = () =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const raw = yield* s.schema(freshSchema)
		const schema = quoteIdent(raw)
		for (const sql of fenceSql(raw, s.owner.role)) {
			yield* s.admin.query(sql, [])
		}
		const frame = writeFrame(prologueIn(raw))
		yield* s.admin.query(
			`CREATE TABLE ${schema}."t" ("k" int4, "v" text NOT NULL, CONSTRAINT ${quoteIdent(tKey)} PRIMARY KEY ("k"))`,
			[]
		)
		yield* s.admin.query(`CREATE SEQUENCE ${schema}."seq"`, [])
		const tapped = yield* tappedSession({
			cluster: s.cluster,
			database: s.database,
			role: s.owner.role,
			password: s.owner.password,
			applicationName: "grizzle-wire-tap"
		})
		const session: TappedSession = {
			batch: (statements) => runFramed(tapped.session, frame, statements),
			release: (statements) => tapped.session.statements.release(statements),
			retired: () => tapped.session.retired(),
			mark: tapped.mark,
			since: tapped.since,
			cancels: tapped.cancels
		}
		const table = `${schema}."t"`
		return {
			s,
			schema,
			table,
			group: fixtureGroup([table]),
			seq: `${schema}."seq"`,
			session,
			wire: tapped.session
		}
	})

/** The rows of one statement in a batch of its own. */
const readBack = (session: TappedSession, sql: string) =>
	Effect.map(session.batch([{ sql: testSql(sql), params: [] }]), (outcomes) => outcomes[0]?.rows)

/** One statement of a flight: rows of a drawn count and tag, an insert, or an update that matches nothing. */
interface Step {
	readonly kind: "rows" | "insert" | "update"
	readonly count: number
	readonly tag: "a" | "bé" | "c\u{1F600}"
}

const stepGen: Gen<Step> = (source) => ({
	kind: source.draw(element(["rows", "insert", "update"] as const)),
	count: source.draw(int(0, 4)),
	tag: source.draw(element(["a", "bé", "c\u{1F600}"] as const))
})

/** How long one case may run before the search stops it as hung. */
const caseHang = Duration.minutes(2)

const refusals = {
	parse: { sql: testSql(`SELECT * FROM "no such table"`), params: [], sqlstate: "42P01" },
	bind: {
		sql: testSql(`SELECT $1::int4::text AS "n"`),
		params: ["not a number"],
		sqlstate: "22P02"
	},
	execute: { sql: testSql(`SELECT (1 / $1::int4)::text AS "n"`), params: ["0"], sqlstate: "22012" },
	unique: { sql: testSql(""), params: [], sqlstate: "23505" }
} as const

/**
 * One round trip: the wire's flights (packages/grizzle/src/adapter/wire/batch.ts) on the one driver, pg in pipeline mode, observed on
 * the protocol through the tap (test/support/wire-tap.ts).
 *
 * The properties: N statements are one round trip and one transaction, each result in its place as its text; a refused
 * statement, at whichever protocol step the server refuses it (parse, bind, execute, a constraint), is named by its
 * index and SQLSTATE, the statements before it roll back and none after it runs; a statement runs unnamed unless it is
 * a server statement, which a session parses on its first use and binds after, closing and parsing afresh a name a
 * failed flight leaves uncertain or its owner releases. Interruption of a flight is test/pg/adapter/flight.test.ts's and suites/interrupt.ts's; a lease's wait for a pooled session, an
 * interrupted one included, is test/pg/serverless/pool.test.ts's.
 */
export const batchParitySuite = (): void => {
	layer(Substrate.layer)("wire flights", (it) => {
		it.effect(
			"runs N statements in one round trip and one transaction, each result in its place as its text",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const { s, table, group, seq, session } = yield* fixture()
						const xid: BatchStatement = {
							sql: testSql("SELECT pg_catalog.txid_current()::text AS xid"),
							params: []
						}
						const statementOf = (planned: Step, index: number): BatchStatement => {
							switch (planned.kind) {
								case "rows":
									return {
										sql: testSql(
											`SELECT g::text AS "i", $1::text || g::text AS "label" FROM pg_catalog.generate_series(1, $2::int4) AS g`
										),
										params: [planned.tag, String(planned.count)]
									}
								case "insert":
									return {
										sql: testSql(
											`INSERT INTO ${table} ("k", "v") VALUES (pg_catalog.nextval('${seq}')::int4, $1::text) RETURNING "v"`
										),
										params: [`row ${index}`]
									}
								case "update":
									return { sql: testSql(`UPDATE ${table} SET "v" = "v" WHERE false`), params: [] }
							}
						}
						const expected = (planned: Step, index: number): BatchOutcome => {
							switch (planned.kind) {
								case "rows":
									return {
										command: "SELECT",
										rows: Arr.map(indices(planned.count), (g) => [
											String(g + 1),
											`${planned.tag}${g + 1}`
										])
									}
								case "insert":
									return { command: "INSERT", rows: [[`row ${index}`]] }
								case "update":
									return { command: "UPDATE", rows: [] }
							}
						}
						/** The first and the last statement saw one transaction. */
						const explored = yield* explore(
							{
								suite: `pg/adapter/batch-parity/one-round-trip`,
								draw: drawn(array(stepGen, { min: 1, max: 10 })),
								literal: Formatter.format,
								coverage: noCoverage,
								kept: [],
								runs: 8,
								shrink: completeShrink,
								concurrency: 1,
								steerEvery: 16,
								caseHang
							},
							(steps) =>
								Effect.gen(function* () {
									yield* replaceRows(s.admin, group, [])
									const statements = [xid, ...Arr.map(steps, statementOf), xid]
									const mark = session.mark()
									const outcomes = yield* session.batch(statements)
									assertOneRoundTrip(session.since(mark), "I")
									assert.equal(outcomes.length, statements.length)
									assert.equal(
										outcomes.at(0)?.rows.at(0)?.at(0),
										outcomes.at(-1)?.rows.at(0)?.at(0)
									)
									for (const [i, planned] of steps.entries()) {
										assert.deepEqual(outcomes[i + 1], expected(planned, i), `statement ${i + 1}`)
									}
									const inserted = yield* s.admin.queryValues(
										`SELECT "v" FROM ${table} ORDER BY "k"`,
										[]
									)
									assert.deepEqual(
										Arr.map(inserted, (row) => row[0]),
										Arr.flatMap(steps, (planned, i) =>
											planned.kind === "insert" ? [`row ${i}`] : []
										)
									)
								})
						)
						/** One statement is one round trip too, and commits. */
						const mark = session.mark()
						const [one] = yield* session.batch([
							{
								sql: testSql(`INSERT INTO ${table} ("k", "v") VALUES (-7, $1::text) RETURNING "v"`),
								params: ["one"]
							}
						])
						assertOneRoundTrip(session.since(mark), "I")
						assert.deepEqual(one, { command: "INSERT", rows: [["one"]] })
						const rows = yield* s.admin.queryValues(`SELECT "v" FROM ${table} WHERE "k" = -7`, [])
						assert.deepEqual(rows, [["one"]])
						return explored
					}).pipe(Effect.scoped)
				)
		)

		it.effect(
			"names the refused statement and its SQLSTATE, rolls back the ones before it and runs none after",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const { s, table, seq, session } = yield* fixture()
						yield* s.admin.query(`INSERT INTO ${table} ("k", "v") VALUES (-1, 'kept')`, [])
						const insert: BatchStatement = {
							sql: testSql(
								`INSERT INTO ${table} ("k", "v") VALUES (pg_catalog.nextval('${seq}')::int4, $1::text)`
							),
							params: ["doomed"]
						}
						const cases: Gen<{
							readonly before: number
							readonly after: number
							readonly refusal: keyof typeof refusals
						}> = (source) => ({
							before: source.draw(int(0, 4)),
							after: source.draw(int(0, 3)),
							refusal: source.draw(element(["parse", "bind", "execute", "unique"] as const))
						})
						return yield* explore(
							{
								/**
								 * Nothing committed. The statements before the refused one ran, since the sequence they
								 * advanced is not transactional, and the ones after it did not.
								 */
								suite: `pg/adapter/batch-parity/refused`,
								draw: drawn(cases),
								literal: Formatter.format,
								coverage: noCoverage,
								kept: [],
								runs: 10,
								shrink: completeShrink,
								concurrency: 1,
								steerEvery: 16,
								caseHang
							},
							({ before, after, refusal }) =>
								Effect.gen(function* () {
									yield* s.admin.query(`ALTER SEQUENCE ${seq} RESTART`, [])
									const planned = refusals[refusal]
									const refused: BatchStatement =
										refusal === "unique"
											? {
													sql: testSql(`INSERT INTO ${table} ("k", "v") VALUES (-1, 'again')`),
													params: []
												}
											: planned
									const statements = [
										...Array.from({ length: before }, () => insert),
										refused,
										...Array.from({ length: after }, () => insert)
									]
									const mark = session.mark()
									const failure = yield* failureOf(session.batch(statements))
									const window = session.since(mark)
									assert.equal(window.roundTrips, 1)
									assert.deepEqual(window.backend.at(-1), { type: "Z", status: "I" })
									assert.equal(failure._tag, "BatchRefused")
									if (failure._tag !== "BatchRefused") {
										return
									}
									assert.equal(failure.index, before)
									assert.equal(failure.failure._tag, "ServerError")
									assert.equal<string>(failure.failure.sqlstate, planned.sqlstate)
									if (refusal === "unique") {
										assert.equal(failure.failure.constraint, tKey)
									}
									assert.equal(session.retired(), false)
									const keys = yield* readBack(
										session,
										`SELECT "k"::text FROM ${table} ORDER BY "k"`
									)
									assert.deepEqual(keys, [["-1"]])
									const sequenceValue = yield* readBack(
										session,
										`SELECT (CASE WHEN is_called THEN last_value ELSE 0 END)::text FROM ${seq}`
									)
									assert.deepEqual(sequenceValue, [[String(before)]])
								})
						)
					}).pipe(Effect.scoped)
				)
		)

		it.effect(
			"parses a server statement on its first use and binds it after, closes what a failure or a release leaves, and runs the rest unnamed",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						/** The prologue's two statements, which every framed flight sends first (wire/batch.ts Prologue). */
						const prologueStatements = 2
						/** The server statements a session draws: two labels, and the refused statement; `c` runs unnamed. */
						const servers: Readonly<Record<"a" | "b" | "boom", ServerStatement>> = {
							a: serverStatement(testSql(`SELECT $1::text AS "a"`)),
							b: serverStatement(testSql(`SELECT $1::text AS "b"`)),
							boom: serverStatement(testSql("SELECT (1 / 0)::text"))
						}
						const unnamedSql = testSql(`SELECT $1::text AS "c"`)
						type Label = "a" | "b" | "c" | "boom"
						const statementOf = (label: Label): FlightStatement =>
							label === "c"
								? { sql: unnamedSql, params: [label] }
								: { server: servers[label], params: label === "boom" ? [] : [label] }
						/** One step: a flight of labelled statements, or the release of a label's server statement. */
						type Step =
							| { readonly kind: "flight"; readonly labels: ReadonlyArray<Label> }
							| { readonly kind: "release"; readonly label: "a" | "b" }
						/** The names of one session as its traffic shows them. */
						const namesOf = (session: TappedSession) => {
							/** Names parsed by a flight that succeeded, or before a failed flight's refusal, and not closed since. */
							const live = new Set<string>()
							/** Names a failed flight was parsing at or after its refusal, whose Parse may not have run. */
							const uncertain = new Set<string>()
							/** Names released and not closed since: the next flight closes each before anything else. */
							const released = new Set<string>()
							return (step: Step) =>
								Effect.gen(function* () {
									if (step.kind === "release") {
										const server = servers[step.label]
										session.release([server])
										if (live.has(server.name)) {
											released.add(server.name)
										}
										return
									}
									const batch = step.labels
									const mark = session.mark()
									const exit = yield* Effect.exit(session.batch(Arr.map(batch, statementOf)))
									const window = session.since(mark)
									const refused = batch.indexOf("boom")
									if (refused < 0) {
										assert.ok(
											Exit.isSuccess(exit),
											"a flight without the refused statement succeeds"
										)
										if (Exit.isSuccess(exit)) {
											assert.deepEqual(
												Arr.map(exit.value, (outcome) => outcome.rows),
												Arr.map(batch, (label) => [[label]])
											)
										}
									} else {
										assert.ok(Exit.isFailure(exit), "a flight with the refused statement fails")
										const failure = Exit.isFailure(exit) ? Cause.findError(exit.cause) : undefined
										assert.ok(failure !== undefined && Result.isSuccess(failure))
										assert.equal(failure.success._tag, "BatchRefused")
										if (failure.success._tag === "BatchRefused") {
											assert.equal(failure.success.index, refused)
										}
									}
									/**
									 * Walk the flight's messages: the statement a Parse or Bind belongs to is the number of
									 * Executes before it, the prologue's (the flight's first two, at -2 and -1) aside. A
									 * statement binds a name it or an earlier statement of the flight parsed, or a live one.
									 */
									const parsedHere = new Set<string>()
									let statement = -prologueStatements
									for (const message of window.frontend) {
										if (message.type === "E") {
											statement++
										}
										if (message.type === "C") {
											live.delete(message.name)
											uncertain.delete(message.name)
											released.delete(message.name)
										}
										if (message.type === "P" && message.name === "") {
											assert.equal(
												message.text,
												unnamedSql,
												"only a statement no server statement names runs unnamed"
											)
										}
										if (message.type === "P" && message.name !== "") {
											assert.ok(
												!live.has(message.name) && !uncertain.has(message.name),
												`${message.name} parsed again before its Close`
											)
											parsedHere.add(message.name)
											if (refused >= 0 && statement >= refused) {
												uncertain.add(message.name)
											} else {
												live.add(message.name)
											}
										}
										if (message.type === "B" && message.name !== "") {
											assert.ok(
												live.has(message.name) || parsedHere.has(message.name),
												`statement ${statement} binds ${message.name}, which was not parsed or was closed`
											)
										}
									}
									assert.equal(released.size, 0, "every released name is closed by the next flight")
								})
						}
						const label = element<Label>(["a", "b", "c", "boom"])
						const steps = array(
							weighted<Step>([
								[
									4,
									map(array(label, { min: 1, max: 4 }), (labels): Step => ({
										kind: "flight",
										labels
									}))
								],
								[
									1,
									map(element<"a" | "b">(["a", "b"]), (l): Step => ({ kind: "release", label: l }))
								]
							]),
							{ min: 4, max: 14 }
						)
						const run = namesOf((yield* fixture()).session)
						return yield* explore(
							{
								suite: `pg/adapter/batch-parity/names`,
								draw: drawn(steps),
								literal: Formatter.format,
								coverage: noCoverage,
								kept: [],
								runs: 8,
								shrink: completeShrink,
								concurrency: 1,
								steerEvery: 16,
								caseHang
							},
							(drawnSteps) => Effect.forEach(drawnSteps, run, { discard: true })
						)
					}).pipe(Effect.scoped)
				)
		)
	})
}
