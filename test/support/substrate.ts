/**
 * The substrate proofs' one door to a transaction and its verdict (test/pg/substrate): each proof writes the RFC's
 * lowering templates by hand, sends a transaction of them to PostgreSQL 19rc1, and judges what PostgreSQL did against
 * an independent model. PostgreSQL is the system under test, and the RFC's theorem is the oracle.
 *
 * A verdict is what the contract of a transaction fixes: it commits, or it is refused at one moment (a statement, or
 * the commit, where a deferred constraint is checked) with one SQLSTATE and the constraint PostgreSQL names. Which
 * constraint PostgreSQL names among several a state breaks depends on an order of rows and checks it does not promise,
 * so a model states the set PostgreSQL may name, and a judge requires the named one to be in it.
 */
import { Array as Arr, Effect, Option } from "effect"
import { quoteIdent } from "#compiler/sql/print.ts"
import type { Moment } from "#test/support/families/mutate.ts"
import type { SqlError } from "#test/support/pg.ts"
import {
	messageText,
	type PgErrorFields,
	pgErrorFields,
	type TransactionRolledBack
} from "#test/support/substrate/errors.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

/** What PostgreSQL did with one transaction: it committed, or refused it at a moment with its error's fields. */
export type Attempted =
	| { readonly kind: "committed" }
	| { readonly kind: "refused"; readonly moment: Moment; readonly fields: PgErrorFields }

/**
 * The fields of the PostgreSQL error `effect` fails with, or none when it succeeds. A failure that is no server error
 * (a lost connection) is no verdict, and fails the proof as it is.
 */
export const refusalOf = <A, E, R>(
	effect: Effect.Effect<A, E, R>
): Effect.Effect<Option.Option<PgErrorFields>, E, R> =>
	Effect.matchEffect(effect, {
		onSuccess: () => Effect.succeedNone,
		onFailure: (error) => {
			const fields = pgErrorFields(error)
			return fields === undefined ? Effect.fail(error) : Effect.succeedSome(fields)
		}
	})

/** A transaction's refusal: the moment PostgreSQL refused it, and its error's fields. */
type Refused = Extract<Attempted, { readonly kind: "refused" }>

/**
 * `effect`, run in `session`'s open transaction: a failure that is no refusal ends the transaction with ROLLBACK before
 * it goes on, so no failure leaves the session inside a transaction PostgreSQL aborted, where every later statement,
 * the next case's BEGIN among them, is refused with 25P02 and the failure a search reports is that, not its own.
 */
const inTransaction = <A, E>(
	session: RawSession,
	effect: Effect.Effect<A, E>
): Effect.Effect<A, E> => Effect.onError(effect, () => Effect.ignore(session.rollback))

/**
 * BEGIN and each of `statements` in order: the refusal of the first PostgreSQL refuses, the transaction rolled back, or
 * none, the transaction still open.
 */
const opened = (
	session: RawSession,
	statements: ReadonlyArray<string>
): Effect.Effect<Option.Option<Refused>, SqlError> =>
	Effect.gen(function* () {
		yield* session.begin
		return yield* inTransaction(
			session,
			Effect.gen(function* () {
				for (const [index, sql] of statements.entries()) {
					const refused = yield* refusalOf(session.query(sql, []))
					if (Option.isSome(refused)) {
						yield* session.rollback
						return Option.some({
							kind: "refused",
							moment: { kind: "statement", index },
							fields: refused.value
						} satisfies Refused)
					}
				}
				return Option.none()
			})
		)
	})

/**
 * One transaction of `statements` on `session`: BEGIN, each statement in order, and COMMIT. The first statement
 * PostgreSQL refuses ends it, rolled back; a COMMIT PostgreSQL refuses has already ended it. An empty transaction is
 * sent too, so a deferred check of nothing is still a COMMIT.
 */
export const attempt = (
	session: RawSession,
	statements: ReadonlyArray<string>
): Effect.Effect<Attempted, SqlError | TransactionRolledBack> =>
	Effect.gen(function* () {
		const refusedAt = yield* opened(session, statements)
		if (Option.isSome(refusedAt)) {
			return refusedAt.value
		}
		const refused = yield* inTransaction(session, refusalOf(session.commit))
		return Option.match(refused, {
			onNone: (): Attempted => ({ kind: "committed" }),
			onSome: (fields): Attempted => ({ kind: "refused", moment: { kind: "commit" }, fields })
		})
	})

/** What a checked transaction came to: the verdict its COMMIT would give, with what `read` found in it when accepted. */
export type Checked<A> = { readonly kind: "committed"; readonly read: A } | Refused

/**
 * One transaction of `statements` on `session` checked as its COMMIT would check it, and rolled back: BEGIN, each
 * statement in order, then SET CONSTRAINTS ALL IMMEDIATE, which runs every check the transaction deferred to its commit
 * at that statement (PostgreSQL's documented retroactive switch), so a refusal there is the commit's, at the commit's
 * moment; then `read` of what the transaction left, and ROLLBACK, so none of its rows stays and no case needs its rows
 * cleared.
 */
export const attemptChecked = <A>(
	session: RawSession,
	statements: ReadonlyArray<string>,
	read: Effect.Effect<A, SqlError>
): Effect.Effect<Checked<A>, SqlError> =>
	Effect.gen(function* () {
		const refusedAt = yield* opened(session, statements)
		if (Option.isSome(refusedAt)) {
			return refusedAt.value
		}
		return yield* inTransaction(
			session,
			Effect.gen(function* () {
				const refused = yield* refusalOf(session.query("SET CONSTRAINTS ALL IMMEDIATE", []))
				if (Option.isSome(refused)) {
					yield* session.rollback
					return {
						kind: "refused",
						moment: { kind: "commit" },
						fields: refused.value
					} satisfies Refused
				}
				const found = yield* read
				yield* session.rollback
				return { kind: "committed", read: found } satisfies Checked<A>
			})
		)
	})

/** A moment as a report reads it. */
export const momentText = (moment: Moment): string =>
	moment.kind === "commit" ? "at commit" : `at statement ${moment.index}`

/** Whether two moments are the same. */
export const sameMoment = (a: Moment, b: Moment): boolean =>
	a.kind === "commit" ? b.kind === "commit" : b.kind === "statement" && a.index === b.index

/**
 * A refusal as a report reads it: its SQLSTATE, the constraint PostgreSQL names, and its message and DETAIL, a 40001's
 * reason code among them.
 */
export const refusalText = (fields: PgErrorFields): string =>
	`${fields.code} on ${fields.constraint ?? "no constraint"} (${messageText(fields)})`

/** An identifier of a proof's own schema, quoted, joined to a name in it. */
export const qualified = (schema: string, name: string): string =>
	`${quoteIdent(schema)}.${quoteIdent(name)}`

/** The SQL text of an int8 list, `(a, b, …)`, for an IN list or a VALUES row. */
export const tuple = (values: ReadonlyArray<number | bigint | string>): string =>
	`(${Arr.join(
		Arr.map(values, (v) => String(v)),
		", "
	)})`
