/**
 * The payroll example's concurrency window no generated race plants: an exact repeat at a span primary key waiting on
 * an identical insert in flight. The single-law races of the payroll laws (the deposits' amount and count, the
 * approvers' count, the approved shifts' timesheet, ceiling and employment) are the law families' generated races
 *.
 *
 * Reporting installs completely under a fresh schema name with its login, and the facts of the state after onboard,
 * logShifts and draftRun (stateA). The actors are a psql child `h` that has
 * taken on the role `hr` through its login and the grizzle writer `g`, a Db of `hr` over the worlds rebuilt under the
 * installed name, whose operation is a db.apply of a ChangeSet over Payroll there. Every table and column a schedule
 * names comes from the installation (`names`). The leave reason the writers write is drawn.
 */

import { layer } from "@effect/vitest"
import { element } from "@grizzle/testing/gen"
import { Effect, Layer, type Scope } from "effect"
import type { OpenError } from "#adapter/errors/execution.ts"
import { Db } from "#adapter/public/db.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import type { PayrollInstalled, PayrollWorlds } from "#test/pg/e2e-laws/payroll.ts"
import { openFixture } from "#test/pg/e2e-laws/support.ts"
import { Instant } from "#test/support/fixtures/api/contracts.ts"
import * as P from "#test/support/fixtures/api/payroll.ts"
import { ada, stateA, t5, t9 } from "#test/support/fixtures/golden/payroll.ts"
import { type Names, namesOf } from "#test/support/kernel/naming.ts"
import type { SqlError } from "#test/support/pg.ts"
import { type Actors, grizzleActor, openActors } from "#test/support/schedules/actors.ts"
import {
	awaits,
	begin,
	blocksOn,
	check,
	commit,
	complete,
	op,
	schedule,
	sql
} from "#test/support/schedules/build.ts"
import { applied, refusals, retried } from "#test/support/schedules/grizzle.ts"
import { exploreEnv } from "#test/support/schedules/interleave.ts"
import { ok, rows } from "#test/support/schedules/match.ts"
import { planted } from "#test/support/schedules/planted.ts"
import { runSchedule, type ScheduleFailed } from "#test/support/schedules/runner.ts"
import { type Schedule, type Trace } from "#test/support/schedules/types.ts"
import type { PsqlProcessError, TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const range = (start: bigint, end: bigint): string => `int8range(${start}, ${end})`
const span = (start: bigint, end: bigint) => ({ start: Instant(start), end: Instant(end) })

interface Rig {
	readonly s: PayrollInstalled
	/** The installation's names of Payroll's relations. */
	readonly names: Names
	readonly hr: Db<PayrollWorlds["hr"], unknown>
	readonly run: (
		schedule: Schedule<"h", "g", "h" | "g">
	) => Effect.Effect<Trace, ScheduleFailed | SqlError>
}

const openPayroll: Effect.Effect<
	Rig,
	CompileError | SqlError | TransactionRolledBack | OpenError | PsqlProcessError,
	Substrate | Scope.Scope
> = Effect.gen(function* () {
	const substrate = yield* Substrate
	const f = yield* openFixture(P.Reporting, [P.reportingWorlds(P.Payroll).server], {
		facts: stateA,
		after: []
	})
	const s: PayrollInstalled = f.rebuilt(P.Payroll)
	const worlds = P.reportingWorlds(s)
	const serverContext = yield* Layer.build(f.layer(worlds.server))
	const hr = yield* Db.open(worlds.server.roles.hr, {}).pipe(Effect.provideContext(serverContext))
	const psql = yield* openActors(substrate, {
		h: { kind: "psql", as: f.installed.world(worlds.hr) }
	})
	/** The grizzle writer's login is the psql child's too: its backend is the one the child does not run. */
	const g = yield* grizzleActor("g", f.installed.as(worlds.server).role, [
		yield* Effect.orDie(psql.h.pid)
	])
	const actors: Actors<"h", "g"> = { direct: psql, grizzle: { g } }
	const env = yield* exploreEnv(substrate)
	return {
		s,
		names: namesOf(f.installed),
		hr,
		run: (sched) => runSchedule(env, sched, actors)
	} satisfies Rig
})

layer(Substrate.layer, { excludeTestServices: true })(
	"the payroll example's concurrency schedules over the payroll fixture",
	(it) => {
		it.effect(
			"the span key's exact repeat, a Leave insert waiting on an identical one in flight, is no-change",
			planted(
				"payroll/span key repeat",
				element(["vacation", "sick", "unpaid"] as const),
				["an identical Leave in flight"],
				(reason) =>
					Effect.gen(function* () {
						const r = yield* openPayroll
						const leave = r.names.table(P.Leave)
						const employee = r.names.column(P.Leave, "employee")
						return [
							yield* r.run(
								schedule("an identical Leave in flight", [
									begin("h"),
									sql(
										"h",
										`INSERT INTO ${leave} (${employee}, ${r.names.column(P.Leave, "during")}, ${r.names.column(P.Leave, "reason")}) VALUES ('${ada}', ${range(t5, t9)}, '${reason}')`,
										ok(),
										complete
									),
									op(
										"g",
										"insert ada's leave",
										retried(
											r.hr.apply(
												ChangeSet.empty(r.s).insert(P.Leave, [
													{ employee: ada, during: span(t5, t9), reason }
												]),
												{}
											)
										),
										applied({ kind: "no-change", calls: refusals(1) }),
										blocksOn("h")
									),
									commit("h", ok(), complete),
									awaits("g", complete),
									check(
										`SELECT count(*)::text FROM ${leave} WHERE ${employee} = '${ada}'`,
										rows(["1"])
									)
								])
							)
						]
					})
			)
		)
	}
)
