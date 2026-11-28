/**
 * A grizzle actor is the backend its Db's call holds (test/support/schedules/actors.ts grizzleActor), read while the
 * call holds it, whatever other sessions of its login stand beside it when it is named: an earlier writer's, whose pool
 * holds its session idle; a session another Db of the login holds leased; or a session another Db of the login has
 * just let go, whose pool ends without awaiting its backend's exit, so the backend may still be listed. And whatever
 * connection its Db's pool dropped before: a call interrupted while its statement waits is cancelled and its session
 * never used again (test/pg/adapter/pool.test.ts), so the next call runs on another backend, as an interleaving's run
 * that ends with a grizzle move in flight leaves it (schedules/interleave.ts). The history suites name two writers of
 * one login per case, each case after the last one's Dbs closed (test/support/history/families.ts historyEnv).
 *
 * The installation is the timekeeping family's first schema, installed once. A case draws one or two writers, each with
 * up to two sessions of its login opened just before it is named, each held to the case's end or let go at once, and
 * each with a first call interrupted while it waits for an advisory lock the admin session holds, or none. Each
 * writer's Db is opened as the history suites open it (laws/support.ts openWriter), its actor named, and then its pool
 * runs a statement whose text no other writer of the test sends.
 *
 * - Property: while a writer's call holds its connection, its actor's backend is the one backend PostgreSQL lists as
 *   having run the call's statement, under its actor's role; once the call ends, it is none.
 * - Oracle: pg_stat_activity, read by the observer: each backend's last statement and its user.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Ref } from "effect"
import {
	type ActorFeature,
	caseGen,
	interruptedCall,
	timekeepingTemplate
} from "#test/schedules/actors/grizzle-actor.fixtures.ts"
import { timekeeping } from "#test/support/laws/boxes.ts"
import { openWriter } from "#test/support/laws/support.ts"
import { rowsOn } from "#test/support/pg/adapter/support.ts"
import { grizzleActor } from "#test/support/schedules/actors.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Grizzle actors a grizzle actor is the backend its Db's calls run on, whatever sessions of its login stand beside it.
 *
 * Its pre-conversion budget: runs 16, coverage cases 32 (test/schedules/actors/grizzle-actor.test.ts at d8eed1786).
 */
export const grizzleActorsAGrizzleActorIsTheBackendItsDbsCallsRunOnWhateverSessionsOfItsLoginStandBesideIt =
	property.explore(caseGen, {
		needs: { fresh: Substrate.fresh(timekeepingTemplate) },
		situations: [
			"a writer named alone",
			"a writer named beside an earlier writer",
			"a writer named beside a held session of its login",
			"a writer named beside a departed session of its login",
			"a writer whose interrupted call's connection its pool dropped"
		] satisfies ReadonlyArray<Reached<ActorFeature>>,
		check:
			({ fresh }, c: Case<ActorFeature>) =>
			(writers) =>
				Effect.flatMap(fresh, ({ substrate: clone, value: install }) =>
					Effect.provideService(
						Effect.gen(function* () {
							const s = yield* Substrate
							const opened = {
								installed: install.installed,
								schema: timekeeping(install.params)(install.installed.declared)
							}
							/** A Db of the writers' login whose pool leases one session, which the case holds to its end. */
							const held = Effect.flatMap(openWriter(opened), (db) => db.ctx.pool.lease)
							/** A Db of the writers' login whose pool leased one session and ended at once. */
							const departed = Effect.scoped(
								Effect.flatMap(openWriter(opened), (db) => Effect.scoped(db.ctx.pool.lease))
							)
							/**
							 * The writers named so far: each writer's statement is its own text in the case's own database, where
							 * the backend that ran it is read.
							 */
							const named = yield* Ref.make(0)

							for (const [w, writer] of writers.entries()) {
								for (const bystander of writer.beside) {
									yield* bystander === "held" ? Effect.asVoid(held) : Effect.asVoid(departed)
								}
								const db = yield* openWriter(opened)
								const actor = yield* grizzleActor(`w${w}`, db.ctx.pool)
								const statement = `SELECT 'the statement of writer ${yield* Ref.getAndUpdate(named, (n) => n + 1)}'::text`
								const interrupted =
									writer.first === "interrupted"
										? yield* Effect.asSome(interruptedCall(s.admin, db.ctx.pool, actor, statement))
										: Option.none()
								const read = yield* Effect.orDie(
									Effect.scoped(
										Effect.flatMap(db.ctx.pool.lease, (session) =>
											Effect.andThen(rowsOn(session, statement, []), actor.backend)
										)
									)
								)
								const ran = yield* s.admin.queryValues(
									"SELECT a.pid::text, a.usename::text FROM pg_catalog.pg_stat_activity AS a WHERE a.query = $1::text AND a.backend_type = 'client backend'::text AND a.datname = pg_catalog.current_database()",
									[statement]
								)
								assert.deepEqual(
									ran,
									[[Option.match(read, { onNone: () => "none", onSome: String }), actor.role]],
									`the backend that ran ${statement}, as its actor read it while the call held it`
								)
								const after = yield* actor.backend
								assert.ok(
									Option.isNone(after),
									`once ${statement} ended, its actor holds no backend`
								)
								if (Option.exists(interrupted, (waited) => !Option.contains(read, waited))) {
									c.note("a writer whose interrupted call's connection its pool dropped")
								}
								if (w === 0 && writer.beside.length === 0) {
									c.note("a writer named alone")
								}
								if (w > 0) {
									c.note("a writer named beside an earlier writer")
								}
								if (Arr.contains(writer.beside, "held")) {
									c.note("a writer named beside a held session of its login")
								}
								if (Arr.contains(writer.beside, "departed")) {
									c.note("a writer named beside a departed session of its login")
								}
							}
						}).pipe(Effect.scoped),
						Substrate,
						clone
					)
				),
		oracle: {
			kind: "postgresql",
			name: "pg_stat_activity: the backend that ran a writer's statement, and its user"
		},
		budget: { runs: 16, steered: 32 },
		kept: [],
		kills: []
	})
