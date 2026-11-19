import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { exact } from "@bjornpagen/testing/oracle"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Fiber, Formatter, Option } from "effect"
import { oneShotStatement } from "#adapter/wire/batch.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import {
	asSet,
	expressible,
	type ScriptedFeature,
	situations,
	space,
	sqlOver,
	writing,
	flightAims
} from "#test/pg/adapter/flight.fixtures.ts"
import { until } from "#test/pg/adapter/support.ts"
import { caseGen } from "#test/support/flight/cases.ts"
import {
	callAnswers,
	callOf,
	fenceSql,
	type FlightCase,
	interruptionPoint,
	layoutOf,
	type Observation,
	observed,
	prologueIn
} from "#test/support/flight/model.ts"
import { observationsOf, plannedBySql, runScripted } from "#test/support/flight/run.ts"
import { runAlone } from "#test/support/pg.ts"
import { testSql } from "#test/support/sql.ts"
import { freshSchema, Substrate } from "#test/support/substrate/substrate.ts"
import { backendCount, tappedSession } from "#test/support/wire-tap.ts"

/**
 * The scripted session against PostgreSQL observes what the server observes for every flight and interruption point the server can be made to show.
 *
 * Its pre-conversion budget: runs 25, coverage cases 200 (test/pg/adapter/flight.test.ts at 991e0f9ab).
 */
export const theScriptedSessionAgainstPostgreSQLObservesWhatTheServerObservesForEveryFlightAndInterruptionPointTheServerCanBeMadeToShow =
	property.explore(aimed(caseGen(space), flightAims), {
		needs: { substrate: Substrate.installing },
		situations: situations satisfies ReadonlyArray<Reached<ScriptedFeature>>,
		check:
			({ substrate }, cx: Case<ScriptedFeature>) =>
			(sketch) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const s = yield* Substrate
						const raw = yield* s.schema(freshSchema)
						const schema = quoteIdent(raw)
						for (const sql of fenceSql(raw, s.owner.role)) {
							yield* s.admin.query(sql, [])
						}
						const prologue = prologueIn(raw)
						yield* s.admin.query(`CREATE TABLE ${schema}."p" ("k" int4 PRIMARY KEY)`, [])
						yield* s.admin.query(`INSERT INTO ${schema}."p" ("k") VALUES (1)`, [])
						yield* s.admin.query(
							`CREATE TABLE ${schema}."t" ("label" text PRIMARY KEY, "ref" int4 NOT NULL REFERENCES ${schema}."p" DEFERRABLE INITIALLY DEFERRED)`,
							[]
						)
						yield* s.admin.query(
							`CREATE FUNCTION ${schema}."refuse"(code text) RETURNS text LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION USING ERRCODE = code; END$$`,
							[]
						)
						const table = `${schema}."t"`
						/**
						 * The case on a real session, interrupted after `k` answers unless k is undefined.
						 *
						 * No CancelRequest's connection outlives the call.
						 */
						const onServer = (c: FlightCase, k: number | undefined) =>
							Effect.scoped(
								Effect.gen(function* () {
									const sqlOf = sqlOver(schema, c)
									yield* s.admin.query(`TRUNCATE ${table}`, [])
									const tapped = yield* tappedSession({
										cluster: s.cluster,
										database: s.database,
										role: s.owner.role,
										password: s.owner.password
									})
									const session = tapped.session
									const backend = yield* runAlone(
										session,
										oneShotStatement(testSql("SELECT pg_catalog.pg_backend_pid()::text"), [])
									)
									const pid = Number(backend.rows[0]?.[0])
									const mark = tapped.mark()
									if (k !== undefined) {
										tapped.gate.hold(k, { kind: "type", type: "Z" })
									}
									const fiber = yield* Effect.forkChild(callOf(session, c.call, sqlOf, prologue))
									if (k !== undefined) {
										const held = yield* Effect.raceFirst(
											Effect.as(tapped.gate.holding, true),
											Effect.as(Fiber.await(fiber), false)
										)
										if (held) {
											const queries = layoutOf(c.call).length
											yield* until(
												Effect.gen(function* () {
													if (backendCount(tapped.since(mark), "Z") >= queries) {
														return true
													}
													const rows = yield* s.admin.queryValues(
														"SELECT coalesce(wait_event::text, '') FROM pg_catalog.pg_stat_activity WHERE pid = $1::int4",
														[pid]
													)
													return rows[0]?.[0] === "PgSleep"
												})
											)
											/**
											 * The fork starts at once, so the call has taken the interruption when it returns: a call that
											 * cancels has retired its session, and the gate holds until its CancelRequest has reached the
											 * server, or the interruption has ended, when the call has nothing left to send; any other
											 * awaits the drain, with nothing to send.
											 */
											const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber), {
												startImmediately: true
											})
											if (session.state() !== "open") {
												yield* until(
													Effect.sync(
														() =>
															tapped.cancelsEnded() > 0 || interrupting.pollUnsafe() !== undefined
													)
												)
											}
											tapped.gate.release()
											yield* Fiber.join(interrupting)
										}
									}
									const exit = yield* Fiber.await(fiber)
									yield* until(Effect.sync(() => tapped.cancelsEnded() === tapped.cancels()))
									const committed = yield* s.admin.queryValues(
										`SELECT "label" FROM ${table} ORDER BY "label"`,
										[]
									)
									return observed(
										exit,
										Arr.map(committed, ([label]) => String(label)),
										session.state() !== "open",
										tapped.cancels()
									)
								})
							)
						/**
						 * One timing of a case on both sides: the server must agree with the scripted session, every field exact.
						 *
						 * A call that completed before k answers is the uninterrupted run; one that blocked before them is the run
						 * of a smaller k.
						 */
						const compare = (c: FlightCase, k: number | undefined, cx: Case<ScriptedFeature>) =>
							Effect.gen(function* () {
								const sqlOf = sqlOver(schema, c)
								const bySql = plannedBySql(c, sqlOf)
								const writes = writing(c)
								const run = runScripted(c, { interruptAfter: k }, sqlOf)
								const observations = observationsOf(c, run, (sql) => bySql.get(sql)?.label ?? sql)
								if (observations === undefined) {
									return { blocked: true, at: undefined }
								}
								const scripted: Observation = asSet({
									...observations.run,
									committed: Arr.filter(observations.run.committed, (label) => writes.has(label))
								})
								const at = observations.interruption.at
								if (k !== undefined && (at === undefined || at < k)) {
									return { blocked: false, at }
								}
								const serverRows = yield* onServer(c, k)
								const server = asSet(serverRows)
								const difference = exact(scripted, server)
								if (Option.isSome(difference)) {
									return yield* Effect.die(
										new Error(
											`server disagrees with scripted: ${difference.value}\nserver ${Formatter.format(server)}, scripted ${Formatter.format(scripted)}\ninterrupted after ${k ?? "no"} answers`
										)
									)
								}
								cx.note(`call ${c.call.kind} ${c.call.frame}`)
								const point = interruptionPoint(
									c.call,
									callAnswers(c.call, run.session.flights()).delivered,
									observations.interruption
								)
								if (point !== "none") {
									cx.note(`interrupted ${point}`)
								}
								if (point !== "none" && scripted.committed.length > 0) {
									cx.note("committed after an interruption")
								}
								if (scripted.cancelled) {
									cx.note("cancel sent")
								}
								if (scripted.ending.kind === "failure") {
									cx.note(`ending ${scripted.ending.failure.tag}`)
								}
								return { blocked: false, at }
							})
						const resolved = expressible(sketch)
						const c = resolved

						yield* compare(c, undefined, cx)
						for (let k = 0; ; k++) {
							const ran = yield* compare(c, k, cx)
							if (ran.blocked || ran.at === undefined || ran.at < k) {
								return
							}
						}
					}),
					Substrate,
					substrate
				),
		oracle: {
			kind: "postgresql",
			name: "a real session interrupted at each answer, against the scripted session"
		},
		budget: { runs: 25, steered: 200 },
		kept: [],
		kills: []
	})
