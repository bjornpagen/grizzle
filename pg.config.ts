import { localCluster } from "@bjornpagen/testing/pg"
import { pin } from "#pg/pin.ts"
import { connectionsPerLease, unleasedConnections } from "#test/support/substrate/lease.ts"

/**
 * c*, the test workers one member of the family serves at once, each running one network test file at a time (a Vitest
 * worker) or one property's cases (a runner worker). Every cost it divides is the member's own, a cluster's, and grows
 * with the files that share it: the SSI LWLocks (SerializableFinishedList, SerializableXactHash,
 * SerializablePredicateList) and SxactGlobalXmin, which every SERIALIZABLE transaction of the cluster shares; the safe
 * snapshot a DEFERRABLE read waits for, until every SERIALIZABLE writer of the cluster that began before it has ended;
 * and the one checkpointer, which syncs every file the cluster wrote since its last checkpoint. So it bounds the workers
 * a member serves, and the members' count follows from it (a run's workers over it, rounded up: the testing library's
 * family `spread`), each member's sizes from its share (the sizing below), so a family's total stays what one cluster
 * sized for every worker would hold.
 *
 * @limitKind measured
 * @owner grizzle's network test tier (pg.config.ts)
 * @unit test files
 * @scope the network test files one member of the local cluster family runs at once, each in a Vitest worker of its
 *   own, at a run's width (the testing library's testWorkers, one file per core), on a member sized for its share
 * @evidence packages/experiments/cluster-share at 14b2e2b9 (deleted in the commit after it): two checkouts of grizzle
 *   0b7b5f31 that differ only in this value, each tagged by tag.sh and on a private family scripts/pg/init.sh made from it
 *   (2 members at 32, 4 at 16), run at once by `TEST_SEED=1234567 pair.sh <out> c32 <tree> 5771 c16 <tree> 5781`,
 *   every member's pg_stat_activity sampled each second and its SERIALIZABLE transactions every ten as the bootstrap
 *   superuser, then `compare.sh <out> c32 c16` with the seven files failing for causes outside this value left out;
 *   each member's checkpoint lines from its server log; uncommitted run files in
 *   ~/.cache/grizzle-release/IDLEXACT/measure (c32.out, c16.out, c32.wall, c16.wall, c32.<port>.samples,
 *   c16.<port>.samples, checkpoints.<port>.log, verdict.txt)
 * @observed 2026-11-14 23:08:31 to 2026-11-15 02:06:52 UTC, the two runs at once (16's ended at 01:49:31)
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GB of memory, shared with other lanes' runs
 *   (1-minute load 300 to 455 during the runs); the local PostgreSQL 19rc2 (scripts/pg/pin.env), each member sized by
 *   scripts/pg/init.sh for its share (grizzle's size.ts clusterSize then, the sizing below now: at 32, shared_buffers
 *   1216256 kB and max_connections 2215 a member; at 16, 608128 kB and 1111); grizzle 0b7b5f31 with vendor/toolchain at
 *   its pin, whose testWorkers is availableParallelism(), 64; Node 26.13.1, Vitest 5.1.0
 * @workload the whole network tier, 342 files and 594 tests, at 64 workers, TEST_SEED=1234567: at 32, 2 members of 32
 *   files each; at 16, 4 members of 16; the two runs at once, one run at each value
 * @result Wall time 10701 s at 32 and 9660 s at 16, both set by test/pg/substrate/tree.test.ts, the last file of both,
 *   cut by its hour (10515 s and 9230 s). Over the 311 files both runs passed, leaving out pg/fin/plans,
 *   schedules/install/database-default, pg/serverless/pool, pg/sql/print, pg/migrate/redraft, pg/live/routing and
 *   pg/world-model/inductive: 236111 s summed at 32 and 169681 s at 16, a ratio of 0.72, the per-file ratio's median
 *   0.70 and geometric mean 0.69. Files cut by their hour: 23 at 32, 13 at 16, each of 16's also cut at 32 but
 *   pg/live/exactness; no other failure. SSI LWLock waiters, as a share of the active backends: 8% and 10% of the
 *   members at 32; 1%, 2%, 5% and 1% at 16 (92% on one cluster at be5f3ec4). The oldest SERIALIZABLE transaction: 571
 *   s at 32, 439 s at 16 beside serverless/pool's hung lease (3591 s). Freeze windows (10 s and more with at most two
 *   backends on the CPU and half the active ones waiting on SSI's LWLocks): none at 32; one of 12 s at 16, as the hung
 *   lease's transaction ended. Checkpoints back to back on every member: 1.07 and 1.11 million files synced a member
 *   at 32, 0.59 to 0.92 million at 16, the longest 2267 s and 2296 s. Safe-snapshot waits past 10 s: 5482 samples at
 *   32, 3236 at 16 (2326 of them behind the hung lease). A family's shared memory: 2 x 1454 MB at 32, 4 x 738 MB at
 *   16. No cluster errors
 * @decision 16: at this load every measure favors it over 32: 28% less time over the files both runs passed, the ratio
 *   steady across them (median 0.70), 9.7% less wall time, ten fewer hour cuts, a tenth to a half of 32's SSI waiting
 *   share and less checkpoint sync work a member, for 44 MB more shared memory a family, since each member's memory
 *   follows its share (the sizing below, and `toolchain-pg init --adopt` sizes the members a growing family keeps).
 *   Every coupling it divides is a cluster's own, so the quantity is the files one member runs at once. One run at each
 *   value, at one seed, on a loaded machine; below 16 is unmeasured. No headroom added
 * @revalidate a run at 8, and at 16 again, at a quiet window; a network tier whose files hold more SERIALIZABLE
 *   transactions or hold them longer, or create more databases (the checkpoints' sync work); a change of SSI's
 *   settings (max_pred_locks_*), of the checkpoint settings or of the lease's grant (leaseGrant); a PostgreSQL repin;
 *   another machine or core count
 */
const workersPerMember = 16

/**
 * The connections one worker of a member holds at most: its lease's (lease.ts connectionsPerLease), and the one the
 * lease gate's head races a slot with while every slot is held (substrate/shared.ts takeLease), so the lease slots a
 * member of its share's connections admits (lease.ts leaseSlots) are its share, and a run alone never waits for a
 * lease.
 *
 * @limitKind derived
 * @owner grizzle's network test tier (pg.config.ts)
 * @unit connections
 * @scope the client backends one test worker holds on its member at once: its lease's connections and its race
 *   connection for a slot
 * @derivation leaseSlots admits floor((max_connections − reserved − outside + 1) / (connectionsPerLease + 1)) slots;
 *   at share × (connectionsPerLease + 1) + outside connections past the reserved, that is the share
 * @from {@link connectionsPerLease}
 */
const connectionsPerWorker = connectionsPerLease + 1

/**
 * The installations on the local cluster outside the substrate's databases that serve live reads, each its own live
 * source, slot and walsender: qti-pie's and the dev database's.
 */
const standingInstallations = ["qti_pie", "the dev database"] as const

/**
 * The largest database a network worker's files work in, measured: each worker's shared database, which file after
 * file reuses, as autovacuum leaves its catalogs between their schemas. A member's shared_buffers holds this for each
 * worker it serves, every page its share of a run reads at once, and not more: outside recovery PostgreSQL scans every
 * shared buffer at each commit that drops or truncates a relation (REL_19_RC2 bufmgr.c DropRelationsAllBuffers, whose
 * cached-size path smgrnblocks_cached takes only in recovery, smgr.c#L854), and a test drops its schemas in every
 * release. On a throwaway cluster on cassowary on 2026-11-14, one client's CREATE SCHEMA, three tables and DROP SCHEMA
 * CASCADE took 5.3 ms at 128 MB of shared buffers, 9.4 ms at 4 GB, 19.1 ms at 16 GB and 74.9 ms at a quarter of the
 * machine's memory, the documentation's starting point for a dedicated server.
 *
 * @limitKind measured
 * @owner grizzle's network test tier
 * @unit bytes
 * @scope one network worker's database: its shared database (gz_shared_<n>), or a file's own clone of the template, as
 *   pg_database_size reports it
 * @evidence pg_database_size of every gz_ database on the local cluster: `SELECT datname, pg_database_size(oid) FROM
 *   pg_catalog.pg_database WHERE datname LIKE 'gz\_%'`, as the bootstrap superuser (scripts/pg/ctl.sh admin, at 1623175d;
 *   `pnpm pg admin` reads it now)
 * @observed one reading on 2026-11-14 at 00:44 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, the local PostgreSQL 19rc2 cluster (scripts/pg/pin.env),
 *   grizzle 1623175d
 * @workload every network run on the cluster since its 19rc2 init on 2026-11-13, each worker's files reusing its
 *   shared database, six workers then
 * @result gz_shared_1 to gz_shared_6: 32,981,519, 21,525,319, 22,524,743, 28,169,031, 35,558,215 and 38,916,935 bytes;
 *   the template is 7.7 MB, so a file's own clone starts smaller than any
 * @decision the largest, gz_shared_6: a worker runs one file at a time, and a file works in one database, so this
 *   bounds the pages one worker's file reads. No headroom added: a database past it is unmeasured
 * @revalidate a shared database that grows past it; a PostgreSQL repin; a test tier whose files install larger schemas
 *   or keep more rows; another machine
 */
const workerDatabaseBytes = 38_916_935

/**
 * grizzle's local cluster, which every test, benchmark and script reaches, made and started by the testing library
 * (@bjornpagen/testing/pg) the first time a need or `pnpm pg <command>` (toolchain-pg) reaches it: on port 5442, run by
 * the pinned build (scripts/pg/pin.env, `pnpm pg:build`), owned by grizzle_dev, the migration identity, its template
 * grizzle_template carrying pgvector in vector_ext, throwaway, a family of members each serving workersPerMember of a
 * run's workers, each member sized for its share: a lease's connections and its race connection for each worker and the
 * connections no lease covers; a live source's slot and walsender for each worker's substrate and each standing
 * installation; and each worker's largest database in shared buffers.
 */
export default localCluster({
	port: 5442,
	bin: { kind: "directory", directory: `${pin.GRIZZLE_PG_PREFIX}/bin` },
	owner: "grizzle_dev",
	template: "grizzle_template",
	extensions: [{ name: "vector", schema: "vector_ext" }],
	peerLogins: [],
	durability: "throwaway",
	family: { kind: "spread", workersPerMember },
	sizing: {
		connections: {
			kind: "perWorker",
			perWorker: connectionsPerWorker,
			outside: unleasedConnections
		},
		replication: { kind: "perWorker", perWorker: 1, outside: standingInstallations.length },
		sharedBuffers: { kind: "perWorker", bytes: workerDatabaseBytes }
	}
})
