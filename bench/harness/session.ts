import type { Effect } from "effect"
import type { SqlError } from "#test/support/pg.ts"

/**
 * The one session shape every measurement runs on.
 *
 * A measurement sends statements to one backend and reads its rows. That is all the harness needs, so a raw substrate
 * session (test/support/substrate/session.ts RawSession, a direct SQL client logged in as any role) already has this
 * shape. Measurements that read per-backend counters (wal.ts) need the backend fixed for the whole measurement, which
 * every session is: each reaches PostgreSQL directly.
 */
export interface BenchSession {
	/**
	 * One statement, its parameters bound as text and cast by the statement's own SQL; the rows as the driver decodes
	 * them.
	 */
	readonly values: (
		sql: string,
		params: ReadonlyArray<unknown>
	) => Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, SqlError>
}
