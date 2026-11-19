/**
 * G3's fence through the adapter, edullm's production publisher: a publisher's served replace, which deletes the key a
 * READ COMMITTED learner's deferred foreign key checks and inserts it again, beside the learner's served insert of a
 * row referencing that key, each called through a DbLayer of its own and Db.open as the login `server`, exactly as an
 * application calls it.
 *
 * Pub(v, s) holds a field beyond its key, so Seen's key into it is DEFERRABLE INITIALLY DEFERRED, as edullm's
 * learner's keys into its publications are: the learner's check runs inside its COMMIT, taking ROW SHARE on Pub
 * (PostgreSQL 19 ri_triggers.c ri_FastPathCheck), then its snapshot. generate certifies the learner READ COMMITTED on
 * the fence the publisher's login takes (analysis/isolation/certify.ts Fence): migrate grants the login MAINTAIN on
 * Pub, and the publisher's write sends its LOCK TABLE ... IN EXCLUSIVE MODE as the login in its transaction's
 * prologue, between the ledger's fence and `enter` (adapter/wire/batch.ts, step "exclude"). A call through the adapter
 * is one move, so a blocker holds the publisher's transaction open past its lock: an uncommitted Log row at the key
 * the publisher's replace inserts after it replaces Pub, which the blocker ends by its COMMIT or its ROLLBACK.
 *
 * Property: every run of a race, in every order of its moves, is explained by its serial reference
 * (test/support/schedules/serial.ts): the publisher's and the learner's calls, each retried after each TransientFailure
 * until it answers, and the blocker's transaction, run alone from the race's initial state in an order that respects
 * real time, answer and show what they did in the run and leave its state. A learner refused with 23503 at a key that
 * stands before and after the replace is a run no serial order explains, and a call failing otherwise, such as the
 * lock refused 42501, is a refusal of the run.
 *
 * Required features: generate certifies the learner READ COMMITTED; the login holds MAINTAIN on Pub, as migrate
 * granted it; the publisher's call waited on the blocker past its lock; the learner's call waited, as read in pg_locks,
 * for ROW SHARE on a relation the publisher held, its deferred check meeting the fence; and that learner accepted,
 * placed after the replace it waited on.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { type FenceFeature, raceGen, runRace, runs } from "#test/schedules/fence/fence.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * G3's fence through the adapter, a publisher's replace beside a READ COMMITTED learner every race of a fenced replace, its learner and a blocker is serializable, the learner's deferred check waiting on the fence the adapter sends.
 *
 * Its pre-conversion budget: runs runs, coverage cases runs (test/schedules/fence/fence.test.ts at d8eed1786).
 */
export const g3sFenceThroughTheAdapterAPublishersReplaceBesideAREADCOMMITTEDLearnerEveryRaceOfAFencedReplaceItsLearnerAndABlockerIsSerializableTheLearnersDeferredCheckWaitingOnTheFenceTheAdapterSends =
	property.explore(raceGen, {
		needs: { substrate: Substrate.installing },
		situations: [
			"generate certifies the learner READ COMMITTED",
			"the login holds MAINTAIN on Pub, as migrate granted it",
			"the publisher's call waited on the blocker past its lock",
			"the learner's deferred check waited on the publisher's fence",
			"a learner that waited on the fence accepted after the replace"
		] satisfies ReadonlyArray<Reached<FenceFeature>>,
		check:
			({ substrate }, c: Case<FenceFeature>) =>
			(race) =>
				Effect.provideServiceEffect(Effect.scoped(runRace(race, c)), Substrate, substrate),
		oracle: {
			kind: "specification",
			name: "serializability: the calls and the blocker's transaction run alone in a real-time order answer, show and leave what the run did"
		},
		budget: { runs: runs, steered: runs },
		kept: [],
		kills: []
	})
