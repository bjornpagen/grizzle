/**
 * The substrate proofs' one door to a transaction and its verdict (test/pg/substrate): each proof writes the RFC's
 * lowering templates by hand, sends a transaction of them to PostgreSQL 19rc2, and judges what PostgreSQL did against
 * an independent model. PostgreSQL is the system under test, and the RFC's theorem is the oracle.
 *
 * A verdict is what the contract of a transaction fixes: it commits, or it is refused at one moment (a statement, or
 * the commit, where a deferred constraint is checked) with one SQLSTATE and the constraint PostgreSQL names. Which
 * constraint PostgreSQL names among several a state breaks depends on an order of rows and checks it does not promise,
 * so a model states the set PostgreSQL may name, and a judge requires the named one to be in it.
 */
import { Array as Arr, Effect, Option, Result } from "effect"
import { quoteIdent } from "#compiler/sql/print.ts"
import type { Moment } from "#test/support/families/mutate.ts"
import { elementAt } from "#test/support/oracle/pick.ts"
import type { RawQueryResult, SqlError } from "#test/support/pg.ts"
import {
	messageText,
	type PgErrorFields,
	pgErrorFields,
	TransactionRolledBack
} from "#test/support/substrate/errors.ts"
import { beginSerializable, type RawSession } from "#test/support/substrate/session.ts"

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
 * A statement of a transaction's pipeline: its text, and the moment of the transaction a refusal of it is, none for its
 * BEGIN, whose refusal is no verdict.
 */
interface Framed {
	readonly sql: string
	readonly moment: Option.Option<Moment>
}

/**
 * The pipeline of one transaction of `statements`: BEGIN, each statement at its own moment, and `closing`, the COMMIT,
 * or the SET CONSTRAINTS ALL IMMEDIATE that runs the checks the commit would, at the commit's moment.
 */
const framed = (
	statements: ReadonlyArray<string>,
	closing: string
): Arr.NonEmptyReadonlyArray<Framed> => [
	{ sql: beginSerializable, moment: Option.none() },
	...Arr.map(statements, (sql, index): Framed => ({
		sql,
		moment: Option.some({ kind: "statement", index })
	})),
	{ sql: closing, moment: Option.some({ kind: "commit" }) }
]

/**
 * `frame` on `session` in one write, BEGIN through its closing statement, as grizzle's adapter writes a transaction
 * (adapter/wire/batch.ts): the closing statement's answer, or the refusal of the first statement PostgreSQL refused, at
 * that statement's moment. Every statement after it was sent with it, each its own exchange ending in a Sync, and
 * PostgreSQL answers each as the aborted transaction's (25P02) and a COMMIT among them with ROLLBACK, so the first
 * refusal is the transaction's and a COMMIT has ended it. A refused BEGIN, or a failure that is no server error (a lost
 * connection), is no verdict, and fails the proof as it is.
 */
const sent = (
	session: RawSession,
	frame: Arr.NonEmptyReadonlyArray<Framed>
): Effect.Effect<Result.Result<RawQueryResult, Refused>, SqlError> =>
	session.pipeline(Arr.map(frame, (f) => f.sql)).pipe(
		Effect.map((answers) =>
			Result.succeed(elementAt(answers, frame.length - 1, "the transaction's closing answer"))
		),
		Effect.catchTag("PipelineRefused", (refused) => {
			const fields = pgErrorFields(refused.error)
			const at = elementAt(frame, refused.index, "the refused statement")
			return fields === undefined || Option.isNone(at.moment)
				? Effect.fail(refused.error)
				: Effect.succeed(
						Result.fail({ kind: "refused", moment: at.moment.value, fields } satisfies Refused)
					)
		})
	)

/**
 * One transaction of `statements` on `session`, sent in one write: BEGIN, each statement in order, and COMMIT. The
 * first statement PostgreSQL refuses ends it, rolled back at its COMMIT; a COMMIT PostgreSQL refuses has ended it. An
 * empty transaction is sent too, so a deferred check of nothing is still a COMMIT. A COMMIT answered with ROLLBACK
 * fails with TransactionRolledBack, as RawSession commit does.
 */
export const attempt = (
	session: RawSession,
	statements: ReadonlyArray<string>
): Effect.Effect<Attempted, SqlError | TransactionRolledBack> =>
	Effect.flatMap(
		sent(session, framed(statements, "COMMIT")),
		Result.match({
			onFailure: (refused): Effect.Effect<Attempted, TransactionRolledBack> =>
				Effect.succeed(refused),
			onSuccess: (closing) =>
				closing.command === "COMMIT"
					? Effect.succeed<Attempted>({ kind: "committed" })
					: Effect.fail(
							new TransactionRolledBack({ label: session.label, command: closing.command })
						)
		})
	)

/** What a checked transaction came to: the verdict its COMMIT would give, with what `read` found in it when accepted. */
export type Checked<A> = { readonly kind: "committed"; readonly read: A } | Refused

/**
 * One transaction of `statements` on `session` checked as its COMMIT would check it, and rolled back: BEGIN, each
 * statement in order, then SET CONSTRAINTS ALL IMMEDIATE, which runs every check the transaction deferred to its commit
 * at that statement (PostgreSQL's documented retroactive switch), so a refusal there is the commit's, at the commit's
 * moment, all sent in one write; then `read` of what the transaction left, and ROLLBACK, so none of its rows stays and
 * no case needs its rows cleared. A refusal leaves the transaction aborted, and ROLLBACK ends it; so does any failure,
 * so no failure leaves the session inside a transaction PostgreSQL aborted, where every later statement, the next
 * case's BEGIN among them, is refused with 25P02 and the failure a search reports is that, not its own.
 */
export const attemptChecked = <A>(
	session: RawSession,
	statements: ReadonlyArray<string>,
	read: Effect.Effect<A, SqlError>
): Effect.Effect<Checked<A>, SqlError> =>
	Effect.onError(
		Effect.gen(function* () {
			const answered = yield* sent(session, framed(statements, "SET CONSTRAINTS ALL IMMEDIATE"))
			const checked: Checked<A> = Result.isFailure(answered)
				? answered.failure
				: { kind: "committed", read: yield* read }
			yield* session.rollback
			return checked
		}),
		() => Effect.ignore(session.rollback)
	)

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
