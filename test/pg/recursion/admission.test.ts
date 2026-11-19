import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	type AgreedFeature,
	caseOfSketch,
	recursions,
	sketchGen
} from "#test/pg/recursion/admission.fixtures.ts"
import {
	conservative,
	defaultRunOptions,
	printOutcome,
	reference,
	runLabelledOracle
} from "#test/support/oracle/runner.ts"
import { OracleSeat } from "#test/support/oracle/seat.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** Admitted recursions on PostgreSQL 19 agree with the reference evaluator as raw text sets, with no repeated row. */
export const admittedRecursionsOnPostgreSQL19AgreeWithTheReferenceEvaluatorAsRawTextSetsWithNoRepeatedRow =
	property.explore(sketchGen, {
		needs: { tx: Substrate.transaction },
		situations: Arr.map(
			recursions,
			(r): AgreedFeature => `${r} agreed with rows`
		) satisfies ReadonlyArray<Reached<AgreedFeature>>,
		/** Its pre-conversion budget: runs 12, coverage cases 24 (admission.test.ts at 4fbc3e95). */
		budget: { runs: 12, steered: 24 },
		check:
			({ tx }, c: Case<AgreedFeature>) =>
			(k) =>
				Effect.flatMap(tx, (held) =>
					Effect.provideService(
						Effect.gen(function* () {
							const seat = yield* OracleSeat
							const name = yield* seat.schema("admission")
							return yield* Effect.forEach(
								recursions,
								(recursion) =>
									Effect.gen(function* () {
										const outcome = yield* runLabelledOracle(
											caseOfSketch(recursion, k),
											conservative,
											reference,
											{
												...defaultRunOptions,
												schema: { kind: "named", name: name }
											}
										)
										assert.equal(outcome.comparison.equal, true, printOutcome(outcome))
										c.note(
											Arr.some(outcome.left.run.statements, (st) => st.rows.length > 0)
												? `${recursion} agreed with rows`
												: `${recursion} agreed with none`
										)
									}),
								{ discard: true }
							)
						}),
						OracleSeat,
						OracleSeat.rolledBack(held)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "the reference evaluator over the same facts, raw text sets with no repeated row"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/recursive/index.ts",
				original:
					'\tconst body: Select = select({ kind: "setOp", op: "UNION", arms: [base, step] })',
				replacement:
					'\tconst body: Select = select({ kind: "setOp", op: "UNION ALL", rows: "operand", arms: [base, step] })',
				why: "The conservative lowering's recursive CTE feeds back with UNION ALL, so repeated states are kept and a cycle never reaches its fixed point."
			}
		]
	})
