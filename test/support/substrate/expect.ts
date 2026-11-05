import { Effect } from "effect"
import type { ConstraintName } from "#compiler/core/ids.ts"
import { messageOf } from "#test/support/message.ts"
import {
	ExpectationFailed,
	type PgErrorFields,
	pgErrorFields
} from "#test/support/substrate/errors.ts"

const describe = (error: unknown): string => {
	const fields = pgErrorFields(error)
	if (fields !== undefined) {
		return `SQLSTATE ${fields.code} (${fields.message})`
	}
	return messageOf(error)
}

/** How the attempt an expectation judges ended. */
type Outcome =
	| { readonly kind: "succeeded" }
	| { readonly kind: "not PostgreSQL's"; readonly error: unknown }
	| { readonly kind: "refused"; readonly error: unknown; readonly fields: PgErrorFields }

/**
 * `attempt` run once and judged. SERIALIZABLE never refuses an attempt that runs alone: a 40001 needs a concurrent
 * transaction in its set of conflicts to have committed (PostgreSQL 19rc1's src/backend/storage/lmgr/README-SSI: "no
 * transaction is canceled until one of the other transactions in the set of conflicts which could generate an anomaly
 * has successfully committed"), and a 40P01 a second backend waiting on it. An attempt beside a concurrent transaction
 * may meet a refusal, which is judged like any other SQLSTATE: the one expected, or a failure of the expectation.
 */
const observed = <A, E, R, B>(
	attempt: Effect.Effect<A, E, R>,
	judge: (outcome: Outcome) => Effect.Effect<B, ExpectationFailed>
): Effect.Effect<B, ExpectationFailed, R> =>
	Effect.matchEffect(attempt, {
		onSuccess: () => judge({ kind: "succeeded" }),
		onFailure: (error) => {
			const fields = pgErrorFields(error)
			return judge(
				fields === undefined
					? { kind: "not PostgreSQL's", error }
					: { kind: "refused", error, fields }
			)
		}
	})

/**
 * Assertions on PostgreSQL's native errors, for raw sessions and psql writers alike.
 *
 * Direct SQL writers "see PostgreSQL's native errors" (oracle coverage): an exact
 * repeat raises 23505, a privilege refusal 42501, a residual law raises at COMMIT with the law's identity. These
 * helpers run an attempt, require it to fail with a PostgreSQL error, and return that error's fields.
 *
 * An attempt is one whole transaction, a statement in autocommit or a transaction from BEGIN (inTransaction), run once
 * and judged (observed).
 *
 * Requires `attempt` to fail with SQLSTATE `sqlstate`. Defects and interruptions propagate unchanged.
 */
export const expectSqlstate = <A, E, R>(
	attempt: Effect.Effect<A, E, R>,
	sqlstate: string
): Effect.Effect<PgErrorFields, ExpectationFailed, R> =>
	observed(attempt, (outcome) => {
		switch (outcome.kind) {
			case "succeeded":
				return Effect.fail(
					new ExpectationFailed({
						message: `expected SQLSTATE ${sqlstate}, but the statement succeeded`
					})
				)
			case "not PostgreSQL's":
				return Effect.fail(
					new ExpectationFailed({
						message: `expected SQLSTATE ${sqlstate}, but the failure is not a PostgreSQL error: ${describe(outcome.error)}`
					})
				)
			case "refused":
				return outcome.fields.code === sqlstate
					? Effect.succeed(outcome.fields)
					: Effect.fail(
							new ExpectationFailed({
								message: `expected SQLSTATE ${sqlstate}, got ${describe(outcome.error)}`
							})
						)
		}
	})

/** Requires `attempt`, as expectSqlstate takes one, to fail on the named constraint with SQLSTATE `sqlstate`. */
export const expectConstraint = <A, E, R>(
	attempt: Effect.Effect<A, E, R>,
	constraint: ConstraintName,
	sqlstate: string
): Effect.Effect<PgErrorFields, ExpectationFailed, R> =>
	observed(attempt, (outcome) => {
		switch (outcome.kind) {
			case "succeeded":
				return Effect.fail(
					new ExpectationFailed({
						message: `expected a violation of ${constraint}, but the statement succeeded`
					})
				)
			case "not PostgreSQL's":
				return Effect.fail(
					new ExpectationFailed({
						message: `expected a violation of ${constraint}, but the failure is not a PostgreSQL error: ${describe(outcome.error)}`
					})
				)
			case "refused":
				if (outcome.fields.code !== sqlstate) {
					return Effect.fail(
						new ExpectationFailed({
							message: `expected SQLSTATE ${sqlstate} on ${constraint}, got ${describe(outcome.error)}`
						})
					)
				}
				if (outcome.fields.constraint !== constraint) {
					return Effect.fail(
						new ExpectationFailed({
							message: `expected a violation of ${constraint}, got ${outcome.fields.constraint ?? "no constraint"}: ${describe(outcome.error)}`
						})
					)
				}
				return Effect.succeed(outcome.fields)
		}
	})

/** A session that opens its own transactions: a raw session or a psql writer. */
interface Transactional<E> {
	readonly begin: Effect.Effect<void, E>
}

/**
 * One attempt of an explicit transaction, as the expectations take it: BEGIN on `session`, then `body`. A failure
 * leaves the transaction open and aborted, as `body` left it, for the caller to observe and end.
 */
export const inTransaction = <A, E, R, S>(
	session: Transactional<S>,
	body: Effect.Effect<A, E, R>
): Effect.Effect<A, E | S, R> => Effect.andThen(session.begin, body)
