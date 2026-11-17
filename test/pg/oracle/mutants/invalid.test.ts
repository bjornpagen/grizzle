/**
 * The oracle runner wins every kill search of the mutant roster (invalid.dictionary.ts), each nested in a case of its
 * own and run on its witnesses alone, the floor and steered cases its identity fixes, so a kill holds on every run seed:
 *
 * - each of the seven deliberately invalid transformations I1-I3 and I5-I8 is killed against the conservative
 *   lowering and produces its listed counterexample. Each runs on generated cases rooted at the construct its flawed
 *   rule rewrites (mutants/cases.ts); I3 runs on the hand-built noninjective-key cases, with generated facts. The
 *   harness must find, among those witnesses, one on which some statement's raw text set differs from the conservative
 *   lowering's, or, where the two agree, from the mutant's own first reading on its second (its facts stored
 *   otherwise, under the complement plan), and that difference must be the counterexample listed below for the mutant,
 *   judged on the shrunk case's comparison (the conservative run or the mutant's first reading on the left, the
 *   mutant's run on the right):
 *   - duplicate answers (I1, I2, I3, I5, I6) and a repeated endpoint state (I8): the same statements, columns and
 *     distinct rows, the mutant repeating some, the conservative lowering none;
 *   - an incorrect second-value witness (I7): no repeated row, and only left tuples of the semi-join the mutant lost,
 *     since the first k rows of a bag hold no value outside the first k distinct values.
 *   Any other difference, a changed value, a lost column or a missing statement, is not the mutant's bug and fails;
 * - the reference side of the oracle discriminates (the conservative gate only ever shows it agreeing): the I1 mutant
 *   (a DISTINCT dropped from a projection that keeps no key) is told apart from the brute-force reference evaluator by
 *   its population's floor cases, by a comparison and never by its own second reading, and the shrunk case is the one
 *   the report prints, with the repeated row on the mutant's side, a row the reference has missing on it, and no
 *   structural difference.
 *
 * Oracle: the specification of each mutant's counterexample, judged on the shrunk kill; and the reference evaluator.
 *
 * Features: each invalid mutant killed, and I1 told apart by the reference.
 */
import { word } from "@bjornpagen/testing/dictionary"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { killSearches } from "#test/pg/oracle/mutants/invalid.dictionary.ts"
import {
	expectListed,
	judgedOf,
	type KilledFeature,
	killedFeature,
	populations
} from "#test/pg/oracle/mutants/invalid.fixtures.ts"
import { runAgainstReference, runMutant } from "#test/pg/oracle/mutants/support.ts"
import { assert, containsText } from "#test/support/assert.ts"
import { repeatsOn } from "#test/support/oracle/compare.ts"
import { mutants } from "#test/support/oracle/mutants/mutants.ts"
import { printOracleCase } from "#test/support/oracle/runner.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** Each invalid mutant is killed by its witnesses with its listed counterexample, and the reference tells I1 apart. */
export const invalid = property.exhaust(finite(word(killSearches)), {
	needs: { substrate: Substrate.fresh },
	situations: Arr.map(killSearches, killedFeature) satisfies ReadonlyArray<Reached<KilledFeature>>,
	check:
		({ substrate }, c: Case<KilledFeature>) =>
		(search) =>
			Effect.provideServiceEffect(
				Effect.gen(function* () {
					const mutant = mutants[search.id]
					assert.equal(mutant.valid, false, `${search.id} is an invalid mutant of the roster`)
					if (search.judge === "conservative") {
						const { gen, shape } = populations[search.id]
						const run = yield* runMutant(mutant, gen, `mutants/${search.id}`)
						assert.deepEqual(run.harnessErrors, [], Arr.join(run.harnessErrors, "\n\n"))
						if (run.result.kind === "survived") {
							return assert.fail(`${search.id} (${mutant.check}) survived its witnesses`)
						}
						if (run.result.kind === "failed") {
							return assert.fail(`${search.id} was not killed: ${run.result.report}`)
						}
						expectListed(shape, judgedOf(run.result.verdict), run.result.report)
						return c.note(killedFeature(search))
					}
					const run = yield* runAgainstReference(mutant, populations.I1.gen, "oracle/reference-i1")
					assert.deepEqual(run.harnessErrors, [], Arr.join(run.harnessErrors, "\n\n"))
					if (run.result.kind === "survived") {
						return assert.fail("the I1 mutant survived its witnesses against the reference")
					}
					if (run.result.kind === "failed") {
						return assert.fail(run.result.report)
					}
					if (run.result.verdict.kind === "invariance") {
						return assert.fail(
							`the I1 mutant was caught by its own second reading, never told from the reference\n${run.result.report}`
						)
					}
					const outcome = run.result.verdict.outcome
					containsText(run.result.report, printOracleCase(run.result.counterexample))
					assert.ok(
						Arr.some(outcome.comparison.diffs, (d) => d.missing.length > 0),
						run.result.report
					)
					assert.deepEqual(outcome.comparison.structural, [])
					assert.ok(repeatsOn(outcome.comparison, "left") > 0)
					assert.equal(repeatsOn(outcome.comparison, "right"), 0)
					c.note(killedFeature(search))
				}),
				Substrate,
				substrate
			),
	oracle: {
		kind: "specification",
		name: "the counterexample each invalid mutant's transformation lists, judged on the shrunk kill, and the reference evaluator against I1"
	},
	box: "every kill search of the mutant roster (invalid.dictionary.ts): each invalid mutant against the conservative lowering, and I1 against the reference evaluator",
	kept: [],
	kills: [
		{
			file: "packages/engine/src/scalar/aggregate.ts",
			original: '\tif (c === "bool") {',
			replacement: '\tif (c !== "bool") {',
			why: "Operator mutant (comparison) at packages/engine/src/scalar/aggregate.ts:420 in unaryOverload: `===` becomes `!==`; the property fails (lane CATCH, grizzle 0baff5d6)."
		},
		{
			file: "packages/engine/src/runtime/lower/tree.ts",
			original: "\theading.length === 0 ? unitHeading : heading",
			replacement: "\theading.length === 1 ? unitHeading : heading",
			why: "Operator mutant (bound) at packages/engine/src/runtime/lower/tree.ts:37 in deliveredHeading: `0` becomes `1`; the property fails (lane CATCH, grizzle 0baff5d6)."
		}
	]
})
