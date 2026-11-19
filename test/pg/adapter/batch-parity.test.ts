import { indices } from "@bjornpagen/grizzle-text/base/array"
import { assert, failureOf } from "@bjornpagen/testing/assert"
/**
 * The wire's flights (adapter/wire/batch.ts) on pg in pipeline mode, observed on the protocol through the tap
 * (test/support/wire-tap.ts), one session to a schema of the test's own with a write's frame.
 *
 * - One round trip: a flight of drawn statements (rows of a drawn count and text, inserts, an update that matches
 *   nothing), bracketed by txid_current(), is one round trip that ends idle; the brackets read one transaction; each
 *   statement answers in its place what a model of it says; and the rows its inserts commit are the model's.
 * - A refusal: a statement PostgreSQL refuses at its Parse, its Bind, its execution or a key, drawn among inserts before
 *   and after it, fails the flight at its index with PostgreSQL's own verdict on it run alone (the oracle: its SQLSTATE
 *   and the constraint it names), in one round trip, the session open after; the inserts before it roll back, their
 *   sequence advanced, and none after it runs.
 * - Prepared names: on a fresh session, each flight of drawn texts Parses exactly the names its connection has not
 *   parsed, each once, and Binds every statement's name, as a model of pg's per-connection names says; a Parse the
 *   server refused leaves its name to parse again; a refusal is the first refused text's, with PostgreSQL's SQLSTATE
 *   for that text alone; and the server ends holding exactly the parsed names, each with its text.
 *
 * Interruption of a flight is test/pg/adapter/flight.test.ts's and interrupt.test.ts's; a lease's wait for a pooled
 * session is test/pg/serverless/pool.test.ts's.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { array } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter, Array as Arr, Order, Result } from "effect"
import { type BatchOutcome, type BatchStatement } from "#adapter/wire/batch.ts"
import { flightsIn, flightsTemplate } from "#test/pg/adapter/batch-parity.fixtures.ts"
import {
	assertOneRoundTrip,
	type RoundTripFeature,
	flightModel,
	preparedCaseGen,
	type PreparedFeature,
	preparedOn,
	preparedRows,
	preparedSituations,
	preparedTexts,
	readBack,
	type RefusedFeature,
	refusedStatement,
	served,
	type Step,
	stepGen,
	tapIn,
	type Verdict,
	verdictAlone
} from "#test/pg/adapter/batch-parity.fixtures.ts"
import { refusedAts, refusedCases } from "#test/pg/adapter/batch-parity.fixtures.ts"
import { replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { outputRows, paramText } from "#test/support/wire.ts"

/**
 * Runs N statements in one round trip and one transaction, each result in its place as its text, each case on the worker's seat of the schema, its own tapped session.
 *
 * Its pre-conversion budget: runs 8, coverage cases 16 (test/pg/adapter/batch-parity.test.ts at f6a7126a8).
 */
export const runsNStatementsInOneRoundTripAndOneTransactionEachResultInItsPlaceAsItsText =
	property.explore(array(stepGen, { min: 1, max: 10 }), {
		needs: { seated: Substrate.seat(flightsTemplate) },
		situations: [
			"step rows",
			"step insert",
			"step update",
			"a statement answering no rows"
		] satisfies ReadonlyArray<Reached<RoundTripFeature>>,
		check:
			({ seated }, c: Case<RoundTripFeature>) =>
			(steps) =>
				Effect.scoped(
					Effect.flatMap(seated, (seat) =>
						Effect.provideService(
							Effect.gen(function* () {
								const { s, table, group, seq, session } = yield* flightsIn(seat)
								const xid = served("SELECT pg_catalog.txid_current()::text AS xid", [])
								const statementOf = (planned: Step, index: number): BatchStatement => {
									switch (planned.kind) {
										case "rows":
											return served(
												`SELECT g::text AS "i", $1::text || g::text AS "label" FROM pg_catalog.generate_series(1, $2::int4) AS g`,
												[paramText(planned.tag), paramText(String(planned.count))]
											)
										case "insert":
											return served(
												`INSERT INTO ${table} ("k", "v") VALUES (pg_catalog.nextval('${seq}')::int4, $1::text) RETURNING "v"`,
												[paramText(`row ${index}`)]
											)
										case "update":
											return served(`UPDATE ${table} SET "v" = "v" WHERE false`, [])
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
								for (const step of steps) {
									c.note(`step ${step.kind}`)
									if (step.kind !== "insert" && (step.kind === "update" || step.count === 0)) {
										c.note("a statement answering no rows")
									}
								}
								yield* replaceRows(s.admin, group, [])
								const statements = [xid, ...Arr.map(steps, statementOf), xid]
								const mark = session.mark()
								const outcomes = yield* session.batch(statements)
								assertOneRoundTrip(session.since(mark), "I")
								assert.equal(outcomes.length, statements.length)
								assert.equal(outcomes.at(0)?.rows.at(0)?.at(0), outcomes.at(-1)?.rows.at(0)?.at(0))
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
							}),
							Substrate,
							seat.substrate
						)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "a model of each statement's answer, and the rows its inserts commit"
		},
		show: Formatter.format,
		budget: { runs: 8, steered: 16 },
		kept: [],
		kills: []
	})

/**
 * Names the refused statement and its SQLSTATE, rolls back the ones before it and runs none after, each case on the worker's seat of the schema, its own tapped session.
 *
 * Its pre-conversion budget: runs 10, coverage cases 24 (test/pg/adapter/batch-parity.test.ts at f6a7126a8).
 */
export const namesTheRefusedStatementAndItsSqlstateRollsBackTheOnesBeforeItAndRunsNoneAfter =
	property.explore(refusedCases, {
		needs: { seated: Substrate.seat(flightsTemplate) },
		situations: [
			...Arr.map(refusedAts, (at): RefusedFeature => `refused at ${at}`),
			"the first statement refused",
			"statements after the refusal"
		] satisfies ReadonlyArray<Reached<RefusedFeature>>,
		check:
			({ seated }, c: Case<RefusedFeature>) =>
			({ before, after, refusal }) =>
				Effect.scoped(
					Effect.flatMap(seated, (seat) =>
						Effect.provideService(
							Effect.gen(function* () {
								const { s, table, seq, session } = yield* flightsIn(seat)
								yield* s.admin.query(`INSERT INTO ${table} ("k", "v") VALUES (-1, 'kept')`, [])
								const insert = served(
									`INSERT INTO ${table} ("k", "v") VALUES (pg_catalog.nextval('${seq}')::int4, $1::text)`,
									[paramText("doomed")]
								)
								c.note(`refused at ${refusal}`)
								if (before === 0) {
									c.note("the first statement refused")
								}
								if (after > 0) {
									c.note("statements after the refusal")
								}
								yield* s.admin.query(`ALTER SEQUENCE ${seq} RESTART`, [])
								const planned = refusedStatement(refusal, table)
								const alone = yield* verdictAlone(s, planned)
								const refused = served(planned.sql, planned.params)
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
								assert.deepEqual<Verdict>(
									{ sqlstate: failure.failure.sqlstate, constraint: failure.failure.constraint },
									alone,
									"the refusal is PostgreSQL's own for the statement alone"
								)
								assert.equal(session.state(), "open", "a refused statement leaves the session open")
								const keys = yield* readBack(session, `SELECT "k"::text FROM ${table} ORDER BY "k"`)
								assert.deepEqual(keys, outputRows([["-1"]]))
								const sequenceValue = yield* readBack(
									session,
									`SELECT (CASE WHEN is_called THEN last_value ELSE 0 END)::text FROM ${seq}`
								)
								assert.deepEqual(sequenceValue, outputRows([[String(before)]]))
							}),
							Substrate,
							seat.substrate
						)
					)
				),
		oracle: {
			kind: "postgresql",
			name: "the refused statement run alone: its SQLSTATE and constraint"
		},
		show: Formatter.format,
		budget: { runs: 10, steered: 24 },
		kept: [],
		kills: []
	})

/**
 * Parses each served statement once per session, by pg's record of its names, and parses again what the server refused, each case on the worker's seat of the schema, its own tapped session.
 *
 * Its pre-conversion budget: runs 12, coverage cases 64 (test/pg/adapter/batch-parity.test.ts at f6a7126a8).
 */
export const parsesEachServedStatementOncePerSessionAndParsesAgainWhatTheServerRefused =
	property.explore(preparedCaseGen, {
		needs: { seated: Substrate.seat(flightsTemplate) },
		situations: preparedSituations satisfies ReadonlyArray<Reached<PreparedFeature>>,
		check:
			({ seated }, cx: Case<PreparedFeature>) =>
			(flights) =>
				Effect.scoped(
					Effect.flatMap(seated, (seat) =>
						Effect.provideService(
							Effect.gen(function* () {
								const { s, frame } = yield* flightsIn(seat)
								const prologue = [frame.prologue.fence, frame.prologue.enter]
								const verdicts = {
									parse: yield* verdictAlone(s, preparedTexts.parse),
									execute: yield* verdictAlone(s, preparedTexts.execute)
								}
								return yield* Effect.scoped(
									Effect.gen(function* () {
										const { session, wire } = yield* tapIn(s, frame)
										const before = yield* preparedOn(wire)
										assert.deepEqual(before, [], "a new session holds none")
										const parsed = new Set<string>()
										const refusedBefore = new Set<string>()
										const texts = new Map<string, string>()
										for (const keys of flights) {
											const model = flightModel(parsed, prologue, keys, (feature) => {
												cx.note(feature)
											})
											for (const name of model.parses) {
												if (refusedBefore.has(name)) {
													cx.note("a name parsed again after its Parse was refused")
												}
											}
											const statements = Arr.map(keys, (key) =>
												served(preparedTexts[key].sql, preparedTexts[key].params)
											)
											for (const statement of [...prologue, ...statements]) {
												if (statement._tag === "prepared") {
													texts.set(statement.text.name, statement.text.sql)
												}
											}
											const mark = session.mark()
											const ran = yield* Effect.result(session.batch(statements))
											const window = session.since(mark)
											assert.equal(window.roundTrips, 1, "one round trip")
											assert.deepEqual(
												Arr.map(
													Arr.filter(window.frontend, (m) => m.type === "P"),
													(m) => m.name
												),
												model.parses,
												"the flight parses exactly the names its connection has not"
											)
											assert.deepEqual(
												Arr.map(
													Arr.filter(window.frontend, (m) => m.type === "B"),
													(m) => m.name
												),
												model.binds,
												"every statement is bound by its name"
											)
											for (const name of model.parses) {
												if (!parsed.has(name)) {
													refusedBefore.add(name)
												}
											}
											if (model.refused === undefined) {
												assert.deepEqual(
													Result.map(ran, (outcomes) => Arr.map(outcomes, (o) => o.rows)),
													Result.succeed(Arr.map(keys, (key) => outputRows(preparedRows[key]))),
													"each statement answers its own text's rows"
												)
												continue
											}
											const failure = Result.isFailure(ran) ? ran.failure : undefined
											assert.equal(
												failure?._tag,
												"BatchRefused",
												"the refused statement fails its flight"
											)
											if (failure?._tag !== "BatchRefused") {
												return
											}
											assert.equal(failure.index, model.refused.index)
											assert.equal<string>(
												failure.failure.sqlstate,
												verdicts[model.refused.at].sqlstate
											)
										}
										const held = yield* preparedOn(wire)
										assert.deepEqual(
											held,
											Arr.map(
												Arr.sort([...parsed], Order.String),
												(name): readonly [string, string] => [name, texts.get(name) ?? ""]
											),
											"the server holds exactly the names parsed, each with its text"
										)
									})
								)
							}),
							Substrate,
							seat.substrate
						)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "a model of the names pg's connection has parsed, and PostgreSQL's verdict on each refused text alone"
		},
		show: Formatter.format,
		budget: { runs: 12, steered: 64 },
		kept: [],
		kills: []
	})
