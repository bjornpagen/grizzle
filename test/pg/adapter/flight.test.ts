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
import { caseGen } from "#test/support/flight/cases.ts"
import type { Interruption } from "#test/support/flight/drive.ts"
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
import { until } from "#test/support/pg/adapter/support.ts"
import { testSql } from "#test/support/sql.ts"
import { clearRows, tablesGroup } from "#test/support/substrate/replace.ts"
import { freshSchema, Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"
import { backendCount, queriesSent, tappedSession } from "#test/support/wire-tap.ts"

/**
 * The scripted session against PostgreSQL observes what the server observes for every flight and interruption point the server can be made to show.
 *
 * Its pre-conversion budget: runs 25, coverage cases 200 (test/pg/adapter/flight.test.ts at 991e0f9ab).
 */
export const theScriptedSessionAgainstPostgreSQLObservesWhatTheServerObservesForEveryFlightAndInterruptionPointTheServerCanBeMadeToShow =
	property.explore(aimed(caseGen(space), flightAims), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: situations satisfies ReadonlyArray<Reached<ScriptedFeature>>,
		check:
			({ substrate }, cx: Case<ScriptedFeature>) =>
			(sketch) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const s = yield* Substrate
						const raw = yield* s.schema(freshSchema)
						const schema = quoteIdent(raw)
						for (const { sql, params } of fenceSql(raw, s.owner.role)) {
							yield* s.admin.query(sql, params)
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
						 * The case on a real session, held and interrupted where the scripted run was (drive.ts Interruption): its
						 * gate holds once the run's delivered answers have reached the client, and the interruption comes once the
						 * server is quiescent, waiting in a hold's sleep, or reading from the client with every query the client
						 * sent answered, which it always comes to, so the wait ends whatever the product sent. There the real pair
						 * must stand as the scripted one did: the client sent the queries the scripted client had, over every
						 * flight, and the server answered those the scripted server had made. A count the client never sends
						 * (layoutOf's, both flights of an alongside call, where its end waits for a first flight the gate holds) is
						 * a red, never a wait.
						 *
						 * No CancelRequest's connection outlives the call.
						 */
						const onServer = (c: FlightCase, interruption: Interruption) =>
							Effect.scoped(
								Effect.gen(function* () {
									const sqlOf = sqlOver(schema, c)
									yield* clearRows(s.admin, tablesGroup([table]))
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
									if (interruption.at !== undefined) {
										tapped.gate.hold(interruption.at, { kind: "type", type: "Z" })
									}
									const fiber = yield* Effect.forkChild(callOf(session, c.call, sqlOf, prologue))
									if (interruption.at !== undefined) {
										const held = yield* Effect.raceFirst(
											Effect.as(tapped.gate.holding, true),
											Effect.as(Fiber.await(fiber), false)
										)
										if (held) {
											/**
											 * Whether the server is quiescent: in a hold's sleep, or reading from the client with every query
											 * the client sent answered. Its wait is read before the traffic, so every query the client had
											 * sent by then is in the window its answers are counted against.
											 */
											const quiescent = Effect.gen(function* () {
												const rows = yield* s.admin.queryValues(
													"SELECT coalesce(wait_event::text, '') FROM pg_catalog.pg_stat_activity WHERE pid = $1::int4",
													[pid]
												)
												const waiting = rows[0]?.[0]
												const window = tapped.since(mark)
												return (
													waiting === "PgSleep" ||
													(waiting === "ClientRead" &&
														backendCount(window, "Z") === queriesSent(window))
												)
											})
											yield* until(quiescent)
											const window = tapped.since(mark)
											const standing = {
												sent: queriesSent(window),
												made: backendCount(window, "Z")
											}
											const scripted = { sent: interruption.sent, made: interruption.made }
											const difference = exact(scripted, standing)
											if (Option.isSome(difference)) {
												return yield* Effect.die(
													new Error(
														`the server stands unlike the scripted session after ${interruption.at} answers of the call's ${layoutOf(c.call).length} queries: ${difference.value}\nserver ${Formatter.format(standing)}, scripted ${Formatter.format(scripted)}`
													)
												)
											}
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
								const serverRows = yield* onServer(c, observations.interruption)
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
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "postgresql",
			name: "a real session interrupted at each answer, against the scripted session"
		},
		budget: { runs: 25, steered: 200 },
		kept: [],
		kills: [
			{
				file: "test/pg/adapter/flight.test.ts",
				original:
					"\t\t\t\t\t\t\t\t\t\t\tconst scripted = { sent: interruption.sent, made: interruption.made }",
				replacement:
					"\t\t\t\t\t\t\t\t\t\t\tconst scripted = { sent: layoutOf(c.call).length, made: interruption.made }",
				why: "The server check expects every query of the call's layout sent at the interruption, an alongside call's end among them, where runAlongside sends its end in a second flight only once the client has read the first, which the gate holds: the count the wait for the server hung on before (bafa0de1c), now a red at the server's standing."
			}
		]
	})
