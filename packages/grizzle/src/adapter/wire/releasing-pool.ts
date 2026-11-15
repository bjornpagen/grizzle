import * as Result from "effect/Result"
import type { PgDriver, PgPool, PgPoolConfig, PoolListener } from "#adapter/types/driver.ts"

/**
 * The class of the session pools built from `Pool`, the caller's driver's (PgDriver), made when a layer is built: pg's
 * Pool, each of whose `release` listeners is guarded as it is added. A listener is foreign code (Vercel's integration),
 * and a release happens in a lease's finalizer: one that throws never skips the other listeners or the release itself,
 * which pg's Pool would otherwise leave half done, its client neither idle nor closed, so the pool would lose a session
 * for good. A guarded listener gets pg's own arguments (PoolListener): Vercel's integration ends a release's wait with
 * the request that checked out its client, which it finds by the client.
 */
export const releasingPool = (Pool: PgDriver["Pool"]): new (config: PgPoolConfig) => PgPool =>
	class ReleasingPool extends Pool {
		override on(event: "error" | "release", listener: PoolListener): unknown {
			return super.on(
				event,
				event === "release"
					? (error: unknown, client: object | undefined) => {
							Result.try(() => listener(error, client))
						}
					: listener
			)
		}
	}
