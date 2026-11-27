/**
 * The stored state a case reads beside what it writes, committed once per member into its template through ordinary
 * writes, each judged at its COMMIT as every earlier transaction's rows were: the production path of rows a case reads
 * as stored. A case over a clone of the template (Substrate.rolledBack) then writes in its own transaction, whose
 * judge's deltas hold its rows alone, and pays no judging of the stored state.
 */

import { Effect } from "effect"
import type { Installed } from "#test/support/install-migrate.ts"
import { standUpJudge } from "#test/support/judge.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import { beginSerializable } from "#test/support/substrate/session.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A template's seed (install-migrate.ts seededTemplate) that commits `statements` of the installation it seeds as the
 * owner: the judge's session tables stood up, then one SERIALIZABLE transaction of the statements, committed, so every
 * rule over a query judges them at the COMMIT and a load that breaks a law fails the template's build.
 */
export const storedSeed =
	(statements: (installed: Installed) => ReadonlyArray<string>) => (installed: Installed) =>
		Effect.gen(function* () {
			const substrate = yield* Substrate
			const session = yield* substrate.session({ ...ownerSession(), label: "stored" })
			yield* standUpJudge(session, installed.installation)
			yield* session.begin
			for (const sql of statements(installed)) {
				yield* session.query(sql, [])
			}
			yield* session.commit
		})

/**
 * `statements` committed on `connection`'s backend as stored rows a case then writes beside, in one SERIALIZABLE
 * transaction of their own, judged at its COMMIT: where a case's stored rows differ from case to case and are too few to
 * be worth a template of their own (storedSeed). The case's own transaction begins after it, so its judge's deltas hold
 * its rows alone.
 */
export const committedOn = (
	connection: Pick<PgConnection, "query">,
	statements: ReadonlyArray<string>
): Effect.Effect<void, SqlError> =>
	Effect.gen(function* () {
		yield* connection.query(beginSerializable, [])
		for (const sql of statements) {
			yield* connection.query(sql, [])
		}
		yield* connection.query("COMMIT", [])
	})
