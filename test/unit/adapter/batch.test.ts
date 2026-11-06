import { describe, it } from "@effect/vitest"
import { type Case, drawn, exhaust, explore } from "@grizzle/testing/explore"
import { noCoverage, type Reached, required, requiredInSpace } from "@grizzle/testing/features"
import { array, element, int } from "@grizzle/testing/gen"
import { exact } from "@grizzle/testing/oracle"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import {
	type BatchStatement,
	type Flight,
	type FlightStatement,
	joinFlights,
	runFramed,
	runTransaction,
	writeFrame
} from "#adapter/wire/batch.ts"
import { serverStatement } from "#adapter/wire/session.ts"
import { indices } from "#compiler/core/array.ts"
import { assert } from "#test/support/assert.ts"
import { type CaseSpace, caseGen, smallCases } from "#test/support/flight/cases.ts"
import type { Timing } from "#test/support/flight/drive.ts"
import {
	type FlightCase,
	type FlightFeature,
	flightPrologue,
	type Framed,
	framedOf,
	framingOf,
	type Interruption,
	interruptionPoint,
	layoutOf,
	type Observation,
	type Planned
} from "#test/support/flight/model.ts"
import { observationsOf, runScripted } from "#test/support/flight/run.ts"
import {
	answeringScript,
	firstCells,
	immediateDelivery,
	refusedAnswer,
	rows,
	scriptedSession
} from "#test/support/flight/scripted.ts"
import { caseHang } from "#test/support/limits.ts"
import { statementSql, testSql } from "#test/support/sql.ts"

/**
 * Flights (packages/grizzle/src/adapter/wire/batch.ts) against their contract, at every interruption point.
 *
 * A case is a call (a read, a write or an EXPLAIN's flight, or statements alone in front of a transaction) and what the
 * server does with each of its statements, on a session that answers as PostgreSQL answers a pipeline
 * (test/support/flight/scripted.ts, itself checked against the server by test/pg/adapter/flight.test.ts). The driver
 * (test/support/flight/drive.ts) makes timing an input: each case runs once uninterrupted and once interrupted after
 * every number of delivered answers, and, where the interruption's CancelRequest stopped a statement, once for every
 * number of the later queries the server runs before the destroyed connection's end reaches it, and each run must
 * observe what the model (test/support/flight/model.ts) predicts
 * from the answers the server made and the client was given: the ending, what committed (all of a transaction or none
 * of it), the retirement, and whether a CancelRequest was sent. The flight's texts must be exactly the frame's.
 *
 * Every case of one statement per part is checked exhaustively; larger cases are drawn, each statement failing in a
 * way the case's swarm allows.
 *
 * Also here: a stale name is StaleName and is parsed afresh, and joined flights hand each part its own outcomes.
 */
const statement = (sql: string): BatchStatement => ({ sql: testSql(sql), params: [] })

/** Each statement's SQL is its label. */
const statementOf = (planned: Planned): BatchStatement => statement(planned.label)

/**
 * The features of the exhaustive population: how calls end, where interruptions land, and the interruptions that meet
 * a refused BEGIN or a refused statement, where the ending must follow the whole transaction's fate. Its cases hold no
 * stuck statement (smallCases), so a statement only the destruction drains is the drawn population's.
 */
const smallRequired: Arr.NonEmptyReadonlyArray<Reached<FlightFeature>> = [
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
	"race cut short",
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

/** The drawn population's: the exhaustive one's, and a stuck statement the interruption's destruction drains. */
const drawnRequired: Arr.NonEmptyReadonlyArray<Reached<FlightFeature>> = [
	...smallRequired,
	"drained by its destruction"
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

/** What one run of a case came to: where the interruption came, and whether the destroyed connection's end cut the
 * server's race past a cancelled statement short (ScriptedSession.cutShort). */
interface Ran {
	readonly interruption: Interruption
	readonly cutShort: boolean
}

/**
 * One run of a case: the model and the run must agree, the flight's texts must be the frame's, the server must end
 * idle with nothing owed. Answers where the interruption came and whether the race was cut short, or undefined for a
 * run that blocked without an interruption.
 *
 * A step of the prologue that fences and enters the Db's role answered with a fault: it fails as a statement position
 * does, and the fence's refusal is StaleSnapshot.
 */
const runOnce = (c: FlightCase, timing: Timing, k: Case<FlightFeature>): Ran | undefined => {
	const run = runScripted(c, timing, statementOf)
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
	const framed = framedOf(c.call, statementOf)
	const sent: ReadonlyArray<ReadonlyArray<Framed>> = Arr.map(session.flights(), (flight) =>
		Arr.map(flight.pipeline, framed)
	)
	assert.deepEqual(sent, framingOf(c.call, statementOf), "the flight's texts")
	assert.equal(session.open(), false, "the server holds no transaction open")
	assert.equal(session.deliverable(), false, "every answer was read")
	const observation = observations.run
	k.note(endingFeature(observation))
	if (observation.retired) {
		k.note("retired")
	}
	if (observation.cancelled) {
		k.note("cancel sent")
	}
	if (session.cutShort()) {
		k.note("race cut short")
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
	const delivered = session.flights()[0]?.delivered ?? []
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
	/** The interruption destroyed the connection: the first query that got no answer is a stuck statement. */
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
	return { interruption: observations.interruption, cutShort: session.cutShort() }
}

/**
 * Every run of a case: uninterrupted, then interrupted after k answers for every k up to the call's completion or the
 * statement it blocks at. Once the call completes first, or blocks before k answers, every later k is the same run.
 * At each k, the server's race past a statement the CancelRequest stopped runs from no query before the destroyed
 * connection's end reaches it up to the first number that runs every query the server would, where the run is no
 * longer cut short: every larger number is the same run.
 */
const checkCase = (c: FlightCase, k: Case<FlightFeature>): void => {
	k.note(`call ${c.call.kind} ${c.call.frame}`)
	if (runOnce(c, { interruptAfter: undefined, afterCancel: 0 }, k) === undefined) {
		k.note("blocked without an interruption")
	}
	for (let after = 0; ; after++) {
		let run = runOnce(c, { interruptAfter: after, afterCancel: 0 }, k)
		for (let afterCancel = 1; run?.cutShort === true; afterCancel++) {
			run = runOnce(c, { interruptAfter: after, afterCancel }, k)
		}
		if (run === undefined) {
			throw new Error("an interrupted run cannot block")
		}
		if (run.interruption.at === undefined || run.interruption.at < after) {
			return
		}
	}
}

/** The unit fuzzer's cases: every way a statement fails, BEGIN refused and COMMIT's connection lost among them. */
const space: CaseSpace = {
	failures: ["refused", "doomed", "hold", "late", "stuck", "nullCell", "fatal", "lose"],
	serverFaults: true
}

describe("a flight", () => {
	it.effect(
		"keeps its contract at every interruption point of every flight of one statement per part",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/adapter/flight-small",
						generator: smallCases,
						literal: Formatter.format,
						limit: 2_000,
						coverage: requiredInSpace<FlightFeature>(smallRequired),
						caseHang
					},
					(flightCase, k) =>
						Effect.sync(() => {
							checkCase(flightCase, k)
						})
				)
			)
	)

	it.effect("keeps its contract at every interruption point of drawn flights", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/adapter/flight",
					draw: drawn(caseGen(space)),
					literal: Formatter.format,
					coverage: required<FlightFeature>(drawnRequired, { cases: 500, sense: notesOnly }),
					kept: [],
					runs: 500,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(flightCase, k) =>
					Effect.sync(() => {
						checkCase(flightCase, k)
					})
			)
		)
	)

	it.effect(
		"reports a stale server statement as StaleName, closes its name, and parses it afresh under it",
		(ctx) =>
			Effect.gen(function* () {
				const whole = { access: "readWrite", end: "COMMIT" } as const
				const server = serverStatement(testSql("a"))
				const named: FlightStatement = { server, params: [] }
				/** Each SQLSTATE PostgreSQL answers a statement whose prepared plan went stale with. */
				const exhausted = yield* searched(
					ctx,
					exhaust(
						{
							suite: "unit/adapter/stale-name",
							generator: element(["0A000", "26000"] as const),
							literal: Formatter.format,
							limit: 2,
							coverage: requiredInSpace<"0A000" | "26000">(["0A000", "26000"]),
							caseHang
						},
						(sqlstate, c) =>
							Effect.gen(function* () {
								c.note(sqlstate)
								let stale = false
								const session = scriptedSession(
									{
										...answeringScript,
										statement: (query) => (stale ? refusedAnswer(sqlstate) : rows([[query.sql]]))
									},
									immediateDelivery
								)
								yield* runTransaction(session, [named], whole)
								assert.deepEqual(session.flights()[0]?.pipeline[1], {
									_tag: "statement",
									sql: testSql("a"),
									params: [],
									name: { _tag: "parsing", name: server.name }
								})
								stale = true
								const failure = yield* Effect.flip(runTransaction(session, [named], whole))
								assert.ok(failure._tag === "StaleName" && failure.index === 0)
								assert.deepEqual(session.flights()[1]?.pipeline[1], {
									_tag: "statement",
									sql: testSql("a"),
									params: [],
									name: { _tag: "parsed", name: server.name }
								})
								assert.equal(session.state(), "open", "a stale name retires nothing")
								stale = false
								yield* runTransaction(session, [named], whole)
								const after = session.flights()[2]
								assert.deepEqual(after?.closes, [server.name])
								assert.deepEqual(after?.pipeline[1], {
									_tag: "statement",
									sql: testSql("a"),
									params: [],
									name: { _tag: "parsing", name: server.name }
								})
							})
					)
				)
				/** A name parsed in the same flight cannot have gone stale: its refusal is the statement's own. */
				const fresh = scriptedSession(
					{ ...answeringScript, statement: () => refusedAnswer("0A000") },
					immediateDelivery
				)
				const freshRefusal = yield* Effect.flip(runTransaction(fresh, [named], whole))
				assert.equal(freshRefusal._tag, "BatchRefused")
				/** A statement no server statement names runs unnamed. */
				const plain = scriptedSession(answeringScript, immediateDelivery)
				yield* runTransaction(plain, [statement("a")], whole)
				assert.deepEqual(plain.flights()[0]?.pipeline[1], {
					_tag: "statement",
					sql: testSql("a"),
					params: [],
					name: { _tag: "unnamed" }
				})
				return exhausted
			})
	)
})

/** A part of a joined flight: `width` statements named for the part, reading their outcomes' first cells. */
const part = (name: string, width: number): Flight<ReadonlyArray<unknown>, never> => ({
	statements: Arr.map(indices(width), (i) => statement(`${name}.${i}`)),
	read: (outcomes) => Effect.succeed(firstCells(outcomes))
})

describe("joined flights", () => {
	it.live(
		"send every part's statements in part order and hand each part exactly its own outcomes",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/adapter/batch-2",
						draw: drawn(array(int(0, 3), { min: 0, max: 5 })),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(widths) =>
						Effect.gen(function* () {
							const session = scriptedSession(answeringScript, immediateDelivery)
							const joined = joinFlights(Arr.map(widths, (width, p) => part(`p${p}`, width)))
							const expected = Arr.map(widths, (width, p) =>
								Arr.map(indices(width), (i) => `p${p}.${i}`)
							)
							assert.deepEqual(Arr.map(joined.statements, statementSql), expected.flat())
							const values = yield* Effect.flatMap(
								runFramed(session, writeFrame(flightPrologue), joined.statements),
								joined.read
							)
							assert.deepEqual(values, expected)
							assert.equal(
								session.flights().length,
								1,
								"one flight, its frame sent with no statement too"
							)
						})
				)
			)
	)
})
