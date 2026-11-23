/**
 * A live read registered while its installation's replication slot cannot be made yet waits for the slot with no work
 * of its own: its source's open checks the slot, finds none, and waits for the `stands` its leader fans out once it
 * holds the slot, then checks once more (adapter/live/listen.ts, adapter/live/leader.ts). Nothing re-checks on its
 * own, so what the read costs while the slot is held up does not grow with how long it is held.
 *
 * A case installs a drawn live world fresh (test/support/live/harness.ts), every session of its layer, the listener's
 * and the leader's among them, through a wire tap; holds a transaction that holds a transaction id, which a logical
 * slot's making waits for (PostgreSQL's snapbuild.c SnapBuildWaitSnapshot); registers the probe read in process or as
 * an HTTP read's once, its watch's first value (test/support/live/standing.ts standingOn); ends the hold once the
 * tap saw the listener's first slot check answered, which so found no slot; and waits for the read to stand.
 *
 * Property: the case's sessions sent three slot checks: the leader's one before it made the slot, and the listener's
 * one before the slot stood and one at its `stands`, however long the slot's making took.
 *
 * Oracle: the specification, the protocol the listener and the leader state, counted on the wire.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	slotWaitCase,
	type SlotWaitFeature,
	slotWaitGen
} from "#test/pg/live/slot-wait.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** A read registered before its slot stands waits for the leader's `stands`, checking the slot once before and once after. */
export const slotWait = property.explore(slotWaitGen, {
	needs: { substrate: Substrate.fresh(baseSubstrate) },
	situations: ["a read in process", "a read over HTTP"] satisfies ReadonlyArray<
		Reached<SlotWaitFeature>
	>,
	check:
		({ substrate }, c: Case<SlotWaitFeature>) =>
		(value) =>
			Effect.provideServiceEffect(
				slotWaitCase(value, c),
				Substrate,
				Effect.map(substrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "specification",
		name: "the listener's and the leader's slot protocol, counted on the wire"
	},
	kept: [],
	kills: [
		{
			file: "packages/grizzle/src/adapter/live/listen.ts",
			original: "\t\t\t\t\t\tyield* Deferred.await(heard)\n",
			replacement: "",
			why: "The open checks the slot again at once while it does not stand, a spin of slot checks for as long as the slot's making is held up, as the callers' calls again on slotAbsent were (EVALCOMPILE's decoder-derivation: 137 s of CPU); this property fails."
		}
	]
})
