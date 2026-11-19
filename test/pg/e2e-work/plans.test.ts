import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { appendAll } from "#compiler/core/array.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { codeOf } from "#compiler/ir/codes.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import {
	accountOf,
	caseGen,
	type Entities,
	relations,
	runs,
	selectiveReads,
	series,
	type Sizes,
	tenantWorld,
	type WorkFeature,
	workPlansTemplate
} from "#test/pg/e2e-work/plans.fixtures.ts"
import { assert, defined } from "#test/support/assert.ts"
import { readOnce } from "#test/support/calls.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { pickIndex } from "#test/support/pick.ts"
import {
	plannedIndexes,
	recordingMembers,
	sentProblems,
	spread,
	unanalyzed
} from "#test/support/plans.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { beginSerializable } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { untilAnswered } from "#test/support/transient.ts"

/**
 * The worked example's plans every selective read through its indexes, on drawn small loads.
 *
 * Its pre-conversion budget: runs runs, coverage cases runs (test/pg/e2e-work/plans.test.ts at fd71eef13).
 */
export const theWorkedExamplesPlansEverySelectiveReadThroughItsIndexesOnDrawnSmallLoads =
	property.explore(caseGen, {
		needs: { work: Substrate.seat(workPlansTemplate) },
		situations: ["a read by a busy account", "a read by another account"] satisfies ReadonlyArray<
			Reached<WorkFeature>
		>,
		check:
			({ work }, cx: Case<WorkFeature>) =>
			({ sizes, pick }) =>
				Effect.scoped(
					Effect.flatMap(work, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const m = taken.value
								const world = tenantWorld(m.declared)
								const s = yield* Substrate
								const names = m.names
								const table = (relation: string): string =>
									printObjectName(names.relation(relation))
								const columns = (relation: string, fields: ReadonlyArray<string>): string =>
									Arr.join(
										Arr.map(fields, (f) => quoteIdent(names.column(relation, f))),
										", "
									)
								const column = (relation: string, field: string): string =>
									quoteIdent(names.column(relation, field))
								const kind = defined(
									names.codes.rosters.get(parsedName("Kind")),
									"the codes of Kind"
								)
								/** Work at `sizes`, written whole in one SERIALIZABLE transaction over emptied tables, then left unanalyzed. */
								const loadAt = (sizes: Sizes) =>
									Effect.gen(function* () {
										const load = [
											`TRUNCATE ${Arr.join(Arr.map(relations, table), ", ")}`,
											`INSERT INTO ${table("Account")} (${columns("Account", ["id", "name"])}) ` +
												`SELECT md5('account:' || g)::uuid, 'account ' || lpad(g::text, 6, '0') ${series(sizes.accounts)}`,
											`INSERT INTO ${table("Task")} (${columns("Task", ["id", "account", "kind"])}) ` +
												`SELECT md5('task:' || g)::uuid, md5('account:' || ${spread(1, sizes.accounts)})::uuid, ` +
												`(CASE WHEN g % 2 = 0 THEN ${codeOf(kind, "Automatic")} ELSE ${codeOf(kind, "Manual")} END)::smallint ${series(sizes.tasks)}`,
											`INSERT INTO ${table("AutomaticTask")} (${columns("AutomaticTask", ["task", "budget"])}) ` +
												`SELECT md5('task:' || (2 * g))::uuid, ${spread(2, 10_000)} ${series(sizes.tasks / 2)}`,
											`INSERT INTO ${table("ManualTask")} (${columns("ManualTask", ["task", "operator"])}) ` +
												`SELECT md5('task:' || (2 * g + 1))::uuid, 'operator ' || g ${series(sizes.tasks / 2)}`,
											`INSERT INTO ${table("TaskNote")} (${columns("TaskNote", ["task", "note"])}) ` +
												`SELECT md5('task:' || (3 * g))::uuid, 'note ' || g ${series(Math.floor((sizes.tasks - 1) / 3) + 1)}`
										]
										yield* Effect.onError(
											Effect.gen(function* () {
												yield* s.admin.query(beginSerializable, [])
												for (const statement of load) {
													yield* s.admin.query(statement, [])
												}
												yield* s.admin.query("COMMIT", [])
											}),
											() => Effect.ignore(s.admin.query("ROLLBACK", []))
										)
										yield* unanalyzed(
											s.admin,
											Arr.map(relations, (r) => names.relation(r))
										)
										const busiest = yield* s.admin.queryValues(
											`SELECT ${column("Task", "account")}::text FROM ${table("Task")} GROUP BY 1 ORDER BY count(*) DESC, 1`,
											[]
										)
										const tasks = yield* s.admin.queryValues(
											`SELECT ${column("Task", "id")}::text FROM ${table("Task")} ORDER BY 1`,
											[]
										)
										const e: Entities = {
											accounts: Arr.map(
												trusted<ReadonlyArray<readonly [string]>>(busiest),
												([a]) => a
											),
											tasks: Arr.map(trusted<ReadonlyArray<readonly [string]>>(tasks), ([id]) => id)
										}
										return e
									})
								const planned = plannedIndexes(m.installation)
								return yield* Effect.gen(function* () {
									cx.note(
										pickIndex(pick, 4) === 0
											? "a read by a busy account"
											: "a read by another account"
									)
									const e = yield* loadAt(sizes)
									const account = accountOf(e, pick)
									yield* withServedDb(m, world.server.roles.tenant, { account }, ({ ctx, load }) =>
										Effect.gen(function* () {
											const loaded = yield* load(world.reads)
											const { calls, counts } = recordingMembers(ctx)
											const problems: Array<string> = []
											for (const read of selectiveReads(e, sizes, pick, account)) {
												const before = counts.sent.length
												yield* untilAnswered(
													readOnce(calls(member(loaded, read.name)))({
														params: read.params,
														facts: {}
													}),
													() => undefined
												)
												const judged = yield* sentProblems(
													s.admin,
													read.name,
													counts.sent.slice(before),
													planned
												)
												appendAll(problems, judged)
											}
											assert.deepEqual(
												problems,
												[],
												"every selective read is planned through its indexes"
											)
										})
									)
								}).pipe(Effect.scoped)
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "postgresql",
			name: "PostgreSQL's plans with sequential and index scans disabled"
		},
		budget: { runs: runs, steered: runs },
		kept: [],
		kills: []
	})
