/**
 * The perCase spelling rule, judged where it matters: at every point the reference evaluator merges natively equal
 * rows or values and keeps one representative (gen/domain.ts, reference/evaluate.ts ReferenceObserver).
 *
 * Raw text multisets are the oracle's contract, and PostgreSQL keeps whichever spelling of
 * a merged class its plan meets first, so the generators promise that no merge ever sees two spellings: not at a set
 * boundary (DISTINCT, UNION, the bound tuples of a group), a group key, a recursion's new state, an intersection, a
 * join variable bound by two columns, nor the argument a min or max returns. Stored values are spelled once per class
 * per case; the values PostgreSQL's arithmetic spells (a numeric sum or avg, a float sum or avg) are kept away from
 * every merge. The check runs the reference over each case's root and over every statement the query's delivery
 * defines, across several populations and a dense one that piles unions and groups on few types.
 *
 * The control draws the population built to meet two spellings (gen/case.ts spellingGenConfig): every stored value
 * spelled on its own and twinned (gen/domain.ts "twinned"), each fact after a relation's first holding, at every field
 * outside the relation's keys, the value class of the fact before it in the next spelling; a palette of the numeric
 * types alone, whose classes have several spellings (numeric 1, 1.0 and 1.00; float 0 and -0); no containments (a
 * containment copies its target's stored literal, which then meets itself in one spelling); and unions and groups
 * weighted up, so the twins meet at a merge.
 *
 * The oracle suites draw this population (queryCaseGen's default configuration).
 *
 * The control: twinned facts hold one value class in two spellings, so merges of two spellings occur.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { features, noFeatures } from "@grizzle/testing/features"
import { type Gen } from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Result, Schema } from "effect"
import {
	defaultGenConfig,
	type GenConfig,
	type QueryCase,
	queryCaseGen,
	spellingGenConfig
} from "#test/support/oracle/gen/case.ts"
import { printQueryCase } from "#test/support/oracle/gen/print.ts"
import { expectedStatements } from "#test/support/oracle/reference/deliver.ts"
import { noBindings, Reference, unobserved } from "#test/support/oracle/reference/evaluate.ts"
import { ReferenceUnsupported, rowSpelling } from "#test/support/oracle/reference/values.ts"

/**
 * The merges of one case whose two sides are spelled differently, as printable lines.
 *
 * The oracle suites report what the reference cannot evaluate; this test judges only spellings: a case the reference
 * does not state is no conflict, and anything else it throws fails the case.
 */
const spellingConflicts = (c: QueryCase): ReadonlyArray<string> => {
	const conflicts: Array<string> = []
	const ref = Reference.of(c.query.dag, {
		schema: c.schema,
		facts: c.facts,
		params: c.query.params,
		observer: {
			...unobserved,
			merge: (heading, kept, merged, at) => {
				const a = rowSpelling(kept, heading)
				const b = rowSpelling(merged, heading)
				if (a !== b) {
					conflicts.push(`${at}: ${a} and ${b}`)
				}
			}
		}
	})
	const ran = Result.try(() => {
		ref.eval(c.query.dag.roots[0], noBindings)
		expectedStatements(ref, c.query.dag.roots[0])
	})
	if (Result.isFailure(ran) && !Schema.is(ReferenceUnsupported)(ran.failure)) {
		throw ran.failure
	}
	return conflicts
}

/** Explores a population: no case merges two spellings. */
const expectNoConflicts = (suite: string, generator: Gen<QueryCase>, runs: number) =>
	explore(
		{
			suite,
			draw: drawn(generator),
			literal: Formatter.format,
			features: noFeatures,
			kept: [],
			runs,
			shrink: completeShrink,
			concurrency: 1,
			steerEvery: 16,
			steering: { kind: "none" },
			caseHang: Duration.minutes(2)
		},
		(c) =>
			Effect.sync(() => {
				const conflicts = spellingConflicts(c)
				if (conflicts.length > 0) {
					throw new Error(`${Arr.join(conflicts, "\n")}\n${printQueryCase(c)}`)
				}
			})
	)

/** Each test samples thousands of cases and evaluates each by brute force. */
const slow = 180_000

describe("the perCase spelling rule", () => {
	it.effect(
		"holds at every merge of the oracle suites' population, across a run's rotating stream",
		(ctx) =>
			searched(
				ctx,
				expectNoConflicts("unit/oracle-gen/spelling-rotating", queryCaseGen(defaultGenConfig), 6000)
			),
		slow
	)

	it.effect(
		"holds in a dense population of unions, groups and set operations over one type",
		(ctx) => {
			const dense: GenConfig = {
				...defaultGenConfig,
				schema: {
					...defaultGenConfig.schema,
					maxPalette: 1
				},
				query: {
					...defaultGenConfig.query,
					weights: {
						...defaultGenConfig.query.weights,
						union: 6,
						group: 8,
						intersect: 3,
						difference: 3,
						closure: 2,
						take: 0,
						semi: 0,
						anti: 0,
						filter: 0
					}
				}
			}
			return searched(
				ctx,
				expectNoConflicts("unit/oracle-gen/spelling-dense", queryCaseGen(dense), 8000)
			)
		},
		slow
	)

	it.effect(
		"sees the conflicts twinned spelling creates",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/oracle-gen/spelling-twinned",
						draw: drawn(queryCaseGen(spellingGenConfig)),
						literal: Formatter.format,
						features: features<"two spellings merged">(["two spellings merged"]),
						kept: [],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					(c, reached) =>
						Effect.sync(() => {
							if (spellingConflicts(c).length > 0) {
								reached.note("two spellings merged")
							}
						})
				)
			),
		slow
	)
})
