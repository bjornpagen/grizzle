/**
 * A live source's replication slot is its database's: two databases holding one installation on one member, two clones
 * of one template, each run a live leader at once, and each leader makes the slot of its own database
 * (core/identity.ts liveSlotOf: the source's stem and the database's digest), where a slot named by the installation
 * alone was one cluster-wide name for both, and the second database's leader met the first's slot, 42710 (TESTRESET4,
 * 2026-11-23, test/pg/net/network.test.ts on clones of the campus template).
 *
 * A case takes two clones of the campus template (test/support/pg/net/network.fixtures.ts), whose login serves live reads;
 * builds the login's served layer over the one it draws first and watches a read there to its first event, which comes
 * once the leader its registration starts has made the slot (adapter/live/listen.ts), then, with that layer still open,
 * does the same over the other.
 *
 * Property: both watches answer, and each database holds exactly one replication slot, the source's in that database.
 *
 * Oracle: the specification, the slot's name as liveSlotOf states it, read from pg_replication_slots.
 */
import { assert } from "@bjornpagen/testing/assert"
import { boolean, finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Layer, Option, Stream } from "effect"
import { Db } from "#adapter/public/db.ts"
import { identifierOf, identity, liveSlotOf } from "#compiler/core/identity.ts"
import { campusAt, campusTemplate } from "#test/support/pg/net/network.fixtures.ts"
import { servedGenerated } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { tokenOf } from "#test/support/worlds.ts"

/** Each database of one installation holds the slot of its own leader, whichever leader starts first. */
export const eachDatabaseOfOneInstallationHoldsTheSlotOfItsOwnLeader = property.exhaust(
	finite(boolean),
	{
		box: "either clone's leader started first, the other's while it runs",
		needs: { first: Substrate.fresh(campusTemplate), second: Substrate.fresh(campusTemplate) },
		situations: [],
		check:
			({ first, second }) =>
			(firstLeads) =>
				Effect.scoped(
					Effect.gen(function* () {
						const clones = [yield* first, yield* second] as const
						const started = firstLeads ? clones : ([clones[1], clones[0]] as const)
						for (const taken of started) {
							const served = servedGenerated(
								taken.value,
								campusAt(taken.value.installed.declared).web
							)
							const context = yield* Layer.build(served.layer)
							yield* Effect.provideContext(
								Effect.gen(function* () {
									const db = yield* Db.open(served.login.roles.campus, {
										token: tokenOf({}),
										attested: {}
									})
									const first = yield* Stream.runHead(
										db.workload.networks.watch({ params: {}, facts: {} })
									)
									assert.ok(Option.isSome(first), "the watch answers its first event")
								}),
								context
							)
						}
						const stem = identifierOf(identity.liveSource(clones[0].value.installed.schema))
						const slots = yield* Effect.forEach(clones, (taken) =>
							taken.substrate.admin.queryValues(
								"SELECT slot_name::text FROM pg_catalog.pg_replication_slots WHERE database = pg_catalog.current_database() ORDER BY 1",
								[]
							)
						)
						assert.deepEqual(
							slots,
							Arr.map(clones, (taken) => [[liveSlotOf(stem, taken.substrate.database)]]),
							"each database holds one slot, the source's in it"
						)
					})
				),
		oracle: {
			kind: "specification",
			name: "the slot's name as liveSlotOf states it, the source's stem and the database's digest, read from pg_replication_slots"
		},
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/pool/live.ts",
				original: "\t\t\t\tconst slot = liveSlotOf(source.stem, parsed.database)\n",
				replacement: "\t\t\t\tconst slot = decoder\n",
				why: "The slot is named by its decoder login alone, as it was: one cluster-wide name for the source in every database, so the second clone's leader meets the first's slot (42710) and its read never answers, or answers over no slot of its own; the property fails."
			}
		]
	}
)
