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
 *
 * Plants (~/.cache/grizzle-release/BR13/plants): deadlines-statement-timeout.patch (a login's startup options setting
 * statement_timeout).
 */
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import type { Source } from "@grizzle/testing/source"
import { searched } from "@grizzle/testing/vitest"
import { attachDatabasePool } from "@vercel/functions/db-connections"
import { Array as Arr, Clock, Effect, Formatter, Option } from "effect"
import { oneShotStatement, runTransaction, type Transaction } from "#adapter/wire/batch.ts"
import { defaultPool, poolFor, roleDefaults, substrateLogin } from "#test/pg/adapter/support.ts"
import { backendPid, onVercel, vercelRuntime } from "#test/pg/serverless/support.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang, testIdleTimeout } from "#test/support/limits.ts"
import { testSql } from "#test/support/sql.ts"
import { freshSchema, roleSession, Substrate } from "#test/support/substrate/substrate.ts"
import { outputRows, paramText } from "#test/support/wire.ts"

/** Every way a transaction grizzle opens begins: a read, immediate or deferrable, and a write. */
const openings = ["read", "deferrable read", "write"] as const

type Opening = (typeof openings)[number]

/** The transaction each opening begins, committed. */
const transactions: { readonly [O in Opening]: Transaction } = {
	read: { access: "readOnly", deferrable: false, end: "COMMIT" },
	"deferrable read": { access: "readOnly", deferrable: true, end: "COMMIT" },
	write: { access: "readWrite", isolation: "serializable", end: "COMMIT" }
}

const deadlineSettings = [
	"idle_in_transaction_session_timeout",
	"lock_timeout",
	"statement_timeout",
	"transaction_timeout"
] as const

const settingsQuery = `SELECT name::text, setting::text, source::text FROM pg_catalog.pg_settings
WHERE name = ANY ($1::text[]) ORDER BY name`

/**
 * The wall clock's time in milliseconds, whatever the test's clock: a Vercel deadline is wall-clock time. It only
 * builds the deadline the request context carries; no verdict reads it.
 */
const wallMillis = Clock.Clock.defaultValue().currentTimeMillis

/** A session's surroundings: a plain process, or a Vercel function whose request carries a deadline. */
const contexts = ["plain", "vercel deadline"] as const

type Context = (typeof contexts)[number]

type DeadlineFeature = `${Opening} ${Context}`

/** Every opening with every surrounding, the opening outermost. */
const modes = (source: Source): readonly [Opening, Context] =>
	[source.draw(element(openings)), source.draw(element(contexts))] as const

layer(Substrate.layer)("no server-side deadlines", (it) => {
	it.effect(
		"no session sets a statement, lock, idle or transaction timeout, read-only, deferrable or not, with or without a Vercel deadline",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const schema = yield* s.schema(freshSchema)
					const writer = yield* substrateLogin(schema, "server", roleDefaults)
					const deadlineList = `{${Arr.join(deadlineSettings, ",")}}`
					/** The deadline settings a plain session of the login runs under, opened without grizzle. */
					const plain = yield* s.session({ ...roleSession(writer), label: "plain" })
					const plainRows = yield* plain.values(settingsQuery, [deadlineList])
					const reference = Arr.map(plainRows, (row) => Arr.map(row, String))
					/** Every session of the pool at once, so each one is asked, not only the floor. */
					const max = 3
					const exhausted = yield* exhaust(
						{
							box: "every way a transaction grizzle opens begins, in a plain process and under a Vercel request's deadline",
							oracle: {
								kind: "postgresql",
								name: "the deadline settings, value and source, of a plain session of the same login"
							},
							suite: "serverless/deadlines",
							generator: modes,
							literal: Formatter.format,
							coverage: requiredInSpace<DeadlineFeature>(
								Arr.flatMap(openings, (i) => Arr.map(contexts, (c): DeadlineFeature => `${i} ${c}`))
							),
							caseHang
						},
						([opening, context], c) =>
							Effect.gen(function* () {
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
									pool: { idleTimeoutMs: testIdleTimeout.value, min: 1, max },
									attachPool: Option.isSome(vercel) ? attachDatabasePool : defaultPool.attachPool
								})
								const backends = new Set<string>()
								yield* Effect.scoped(
									Effect.gen(function* () {
										const sessions = yield* Effect.all(
											Array.from({ length: max }, () => pool.lease),
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
								assert.equal(backends.size, max, "every session of the pool is asked")
								c.note(`${opening} ${context}`)
							})
					)
					/** Nor does any role default the login carries. */
					const settings = yield* s.admin.queryValues(
						`SELECT count(*)::int4 FROM pg_catalog.pg_db_role_setting AS d
					CROSS JOIN LATERAL pg_catalog.unnest(d.setconfig) AS c(setting)
					WHERE d.setrole = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1::text)
					AND pg_catalog.split_part(c.setting, '=', 1) = ANY ($2::text[])`,
						[writer.role, deadlineList]
					)
					assert.deepEqual(settings, [[0]])
					return exhausted
				}).pipe(Effect.scoped)
			)
	)
})
