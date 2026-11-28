import { Effect, Option, Result } from "effect"
import type { ConstraintName } from "#compiler/core/ids.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"

/** What the server answered a probe: admitted, or refused with a SQLSTATE and the constraint it named. */
export type Verdict =
	| { readonly kind: "admitted" }
	| {
			readonly kind: "refused"
			readonly code: string
			readonly constraint: Option.Option<ConstraintName>
	  }

/**
 * Runs `sql` with `params` under a savepoint of the pinned session's open transaction, rolled back to when the server
 * refuses it. A connection failure is the case's defect, not a verdict.
 */
export const probe = (
	pinned: PgConnection,
	sql: string,
	params: ReadonlyArray<unknown>
): Effect.Effect<Verdict, SqlError> =>
	Effect.gen(function* () {
		yield* pinned.query("SAVEPOINT probe", [])
		const ran = yield* Effect.result(pinned.query(sql, params))
		if (Result.isSuccess(ran)) {
			yield* pinned.query("RELEASE SAVEPOINT probe", [])
			return { kind: "admitted" } satisfies Verdict
		}
		const reason = ran.failure.reason
		if (reason._tag !== "ServerError") {
			return yield* ran.failure
		}
		yield* pinned.query("ROLLBACK TO SAVEPOINT probe", [])
		return {
			kind: "refused",
			code: reason.fields.code,
			constraint: Option.fromUndefinedOr(reason.fields.constraint)
		} satisfies Verdict
	})

/**
 * A probe's verdict judged against the host meaning of the declaration that installs `check`: a probe runs inside the
 * case's transaction under a savepoint (probe), so a refusal aborts only the probe, and PostgreSQL must admit it exactly
 * when the host meaning holds (`holds`), and refuse every other with 23514 naming the CHECK the declaration installs, as
 * the naming door names it (test/support/kernel/naming.ts). A wrong or missing CHECK is a probe the server judges
 * otherwise. The problems, each a line, or none.
 */
export const judged = (
	what: string,
	holds: boolean,
	verdict: Verdict,
	check: ConstraintName
): ReadonlyArray<string> => {
	if (verdict.kind === "admitted") {
		return holds ? [] : [`${what}: the declaration refuses it (${check}), the server admitted it`]
	}
	const named = Option.match(verdict.constraint, {
		onNone: () => "naming no constraint",
		onSome: (c) => `naming ${c}`
	})
	if (holds) {
		return [`${what}: the declaration admits it, the server refused it (${verdict.code} ${named})`]
	}
	return verdict.code === "23514" && Option.contains(verdict.constraint, check)
		? []
		: [`${what}: refused with ${verdict.code} ${named}, not 23514 ${check}`]
}
