/** What the properties of batch.test.ts read: its spaces, models and helpers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { aimed, map } from "@bjornpagen/testing/gen"
import { exact } from "@bjornpagen/testing/oracle"
import type { Space, Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { type BatchStatement, type Flight, preparedStatement } from "#adapter/wire/batch.ts"
import { prepared } from "#compiler/core/prepared.ts"
import type { EmittedText } from "#compiler/sql/ast.ts"
import { type CaseSpace, caseGen } from "#test/support/flight/cases.ts"
import type { Interruption, Timing } from "#test/support/flight/drive.ts"
import {
	callAnswers,
	type FlightCase,
	type FlightFeature,
	type Framed,
	framedOf,
	framingOf,
	interruptionPoint,
	layoutOf,
	type Observation,
	type Planned,
	type PrologueAnswer
} from "#test/support/flight/model.ts"
import { observationsOf, runScripted } from "#test/support/flight/run.ts"
import { firstCells } from "#test/support/flight/scripted.ts"
import { testSql } from "#test/support/sql.ts"

/**
 * Flights (packages/grizzle/src/adapter/wire/batch.ts) against their contract, at every interruption point.
 *
 * A case is a call (a read, a write or an EXPLAIN's flight, or statements alone in front of a transaction) and what the
 * server does with each of its statements, on a session that answers as PostgreSQL answers a pipeline
 * (test/support/flight/scripted.ts, itself checked against the server by test/pg/adapter/flight.test.ts). The driver
 * (test/support/flight/drive.ts) makes timing an input: each case runs once uninterrupted and once interrupted after
 * every number of delivered answers, with a clock nothing advances, since no flight waits on one, and each run must
 * observe what the model (test/support/flight/model.ts) predicts
 * from the answers the server made and the client was given: the ending, what committed (all of a transaction or none
 * of it), the retirement, and whether a CancelRequest was sent. The flight's texts must be exactly the frame's.
 *
 * Every case of one statement per part is checked exhaustively; larger cases are drawn, each statement failing in a
 * way the case's swarm allows.
 *
 * Also here: joined flights hand each part its own outcomes.
 *
 * Oracles: the flight model, a second implementation of the ending, the commit, the retirement and the CancelRequest
 * from the answers the server made and the client was given; for joined flights, each part's own statements and
 * outcomes.
 *
 * Features: each ending, commit and retirement the model names; for joined flights, no part, a part of no statement,
 * and several parts.
 */
/** A call's statement, a served one as a Db call sends it: its label's text, named. */
const statement = (sql: string): BatchStatement => preparedStatement(prepared(testSql(sql)), [])

/** Each statement's SQL is its label. */
const sqlOf = (planned: Planned): EmittedText => testSql(planned.label)

/**
 * The features of the exhaustive population: how calls end, where interruptions land, and the interruptions that meet
 * a refused BEGIN or a refused statement, where the ending must follow the whole transaction's fate. Its cases hold no
 * stuck statement (smallCases), so a statement only the destruction drains is the drawn population's.
 */
export const smallRequired: Arr.NonEmptyReadonlyArray<Reached<FlightFeature>> = [
	"ending value",
	"ending BatchRefused",
	"ending PrologueRefused",
	"ending StaleSnapshot",
	"ending CommitRefused",
	"ending CommitLost",
	"ending ConnectionLost",
	"ending UnreadableAnswer",
	"ending interrupted",
	"interrupted in flight",
	"interrupted awaiting COMMIT",
	"interrupted draining",
	"cancel sent",
	"retired",
	"blocked without an interruption",
	"committed after an interruption",
	["interrupted draining", "begin refused"],
	["interrupted in flight", "begin refused"],
	["interrupted in flight", "statement refused"],
	"prologue lock refused",
	"prologue lock migrating",
	"prologue lock fatal",
	"prologue lock lost",
	"prologue guard refused",
	"prologue guard migrating",
	"prologue guard migrated",
	"prologue guard fatal",
	"prologue guard lost"
]

/**
 * The drawn population's: the exhaustive one's, a stuck statement on a server no CancelRequest reaches, so abandon
 * severs its connection at the round whose request was unreached, and a change of a role certified READ COMMITTED,
 * whose flight begins at that level.
 */
export const drawnRequired: Arr.NonEmptyReadonlyArray<Reached<FlightFeature>> = [
	...smallRequired,
	"drained by its destruction",
	"call framed readCommittedWrite"
]

const endingFeature = (observation: Observation): FlightFeature => {
	const ending = observation.ending
	switch (ending.kind) {
		case "value":
		case "interrupted":
			return `ending ${ending.kind}`
		case "failure":
			return `ending ${ending.failure.tag}`
	}
}

/**
 * One run of a case: the model and the run must agree, the flight's texts must be the frame's, the server must end
 * idle with nothing owed. Answers where the interruption came, or undefined for a run that blocked without an
 * interruption.
 *
 * A step of the prologue that fences and enters the Db's role answered with a fault: it fails as a statement position
 * does, and the fence's refusal is StaleSnapshot.
 */
const runOnce = (
	c: FlightCase,
	timing: Timing,
	k: Case<FlightFeature>
): Interruption | undefined => {
	const run = runScripted(c, timing, sqlOf)
	const observations = observationsOf(c, run, (sql) => sql)
	if (observations === undefined) {
		return undefined
	}
	const difference = exact(observations.model, observations.run)
	if (Option.isSome(difference)) {
		throw new Error(
			`the run disagrees with the model: ${difference.value}\ntiming ${Formatter.format(timing)}, interruption ${Formatter.format(observations.interruption)}`
		)
	}
	const session = run.session
	const framed = framedOf(c.call, sqlOf)
	const sent: ReadonlyArray<ReadonlyArray<Framed>> = Arr.map(session.flights(), (flight) =>
		Arr.map(flight.pipeline, framed)
	)
	const answers = callAnswers(c.call, session.flights())
	assert.deepEqual(sent, framingOf(c.call, sqlOf, answers.endSent), "the flights' texts")
	assert.equal(session.open(), false, "the server holds no transaction open")
	assert.equal(session.deliverable(), false, "every answer was read")
	/**
	 * An abandoned flight keeps its connection until the server has ended it (batch.ts abandon): every answer the server
	 * made reaches the client, and only a query the server never answered, a stuck statement's and those behind it, can
	 * fail for a destroyed connection.
	 */
	const flights = session.flights()
	for (const [at, flight] of flights.entries()) {
		for (const [index, made] of flight.made.entries()) {
			if (made !== undefined) {
				assert.deepEqual(
					flight.delivered[index]?.answer,
					made,
					`the answer the server made at ${index} of flight ${at} reached the client`
				)
			}
		}
	}
	const observation = observations.run
	k.note(endingFeature(observation))
	if (observation.retired) {
		k.note("retired")
	}
	if (observation.cancelled) {
		k.note("cancel sent")
	}
	const layout = layoutOf(c.call)
	/** BEGIN refused, or a statement of the transaction refused: the fate must read the whole flight, not COMMIT. */
	const beginRefused = c.begin === "refused" && Arr.some(layout, (slot) => slot.role === "begin")
	const statementRefused = Arr.some(
		layout,
		(slot) => slot.role === "statement" && slot.planned.kind === "refused"
	)
	if (beginRefused) {
		k.note("begin refused")
	}
	if (statementRefused) {
		k.note("statement refused")
	}
	for (const slot of layout) {
		if (slot.role === "prologue" && slot.answer !== "answered") {
			k.note(`prologue ${slot.step} ${slot.answer}`)
		}
	}
	const delivered = answers.delivered
	const point = interruptionPoint(c.call, delivered, observations.interruption)
	if (point !== "none") {
		k.note(`interrupted ${point}`)
		if (beginRefused) {
			k.pair(`interrupted ${point}`, "begin refused")
		}
		if (statementRefused) {
			k.pair(`interrupted ${point}`, "statement refused")
		}
		if (observation.committed.length > 0) {
			k.note("committed after an interruption")
		}
	}
	/** abandon severed the connection: the first query that got no answer is a stuck statement. */
	const unanswered = Option.flatMap(
		Arr.findFirstIndex(delivered, (d) => d?.answer._tag === "failed"),
		(i) => Arr.get(layout, i)
	)
	if (
		Option.exists(
			unanswered,
			(slot) =>
				(slot.role === "alone" || slot.role === "statement") && slot.planned.kind === "stuck"
		)
	) {
		k.note("drained by its destruction")
	}
	return observations.interruption
}

/**
 * Every run of a case: uninterrupted, then interrupted after k answers for every k up to the call's completion or the
 * statement it blocks at. Once the call completes first, or blocks before k answers, every later k is the same run.
 */
export const checkCase = (c: FlightCase, k: Case<FlightFeature>): void => {
	k.note(`call ${c.call.kind} ${c.call.frame}`)
	if (runOnce(c, { interruptAfter: undefined }, k) === undefined) {
		k.note("blocked without an interruption")
	}
	for (let after = 0; ; after++) {
		const interruption = runOnce(c, { interruptAfter: after }, k)
		if (interruption === undefined) {
			throw new Error("an interrupted run cannot block")
		}
		if (interruption.at === undefined || interruption.at < after) {
			return
		}
	}
}

/** The unit fuzzer's cases: every way a statement fails, BEGIN refused and COMMIT's connection lost among them. */
const space: CaseSpace = {
	failures: ["refused", "doomed", "hold", "late", "stuck", "nullCell", "fatal", "lose"],
	serverFaults: true
}

/**
 * A drawn case framed, its prologue answering `prologue`: the drawn call's frame and statements in a framed call, so a
 * fault of the prologue, which a drawn case seldom meets, is met at once.
 */
const framedUnder = (prologue: PrologueAnswer): Space<FlightCase> =>
	map(caseGen(space), (c): FlightCase => ({
		...c,
		call: { kind: "framed", frame: c.call.frame, prologue, statements: c.call.statements }
	}))

/** The drawn flights, aimed at each fault of the prologue. */
export const drawnFlights = aimed<FlightCase, FlightFeature>(caseGen(space), [
	["prologue lock refused", framedUnder({ kind: "fault", step: "lock", fault: "refused" })],
	["prologue lock migrating", framedUnder({ kind: "fault", step: "lock", fault: "migrating" })],
	["prologue lock fatal", framedUnder({ kind: "fault", step: "lock", fault: "fatal" })],
	["prologue lock lost", framedUnder({ kind: "fault", step: "lock", fault: "lost" })],
	["prologue guard refused", framedUnder({ kind: "fault", step: "guard", fault: "refused" })],
	["prologue guard migrating", framedUnder({ kind: "fault", step: "guard", fault: "migrating" })],
	["prologue guard migrated", framedUnder({ kind: "fault", step: "guard", fault: "migrated" })],
	["prologue guard fatal", framedUnder({ kind: "fault", step: "guard", fault: "fatal" })],
	["prologue guard lost", framedUnder({ kind: "fault", step: "guard", fault: "lost" })]
])

/** A part of a joined flight: `width` statements named for the part, reading their outcomes' first cells. */
export const part = (name: string, width: number): Flight<ReadonlyArray<unknown>, never> => ({
	statements: Arr.map(indices(width), (i) => statement(`${name}.${i}`)),
	read: (outcomes) => Effect.succeed(firstCells(outcomes))
})

/** What a joined flight's parts are: none, one of no statement among them, or more than one. */
export type JoinedFeature = "no part" | "a part of no statement" | "several parts"

export const joinedFeatures = (widths: ReadonlyArray<number>): ReadonlyArray<JoinedFeature> => [
	...(widths.length === 0 ? (["no part"] as const) : []),
	...(Arr.contains(widths, 0) ? (["a part of no statement"] as const) : []),
	...(widths.length > 1 ? (["several parts"] as const) : [])
]
