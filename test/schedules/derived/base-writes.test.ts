/**
 * Refresh under concurrent base writes is correct.
 *
 * db.refresh runs one transaction, so every level's definition reads one snapshot of the base relations and a higher
 * level reads the lower levels as this transaction just refreshed them. A raw `holder`
 * refresher parks the call between its two levels by holding WeekBusy's lock, so a base write commits while the call
 * has refreshed StudentWeekly and not yet WeekBusy: a direct writer that read StudentWeekly before the call's commit
 * and wrote a sitting the call's definition read is the other half of a cycle, so it commits first, the call fails
 * with 40001, retries from the current base, and publishes both levels with the write.
 *
 * What a reader sees of a view is the host model of its definition over the sittings it was refreshed at.
 */

import { layer } from "@effect/vitest"
import { Effect } from "effect"
import {
	addSitting,
	busyRows,
	freshSql,
	initial,
	labelsGen,
	open,
	refreshSql,
	sat,
	weekBusy,
	weekly,
	weeklyRows
} from "#test/schedules/derived/support.ts"
import { openActors } from "#test/support/schedules/actors.ts"
import {
	awaits,
	begin,
	blocksOn,
	check,
	commit,
	complete,
	op,
	rollback,
	schedule,
	sql
} from "#test/support/schedules/build.ts"
import { exactly, refreshed } from "#test/support/schedules/grizzle.ts"
import { ok, rowSet, rows } from "#test/support/schedules/match.ts"
import { planted } from "#test/support/schedules/planted.ts"
import { runSchedule } from "#test/support/schedules/runner.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const fresh = rows(["true"])

layer(Substrate.layer, { excludeTestServices: true })(
	"db.refresh under concurrent base writes",
	(it) => {
		it.effect(
			"a writer that read the view and wrote what the call read commits first; the call retries with it",
			planted("base writes/writer in a cycle", labelsGen, ["writer in a cycle"], (labels) =>
				Effect.gen(function* () {
					const o = yield* open(labels)
					const s = yield* Substrate
					yield* o.refresh("refresher", "StudentWeekly", "WeekBusy")
					const actors = {
						direct: yield* openActors(s, {
							holder: { kind: "raw", as: o.direct.holder },
							writer: { kind: "raw", as: o.direct.writer }
						}),
						grizzle: { refresher: o.refreshers.refresher }
					}
					const before = sat(30, 5, 4, true)
					const during = sat(31, 5, 4, false)
					const all = [...initial, before, during]
					return [
						yield* runSchedule(
							o.env,
							schedule("writer in a cycle", [
								sql("writer", addSitting(o, before), ok(), complete),
								begin("holder"),
								sql("holder", refreshSql(o, "WeekBusy", true), ok(), complete),
								op(
									"refresher",
									"db.refresh(StudentWeekly, WeekBusy)",
									o.refresh("refresher", "StudentWeekly", "WeekBusy"),
									refreshed(exactly("SerializationFailure")),
									blocksOn("holder")
								),
								begin("writer"),
								sql(
									"writer",
									weekly(o, o.seen.writer),
									rowSet(...weeklyRows(labels, initial)),
									complete
								),
								sql("writer", addSitting(o, during), ok(), complete),
								commit("writer", ok(), complete),
								rollback("holder"),
								awaits("refresher", complete),
								check(freshSql(o, "StudentWeekly"), fresh),
								check(freshSql(o, "WeekBusy"), fresh),
								check(weekly(o, o.view), rowSet(...weeklyRows(labels, all))),
								check(weekBusy(o, o.view), rowSet(...busyRows(labels, all)))
							]),
							actors
						)
					]
				})
			)
		)
	}
)
