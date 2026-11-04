import { Effect, Result } from "effect"
import { LedgerUnread, type MigrateError, stopped } from "#adapter/migrate/errors.ts"
import { ledgerOfAnswers, ledgerReads } from "#adapter/migrate/ledger.ts"
import type { MigrationSession } from "#adapter/migrate/session.ts"
import { sentAnswer } from "#adapter/wire/batch.ts"
import type { LedgerState, LedgerStatements } from "#compiler/deploy/ledger/ledger.ts"

/**
 * A schema's ledger state, read in a step of its own through the two reads the apply runner sends with its steps
 * (packages/grizzle/src/adapter/migrate/ledger.ts ledgerReads, ledgerOfAnswers).
 */
export const readLedger = (
	session: MigrationSession,
	schema: string,
	statements: LedgerStatements
): Effect.Effect<LedgerState, MigrateError> =>
	Effect.mapError(
		Effect.flatMap(
			Effect.mapError(session.apart(ledgerReads(schema, statements)), (failure) =>
				LedgerUnread.make({ schema, failure })
			),
			(answers) =>
				Effect.fromResult(
					Result.map(
						ledgerOfAnswers(schema, sentAnswer(answers, 0), sentAnswer(answers, 1)),
						(read) => read.state
					)
				)
		),
		stopped
	)
