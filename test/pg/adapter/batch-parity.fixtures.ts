/** What the properties of batch-parity.test.ts read: the flights' template, a case's session and the models. */

import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Result } from "effect"
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
import { prepared } from "#compiler/core/prepared.ts"

import { assert } from "@bjornpagen/testing/assert"
import { quoteIdent } from "#compiler/core/text.ts"
import type { Param } from "#compiler/core/wire.ts"
import { templateNeedBudget } from "#test/support/budgets.ts"
import { fenceSql, prologueIn } from "#test/support/flight/model.ts"
import { testSql } from "#test/support/sql.ts"
import { fixtureGroup } from "#test/support/substrate/replace.ts"
import {
	installTemplate,
	Substrate,
	type SubstrateCase,
	type SubstrateShape
} from "#test/support/substrate/substrate.ts"
import { tappedSession, type WireWindow } from "#test/support/wire-tap.ts"
import { paramText } from "#test/support/wire.ts"

/**
 * One session whose traffic the tap records, running flights framed as a Db's write: one transaction, its prologue
 * right after BEGIN.
 */
export interface TappedSession {
	readonly batch: (
		statements: ReadonlyArray<BatchStatement>
	) => Effect.Effect<ReadonlyArray<BatchOutcome>, FlightFailure>
	readonly state: () => SessionState
	readonly mark: () => number
	readonly since: (mark: number) => WireWindow
	readonly cancels: () => number
}

/** A flight is one turn of the conversation, and its answer ends with a ReadyForQuery whose status is `status`. */
export const assertOneRoundTrip = (window: WireWindow, status: string): void => {
	assert.equal(window.roundTrips, 1, "one round trip")
	assert.deepEqual(window.backend.at(-1), { type: "Z", status }, "a ReadyForQuery ends the answer")
}

/**
 * A schema of the test's own, its fence installed for the substrate's owner and its table and sequence created, as a
 * template (substrate.ts installTemplate): made once per member, where each search made it before its cases, each case
 * over the worker's seat of it, its table emptied after the case (flightsIn).
 */
export const flightsTemplate = installTemplate({
	budget: templateNeedBudget,
	declaredIn: import.meta,
	name: "wire flights",
	content: { table: "t", sequence: "seq" },
	plan: (names) => Effect.succeed(names.schema),
	install: () =>
		Effect.gen(function* () {
			const s = yield* Substrate
			const raw = yield* s.schema({ create: true, label: "install" })
			const schema = quoteIdent(raw)
			for (const { sql, params } of fenceSql(raw, s.owner.role)) {
				yield* s.admin.query(sql, params)
			}
			yield* s.admin.query(
				`CREATE TABLE ${schema}."t" ("k" int4 PRIMARY KEY, "v" text NOT NULL)`,
				[]
			)
			yield* s.admin.query(`CREATE SEQUENCE ${schema}."seq"`, [])
		}),
	bind: (raw) => raw,
	reset: (raw) => fixtureGroup([`${quoteIdent(raw)}."t"`])
})

/** A case's flights over its seat of the template: the schema's table and sequence, a write's frame and a tapped session. */
export const flightsIn = (taken: SubstrateCase<string>) =>
	Effect.gen(function* () {
		const s = taken.substrate
		const raw = taken.value
		const schema = quoteIdent(raw)
		const frame = writeFrame(prologueIn(raw), "serializable", excludesNothing)
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
export const tapIn = (s: SubstrateShape, frame: Frame) =>
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
export const served = (sql: string, params: ReadonlyArray<Param>): BatchStatement =>
	preparedStatement(prepared(testSql(sql)), params)

/** The rows of one statement in a batch of its own. */
export const readBack = (session: TappedSession, sql: string) =>
	Effect.map(session.batch([served(sql, [])]), (outcomes) => outcomes[0]?.rows)

/** One statement of a flight: rows of a drawn count and tag, an insert, or an update that matches nothing. */
export interface Step {
	readonly kind: "rows" | "insert" | "update"
	readonly count: number
	readonly tag: "a" | "bé" | "c\u{1F600}"
}

export const stepGen: Gen<Step> = (source) => ({
	kind: source.draw(element(["rows", "insert", "update"] as const)),
	count: source.draw(int(0, 4)),
	tag: source.draw(element(["a", "bé", "c\u{1F600}"] as const))
})

/** The protocol steps PostgreSQL refuses a statement at: its Parse, its Bind, its execution, or a constraint. */
export type RefusedAt = "parse" | "bind" | "execute" | "unique"

/** A text PostgreSQL refuses at its Parse, its Bind or its execution, whatever the tables hold. */
const textRefusals = {
	parse: { sql: `SELECT * FROM "no such table"`, params: [] },
	bind: { sql: `SELECT $1::int4::text AS "n"`, params: [paramText("not a number")] },
	execute: { sql: `SELECT (1 / $1::int4)::text AS "n"`, params: [paramText("0")] }
} as const

/** A statement PostgreSQL refuses at each step: a text's, or a key's over the fixture's table, whose -1 is stored. */
export const refusedStatement = (at: RefusedAt, table: string) =>
	at === "unique"
		? { sql: `INSERT INTO ${table} ("k", "v") VALUES (-1, 'again')`, params: [] }
		: textRefusals[at]

/** What PostgreSQL said refusing a statement: its SQLSTATE and the constraint it names. */
export interface Verdict {
	readonly sqlstate: string
	readonly constraint: string | undefined
}

/**
 * PostgreSQL's own verdict on `statement` run alone on the admin connection, the oracle of a flight's refusal: a
 * statement it runs alone is no refusal, and the case dies.
 */
export const verdictAlone = (
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
export const preparedTexts = {
	rows: { sql: `SELECT $1::text AS "a"`, params: [paramText("a")] },
	plain: { sql: `SELECT g::text AS "g" FROM pg_catalog.generate_series(1, 2) AS g`, params: [] },
	execute: textRefusals.execute,
	parse: textRefusals.parse
} as const

export type PreparedKey = keyof typeof preparedTexts

/** The rows each text answers where it runs: the refused ones run in no flight that answers. */
export const preparedRows: { readonly [K in PreparedKey]: ReadonlyArray<ReadonlyArray<string>> } = {
	rows: [["a"]],
	plain: [["1"], ["2"]],
	execute: [],
	parse: []
}

/** A case of the prepared-statement search: the flights one fresh session sends, each its statements' texts. */
export type PreparedCase = ReadonlyArray<ReadonlyArray<PreparedKey>>

export const preparedCaseGen: Gen<PreparedCase> = array(
	array(element(["rows", "plain", "execute", "parse"] as const), { min: 1, max: 5 }),
	{ min: 1, max: 4 }
)

/** What a flight's statements reached: each kind of step, and a statement whose answer has no rows. */
export type RoundTripFeature = `step ${Step["kind"]}` | "a statement answering no rows"

/** Where a refusal was drawn: its protocol step, first in its flight, and with statements after it. */
export type RefusedFeature =
	| `refused at ${RefusedAt}`
	| "the first statement refused"
	| "statements after the refusal"

export type PreparedFeature =
	| "a name bound with no Parse, parsed by an earlier flight"
	| "a name parsed again after its Parse was refused"
	| "one name twice in a flight"
	| "a Parse refused in an aborted transaction"

export const preparedSituations: Arr.NonEmptyReadonlyArray<PreparedFeature> = [
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
export const flightModel = (
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
export const preparedOn = (wire: Session) =>
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

/** Where a flight's statement is refused: at its Parse, its Bind, its Execute, or by the table's key. */
export const refusedAts = ["parse", "bind", "execute", "unique"] as const

/** A refused flight: statements before and after the refused one, and where it is refused. */
export const refusedCases: Gen<{
	readonly before: number
	readonly after: number
	readonly refusal: RefusedAt
}> = (source) => ({
	before: source.draw(int(0, 4)),
	after: source.draw(int(0, 3)),
	refusal: source.draw(element(refusedAts))
})
