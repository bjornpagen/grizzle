/**
 * A backend whose client died mid-statement ends by itself, and a logical slot's creation on the cluster then proceeds,
 * against PostgreSQL 19 with the settings every member holds (@bjornpagen/testing/pg's settings.ts fixedSettings).
 *
 * Each case makes a cluster of grizzle's spec of its own (test/support/private-cluster.ts privateCluster), its one
 * member made by the testing library as every member is: a member's settings are fixed when it is made, so only a
 * member made from the declaration answers for a change to it, and the doctor holds every member of the shared cluster
 * to the declaration. Each case is a statement that holds a transaction id and never reads from or writes to its
 * client, run by a psql child: computing, sleeping or waiting on a lock another session holds. Once pg_stat_activity
 * shows it running, the child is SIGKILLed, as a test process ended by its hang guard is. The box is the three ways
 * such a statement runs on; the oracle is the client check's own bound, PostgreSQL's
 * client_connection_check_interval: the backend is seen gone from pg_stat_activity within orphanExitBound of the kill
 * (test/support/limits.ts), the one property of the tiers judged by the clock, since what it checks is a time; then
 * CREATE_REPLICATION_SLOT of a logical slot, which waits for every transaction id running as it starts, returns the
 * slot.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
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
	needs: {},
	situations: formNames satisfies ReadonlyArray<Reached<Form>>,
	check: (_resources, k: Case<Form>) => (form) =>
		Effect.gen(function* () {
			const server = yield* throwaway
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
			file: "vendor/toolchain/packages/testing/src/pg/settings.ts",
			original: `\t["client_connection_check_interval", \`\${clientCheckInterval}\`],\n`,
			replacement: "",
			why: "No member declares client_connection_check_interval (@bjornpagen/testing/pg settings.ts everyMember), so the backend of a client killed mid-statement runs its statement on and keeps its transaction id, and every logical slot's creation on the cluster waits behind it."
		}
	]
})
