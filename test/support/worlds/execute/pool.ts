import { Effect } from "effect"
import { Pool, type PoolClient } from "pg"
import type { ConnectionPool } from "#adapter/types/layer.ts"
import type { Probe } from "#test/support/worlds/model/types.ts"

/**
 * The pg Pool a login's DbLayer builds, as its `attachPool` hook hands it over (the hook Vercel's attachDatabasePool
 * is): grizzle's pool is node-postgres's own, so the executor can lease an idle connection between transactions,
 * outside grizzle's prologue, and read what the last transaction left on it.
 */
export const isNativePool = (pool: ConnectionPool): pool is ConnectionPool & Pool =>
	pool instanceof Pool

const leased = (
	pool: Pool
): Effect.Effect<{ readonly client: PoolClient; readonly release: () => void }> =>
	Effect.callback((resume) => {
		pool.connect((error, client, done) => {
			if (client === undefined) {
				resume(Effect.die(error ?? new Error("the pool leased no connection")))
				return
			}
			resume(
				Effect.succeed({
					client,
					release: () => {
						done()
					}
				})
			)
		})
	})

const probeSql =
	"SELECT current_user::text, coalesce(pg_catalog.current_setting('grizzle.claims', true), '')"

/**
 * The probe's one row. A refusal is the server's error itself, a defect of the run: an open session's connection
 * always answers it (a Db whose login a migration dropped, whose connection's role is gone, is never probed).
 */
const read = (client: PoolClient): Effect.Effect<ReadonlyArray<unknown>> =>
	Effect.flatMap(
		Effect.promise(() => client.query<Array<unknown>>({ text: probeSql, rowMode: "array" })),
		(result) => {
			const [row] = result.rows
			return row === undefined
				? Effect.die(new Error("the pooled probe read no row"))
				: Effect.succeed(row)
		}
	)

/**
 * What an idle pooled connection carries between transactions: pg's transaction status from the last ReadyForQuery,
 * read before anything is sent, and, outside an aborted transaction, current_user and the claims setting. The
 * connection goes back to the pool as it was found.
 */
export const probePool = (pool: Pool): Effect.Effect<Probe> =>
	Effect.acquireUseRelease(
		leased(pool),
		({ client }) =>
			Effect.gen(function* () {
				const status = client.getTransactionStatus()
				if (status === "E") {
					return { transaction: "aborted" }
				}
				const [user, claims] = yield* read(client)
				if (typeof user !== "string" || typeof claims !== "string") {
					return yield* Effect.die(new Error("the pooled probe read no row"))
				}
				return {
					transaction: status === "T" ? "in-transaction" : "idle",
					currentUser: user,
					claims
				}
			}),
		({ release }) => Effect.sync(release)
	)

/** The backend of the connection a pool most recently leased. */
export const leasedBackend = (client: unknown): number | undefined =>
	client instanceof Object && "processID" in client && typeof client.processID === "number"
		? client.processID
		: undefined
