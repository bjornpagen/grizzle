/**
 * No server-side deadlines (README "No server-side timeouts"): grizzle sets no statement_timeout or lock_timeout, nor
 * PostgreSQL 19's other server-side deadlines, idle_in_transaction_session_timeout and transaction_timeout, per
 * statement, per transaction, per session or per role.
 *
 * Exhausted over the box of every way a transaction grizzle opens begins (SERIALIZABLE READ ONLY, deferrable or not, or
 * SERIALIZABLE read-write) by
 * its surroundings (a plain process, or a Vercel function whose request carries a deadline, its pool built as a Vercel
 * application builds it, with Vercel's own attachDatabasePool as its hook): every session of a login's pool, its
 * maximum leased at once, runs its transaction under exactly the deadline settings, value and source, that a plain
 * session of the same login, opened by the test without grizzle, runs under. PostgreSQL is the oracle: a deadline
 * grizzle set, by a startup option, a SET or a SET LOCAL, shows as another value or another source. A role default is
 * one the plain session shares, so the login's stored defaults hold no deadline setting either, read from
 * pg_db_role_setting.
 *
 * Vercel's attachDatabasePool adds its releases to the request context's waits, so a pool another file builds meanwhile
 * with that hook would add its own: the file runs alone.
 *
 * Features: each opening in each surrounding.
 */
import { assert } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { attachDatabasePool } from "@vercel/functions/db-connections"
import { Array as Arr, Effect, Option } from "effect"
import { oneShotStatement, runTransaction } from "#adapter/wire/batch.ts"
import { defaultPool, poolFor } from "#test/pg/adapter/support.ts"
import {
	type DeadlineFeature,
	deadlineList,
	deadlineSituations,
	deadlinesLogin,
	leasedAtOnce,
	modes,
	roleDeadlinesQuery,
	settingsQuery,
	transactions,
	wallMillis
} from "#test/pg/serverless/deadlines.fixtures.ts"
import { backendPid, onVercel, vercelRuntime } from "#test/pg/serverless/support.ts"
import { testIdleTimeout } from "#test/support/limits.ts"
import { testSql } from "#test/support/sql.ts"
import { roleSession, Substrate } from "#test/support/substrate/substrate.ts"
import { outputRows, paramText } from "#test/support/wire.ts"

/**
 * No session sets a statement, lock, idle or transaction timeout, read-only, deferrable or not, with or without a
 * Vercel deadline, nor does any role default the login carries.
 *
 * Its pre-conversion budget: the box, 6 cases (test/pg/serverless/deadlines.test.ts at af1d5aac8).
 */
export const noSessionSetsAStatementLockIdleOrTransactionTimeoutWithOrWithoutAVercelDeadline =
	property.exhaust(finite(modes), {
		needs: { login: Substrate.seat(deadlinesLogin) },
		situations: deadlineSituations,
		check:
			({ login }, c: Case<DeadlineFeature>) =>
			([opening, context]) =>
				Effect.scoped(
					Effect.flatMap(login, ({ substrate: seat, value: writer }) =>
						Effect.provideService(
							Effect.gen(function* () {
								const s = yield* Substrate
								/** The deadline settings a plain session of the login runs under, opened without grizzle. */
								const plain = yield* s.session({ ...roleSession(writer), label: "plain" })
								const plainRows = yield* plain.values(settingsQuery, [deadlineList])
								const reference = Arr.map(plainRows, (row) => Arr.map(row, String))
								const vercel =
									context === "vercel deadline"
										? yield* Effect.asSome(
												Effect.flatMap(wallMillis, (now) =>
													vercelRuntime(onVercel, Option.some(now + 2_000))
												)
											)
										: Option.none()
								const pool = yield* poolFor(writer, {
									...defaultPool,
									pool: { idleTimeoutMs: testIdleTimeout, min: 1, max: leasedAtOnce },
									attachPool: Option.isSome(vercel) ? attachDatabasePool : defaultPool.attachPool
								})
								const backends = new Set<string>()
								yield* Effect.scoped(
									Effect.gen(function* () {
										const sessions = yield* Effect.all(
											Array.from({ length: leasedAtOnce }, () => pool.lease),
											{ concurrency: "unbounded" }
										)
										for (const session of sessions) {
											const [settings, pid] = yield* runTransaction(
												session,
												[
													oneShotStatement(testSql(settingsQuery), [paramText(deadlineList)]),
													oneShotStatement(testSql(backendPid), [])
												],
												transactions[opening]
											)
											assert.deepEqual(
												settings?.rows,
												outputRows(reference),
												"a pooled session's deadlines are a plain session's"
											)
											backends.add(String(pid?.rows[0]?.[0]))
										}
									})
								)
								assert.equal(backends.size, leasedAtOnce, "every session of the pool is asked")
								/** Nor does any role default the login carries. */
								const stored = yield* s.admin.queryValues(roleDeadlinesQuery, [
									writer.role,
									deadlineList
								])
								assert.deepEqual(stored, [[0]])
								c.note(`${opening} ${context}`)
							}),
							Substrate,
							seat
						)
					)
				),
		oracle: {
			kind: "postgresql",
			name: "the deadline settings, value and source, of a plain session of the same login"
		},
		box: "every way a transaction grizzle opens begins, in a plain process and under a Vercel request's deadline",
		kept: [],
		kills: []
	})
