/**
 * Two concurrent refreshers of one relation both succeed, whether or not their diffs touch the same rows.
 *
 * "Two refreshers without one [a lease] are correct and merely repeat work". A raw transaction of the role `holder`,
 * as another db.refresh would be, refreshes a view CONCURRENTLY and holds its EXCLUSIVE lock, so the grizzle
 * refreshers queue behind it with snapshots taken before they wait:
 *
 * - diffs touching the same row: each later refresher's diff deletes a row the holder replaced, which PostgreSQL
 *   refuses with 40001; each retries and converges;
 * - a key the holder inserted: the later refresher inserts it too, and that conflict is 40001, never 23505, so it
 *   retries rather than failing as a compiler defect;
 * - diffs touching different rows: the waiter's diff never meets the other refresher's row, yet it is a pivot between
 *   the two and fails with 40001, so it never commits a view that is the definition at no snapshot, and its retry
 *   converges;
 * - the first population: both refreshers read the view unpopulated and take the plain form, which swaps in a new heap
 *   instead of diffing tuples, so neither a unique index nor SSI meets the other refresher's commit. Before a plain
 *   refresh statement db.refresh waits for any plain refresh of the view in progress and compares the view's storage
 *   in its snapshot with the current one; another refresher's population committed
 *   after its snapshot is met there as a serialization failure, and the retry takes the concurrent form. Without that
 *   check the refresher whose snapshot is older, committing last, overwrites the other's StudentTotal with an older
 *   state, which no serial order of the two produces.
 *
 * After every schedule each view equals its definition evaluated by the conservative lowering, and the host model of
 * its definition over the sittings it was refreshed at.
 */

import { layer } from "@effect/vitest"
import { Effect } from "effect"
import {
	addSitting,
	dropSitting,
	freshSql,
	initial,
	labelsGen,
	open,
	refreshSql,
	sat,
	studentTotals,
	totalRows,
	weekly,
	weeklyRows
} from "#test/schedules/derived/support.ts"
import { openActors } from "#test/support/schedules/actors.ts"
import {
	awaits,
	begin,
	blocksAny,
	blocksOn,
	check,
	commit,
	complete,
	mayWait,
	op,
	rollback,
	schedule,
	sql
} from "#test/support/schedules/build.ts"
import { exactly, refreshed, within } from "#test/support/schedules/grizzle.ts"
import { ok, rowSet, rows } from "#test/support/schedules/match.ts"
import { planted } from "#test/support/schedules/planted.ts"
import { runSchedule } from "#test/support/schedules/runner.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const fresh = rows(["true"])

layer(Substrate.layer, { excludeTestServices: true })(
	"two concurrent refreshers of one relation",
	(it) => {
		it.effect(
			"diffs touching the same row: both later refreshers meet 40001, retry and succeed",
			planted("refreshers/same rows", labelsGen, ["same rows"], (labels) =>
				Effect.gen(function* () {
					const o = yield* open(labels)
					const s = yield* Substrate
					yield* o.refresh("refresher", "StudentWeekly", "StudentTotal", "WeekBusy")
					const actors = {
						direct: yield* openActors(s, {
							holder: { kind: "raw", as: o.direct.holder },
							writer: { kind: "psql", as: o.direct.writer }
						}),
						grizzle: o.refreshers
					}
					/** Student 1's week 1 changes three times over: each refresher's diff replaces that one row. */
					const first = sat(5, 1, 1, true)
					const second = sat(6, 1, 1, false)
					return [
						yield* runSchedule(
							o.env,
							schedule("same rows", [
								sql("writer", addSitting(o, first), ok(), complete),
								begin("holder"),
								sql("holder", refreshSql(o, "StudentWeekly", true), ok(), complete),
								op(
									"refresher",
									"db.refresh(StudentWeekly)",
									o.refresh("refresher", "StudentWeekly"),
									refreshed(within(1, 4, ["SerializationFailure", "Deadlock"])),
									blocksOn("holder")
								),
								sql("writer", addSitting(o, second), ok(), complete),
								op(
									"refresher2",
									"db.refresh(StudentWeekly)",
									o.refresh("refresher2", "StudentWeekly"),
									refreshed(within(1, 4, ["SerializationFailure", "Deadlock"])),
									blocksAny
								),
								commit("holder", ok(), complete),
								awaits("refresher", mayWait),
								awaits("refresher2", mayWait),
								check(freshSql(o, "StudentWeekly"), fresh),
								check(weekly(o, o.view), rowSet(weeklyRows(labels, [...initial, first, second])))
							]),
							actors
						)
					]
				})
			)
		)

		it.effect(
			"a key the first refresher inserted is 40001, never 23505: both succeed",
			planted("refreshers/inserted key", labelsGen, ["an inserted key"], (labels) =>
				Effect.gen(function* () {
					const o = yield* open(labels)
					const s = yield* Substrate
					yield* o.refresh("refresher", "StudentWeekly", "StudentTotal", "WeekBusy")
					const actors = {
						direct: yield* openActors(s, {
							holder: { kind: "raw", as: o.direct.holder },
							writer: { kind: "psql", as: o.direct.writer }
						}),
						grizzle: o.refreshers
					}
					/** New students only: every diff is insertions, and each later one inserts a key already committed. */
					const first = sat(6, 6, 1, true)
					const second = sat(7, 7, 1, true)
					return [
						yield* runSchedule(
							o.env,
							schedule("an inserted key", [
								sql("writer", addSitting(o, first), ok(), complete),
								begin("holder"),
								sql("holder", refreshSql(o, "StudentTotal", true), ok(), complete),
								op(
									"refresher",
									"db.refresh(StudentTotal)",
									o.refresh("refresher", "StudentTotal"),
									refreshed(within(1, 4, ["SerializationFailure", "Deadlock"])),
									blocksOn("holder")
								),
								sql("writer", addSitting(o, second), ok(), complete),
								op(
									"refresher2",
									"db.refresh(StudentTotal)",
									o.refresh("refresher2", "StudentTotal"),
									refreshed(within(1, 4, ["SerializationFailure", "Deadlock"])),
									blocksAny
								),
								commit("holder", ok(), complete),
								awaits("refresher", mayWait),
								awaits("refresher2", mayWait),
								check(freshSql(o, "StudentTotal"), fresh),
								check(
									studentTotals(o, o.view),
									rowSet(totalRows(labels, [...initial, first, second]))
								)
							]),
							actors
						)
					]
				})
			)
		)

		it.effect(
			"diffs touching different rows: the waiter is the pivot, fails 40001 and retries; both succeed",
			planted("refreshers/different rows", labelsGen, ["different rows"], (labels) =>
				Effect.gen(function* () {
					const o = yield* open(labels)
					const s = yield* Substrate
					yield* o.refresh("refresher", "StudentWeekly", "StudentTotal")
					const actors = {
						direct: yield* openActors(s, {
							holder: { kind: "raw", as: o.direct.holder },
							writer: { kind: "psql", as: o.direct.writer }
						}),
						grizzle: o.refreshers
					}
					/**
					 * Sitting 2 of student 1 is dropped and sat again, so student 1's total is back where the view has it;
					 * student 9 appears.
					 */
					const back = sat(2, 1, 1, false)
					const newcomer = sat(13, 9, 1, true)
					const after = totalRows(labels, [...initial, newcomer])
					return [
						yield* runSchedule(
							o.env,
							schedule("different rows", [
								sql("writer", dropSitting(o, back), ok(), complete),
								begin("holder"),
								sql("holder", refreshSql(o, "StudentWeekly", true), ok(), complete),
								op(
									"refresher",
									"db.refresh(StudentTotal, StudentWeekly)",
									o.refresh("refresher", "StudentTotal", "StudentWeekly"),
									refreshed(exactly("SerializationFailure")),
									blocksOn("holder")
								),
								sql("writer", addSitting(o, back), ok(), complete),
								sql("writer", addSitting(o, newcomer), ok(), complete),
								op(
									"refresher2",
									"db.refresh(StudentTotal)",
									o.refresh("refresher2", "StudentTotal"),
									refreshed(exactly()),
									complete
								),
								check(studentTotals(o, o.view), rowSet(after)),
								rollback("holder"),
								awaits("refresher", complete),
								check(studentTotals(o, o.view), rowSet(after)),
								check(freshSql(o, "StudentTotal"), fresh),
								check(freshSql(o, "StudentWeekly"), fresh)
							]),
							actors
						)
					]
				})
			)
		)

		it.effect(
			"the first population: both meet the other plain refresh at the rewrite check, retry concurrently and succeed",
			planted("refreshers/first population", labelsGen, ["first population"], (labels) =>
				Effect.gen(function* () {
					const o = yield* open(labels)
					const s = yield* Substrate
					const actors = {
						direct: yield* openActors(s, {
							holder: { kind: "raw", as: o.direct.holder },
							writer: { kind: "psql", as: o.direct.writer }
						}),
						grizzle: o.refreshers
					}
					const newcomer = sat(8, 8, 1, true)
					return [
						yield* runSchedule(
							o.env,
							schedule("first population", [
								begin("holder"),
								sql("holder", refreshSql(o, "StudentTotal", false), ok(), complete),
								op(
									"refresher",
									"db.refresh(StudentTotal)",
									o.refresh("refresher", "StudentTotal"),
									refreshed(
										within(1, 2, ["ConcurrentRefresh", "Deadlock", "SerializationFailure"])
									),
									blocksOn("holder")
								),
								sql("writer", addSitting(o, newcomer), ok(), complete),
								op(
									"refresher2",
									"db.refresh(StudentTotal)",
									o.refresh("refresher2", "StudentTotal"),
									refreshed(
										within(1, 2, ["ConcurrentRefresh", "Deadlock", "SerializationFailure"])
									),
									blocksAny
								),
								commit("holder", ok(), complete),
								awaits("refresher", mayWait),
								awaits("refresher2", mayWait),
								check(freshSql(o, "StudentTotal"), fresh),
								check(studentTotals(o, o.view), rowSet(totalRows(labels, [...initial, newcomer])))
							]),
							actors
						)
					]
				})
			)
		)

		it.effect(
			"first populations in the other order: the older snapshot meets the other refresher's commit, retries, and both views end fresh",
			planted(
				"refreshers/first populations, older last",
				labelsGen,
				["first populations, the older snapshot last"],
				(labels) =>
					Effect.gen(function* () {
						const o = yield* open(labels)
						const s = yield* Substrate
						const actors = {
							direct: yield* openActors(s, {
								holder: { kind: "raw", as: o.direct.holder },
								writer: { kind: "psql", as: o.direct.writer }
							}),
							grizzle: o.refreshers
						}
						const newcomer = sat(8, 8, 1, true)
						const after = rowSet(totalRows(labels, [...initial, newcomer]))
						return [
							yield* runSchedule(
								o.env,
								schedule("first populations, the older snapshot last", [
									begin("holder"),
									sql("holder", refreshSql(o, "StudentWeekly", false), ok(), complete),
									op(
										"refresher",
										"db.refresh(StudentWeekly, StudentTotal)",
										o.refresh("refresher", "StudentWeekly", "StudentTotal"),
										refreshed(exactly("ConcurrentRefresh")),
										blocksOn("holder")
									),
									sql("writer", addSitting(o, newcomer), ok(), complete),
									op(
										"refresher2",
										"db.refresh(StudentTotal)",
										o.refresh("refresher2", "StudentTotal"),
										refreshed(exactly()),
										complete
									),
									check(studentTotals(o, o.view), after),
									rollback("holder"),
									awaits("refresher", complete),
									check(studentTotals(o, o.view), after),
									check(weekly(o, o.view), rowSet(weeklyRows(labels, [...initial, newcomer]))),
									check(freshSql(o, "StudentTotal"), fresh),
									check(freshSql(o, "StudentWeekly"), fresh)
								]),
								actors
							)
						]
					})
			)
		)
	}
)
