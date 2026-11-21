/**
 * The settings a refusal of a lock table too small names (adapter/migrate/locks.ts maxLocksPerTransactionFor,
 * maxConnectionsFor): for any server's six settings and any count of locks, the max_locks_per_transaction it states is
 * the least at which the table holds them, the server's other settings kept, and the max_connections it states is the
 * least at which the table holds them at the server's max_locks_per_transaction, never below its own.
 *
 * Oracle: PostgreSQL 19's lock table, max_locks_per_transaction × (max_connections + autovacuum_worker_slots +
 * max_worker_processes + max_wal_senders + 2 + max_prepared_transactions) entries (lock.c NLOCKENTS, postinit.c
 * InitializeMaxBackends at REL_19_0), restated here as its own product.
 *
 * Features: a setting at its stated least and the one below it refused, for each of the two.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Gen, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type LockTableSettings,
	maxConnectionsFor,
	maxLocksPerTransactionFor
} from "#adapter/migrate/locks.ts"

type Feature = "max_locks_per_transaction at its least" | "max_connections at its least"

/** PostgreSQL 19's table restated: the entries a server of these settings holds. */
const entries = (t: LockTableSettings): number =>
	t.maxLocksPerTransaction *
	(t.maxConnections +
		t.autovacuumWorkerSlots +
		t.maxWorkerProcesses +
		t.maxWalSenders +
		2 +
		t.maxPreparedTransactions)

/** A count of locks, and a server's six settings. */
const caseGen: Gen<{ readonly locks: number; readonly table: LockTableSettings }> = (source) => ({
	locks: source.draw(int(1, 200_000)),
	table: {
		maxLocksPerTransaction: source.draw(int(10, 1024)),
		maxConnections: source.draw(int(1, 2000)),
		autovacuumWorkerSlots: source.draw(int(0, 32)),
		maxWorkerProcesses: source.draw(int(0, 64)),
		maxWalSenders: source.draw(int(0, 32)),
		maxPreparedTransactions: source.draw(int(0, 8))
	}
})

/** The settings a lock-table refusal names are the least that hold its locks, the server's others kept. */
export const theSettingsALockTableRefusalNamesAreTheLeastThatHoldItsLocks = property.explore(
	caseGen,
	{
		needs: {},
		situations: [
			"max_locks_per_transaction at its least",
			"max_connections at its least"
		] satisfies ReadonlyArray<Reached<Feature>>,
		budget: { runs: 200, steered: 0 },
		check: (_, c: Case<Feature>) => (x) =>
			Effect.sync(() => {
				const slots = maxLocksPerTransactionFor(x.locks, x.table)
				assert.ok(
					entries({ ...x.table, maxLocksPerTransaction: slots }) >= x.locks,
					`${slots} slots hold ${x.locks} locks`
				)
				assert.ok(
					slots <= 1 || entries({ ...x.table, maxLocksPerTransaction: slots - 1 }) < x.locks,
					`${slots - 1} slots do not hold ${x.locks} locks`
				)
				c.note("max_locks_per_transaction at its least")
				const connections = maxConnectionsFor(x.locks, x.table)
				assert.ok(connections >= x.table.maxConnections, "never below the server's own")
				assert.ok(
					entries({ ...x.table, maxConnections: connections }) >= x.locks,
					`${connections} connections hold ${x.locks} locks`
				)
				if (connections > x.table.maxConnections) {
					assert.ok(
						entries({ ...x.table, maxConnections: connections - 1 }) < x.locks,
						`${connections - 1} connections do not hold ${x.locks} locks`
					)
					c.note("max_connections at its least")
				}
			}),
		oracle: {
			kind: "specification",
			name: "PostgreSQL 19's lock table, max_locks_per_transaction × (MaxBackends + max_prepared_transactions)"
		},
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/migrate/locks.ts",
				original:
					"): number => Math.ceil(locks / lockedBackends({ ...t, maxLocksPerTransaction: 0 }))",
				replacement:
					"): number => Math.floor(locks / lockedBackends({ ...t, maxLocksPerTransaction: 0 }))",
				why: "The stated max_locks_per_transaction rounds down, one slot short of the locks wherever they do not divide."
			},
			{
				file: "packages/grizzle/src/adapter/migrate/locks.ts",
				original:
					"\t\tMath.ceil(locks / t.maxLocksPerTransaction) - (lockedBackends(t) - t.maxConnections)",
				replacement:
					"\t\tMath.ceil(locks / t.maxLocksPerTransaction) - lockedBackends(t) + t.maxConnections - 1",
				why: "The stated max_connections is one short of the least that holds the locks."
			}
		]
	}
)
