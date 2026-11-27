/**
 * Two SERIALIZABLE writers appending to one stored owner's family, every interleaving: a direct writer running the
 * direct-writer protocol for an append to owner 0's counted family (the count read, the count update, the successor of
 * the member before the new slot set to that slot, and the member insert at the slot the count gives, its own slot its
 * successor, then COMMIT), and a grizzle writer applying a ChangeSet that inserts a member of
 * owner 0, run again after each TransientFailure until it answers, as an application runs it. Either append is lawful
 * before or after the other.
 *
 * - **The interleaving model:** a run is allowed exactly when the grizzle write answers accepted, every
 *   TransientFailure it met a SerializationFailure, never a refusal by the family's (group, index) key both writers
 *   drew from their snapshots; the direct writer commits, or fails with 40001 where the grizzle write committed inside
 *   its span; and the state read back holds the families theorem (theorem.ts), owner 0's family holding its first
 *   member and then every committed append in commit order.
 * - **Every interleaving** of the direct writer's five moves and the grizzle write's one (the library's interleave,
 *   `every`, every move on the family's relations, so no two moves commute and every order runs), some of which block
 *   the grizzle write on the owner row the direct writer updated, and run it again once that commits.
 */
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { contendedRig, contentionCase } from "#test/schedules/fin/contention.fixtures.ts"
import { everyInterleaving } from "#test/support/schedules/interleave.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * In every interleaving the grizzle write is accepted, its only refusals serialization failures, and both appends are
 * stored at distinct slots in commit order, on its own clone of the rig, installed once per member, where the search
 * installed it.
 *
 * Its pre-conversion budget: every interleaving (test/schedules/fin/contention.test.ts at 948630c1c).
 */
export const inEveryInterleavingTheGrizzleWriteIsAcceptedAndBothAppendsAreStoredAtDistinctSlotsInCommitOrder =
	property.exhaust(everyInterleaving, {
		needs: { rigged: Substrate.fresh(contendedRig) },
		situations: [],
		check:
			({ rigged }) =>
			() =>
				Effect.scoped(
					Effect.flatMap(rigged, (taken) =>
						Effect.provideService(contentionCase(taken), Substrate, taken.substrate)
					)
				),
		oracle: {
			kind: "specification",
			name: "the interleaving model: the grizzle write accepted after serialization failures alone, the direct writer committing or failing with 40001, and the families theorem over the state read back"
		},
		box: "every interleaving of the direct writer's four moves and the grizzle write's one",
		kept: [],
		kills: []
	})
