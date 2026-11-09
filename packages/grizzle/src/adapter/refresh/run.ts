import * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import { type DbContext, dbWriteFrame } from "#adapter/db/context.ts"
import {
	type ApplyError,
	CommitUnknown,
	ExecutionFailure,
	serializationRefusal,
	TransientFailure,
	TransportFailure
} from "#adapter/errors/execution.ts"
import { ConcurrentRefresh, type ServerError } from "#adapter/errors/failures.ts"
import { concurrentRefreshPosition, populatedViews } from "#adapter/refresh/detail.ts"
import { type BatchStatement, type FlightFailure, runFramed } from "#adapter/wire/batch.ts"
import type { Session } from "#adapter/wire/session.ts"
import type { EmittedText } from "#compiler/plan/common.ts"
import { sqlstates } from "#compiler/plan/runtime.ts"
import type { ServedRefresh, ServedRefreshTarget } from "#compiler/plan/serve.ts"

/** One refresh statement an attempt ran. */
interface RefreshStatement {
	readonly relation: string
	readonly concurrently: boolean
	readonly sql: EmittedText
}

/**
 * The refresh transaction: one attempt, in one flight of one transaction (../wire/batch.ts):
 *
 * BEGIN, one catalog statement per PostgreSQL schema reading which named views are
 * populated (statements.ts), which takes the transaction's snapshot, then one DO block (statements.ts refreshBlock) that
 * reads each view's populated state again in that snapshot, runs the rewrite check of every named view, and then the
 * refresh statement of each target in refresh order (targets.ts): `REFRESH MATERIALIZED VIEW <view>` for an
 * unpopulated view and `REFRESH MATERIALIZED VIEW CONCURRENTLY <view>` for a populated one, then COMMIT, whose wait for
 * its answer is not interrupted: every named view is published in that one commit, so a reader never sees them out of
 * step with each other. The host's populated reading, in front of the block and in its snapshot, is the block's own
 * choice, which the report records. Every level's definition reads one snapshot of the base relations and a higher
 * level reads the lower levels as this transaction just refreshed them. It writes only materialized views, which no
 * law names, so no law function fires in it. Two refreshers of one view each read the whole view and write into it, so
 * the later one fails with 40001, and a caller's retry converges; a key the other refresher inserted is 40001 too,
 * never 23505.
 *
 * The rewrite check (statements.ts) waits for any plain refresh of the view in progress and compares the view's
 * storage in the snapshot with the current one. A difference for a view the snapshot shows unpopulated is another
 * refresher's first population committed after the snapshot, which a plain refresh statement's heap swap would
 * silently overwrite with an older state, so the block raises before any refresh statement, and the refresh fails with
 * TransientFailure{ConcurrentRefresh} and rolls back without refreshing anything. A view the snapshot shows populated
 * takes the concurrent form, whose diff meets another refresher's commit as 40001, so its check decides nothing; it
 * runs anyway, before any refresh statement. Each refresh statement runs as the Db's role, which holds MAINTAIN on every
 * view its refresh list names; PostgreSQL evaluates the definition with the view owner's privileges, over reality.
 *
 * How the transaction ends:
 *
 * - committed: the refresh succeeded; its success value is void;
 * - a serialization failure (40001) or a deadlock (40P01), at any statement or raised by COMMIT, and the rewrite check
 *   of step 1, are a TransientFailure: the caller may run the refresh again, which recomputes every named view from
 *   the base as it then is. Two refreshers of one view without a lease are correct and merely repeat work: the later
 *   one meets the earlier one's commit as 40001 (see step 1), or before a plain refresh statement through the rewrite
 *   check, and its retry's snapshot sees that commit;
 * - any other server error is ExecutionFailure with the server's report (a privilege refusal, 42501, a view the catalog
 *   does not hold, 42P01, and a refused prologue, among them), but the fence's refusal is StaleSnapshot. A unique
 *   violation (23505) or a duplicate row in the new data (21000) is one of them: only a definition that is not
 *   duplicate-free under its inherited keys raises one, which the compiler proves it is, so it is the database's answer
 *   contradicting that proof, and the refresh fails closed with that answer; a lost
 *   connection before COMMIT was sent is TransportFailure{stage: "transport"}, a driver failure
 *   TransportFailure{stage: "driver"}; the refresh's own failed acquisition is the TransportFailure whose reason is
 *   the acquisition's refusal, at stage acquire, as an apply's is; an unreadable answer is the ExecutionFailure whose
 *   reason it is; a COMMIT with no answer is CommitUnknown.
 *
 * A refused statement aborts the transaction, so the first refusal of the flight is classified, never a later 25P02; a
 * refusal inside the block keeps its own SQLSTATE.
 *
 * What a committed refresh did: the statements it ran.
 */
export interface RefreshReport {
	readonly statements: ReadonlyArray<RefreshStatement>
}

/**
 * What a refused statement of a refresh means (see the header): SERIALIZABLE's refusal is the TransientFailure, and
 * every other refusal the server's report. A refresh writes no unique object a statement probes, so no unique violation
 * of it is an abort.
 */
const classifyRefreshFailure = (failure: ServerError): TransientFailure | ExecutionFailure =>
	serializationRefusal(failure) ?? new ExecutionFailure({ reason: failure })

/**
 * How a refresh's flight failed (see the header): the block's own refusal of a rewritten view is ConcurrentRefresh of
 * the target it names.
 */
const refreshFailure =
	(targets: ReadonlyArray<ServedRefreshTarget>) =>
	(failure: FlightFailure): Effect.Effect<never, ApplyError> => {
		switch (failure._tag) {
			case "BatchRefused": {
				const position =
					failure.failure.sqlstate === sqlstates.grizzleConcurrentChange
						? concurrentRefreshPosition(failure.failure.detail)
						: undefined
				const target = position === undefined ? undefined : targets[position]
				if (target !== undefined) {
					return Effect.fail(
						new TransientFailure({
							reason: new ConcurrentRefresh({ relation: target.relation }),
							error: failure.failure
						})
					)
				}
				return failure.failure.pipe(classifyRefreshFailure, Effect.fail)
			}
			case "CommitRefused":
			case "PrologueRefused":
				return failure.failure.pipe(classifyRefreshFailure, Effect.fail)
			case "CommitLost":
				return Effect.fail(new CommitUnknown())
			case "ConnectionLost":
			case "DriverFailure":
				return Effect.fail(new TransportFailure({ reason: failure }))
			case "UnreadableAnswer":
			case "InputTooLarge":
				return Effect.fail(new ExecutionFailure({ reason: failure }))
			case "StaleSnapshot":
				return Effect.fail(failure)
		}
	}

/**
 * The refresh's one flight (see the header), its texts as generate printed them (served/forms.ts ServedRefresh), and the
 * statements it ran read from its outcomes.
 */
const refreshFlight = (
	ctx: Pick<DbContext, "prologue">,
	session: Session,
	refresh: ServedRefresh
): Effect.Effect<ReadonlyArray<RefreshStatement>, FlightFailure> => {
	const statements: Array<BatchStatement> = [
		...Arr.map(refresh.schemas, (schema) => ({ sql: refresh.populated, params: schema.params })),
		{ sql: refresh.block, params: [] }
	]
	return Effect.map(runFramed(session, dbWriteFrame(ctx), statements), (outcomes) => {
		/** The places of the targets whose view its schema's catalog statement read populated. */
		const populated = new Set<number>()
		for (const [schema, outcome] of Arr.zip(refresh.schemas, outcomes)) {
			const views = populatedViews(outcome.rows)
			for (const { place, view } of schema.targets) {
				if (views.has(view)) {
					populated.add(place)
				}
			}
		}
		const ran = Arr.map(refresh.targets, (t, place) => {
			const concurrently = populated.has(place)
			return Object.freeze({
				relation: t.relation,
				concurrently,
				sql: concurrently ? t.concurrently : t.plain
			})
		})
		return Object.freeze(ran)
	})
}

/** Runs the refresh call `refresh`, its targets already in refresh order, in one transaction of the Db's role. */
export const runRefresh = Effect.fn("runRefresh")(function* (
	ctx: Pick<DbContext, "pool" | "prologue">,
	refresh: ServedRefresh
): Effect.fn.Return<RefreshReport, ApplyError, Scope.Scope> {
	const session = yield* Effect.mapError(
		ctx.pool.lease,
		(reason) => new TransportFailure({ reason })
	)
	const statements = yield* Effect.catch(
		refreshFlight(ctx, session, refresh),
		refreshFailure(refresh.targets)
	)
	return Object.freeze({ statements })
}, Effect.scoped)
