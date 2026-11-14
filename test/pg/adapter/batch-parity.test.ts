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
 *
 * Plants (~/.cache/grizzle-release/BR13/plants): batch-parity-split-flight.patch (a flight's COMMIT sent in a second
 * flight), batch-parity-refused-index.patch (a refusal reported one statement late), batch-parity-reparse.patch (a
 * served statement sent unnamed, parsed on every flight).
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Order, Result } from "effect"
import {
	type BatchOutcome,
	type BatchStatement,
	excludesNothing,
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
		const frame = writeFrame(prologueIn(raw), "serializable", excludesNothing)
		yield* s.admin.query(`CREATE TABLE ${schema}."t" ("k" int4 PRIMARY KEY, "v" text NOT NULL)`, [])
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

/** The protocol steps PostgreSQL refuses a statement at: its Parse, its Bind, its execution, or a constraint. */
type RefusedAt = "parse" | "bind" | "execute" | "unique"

/** A text PostgreSQL refuses at its Parse, its Bind or its execution, whatever the tables hold. */
const textRefusals = {
	parse: { sql: `SELECT * FROM "no such table"`, params: [] },
	bind: { sql: `SELECT $1::int4::text AS "n"`, params: [paramText("not a number")] },
	execute: { sql: `SELECT (1 / $1::int4)::text AS "n"`, params: [paramText("0")] }
} as const

/** A statement PostgreSQL refuses at each step: a text's, or a key's over the fixture's table, whose -1 is stored. */
const refusedStatement = (at: RefusedAt, table: string) =>
	at === "unique"
		? { sql: `INSERT INTO ${table} ("k", "v") VALUES (-1, 'again')`, params: [] }
		: textRefusals[at]

/** What PostgreSQL said refusing a statement: its SQLSTATE and the constraint it names. */
interface Verdict {
	readonly sqlstate: string
	readonly constraint: string | undefined
}

/**
 * PostgreSQL's own verdict on `statement` run alone on the admin connection, the oracle of a flight's refusal: a
 * statement it runs alone is no refusal, and the case dies.
 */
const verdictAlone = (
	s: SubstrateShape,
	statement: { readonly sql: string; readonly params: ReadonlyArray<string> }
): Effect.Effect<Verdict> =>
	Effect.flatMap(Effect.result(s.admin.query(statement.sql, statement.params)), (ran) =>
		Result.isFailure(ran) && ran.failure.reason._tag === "ServerError"
			? Effect.succeed({
					sqlstate: ran.failure.reason.fields.code,
					constraint: ran.failure.reason.fields.constraint
				})
			: Effect.die(new Error(`PostgreSQL ran ${statement.sql} alone without a refusal`))
	)

/**
 * The texts a prepared-statement case's flights draw from, by what PostgreSQL makes of each: one that answers rows,
 * one that answers rows with no parameter, one refused at its execution, and one refused at its Parse.
 */
const preparedTexts = {
	rows: { sql: `SELECT $1::text AS "a"`, params: [paramText("a")] },
	plain: { sql: `SELECT g::text AS "g" FROM pg_catalog.generate_series(1, 2) AS g`, params: [] },
	execute: textRefusals.execute,
	parse: textRefusals.parse
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

/** What a flight's statements reached: each kind of step, and a statement whose answer has no rows. */
type FlightFeature = `step ${Step["kind"]}` | "a statement answering no rows"

/** Where a refusal was drawn: its protocol step, first in its flight, and with statements after it. */
type RefusedFeature =
	| `refused at ${RefusedAt}`
	| "the first statement refused"
	| "statements after the refusal"

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
	let refused: { readonly index: number; readonly at: "parse" | "execute" } | undefined
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
				refused = { index, at: "parse" }
			} else {
				parsed.add(name)
			}
		}
		if (!aborted && key === "execute") {
			aborted = true
			refused = { index, at: "execute" }
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
			{ access: "readOnly", deferrable: false, end: "COMMIT" }
		),
		(outcomes) =>
			Arr.map(outcomes[0]?.rows ?? [], (row): readonly [string, string] => [
				row[0] ?? "",
				row[1] ?? ""
			])
	)

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
					return yield* explore(
						{
							oracle: {
								kind: "second-implementation",
								name: "a model of each statement's answer, and the rows its inserts commit"
							},
							suite: `pg/adapter/batch-parity/one-round-trip`,
							draw: drawn(array(stepGen, { min: 1, max: 10 })),
							literal: Formatter.format,
							coverage: required<FlightFeature>(
								["step rows", "step insert", "step update", "a statement answering no rows"],
								{ cases: 16, sense: notesOnly }
							),
							kept: [],
							runs: 8,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(steps, c) =>
							Effect.gen(function* () {
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
							})
					)
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
					const refusedAts = ["parse", "bind", "execute", "unique"] as const
					const insert = served(
						`INSERT INTO ${table} ("k", "v") VALUES (pg_catalog.nextval('${seq}')::int4, $1::text)`,
						[paramText("doomed")]
					)
					const cases: Gen<{
						readonly before: number
						readonly after: number
						readonly refusal: RefusedAt
					}> = (source) => ({
						before: source.draw(int(0, 4)),
						after: source.draw(int(0, 3)),
						refusal: source.draw(element(refusedAts))
					})
					return yield* explore(
						{
							oracle: {
								kind: "postgresql",
								name: "the refused statement run alone: its SQLSTATE and constraint"
							},
							suite: `pg/adapter/batch-parity/refused`,
							draw: drawn(cases),
							literal: Formatter.format,
							coverage: required<RefusedFeature>(
								[
									...Arr.map(refusedAts, (at): RefusedFeature => `refused at ${at}`),
									"the first statement refused",
									"statements after the refusal"
								],
								{ cases: 24, sense: notesOnly }
							),
							kept: [],
							runs: 10,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						({ before, after, refusal }, c) =>
							Effect.gen(function* () {
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
					const verdicts = {
						parse: yield* verdictAlone(s, preparedTexts.parse),
						execute: yield* verdictAlone(s, preparedTexts.execute)
					}
					return yield* explore(
						{
							oracle: {
								kind: "second-implementation",
								name: "a model of the names pg's connection has parsed, and PostgreSQL's verdict on each refused text alone"
							},
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
					)
				}).pipe(Effect.scoped)
			)
	)
})
