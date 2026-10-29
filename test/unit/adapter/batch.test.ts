import { describe, it } from "@effect/vitest"
import { type Case, drawn, exhaust, explore } from "@grizzle/testing/explore"
import { features, noFeatures, type Reached } from "@grizzle/testing/features"
import { array, element, int } from "@grizzle/testing/gen"
import { exact } from "@grizzle/testing/oracle"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Option } from "effect"
import {
	type BatchStatement,
	type Flight,
	type FlightStatement,
	joinFlights,
	runFramed,
	runTransaction,
	statementSql,
	writeFrame
} from "#adapter/wire/batch.ts"
import { serverStatement } from "#adapter/wire/session.ts"
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
import { indices } from "#test/support/oracle/pick.ts"

/**
 * Flights (packages/grizzle/src/adapter/wire/batch.ts) against their contract, at every interruption point.
 *
 * A case is a call (a read, a write or an EXPLAIN's flight, or statements alone in front of a transaction) and what the
 * server does with each of its statements, on a session that answers as PostgreSQL answers a pipeline
 * (test/support/flight/scripted.ts, itself checked against the server by test/pg/adapter/flight.test.ts). The driver
 * (test/support/flight/drive.ts) makes timing an input: each case runs once uninterrupted and once interrupted after
 * every number of delivered answers, with every number of answers delivered before the cancellation grace expires, and
 * each run must observe what the model (test/support/flight/model.ts) predicts from the answers the server gave: the
 * ending, what committed (all of a transaction or none of it), the retirement, and whether CancelRequests were sent.
 * The flight's texts must be exactly the frame's, and no CancelRequest connection may outlive the flight, the drain
 * deadline firing while a wedged backend leaves one unanswered included.
 *
 * Every case of one statement per part is checked exhaustively; larger cases are drawn, each statement failing in a
 * way the case's swarm allows.
 *
 * Also here: a stale name is StaleName and is parsed afresh, and joined flights hand each part its own outcomes.
 */
const statement = (sql: string): BatchStatement => ({ sql, params: [] })

/** Each statement's SQL is its label. */
const statementOf = (planned: Planned): BatchStatement => statement(planned.label)

/**
 * The features of the exhaustive population: how calls end, where interruptions land, and the interruptions that meet
 * a refused BEGIN or a refused statement, where the ending must follow the whole transaction's fate. Its cases hold no
 * stuck or wedged statement (smallCases), so the drain deadline is the drawn population's.
 */
const smallRequired: ReadonlyArray<Reached<FlightFeature>> = [
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

/** The drawn population's: the exhaustive one's, and the drain deadline, which fires once mid-CancelRequest. */
const drawnRequired: ReadonlyArray<Reached<FlightFeature>> = [
	...smallRequired,
	"drained by the deadline",
	"deadline during a CancelRequest"
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
 * idle with nothing owed, a session not retired healthy, and no CancelRequest connection may be left open. Answers
 * where the interruption came, or undefined for a run that blocked without one.
 *
 * A step of the prologue that fences and enters the Db's role answered with a fault: it fails as a statement position
 * does, and the fence's refusal is StaleSnapshot.
 */
const runOnce = (
	c: FlightCase,
	timing: Timing,
	k: Case<FlightFeature>
): Interruption | undefined => {
	const run = runScripted(c, timing, statementOf)
	const observations = observationsOf(c, run, (sql) => sql)
	if (observations === undefined) {
		return undefined
	}
	const difference = exact(observations.model, observations.run)
	if (Option.isSome(difference)) {
		throw new Error(
			`the run disagrees with the model: ${difference.value}\ntiming ${JSON.stringify(timing)}, interruption ${JSON.stringify(observations.interruption)}`
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
	if (!session.retired()) {
		assert.equal(session.lost(), false, "a session not retired is healthy")
	}
	assert.equal(session.openCancels(), 0, "no CancelRequest connection outlives the flight")
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
	if (session.destroyedDuringCancel()) {
		k.note("deadline during a CancelRequest")
	}
	/**
	 * The drain deadline destroyed the connection: the first query that got no answer is a stuck or wedged statement.
	 */
	const unanswered = Option.flatMap(
		Arr.findFirstIndex(delivered, (d) => d?.answer._tag === "failed"),
		(i) => Arr.get(layout, i)
	)
	if (
		Option.exists(
			unanswered,
			(slot) =>
				(slot.role === "alone" || slot.role === "statement") &&
				(slot.planned.kind === "stuck" || slot.planned.kind === "wedged")
		)
	) {
		k.note("drained by the deadline")
	}
	return observations.interruption
}

/**
 * Every run of a case: uninterrupted, then interrupted after k answers for every k up to the call's completion or the
 * statement it blocks at, each with every number of answers before the grace expires. Once the call completes first,
 * or blocks before k answers, every later k is the same run.
 */
const checkCase = (c: FlightCase, k: Case<FlightFeature>): void => {
	k.note(`call ${c.call.kind} ${c.call.frame}`)
	if (runOnce(c, { interruptAfter: undefined, grace: 0 }, k) === undefined) {
		k.note("blocked without an interruption")
	}
	for (let after = 0; ; after++) {
		let last = false
		for (let grace = 0; ; grace++) {
			const run = runOnce(c, { interruptAfter: after, grace }, k)
			if (run === undefined) {
				throw new Error("an interrupted run cannot block")
			}
			if (run.at === undefined || run.at < after) {
				last = true
			}
			if (run.at === undefined || run.grace < grace) {
				break
			}
		}
		if (last) {
			return
		}
	}
}

/** The unit fuzzer's cases: every way a statement fails, BEGIN refused and COMMIT's connection lost among them. */
const space: CaseSpace = {
	failures: ["refused", "doomed", "hold", "late", "stuck", "wedged", "nullCell", "fatal", "lose"],
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
						features: features<FlightFeature>(smallRequired),
						caseHang: Duration.minutes(2)
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
					features: features<FlightFeature>(drawnRequired),
					kept: [],
					runs: 500,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					steering: { kind: "none" },
					caseHang: Duration.minutes(2)
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
				const server = serverStatement("a")
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
							features: features<"0A000" | "26000">(["0A000", "26000"]),
							caseHang: Duration.minutes(2)
						},
						(sqlstate, c) =>
							Effect.gen(function* () {
								c.note(sqlstate)
								let stale = false
								const session = scriptedSession(
									{
										...answeringScript,
										statement: (query) => (stale ? refusedAnswer(sqlstate) : rows([query.sql]))
									},
									immediateDelivery
								)
								yield* runTransaction(session, [named], whole)
								assert.deepEqual(session.flights()[0]?.pipeline[1], {
									_tag: "statement",
									sql: "a",
									params: [],
									name: { _tag: "parsing", name: server.name }
								})
								stale = true
								const failure = yield* Effect.flip(runTransaction(session, [named], whole))
								assert.ok(failure._tag === "StaleName" && failure.index === 0)
								assert.deepEqual(session.flights()[1]?.pipeline[1], {
									_tag: "statement",
									sql: "a",
									params: [],
									name: { _tag: "parsed", name: server.name }
								})
								assert.equal(session.retired(), false)
								stale = false
								yield* runTransaction(session, [named], whole)
								const after = session.flights()[2]
								assert.deepEqual(after?.closes, [server.name])
								assert.deepEqual(after?.pipeline[1], {
									_tag: "statement",
									sql: "a",
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
				assert.equal(
					(yield* Effect.flip(runTransaction(fresh, [named], whole)))._tag,
					"BatchRefused"
				)
				/** A statement no server statement names runs unnamed. */
				const plain = scriptedSession(answeringScript, immediateDelivery)
				yield* runTransaction(plain, [statement("a")], whole)
				assert.deepEqual(plain.flights()[0]?.pipeline[1], {
					_tag: "statement",
					sql: "a",
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
						features: noFeatures,
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
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
