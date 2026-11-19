import type { Array as Arr } from "effect"

/**
 * How long a backend runs a statement between two polls of its client's socket, PostgreSQL's
 * client_connection_check_interval, which every member holds (clusterSettings). A backend polls only while it runs a
 * statement (the timer start_xact_command arms, REL_19_RC2 src/backend/tcop/postgres.c#L2818), so an idle
 * session is never woken; a poll that finds the socket closed (pq_check_connection, src/backend/libpq/pqcomm.c#L2057)
 * ends the backend with FATAL "connection to client lost" (postgres.c#L3465), and with it the transaction id it holds.
 * Without it PostgreSQL notices a dead client only when it next reads from or writes to the socket, which a statement
 * that never ends never does: a test process ended mid-statement (its hang guard, a SIGKILL, a defect whose SQL never
 * ends) leaves its backend running and holding its transaction id, and every logical slot's creation on the member
 * (CREATE_REPLICATION_SLOT, a live source's) waits for every transaction id running when it starts.
 *
 * @limitKind measured
 * @owner grizzle's local cluster (scripts/pg/init.sh)
 * @unit milliseconds
 * @scope one backend of a family member while it runs a statement: the time between two polls of its client's socket,
 *   and so the longest it outlives its client's death before its next poll
 * @evidence one psql session's \timing (psql -X -At -f) on the postmaster below: `SET client_connection_check_interval
 *   = 0` and `= 1000` in turn, each followed by `WITH RECURSIVE r(i) AS (SELECT 1::int8 UNION ALL SELECT i + 1 FROM r
 *   WHERE i < 20000000) SELECT count(*) FROM r`, eight times each after one warm run; its output kept at
 *   ~/.cache/grizzle-release/ORPHAN/out/cost.txt on cassowary
 * @observed 2026-11-15 14:14:02 to 14:15:40 UTC, one run
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores, load average 16 to 22 from other sessions; a
 *   throwaway postmaster of the pinned PostgreSQL 19rc2 build (scripts/pg/pin.env, its three patches, none touching
 *   postgres.c or pqcomm.c) at initdb's defaults, no other session on it; grizzle 17b28413
 * @workload one backend running a CPU-bound statement of 20,000,000 recursive steps, about 5.7 s, which polls five
 *   times a run at 1,000 ms and never at 0, the two in alternation
 * @result at 0: median 5,762.8 ms, 5,751.8 to 6,018.1; at 1,000: median 5,754.7 ms, 5,727.0 to 5,811.3. The polls'
 *   cost is below the runs' own spread. Beside it, backends of SIGKILLed psql clients, each holding a transaction id
 *   and computing, in pg_sleep or waiting on an advisory lock, left pg_stat_activity 1,000 to 1,017 ms after the kill
 *   at 1,000, each with FATAL connection to client lost; the incident's orphans at 0 ran 44 minutes to 5.7 hours
 * @decision 1,000 ms: its polls cost nothing measurable on a statement of seconds, and an orphan then holds its
 *   transaction id at most about a second past its client's death, against hours without. No shorter value is
 *   measured: the polls' cost grows as one over the interval, and a slot creation waiting a second behind an orphan
 *   waits far less than any test's own hang limit
 * @revalidate a PostgreSQL repin; a poll's cost measured above the runs' spread; a test that waits behind an orphan
 *   for less than the interval; another machine
 */
export const clientCheckInterval = 1000

/**
 * The predicate locks PostgreSQL's table holds for each connection slot, max_pred_locks_per_transaction, which every
 * member holds as production does: the README requires it ("Set max_pred_locks_per_transaction = 2048"), so a test meets
 * the table an application's cluster has, and max_pred_locks_per_relation's default (-2) promotes a transaction's page
 * locks to its relation's at 2048 / 2 - 1 = 1023, as production's do. A member sized to its share of one run (30, at
 * 1,111 connections) filled under several lanes' runs at once: 35,332 SIRead locks on 5433, the table's whole, and
 * SERIALIZABLE statements failed with 53200 (follow-up 3's full suite at a5dd3588d, four network files; EVALCOMPILE's
 * world-model/inductive).
 *
 * @limitKind published
 * @owner grizzle's README ("Transactions and concurrency", "Predicate locks are the operator's to size")
 * @unit predicate locks per connection slot
 * @scope every member of a local family: its predicate-lock table, max_pred_locks_per_transaction × (max_connections
 *   + max_prepared_transactions) locks shared by every transaction at once
 * @constraint the configuration the README requires of a cluster grizzle runs on
 * @source README.md, "Transactions and concurrency": max_pred_locks_per_transaction = 2048, recommended
 * @quote Set `max_pred_locks_per_transaction = 2048`; without room, PostgreSQL fails transactions with 53200, which is
 *   not retryable.
 * @verified 2026-11-19
 */
export const predicateLocks = 2048

/** A setting's value as postgresql.conf, ALTER SYSTEM and pg_settings spell it: a number in its own unit, or a boolean. */
type SettingValue = number | "on" | "off"

/**
 * The settings every member of a family holds exactly, whatever the machine, by name, each in its own unit:
 * cluster-settings.ts prints them, scripts/pg/init.sh writes them into every member and gives them to each it adopts, and
 * scripts/pg/doctor.sh requires each of every member exactly; never none, since the shell reads them a line each. The
 * settings sized to the machine are size.ts clusterSize.
 *
 * - client_connection_check_interval: a running statement polls its client's socket, so a backend whose client died
 *   mid-statement ends at its next poll and lets go of its transaction id (clientCheckInterval).
 * - max_pred_locks_per_transaction: the README's 2048, production's, so the predicate-lock table is the one an
 *   application's cluster has (predicateLocks).
 * - fsync off: a member never waits for the disk. A test database is a clone made for one case and dropped after it
 *   (test/support/runner.ts, the toolchain's Database.fresh), and every DROP DATABASE forces a checkpoint it waits for
 *   inside its transaction (dbcommands.c dropdb, RequestCheckpoint with CHECKPOINT_WAIT), which with fsync on syncs
 *   every file the member wrote since the last one: under a full run's load the toolchain's pool measured its take wait
 *   at 27 to 47 s at the 90th percentile with fsync on, and 2 ms with it off at a pool depth of 4
 *   (~/.cache/grizzle-release/TESTSYS/RESOURCES/measure/pool). No answer a test reads changes: with fsync off the WAL
 *   is still written and its flush pointer still advances past every commit (xlog.c XLogWrite sets LogwrtResult.Flush
 *   after issue_xlog_fsync, which returns at once when fsync is off), so hint bits and the visibility map follow
 *   commits as with fsync on, unlike synchronous_commit = off. What it gives up is a member's survival of a crash of
 *   the machine, which a test cluster, rebuilt by init.sh, never needs. Only these local test clusters hold it; a
 *   production-shaped cluster keeps PostgreSQL's default.
 */
export const clusterSettings: Arr.NonEmptyReadonlyArray<
	readonly [setting: string, value: SettingValue]
> = [
	["client_connection_check_interval", clientCheckInterval],
	["fsync", "off"],
	["max_pred_locks_per_transaction", predicateLocks]
]
