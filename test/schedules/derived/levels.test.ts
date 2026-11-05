/**
 * Levels: a level chain publishes in one commit.
 *
 * - One call naming a level chain publishes every named view in one commit: a reader between its two statements sees
 *   neither refreshed, and after it both.
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
	type Sat,
	sat,
	studentTotals,
	totalRows,
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
	complete,
	rollback,
	schedule,
	sql
} from "#test/support/schedules/build.ts"
import { exactly, refreshed, retriedOp } from "#test/support/schedules/grizzle.ts"
import { ok, rowSet, rows } from "#test/support/schedules/match.ts"
import { planted } from "#test/support/schedules/planted.ts"
import { runSchedule } from "#test/support/schedules/runner.ts"
import { type Step } from "#test/support/schedules/types.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const fresh = rows(["true"])

layer(Substrate.layer, { excludeTestServices: true })("db.refresh across levels", (it) => {
	it.effect(
		"one call publishes a level chain in one commit; a reader sees neither level before it",
		planted("levels/one commit", labelsGen, ["one commit"], (labels) =>
			Effect.gen(function* () {
				const o = yield* open(labels)
				const s = yield* Substrate
				yield* o.refresh("refresher", "StudentWeekly", "StudentTotal", "WeekBusy")
				const actors = {
					direct: yield* openActors(s, {
						holder: { kind: "raw", as: o.direct.holder },
						writer: { kind: "psql", as: o.direct.writer },
						reader: { kind: "raw", as: o.direct.reader }
					}),
					grizzle: { refresher: o.refreshers.refresher }
				}
				/** What the reader sees of every view refreshed over `sats`. */
				const reads = (sats: ReadonlyArray<Sat>): ReadonlyArray<Step<"reader", never, never>> => [
					sql("reader", weekly(o, o.seen.reader), rowSet(weeklyRows(labels, sats)), complete),
					sql("reader", studentTotals(o, o.seen.reader), rowSet(totalRows(labels, sats)), complete),
					sql("reader", weekBusy(o, o.seen.reader), rowSet(busyRows(labels, sats)), complete)
				]
				const newcomer = sat(40, 6, 7, true)
				return [
					yield* runSchedule(
						o.env,
						schedule("one commit", [
							sql("writer", addSitting(o, newcomer), ok(), complete),
							begin("holder"),
							sql("holder", refreshSql(o, "WeekBusy", true), ok(), complete),
							retriedOp(
								"refresher",
								"db.refresh(WeekBusy, StudentTotal, StudentWeekly)",
								o.refresh("refresher", "WeekBusy", "StudentTotal", "StudentWeekly"),
								refreshed(exactly()),
								blocksOn("holder")
							),
							...reads(initial),
							rollback("holder"),
							awaits("refresher", complete),
							...reads([...initial, newcomer]),
							check(freshSql(o, "StudentWeekly"), fresh),
							check(freshSql(o, "StudentTotal"), fresh),
							check(freshSql(o, "WeekBusy"), fresh)
						]),
						actors
					)
				]
			})
		)
	)
})
