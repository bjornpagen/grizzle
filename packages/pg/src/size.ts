import {
	blockSize,
	derived,
	type Limit,
	measured,
	postgresSource,
	published
} from "#compiler/core/limits.ts"
import { connectionsPerLease, unleasedConnections } from "#pg/lease.ts"
import { networkWorkers } from "#pg/workers.ts"

/** PostgreSQL's source of its settings' defaults. */
const settingDefaults = `${postgresSource}/src/backend/utils/misc/guc_parameters.dat`

/** The connections PostgreSQL keeps for superusers alone, at its default, which scripts/pg/init.sh leaves as it is. */
const superuserReservedConnections = published({
	value: 3,
	owner: "PostgreSQL 19rc2",
	unit: "connections",
	scope: "the local cluster's superuser_reserved_connections, out of its max_connections",
	constraint: "configurable default",
	source: `${settingDefaults}#L2941`,
	quote: "boot_val => '3',",
	verified: "2026-11-14"
})

/** The connections PostgreSQL keeps for pg_use_reserved_connections, at its default, which init.sh leaves as it is. */
const reservedConnections = published({
	value: 0,
	owner: "PostgreSQL 19rc2",
	unit: "connections",
	scope: "the local cluster's reserved_connections, out of its max_connections",
	constraint: "configurable default",
	source: `${settingDefaults}#L2552`,
	quote: "boot_val => '0',",
	verified: "2026-11-14"
})

/**
 * The local cluster's max_connections, which scripts/pg/init.sh sets and scripts/pg/doctor.sh requires at least: a
 * slot for each of the run's workers (networkWorkers, one per core), each its lease's connections (connectionsPerLease)
 * and the gate head's race connection but one (leaseSlots), the connections no lease covers (unleasedConnections), and
 * the slots PostgreSQL reserves, at their defaults. leaseSlots over exactly this many connections is networkWorkers,
 * so a run alone never waits for a lease. The machine's cores are read here, where the bound acts, and enter no Limit.
 */
const clusterConnections: number =
	networkWorkers * (connectionsPerLease + 1) -
	1 +
	unleasedConnections +
	superuserReservedConnections.value +
	reservedConnections.value

/**
 * The largest database a network worker's files work in, measured: each worker's shared database, which file after
 * file reuses, as autovacuum leaves its catalogs between their schemas.
 */
const workerDatabaseBytes: Limit = measured({
	value: 38_916_935,
	owner: "grizzle's network test tier",
	unit: "bytes",
	scope:
		"one network worker's database: its shared database (gz_shared_<n>), or a file's own clone of the template, as pg_database_size reports it",
	evidence:
		"pg_database_size of every gz_ database on the local cluster: `SELECT datname, pg_database_size(oid) FROM pg_catalog.pg_database WHERE datname LIKE 'gz\\_%'`, as the bootstrap superuser (scripts/pg/ctl.sh admin)",
	observed: "one reading on 2026-11-14 at 00:44 UTC",
	environment:
		"cassowary, Ubuntu 26.04 on arm64 in AWS, the local PostgreSQL 19rc2 cluster (scripts/pg/pin.env), grizzle 1623175d",
	workload:
		"every network run on the cluster since its 19rc2 init on 2026-11-13, each worker's files reusing its shared database, six workers then",
	result:
		"gz_shared_1 to gz_shared_6: 32,981,519, 21,525,319, 22,524,743, 28,169,031, 35,558,215 and 38,916,935 bytes; the template is 7.7 MB, so a file's own clone starts smaller than any",
	decision:
		"the largest, gz_shared_6: a worker runs one file at a time, and a file works in one database, so this bounds the pages one worker's file reads. No headroom added: a database past it is unmeasured",
	revalidate:
		"a shared database that grows past it; a PostgreSQL repin; a test tier whose files install larger schemas or keep more rows; another machine"
})

/**
 * The pages one network worker's database holds, in PostgreSQL's blocks: its largest database, rounded up to whole
 * blocks.
 */
const workerBufferBlocks: Limit = derived({
	owner: "grizzle's network test tier (scripts/pg/init.sh)",
	unit: "blocks",
	scope:
		"the shared buffers one network worker's database fills, out of the local cluster's shared_buffers",
	from: [workerDatabaseBytes, blockSize],
	derivation:
		"a worker runs one file at a time, and a file works in one database, so the largest such database, in blocks rounded up, holds every page one worker's file reads",
	compute: ([database, block]) => Math.ceil(database.value / block.value)
})

/**
 * The local cluster's shared_buffers in blocks, which scripts/pg/init.sh sets and scripts/pg/doctor.sh requires at
 * least: one worker's database (workerBufferBlocks) for each of the run's workers (networkWorkers, one per core), every
 * page a run reads held at once. Not more: outside recovery PostgreSQL scans every shared buffer at each commit that
 * drops or truncates a relation (REL_19_RC2 bufmgr.c DropRelationsAllBuffers, whose cached-size path
 * smgrnblocks_cached takes only in recovery, smgr.c#L854), and a test drops its schemas in every release. On a
 * throwaway cluster on cassowary on 2026-11-14, one client's CREATE SCHEMA, three tables and DROP SCHEMA CASCADE took
 * 5.3 ms at 128 MB of shared buffers, 9.4 ms at 4 GB, 19.1 ms at 16 GB and 74.9 ms at a quarter of the machine's
 * memory, the documentation's starting point for a dedicated server. The machine's cores are read here and enter no
 * Limit.
 */
const clusterSharedBuffers: number = networkWorkers * workerBufferBlocks.value

/**
 * The predicate locks one network worker's file holds at once, measured: the most any one test database held while
 * every worker ran a file.
 */
const workerPredicateLocks: Limit = measured({
	value: 2038,
	owner: "grizzle's network test tier",
	unit: "predicate locks",
	scope:
		"the SIRead locks one network worker's file holds at once, every transaction of its database's together, as pg_locks lists them",
	evidence:
		"`SELECT max(n), sum(n), count(*) FROM (SELECT database, count(*) AS n FROM pg_catalog.pg_locks WHERE mode = 'SIReadLock' GROUP BY 1) AS x` as the bootstrap superuser, every 3 s, during a full `pnpm -s test:network`",
	observed: "ten readings on 2026-11-14 between 01:28 and 01:29 UTC",
	environment:
		"cassowary, Ubuntu 26.04 on arm64 in AWS, the local PostgreSQL 19rc2 cluster sized by clusterSize with max_pred_locks_per_transaction 2048, grizzle 993326b3; a second full network run and other lanes' files on the cluster at once",
	workload:
		"a full network run at one file per core, every worker's file in its own database, beside another run's files",
	result:
		"at most 2,038 locks in one database, 7,812 in all over 57 databases at once; no 53200 (out of shared memory)",
	decision:
		"the largest one database held. No headroom added: the table holds this many for every worker at once (clusterPredicateLocks), and the measured total over every database is a seventeenth of that",
	revalidate:
		"a 53200 in a network run; a test tier whose transactions read more rows SERIALIZABLE; a change of max_pred_locks_per_relation or max_pred_locks_per_page; a PostgreSQL repin"
})

/**
 * The local cluster's max_pred_locks_per_transaction, which scripts/pg/init.sh sets and scripts/pg/doctor.sh requires
 * at least. PostgreSQL's predicate-lock table holds it for every connection the cluster admits, and every index drop
 * and table rewrite under a SERIALIZABLE transaction anywhere on the cluster scans that whole table holding every
 * predicate-lock partition (REL_19_RC2 predicate.c DropAllPredicateLocksFromTable), as every read of pg_locks does
 * (GetPredicateLockStatusData). So the table is sized to what the run holds, a worker's locks (workerPredicateLocks)
 * for each worker, spread over the connections, never to a number of locks for each connection. On a throwaway cluster
 * on cassowary on 2026-11-14, a CREATE INDEX and DROP INDEX beside an open SERIALIZABLE transaction took 1.6 ms at 100
 * connections and 2048 locks each, 12.0 ms at the machine's sized connections and 2048, and 2.1 ms there at 64; a read
 * of pg_locks 0.9, 22.9 and 2.1 ms. A transaction's locks promote to its page's and relation's as production's do,
 * whatever this is: init.sh pins max_pred_locks_per_relation.
 */
const clusterPredicateLocks: number = Math.ceil(
	(networkWorkers * workerPredicateLocks.value) / clusterConnections
)

/**
 * The settings that size the local cluster to the machine, by name, each in its own unit: cluster-size.ts
 * prints them, scripts/pg/init.sh writes them, and scripts/pg/doctor.sh requires each at least.
 */
export const clusterSize: ReadonlyArray<readonly [setting: string, value: number]> = [
	["max_connections", clusterConnections],
	["shared_buffers", clusterSharedBuffers],
	["max_pred_locks_per_transaction", clusterPredicateLocks]
]
