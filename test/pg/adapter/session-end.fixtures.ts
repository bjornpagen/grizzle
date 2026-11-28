/** What session-end.test.ts reads: its cases and each case's run over `grizzle migrate`'s session. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Data, Effect, Exit, Fiber, Formatter, Result, Scope } from "effect"
import { openMigrationSession } from "#adapter/migrate/session.ts"
import { oneShotStatement } from "#adapter/wire/batch.ts"
import { holdSchemaSql, temporaryTablesSql } from "#test/pg/adapter/pool.fixtures.ts"
import { clusterConnection, parsedConnection } from "#test/support/pg.ts"
import {
	backendState,
	roleDefaults,
	substrateLogin,
	until
} from "#test/support/pg/adapter/support.ts"
import { testSql } from "#test/support/sql.ts"
import { superuserClient } from "#test/support/substrate/shared.ts"
import { freshSchema, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * How a case's migration session ends: its scope closed with nothing holding its backend's exit, its backend's drop of
 * its temporary relations held by the bootstrap superuser and then let go, or held and the close interrupted.
 */
export type SessionEndFeature = "unheld" | "held, let go" | "held, interrupted"

export const endings: Gen<SessionEndFeature> = (source) =>
	source.draw(element<SessionEndFeature>(["unheld", "held, let go", "held, interrupted"]))

/** The temporary tables a case's migration session makes, as many as a session of pantry's export suite held. */
const sessionTables = 150

class Ended extends Data.TaggedError("Ended")<{ readonly message: string }> {}

/**
 * Opens the migration identity's session as `grizzle migrate` does (migrate/session.ts openMigrationSession), as a
 * login of its own with TEMPORARY on the database; makes its temporary tables and reads its backend and temporary
 * schema; then closes the session's scope as `grizzle migrate` returns. Unheld, no backend of it is left in
 * pg_stat_activity once the close returns. Held, the close has not returned while the backend waits on the hold; let
 * go, it returns and leaves no backend; interrupted, it ends at once, the session destroyed.
 */
export const runEnding = (ending: SessionEndFeature, c: Case<SessionEndFeature>) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const schema = yield* s.schema(freshSchema)
		const login = yield* substrateLogin(schema, "migrator", roleDefaults)
		const scope = yield* Effect.scope
		const sessionScope = yield* Scope.fork(scope)
		const session = yield* Scope.provide(
			openMigrationSession(
				parsedConnection(clusterConnection(s.cluster, s.database, login.password), login.role)
			),
			sessionScope
		)
		const answers = yield* session.apart([
			oneShotStatement(testSql(temporaryTablesSql(sessionTables)), []),
			oneShotStatement(
				testSql(
					"SELECT pg_catalog.pg_backend_pid()::text, pg_catalog.pg_my_temp_schema()::regnamespace::text"
				),
				[]
			)
		])
		const read = answers[1]
		if (read === undefined || Result.isFailure(read)) {
			return yield* new Ended({
				message: `the session read no backend: ${Formatter.format(answers)}`
			})
		}
		const [row] = read.success.rows
		const pid = Number(row?.[0])
		const temporary = String(row?.[1])
		c.note(ending)
		if (ending === "unheld") {
			yield* Scope.close(sessionScope, Exit.void)
			const left = yield* backendState(pid)
			if (left.state !== "gone") {
				return yield* new Ended({
					message: `the session's backend ${String(pid)} is ${left.state} once its close returned`
				})
			}
			return
		}
		const holder = yield* superuserClient(s.cluster, s.database, "migration exit holder")
		yield* holder.query("BEGIN", [])
		yield* holder.query(holdSchemaSql(temporary), [])
		const closing = yield* Effect.forkChild(Scope.close(sessionScope, Exit.void), {
			startImmediately: true
		})
		yield* until(
			Effect.map(backendState(pid), (b) => b.state !== "gone" && b.waitEvent === "object")
		)
		if (closing.pollUnsafe() !== undefined) {
			return yield* new Ended({
				message: `the close returned while the backend ${String(pid)} still dropped its temporary relations`
			})
		}
		if (ending === "held, let go") {
			yield* holder.query("COMMIT", [])
			const closed = yield* Fiber.await(closing)
			const left = yield* backendState(pid)
			if (!Exit.isSuccess(closed) || left.state !== "gone") {
				return yield* new Ended({
					message: `the close let go ended ${Formatter.format(closed)} with the backend ${left.state}`
				})
			}
			return
		}
		const closed = yield* Effect.andThen(Fiber.interrupt(closing), Fiber.await(closing))
		yield* holder.query("COMMIT", [])
		if (!Exit.hasInterrupts(closed)) {
			return yield* new Ended({
				message: `the interrupted close ended ${Formatter.format(closed)}`
			})
		}
		yield* until(Effect.map(backendState(pid), (b) => b.state === "gone"))
	})
