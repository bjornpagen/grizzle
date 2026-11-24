import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { groupingSteps } from "#bench/harness/explain.ts"
import { explainMain, lowerCase } from "#test/pg/recursion/lowering/support.ts"
import {
	caseOf,
	type CounterFeature,
	counterGen,
	counterOf,
	names,
	optimized,
	reachableBy,
	type ReachedFeature,
	vertexId,
	walkGen,
	walksBelow
} from "#test/pg/recursion/lowering/walks.fixtures.ts"
import { programAsts } from "#test/support/compile.ts"
import { featureCount, shapeOf } from "#test/support/kernel/shape.ts"
import {
	conservative,
	defaultRunOptions,
	printOutcome,
	reference,
	runLabelledOracle
} from "#test/support/oracle/runner.ts"
import { OracleSeat } from "#test/support/oracle/seat.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** The Walks example through the optimized lowering each walk's plan has one Recursive Union and no other deduplication (V6). */
export const theWalksExampleThroughTheOptimizedLoweringEachWalksPlanHasOneRecursiveUnionAndNoOtherDeduplicationV6 =
	property.explore(walkGen, {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: [],
		/**
		 * Its search budget: 1 run of its rotating stream, so a floor of 1 (a quarter of the runs, rounded up), and no
		 * steered phase, since it requires no situation. Its floor is fixed by its identity, so every run seed judges its
		 * kills alike.
		 *
		 * @limitKind measured
		 * @owner test/pg/recursion/lowering/walks.test.ts's property
		 *   theWalksExampleThroughTheOptimizedLoweringEachWalksPlanHasOneRecursiveUnionAndNoOtherDeduplicationV6, its search
		 * @unit cases: the rotating stream's runs, and the steered phase's most
		 * @scope one run of the property, on any run seed: its kept cases, its floor, its steered phase and its rotating
		 *   stream
		 * @evidence ~/.cache/grizzle/CULL-PAGEREC-notes: kills0.log, `toolchain-test kills test/pg/recursion
		 *   test/pg/page/generated-optimized.test.ts` at the pre-conversion budgets, each kill's first red witness printed by
		 *   a local line in the kills command's report, never committed; m1run.log and m2run.log with their run records
		 *   m1run.json and m2run.json, `toolchain-test run` of the module at the budgets in @workload, every kill judged
		 *   after its search and none answered by a cached verdict; final1.log and final1.json, the same at this budget under
		 *   a verdict cache of its own; each run under TEST_SEED=2219874524, its budget rewritten for the run
		 * @observed 2026-11-23 03:27 to 04:39 UTC
		 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB, shared with other lanes' runs (1-minute
		 *   load 390 to 550); PostgreSQL 19.0, the in-memory family grizzle-m-cull-pagerec, two members settled by
		 *   toolchain-pg settle; grizzle f87b2aaab with test/pg/page's cull; vendor/toolchain 2cc4817; Node 26.13.1
		 * @workload this property at { runs, steered } of { 12, 0 }, its pre-conversion budget (walks.test.ts at 4fbc3e95),
		 *   then { 1, 0 }
		 * @result At { 12, 0 }, 15 cases at f1bf91a2f's gate, its kill went red on floor case 0. Green, every case passing,
		 *   and every kill killed at { 1, 0 } (2 cases, 0 steered); and at { 1, 0 } again under a verdict cache of its own
		 *   (final1). Worker CPU is a loaded machine's and not compared
		 * @decision runs 1, the fewest a rotating stream runs: its kill is red on floor case 0 at every budget measured;
		 *   steered 0, as it requires no situation.
		 * @revalidate a red naming an unreached situation; a kill added or changed; an edit to the property's identity (its
		 *   file or name), its generator or its situations; the runner's floor and steering (the toolchain's
		 *   runner/search.ts, random.ts and limits.ts)
		 */
		budget: { runs: 1, steered: 0 },
		check:
			({ tx }) =>
			(k) =>
				Effect.flatMap(tx, (held) =>
					Effect.provideService(
						Effect.gen(function* () {
							const c = caseOf(
								"Walks",
								walksBelow("Walks", k.bound),
								{ start: vertexId(k.start) },
								k.graph
							)
							const plan = yield* explainMain(c, optimized)
							assert.equal(
								Arr.filter(plan.nodes, (n) => n === "Recursive Union").length,
								1,
								plan.sql
							)
							assert.equal(
								Arr.filter(plan.nodes, (n) => n === "WorkTable Scan").length,
								1,
								plan.sql
							)
							assert.deepEqual(
								groupingSteps(plan.nodes),
								[],
								`${Arr.join(plan.nodes, ", ")}\n${plan.sql}`
							)
						}),
						OracleSeat,
						OracleSeat.rolledBack(held)
					)
				),
		oracle: {
			kind: "postgresql",
			name: "EXPLAIN's plan: one Recursive Union over one WorkTable Scan and no other deduplication step"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/print.ts",
				original: '\tout.line("BEGIN")',
				replacement: "\t{}",
				why: 'Operator mutant (statement) at packages/engine/src/sql/print.ts:1571 in plBlock: `out.line("BEGIN")` becomes `{}`; the property fails (lane CATCH, grizzle 0baff5d6).'
			}
		]
	})

/** The Walks example through the optimized lowering dropping the hop count deduplicates once, outside the recursion, and agrees with the reference. */
export const theWalksExampleThroughTheOptimizedLoweringDroppingTheHopCountDeduplicatesOnceOutsideTheRecursionAndAgreesWithTheReference =
	property.explore(walkGen, {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: ["reached people", "reached nobody"] satisfies ReadonlyArray<
			Reached<ReachedFeature>
		>,
		/**
		 * Its search budget: 1 run of its rotating stream, so a floor of 1 (a quarter of the runs, rounded up), and at most
		 * 16 steered cases, the phase that runs only while a required situation is unreached. Its witnesses, the floor and
		 * the steered phase, are fixed by its identity, so every run seed reaches its situations and judges its kills alike.
		 *
		 * @limitKind measured
		 * @owner test/pg/recursion/lowering/walks.test.ts's property
		 *   theWalksExampleThroughTheOptimizedLoweringDroppingTheHopCountDeduplicatesOnceOutsideTheRecursionAndAgreesWithTheReference,
		 *   its search
		 * @unit cases: the rotating stream's runs, and the steered phase's most
		 * @scope one run of the property, on any run seed: its kept cases, its floor, its steered phase and its rotating
		 *   stream
		 * @evidence ~/.cache/grizzle/CULL-PAGEREC-notes: kills0.log, `toolchain-test kills test/pg/recursion
		 *   test/pg/page/generated-optimized.test.ts` at the pre-conversion budgets, each kill's first red witness printed by
		 *   a local line in the kills command's report, never committed; m1run.log and m2run.log with their run records
		 *   m1run.json and m2run.json, `toolchain-test run` of the module at the budgets in @workload, every kill judged
		 *   after its search and none answered by a cached verdict; final1.log and final1.json, the same at this budget under
		 *   a verdict cache of its own; each run under TEST_SEED=2219874524, its budget rewritten for the run
		 * @observed 2026-11-23 03:27 to 04:39 UTC
		 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB, shared with other lanes' runs (1-minute
		 *   load 390 to 550); PostgreSQL 19.0, the in-memory family grizzle-m-cull-pagerec, two members settled by
		 *   toolchain-pg settle; grizzle f87b2aaab with test/pg/page's cull; vendor/toolchain 2cc4817; Node 26.13.1
		 * @workload this property at { runs, steered } of { 12, 24 }, its pre-conversion budget (walks.test.ts at 4fbc3e95),
		 *   then { 1, 2000 }, { 5, 2000 }
		 * @result At { 12, 24 }, 31 cases at f1bf91a2f's gate, its kill went red on floor case 0. Green, every required
		 *   situation reached by a witness, and every kill killed at { 1, 2000 } (18 cases, 16 steered); { 5, 2000 } (23
		 *   cases, 16 steered); and at { 1, 16 } again under a verdict cache of its own (final1). Worker CPU is a loaded
		 *   machine's and not compared
		 * @decision runs 1 and steered 16, the fewest cases measured: from a floor of 1, 2 or 3 the steered phase reaches its
		 *   situations in 16 cases, so a larger floor only adds cases; its kill is red on floor case 0 at every budget
		 *   measured. The steered phase stops once every situation is reached, so its cap costs no case beyond those it runs.
		 *   No headroom: a run that reaches fewer situations says which
		 * @revalidate a red naming an unreached situation; a kill added or changed; an edit to the property's identity (its
		 *   file or name), its generator or its situations; the runner's floor and steering (the toolchain's
		 *   runner/search.ts, random.ts and limits.ts)
		 */
		budget: { runs: 1, steered: 16 },
		check:
			({ tx }, c: Case<ReachedFeature>) =>
			(k) =>
				Effect.flatMap(tx, (held) =>
					Effect.provideService(
						Effect.gen(function* () {
							const seat = yield* OracleSeat
							const name = yield* seat.schema("reachable")

							const reached = caseOf(
								"Reachable",
								reachableBy(walksBelow("Walks", k.bound)),
								{ person: vertexId(k.start) },
								k.graph
							)
							const outcome = yield* runLabelledOracle(reached, optimized, reference, {
								...defaultRunOptions,
								schema: { kind: "named", name: name }
							})
							assert.equal(outcome.comparison.equal, true, printOutcome(outcome))
							const plan = yield* explainMain(reached, optimized)
							assert.equal(Arr.filter(plan.nodes, (n) => n === "Recursive Union").length, 1)
							assert.equal(
								groupingSteps(plan.nodes).length,
								1,
								`${Arr.join(plan.nodes, ", ")}\n${plan.sql}`
							)
							c.note(
								Arr.some(outcome.left.run.statements, (st) => st.rows.length > 0)
									? "reached people"
									: "reached nobody"
							)
						}),
						OracleSeat,
						OracleSeat.rolledBack(held)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "the reference evaluator over the same facts; EXPLAIN's plan, one Recursive Union and one deduplication"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/print.ts",
				original: '\tout.line("BEGIN")',
				replacement: "\t{}",
				why: 'Operator mutant (statement) at packages/engine/src/sql/print.ts:1571 in plBlock: `out.line("BEGIN")` becomes `{}`; the property fails (lane CATCH, grizzle 0baff5d6).'
			}
		]
	})

/** Counter shapes through the optimized lowering each lowers to the recursive CTE and agrees with the reference and the conservative lowering. */
export const counterShapesThroughTheOptimizedLoweringEachLowersToTheRecursiveCTEAndAgreesWithTheReferenceAndTheConservativeLowering =
	property.explore(counterGen, {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: [
			"counting up",
			"counting down",
			"arms counting both ways",
			"two seeds",
			"a stride of two",
			"a backward arm",
			"a between",
			"swapped operands",
			"a non-strict bound",
			"rows reached past a seed"
		] satisfies ReadonlyArray<Reached<CounterFeature>>,
		/**
		 * Its search budget: 1 run of its rotating stream, so a floor of 1 (a quarter of the runs, rounded up), and at most
		 * 16 steered cases, the phase that runs only while a required situation is unreached. Its witnesses, the floor and
		 * the steered phase, are fixed by its identity, so every run seed reaches its situations and judges its kills alike.
		 *
		 * @limitKind measured
		 * @owner test/pg/recursion/lowering/walks.test.ts's property
		 *   counterShapesThroughTheOptimizedLoweringEachLowersToTheRecursiveCTEAndAgreesWithTheReferenceAndTheConservativeLowering,
		 *   its search
		 * @unit cases: the rotating stream's runs, and the steered phase's most
		 * @scope one run of the property, on any run seed: its kept cases, its floor, its steered phase and its rotating
		 *   stream
		 * @evidence ~/.cache/grizzle/CULL-PAGEREC-notes: kills0.log, `toolchain-test kills test/pg/recursion
		 *   test/pg/page/generated-optimized.test.ts` at the pre-conversion budgets, each kill's first red witness printed by
		 *   a local line in the kills command's report, never committed; m1run.log and m2run.log with their run records
		 *   m1run.json and m2run.json, `toolchain-test run` of the module at the budgets in @workload, every kill judged
		 *   after its search and none answered by a cached verdict; final1.log and final1.json, the same at this budget under
		 *   a verdict cache of its own; each run under TEST_SEED=2219874524, its budget rewritten for the run
		 * @observed 2026-11-23 03:27 to 04:39 UTC
		 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB, shared with other lanes' runs (1-minute
		 *   load 390 to 550); PostgreSQL 19.0, the in-memory family grizzle-m-cull-pagerec, two members settled by
		 *   toolchain-pg settle; grizzle f87b2aaab with test/pg/page's cull; vendor/toolchain 2cc4817; Node 26.13.1
		 * @workload this property at { runs, steered } of { 24, 48 }, its pre-conversion budget (walks.test.ts at 4fbc3e95),
		 *   then { 1, 2000 }, { 5, 2000 }
		 * @result At { 24, 48 }, 30 cases at f1bf91a2f's gate, its kill went red on floor case 0. Green, every required
		 *   situation reached by a witness, and every kill killed at { 1, 2000 } (18 cases, 16 steered); { 5, 2000 } (23
		 *   cases, 16 steered); and at { 1, 16 } again under a verdict cache of its own (final1). Worker CPU is a loaded
		 *   machine's and not compared
		 * @decision runs 1 and steered 16, the fewest cases measured: from a floor of 1 or 2 the steered phase reaches every
		 *   situation in 16 cases, and a floor of 6 reaches them with none in 30 cases; its kill is red on floor case 0 at
		 *   every budget measured. The steered phase stops once every situation is reached, so its cap costs no case beyond
		 *   those it runs. No headroom: a run that reaches fewer situations says which
		 * @revalidate a red naming an unreached situation; a kill added or changed; an edit to the property's identity (its
		 *   file or name), its generator or its situations; the runner's floor and steering (the toolchain's
		 *   runner/search.ts, random.ts and limits.ts)
		 */
		budget: { runs: 1, steered: 16 },
		check:
			({ tx }, c: Case<CounterFeature>) =>
			(k) =>
				Effect.flatMap(tx, (held) =>
					Effect.provideService(
						Effect.gen(function* () {
							const seat = yield* OracleSeat
							const name = yield* seat.schema("counters")

							const counted = caseOf("Counter", counterOf(k), { start: vertexId(k.start) }, k.graph)
							const u = lowerCase(counted, names)
							if (!u.ok) {
								return assert.fail(`the counter is refused: ${u.error.message}`)
							}
							const [statement] = programAsts(u.value)
							assert.ok(
								featureCount(shapeOf(statement), "with recursive") > 0,
								"the counter lowers to the recursive CTE"
							)
							const outcome = yield* runLabelledOracle(counted, optimized, reference, {
								...defaultRunOptions,
								schema: { kind: "named", name: name }
							})
							assert.equal(outcome.comparison.equal, true, printOutcome(outcome))
							const against = yield* runLabelledOracle(counted, optimized, conservative, {
								...defaultRunOptions,
								schema: { kind: "named", name: name }
							})
							assert.equal(against.comparison.equal, true, printOutcome(against))
							const up = Arr.some(k.arms, (arm) => arm.step > 0)
							const down = Arr.some(k.arms, (arm) => arm.step < 0)
							c.note(up ? "counting up" : "counting down")
							if (up && down) {
								c.note("arms counting both ways")
							}
							if (k.seeds.length > 1) {
								c.note("two seeds")
							}
							if (Arr.some(k.arms, (arm) => Math.abs(arm.step) > 1)) {
								c.note("a stride of two")
							}
							if (Arr.some(k.arms, (arm) => arm.backward)) {
								c.note("a backward arm")
							}
							for (const { bound } of k.arms) {
								if (bound.kind === "between") {
									c.note("a between")
								} else {
									if (bound.swapped) {
										c.note("swapped operands")
									}
									if (!bound.strict) {
										c.note("a non-strict bound")
									}
								}
							}
							if (Arr.some(outcome.left.run.statements, (st) => st.rows.length > k.seeds.length)) {
								c.note("rows reached past a seed")
							}
						}),
						OracleSeat,
						OracleSeat.rolledBack(held)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "the reference evaluator and the conservative lowering over the same facts"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/recursion/index.ts",
				original: '\t\t\t\t\t\tselect({ kind: "setOp", op: "UNION", arms: [base, step] }),',
				replacement:
					'\t\t\t\t\t\tselect({ kind: "setOp", op: "UNION ALL", rows: "operand", arms: [base, step] }),',
				why: "The optimized lowering's recursive CTE feeds back with UNION ALL, so repeated states are kept and a cycle never reaches its fixed point."
			}
		]
	})
