import { Effect, Result } from "effect"
import { LedgerUnread, type MigrateError, stopped } from "#adapter/migrate/errors.ts"
import {
	installedLedger,
	ledgerExistsRead,
	ledgerPresence,
	ledgerRowsRead,
	ledgerStateOf
} from "#adapter/migrate/ledger.ts"
import type { MigrationSession } from "#adapter/migrate/session.ts"
import { sentAnswer } from "#adapter/wire/batch.ts"
import type { LedgerState, LedgerStatements } from "#compiler/deploy/ledger/ledger.ts"

/**
 * A schema's ledger state, read as the apply runner reads it (packages/grizzle/src/adapter/migrate/ledger.ts): whether
 * the ledger exists, in a step of its own, then, only where it does, its rows in the next.
 */
export const readLedger = (
	session: MigrationSession,
	schema: string,
	statements: LedgerStatements
): Effect.Effect<LedgerState, MigrateError> => {
	const apart = (read: Parameters<MigrationSession["apart"]>[0]) =>
		Effect.mapError(session.apart(read), (failure) => new LedgerUnread({ schema, failure }))
	return Effect.mapError(
		Effect.flatMap(apart([ledgerExistsRead(schema)]), (exists) =>
			Effect.flatMap(Effect.fromResult(ledgerPresence(schema, sentAnswer(exists, 0))), (presence) =>
				presence === "absent"
					? Effect.succeed(ledgerStateOf(schema, { kind: "absent" }))
					: Effect.flatMap(apart([ledgerRowsRead(statements)]), (rows) =>
							Effect.fromResult(
								Result.map(installedLedger(schema, sentAnswer(rows, 0)), (read) =>
									ledgerStateOf(schema, read)
								)
							)
						)
			)
		),
		stopped
	)
}
