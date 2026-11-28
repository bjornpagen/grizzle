/**
 * A connection over the server's Unix socket (types/layer.ts UnixSocketTransport) carries no SSLRequest, no TLS and no
 * password, and its CancelRequest goes over a connection of its own to the same socket (packages/grizzle/src/adapter/
 * wire/session.ts).
 *
 * The server is a PostgreSQL of the test's own listening on a Unix socket in a directory of its own
 * (unix-socket.fixtures.ts UnixSocketServer), which answers each startup by the authentication the case names. Over
 * both connect paths, an owner's session (`grizzle migrate`'s and the live leader's, wire/session.ts connectSession)
 * and a lease of a login's pool (wire/pool.ts makePool), and under a process environment that sets none of the
 * variables pg reads for a setting it is not given, or every one of them (PGSSLMODE requiring TLS, PGPASSWORD, PGUSER,
 * PGDATABASE, PGHOST and PGPORT):
 * - the connection's first message is its startup packet, never an SSLRequest, naming the configured role and
 *   database;
 * - under `peer`, the account the kernel names, the attempt connects, and the session's CancelRequest is `sent` and
 *   reaches the server on a second connection to the socket, whose only bytes are the 16-byte CancelRequest carrying
 *   the key the server gave the session;
 * - under each password method the server may ask by (cleartext, the salted hash, SCRAM-SHA-256), the attempt fails with
 *   PasswordAsked, and no password message reaches the server.
 *
 * Oracle: the protocol's specification (a Unix socket's startup is the first message, CancelRequest is four Int32s on
 * a connection of its own) and the transport's (no password over a Unix socket). The box is exhausted: each path,
 * authentication and environment. Features: each path's session cancelled and each path's refusal.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Cause, Effect, Exit, Option, Result, type Scope } from "effect"
import pgDriver from "pg"
import { type AcquireRefusal, PasswordAsked } from "#adapter/errors/failures.ts"
import { makePool } from "#adapter/wire/pool.ts"
import { connectSession, type Session } from "#adapter/wire/session.ts"
import { servedSession } from "#compiler/program/served.ts"
import { parsedConnection } from "#test/support/pg.ts"
import { processEnvironment } from "#test/support/process-env.ts"
import {
	type Authentication,
	authentications,
	startupOf,
	UnixSocketServer
} from "#test/unit/adapter/unix-socket.fixtures.ts"

/** The connect paths: an owner's session outside any pool, and a lease of a login's pool, as a Db's call takes one. */
const paths = ["an owner's session", "a Db's lease"] as const
type Path = (typeof paths)[number]

/**
 * The process environments: none of the variables pg reads for a setting it is not given, or each of them at a value
 * that would turn TLS on, send a password, or connect elsewhere as another role, were pg to read it.
 */
const environments = ["none set", "every PG variable set"] as const
type Environment = (typeof environments)[number]

const pgVariables = {
	PGSSLMODE: "require",
	PGPASSWORD: "pw-from-the-environment",
	PGUSER: "someone_else",
	PGDATABASE: "elsewhere",
	PGHOST: "/nowhere",
	PGPORT: "1"
} as const

type UnixSocketFeature = `${Path} cancelled` | `${Path} refused for a password`

/** The port the server's socket file is named by: the test's own, which names no TCP port. */
const port = 5432

/** The role and the database every attempt names. */
const role = "socket_role"
const database = "socket_db"

/** A session over `path` to `server`'s socket, for the scope, or the attempt's refusal. */
const attemptOver = (
	server: UnixSocketServer,
	path: Path
): Effect.Effect<Session, AcquireRefusal, Scope.Scope> => {
	const connection = parsedConnection(
		{
			driver: pgDriver,
			transport: { kind: "unixSocket", directory: server.directory, port },
			database
		},
		role
	)
	switch (path) {
		case "an owner's session":
			return connectSession({ ...connection, controls: servedSession })
		case "a Db's lease":
			return Effect.flatMap(
				makePool({ connection, session: servedSession, bounds: { max: 1 } }),
				(pool) => pool.lease
			)
	}
}

/** Every PG variable pg reads for a setting it is not given, at `environment`'s values, for the scope. */
const environmentOf = (environment: Environment): Effect.Effect<void, never, Scope.Scope> =>
	processEnvironment({
		PGSSLMODE: Option.none(),
		PGPASSWORD: Option.none(),
		PGUSER: Option.none(),
		PGDATABASE: Option.none(),
		PGHOST: Option.none(),
		PGPORT: Option.none(),
		...(environment === "every PG variable set"
			? {
					PGSSLMODE: Option.some(pgVariables.PGSSLMODE),
					PGPASSWORD: Option.some(pgVariables.PGPASSWORD),
					PGUSER: Option.some(pgVariables.PGUSER),
					PGDATABASE: Option.some(pgVariables.PGDATABASE),
					PGHOST: Option.some(pgVariables.PGHOST),
					PGPORT: Option.some(pgVariables.PGPORT)
				}
			: {})
	})

/**
 * Over a Unix socket a connection sends its startup first, no SSLRequest and no password, and cancels over a second
 * connection to the socket.
 */
export const overAUnixSocketAConnectionSendsItsStartupFirstNoSslRequestAndNoPasswordAndCancelsOverASecondConnection =
	property.exhaust(
		finite((source) => ({
			path: source.draw(element(paths)),
			authentication: source.draw(element<Authentication>(authentications)),
			environment: source.draw(element(environments))
		})),
		{
			needs: {},
			situations: [
				"an owner's session cancelled",
				"a Db's lease cancelled",
				"an owner's session refused for a password",
				"a Db's lease refused for a password"
			] satisfies ReadonlyArray<Reached<UnixSocketFeature>>,
			check:
				(_, c: Case<UnixSocketFeature>) =>
				({ path, authentication, environment }) =>
					Effect.scoped(
						Effect.gen(function* () {
							yield* environmentOf(environment)
							const server = yield* UnixSocketServer.opened(authentication, port)
							const exit = yield* Effect.exit(Effect.scoped(attempt(server, path, authentication)))
							yield* server.allClosed
							const parameters = onlyStartupOrCancel(server)
							assert.equal(
								parameters.get("user"),
								role,
								`${path}: the startup names the configured role`
							)
							assert.equal(
								parameters.get("database"),
								database,
								`${path}: the startup names the configured database`
							)
							assert.ok(
								Arr.every(server.accepted, (a) => !a.passwordSent),
								`${path}: no password message reaches the server`
							)
							if (authentication === "peer") {
								assert.ok(
									Exit.isSuccess(exit),
									`${path}: the attempt connects under peer: ${Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""}`
								)
								c.note(`${path} cancelled`)
								return
							}
							const error = Exit.isFailure(exit) ? Exit.findError(exit) : Result.fail(undefined)
							assert.ok(
								Result.isSuccess(error) && error.success instanceof PasswordAsked,
								`${path}: a password asked over a Unix socket fails the attempt with PasswordAsked: ${Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "it connected"}`
							)
							c.note(`${path} refused for a password`)
						})
					),
			oracle: {
				kind: "specification",
				name: "the protocol's startup and CancelRequest over a Unix socket, and no password over one"
			},
			box: "both connect paths, each authentication a local line names, and the PG variables pg reads set or not",
			kept: [],
			kills: [
				{
					file: "packages/grizzle/src/adapter/wire/session.ts",
					original: "\t\t\treturn { host: transport.directory, port: transport.port, ssl: false }",
					replacement: "\t\t\treturn { host: transport.directory, port: transport.port, ssl: {} }",
					why: "pg sends an SSLRequest on the Unix socket, which no server there answers with TLS: the first message the server reads is an SSLRequest."
				},
				{
					file: "packages/grizzle/src/adapter/wire/session.ts",
					original: "\t\t\treturn () => Promise.reject(new PasswordAsked())",
					replacement: '\t\t\treturn () => Promise.resolve("")',
					why: "An empty password is sent when the server asks for one over a Unix socket: a password message reaches the server, and the attempt fails with no PasswordAsked."
				},
				{
					file: "packages/grizzle/src/adapter/wire/session.ts",
					original: '\t\t\tend = "sent"\n\t\t\tsocket.write(cancelFrame(key))',
					replacement: '\t\t\tend = "sent"\n\t\t\tsocket.write(sslRequest())',
					why: "A socket session's cancel writes an SSLRequest where its CancelRequest belongs: the second connection carries no CancelRequest of the session's key."
				}
			]
		}
	)

/**
 * The attempt over `path`, and, for a session, its CancelRequest: `sent`, and the server's second connection the
 * CancelRequest alone, carrying the key the server gave the session.
 */
const attempt = (
	server: UnixSocketServer,
	path: Path,
	authentication: Authentication
): Effect.Effect<void, AcquireRefusal, Scope.Scope> =>
	Effect.gen(function* () {
		const session = yield* attemptOver(server, path)
		assert.equal(
			authentication,
			"peer",
			`${path}: a session opened though the server asked for a password`
		)
		const end = yield* session.cancel
		assert.equal(end, "sent", `${path}: the CancelRequest is written`)
		assert.equal(server.accepted.length, 2, `${path}: the CancelRequest takes a second connection`)
		const [opened, cancelled] = server.accepted
		const key = opened?.key
		const first = cancelled?.first
		assert.ok(key !== undefined && Option.isSome(key), `${path}: the server gave the session a key`)
		assert.ok(
			first !== undefined && Option.isSome(first),
			`${path}: the second connection sent a message`
		)
		assert.deepEqual(
			first.value,
			{ kind: "cancel", processId: key.value.processId, secretKey: key.value.secretKey, bytes: 16 },
			`${path}: the second connection carries the 16-byte CancelRequest of the session's key alone`
		)
	})

/**
 * The startup of the first connection the server accepted, its every later connection a CancelRequest: a connection's
 * first message is never an SSLRequest.
 */
const onlyStartupOrCancel = (server: UnixSocketServer): ReadonlyMap<string, string> => {
	const [opened, ...rest] = server.accepted
	assert.ok(opened !== undefined, "a connection reaches the server")
	for (const later of rest) {
		assert.ok(
			Option.isSome(later.first) && later.first.value.kind === "cancel",
			"a later connection carries a CancelRequest"
		)
	}
	return startupOf(opened)
}
