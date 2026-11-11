import { Context, Effect } from "effect"
import { OpenError } from "#adapter/errors/execution.ts"
import { LiveSourceMissing } from "#adapter/errors/failures.ts"
import type { Subscriptions } from "#adapter/live/subscriptions.ts"

/**
 * An installation's live source as a process holds it (pool/live.ts LiveSource.layer builds it, once per process per
 * installation): the registry every live read of the process's layers of the installation registers on, which holds
 * its fan-out's listening session and its candidacy for the installation's leader (live/listen.ts).
 */
export interface LiveSourceSessions {
	readonly subscriptions: Subscriptions
}

const keyPrefix = "@bjornpagen/grizzle/LiveSource/"

/**
 * The service key of the live source of the installation over `base`, by the base's declared name, under the
 * identifier its reader names (types/layer.ts LiveSourceService).
 */
export const liveSourceKey = <I>(base: string): Context.Service<I, LiveSourceSessions> =>
	Context.Service<I, LiveSourceSessions>(`${keyPrefix}${base}`)

/**
 * The live source of the installation over `base` among the services the context holds: a DbLayer of a login that
 * serves a read requires it (types/layer.ts LiveOf), so only a JavaScript caller that leaves it out meets
 * LiveSourceMissing, at stage config.
 */
export const liveSourceSessions = <I>(
	base: string
): Effect.Effect<LiveSourceSessions, OpenError, I> =>
	Effect.flatMap(Effect.context<I>(), (context) =>
		Effect.mapError(
			Effect.fromOption(Context.getOption(context, liveSourceKey<I>(base))),
			() => new OpenError({ reason: new LiveSourceMissing({ base }) })
		)
	)
