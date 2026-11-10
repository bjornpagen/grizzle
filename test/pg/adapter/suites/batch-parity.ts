import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import { array, element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Order, Result } from "effect"
import {
	type BatchOutcome,
	type BatchStatement,
	type FlightFailure,
	type Frame,
	oneShotStatement,
	preparedStatement,
	runFramed,
	runTransaction,
	writeFrame
} from "#adapter/wire/batch.ts"
import type { Session, SessionState } from "#adapter/wire/session.ts"
import { indices } from "#compiler/core/array.ts"
import { prepared } from "#compiler/core/prepared.ts"
import type { Param } from "#compiler/core/wire.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { assert, failureOf } from "#test/support/assert.ts"
import { fenceSql, prologueIn } from "#test/support/flight/model.ts"
import { wild } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { testSql } from "#test/support/sql.ts"
import { fixtureGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { freshSchema, Substrate, type SubstrateShape } from "#test/support/substrate/substrate.ts"
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
		const { session, wire } = yield* tapIn(s, frame)
		const table = `${schema}."t"`
		return {
			s,
			schema,
			table,
			group: fixtureGroup([table]),
			seq: `${schema}."seq"`,
			frame,
			session,
			wire
		}
	})

/** A new session to the substrate's target as the owner, tapped, whose batches run in `frame`. */
const tapIn = (s: SubstrateShape, frame: Frame) =>
	Effect.map(
		tappedSession({
			cluster: s.cluster,
			database: s.database,
			role: s.owner.role,
			password: s.owner.password
		}),
		(tapped) => {
			const session: TappedSession = {
				batch: (statements) => runFramed(tapped.session, frame, statements),
				state: () => tapped.session.state(),
				mark: tapped.mark,
				since: tapped.since,
				cancels: tapped.cancels
			}
			return { session, wire: tapped.session }
		}
	)

/** A Db call's statement over `params`: its text named, as a served login sends it (core/prepared.ts). */
const served = (sql: string, params: ReadonlyArray<Param>): BatchStatement =>
	preparedStatement(prepared(testSql(sql)), params)

/** The rows of one statement in a batch of its own. */
const readBack = (session: TappedSession, sql: string) =>
	Effect.map(session.batch([served(sql, [])]), (outcomes) => outcomes[0]?.rows)

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
	parse: { sql: `SELECT * FROM "no such table"`, params: [], sqlstate: "42P01" },
	bind: {
		sql: `SELECT $1::int4::text AS "n"`,
		params: [paramText("not a number")],
		sqlstate: "22P02"
	},
	execute: {
		sql: `SELECT (1 / $1::int4)::text AS "n"`,
		params: [paramText("0")],
		sqlstate: "22012"
	},
	unique: { sql: "", params: [], sqlstate: "23505" }
} as const

/**
 * The texts a prepared-statement case's flights draw from, by what PostgreSQL makes of each: one that answers rows,
 * one that answers rows with no parameter, one refused at its execution, and one refused at its Parse.
 */
const preparedTexts = {
	rows: { sql: `SELECT $1::text AS "a"`, params: [paramText("a")], refused: undefined },
	plain: {
		sql: `SELECT g::text AS "g" FROM pg_catalog.generate_series(1, 2) AS g`,
		params: [],
		refused: undefined
	},
	execute: { ...refusals.execute, refused: refusals.execute.sqlstate },
	parse: { ...refusals.parse, refused: refusals.parse.sqlstate }
} as const

type PreparedKey = keyof typeof preparedTexts

/** The rows each text answers where it runs: the refused ones run in no flight that answers. */
const preparedRows: { readonly [K in PreparedKey]: ReadonlyArray<ReadonlyArray<string>> } = {
	rows: [["a"]],
	plain: [["1"], ["2"]],
	execute: [],
	parse: []
}

/** A case of the prepared-statement search: the flights one fresh session sends, each its statements' texts. */
type PreparedCase = ReadonlyArray<ReadonlyArray<PreparedKey>>

const preparedCaseGen: Gen<PreparedCase> = array(
	array(element(["rows", "plain", "execute", "parse"] as const), { min: 1, max: 5 }),
	{ min: 1, max: 4 }
)

type PreparedFeature =
	| "a name bound with no Parse, parsed by an earlier flight"
	| "a name parsed again after its Parse was refused"
	| "one name twice in a flight"
	| "a Parse refused in an aborted transaction"

const preparedSituations: Arr.NonEmptyReadonlyArray<PreparedFeature> = [
	"a name bound with no Parse, parsed by an earlier flight",
	"a name parsed again after its Parse was refused",
	"one name twice in a flight",
	"a Parse refused in an aborted transaction"
]

/**
 * What one flight sends and meets, by pg's own record of the names its connection parsed (`parsed`, which it extends):
 * the names it parses, each once, the first time the flight names it where the connection has not parsed it; every
 * statement's name, the prologue's first, as its Binds name them; and the first statement the server refuses, a Parse
 * of the parse-refused text or of any text once the transaction aborted, or the execution-refused text's execution.
 * A Parse refused leaves its name unparsed, so a later flight parses it again; one that succeeds stays parsed whatever
 * the transaction then does.
 */
const flightModel = (
	parsed: Set<string>,
	prologue: ReadonlyArray<BatchStatement>,
	keys: ReadonlyArray<PreparedKey>,
	note: (feature: PreparedFeature) => void
) => {
	const sentNames = new Set<string>()
	const parses: Array<string> = []
	const binds: Array<string> = []
	let aborted = false
	let refused: { readonly index: number; readonly sqlstate: string } | undefined
	const named = (statement: BatchStatement): string =>
		statement._tag === "prepared" ? statement.text.name : ""
	for (const statement of prologue) {
		const name = named(statement)
		binds.push(name)
		if (parsed.has(name) || sentNames.has(name)) {
			continue
		}
		sentNames.add(name)
		parses.push(name)
		parsed.add(name)
	}
	for (const [index, key] of keys.entries()) {
		const text = preparedTexts[key]
		const name = named(served(text.sql, text.params))
		binds.push(name)
		if (sentNames.has(name)) {
			note("one name twice in a flight")
		} else if (parsed.has(name)) {
			note("a name bound with no Parse, parsed by an earlier flight")
		} else {
			sentNames.add(name)
			parses.push(name)
			if (aborted) {
				note("a Parse refused in an aborted transaction")
			} else if (key === "parse") {
				aborted = true
				refused = { index, sqlstate: preparedTexts.parse.refused }
			} else {
				parsed.add(name)
			}
		}
		if (!aborted && key === "execute") {
			aborted = true
			refused = { index, sqlstate: preparedTexts.execute.refused }
		}
	}
	return { parses, binds, refused }
}

/** The session's prepared statements, by name, each with its text, read one-shot so the read prepares nothing. */
const preparedOn = (wire: Session) =>
	Effect.map(
		runTransaction(
			wire,
			[
				oneShotStatement(
					testSql(
						'SELECT name, statement FROM pg_catalog.pg_prepared_statements WHERE NOT from_sql ORDER BY name COLLATE "C"'
					),
					[]
				)
			],
			{ access: "readOnly", isolation: "serializable", end: "COMMIT" }
		),
		(outcomes) =>
			Arr.map(outcomes[0]?.rows ?? [], (row): readonly [string, string] => [
				row[0] ?? "",
				row[1] ?? ""
			])
	)

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
							served(`INSERT INTO ${table} ("k", "v") VALUES (-7, $1::text) RETURNING "v"`, [
								paramText("one")
							])
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
						const insert = served(
							`INSERT INTO ${table} ("k", "v") VALUES (pg_catalog.nextval('${seq}')::int4, $1::text)`,
							[paramText("doomed")]
						)
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
									const refused =
										refusal === "unique"
											? served(`INSERT INTO ${table} ("k", "v") VALUES (-1, 'again')`, [])
											: served(planned.sql, planned.params)
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

		it.effect(
			"parses each served statement once per session, by pg's record of its names, and parses again what the server refused",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const { s, frame } = yield* fixture()
						const prologue = [frame.prologue.fence, frame.prologue.enter]
						return yield* explore(
							{
								oracle: { kind: "unstated" },
								/**
								 * Each case on a session of its own: none prepared before its first flight; each flight's Parses
								 * exactly the names its connection had not parsed, each once, and a Bind of every statement's
								 * name; the first refusal its own, never a name the server lost (26000); and at the end exactly
								 * the parsed names on the server, each with its text.
								 */
								suite: `pg/adapter/batch-parity/prepared`,
								draw: drawn(preparedCaseGen),
								literal: Formatter.format,
								coverage: required<PreparedFeature>(preparedSituations, {
									cases: 64,
									sense: notesOnly
								}),
								kept: [],
								runs: 12,
								shrink: completeShrink,
								concurrency: 1,
								steerEvery: 16,
								caseHang
							},
							(flights, cx) =>
								Effect.scoped(
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
											assert.equal<string>(failure.failure.sqlstate, model.refused.sqlstate)
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
						)
					}).pipe(Effect.scoped)
				)
		)
	})
}
