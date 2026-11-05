import { Result } from "effect"
import type { PgDriver, PgPool, PgPoolConfig } from "#adapter/types/driver.ts"

/**
 * The class of the session pools built from `Pool`, the caller's driver's (PgDriver), made when a layer is built: pg's
 * Pool, each of whose `release` listeners is guarded as it is added. A listener is foreign code (Vercel's integration),
 * and a release happens in a lease's finalizer: one that throws never skips the other listeners or the release itself,
 * which pg's Pool would otherwise leave half done, its client neither idle nor closed, so the pool would lose a session
 * for good. A guarded listener is called with no arguments, as ConnectionPool types it.
 */
export const releasingPool = (Pool: PgDriver["Pool"]): new (config: PgPoolConfig) => PgPool =>
	class ReleasingPool extends Pool {
		override on(event: "error" | "release", listener: () => void): unknown {
			return super.on(
				event,
				event === "release"
					? () => {
							Result.try(listener)
						}
					: listener
			)
		}
	}
