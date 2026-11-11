/**
 * The payroll example's race at a span primary key: a grizzle insert of a Leave racing a direct writer's Leave for the
 * same employee. The single-law races of the payroll laws (the deposits' amount and count, the approvers' count, the
 * approved shifts' timesheet, ceiling and employment) are the law families' generated races.
 *
 * Reporting installs completely under a fresh schema name with its login, and the facts of the state after onboard,
 * logShifts and draftRun (stateA). The actors are a psql child `h` that has taken on the role `hr` through its login,
 * and the grizzle writer `g`, a Db of `hr` over the worlds rebuilt under the installed name. Leave is keyed by
 * (employee, during), a span primary key, so a Leave the writer inserts in flight at an overlapping span holds the
 * insert's entry until it ends.
 *
 * Property: every run of a race, in every order of its moves, is explained by its serial reference
 * (test/support/schedules/serial.ts): the insert (retried after each TransientFailure until it answers) and the direct
 * writer's transaction, each run alone from stateA in an order that respects real time, show what they showed in the
 * run (the insert's outcome, the writer's SQLSTATE on its constraint) and leave its Leave facts. The races draw ada's
 * requested Leave inside her employment, the writer's Leave standing to it as a dictionary of what the key branches on
 * says (the same Leave, the same span for another reason, an overlapping span, or apart), and how the writer ends.
 *
 * The kept race is the window the race was first planted for: the span key's exact repeat, the insert waiting on an
 * identical Leave in flight, which commits, so the insert's retry finds the repeat, no-change.
 */

import { layer } from "@effect/vitest"
import { type Case, drawn, explore, type Kept } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { constant, element, type Gen, int, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Layer, type Scope } from "effect"
import type { OpenError } from "#adapter/errors/execution.ts"
import type { ServedRefusal } from "#adapter/public/compile.ts"
import { type ApplyOutcome, Db } from "#adapter/public/db.ts"
import type { CompileError, TransientTag } from "#compiler/core/errors.ts"
import { openFixture } from "#test/pg/e2e-laws/support.ts"
import { defined } from "#test/support/assert.ts"
import { closedField } from "#test/support/closed/stored.ts"
import { Instant } from "#test/support/fixtures/api/contracts.ts"
import * as P from "#test/support/fixtures/api/payroll.ts"
import { ada, stateA, t0 } from "#test/support/fixtures/golden/payroll.ts"
import { replaceMigrated } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import type { SqlError } from "#test/support/pg.ts"
import { grizzleActor, openActors, textOfValue } from "#test/support/schedules/actors.ts"
import { every, everyRelation, exploreEnv } from "#test/support/schedules/interleave.ts"
import {
	type Explained,
	runSerialRace,
	type SerialRaceFailed
} from "#test/support/schedules/serial.ts"
import type { PsqlProcessError, TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const day = 86_400_000_000n

type Reason = "vacation" | "sick" | "unpaid"

/** A Leave of ada's: its span in days since t0, inside her employment, [t0, t0 + 9 days), and its reason. */
interface Leave {
	readonly start: number
	readonly end: number
	readonly reason: Reason
}

/** A race: the Leave the insert requests, the direct writer's Leave, and how the writer's transaction ends. */
interface LeaveRace {
	readonly requested: Leave
	readonly direct: Leave
	readonly end: "commit" | "rollback"
}

/** What a race reached: the insert waited, met a refusal and each reason, its answer, and how the writer ended. */
type LeaveFeature =
	| "the insert waited"
	| "the insert refused"
	| `refused: ${TransientTag}`
	| `the insert ${ApplyOutcome<unknown>["kind"]}`
	| `the writer ${"committed" | "rolled back" | "aborted" | "failed"}`

const reasons = ["vacation", "sick", "unpaid"] as const

/** Each reason's others. */
const otherReasons: Readonly<Record<Reason, readonly [Reason, Reason]>> = {
	vacation: ["sick", "unpaid"],
	sick: ["vacation", "unpaid"],
	unpaid: ["vacation", "sick"]
}

/** A requested Leave, ending a day before the employment does, so a span apart from it always fits after it. */
const leaveGen: Gen<Leave> = (source) => {
	const start = source.draw(int(0, 7))
	return { start, end: source.draw(int(start + 1, 8)), reason: source.draw(element(reasons)) }
}

/** How the writer's Leave stands to the requested one, the dictionary of what the span key branches on. */
const standings = [
	"the same Leave",
	"the same span for another reason",
	"an overlapping span",
	"a span apart"
] as const

/** The writer's Leave, standing to the requested one as drawn. */
const standingGen =
	(requested: Leave): Gen<Leave> =>
	(source) => {
		switch (source.draw(element(standings))) {
			case "the same Leave":
				return requested
			case "the same span for another reason":
				return { ...requested, reason: source.draw(element(otherReasons[requested.reason])) }
			case "an overlapping span":
				return {
					start: requested.start,
					end: source.draw(int(requested.start + 1, 9)),
					reason: source.draw(element(reasons))
				}
			case "a span apart":
				return {
					start: requested.end,
					end: source.draw(int(requested.end + 1, 9)),
					reason: source.draw(element(reasons))
				}
		}
	}

const raceGen: Gen<LeaveRace> = (source) => {
	const requested = source.draw(leaveGen)
	return {
		requested,
		direct: source.draw(standingGen(requested)),
		end: source.draw(
			weighted<"commit" | "rollback">([
				[2, constant("commit")],
				[1, constant("rollback")]
			])
		)
	}
}

const instantOf = (days: number) => Instant(t0 + BigInt(days) * day)

/** The features one explained run reached (see LeaveFeature). */
const featuresOf = (e: Explained<ApplyOutcome<unknown>>): ReadonlyArray<LeaveFeature> => {
	const waited = Arr.some(e.run.moves, (m) => m.session === "g" && m.observed._tag === "Waited")
	return [
		...(waited ? ["the insert waited" as const] : []),
		...Arr.flatMap([...e.ends.values()], (end): ReadonlyArray<LeaveFeature> => {
			switch (end.kind) {
				case "answered":
					return [
						`the insert ${end.retried.answered.kind}`,
						...(end.retried.refused.length > 0 ? ["the insert refused" as const] : []),
						...Arr.map(end.retried.refused, (reason): LeaveFeature => `refused: ${reason}`)
					]
				case "committed":
				case "rolled back":
				case "aborted":
				case "failed":
					return [`the writer ${end.kind}`]
			}
		})
	]
}

/** Opens the payroll fixture at stateA, its insert's Db and its two actors, and runs the race. */
const runRace = (
	race: LeaveRace,
	c: Case<LeaveFeature>
): Effect.Effect<
	void,
	| CompileError
	| SqlError
	| TransactionRolledBack
	| OpenError
	| PsqlProcessError
	| SerialRaceFailed
	| ServedRefusal,
	Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const f = yield* openFixture(P.Reporting, [P.reportingWorlds(P.Payroll).server], {
			facts: stateA,
			after: []
		})
		const s = f.rebuilt(P.Payroll)
		const worlds = P.reportingWorlds(s)
		const served = yield* f.served(worlds.server)
		const serverContext = yield* Layer.build(served.layer)
		const hr = yield* Db.open(served.login.roles.hr, {}).pipe(Effect.provideContext(serverContext))
		const direct = yield* openActors(substrate, {
			h: { kind: "psql", as: f.installed.world(worlds.hr) }
		})
		const psqlPid = direct.h.pid
		const g = yield* grizzleActor(
			"g",
			f.installed.as(worlds.server).role,
			hr.workload.noop.apply({}),
			[psqlPid]
		)
		const env = yield* exploreEnv(substrate)
		const names = namesOf(f.installed)
		const leave = names.table(P.Leave)
		const column = (field: "employee" | "during" | "reason") => names.column(P.Leave, field)
		const reason = defined(
			closedField(f.installed.installation, P.Leave.name, "reason"),
			"Leave's reason, a closed id"
		)
		yield* runSerialRace(
			env,
			{ direct, grizzle: { g } },
			{
				name: "a Leave insert beside a direct writer's Leave",
				txns: [
					{
						kind: "grizzle",
						session: "g",
						label: "insert ada's leave",
						call: hr.workload.insertLeave.apply(
							{
								insert: {
									Leave: [
										{
											employee: ada,
											during: {
												start: instantOf(race.requested.start),
												end: instantOf(race.requested.end)
											},
											reason: race.requested.reason
										}
									]
								}
							},
							{}
						),
						footprint: everyRelation
					},
					{
						kind: "direct",
						session: "h",
						statements: [
							{
								sql: `INSERT INTO ${leave} (${column("employee")}, ${column("during")}, ${column("reason")}) VALUES ('${ada}', int8range(${instantOf(race.direct.start)}, ${instantOf(race.direct.end)}), ${reason.literal(race.direct.reason)})`,
								footprint: everyRelation
							}
						],
						end: race.end
					}
				],
				reset: Effect.provideService(replaceMigrated(f.installed, stateA), Substrate, substrate),
				state: Effect.map(
					env.observer.queryValues(
						`SELECT ${column("employee")}::text, ${column("during")}::text, ${column("reason")}::text FROM ${leave}`,
						[]
					),
					(rows) => Arr.map(rows, (row) => Arr.map(row, textOfValue))
				)
			},
			every,
			(e) => c.noteAll(featuresOf(e))
		)
	})

/** The cases of the rotating stream; its floor runs a quarter of them. */
const runs = 8

const kept: ReadonlyArray<Kept<LeaveRace, LeaveFeature>> = [
	{
		note: "the span key's exact repeat: the insert waits on an identical Leave in flight, which commits, so its exclusion check meets the repeat and its retry is no-change",
		sketch: {
			requested: { start: 5, end: 9, reason: "vacation" },
			direct: { start: 5, end: 9, reason: "vacation" },
			end: "commit"
		},
		draws: "",
		reaches: ["the insert waited", "the insert refused", "the insert no-change"]
	}
]

layer(Substrate.layer, { excludeTestServices: true })(
	"the payroll example's races at a span primary key",
	(it) => {
		it.effect("every race of a Leave insert and a direct writer's Leave is serializable", (ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "schedules/laws/payroll",
						draw: drawn(raceGen),
						literal: Formatter.format,
						coverage: required<LeaveFeature>(["the insert waited", "the insert refused"], {
							cases: runs,
							sense: notesOnly
						}),
						kept,
						runs,
						shrink: { kind: "bounded", candidates: 40 },
						concurrency: 1,
						steerEvery: runs,
						caseHang
					},
					(race, c) => Effect.scoped(runRace(race, c))
				)
			)
		)
	}
)
