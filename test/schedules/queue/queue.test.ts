/**
 * The work queue's races: two workers' claims and settlements, each one SERIALIZABLE ChangeSet, racing while a third
 * session holds a row they contend for.
 *
 * The queue is relations and laws only. A claim is one ChangeSet whose members read the claimable work and the free
 * seats and write the item's Work, Wanted and Leased facts; a settlement is one whose members are all described from
 * the lease (key, epoch) it settles. Each lease occupies one Seat fact, under a candidate key on (resource, seat), and
 * each standing's arm, mirrored with the work of that standing, gives each item one standing. Under contention the
 * laws, not locks the language exposes, keep the queue sound: two claimers of one item or of one seat cannot both take
 * it, and a late settlement of an expired lease and a reclaim of its item cannot both land.
 *
 * Property: every run of a race, in every order of its moves, is explained by its serial reference
 * (test/support/schedules/serial.ts): the two workers' writes (each retried after each TransientFailure until it
 * answers), each run alone from the queue's golden state in an order that respects real time, answer what they
 * answered in the run, and leave its Work, Wanted, Leased and Done facts. A race draws the blocker, the enqueuer
 * holding one item's Work row FOR UPDATE or a worker holding gpu's free seat 3 with an uncommitted lease, each ended by
 * its ROLLBACK, so both writes are in flight together, blocked, and released at once; each worker's write, a claim
 * from a drawn digest and seat or the settlement of kB's expired lease; and the claims' time and lease length.
 *
 * The queue is the shared fixture with its facts (gpu seats 1-3, seat 1 held by kB's lease that expired at 50, seat 2
 * by kF's live lease, seat 3 free; kA and kG wanted and due). The kept races are the windows the races were first
 * planted for: two claimers of kG, two claimers of seat 3, and a late settlement of kB racing its reclaim.
 *
 * Features: a write waited, a write refused.
 *
 * A worker whose snapshot missed a lease the other committed at the seat meets it as 40001, a SerializationFailure it
 * runs again, and never as a unique violation the write lists as an UnseenOccupant abort: a lease is an insert of
 * complete facts at SERIALIZABLE, which arbitrates every object (write/insert/protocol.ts arbitrationOf), so
 * PostgreSQL meets the unseen lease in its ON CONFLICT pre-check (nodeModifyTable.c ExecCheckTIDVisible).
 */

import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type QueueFeature,
	raceGen,
	runRace,
	runs,
	raceAims
} from "#test/schedules/queue/queue.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/**
 * The work queue's races every race of two workers' claims and settlements is serializable.
 *
 * Its pre-conversion budget: runs runs, coverage cases runs (test/schedules/queue/queue.test.ts at d8eed1786).
 */
export const theWorkQueuesRacesEveryRaceOfTwoWorkersClaimsAndSettlementsIsSerializable =
	property.explore(aimed(raceGen, raceAims), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: ["a write waited", "a write refused"] satisfies ReadonlyArray<
			Reached<QueueFeature>
		>,
		check:
			({ substrate }, c: Case<QueueFeature>) =>
			(race) =>
				Effect.provideServiceEffect(
					Effect.scoped(runRace(race, c)),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "serializability: the race's writes run alone in a real-time order answer and leave what the run did"
		},
		budget: { runs: runs, steered: runs },
		kept: [],
		kills: []
	})
