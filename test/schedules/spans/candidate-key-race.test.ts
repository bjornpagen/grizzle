/**
 * Races at a span candidate key: an apply of a Booking racing direct writers of Booking, at its span key, its other
 * candidate key and its primary key.
 *
 * Booking(id, room, during, ref) is keyed by id, with the span candidate key (room, during), a UNIQUE ... WITHOUT
 * OVERLAPS that PostgreSQL enforces as an exclusion constraint, and the candidate key ref. The insert protocol probes
 * every key under its snapshot, so a refusal at a key can only come from an occupant that snapshot did not see: the
 * attempt fails as a TransientFailure, and the retry finds the committed fact equal, a repeat, or another at the key,
 * that key's law. An insert of complete facts at SERIALIZABLE arbitrates every object (ON CONFLICT DO NOTHING, no
 * target: write/insert/protocol.ts arbitrationOf), so PostgreSQL 19 refuses an occupant its snapshot cannot see with
 * 40001 (nodeModifyTable.c ExecCheckTIDVisible), a SerializationFailure, and never with a 23P01 or 23505.
 *
 * An exclusion constraint inserts the row's entry before it checks, so a second writer of an overlapping fact waits on
 * the apply's entry while the apply waits on its own, a deadlock: the window one writer opens at a plain candidate key
 * cannot be opened by one here. Two open it: the owner rebuilds ref's key and then the primary key, so PostgreSQL inserts
 * into the span key's index first, then ref's, then the primary key's; a blocker holds an uncommitted fact at the
 * requested ref in another room; a direct writer inserting the requested fact keeps its span entry and waits at that
 * ref on the blocker before it reaches the primary key; and the apply's span entry waits on the writer's.
 *
 * Property: every run of a race, in every order of its moves, is explained by its serial reference
 * (test/support/schedules/serial.ts): the apply (retried after each TransientFailure until it answers), the direct
 * writer's and the blocker's transactions, each run alone from the race's initial state in an order that respects
 * real time, show what they showed in the run (the apply's outcome, each statement's SQLSTATE on its constraint) and
 * leave its state. The races draw the requested fact, an insert or a put of it, an initial fact, the direct writer's
 * fact and the blocker's, each standing to the requested one as a dictionary of what the keys branch on says (the same
 * fact, overlapping it in its room, at its ref, at its id, or apart), and how the blocker ends.
 *
 * The kept races are the windows the races were first planted for: an identical insert, and an identical put,
 * committed by the direct writer while the apply waits at the span key, each a repeat, unchanged; and an overlapping
 * fact committed while the apply waits at the span key, the span key's law.
 *
 * Features: the apply waited, and the apply refused.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type BookingFeature,
	bookingRaceGen,
	runRaces,
	runs,
	raceAims
} from "#test/schedules/spans/candidate-key-race.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Races at a span candidate key, an apply beside direct writers every race of an apply and direct writers at a span candidate key is serializable.
 *
 * Its pre-conversion budget: runs runs, coverage cases runs (test/schedules/spans/candidate-key-race.test.ts at d8eed1786).
 */
export const racesAtASpanCandidateKeyAnApplyBesideDirectWritersEveryRaceOfAnApplyAndDirectWritersAtASpanCandidateKeyIsSerializable =
	property.explore(aimed(bookingRaceGen, raceAims), {
		needs: { substrate: Substrate.installing },
		situations: ["the apply waited", "the apply refused"] satisfies ReadonlyArray<
			Reached<BookingFeature>
		>,
		check:
			({ substrate }, c: Case<BookingFeature>) =>
			(races) =>
				Effect.provideServiceEffect(Effect.scoped(runRaces(races, c)), Substrate, substrate),
		oracle: {
			kind: "specification",
			name: "serializability: the apply and the direct transactions run alone in a real-time order show and leave what the run did"
		},
		budget: { runs: runs, steered: runs },
		kept: [],
		kills: []
	})
