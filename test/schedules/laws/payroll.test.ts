/**
 * The payroll example's race at a span primary key: a grizzle insert of a Leave racing a direct writer's Leave for the
 * same employee. The single-law races of the payroll laws (the deposits' amount and count, the approvers' count, the
 * approved shifts' timesheet, ceiling and employment) are the law families' generated races.
 *
 * Reporting installs completely under a fresh schema name with its login, and the facts of the state after onboard,
 * logShifts and draftRun (stateA). The actors are a psql child `h` that has taken on the role `hr` through its login,
 * and the grizzle writer `g`, a Db of `hr` over the worlds rebuilt under the installed name. Leave is keyed by
 * (employee, during), a span primary key, so a Leave the writer inserts in flight at an overlapping span holds the
 * insert's entry until it ends.
 *
 * Property: every run of a race, in every order of its moves, is explained by its serial reference
 * (test/support/schedules/serial.ts): the insert (retried after each TransientFailure until it answers) and the direct
 * writer's transaction, each run alone from stateA in an order that respects real time, show what they showed in the
 * run (the insert's outcome, the writer's SQLSTATE on its constraint) and leave its Leave facts. The races draw ada's
 * requested Leave inside her employment, the writer's Leave standing to it as a dictionary of what the key branches on
 * says (the same Leave, the same span for another reason, an overlapping span, or apart), and how the writer ends.
 *
 * The kept race is the window the race was first planted for: the span key's exact repeat, the insert waiting on an
 * identical Leave in flight, which commits, so the insert's retry finds the repeat, unchanged.
 *
 * Oracle: the serial reference, timing drawn from the case (every order of the race's moves). Features: the insert
 * waited, and the insert refused. Only an interleaving reaches the kept race's abort: Leave's insert lists no in-flight
 * abort, and the Leave in flight, which commits while the insert waits at the span key, fails the insert with 40001
 * (PostgreSQL 19 at SERIALIZABLE), a SerializationFailure the caller runs again; alone, the insert finds the stored
 * Leave instead.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type LeaveFeature,
	raceGen,
	runRace,
	runs,
	leaveAims
} from "#test/schedules/laws/payroll.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The payroll example's races at a span primary key every race of a Leave insert and a direct writer's Leave is serializable.
 *
 * Its pre-conversion budget: runs runs, coverage cases runs (test/schedules/laws/payroll.test.ts at d8eed1786).
 */
export const thePayrollExamplesRacesAtASpanPrimaryKeyEveryRaceOfALeaveInsertAndADirectWritersLeaveIsSerializable =
	property.explore(aimed(raceGen, leaveAims), {
		needs: { substrate: Substrate.fresh },
		situations: ["the insert waited", "the insert refused"] satisfies ReadonlyArray<
			Reached<LeaveFeature>
		>,
		check:
			({ substrate }, c: Case<LeaveFeature>) =>
			(race) =>
				Effect.provideServiceEffect(Effect.scoped(runRace(race, c)), Substrate, substrate),
		oracle: {
			kind: "specification",
			name: "a serial order of the insert and the direct writer's transaction, each run alone from stateA, explains every run"
		},
		budget: { runs: runs, steered: runs },
		kept: [],
		kills: []
	})
