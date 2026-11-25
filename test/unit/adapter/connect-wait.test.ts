/**
 * A connection attempt waits for its server's own answer, however late it comes (packages/grizzle/src/adapter/wire/
 * session.ts): grizzle sets no connect timeout, and DbConnection states none, so the attempt ends with what the server
 * answers or with the failure the operating system reports, never with a clock's verdict. clientConfig hands pg
 * `connectionTimeoutMillis: 0`, the one value for which pg 8.23 sets no timer.
 *
 * The server is the in-memory PostgreSQL behind grizzle's public transport and verify-full TLS
 * (test/unit/adapter/pool.fixtures.ts FakeServer). It holds each startup's answer, and answers it only once the wall
 * clock has run `heldFor` past the startup's arrival. heldFor is the 5,000 ms connect timeout edullm's pantry stated,
 * which failed P5's `grizzle migrate` on a loaded machine (one TLS connect in 16 took 15.5 s). pg's own timer, where one
 * is set, starts before the startup is sent, so a cap of that size runs out before the server answers. The attempt is
 * made over both connect paths: `grizzle migrate`'s owner session (migrate/session.ts openMigrationSession), and a Db's
 * lease from a login's pool (wire/pool.ts makePool), each of which must connect.
 *
 * Oracle: the specification, a session once the server answers ready. The box is exhausted: both paths.
 * Features: each path connected.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Cause, Effect, Exit, Fiber } from "effect"
import pgDriver from "pg"
import { openMigrationSession } from "#adapter/migrate/session.ts"
import { makePool } from "#adapter/wire/pool.ts"
import { servedSession } from "#compiler/program/served.ts"
import { noPassword, parsedConnection } from "#test/support/pg.ts"
import { FakeServer, wallClock } from "#test/unit/adapter/pool.fixtures.ts"

/** The connect paths: `grizzle migrate`'s owner session, and a lease of a login's pool, as a Db's call takes one. */
const paths = ["grizzle migrate", "a Db's lease"] as const
type Path = (typeof paths)[number]

type ConnectWaitFeature = `${Path} connected`

/**
 * How long the server holds a startup's answer once the startup has arrived: the 5,000 ms connect timeout edullm's
 * pantry stated, which P5's migrate met. The test's own time: it names no bound of grizzle's, which has none.
 */
const heldFor = 5_000

/** The attempt over `path` to `server`, closed with its scope once it has connected; a failure is its message. */
const attemptOver = (server: FakeServer, path: Path): Effect.Effect<void, string> => {
	const connection = parsedConnection(
		{ driver: pgDriver, transport: server.transport, database: "fake", password: noPassword },
		"fake"
	)
	switch (path) {
		case "grizzle migrate":
			return Effect.scoped(openMigrationSession(connection)).pipe(
				Effect.asVoid,
				Effect.mapError((error) => error.message)
			)
		case "a Db's lease":
			return Effect.scoped(
				Effect.flatMap(
					makePool({
						connection,
						session: servedSession,
						bounds: { max: 1 }
					}),
					(pool) => Effect.scoped(pool.lease)
				)
			).pipe(
				Effect.asVoid,
				Effect.mapError((error) => error.message)
			)
	}
}

/** A connection attempt waits for its server's answer past the 5,000 ms connect timeout P5's migrate met, and connects. */
export const aConnectionAttemptWaitsForItsServersAnswerPastTheConnectTimeoutP5sMigrateMetAndConnects =
	property.exhaust(
		finite((source) => source.draw(element(paths))),
		{
			needs: {},
			situations: ["grizzle migrate connected", "a Db's lease connected"] satisfies ReadonlyArray<
				Reached<ConnectWaitFeature>
			>,
			check: (_, c: Case<ConnectWaitFeature>) => (path) =>
				Effect.gen(function* () {
					const server = new FakeServer()
					server.holding = true
					const attempt = yield* Effect.forkChild(attemptOver(server, path), {
						startImmediately: true
					})
					yield* server.startupHeld()
					yield* wallClock(heldFor)
					server.releaseHeld()
					const exit = yield* Fiber.await(attempt)
					assert.ok(
						Exit.isSuccess(exit),
						`${path}: the attempt ended before the server answered: ${Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""}`
					)
					assert.equal(server.opened, 1, `${path}: one connection, never a second attempt`)
					c.note(`${path} connected`)
				}),
			oracle: {
				kind: "specification",
				name: "a session once the server answers ready, whenever it answers"
			},
			box: "both connect paths, the server answering each startup 5,000 ms after it arrived",
			kept: [],
			kills: [
				{
					file: "packages/grizzle/src/adapter/wire/session.ts",
					original: "\tconnectionTimeoutMillis: 0,",
					replacement: "\tconnectionTimeoutMillis: 5000,",
					why: "pg's connect timer is back at the 5,000 ms P5's migrate met: it runs out before the server answers, and both paths fail with pg's 'timeout expired'."
				}
			]
		}
	)
