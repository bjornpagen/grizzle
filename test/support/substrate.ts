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
		yield* session.begin
		for (const [index, sql] of statements.entries()) {
			const refused = yield* refusalOf(session.query(sql, []))
			if (Option.isSome(refused)) {
				yield* session.rollback
				return {
					kind: "refused",
					moment: { kind: "statement", index },
					fields: refused.value
				} satisfies Attempted
			}
		}
		const refused = yield* refusalOf(session.commit)
		return Option.match(refused, {
			onNone: (): Attempted => ({ kind: "committed" }),
			onSome: (fields): Attempted => ({ kind: "refused", moment: { kind: "commit" }, fields })
		})
	})

/** A moment as a report reads it. */
export const momentText = (moment: Moment): string =>
	moment.kind === "commit" ? "at commit" : `at statement ${moment.index}`

/** Whether two moments are the same. */
export const sameMoment = (a: Moment, b: Moment): boolean =>
	a.kind === "commit" ? b.kind === "commit" : b.kind === "statement" && a.index === b.index

/** A refusal as a report reads it: its SQLSTATE, the constraint PostgreSQL names, and its message. */
export const refusalText = (fields: PgErrorFields): string =>
	`${fields.code} on ${fields.constraint ?? "no constraint"} (${fields.message})`

/** An identifier of a proof's own schema, quoted, joined to a name in it. */
export const qualified = (schema: string, name: string): string =>
	`${quoteIdent(schema)}.${quoteIdent(name)}`

/** The SQL text of an int8 list, `(a, b, …)`, for an IN list or a VALUES row. */
export const tuple = (values: ReadonlyArray<number | bigint | string>): string =>
	`(${Arr.join(
		Arr.map(values, (v) => String(v)),
		", "
	)})`
