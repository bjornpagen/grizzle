import { type Reached } from "@bjornpagen/testing/features"
import { array, finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { excludesNothing, joinFlights, runFramed, writeFrame } from "#adapter/wire/batch.ts"
import { indices } from "#compiler/core/array.ts"
import { assert } from "#test/support/assert.ts"
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
				original:
					"\t\t\t\treturn Effect.flatMap(round(session, sent), (end) => from(afterRound(state, end)))",
				replacement: "\t\t\t\treturn Effect.andThen(session.cancel, from(severed))",
				why: "abandon destroys the connection after one CancelRequest, so the answers the server made after the request never reach the client; both flight properties fail."
			},
			{
				file: "packages/grizzle/src/adapter/wire/batch.ts",
				original: "\t\t\t\tif (Exit.isFailure(waited)) {",
				replacement: "\t\t\t\tif (Exit.isFailure(waited)) {\n\t\t\t\t\tyield* session.cancel",
				why: "A flight whose answers already decided it sends a CancelRequest when an interruption meets it draining; both flight properties fail."
			}
		]
	})

/** A flight keeps its contract at every interruption point of drawn flights. */
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
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/wire/batch.ts",
				original:
					"\t\t\t\treturn Effect.flatMap(round(session, sent), (end) => from(afterRound(state, end)))",
				replacement: "\t\t\t\treturn Effect.andThen(session.cancel, from(severed))",
				why: "abandon destroys the connection after one CancelRequest, so the answers the server made after the request never reach the client; both flight properties fail."
			},
			{
				file: "packages/grizzle/src/adapter/wire/batch.ts",
				original: "\t\t\t\tif (Exit.isFailure(waited)) {",
				replacement: "\t\t\t\tif (Exit.isFailure(waited)) {\n\t\t\t\t\tyield* session.cancel",
				why: "A flight whose answers already decided it sends a CancelRequest when an interruption meets it draining; both flight properties fail."
			}
		]
	}
)

/** Joined flights send every part's statements in part order and hand each part exactly its own outcomes. */
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
