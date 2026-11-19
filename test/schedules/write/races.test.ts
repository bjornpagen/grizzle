/**
 * Write races: grizzle ChangeSets and direct SQL writers, all SERIALIZABLE, in orders the one concurrency driver
 * chooses, each run judged by the serial model.
 *
 * Property: every run is serializable as the model means it. Some order of the committed operations, with every
 * refusal at a place among them, respecting real time, explains each outcome, each row count, each refusal's law or
 * SQLSTATE and the committed state; and every abort is 40001, 40P01 or a TransientFailure reason the write's shape
 * allows, beside a concurrent operation.
 *
 * A case installs the schedule schema, opens two grizzle writers on the served login and two direct sessions, and
 * runs one race: a lawful initial state and two or three sessions, each a grizzle writer's one or two ChangeSets (each
 * its own transaction, which the caller calls again after each TransientFailure until it answers, as an application
 * does) or a direct writer's one transaction of one or two statements. A race's ChangeSets are compiled into a served
 * file of the login before it runs, as generate compiles a workload, and each runs as its loaded member over its
 * writer's Db. A race of few moves runs in every order (partial-order reduced); a larger one under a drawn PCT
 * schedule. Which deadlock victim PostgreSQL picks is nature's branch, judged like any run.
 *
 * The races are drawn over small domains, so keys, candidate keys and spans meet, or planted from the
 * dictionary of shapes (PlantedRace): an insert in flight at the key, a deletion before a put of the
 * fact, an anchor replaced by DELETE and INSERT beside a reference to it, a candidate key raced beside the arbiter
 * (UnseenOccupant), a direct writer's deletion and insert beside a concurrent occupant of the key it inserts (a 23505
 * its snapshot cannot explain), two puts of one key, an exact repeat beside a deletion of it, a span put overlapping
 * another key, and an update beside a put in place (each in-place target).
 *
 * The claimer race: two calls of the certified READ COMMITTED `claimer`, each racing Claim and then Seat, both raced
 * (race), each in a statement of its own, under holders apart, the owner holding Gate beside them, in every order. The
 * model meets a raced table's held key and adds nothing there; each call answers on its one try, and its read-backs
 * show each raced table won, its own fact added and nothing met, or met, nothing added and the fact the final state
 * holds at its key met, so a call may win one table and meet the other.
 *
 * Features: each put target the served write runs (its statements' steps) and each pair reason the compile that
 * served it chose (PutChoice), each answer, each TransientFailure reason met, each direct SQLSTATE, waits, deadlocks,
 * nature's branches, a write held between its strata by a blocker, and each planted shape.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Cause, Effect } from "effect"
import {
	type AloneFeature,
	claimerCaseGen,
	type ClaimerFeature,
	inserterAloneGen,
	inserterCaseGen,
	type InserterFeature,
	inserterRuns,
	raceCaseGen,
	RaceFailed,
	type RaceFeature,
	runClaimers,
	runInserterAlone,
	runInserters,
	runRace,
	runs,
	situations
} from "#test/schedules/write/races.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Write races, judged by a serial model ${inserterRuns} cases of certified READ COMMITTED inserters racing at Badge: every run serial, every call answered on its one try, and independent calls never waiting on each other.
 *
 * Its pre-conversion budget: runs inserterRuns, coverage cases inserterRuns (test/schedules/write/races.test.ts at d8eed1786).
 */
export const writeRacesJudgedByASerialModelInserterRunsCasesOfCertifiedREADCOMMITTEDInsertersRacingAtBadgeEveryRunSerialEveryCallAnsweredOnItsOneTryAndIndependentCallsNeverWaitingOnEachOther =
	property.explore(inserterCaseGen, {
		needs: { substrate: Substrate.installing },
		situations: [
			"inserter accepted",
			"inserter refused",
			"inserter witness reported",
			"an inserter waited on the other's insert",
			"an inserter held at its gate",
			"independent inserters ran at once",
			"planted candidate key race",
			"planted independent children"
		] satisfies ReadonlyArray<Reached<InserterFeature>>,
		check:
			({ substrate }, c: Case<InserterFeature>) =>
			(ic) =>
				Effect.provideServiceEffect(
					Effect.scoped(runInserters(ic, c)).pipe(
						Effect.catchCause((cause) =>
							Effect.fail(new RaceFailed({ message: Cause.pretty(cause) }))
						)
					),
					Substrate,
					substrate
				),
		oracle: {
			kind: "second-implementation",
			name: "the serial model (model.ts judgeRun): a real-time serial order of the calls explains every answer and the state, each call answered on its one try"
		},
		budget: { runs: inserterRuns, steered: inserterRuns },
		kept: [],
		kills: []
	})

/**
 * Write races, judged by a serial model ${inserterRuns} cases of certified READ COMMITTED claimers racing at Claim and Seat: every run serial with a raced table's held key met, every call answered on its one try, each raced table won or met as its read-backs show.
 *
 * Its pre-conversion budget: runs inserterRuns, coverage cases inserterRuns (test/schedules/write/races.test.ts at d8eed1786).
 */
export const writeRacesJudgedByASerialModelInserterRunsCasesOfCertifiedREADCOMMITTEDClaimersRacingAtClaimAndSeatEveryRunSerialWithARacedTablesHeldKeyMetEveryCallAnsweredOnItsOneTryEachRacedTableWonOrMetAsItsReadBacksShow =
	property.explore(claimerCaseGen, {
		needs: { substrate: Substrate.installing },
		situations: [
			"claimer accepted",
			"claimer unchanged",
			"a claimer won both raced tables",
			"a claimer met both raced tables",
			"a claimer won one raced table and met the other",
			"a claimer waited on the other's race",
			"a claimer held at its gate",
			"planted won one and met the other",
			"planted both met in flight"
		] satisfies ReadonlyArray<Reached<ClaimerFeature>>,
		check:
			({ substrate }, c: Case<ClaimerFeature>) =>
			(cc) =>
				Effect.provideServiceEffect(
					Effect.scoped(runClaimers(cc, c)).pipe(
						Effect.catchCause((cause) =>
							Effect.fail(new RaceFailed({ message: Cause.pretty(cause) }))
						)
					),
					Substrate,
					substrate
				),
		oracle: {
			kind: "second-implementation",
			name: "the serial model (model.ts judgeRun), raced tables meeting a held key, and each call's read-backs against the final state"
		},
		budget: { runs: inserterRuns, steered: inserterRuns },
		kept: [],
		kills: []
	})

/**
 * Write races, judged by a serial model ${inserterRuns} cases of an inserter call alone: one flight, begun READ COMMITTED as generate certified the role, answered as the serial model says.
 *
 * Its pre-conversion budget: runs inserterRuns, coverage cases inserterRuns (test/schedules/write/races.test.ts at d8eed1786).
 */
export const writeRacesJudgedByASerialModelInserterRunsCasesOfAnInserterCallAloneOneFlightBegunREADCOMMITTEDAsGenerateCertifiedTheRoleAnsweredAsTheSerialModelSays =
	property.explore(inserterAloneGen, {
		needs: { substrate: Substrate.installing },
		situations: ["alone accepted", "alone refused"] satisfies ReadonlyArray<Reached<AloneFeature>>,
		check:
			({ substrate }, c: Case<AloneFeature>) =>
			(ac) =>
				Effect.provideServiceEffect(
					Effect.scoped(runInserterAlone(ac, c)).pipe(
						Effect.catchCause((cause) =>
							Effect.fail(new RaceFailed({ message: Cause.pretty(cause) }))
						)
					),
					Substrate,
					substrate
				),
		oracle: {
			kind: "second-implementation",
			name: "the serial model (model.ts judgeRun) of the one call, and its one flight framed at the certified level"
		},
		budget: { runs: inserterRuns, steered: inserterRuns },
		kept: [],
		kills: []
	})

/**
 * Write races, judged by a serial model ${runs} cases of planted and drawn races: every run is explained by a serial order.
 *
 * Its pre-conversion budget: runs runs, coverage cases runs (test/schedules/write/races.test.ts at d8eed1786).
 */
export const writeRacesJudgedByASerialModelRunsCasesOfPlantedAndDrawnRacesEveryRunIsExplainedByASerialOrder =
	property.explore(raceCaseGen, {
		needs: { substrate: Substrate.installing },
		situations: situations satisfies ReadonlyArray<Reached<RaceFeature>>,
		check:
			({ substrate }, c: Case<RaceFeature>) =>
			(rc) =>
				Effect.provideServiceEffect(
					Effect.scoped(runRace(rc, c)).pipe(
						Effect.catchCause((cause) =>
							Effect.fail(new RaceFailed({ message: Cause.pretty(cause) }))
						)
					),
					Substrate,
					substrate
				),
		oracle: {
			kind: "second-implementation",
			name: "the serial model (model.ts judgeRun): a real-time serial order of the committed operations explains every outcome, refusal and the committed state"
		},
		budget: { runs: runs, steered: runs },
		kept: [],
		kills: []
	})
