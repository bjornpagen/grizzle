/** What the properties of payroll.test.ts read: its spaces, models and helpers. */

import { defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { constant, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Layer, type Scope } from "effect"
import { openServed } from "#adapter/db/served.ts"
import type { OpenError } from "#adapter/errors/execution.ts"
import type { ServedRefusal } from "#adapter/public/compile.ts"
import type { CompileError, TransientTag } from "#compiler/core/errors.ts"
import type { WriteOutcome } from "#compiler/live/index.ts"
import { writeAnswerOf, type WriteAnswer } from "#test/support/calls.ts"
import { closedField } from "#test/support/closed/stored.ts"
import { Instant } from "#test/support/fixtures/api/contracts.ts"
import * as P from "#test/support/fixtures/api/payroll.ts"
import { ada, stateA, t0 } from "#test/support/fixtures/golden/payroll.ts"
import { replaceMigrated } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { openFixture } from "#test/support/open-fixture.ts"
import type { SqlError } from "#test/support/pg.ts"
import {
	grizzleActor,
	openActors,
	standUpActor,
	textOfValue
} from "#test/support/schedules/actors.ts"
import { every, everyRelation, exploreEnv } from "#test/support/schedules/interleave.ts"
import {
	type Explained,
	runSerialRace,
	type SerialRaceFailed
} from "#test/support/schedules/serial.ts"
import { beginSerializableAction } from "#test/support/schedules/types.ts"
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
export type LeaveFeature =
	| "the insert waited"
	| "the insert refused"
	| `refused: ${TransientTag}`
	| `the insert answered ${WriteAnswer<WriteOutcome<unknown>>["kind"]}`
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

export const raceGen: Gen<LeaveRace> = (source) => {
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
const featuresOf = (
	e: Explained<WriteAnswer<WriteOutcome<unknown>>>
): ReadonlyArray<LeaveFeature> => {
	const waited = Arr.some(e.run.moves, (m) => m.session === "g" && m.observed._tag === "Waited")
	return [
		...(waited ? ["the insert waited" as const] : []),
		...Arr.flatMap([...e.ends.values()], (end): ReadonlyArray<LeaveFeature> => {
			switch (end.kind) {
				case "answered":
					return [
						`the insert answered ${end.retried.answered.kind}`,
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
export const runRace = (
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
		const opened = yield* openServed(served.login.roles.hr, {}).pipe(
			Effect.provideContext(serverContext)
		)
		const hr = opened.db
		const direct = yield* openActors(substrate, {
			h: { kind: "psql", as: f.installed.world(worlds.hr) }
		})
		yield* standUpActor(direct.h, namesOf(f.installed).standUps)
		yield* Effect.orDie(writeAnswerOf(hr.workload.noop.once({ params: {}, facts: {} })))
		const g = yield* grizzleActor("g", opened.ctx.pool)
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
						call: writeAnswerOf(
							hr.workload.insertLeave.once({
								params: {},
								facts: {
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
								}
							})
						),
						footprint: everyRelation
					},
					{
						kind: "direct",
						begin: beginSerializableAction,
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
export const runs = 8

/**
 * The cases the search kept by value, which reached their situations on every run: each is the aim of the situations
 * it reaches (aimed), so a case whose turn aims at one draws it. None ever caught a bug (git log -S on the module).
 */
const leaveCases: ReadonlyArray<{
	readonly why: string
	readonly value: LeaveRace
	readonly reaches: ReadonlyArray<LeaveFeature>
}> = [
	{
		why: "the span key's exact repeat: the insert waits on an identical Leave in flight, which commits, so its exclusion check meets the repeat and its retry is unchanged",
		value: {
			requested: { start: 5, end: 9, reason: "vacation" },
			direct: { start: 5, end: 9, reason: "vacation" },
			end: "commit"
		},
		reaches: ["the insert waited", "the insert refused", "the insert answered unchanged"]
	}
]

/** The property's aims (leave): each kept case's value at every situation it reaches. */
export const leaveAims: ReadonlyArray<readonly [Reached<LeaveFeature>, Gen<LeaveRace>]> =
	Arr.flatMap(leaveCases, (c) =>
		Arr.map(c.reaches, (situation) => [situation, constant(c.value)] as const)
	)
