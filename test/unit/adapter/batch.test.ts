import { indices } from "@bjornpagen/grizzle-text/base/array"
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { array, finite, int } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { excludesNothing, joinFlights, runFramed, writeFrame } from "#adapter/wire/batch.ts"
import { smallCases } from "#test/support/flight/cases.ts"
import { type FlightFeature, flightPrologue } from "#test/support/flight/model.ts"
import {
	answeringScript,
	immediateDelivery,
	scriptedSession,
	sentSql
} from "#test/support/flight/scripted.ts"
import {
	checkCase,
	drawnFlights,
	drawnRequired,
	type JoinedFeature,
	joinedFeatures,
	part,
	smallRequired
} from "#test/unit/adapter/batch.fixtures.ts"

/** A flight keeps its contract at every interruption point of every flight of one statement per part. */
export const aFlightKeepsItsContractAtEveryInterruptionPointOfEveryFlightOfOneStatementPerPart =
	property.exhaust(finite(smallCases), {
		needs: {},
		situations: smallRequired satisfies ReadonlyArray<Reached<FlightFeature>>,
		check: (_, k: Case<FlightFeature>) => (flightCase) =>
			Effect.sync(() => {
				checkCase(flightCase, k)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the flight model (test/support/flight/model.ts) over the answers made and given"
		},
		box: "every flight of one statement per part, interrupted after every number of delivered answers",
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/wire/batch.ts",
				original: "\t\t\t\t\treturn Effect.as(answeredPast(sent, answered), answeredRound)",
				replacement: "\t\t\t\t\treturn Effect.succeed(unreachedRound)",
				why: "abandon destroys the connection after a CancelRequest that reached the server, so the answers the server made after the request never reach the client; both flight properties fail."
			},
			{
				file: "packages/grizzle/src/adapter/wire/batch.ts",
				original:
					'\t\tcase "answered":\n\t\t\treturn { _tag: "cancelling", answered: answeredIn(sent) }',
				replacement: '\t\tcase "answered":\n\t\t\treturn draining',
				why: "abandon sends one CancelRequest and then only awaits the drain, so a second statement that waits for one, past the one the first request stopped, is never stopped: the interrupted call waits with nothing left to deliver; both flight properties fail."
			},
			{
				file: "packages/grizzle/src/adapter/wire/batch.ts",
				original: "\t\t\t\t\treturn Effect.as(answeredPast(sent, answered), answeredRound)",
				replacement: '\t\t\t\t\treturn Effect.as(Effect.sleep("5 seconds"), answeredRound)',
				why: "abandon paces its rounds by a clock, 5 seconds a round, the connect timeout P5 met, instead of the server's answers: the call waits on a clock nothing advances; both flight properties fail."
			},
			{
				file: "packages/grizzle/src/adapter/wire/batch.ts",
				original: "\t\t\t\tif (Exit.isFailure(waited)) {",
				replacement: "\t\t\t\tif (Exit.isFailure(waited)) {\n\t\t\t\t\tyield* session.cancel",
				why: "A flight whose answers already decided it sends a CancelRequest when an interruption meets it draining; both flight properties fail."
			},
			{
				file: "packages/grizzle/src/adapter/wire/batch.ts",
				original: "\t\t\t\t\t\t\tyield* Deferred.await(ending.success.sent.drained)",
				replacement:
					"\t\t\t\t\t\t\tyield* execute(session, restore, ending.success.sent, ending.success.sent.drained)",
				why: "An alongside call's end, once its first flight decided it, is cancelled when an interruption meets it, as a flight still in flight is; both flight properties fail."
			}
		]
	})

/**
 * A flight keeps its contract at every interruption point of drawn flights.
 *
 * Budget: its suite's count before the conversion (unit/adapter/flight: 500 independent cases and 224 steered, Vitest
 * at grizzle 4ca3036a).
 */
export const aFlightKeepsItsContractAtEveryInterruptionPointOfDrawnFlights = property.explore(
	drawnFlights,
	{
		needs: {},
		situations: drawnRequired satisfies ReadonlyArray<Reached<FlightFeature>>,
		check: (_, k: Case<FlightFeature>) => (flightCase) =>
			Effect.sync(() => {
				checkCase(flightCase, k)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the flight model (test/support/flight/model.ts) over the answers made and given"
		},
		budget: { runs: 500, steered: 224 },
		kept: [
			{
				token: ReplayToken(
					"test/unit/adapter/batch.test.ts#aFlightKeepsItsContractAtEveryInterruptionPointOfDrawnFlights:-:0.1.0.0.0.0.0.0.0.1.5.1.0.2.1.0.0.1.1.0.0"
				),
				reason:
					"an alongside call in a rollback frame whose first flight meets a refused statement and then a lost connection: the refusal decides, and no second flight goes out over the ended session (071f77302 sent the end over it and failed the call as ConnectionLost)",
				since: "2026-11-19"
			}
		],
		kills: [
			{
				file: "packages/grizzle/src/adapter/wire/batch.ts",
				original: "\t\t\t\t\treturn Effect.as(answeredPast(sent, answered), answeredRound)",
				replacement: "\t\t\t\t\treturn Effect.succeed(unreachedRound)",
				why: "abandon destroys the connection after a CancelRequest that reached the server, so the answers the server made after the request never reach the client; both flight properties fail."
			},
			{
				file: "packages/grizzle/src/adapter/wire/batch.ts",
				original:
					'\t\tcase "answered":\n\t\t\treturn { _tag: "cancelling", answered: answeredIn(sent) }',
				replacement: '\t\tcase "answered":\n\t\t\treturn draining',
				why: "abandon sends one CancelRequest and then only awaits the drain, so a second statement that waits for one, past the one the first request stopped, is never stopped: the interrupted call waits with nothing left to deliver; both flight properties fail."
			},
			{
				file: "packages/grizzle/src/adapter/wire/batch.ts",
				original: "\t\t\t\t\treturn Effect.as(answeredPast(sent, answered), answeredRound)",
				replacement: '\t\t\t\t\treturn Effect.as(Effect.sleep("5 seconds"), answeredRound)',
				why: "abandon paces its rounds by a clock, 5 seconds a round, the connect timeout P5 met, instead of the server's answers: the call waits on a clock nothing advances; both flight properties fail."
			},
			{
				file: "packages/grizzle/src/adapter/wire/batch.ts",
				original: "\t\t\t\tif (Exit.isFailure(waited)) {",
				replacement: "\t\t\t\tif (Exit.isFailure(waited)) {\n\t\t\t\t\tyield* session.cancel",
				why: "A flight whose answers already decided it sends a CancelRequest when an interruption meets it draining; both flight properties fail."
			},
			{
				file: "packages/grizzle/src/adapter/wire/batch.ts",
				original: "\t\t\t\t\t\t\tyield* Deferred.await(ending.success.sent.drained)",
				replacement:
					"\t\t\t\t\t\t\tyield* execute(session, restore, ending.success.sent, ending.success.sent.drained)",
				why: "An alongside call's end, once its first flight decided it, is cancelled when an interruption meets it, as a flight still in flight is; both flight properties fail."
			},
			{
				file: "packages/grizzle/src/adapter/wire/batch.ts",
				original: '\t\t\tcase "UnreadableAnswer":',
				replacement: '\t\t\tcase "BatchRefused":\n\t\t\tcase "UnreadableAnswer":',
				why: "A statement's refusal in an alongside call's first flight is read through its second flight, whose lost connection then decides: the kept call fails as ConnectionLost, as 071f77302's did; the drawn flights' property fails."
			},
			{
				file: "packages/grizzle/src/adapter/wire/batch.ts",
				original:
					'\t\t\t\tonSession(session, () => sendPlan(session, [], asLogin, statements, transaction, "closing"))',
				replacement: '\t\t\t\tsendPlan(session, [], asLogin, statements, transaction, "closing")',
				why: "An alongside call's second flight is written over the session its first flight ended: the kept call sends its end over the ended session; the drawn flights' property fails on the flights' texts."
			}
		]
	}
)

/**
 * Joined flights send every part's statements in part order and hand each part exactly its own outcomes.
 *
 * Budget: its suite's count before the conversion (unit/adapter/batch-2: 200 independent cases and 0 steered, Vitest
 * at grizzle 4ca3036a).
 */
export const joinedFlightsSendEveryPartsStatementsInPartOrderAndHandEachPartExactlyItsOwnOutcomes =
	property.explore(array(int(0, 3), { min: 0, max: 5 }), {
		needs: {},
		situations: ["no part", "a part of no statement", "several parts"] satisfies ReadonlyArray<
			Reached<JoinedFeature>
		>,
		check: (_, c: Case<JoinedFeature>) => (widths) =>
			Effect.gen(function* () {
				c.noteAll(joinedFeatures(widths))
				const session = scriptedSession(answeringScript, immediateDelivery)
				const joined = joinFlights(Arr.map(widths, (width, p) => part(`p${p}`, width)))
				const expected = Arr.map(widths, (width, p) => Arr.map(indices(width), (i) => `p${p}.${i}`))
				assert.deepEqual<ReadonlyArray<string>>(
					Arr.map(joined.statements, sentSql),
					expected.flat()
				)
				const values = yield* Effect.flatMap(
					runFramed(
						session,
						writeFrame(flightPrologue, "serializable", excludesNothing),
						joined.statements
					),
					joined.read
				)
				assert.deepEqual(values, expected)
				assert.equal(
					session.flights().length,
					1,
					"one flight, its frame sent with no statement too"
				)
			}),
		oracle: {
			kind: "specification",
			name: "each part's statements in part order, and each part's own outcomes back"
		},
		budget: { runs: 200, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/wire/batch.ts",
				original: "\t\t\t\t\tpart.read(outcomes.slice(from, from + part.statements.length)),",
				replacement:
					"\t\t\t\t\tpart.read(outcomes.slice(from, from + part.statements.length + 1)),",
				why: "A joined part reads the next part's first outcome as its own; the joined flights' property fails."
			}
		]
	})
