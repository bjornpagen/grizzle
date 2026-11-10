import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { noCoverage } from "@grizzle/testing/features"
import { array, element, type Gen, int } from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import {
	type BatchOutcome,
	type BatchStatement,
	type FlightFailure,
	runFramed,
	writeFrame
} from "#adapter/wire/batch.ts"
import type { SessionState } from "#adapter/wire/session.ts"
import { indices } from "#compiler/core/array.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { assert, failureOf } from "#test/support/assert.ts"
import { fenceSql, prologueIn } from "#test/support/flight/model.ts"
import { wild } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { testSql } from "#test/support/sql.ts"
import { fixtureGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { freshSchema, Substrate } from "#test/support/substrate/substrate.ts"
import { tappedSession, type WireWindow } from "#test/support/wire-tap.ts"
import { outputRows, paramText } from "#test/support/wire.ts"

/**
 * One session whose traffic the tap records, running flights framed as a Db's write: one transaction, its prologue
 * right after BEGIN.
 */
interface TappedSession {
	readonly batch: (
		statements: ReadonlyArray<BatchStatement>
	) => Effect.Effect<ReadonlyArray<BatchOutcome>, FlightFailure>
	readonly state: () => SessionState
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
		const frame = writeFrame(prologueIn(raw), "serializable")
		yield* s.admin.query(
			`CREATE TABLE ${schema}."t" ("k" int4, "v" text NOT NULL, CONSTRAINT ${quoteIdent(tKey)} PRIMARY KEY ("k"))`,
			[]
		)
		yield* s.admin.query(`CREATE SEQUENCE ${schema}."seq"`, [])
		const tapped = yield* tappedSession({
			cluster: s.cluster,
			database: s.database,
			role: s.owner.role,
			password: s.owner.password
		})
		const session: TappedSession = {
			batch: (statements) => runFramed(tapped.session, frame, statements),
			state: () => tapped.session.state(),
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

const refusals = {
	parse: { sql: testSql(`SELECT * FROM "no such table"`), params: [], sqlstate: "42P01" },
	bind: {
		sql: testSql(`SELECT $1::int4::text AS "n"`),
		params: [paramText("not a number")],
		sqlstate: "22P02"
	},
	execute: {
		sql: testSql(`SELECT (1 / $1::int4)::text AS "n"`),
		params: [paramText("0")],
		sqlstate: "22012"
	},
	unique: { sql: testSql(""), params: [], sqlstate: "23505" }
} as const

/**
 * One round trip: the wire's flights (packages/grizzle/src/adapter/wire/batch.ts) on the one driver, pg in pipeline mode, observed on
 * the protocol through the tap (test/support/wire-tap.ts).
 *
 * The properties: N statements are one round trip and one transaction, each result in its place as its text; a refused
 * statement, at whichever protocol step the server refuses it (parse, bind, execute, a constraint), is named by its
 * index and SQLSTATE, the statements before it roll back and none after it runs. Interruption of a flight is test/pg/adapter/flight.test.ts's and suites/interrupt.ts's; a lease's wait for a pooled session, an
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
										params: [paramText(planned.tag), paramText(String(planned.count))]
									}
								case "insert":
									return {
										sql: testSql(
											`INSERT INTO ${table} ("k", "v") VALUES (pg_catalog.nextval('${seq}')::int4, $1::text) RETURNING "v"`
										),
										params: [paramText(`row ${index}`)]
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
										rows: outputRows(
											Arr.map(indices(planned.count), (g) => [
												String(g + 1),
												`${planned.tag}${g + 1}`
											])
										)
									}
								case "insert":
									return { command: "INSERT", rows: outputRows([[`row ${index}`]]) }
								case "update":
									return { command: "UPDATE", rows: [] }
							}
						}
						/** The first and the last statement saw one transaction. */
						const explored = yield* explore(
							{
								oracle: { kind: "unstated" },
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
								params: [paramText("one")]
							}
						])
						assertOneRoundTrip(session.since(mark), "I")
						assert.deepEqual(one, { command: "INSERT", rows: outputRows([["one"]]) })
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
							params: [paramText("doomed")]
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
								oracle: { kind: "unstated" },
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
									assert.equal(
										session.state(),
										"open",
										"a refused statement leaves the session open"
									)
									const keys = yield* readBack(
										session,
										`SELECT "k"::text FROM ${table} ORDER BY "k"`
									)
									assert.deepEqual(keys, outputRows([["-1"]]))
									const sequenceValue = yield* readBack(
										session,
										`SELECT (CASE WHEN is_called THEN last_value ELSE 0 END)::text FROM ${seq}`
									)
									assert.deepEqual(sequenceValue, outputRows([[String(before)]]))
								})
						)
					}).pipe(Effect.scoped)
				)
		)
	})
}
