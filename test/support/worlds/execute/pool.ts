import { Effect, Result } from "effect"
import { Pool } from "pg"
import type { ConnectionPool } from "#adapter/types/layer.ts"
import type { SessionPool } from "#adapter/wire/session.ts"
import { runAlone } from "#test/support/pg.ts"
import { testSql } from "#test/support/sql.ts"
import { probeSql } from "#test/support/worlds/execute/writer.ts"
import type { Probe } from "#test/support/worlds/model/types.ts"

/**
 * The pg Pool a login's DbLayer builds, as its `attachPool` hook hands it over (the hook Vercel's attachDatabasePool
 * is): grizzle's pool is node-postgres's own, whose `acquire` event names the backend of each connection a lease takes.
 */
export const isNativePool = (pool: ConnectionPool): pool is ConnectionPool & Pool =>
	pool instanceof Pool

/** A pooled connection in an aborted transaction, which refuses every statement. */
const aborted: Probe = { transaction: "aborted" }

/**
 * What an idle pooled connection carries between transactions, read on a session leased as a Db's transactions lease
 * one, through its pool's permits (wire/session.ts SessionPool.lease), with a direct writer's probe (writer.ts
 * probeSql): an aborted transaction refuses the read (25P02); otherwise current_user, the claims setting, and whether
 * the read ran inside an explicit transaction. Any other failure is a defect of the run: an open session's pool always
 * leases, and its connection always answers the read. The session goes back to the pool as it was found.
 */
export const probePool = (pool: SessionPool): Effect.Effect<Probe> =>
	Effect.scoped(
		Effect.gen(function* () {
			const session = yield* Effect.orDie(pool.lease)
			const read = yield* Effect.result(runAlone(session, { sql: testSql(probeSql), params: [] }))
			if (Result.isFailure(read)) {
				const error = read.failure
				return error._tag === "BatchRefused" && error.failure.sqlstate === "25P02"
					? aborted
					: yield* Effect.die(error)
			}
			const [row] = read.success.rows
			if (row === undefined) {
				return yield* Effect.die(new Error("the pooled probe read no row"))
			}
			const [user, claims, inside] = row
			if (user === undefined || claims === undefined) {
				return yield* Effect.die(new Error("the pooled probe read no row"))
			}
			const probe: Probe = {
				transaction: inside === "t" ? "in-transaction" : "idle",
				currentUser: user,
				claims
			}
			return probe
		})
	)

/** The backend of the connection a pool most recently leased. */
export const leasedBackend = (client: unknown): number | undefined =>
	client instanceof Object && "processID" in client && typeof client.processID === "number"
		? client.processID
		: undefined
