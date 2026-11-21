/**
 * A statement in flight on PostgreSQL is a declared wait of the case that sent it, checked on its backend
 * (test/support/pg.ts awaitingBackend, @bjornpagen/testing/live waitingOnWork, pg-session backendWorking), wherever
 * test support hands it to the server: a raw session (pg.ts connectOnce, which the substrate's admin and every raw
 * session use), grizzle's adapter (pg.ts testDriver, which every Db, migration and wire session under test connects
 * with), the bootstrap superuser (substrate/shared.ts superuserClient) and a psql writer (substrate/psql.ts). The server is no process of a case's tree, so without the wait a case's guard reads the
 * wall time the server spends on a statement as a stall of the case, its CPU unmoved, and judges hung a case that waits
 * on a statement a loaded server is slow to answer: hybrid.test.ts's first case, its catalog's load running past the
 * guard's window at load 729 (lane FTSG2, 2026-11-21).
 *
 * Each case sends `SELECT pg_sleep` through one place for three of the property's case deadlines (sleepSeconds), so
 * whole windows of the guard pass with the case's CPU unmoved, and reads its answer. The oracle is the runner's guard
 * itself: the case ends with the statement's answer, never a hang verdict, which each kill, unwrapping one place's wait,
 * brings back.
 *
 * Features: none beyond the box, every place once.
 */

import { assert } from "@bjornpagen/testing/assert"
import { element, finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { rowsOn } from "#test/pg/adapter/support.ts"
import { wireSession } from "#test/support/pg.ts"
import { rolePsql, Substrate, type TextRows } from "#test/support/substrate/substrate.ts"

/** Each place test support hands a statement to PostgreSQL. */
const places = ["a raw session", "the adapter", "the bootstrap superuser", "a psql writer"] as const

type Place = (typeof places)[number]

/**
 * The case deadline the property's cases run under: the window the runner's guard judges a stall over is this, its
 * cases' own work a connect and one statement. The property's own input, short so that its cases and its kills' are
 * quick, and long enough that the CPU a case's process spends idle in it, about 0.75 ms a second (hybrid.test.ts's hang
 * report: 45 ms over 60 s), stays under the 0.1 % of it that shows progress.
 */
const caseDeadline = 10_000

/** How long each case's statement sleeps on the server: three of its case deadlines, in seconds. */
const sleepSeconds = (3 * caseDeadline) / 1000

/** The statement each case sends: it answers one row, `slept`, once the server has slept. */
const sleep = `SELECT 'slept' FROM pg_catalog.pg_sleep(${sleepSeconds})`

/** The rows `sleep` answers through `place`. */
const sleptThrough = (place: Place) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		switch (place) {
			case "a raw session":
				return yield* s.admin.queryValues(sleep, [])
			case "the adapter": {
				const session = yield* wireSession(s.cluster, {
					database: s.database,
					username: s.owner.role,
					password: s.owner.password
				})
				return yield* rowsOn(session, sleep, [])
			}
			case "the bootstrap superuser":
				return yield* s.superuserRead<TextRows, never>((rows) => rows(sleep))
			case "a psql writer": {
				const writer = yield* s.psql(rolePsql(s.owner))
				return yield* Effect.map(writer.run(sleep), (result) => result.rows)
			}
		}
	})

/** A statement in flight is a declared wait, wherever test support sends it: a case waiting on it is never hung. */
export const aStatementInFlightIsADeclaredWaitWhereverTestSupportSendsIt = property.exhaust(
	finite((source) => source.draw(element(places))),
	{
		box: "every place test support hands a statement to PostgreSQL",
		needs: { substrate: Substrate.installing },
		situations: [],
		caseDeadline,
		check:
			({ substrate }) =>
			(place: Place) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						Effect.gen(function* () {
							const rows = yield* sleptThrough(place)
							assert.deepEqual(
								rows,
								[["slept"]],
								`${place}: the statement's answer, once the server slept`
							)
						})
					),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "the runner's guard, which judges hung a case whose CPU stands still outside its declared waits"
		},
		show: (place) => place,
		kept: [],
		kills: [
			{
				file: "test/support/pg.ts",
				original:
					"\t\t\tawaitingBackend(cluster, processId, Arr.headNonEmpty(statements).sql)(flight(statements))",
				replacement: "\t\t\tflight(statements)",
				why: "A raw session's statement is no declared wait: the raw session's case, its CPU still for whole windows while the server sleeps, is judged hung."
			},
			{
				file: "test/support/pg.ts",
				original: "\t\t\t\tEffect.runFork(awaiting(Deferred.await(answered)))",
				replacement: "\t\t\t\tEffect.runFork(Deferred.await(answered))",
				why: "The adapter's statement is no declared wait: the adapter's case is judged hung while the server sleeps."
			},
			{
				file: "test/support/substrate/shared.ts",
				original:
					"\t\t\treturn { query: (sql, params) => awaitingBackend(cluster, pid, sql)(answer(sql, params)) }",
				replacement: "\t\t\treturn { query: answer }",
				why: "The bootstrap superuser's statement is no declared wait: the superuser's case is judged hung while the server sleeps."
			},
			{
				file: "test/support/substrate/psql.ts",
				original: "\t\t\t? awaitingBackend(options.member, canceler.pid, sql)",
				replacement: "\t\t\t? <A, E, R>(effect: Effect.Effect<A, E, R>) => effect",
				why: "A psql writer's statement is no declared wait: psql, waiting on the server, spends no CPU, and the psql writer's case is judged hung while the server sleeps."
			}
		]
	}
)
