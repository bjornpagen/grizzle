import { Effect, Result } from "effect"
import { Pool, type PoolClient } from "pg"
import type { ConnectionPool } from "#adapter/types/layer.ts"
import { oneShotStatement } from "#adapter/wire/batch.ts"
import type { SessionPool } from "#adapter/wire/session.ts"
import { runAlone } from "#test/support/pg.ts"
import { testSql } from "#test/support/sql.ts"
import type { Probe } from "#test/support/worlds/model/types.ts"

/**
 * The pg Pool a login's DbLayer builds, as its `attachPool` hook hands it over (the hook Vercel's attachDatabasePool
 * is): grizzle's pool is node-postgres's own, whose `acquire` event names the backend of each connection a lease takes.
 */
export const isNativePool = (pool: ConnectionPool): pool is ConnectionPool & Pool =>
	pool instanceof Pool

/** The backend of the connection a pool most recently leased. */
export const leasedBackend = (client: unknown): number | undefined =>
	client instanceof Object && "processID" in client && typeof client.processID === "number"
		? client.processID
		: undefined

/** A pooled connection in an aborted transaction, which refuses every statement. */
const aborted: Probe = { transaction: "aborted" }

/**
 * current_user, the claims setting and the backend of a pooled connection. Whether it is inside a transaction is not
 * among them: its statements run on the extended protocol, where Parse, or the Bind of a parsed statement, starts the
 * implicit transaction at its own statement timestamp and Execute sets another (PostgreSQL 19 postgres.c PostgresMain,
 * xact.c StartTransaction), so statement_timestamp() and transaction_timestamp() differ inside an explicit transaction
 * and outside one alike.
 */
const pooledSql =
	"SELECT current_user::text, coalesce(pg_catalog.current_setting('grizzle.claims', true), ''), pg_catalog.pg_backend_pid()::text"

/**
 * What an idle pooled connection carries between transactions, read on a session leased as a Db's transactions lease
 * one, through its pool's permits (wire/session.ts SessionPool.lease). Where it stands is the status of the last
 * ReadyForQuery its connection read, which pg keeps on its client (`getTransactionStatus`), read before anything is sent:
 * idle, in a transaction, or in an aborted one. The client is the one pg's Pool names in its `acquire` event just before
 * it answers the lease's ask, which resumes the lease in that same call (makePool), so the last client named when the
 * lease returns is the leased session's, whatever other leases the pool serves meanwhile; the read's backend confirms
 * it. An aborted transaction refuses the read (25P02); otherwise it shows current_user and the claims setting. Any other
 * outcome is a defect of the run: an open session's pool always leases, and its connection answers the read. The
 * session goes back to the pool as it was found.
 */
export const probePool = (pool: SessionPool): Effect.Effect<Probe> =>
	Effect.scoped(
		Effect.gen(function* () {
			const native = pool.native
			if (!isNativePool(native)) {
				return yield* Effect.die(new Error("a login's pool is not node-postgres's Pool"))
			}
			const handed: { client: PoolClient | undefined } = { client: undefined }
			const onAcquire = (client: PoolClient): void => {
				handed.client = client
			}
			yield* Effect.acquireRelease(
				Effect.sync(() => native.on("acquire", onAcquire)),
				() => Effect.sync(() => native.off("acquire", onAcquire))
			)
			const session = yield* Effect.orDie(pool.lease)
			const client = handed.client
			if (client === undefined) {
				return yield* Effect.die(new Error("the pooled probe's lease named no client"))
			}
			/**
			 * A client pg's Pool just connected is handed over from inside its first ReadyForQuery's handling, before pg
			 * records that ReadyForQuery's status (client.js _handleReadyForQuery calls back first), so the status is
			 * read once the handover's call has returned.
			 */
			let status = client.getTransactionStatus()
			while (status === null) {
				yield* Effect.yieldNow
				status = client.getTransactionStatus()
			}
			const read = yield* Effect.result(runAlone(session, oneShotStatement(testSql(pooledSql), [])))
			if (status === "E") {
				return Result.isFailure(read) &&
					read.failure._tag === "BatchRefused" &&
					read.failure.failure.sqlstate === "25P02"
					? aborted
					: yield* Effect.die(
							new Error("the pooled probe's aborted transaction did not refuse the read")
						)
			}
			if (Result.isFailure(read)) {
				return yield* Effect.die(read.failure)
			}
			const [user, claims, backend] = read.success.rows[0] ?? []
			if (user === undefined || claims === undefined) {
				return yield* Effect.die(new Error("the pooled probe read no row"))
			}
			if (backend !== String(leasedBackend(client))) {
				return yield* Effect.die(
					new Error("the pooled probe read another backend than its lease's")
				)
			}
			const probe: Probe = {
				transaction: status === "T" ? "in-transaction" : "idle",
				currentUser: user,
				claims
			}
			return probe
		})
	)
