import { clientCheckInterval } from "@grizzle/limits"
import type { Array as Arr } from "effect"

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
	["client_connection_check_interval", clientCheckInterval.value],
	["fsync", "off"]
]
