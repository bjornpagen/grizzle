import { localCluster } from "@bjornpagen/testing/pg"

/**
 * The test workers one member of a family serves at once, each running one property's cases at a time (a runner
 * worker). Every cost it divides is the member's own, a cluster's, and grows with the workers that share it: the one
 * checkpointer, which every CREATE DATABASE and DROP DATABASE of the member waits on (a clone per case, and a forced
 * checkpoint per drop), the SSI LWLocks every SERIALIZABLE transaction of the member shares, and the WAL. So it bounds
 * the workers a member serves, and the members' count follows from it (a run's workers over it, rounded up: the
 * testing library's family `spread`), each member's shared buffers from its share, so a family's buffers stay what one
 * cluster sized for every worker would hold. At 1, one server a worker: no worker waits on another's checkpoint or SSI
 * lock.
 *
 * @limitKind measured
 * @owner grizzle's network test tier (pg.config.ts)
 * @unit test workers
 * @scope the network tier's workers one member of a checkout's family serves at once, at a run's width (the testing
 *   library's testWorkers), each family's members' data in memory (~/.config/postgres/memory names grizzle-test-*)
 * @evidence lane RUNPG1's runs, uncommitted in ~/.cache/grizzle-release/RUNPG1/out: run-w1.log, run-w4.log (the first
 *   pair), run2-w1.log, run2-w4.log (the second), run3-w1.log, run3-w4.log, run3-w16.log (the third), each its runner's
 *   summary and `wall_ms`; settle.times and pair12/settle.times (each fresh family's settle, timed by settle-timed.sh);
 *   <family>.samples and pair12/<family>.samples (every member's cgroup memory.current, memory.peak, CPU and /dev/shm
 *   bytes every 10 s, by sample.sh); summarize.sh reads them; and lane PGFAMILY's sweep on disk,
 *   ~/.cache/toolchain/PGFAMILY/packages/testing/out/pgfamily/sweep (report.txt)
 * @observed 2026-11-23 03:21 to 04:21 UTC: the first pair 03:22 to 03:33, the second 03:34 to 03:43, the third
 *   03:48 to 04:21, each pair's or trio's runs at once; PGFAMILY's sweep 02:06 to 02:25 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB, shared with other lanes' runs (1-minute
 *   load 245 at the first pair, 330 at the second, 290 to 450 at the third; 52 to 90 GiB of the account in swap); the
 *   machine's PostgreSQL 19.0 as fresh families of this spec in /dev/shm (fsync off, clones by FILE_COPY), at toolchain
 *   b87bc72c0 (the first two) and RUNPG1's draft on it (the third, whose members log no test's errors); grizzle
 *   f87b2aaab with PGFAMILY's families bump
 * @workload test/pg/laws' 13 files of two properties or more (rule-whole, rule-seeding, projections/source and
 *   mirrors, outcomes/witness, families/alternatives, superkey-orders, rule-tokens, rule-suffix, rule-net-write,
 *   rule-aggregate, lowering, curriculum), 73 properties at 32 workers, TEST_SEED=2219874524: each run at 1 (32
 *   members) and 4 (8 members) at once, the first and third from fresh families, the second on the first's templates;
 *   the third beside a run at 16 (2 members)
 * @result the runner's time for the properties, 1 against 4: 360 s and 350 s; 485 s and 505 s; 543 s and 608 s
 *   (16: 1,196 s), a ratio of 1.03, 0.96 and 0.89, geometric mean 0.96. The members' server CPU over them: 1,763 s
 *   and 1,766 s; 1,420 s and 1,369 s; 1,488 s and 1,501 s (16: 1,685 s). The family's /dev/shm: 9.8 and 7.0 GiB at
 *   the run's end; 14.4 and 9.8 GiB at its peak; 10.4 and 7.3 GiB at its end (16: 4.4 GiB), half of it in swap under
 *   the machine's pressure. A fresh family's settle: 9.3 s and 6.7 s; 11.6 s and 8.8 s (16: 7.4 s). 0 failed in
 *   each. On disk (PGFAMILY, toolchain 5de5e1a1 with clones by WAL_LOG, load 160): 4, 597 s; 8, 790 s; 16, 909 s
 * @decision 1: 4% less time than 4 over the three, its lead growing with the machine's load (none at 245, 11% at
 *   450), the same server CPU, for 40 to 47% more of the family in memory (3 to 4.6 GiB on this subset) and 3 s more
 *   to settle a fresh family; 16 took twice 4's time in memory, as on disk it took 52% more. Below 1 is no family. No
 *   headroom added
 * @revalidate the whole network tier in memory, whose members each hold the templates their worker's properties build
 *   (a family's /dev/shm past this subset's is unmeasured; /dev/shm holds 124 GiB); a family on disk; a family's pages
 *   swapped; a change of the clone strategy or of the predicate room; a PostgreSQL repin; another machine or core count
 */
const workersPerMember = 1

/**
 * The largest database a network worker's files work in, measured: each worker's shared database, which file after
 * file reuses, as autovacuum leaves its catalogs between their schemas. A member's shared_buffers holds this for each
 * worker it serves, every page its share of a run reads at once, and not more: outside recovery PostgreSQL scans every
 * shared buffer at each commit that drops or truncates a relation (REL_19_0 bufmgr.c DropRelationsAllBuffers, whose
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
 * One busy backend's proportional share of memory at the network tier's real work, the denominator of a member's
 * connection capacity (@bjornpagen/testing/pg Capacity): each member admits as many connections as the machine's memory
 * holds of it, shared among the members.
 *
 * @limitKind measured
 * @owner grizzle's network test tier (pg.config.ts)
 * @unit bytes
 * @scope one client backend of a member of the local cluster, at its largest sampled, at the tier's real work
 * @evidence every client backend's /proc/<pid>/smaps_rollup Pss on both members, read by the bootstrap superuser
 *   (pg_read_file) once a second by a transient timer unit (grizzle-grizzlepg-pss<i>, one psql each, the three largest a
 *   reading), beside two runs of the modules below as the unit grizzle-grizzlepg-pg, TEST_SEED 805314508 and 2455893079
 *   (the first run's sampler, a psql \watch, ended 49 s in on a backend exiting mid-read); logs in
 *   ~/.cache/grizzle/grizzlepg-pss<i>{.run1,}.log
 * @observed 2026-11-21 12:43:39 to 12:44:28 UTC (the first run's window) and 12:51:45 to 12:55:53 UTC (the second run,
 *   342 and 337 readings)
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB, shared with other lanes' runs; the
 *   machine's PostgreSQL 19.0 as postgres@grizzle-test-0 and -1, settled by toolchain-pg settle at TOOLCHAIN6's
 *   candidate d2b5f71 with this spec's shared buffers and fixed settings; grizzle's network tier at 12 and 17 workers
 * @workload test/pg/substrate/budget, exit, orphan and forms, test/pg/package/consumer, test/pg/adapter/connection and
 *   connect-classes, test/pg/laws/checks and test/pg/migrate/backfill: 23 properties, 0 failed, each run
 * @result the largest Pss 99,615 kB (102,005,760 bytes), a login's backend running an install's CREATE TABLE in its
 *   clone in the first run; the second run's largest 98,029 kB, an install's ALTER TABLE; every largest reading an
 *   installation's DDL
 * @decision the largest as it is: a reading a second misses a backend's peak between readings, and a backend that touches
 *   more shared buffers or a larger catalog grows past it, which a member meets as a refusal ("too many clients",
 *   53300), measured again, never padded here
 * @revalidate a 53300 refusal in a run; a network tier whose cases install larger schemas; a change of shared_buffers
 *   (workerDatabaseBytes, workersPerMember); a PostgreSQL repin; another machine
 */
const busyBackendBytes = 102_005_760

/**
 * The predicate lock room one network worker's cases take on its member at once, its SIREAD targets as PostgreSQL's
 * table counts them (spec.ts PredicateRoom): what sizes each member's max_pred_locks_per_transaction, the least whose
 * table holds its workers' room, never under PostgreSQL's 10, so a member's table no longer grows with its connections
 * and senders, which every DROP INDEX of the member walks under every SSI LWLock.
 *
 * @limitKind measured
 * @owner grizzle's network test tier (pg.config.ts)
 * @unit predicate lock targets
 * @scope the SIREAD targets one network worker's SERIALIZABLE transactions hold on its member at once, committed ones
 *   PostgreSQL keeps among them, at a run's width
 * @evidence lane PGFAMILY's arms, uncommitted in ~/.cache/toolchain/PGFAMILY/packages/testing/out/pgfamily/arms:
 *   c.dense and d.dense, each member's `select count(*), count(distinct (database, relation, page, tuple)) from pg_locks
 *   where mode = 'SIReadLock'` read once a second by a transient timer unit (dense.sh), beside runs of the subset below
 *   (run-c.log, run-d.log); a.locks, b.locks every 15 s (sample.sh); report.txt; and lane PGFAMILY's proof pair,
 *   ~/.cache/toolchain/PGFAMILY/packages/testing/out/pgfamily/proof (z1.locks, z2.locks every 15 s; report.txt)
 * @observed 2026-11-22 18:11 to 18:41 UTC, the arms' runs, until their members were stopped (PGFAMILY's incident);
 *   2026-11-22 23:19 UTC to 2026-11-23 00:38 UTC, the proof pair's two runs of this spec, each on its own family, whole
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB, load 600 to 640 (five runs of 32 workers
 *   beside trunk and other lanes); the machine's PostgreSQL 19.0 as private families of this spec (2 members of 16
 *   workers, and 1 of 32), max_pred_locks_per_transaction 64 and max_pred_locks_per_relation 1023; grizzle c2e208938
 *   with vendor/toolchain at 2cc481724
 * @workload test/pg/laws' 13 files of two properties or more (rule-whole, rule-seeding, projections/source and
 *   mirrors, outcomes/witness, families/alternatives, superkey-orders, rule-tokens, rule-suffix, rule-net-write,
 *   rule-aggregate, lowering, curriculum), 73 properties at 32 workers, TEST_SEED=2219874524
 * @result peaks: 1,879 SIREAD locks over 265 targets on a member of 16 workers, 1,273 over 256 on the other; 3,081 over
 *   512 on the member of 32; 938 over 335 on a member two runs shared (32 workers). PostgreSQL's table holds two locks a
 *   target, so a member's room is the larger of its targets and half its locks: 940 for 16 workers, 59 a worker; 1,541
 *   for 32, 48 a worker. The proof pair's runs, whole, on families of this spec (2 members of 16 workers, 10 predicate
 *   locks a backend): 1,905 locks over 272 targets at most on a member, 953 a member, 60 a worker. No 53200 in any
 *   run, nor in the workersPerMember sweep's run at 4 workers a member (8 members), nor in lane RUNPG1's six runs at 1
 *   and 4 and one at 16, whose locks were not sampled. Unmeasured: the rest of the network tier, and the peak a worker
 *   at 1 worker a member
 * @decision 60, the largest a worker: at it a member of 1 worker (workersPerMember) needs 60 targets, and holds
 *   PostgreSQL's least, 10 a backend, about 1,900 targets at this machine's 192 backends a member of 32, 32 times its
 *   room. No headroom added: the room moves the setting only past about 1,900 a worker
 * @revalidate a 53200 ("out of shared memory", a predicate lock) in any run; a network tier whose SERIALIZABLE
 *   transactions read more rows or hold them longer; a change of workersPerMember, of the promotion
 *   (max_pred_locks_per_relation) or of busyBackendBytes; a PostgreSQL repin; another machine
 */
const predicateRoomPerWorker = 60

/**
 * The first port a family's members claim from (@bjornpagen/testing/pg family.ts): each member's, the lowest from it
 * that no family claims and nothing listens at, the one way grizzle's client connects (verify-full TLS at localhost,
 * packages/grizzle/src/adapter/types/layer.ts refuses a socket path). Above every fixed port of the clusters made before
 * families (5432 to 5999 on cassowary, 2026-11-22) and below the kernel's ephemeral range (from 32768). A module that
 * names the cluster's port with no member at hand, for a connection no test opens, reads it here (test/support/env.ts
 * clusterPort).
 */
export const clusterNetwork = { kind: "tls", from: 20_000 } as const

/**
 * grizzle's local cluster, which every test, benchmark and script reaches: at each checkout (a lane's workspace,
 * trunk's worktree) a family of its own, the workbench's PostgreSQL units postgres@grizzle-test-<key>-<i>
 * (~/Documents/beefy-workspace/workbench/parts/postgres), each member listening on localhost at a port it claims from
 * clusterNetwork's over verify-full TLS alone, which grizzle's client demands, the server's certificate the
 * workbench's, signed by the CA PGSSLROOTCERT names; owned by grizzle_dev, the migration identity, its template
 * grizzle_template carrying pgvector in vector_ext and pageinspect in pageinspect_ext, whose B-tree metapage a test
 * of a plan's buffers reads an index's height from as the bootstrap superuser; every member preloading
 * pg_stat_statements inert, which a test of what a backend plans turns on in its own clone
 * (test/pg/adapter/second-call.test.ts), the owner setting its three parameters there, and pg_plan_advice, which
 * every session grizzle serves loads (README "Install"), loaded by each session, so a test of a session without it
 * sets session_preload_libraries to PostgreSQL's empty list in its own clone, the owner granted that parameter;
 * throwaway, its members each serving workersPerMember of a run's workers, each member admitting as many connections
 * as the machine's memory holds of busy backends (busyBackendBytes), a replication slot and a WAL sender for each, a
 * live source's leader holding one of each, each worker's largest database in shared buffers, and a predicate lock
 * table of its workers' room (predicateRoomPerWorker). `pnpm pg settle` (toolchain-pg settle, run as a unit) gives
 * the checkout's family this spec; a run only reads it and refuses a member that is not as it states. Nothing admits
 * or queues a run's connections: a member past its capacity refuses one (53300), a problem met, measured and fixed
 * where it happens.
 */
export default localCluster({
	unit: "grizzle-test",
	network: clusterNetwork,
	owner: "grizzle_dev",
	template: "grizzle_template",
	extensions: [
		{ name: "vector", schema: "vector_ext" },
		{ name: "pageinspect", schema: "pageinspect_ext" }
	],
	preload: ["pg_stat_statements", "pg_plan_advice"],
	ownerParameters: [
		"deadlock_timeout",
		"session_replication_role",
		"compute_query_id",
		"pg_stat_statements.track",
		"pg_stat_statements.track_planning",
		"session_preload_libraries"
	],
	durability: "throwaway",
	sizing: {
		kind: "workers",
		family: { kind: "spread", workersPerMember },
		connections: { kind: "capacity", backendBytes: busyBackendBytes },
		replication: { kind: "capacity" },
		sharedBuffers: { kind: "perWorker", bytes: workerDatabaseBytes },
		locks: { kind: "default" },
		predicateLocks: { kind: "perWorker", targets: predicateRoomPerWorker }
	}
})
