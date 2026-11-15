import type { Array as Arr } from "effect"
import { type Limit, measured } from "#compiler/core/limits.ts"

/**
 * How long a backend runs a statement between two polls of its client's socket, PostgreSQL's
 * client_connection_check_interval, which every member holds (clusterSettings). A backend polls only while it runs a
 * statement (the timer start_xact_command arms, REL_19_RC2 src/backend/tcop/postgres.c#L2818), so an idle
 * session is never woken; a poll that finds the socket closed (pq_check_connection, src/backend/libpq/pqcomm.c#L2057)
 * ends the backend with FATAL "connection to client lost" (postgres.c#L3465), and with it the transaction id it holds.
 * Without it PostgreSQL notices a dead client only when it next reads from or writes to the socket, which a statement
 * that never ends never does: a test process ended mid-statement (its hang guard, a SIGKILL, a plant whose SQL never
 * ends) leaves its backend running and holding its transaction id, and every logical slot's creation on the member
 * (CREATE_REPLICATION_SLOT, a live source's) waits for every transaction id running when it starts.
 */
export const clientCheckInterval: Limit = measured({
	value: 1000,
	owner: "grizzle's local cluster (scripts/pg/init.sh)",
	unit: "milliseconds",
	scope:
		"one backend of a family member while it runs a statement: the time between two polls of its client's socket, and so the longest it outlives its client's death before its next poll",
	evidence:
		"one psql session's \\timing (psql -X -At -f) on the postmaster below: `SET client_connection_check_interval = 0` and `= 1000` in turn, each followed by `WITH RECURSIVE r(i) AS (SELECT 1::int8 UNION ALL SELECT i + 1 FROM r WHERE i < 20000000) SELECT count(*) FROM r`, eight times each after one warm run; its output kept at ~/.cache/grizzle-release/ORPHAN/out/cost.txt on cassowary",
	observed: "2026-11-15 14:14:02 to 14:15:40 UTC, one run",
	environment:
		"cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores, load average 16 to 22 from other sessions; a throwaway postmaster of the pinned PostgreSQL 19rc2 build (scripts/pg/pin.env, its three patches, none touching postgres.c or pqcomm.c) at initdb's defaults, no other session on it; grizzle 17b28413",
	workload:
		"one backend running a CPU-bound statement of 20,000,000 recursive steps, about 5.7 s, which polls five times a run at 1,000 ms and never at 0, the two in alternation",
	result:
		"at 0: median 5,762.8 ms, 5,751.8 to 6,018.1; at 1,000: median 5,754.7 ms, 5,727.0 to 5,811.3. The polls' cost is below the runs' own spread. Beside it, backends of SIGKILLed psql clients, each holding a transaction id and computing, in pg_sleep or waiting on an advisory lock, left pg_stat_activity 1,000 to 1,017 ms after the kill at 1,000, each with FATAL connection to client lost; the incident's orphans at 0 ran 44 minutes to 5.7 hours",
	decision:
		"1,000 ms: its polls cost nothing measurable on a statement of seconds, and an orphan then holds its transaction id at most about a second past its client's death, against hours without. No shorter value is measured: the polls' cost grows as one over the interval, and a slot creation waiting a second behind an orphan waits far less than any test's own hang limit",
	revalidate:
		"a PostgreSQL repin; a poll's cost measured above the runs' spread; a test that waits behind an orphan for less than the interval; another machine"
})

/**
 * The settings every member of a family holds exactly, whatever the machine, by name, each in its own unit:
 * cluster-settings.ts prints them, scripts/pg/init.sh writes them into every member and gives them to each it adopts, and
 * scripts/pg/doctor.sh requires each of every member exactly; never none, since the shell reads them a line each. The
 * settings sized to the machine are size.ts clusterSize.
 */
export const clusterSettings: Arr.NonEmptyReadonlyArray<readonly [setting: string, value: number]> =
	[["client_connection_check_interval", clientCheckInterval.value]]
