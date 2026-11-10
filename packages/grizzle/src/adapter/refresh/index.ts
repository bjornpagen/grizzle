import { type Array as Arr, Effect, Result } from "effect"
import { compileFailure } from "#adapter/apply/run.ts"
import type { DbContext } from "#adapter/db/context.ts"
import type { ApplyError } from "#adapter/errors/execution.ts"
import { type RefreshReport, runRefresh } from "#adapter/refresh/run.ts"
import { refreshPlan } from "#adapter/refresh/statements.ts"
import { refreshTargets } from "#adapter/refresh/targets.ts"

/**
 * db.refresh(...relations): bring derived relations to their definitions in one transaction.
 *
 * "db.refresh(...relations) runs one transaction that issues one refresh statement per named relation in level order,
 * relations at one level in declared order. Its meaning is the set-difference transition: after it commits, each named
 * relation holds exactly its definition's result". The call:
 *
 * 1. resolves the named relations against the Db's base and the role's refresh list, and orders them (targets.ts),
 *    before any SQL: a refusal is the ExecutionFailure whose reason is its CompileError, the refresh's error channel
 *    being ApplyError;
 * 2. runs the refresh transaction once, as the Db's role (run.ts): plain REFRESH MATERIALIZED VIEW for a view
 *    pg_class.relispopulated shows unpopulated, CONCURRENTLY for a populated one (statements.ts). Another refresher's
 *    commit after this transaction's snapshot is met as 40001 or 40P01 (before a plain statement, through the rewrite
 *    check of statements.ts), and fails the refresh with TransientFailure, which the caller may retry.
 *
 * A call names at least one relation, by its type: a caller with a list built at run time narrows it to a non-empty
 * one first, so no call claims a refresh it never ran. Refresh is not a ChangeSet: it has no outcome beyond
 * success. Separate calls are separate transactions, which is how a long refresh is split into bounded
 * steps, the caller's semantic choice.
 *
 * The refresh of `relations` on the opened database, reporting its statements (for tests and diagnostics).
 */
const refreshReport = (
	ctx: DbContext,
	relations: Arr.NonEmptyReadonlyArray<unknown>
): Effect.Effect<RefreshReport, ApplyError> =>
	Effect.suspend(() => {
		const targets = refreshTargets(ctx.role, ctx.artifacts, relations)
		if (Result.isFailure(targets)) {
			return compileFailure(targets.failure)
		}
		return runRefresh(ctx, refreshPlan(targets.success))
	})

/** `relations` are the derived relation values db.refresh was given, each in the role's refresh list by its type. */
export const refresh = (
	ctx: DbContext,
	relations: Arr.NonEmptyReadonlyArray<unknown>
): Effect.Effect<void, ApplyError> => Effect.asVoid(refreshReport(ctx, relations))
