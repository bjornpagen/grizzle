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
import { assert } from "#test/support/assert.ts"
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
import { Substrate } from "#test/support/substrate/substrate.ts"

/** The Walks example through the optimized lowering each walk's plan has one Recursive Union and no other deduplication (V6). */
export const theWalksExampleThroughTheOptimizedLoweringEachWalksPlanHasOneRecursiveUnionAndNoOtherDeduplicationV6 =
	property.explore(walkGen, {
		needs: { tx: Substrate.transaction },
		situations: [],
		/** Its pre-conversion budget: runs 12, no coverage (walks.test.ts at 4fbc3e95). */
		budget: { runs: 12, steered: 0 },
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
		needs: { tx: Substrate.transaction },
		situations: ["reached people", "reached nobody"] satisfies ReadonlyArray<
			Reached<ReachedFeature>
		>,
		/** Its pre-conversion budget: runs 12, coverage cases 24 (walks.test.ts at 4fbc3e95). */
		budget: { runs: 12, steered: 24 },
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
		needs: { tx: Substrate.transaction },
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
		/** Its pre-conversion budget: runs 24, coverage cases 48 (walks.test.ts at 4fbc3e95). */
		budget: { runs: 24, steered: 48 },
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
				original: '\t\t\t\t\tquery: select({ kind: "setOp", op: "UNION", arms: [base, step] }),',
				replacement:
					'\t\t\t\t\tquery: select({ kind: "setOp", op: "UNION ALL", rows: "operand", arms: [base, step] }),',
				why: "The optimized lowering's recursive CTE feeds back with UNION ALL, so repeated states are kept and a cycle never reaches its fixed point."
			}
		]
	})
