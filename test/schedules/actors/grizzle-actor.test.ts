/**
 * A grizzle actor is the backend its Db's calls run on (test/support/schedules/actors.ts grizzleActor), whatever other
 * sessions of its login stand beside it when it is named: an earlier writer's, whose pool holds its session idle; a
 * session another Db of the login holds leased; or a session another Db of the login has just let go, whose pool ends
 * without awaiting its backend's exit, so the backend may still be listed. The history suites name two writers of one
 * login per case, each case after the last one's Dbs closed (test/support/history/families.ts historyEnv).
 *
 * The installation is the timekeeping family's first schema, installed once. A case draws one or two writers, each with
 * up to two sessions of its login opened just before it is named, each held to the case's end or let go at once. Each
 * writer's Db is opened as the history suites open it (laws/support.ts openWriter), its actor named, and then its pool
 * runs a statement whose text no other writer of the test sends.
 *
 * - Property: the one backend PostgreSQL lists as having run a writer's statement is its actor's pid, under its
 *   actor's role.
 * - Oracle: pg_stat_activity, read by the observer: each backend's last statement and its user.
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, element, type Gen } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Ref } from "effect"
import { rowsOn } from "#test/pg/adapter/support.ts"
import { assert } from "#test/support/assert.ts"
import { timekeepingHistory } from "#test/support/history/families.ts"
import { timekeeping } from "#test/support/laws/boxes.ts"
import { openWriter } from "#test/support/laws/support.ts"
import { caseHang } from "#test/support/limits.ts"
import { grizzleActor } from "#test/support/schedules/actors.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A session of the writer's login beside it: held leased to the case's end, or let go just before the writer's naming. */
type Bystander = "held" | "departed"

/** A writer of a case: the sessions of its login opened just before its actor is named, in order. */
interface WriterSketch {
	readonly beside: ReadonlyArray<Bystander>
}

type ActorFeature =
	| "a writer named alone"
	| "a writer named beside an earlier writer"
	| "a writer named beside a held session of its login"
	| "a writer named beside a departed session of its login"

const bystanders: Arr.NonEmptyReadonlyArray<Bystander> = ["held", "departed"]

const writerGen: Gen<WriterSketch> = (source) => ({
	beside: source.draw(array(element(bystanders), { min: 0, max: 2 }))
})

const caseGen: Gen<ReadonlyArray<WriterSketch>> = array(writerGen, { min: 1, max: 2 })

layer(Substrate.layer, { excludeTestServices: true })("grizzle actors", (it) => {
	it.effect(
		"a grizzle actor is the backend its Db's calls run on, whatever sessions of its login stand beside it",
		(ctx) =>
			searched(
				ctx,
				Effect.scoped(
					Effect.gen(function* () {
						const s = yield* Substrate
						const install = yield* timekeepingHistory.install(timekeepingHistory.family.variants[0])
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
						/** The writers named so far, every case's: each writer's statement is its own text. */
						const named = yield* Ref.make(0)
						return yield* explore(
							{
								suite: "schedules/actors/grizzle-actor",
								draw: drawn(caseGen),
								literal: Formatter.format,
								oracle: {
									kind: "postgresql",
									name: "pg_stat_activity: the backend that ran a writer's statement, and its user"
								},
								coverage: required<ActorFeature>(
									[
										"a writer named alone",
										"a writer named beside an earlier writer",
										"a writer named beside a held session of its login",
										"a writer named beside a departed session of its login"
									],
									{ cases: 32, sense: notesOnly }
								),
								kept: [],
								runs: 16,
								shrink: { kind: "bounded", candidates: 50 },
								steerEvery: 16,
								caseHang
							},
							(writers, c) =>
								Effect.gen(function* () {
									for (const [w, writer] of writers.entries()) {
										for (const bystander of writer.beside) {
											yield* bystander === "held" ? Effect.asVoid(held) : Effect.asVoid(departed)
										}
										const db = yield* openWriter(opened)
										const actor = yield* grizzleActor(`w${w}`, db.ctx.pool)
										const statement = `SELECT 'the statement of writer ${yield* Ref.getAndUpdate(named, (n) => n + 1)}'::text`
										yield* Effect.orDie(
											Effect.scoped(
												Effect.flatMap(db.ctx.pool.lease, (session) =>
													rowsOn(session, statement, [])
												)
											)
										)
										const ran = yield* s.admin.queryValues(
											"SELECT a.pid::text, a.usename::text FROM pg_catalog.pg_stat_activity AS a WHERE a.query = $1::text AND a.backend_type = 'client backend'::text",
											[statement]
										)
										assert.deepEqual(
											ran,
											[[String(actor.pid), actor.role]],
											`the backend that ran ${statement}`
										)
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
								})
						)
					})
				)
			)
	)
})
