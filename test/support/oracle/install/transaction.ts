import { Effect } from "effect"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import { TransactionRolledBack } from "#test/support/substrate/errors.ts"

/**
 * One transaction of oracle statements on one pinned backend.
 *
 * Runs `statements` between BEGIN and COMMIT on one backend, rolling back when any of them fails. A COMMIT that
 * PostgreSQL answers with ROLLBACK committed nothing and fails with TransactionRolledBack.
 */
export const transaction = (
	connection: PgConnection,
	statements: ReadonlyArray<string>
): Effect.Effect<void, SqlError | TransactionRolledBack> =>
	Effect.scoped(
		Effect.gen(function* () {
			const pinned = yield* connection.pin
			yield* pinned.query("BEGIN", [])
			yield* Effect.onError(
				Effect.forEach(statements, (sql) => pinned.query(sql, []), { discard: true }),
				() => Effect.ignore(pinned.query("ROLLBACK", []))
			)
			const committed = yield* pinned.query("COMMIT", [])
			if (committed.command !== "COMMIT") {
				return yield* new TransactionRolledBack({
					label: "oracle install",
					command: committed.command
				})
			}
		})
	)
