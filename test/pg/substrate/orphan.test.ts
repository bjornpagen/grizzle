/**
 * A backend whose client died mid-statement ends by itself, and a logical slot's creation on the cluster then proceeds,
 * against PostgreSQL 19 with the settings every member of a family holds (packages/pg/src/settings.ts clusterSettings).
 *
 * Each case starts a throwaway postmaster of the pinned build in its own directory (Scratch.dir), whose configuration
 * is exactly clusterSettings, as scripts/pg/init.sh writes them into a member, beside the logical WAL a slot needs and a
 * socket directory of its own: a member's settings are fixed when it is made, so only a postmaster made from the
 * declaration answers for a change to it, and scripts/pg/doctor.sh holds every member to the declaration. Each case is
 * a statement that holds a transaction id and never reads from or writes to its client, run by a psql child:
 * computing, sleeping or waiting on a lock another session holds. Once pg_stat_activity shows it running, the child is
 * SIGKILLed, as a test process ended by its hang guard is. The box is the three ways such a statement runs on; the
 * oracle is the client check's own bound, PostgreSQL's client_connection_check_interval: the backend is seen gone from
 * pg_stat_activity within orphanExitBound of the kill (test/support/limits.ts), the one property of the tiers judged by
 * the clock, since what it checks is a time; then CREATE_REPLICATION_SLOT of a logical slot, which waits for every
 * transaction id running as it starts, returns the slot.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Effect } from "effect"
import {
	type Form,
	formNames,
	formSpace,
	orphanCase,
	throwaway
} from "#test/pg/substrate/orphan.fixtures.ts"

/** A killed client's backend lets go of its transaction id, and a logical slot's creation proceeds. */
export const orphanEnds = property.exhaust(finite(formSpace), {
	needs: { scratch: Scratch.dir },
	situations: formNames satisfies ReadonlyArray<Reached<Form>>,
	check:
		({ scratch }, k: Case<Form>) =>
		(form) =>
			Effect.gen(function* () {
				const directory = yield* scratch
				const server = yield* throwaway(directory)
				return yield* Effect.andThen(
					orphanCase(server, form),
					Effect.sync(() => k.note(form))
				)
			}),
	box: "every way a statement that holds a transaction id runs on without its client: computing, sleeping, and waiting on a lock another session holds",
	oracle: {
		kind: "postgresql",
		name: "client_connection_check_interval: a backend whose client is gone ends at its next poll, within the interval of the kill, and a logical slot's creation then proceeds"
	},
	kept: [],
	kills: [
		{
			file: "packages/pg/src/ports.ts",
			original: `\t\t\t\tresume(\n\t\t\t\t\tbound === null || typeof bound === "string"\n\t\t\t\t\t\t? Effect.die(new Error(\`a TCP listener at \${address} reported no port\`))\n\t\t\t\t\t\t: Effect.succeed(bound.port)\n\t\t\t\t)`,
			replacement: "\t\t\t\t{}",
			why: 'Operator mutant (statement) at packages/pg/src/ports.ts:34 in listened: `resume(\n\t\t\t\t\tbound === null || typeof bound === "string"\n\t\t\t\t\t\t? Effect.die(new ` becomes `{}`; the property fails (lane CATCH, grizzle 0baff5d6).'
		},
		{
			file: "packages/pg/src/settings.ts",
			original: '\t["client_connection_check_interval", clientCheckInterval.value],\n',
			replacement: "",
			why: "The cluster declares no client_connection_check_interval (packages/pg/src/settings.ts clusterSettings), so the backend of a client killed mid-statement runs its statement on and keeps its transaction id, and every logical slot's creation on the cluster waits behind it."
		}
	]
})
