/**
 * A template build ends the backends its database still holds only once its own sessions have closed
 * (test/support/substrate/substrate.ts builtThenEnded, backendsEnded): the build's scope closes first, its sessions
 * ending by their own close and their finalizers' statements answered, and then every backend still in the database is
 * ended, so CREATE DATABASE ... TEMPLATE meets none (55006). Run inside the build's scope, the end terminated the build's
 * own sessions while it held them, and their closing statements met 57P01: TOOLCHAIN6 counted 49 such terminations in
 * 15 minutes, every one a template build database's (2026-11-21).
 *
 * Each case builds as installTemplate's build does, over a database of its own (pg.ts freshDatabase): it opens one to
 * three raw sessions there as the owner, each of which sends a statement as it closes, the last work a build's sessions
 * do (a psql writer's end of its backend, an allocation's drop), then ends the database's backends. The oracle is
 * PostgreSQL: no session's closing statement is refused.
 *
 * Features: none beyond the box, one to three sessions.
 */

import { assert } from "@bjornpagen/testing/assert"
import { finite, int } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Effect, Formatter, Ref, Result } from "effect"
import { freshDatabase } from "#test/support/pg.ts"
import { openSession } from "#test/support/substrate/session.ts"
import { backendsEnded, builtThenEnded, Substrate } from "#test/support/substrate/substrate.ts"

/** A build ends its database's backends only once its own sessions have closed: none of them meets 57P01. */
export const aBuildEndsItsDatabasesBackendsOnlyOnceItsOwnSessionsHaveClosed = property.exhaust(
	finite(int(1, 3)),
	{
		box: "a build of one to three sessions",
		needs: { substrate: Substrate.installing },
		situations: [],
		check:
			({ substrate }) =>
			(sessions: number) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const s = yield* Substrate
						const database = yield* freshDatabase(s.cluster)
						const refused = yield* Ref.make<ReadonlyArray<string>>([])
						const build = Effect.gen(function* () {
							for (let at = 0; at < sessions; at += 1) {
								const session = yield* openSession(s.cluster, {
									database,
									credentials: s.owner,
									label: `build ${at}`
								})
								yield* Effect.addFinalizer(() =>
									Effect.flatMap(Effect.result(session.query("SELECT 1", [])), (closing) =>
										Result.isFailure(closing)
											? Ref.update(refused, (all) => [
													...all,
													`${session.label}: ${Formatter.format(closing.failure.reason)}`
												])
											: Effect.void
									)
								)
							}
						})
						yield* builtThenEnded(build, backendsEnded(s.cluster, database))
						const closings = yield* Ref.get(refused)
						assert.deepEqual(
							closings,
							[],
							`${sessions} sessions: every closing statement answered, none terminated by the build's end`
						)
					}),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "PostgreSQL, which refuses a statement of a session pg_terminate_backend ended with 57P01"
		},
		kept: [],
		kills: [
			{
				file: "test/support/substrate/substrate.ts",
				original: "Effect.andThen(Effect.scoped(build), ended)",
				replacement: "Effect.scoped(Effect.andThen(build, ended))",
				why: "The build's end runs inside its scope, terminating its sessions while it holds them: each closing statement meets 57P01."
			}
		]
	}
)
