import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import type { Source } from "@grizzle/testing/source"
import { searched } from "@grizzle/testing/vitest"
import { attachDatabasePool } from "@vercel/functions/db-connections"
import { Array as Arr, Clock, Effect, Formatter, Option } from "effect"
import { runTransaction, type Transaction } from "#adapter/wire/batch.ts"
import { defaultPool, poolFor, roleDefaults, substrateLogin } from "#test/pg/adapter/support.ts"
import { backendPid, onVercel, vercelRuntime } from "#test/pg/serverless/support.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang, testIdleTimeout } from "#test/support/limits.ts"
import { testSql } from "#test/support/sql.ts"
import { freshSchema, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * No server-side deadlines.
 *
 * grizzle sets no server-side statement_timeout or lock_timeout, per statement, per transaction, or per role. Each
 * session the pool hands out is asked through pg_settings, in a transaction read-only or not (grizzle opens both, always
 * SERIALIZABLE) and with or without a Vercel request context carrying a deadline, which never becomes a timeout. The
 * other server-side deadlines PostgreSQL 19 has (idle_in_transaction_session_timeout, transaction_timeout) are checked
 * as well: none is set by anything grizzle does.
 *
 * The Vercel case installs the request context on globalThis and sets VERCEL_URL and VERCEL_REGION, and builds the pool
 * as a Vercel application does, with Vercel's own attachDatabasePool as its hook (DbConfig.attachPool): a pool another
 * file builds meanwhile with that hook would add its releases to the waits counted here, so the file runs alone.
 *
 * Every access a transaction grizzle opens has.
 */
type Access = Transaction["access"]
const accesses = ["readOnly", "readWrite"] as const satisfies ReadonlyArray<Access>

const deadlineSettings = [
	"idle_in_transaction_session_timeout",
	"lock_timeout",
	"statement_timeout",
	"transaction_timeout"
] as const

const settingsQuery = `SELECT name::text, setting::text, source::text FROM pg_catalog.pg_settings
WHERE name = ANY ($1::text[]) ORDER BY name`

const untouched = Arr.map(deadlineSettings, (name) => [name, "0", "default"])

/**
 * The wall clock's time in milliseconds, whatever the test's clock: a Vercel deadline is wall-clock time. It only
 * builds the deadline the request context carries; no verdict reads it.
 */
const wallMillis = Clock.Clock.defaultValue().currentTimeMillis

/** A session's surroundings: a plain process, or a Vercel function whose request carries a deadline. */
const contexts = ["plain", "vercel deadline"] as const

type Context = (typeof contexts)[number]

type DeadlineFeature = `${Access} ${Context}`

/** Every access with every surrounding, the access outermost. */
const modes = (source: Source): readonly [Access, Context] =>
	[source.draw(element(accesses)), source.draw(element(contexts))] as const

layer(Substrate.layer)("no server-side deadlines", (it) => {
	it.effect(
		"no session sets a statement, lock, idle or transaction timeout, read-only or not, with or without a Vercel deadline",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const schema = yield* s.schema(freshSchema)
					const writer = yield* substrateLogin(schema, "server", roleDefaults)
					/**
					 * Vercel saw every release, its deadline capping the wait; the database saw nothing of it.
					 *
					 * Every session of the pool at once, so each one is asked, not only the floor.
					 */
					const max = 3
					const exhausted = yield* exhaust(
						{
							suite: "serverless/deadlines",
							generator: modes,
							literal: Formatter.format,
							limit: 8,
							coverage: requiredInSpace<DeadlineFeature>(
								Arr.flatMap(accesses, (i) => Arr.map(contexts, (c): DeadlineFeature => `${i} ${c}`))
							),
							caseHang
						},
						([access, context], c) =>
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
													{
														sql: testSql(settingsQuery),
														params: [`{${Arr.join(deadlineSettings, ",")}}`]
													},
													{ sql: testSql(backendPid), params: [] }
												],
												{ access, end: "COMMIT" }
											)
											assert.deepEqual(settings?.rows, untouched)
											backends.add(String(pid?.rows[0]?.[0]))
										}
									})
								)
								assert.equal(backends.size, max)
								if (Option.isSome(vercel)) {
									assert.equal(vercel.value.waits.length, max)
								}
								c.note(`${access} ${context}`)
							})
					)
					/** Nor does any role default the login carries. */
					const settings = yield* s.admin.queryValues(
						`SELECT count(*)::int4 FROM pg_catalog.pg_db_role_setting AS d
					CROSS JOIN LATERAL pg_catalog.unnest(d.setconfig) AS c(setting)
					WHERE d.setrole = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1::text)
					AND pg_catalog.split_part(c.setting, '=', 1) = ANY ($2::text[])`,
						[writer.role, `{${Arr.join(deadlineSettings, ",")}}`]
					)
					assert.deepEqual(settings, [[0]])
					return exhausted
				}).pipe(Effect.scoped)
			)
	)
})
