import {
	reservedConnections,
	superuserReservedConnections,
	workerBufferBlocks,
	workerPredicateLocks
} from "@grizzle/limits"
import { memberShare } from "#pg/family.ts"
import { connectionsPerLease, unleasedConnections } from "#pg/lease.ts"

/**
 * A family member's max_connections, which scripts/pg/init.sh sets and scripts/pg/doctor.sh requires at least: a slot
 * for each worker the member serves (family.ts memberShare, a run's workers, testWorkers, one per core, over the family's
 * members), each its lease's connections (connectionsPerLease) and the gate head's race connection but one
 * (leaseSlots), the connections no lease covers (unleasedConnections), and the slots PostgreSQL reserves, at their
 * defaults. leaseSlots over exactly this many connections is memberShare, so a run alone never waits for a lease. The
 * machine's cores are read where the share is, and enter no Limit.
 */
const clusterConnections: number =
	memberShare * (connectionsPerLease + 1) -
	1 +
	unleasedConnections +
	superuserReservedConnections.value +
	reservedConnections.value

/**
 * A family member's shared_buffers in blocks, which scripts/pg/init.sh sets and scripts/pg/doctor.sh requires at
 * least: one worker's database (workerBufferBlocks) for each worker the member serves (family.ts memberShare), every
 * page its share of a run reads held at once. Not more: outside recovery PostgreSQL scans every shared buffer at each commit that
 * drops or truncates a relation (REL_19_RC2 bufmgr.c DropRelationsAllBuffers, whose cached-size path
 * smgrnblocks_cached takes only in recovery, smgr.c#L854), and a test drops its schemas in every release. On a
 * throwaway cluster on cassowary on 2026-11-14, one client's CREATE SCHEMA, three tables and DROP SCHEMA CASCADE took
 * 5.3 ms at 128 MB of shared buffers, 9.4 ms at 4 GB, 19.1 ms at 16 GB and 74.9 ms at a quarter of the machine's
 * memory, the documentation's starting point for a dedicated server. The machine's cores are read here and enter no
 * Limit.
 */
const clusterSharedBuffers: number = memberShare * workerBufferBlocks.value

/**
 * A family member's max_pred_locks_per_transaction, which scripts/pg/init.sh sets and scripts/pg/doctor.sh requires at
 * least. PostgreSQL's predicate-lock table holds it for every connection the cluster admits, and every index drop
 * and table rewrite under a SERIALIZABLE transaction anywhere on the cluster scans that whole table holding every
 * predicate-lock partition (REL_19_RC2 predicate.c DropAllPredicateLocksFromTable), as every read of pg_locks does
 * (GetPredicateLockStatusData). So the table is sized to what the member's share of a run holds, a worker's locks
 * (workerPredicateLocks) for each worker it serves (family.ts memberShare), spread over the connections, never to a number of locks for each connection. On a throwaway cluster
 * on cassowary on 2026-11-14, a CREATE INDEX and DROP INDEX beside an open SERIALIZABLE transaction took 1.6 ms at 100
 * connections and 2048 locks each, 12.0 ms at the machine's sized connections and 2048, and 2.1 ms there at 64; a read
 * of pg_locks 0.9, 22.9 and 2.1 ms. A transaction's locks promote to its page's and relation's as production's do,
 * whatever this is: init.sh pins max_pred_locks_per_relation.
 */
const clusterPredicateLocks: number = Math.ceil(
	(memberShare * workerPredicateLocks.value) / clusterConnections
)

/**
 * The settings that size each member of a family to its share of the machine, by name, each in its own unit:
 * cluster-size.ts prints them, scripts/pg/init.sh writes them into every member, and scripts/pg/doctor.sh requires
 * each at least of every member.
 */
export const clusterSize: ReadonlyArray<readonly [setting: string, value: number]> = [
	["max_connections", clusterConnections],
	["shared_buffers", clusterSharedBuffers],
	["max_pred_locks_per_transaction", clusterPredicateLocks]
]
