/**
 * The lowering shapes on PostgreSQL 19 (packages/engine/src/lower/shapes) that no generated suite reaches.
 *
 * The ledger fixture installs under a fresh schema, and the conditional aggregate's count(*) FILTER and CASE sum
 * (R24.conditionalCount) are checked against the conservative lowering, the oracle baseline that deduplicates at every
 * set boundary, by raw text row sets and with no repeated row, over generated groups where no binding, some and every
 * binding satisfies the predicate, the case a filtered sum gets wrong.
 *
 * Every other shape is the generated suites': the per-group takes, heading groups and the VALUES transport the
 * optimized differential's (test/pg/oracle/optimized), and the fused and pipelined attachments, spellings and
 * array_out quoting the public-boundary differential's (test/pg/oracle/public), decoded as an application reads them.
 * That the oracle tells a shape resting on an unsound fact from a sound one is the optimized differential's mutant
 * populations (test/pg/oracle/optimized/counterexamples.ts): each invalid rewrite is killed on its population.
 *
 * Oracle: the conservative lowering, a second implementation that deduplicates at every set boundary, its rows as a set
 * against the shaped statement's, PostgreSQL running both.
 *
 * Features: groups none, some and all of whose bindings qualify.
 */

import { defined, unorderedEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { conservativeInput } from "#compiler/lower/conservative/types.ts"
import {
	accounts,
	conditionalCaseGen,
	conservative,
	factInserts,
	fixtureTables,
	forms,
	shapesTemplate,
	literalOf,
	others,
	type Qualifying,
	qualifying,
	runProgram,
	tableOf
} from "#test/pg/lower-shapes/shapes.fixtures.ts"
import { replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { Task, uuidOf } from "#test/support/unit/lower/conservative/fixtures.ts"
import { conditional } from "#test/support/unit/lower/shapes/queries.ts"
import { shapedFacts, shapedProgram, testOptions } from "#test/support/unit/lower/shapes/support.ts"

/**
 * The lowering shapes on PostgreSQL 19 R24: the conditional count and sum agree with the composition on generated groups none, some or all of whose bindings qualify.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/lower-shapes/shapes.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/lower-shapes/shapes.test.ts` at its budget
 *   before, `{ runs: 60, steered: 60 }`, each kill's verdict printed with where its witnesses went red (judgedLine with
 *   the red's headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log; this budget run by
 *   path in run-budgets.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each declared kill applied alone and judged on the property's witnesses: its kept cases, its floor stream
 *   and its steered phase, which no run seed moves
 * @result its kill went red on the first case of its floor stream
 * @decision 1, the least a generative search draws, whose floor stream holds that one case; no headroom: a kill its
 *   witnesses stop killing fails the kill gate, which measures it again
 * @revalidate a change of its space, situations, kept cases or kills, of its label (the floor stream's seed), or of the
 *   runner's floor rule
 */
export const theLoweringShapesOnPostgreSQL19R24TheConditionalCountAndSumAgreeWithTheCompositionOnGeneratedGroupsNoneSomeOrAllOfWhoseBindingsQualify =
	property.explore(conditionalCaseGen, {
		needs: { shapes: Substrate.fresh(shapesTemplate) },
		situations: ["none qualify", "some qualify", "all qualify"] satisfies ReadonlyArray<
			Reached<Qualifying>
		>,
		budget: { runs: 1, steered: 60 },
		check:
			({ shapes }, k: Case<Qualifying>) =>
			(c) =>
				Effect.flatMap(shapes, (taken) =>
					Effect.provideService(
						Effect.gen(function* () {
							const schema = taken.value
							const { admin } = yield* Substrate
							const task = tableOf(schema, Task)
							const otherInserts = Arr.flatMap(others, (r) => factInserts(schema, r))

							yield* replaceRows(admin, fixtureTables(schema), [
								...Arr.map(otherInserts, (sql) => ({ sql, params: [] })),
								...(c.tasks.length === 0
									? []
									: [
											{
												sql: `INSERT INTO ${task} VALUES ${Arr.join(
													Arr.map(
														c.tasks,
														([account, amount], i) =>
															`(${Arr.join(
																Arr.map(
																	[
																		uuidOf(0x2000 + i),
																		defined(accounts[account], "an account"),
																		"Automatic",
																		String(amount)
																	],
																	(value, j) =>
																		literalOf(
																			schema,
																			defined(Task.heading[j], "a Task column"),
																			value
																		)
																),
																", "
															)})`
													),
													", "
												)}`,
												params: []
											}
										])
							])
							for (const form of forms) {
								const built = conditional(form, c.threshold)
								const query = conservativeInput(built)
								const composed = yield* runProgram(conservative(query, schema), {})
								const base = defined(composed[0], "the composition's statement")
								const { facts } = shapedFacts(built.dag, {}, "placement")
								const shapedRuns = yield* runProgram(
									shapedProgram(query, facts, testOptions(schema)),
									{}
								)
								const shaped = defined(shapedRuns[0], "the shaped statement")
								unorderedEqual(shaped.text, base.text, `${form} > ${c.threshold}`)
								if (form === "int4") {
									for (const [account, passed] of base.columns) {
										k.note(
											qualifying(
												Number(passed),
												Arr.filter(c.tasks, ([a]) => accounts[a] === account).length
											)
										)
									}
								}
							}
						}),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "the conservative lowering's rows, as a set, against the shaped statement's"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/aggregate/index.ts",
				original: "\t\t\treturn { ...countStar(), filter: lowerExpr(cx, shape.predicate, scope) }",
				replacement: "\t\t\treturn countStar()",
				why: "R24's conditional count lowers with no FILTER, counting every binding."
			}
		]
	})
