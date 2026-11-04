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

/**
 * The SQLSTATEs of SERIALIZABLE's refusal of a transaction, no serial order (40001) or a deadlock (40P01), each of
 * which changed nothing. PostgreSQL's SSI can raise 40001 for any SERIALIZABLE transaction once it summarizes old
 * committed ones under load, with nothing visibly concurrent.
 */
const serializableRefusals: ReadonlySet<string> = new Set(["40001", "40P01"])

/** The times an expectation runs its attempt at most: the first, and a fresh one after each SERIALIZABLE refusal. */
export const expectationAttempts = 4

const refusedBySerializable = (error: unknown): boolean => {
	const fields = pgErrorFields(error)
	return fields !== undefined && serializableRefusals.has(fields.code)
}

/** How an attempt an expectation judges ended, and which attempt it was. */
type Outcome =
	| { readonly kind: "succeeded"; readonly attempt: number }
	| { readonly kind: "not PostgreSQL's"; readonly attempt: number; readonly error: unknown }
	| {
			readonly kind: "refused"
			readonly attempt: number
			readonly error: unknown
			readonly fields: PgErrorFields
	  }

/** What a failure message adds for an attempt past the first: every earlier one was refused by SERIALIZABLE. */
const attemptNote = (attempt: number): string =>
	attempt === 1
		? ""
		: ` on attempt ${attempt} of ${expectationAttempts}, SERIALIZABLE having refused each earlier one with 40001 or 40P01`

/**
 * `attempt` run until it ends other than in SERIALIZABLE's refusal, at most expectationAttempts times, and judged once:
 * a 40001 or 40P01 other than the `sqlstate` expected changed nothing, so the expectation is observed on a fresh
 * attempt. The attempt's last outcome is judged when every attempt is refused, so the expectation fails closed.
 */
const observed = <A, E, R, B>(
	attempt: Effect.Effect<A, E, R>,
	sqlstate: string,
	judge: (outcome: Outcome) => Effect.Effect<B, ExpectationFailed>
): Effect.Effect<B, ExpectationFailed, R> => {
	const run = (made: number): Effect.Effect<B, ExpectationFailed, R> =>
		Effect.matchEffect(attempt, {
			onSuccess: () => judge({ kind: "succeeded", attempt: made }),
			onFailure: (error) => {
				const fields = pgErrorFields(error)
				if (fields === undefined) {
					return judge({ kind: "not PostgreSQL's", attempt: made, error })
				}
				if (
					fields.code !== sqlstate &&
					serializableRefusals.has(fields.code) &&
					made < expectationAttempts
				) {
					return run(made + 1)
				}
				return judge({ kind: "refused", attempt: made, error, fields })
			}
		})
	return run(1)
}

/**
 * Assertions on PostgreSQL's native errors, for raw sessions and psql writers alike.
 *
 * Direct SQL writers "see PostgreSQL's native errors" (oracle coverage): an exact
 * repeat raises 23505, a privilege refusal 42501, a residual law raises at COMMIT with the law's identity. These
 * helpers run an attempt, require it to fail with a PostgreSQL error, and return that error's fields.
 *
 * An attempt is one whole transaction: a statement in autocommit, or a transaction from BEGIN (inTransaction). When
 * SERIALIZABLE refuses it with 40001 or 40P01 and that is not the SQLSTATE expected, the attempt changed nothing and
 * runs again (observed). A statement inside a transaction the caller opened is no attempt: run again, it meets 25P02.
 *
 * Requires `attempt` to fail with SQLSTATE `sqlstate`. Defects and interruptions propagate unchanged.
 */
export const expectSqlstate = <A, E, R>(
	attempt: Effect.Effect<A, E, R>,
	sqlstate: string
): Effect.Effect<PgErrorFields, ExpectationFailed, R> =>
	observed(attempt, sqlstate, (outcome) => {
		switch (outcome.kind) {
			case "succeeded":
				return Effect.fail(
					new ExpectationFailed({
						message: `expected SQLSTATE ${sqlstate}, but the statement succeeded${attemptNote(outcome.attempt)}`
					})
				)
			case "not PostgreSQL's":
				return Effect.fail(
					new ExpectationFailed({
						message: `expected SQLSTATE ${sqlstate}, but the failure is not a PostgreSQL error: ${describe(outcome.error)}${attemptNote(outcome.attempt)}`
					})
				)
			case "refused":
				return outcome.fields.code === sqlstate
					? Effect.succeed(outcome.fields)
					: Effect.fail(
							new ExpectationFailed({
								message: `expected SQLSTATE ${sqlstate}, got ${describe(outcome.error)}${attemptNote(outcome.attempt)}`
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
	observed(attempt, sqlstate, (outcome) => {
		switch (outcome.kind) {
			case "succeeded":
				return Effect.fail(
					new ExpectationFailed({
						message: `expected a violation of ${constraint}, but the statement succeeded${attemptNote(outcome.attempt)}`
					})
				)
			case "not PostgreSQL's":
				return Effect.fail(
					new ExpectationFailed({
						message: `expected a violation of ${constraint}, but the failure is not a PostgreSQL error: ${describe(outcome.error)}${attemptNote(outcome.attempt)}`
					})
				)
			case "refused":
				if (outcome.fields.code !== sqlstate) {
					return Effect.fail(
						new ExpectationFailed({
							message: `expected SQLSTATE ${sqlstate} on ${constraint}, got ${describe(outcome.error)}${attemptNote(outcome.attempt)}`
						})
					)
				}
				if (outcome.fields.constraint !== constraint) {
					return Effect.fail(
						new ExpectationFailed({
							message: `expected a violation of ${constraint}, got ${outcome.fields.constraint ?? "no constraint"}: ${describe(outcome.error)}${attemptNote(outcome.attempt)}`
						})
					)
				}
				return Effect.succeed(outcome.fields)
		}
	})

/** A session that opens and rolls back its own transactions: a raw session or a psql writer. */
interface Transactional<E> {
	readonly begin: Effect.Effect<void, E>
	readonly rollback: Effect.Effect<void, E>
}

/**
 * One attempt of an explicit transaction, as the expectations take it: BEGIN on `session`, then `body`. When
 * SERIALIZABLE refuses `body` with 40001 or 40P01 the transaction is rolled back, so the attempt can run again from
 * BEGIN; any other failure leaves the transaction open and aborted, as `body` left it, for the caller to observe and
 * end.
 */
export const inTransaction = <A, E, R, S>(
	session: Transactional<S>,
	body: Effect.Effect<A, E, R>
): Effect.Effect<A, E | S, R> =>
	Effect.andThen(
		session.begin,
		Effect.tapError(body, (error) =>
			refusedBySerializable(error) ? session.rollback : Effect.void
		)
	)
