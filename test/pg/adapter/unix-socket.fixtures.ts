/** What unix-socket.test.ts reads: its connect paths and each case's run over the member's Unix socket. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Cause, Effect, Exit, Fiber, Result } from "effect"
import { BatchRefused } from "#adapter/errors/failures.ts"
import { makePool } from "#adapter/wire/pool.ts"
import { connectSession, type Session } from "#adapter/wire/session.ts"
import { servedSession } from "#compiler/program/served.ts"
import { clusterSocketConnection, parsedConnection } from "#test/support/pg.ts"
import {
	backendState,
	roleDefaults,
	rowsOn,
	substrateLogin,
	until
} from "#test/support/pg/adapter/support.ts"
import { superuserClient } from "#test/support/substrate/shared.ts"
import { freshSchema, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * How a case's session reaches the member's socket: an owner's session outside any pool (`grizzle migrate`'s, the live
 * leader's), or a lease of a login's pool, as a Db's call takes one.
 */
export type SocketPath = "an owner's session" | "a login's lease"

export const socketPaths: Gen<SocketPath> = (source) =>
	source.draw(element<SocketPath>(["an owner's session", "a login's lease"]))

/** A session over `path` for `role`, on the member's socket, for the scope. */
const sessionOver = (path: SocketPath, role: string) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const connection = parsedConnection(clusterSocketConnection(s.cluster, s.database), role)
		switch (path) {
			case "an owner's session":
				return yield* connectSession({ ...connection, controls: servedSession })
			case "a login's lease":
				return yield* Effect.flatMap(
					makePool({ connection, session: servedSession, bounds: { max: 1 } }),
					(pool) => pool.lease
				)
		}
	})

/**
 * What the server says of a session's own connection: its backend, its session user, whether its client is local (no
 * client address, which PostgreSQL gives a Unix socket's connection alone), and whether it is TLS.
 */
const connectionFacts = (session: Session) =>
	Effect.map(
		rowsOn(
			session,
			"SELECT pg_catalog.pg_backend_pid()::text, session_user::text, (pg_catalog.inet_client_addr() IS NULL)::text, COALESCE((SELECT a.ssl FROM pg_catalog.pg_stat_ssl a WHERE a.pid = pg_catalog.pg_backend_pid()), false)::text",
			[]
		),
		(rows) => {
			const row = rows[0] ?? []
			return {
				pid: Number(row[0]),
				user: String(row[1]),
				local: String(row[2]),
				tls: String(row[3])
			}
		}
	)

/**
 * Opens a session over `path` on the member's Unix socket as a login of the case's own, which the member's `local`
 * line admits with no password; reads what the server says of its connection, a local client with no TLS signed in as
 * the login; then blocks a statement of it on an advisory lock the bootstrap superuser holds, cancels it with the
 * session's CancelRequest, which goes over a second connection to the socket, and reads the statement's refusal,
 * 57014 query_canceled.
 */
export const runOverSocket = (path: SocketPath, c: Case<SocketPath>) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const schema = yield* s.schema(freshSchema)
		const login = yield* substrateLogin(schema, "socketeer", roleDefaults)
		yield* s.cluster.budget.within(2)
		const session = yield* sessionOver(path, login.role)
		const facts = yield* connectionFacts(session)
		yield* s.cluster.budget.hold(facts.pid)
		assert.deepEqual(
			{ user: facts.user, local: facts.local, tls: facts.tls },
			{ user: login.role, local: "true", tls: "false" },
			`${path}: the session signs in as its login over the member's socket, a local client with no TLS`
		)
		const holder = yield* superuserClient(s.cluster, s.database, "unix socket lock holder")
		yield* holder.query("SELECT pg_catalog.pg_advisory_lock($1::bigint)", [String(facts.pid)])
		const blocked = yield* Effect.forkChild(
			rowsOn(session, "SELECT 1::text FROM pg_catalog.pg_advisory_lock($1::bigint)", [
				String(facts.pid)
			]),
			{ startImmediately: true }
		)
		yield* until(
			Effect.map(backendState(facts.pid), (b) => b.state !== "gone" && b.waitEvent === "advisory")
		)
		const end = yield* session.cancel
		assert.equal(end, "sent", `${path}: the CancelRequest reaches the server over the socket`)
		const exit = yield* Fiber.await(blocked)
		const error = Exit.isFailure(exit) ? Exit.findError(exit) : Result.fail(undefined)
		assert.ok(
			Result.isSuccess(error) &&
				error.success instanceof BatchRefused &&
				error.success.failure.sqlstate === "57014",
			`${path}: the blocked statement is cancelled, 57014: ${Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "it ran"}`
		)
		yield* holder.query("SELECT pg_catalog.pg_advisory_unlock($1::bigint)", [String(facts.pid)])
		c.note(path)
	})
