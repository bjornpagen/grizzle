import type { Effect, Scope } from "effect"
import type {
	ConnectRefusal,
	ListenerLost,
	ServerError,
	SlotAbsent,
	SourceInvalidated
} from "#adapter/errors/failures.ts"
import type { LeaderFailed, SecretUnreadable } from "#adapter/live/leader.ts"
import type { ApartFailure } from "#adapter/wire/batch.ts"
import type { RouteKey } from "#compiler/plan/runtime.ts"

/**
 * Why a change source did not open: its session's connection refused, its server's refusal of a statement, a session
 * that failed under one, an answer it cannot read, a secret that is no key, or a slot that does not stand yet
 * (SlotAbsent) or no longer does (SourceInvalidated).
 */
export type SourceRefusal =
	| ConnectRefusal
	| ServerError
	| ApartFailure
	| SecretUnreadable
	| SlotAbsent
	| SourceInvalidated

/**
 * Why an open change source ended, after which no change reaches its sink: its listening session ended (ListenerLost),
 * the installation's slot was invalidated (SourceInvalidated), or the process's candidacy for the installation's leader
 * failed (LeaderFailed).
 */
export type SourceLoss = ListenerLost | SourceInvalidated | LeaderFailed

/**
 * Where an open change source delivers: `touched`, a committed change touched the rows `key` names; `lost`, the source
 * ended for `reason`, once, after which nothing more is delivered. Both are called synchronously from the source's own
 * events, so a sink does its work at once and never waits.
 */
export interface ChangeSink {
	readonly touched: (key: RouteKey) => void
	readonly lost: (reason: SourceLoss) => void
}

/**
 * Where a layer's live reads learn which committed changes touched which rows (live/subscriptions.ts): the one seam
 * between the registry and whatever reports changes, so nothing of the registry names how they are reported. The
 * installation's fan-out (live/listen.ts) is one.
 *
 * `open` starts the source in the scope it is given and succeeds only once every change committed after that instant
 * will reach `sink`: each change's keys, each delivered only once its change is visible to every snapshot taken after
 * the delivery, so a read begun after a key arrives sees the change that sent it. `lost` may come at any point after
 * `open` is called, before it succeeds among them, and is the source's terminal event; closing the scope ends the
 * source and loses nothing.
 */
export interface ChangeSource {
	readonly open: (sink: ChangeSink) => Effect.Effect<void, SourceRefusal, Scope.Scope>
}
