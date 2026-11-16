/**
 * A case's substrate allocations stopped wherever they stand leave nothing behind: once the stopped allocations are
 * awaited, the case's database (Substrate.fresh) holds nothing a clean one does not (shared.ts leftovers), and no role
 * an allocation set out to create exists on the cluster, the roles of one stopped mid-creation among them.
 *
 * A runner stops a case by interrupting it, at its deadline, and awaits its release (the toolchain's runner/case.ts
 * guarded, whose own property, runner/case.test.ts, holds that every case's cleanup has run when its search returns).
 * What a stop leaves on PostgreSQL is the substrate's: its schemas, roles and sessions are each released by the scope
 * that allocated them, wherever an interruption lands in their allocation. Roles are the cluster's, so a role a stopped
 * case leaves outlives its database's drop.
 *
 * Each case starts allocations at once on its substrate, each a drawn plan of schemas, roles and sessions: one that
 * blocks once its plan stands and up to two beside it that end on their own, each allocation shielded from interruption
 * or not. It stops them all at once, as each first waits or once the blocking one's plan stands, so the stop lands
 * mid-allocation, while holding and after a release, then awaits every one.
 *
 * Oracle: the specification: the blocking allocation ended interrupted, each beside it passed or ended interrupted,
 * and the database and the cluster hold none of what they allocated.
 *
 * Features: each stop once a plan stood, an allocation stopped mid-allocation, a session open as a role at the stop,
 * allocations stopped together, and allocations released before the stop.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	type Seen,
	type StoppedFeature,
	stoodUnder,
	stopped,
	stoppedFeatures,
	stoppingSpace
} from "#test/pg/substrate/stopped.fixtures.ts"
import { assert } from "#test/support/assert.ts"
import { leftovers } from "#test/support/substrate/shared.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A stopped case's allocations leave no schema or role behind once the stop that interrupted them has been awaited. */
export const stoppedReleases = property.explore(stoppingSpace, {
	needs: { substrate: Substrate.fresh },
	/** Its pre-conversion budget: runs 12, coverage cases 40 (stopped.test.ts:223-226 at d55043f1^). */
	budget: { runs: 12, steered: 40 },
	situations: stoppedFeatures satisfies ReadonlyArray<Reached<StoppedFeature>>,
	check:
		({ substrate }, c: Case<StoppedFeature>) =>
		(p) =>
			Effect.gen(function* () {
				const s = yield* substrate
				const seen: Seen = { began: 0, stood: 0, ended: 0, open: 0, roles: [] }
				const ends = yield* stopped(s, p, seen)
				const left = yield* leftovers(s.admin)
				const rolesLeft = yield* Effect.filter(seen.roles, s.roleExists)
				assert.deepEqual(
					{
						blocking: Arr.headNonEmpty(ends),
						besideFailed: Arr.filter(
							Arr.tailNonEmpty(ends),
							(end) => end !== "passed" && end !== "interrupted"
						),
						left,
						rolesLeft
					},
					{ blocking: "interrupted", besideFailed: [], left: [], rolesLeft: [] }
				)
				if (seen.stood > seen.ended) {
					c.note(stoodUnder(p.stop))
				}
				if (seen.began > seen.stood) {
					c.note("stopped while it allocated")
				}
				if (seen.open > 0) {
					c.note("a session open as a role")
				}
				if (seen.began - seen.ended > 1) {
					c.note("allocations stopped together")
				}
				if (seen.ended > 0) {
					c.note("allocations released before the stop")
				}
			}),
	oracle: {
		kind: "specification",
		name: "a clean database (shared.ts leftovers) and none of the allocations' roles on the cluster, once the stopped allocations are awaited"
	},
	kept: [],
	kills: [
		{
			file: "packages/pg/src/family.ts",
			original: "\tif (head !== first.port) {",
			replacement: "\tif (head === first.port) {",
			why: "Operator mutant (comparison) at packages/pg/src/family.ts:93 in parseFamily: `!==` becomes `===`; the property fails (lane CATCH, grizzle 0baff5d6)."
		}
	]
})
