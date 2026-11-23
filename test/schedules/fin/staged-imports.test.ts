/**
 * Two imports of unrelated packages whose Entry bytes pass one Bind message (write/program/staged.ts), in overlapping
 * SERIALIZABLE transactions, every interleaving: each is pantry's import shape, a fresh immutable Package with its
 * ordered Entry family of bytes nested in its insert, its rows staged through a carrier under a planted message bound
 * (Session.messageMaxBytes, which both the flight's builder and the cut read), the longest Parse message of the
 * member's statements (test/support/staged.ts textBound), which every entry passes beside two others; each is a call
 * of the served login's `importPackage` member with its package's facts on a served writer of its own. A direct gate
 * inserts the first import's package key and rolls back, so in an interleaving where the gate's insert precedes the
 * first import, that import waits on the key inside its transaction while the second runs and commits, and both
 * transactions overlap.
 *
 * Stored beside them are enough packages, each with one entry, keyed across the uuid range, that the two imports' keys
 * fall on index pages of their own at either end of it, so neither import's reads, made by key, meet the other's
 * writes.
 *
 * - **The model:** both imports answer accepted in every interleaving, neither refused by a serialization failure:
 *   their rows hold no conflict, and each staged statement reads a stored package or entry only through a source driven
 *   by a row it holds or the row its arbitration met (write/probe.ts), which PostgreSQL plans once per driving row,
 *   locking only the index pages and rows it reads, whatever the planner guesses of the carriers, which no write
 *   analyzes (write/program/staged.ts). Some interleaving overlaps them (the first
 *   import waits on the gate's key while the second commits).
 */
import { assert } from "@bjornpagen/testing/assert"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { explored, importsRig } from "#test/schedules/fin/staged-imports.fixtures.ts"
import { everyInterleaving } from "#test/support/schedules/interleave.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Both commit in every interleaving, one waiting on the other's commit in some, on its own clone of the rig,
 * installed once per member, where the search installed it.
 *
 * Its pre-conversion budget: every interleaving (test/schedules/fin/staged-imports.test.ts at 948630c1c).
 */
export const bothCommitInEveryInterleavingOneWaitingOnTheOthersCommitInSome = property.exhaust(
	everyInterleaving,
	{
		needs: { rigged: Substrate.fresh(importsRig) },
		situations: [],
		check:
			({ rigged }) =>
			() =>
				Effect.scoped(
					Effect.flatMap(rigged, (taken) =>
						Effect.provideService(
							Effect.map(explored(taken), (report) =>
								assert.ok(
									report.blocked > 0,
									`of ${report.interleavings} interleavings none had the first import wait on the gate while the second ran`
								)
							),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "both imports answer accepted in every interleaving, neither refused by a serialization failure"
		},
		box: "every interleaving of the gate and the two imports' transactions",
		kept: [],
		kills: []
	}
)
