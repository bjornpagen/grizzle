import { Result } from "effect"
import { Pool } from "pg"

/**
 * pg's Pool, whose `release` listeners each run on their own. A listener is foreign code (Vercel's integration), and a
 * release happens in a lease's finalizer: one that throws never skips the other listeners or the release itself, which
 * pg's Pool would otherwise leave half done, its client neither idle nor closed, so the pool would lose a session for
 * good. EventEmitter.emit forwards its caller's argument list, which is that library's own contract, so this module is
 * superlint's no-spread-argument exception.
 */
export class ReleasingPool extends Pool {
	override emit(event: string | symbol, ...args: Array<unknown>): boolean {
		if (event !== "release") {
			return super.emit(event, ...args)
		}
		const listeners = this.listeners(event)
		for (const listener of listeners) {
			Result.try(() => {
				Reflect.apply(listener, this, args)
			})
		}
		return listeners.length > 0
	}
}
