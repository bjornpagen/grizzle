/**
 * A role generate certifies SERIALIZABLE by its own conditions runs, at that level, as a serial order of its calls, and
 * each shape here is one whose race at READ COMMITTED no serial order explains, so a certificate of READ COMMITTED given
 * by mistake is a real anomaly the race shows, against PostgreSQL 19 (analysis/isolation/certify.ts, docs/errors-and-concurrency.md "READ
 * COMMITTED writes"). Each shape installs as `grizzle generate` drafts and serves it (race.ts shapeTemplate), one role
 * of one login, whose calls race at the level generate certifies it at, each sending the statements its served write
 * sends (race.ts callStatements) after the BEGIN its served writes send (race.ts writeBegin):
 *
 * - the exclusion shape (`absence`, `pivot`): a booking of a room where no block of it is, and a block where no booking
 *   is, each a negation of the other relation at the room. At READ COMMITTED a booking and a block of one room at once
 *   both commit, a write skew on an absence;
 * - the sitting shape (`snapshot`, `absence`, `pivot`), QTI's learner in small: a Sitting started with the count of its
 *   Doc's Pools, then served each Pool of its Doc in a later statement, beside a Pool added to a Doc. At READ COMMITTED
 *   a Pool committed between a start's two statements leaves a Sitting that counts one Pool and is served two, a read
 *   of no one snapshot;
 * - the meeting shape (`pivot` alone): an arrival that records its caller came and that it met its friend where its
 *   friend came already. At READ COMMITTED two callers arriving at once, each awaiting the other, both come and neither
 *   meets the other, a write skew through a row written beside the read that misses the other's.
 *
 * A race is two calls of one shape, each a direct transaction of a session of its own, run in every interleaving
 * through the one concurrency driver (schedules/interleave.ts every) from the stored state, the box exhausted.
 *
 * Oracle: specification, serializability (schedules/serial.ts runSerialRace): the calls a run placed, each run alone on
 * the same installation from the stored state in an order that respects real time, show each statement's answer and
 * leave every relation's rows as the run did; a call PostgreSQL refused with 40001 overlapped the other.
 *
 * The kills certify a shape's role READ COMMITTED by mistake, which serves its READ COMMITTED form and installs no guard
 * on what it writes. No kill leaves out `absence` or `snapshot` alone: neither decides a level by itself (certify.ts
 * absenceReasons, snapshotReasons), so leaving either out moves no role's level and no race tells it; they are the
 * diagnostics generate's report prints, and analysis/isolation/certify.test.ts's oracle holds them. Nor is `form` a
 * judged role's: a role with a member of no READ COMMITTED form holds none to serve at that level (certify.ts Candidate
 * `unformed`), and presence.test.ts kills the decision that a member has none.
 *
 * Features: a booking and a block of one room at once, a Pool added to the Doc a Sitting starts on, two arrivals each
 * awaiting the other, and a call refused by a serialization failure.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	exclusionTemplate,
	meetingTemplate,
	raceFeatures,
	runSkew,
	sittingTemplate,
	type SkewFeature,
	skewRaces
} from "#test/pg/isolation/skew.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A role generate certifies SERIALIZABLE by its own conditions runs every interleaving of two of its calls as a serial order of them, where READ COMMITTED leaves a write skew on an absence, a read of no one snapshot, or a write skew through a row written beside a read. */
export const aRoleGenerateCertifiesSerializableByItsOwnConditionsRunsEveryInterleavingOfTwoOfItsCallsAsASerialOrderOfThemWhereReadCommittedLeavesAnAnomaly =
	property.exhaust(finite(skewRaces), {
		box: "each shape's two calls: the exclusion shape's member of each claim and the second's room, the sitting shape's member of each step and the second's Doc, the meeting shape's caller 3 come or not and each arrival's friend",
		needs: {
			exclusion: Substrate.fresh(exclusionTemplate),
			sitting: Substrate.fresh(sittingTemplate),
			meeting: Substrate.fresh(meetingTemplate)
		},
		situations: [
			"a booking and a block of one room at once",
			"a Pool added to the Doc a Sitting starts on",
			"two arrivals each awaiting the other",
			"a call refused by a serialization failure"
		] satisfies ReadonlyArray<Reached<SkewFeature>>,
		check:
			({ exclusion, sitting, meeting }, c: Case<SkewFeature>) =>
			(race) =>
				Effect.gen(function* () {
					for (const f of raceFeatures(race)) {
						c.note(f)
					}
					const seat =
						race.kind === "exclusion"
							? yield* exclusion
							: race.kind === "sitting"
								? yield* sitting
								: yield* meeting
					yield* Effect.provideService(
						runSkew(seat.value, race, (f) => c.note(f)),
						Substrate,
						seat.substrate
					)
				}),
		oracle: {
			kind: "specification",
			name: "serializability: the race's calls run alone in a real-time order answer and leave what the run did"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/isolation/certify.ts",
				original: "\t\tif (isNonEmpty(r.own)) {\n",
				replacement: "\t\tif (isNonEmpty(r.own) && r.own.length < 0) {\n",
				why: "A judged role's own reasons are ignored: a role SERIALIZABLE by its own conditions alone, none giving it one, is certified READ COMMITTED, so a booking and a block of one room both commit, a Sitting counts one Pool and is served two, and two arrivals each awaiting the other meet no one, which no serial order of the two calls leaves."
			},
			{
				file: "packages/engine/src/analysis/isolation/certify.ts",
				original: "\t\tif (isNonEmpty(r.own)) {\n",
				replacement: '\t\tif (r.own.some((reason) => reason.condition === "form")) {\n',
				why: "Only a `form` reason keeps a judged role SERIALIZABLE, which a judged role never holds: each shape's role is certified READ COMMITTED, and its race leaves what no serial order of its calls does."
			},
			{
				file: "packages/engine/src/analysis/isolation/certify.ts",
				original: "\t...snapshotReasons(view),\n\t...pivotReasons(view)\n]",
				replacement: "\t...snapshotReasons(view)\n]",
				why: "Condition 5b (`pivot`) is left out: the visitor, SERIALIZABLE by it alone, is certified READ COMMITTED, and two callers arriving at once, each awaiting the other, both come and neither meets the other, which no serial order of the two leaves."
			}
		]
	})
