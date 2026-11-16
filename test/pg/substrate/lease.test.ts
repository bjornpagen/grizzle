/**
 * The substrate's connection lease (test/support/substrate/shared.ts takeLease) admits a waiting holder the moment any
 * slot frees, holders in the order they queued, and holds no transaction id while it leases or waits: the lease every
 * runner worker takes on its member for its life (test/support/runner.ts), and every Vitest file's while they last.
 *
 * A case draws a number of slots and of files that wait for one, and which holder gives its slot up at each step. It
 * leases tables of its own (leaseTables) in the owner's own database of the member its worker reaches, which it creates
 * first as scripts/pg/init.sh creates the cluster's, never the cluster's slots, and connects through the worker's lease
 * budget (substrate.ts Substrate.member). Holders take every slot; the files then queue one after another, each left
 * to settle (every backend it opened waits on a lock, but for the one that holds the gate). At each step a holder ends
 * its lease's transaction, and in that same release its slot must be granted to a backend of the file that queued
 * first. Nothing is judged by time: the slot's holder is read from pg_locks once the release has returned. That file's
 * lease then completes on that slot and it holds it, so a later step may free it again. At every settled point no
 * holder's or waiting file's backend holds a transaction id, and no idle one holds a snapshot. A backend waiting in a
 * lease's LOCK TABLE may hold one, and only that one, as takeLease states. LOCK takes no snapshot (REL_19_RC2 pquery.c
 * PlannedStmtRequiresSnapshot), but its name lookup runs before its wait. When the backend's catalog caches were reset
 * since its NOWAIT try, the lookup reads the catalogs under a catalog snapshot, and nothing releases that snapshot while
 * the backend sleeps on the lock: postgres.c releases it only when the backend goes idle. A reset is any backend's commit
 * of more invalidations than the shared queue holds (sinval.c), such as a DROP SCHEMA of a few hundred tables in any
 * database of the cluster. Reproduced on a private cluster on 2026-11-14 under a loop of such drops: a file queued at
 * the gate, waiting in LOCK TABLE, held xmin 1074 and no transaction id. PostgreSQL offers no wait that takes neither a
 * snapshot nor a name lookup: a fast-path call pushes one (fastpath.c HandleFunctionRequest), and so does any SELECT
 * of pg_advisory_lock.
 *
 * The oracle is the lease's specification: the first file still queued is admitted by each release, on the slot
 * released. A file that waited on one slot of its own would leave another freed slot free while it waits.
 *
 * Features: several slots, files queued behind the first, a released slot other than the first, and a slot released
 * by a file the lease admitted.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	caseGen,
	type LeaseFeature,
	leaseFeatures,
	runCase
} from "#test/pg/substrate/lease.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The connection lease admits the first file queued the moment any slot frees, and holds no transaction id while it
 * leases or waits, nor a snapshot but its wait's name lookup's.
 */
export const admitsTheFirstQueued = property.explore(caseGen, {
	needs: { cluster: Substrate.member },
	situations: leaseFeatures satisfies ReadonlyArray<Reached<LeaseFeature>>,
	check:
		({ cluster }, c: Case<LeaseFeature>) =>
		(x) =>
			Effect.gen(function* () {
				const leased = yield* cluster
				return yield* Effect.scoped(runCase(leased, x, (f) => c.note(f)))
			}),
	oracle: {
		kind: "specification",
		name: "each release admits the first file still queued, on the slot it freed"
	},
	kept: [],
	kills: []
})
