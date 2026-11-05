/**
 * The invalid mutants I1-I3 and I5-I8 are each killed by their population's witnesses, the floor and steered cases the
 * suite's label fixes, so a kill holds on every run seed: each of the seven deliberately invalid transformations must
 * produce its listed counterexample.
 *
 * Each runs on generated cases rooted at the construct its flawed rule rewrites (mutants/cases.ts); I3 runs on the
 * hand-built noninjective-key cases, with generated facts. The harness
 * must find, among those witnesses, one on which some statement's raw text multiset differs from the conservative
 * lowering's, or, where the two agree, from the mutant's own first reading on its second (its facts stored otherwise,
 * under the complement plan), and that difference must be the counterexample listed below for the mutant, judged on
 * the shrunk case's comparison (the conservative run or the mutant's first reading on the left, the mutant's run on
 * the right):
 *
 * - duplicate answers (I1, I2, I3, I5, I6) and a repeated endpoint state (I8): the same statements, columns and
 *   distinct rows, the mutant repeating some, the conservative lowering none;
 * - an incorrect second-value witness (I7): no repeated row, and only left tuples of the semi-join the mutant lost,
 *   since the first k rows of a bag hold no value outside the first k distinct values.
 *
 * Any other difference, a changed value, a lost column or a missing statement, is not the mutant's bug and fails.
 *
 * The mutant is the right side: duplicates are rows only it has.
 */

import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Option, Order } from "effect"
import { runMutant } from "#test/pg/oracle/mutants/support.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	type Comparison,
	rawRowKey,
	repeatsOn,
	rowMultiset,
	type Run
} from "#test/support/oracle/compare.ts"
import type { QueryCase } from "#test/support/oracle/gen/case.ts"
import { defaultGenConfig } from "#test/support/oracle/gen/case.ts"
import {
	closureRoot,
	existsOverTakeRoot,
	fanoutJoinRoot,
	noninjectiveKeyCaseGen,
	projectGroupRoot,
	projectRoot,
	rootedCaseGen,
	untaggedUnionRoot
} from "#test/support/oracle/mutants/cases.ts"
import { type MutantId, mutants } from "#test/support/oracle/mutants/mutants.ts"
import type { KillVerdict } from "#test/support/oracle/runner.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

type Shape = "duplicates" | "lostWitness"

/** An invalid mutant, the population it runs on, and the shape its listed counterexample takes. */
interface Population {
	readonly id: MutantId
	readonly gen: Gen<QueryCase>
	readonly shape: Shape
}

const populations: Arr.NonEmptyReadonlyArray<Population> = [
	{ id: "I1", gen: rootedCaseGen(projectRoot, defaultGenConfig), shape: "duplicates" },
	{ id: "I2", gen: rootedCaseGen(fanoutJoinRoot, defaultGenConfig), shape: "duplicates" },
	{ id: "I3", gen: noninjectiveKeyCaseGen, shape: "duplicates" },
	{ id: "I5", gen: rootedCaseGen(projectGroupRoot, defaultGenConfig), shape: "duplicates" },
	{ id: "I6", gen: rootedCaseGen(untaggedUnionRoot, defaultGenConfig), shape: "duplicates" },
	{ id: "I7", gen: rootedCaseGen(existsOverTakeRoot, defaultGenConfig), shape: "lostWitness" },
	{ id: "I8", gen: rootedCaseGen(closureRoot(true), defaultGenConfig), shape: "duplicates" }
]

/** A mutant killed by its listed counterexample. */
type KilledFeature = `killed ${MutantId}`

const distinctKeys = (run: Run, label: string): ReadonlyArray<string> =>
	Arr.sort(
		[
			...rowMultiset(
				Option.match(
					Arr.findFirst(run.statements, (s) => s.label === label),
					{ onNone: () => [], onSome: (s) => s.rows }
				)
			).keys()
		],
		Order.String
	)

/**
 * What a kill is judged on: the case, the run the mutant is judged against on the left, the mutant's run on the right,
 * and their comparison. A comparison kill's left is the conservative run; an invariance kill's is the mutant's first
 * reading, which agreed with the conservative run, and its right the mutant's second reading.
 */
interface Judged {
	readonly case: QueryCase
	readonly left: Run
	readonly right: Run
	readonly comparison: Comparison
}

const judgedOf = (verdict: KillVerdict): Judged => {
	switch (verdict.kind) {
		case "comparison":
			return {
				case: verdict.outcome.case,
				left: verdict.outcome.left.run,
				right: verdict.outcome.right.run,
				comparison: verdict.outcome.comparison
			}
		case "invariance": {
			const readings = verdict.failure.readings
			return {
				case: readings.case,
				left: readings.first,
				right: readings.again,
				comparison: readings.comparison
			}
		}
	}
}

/** Duplicate answers: the same distinct rows in every statement, the mutant repeating some. */
const expectDuplicates = (j: Judged, c: Comparison): void => {
	assert.ok(repeatsOn(c, "right") > 0, "the mutant repeats a row")
	assert.equal(repeatsOn(c, "left"), 0, "the left run repeats no row")
	for (const s of j.left.statements) {
		assert.deepEqual(
			distinctKeys(j.right, s.label),
			distinctKeys(j.left, s.label),
			`${s.label}: the same distinct rows`
		)
	}
}

/** An incorrect second-value witness: no repeated row, and only left tuples the mutant's semi-join lost. */
const expectLostWitness = (j: Judged, c: Comparison): void => {
	assert.deepEqual(c.repeated, [], "no repeated row")
	assert.equal(j.case.query.dag.roots[0].kind, "SemiJoin")
	assert.deepEqual(
		Arr.map(c.diffs, (d) => d.label),
		["main"]
	)
	assert.deepEqual(
		Arr.flatMap(c.diffs, (d) => Arr.map(d.extra, (e) => rawRowKey(e.row))),
		[],
		"nothing only in the mutant"
	)
	assert.ok(Arr.flatMap(c.diffs, (d) => d.missing).length > 0, "a left tuple the mutant lost")
}

/**
 * One mutant's kill: its population's search finds a case on which some multiset differs, against the conservative run
 * or against the mutant's own first reading (runner.ts KillVerdict), and the shrunk kill is a multiset difference of the
 * listed shape, with no structural change.
 */
const killed = ({ id, gen, shape }: Population) =>
	Effect.gen(function* () {
		const mutant = mutants[id]
		const run = yield* runMutant(mutant, gen, `mutants/${id}`)
		assert.deepEqual(run.harnessErrors, [], Arr.join(run.harnessErrors, "\n\n"))
		if (run.result.kind === "survived") {
			return assert.fail(`${id} (${mutant.check}) survived every case`)
		}
		if (run.result.kind === "unwitnessed") {
			return assert.fail(
				`${id} (${mutant.check}) survived its witnesses, the floor and steered cases: only a case the run's seed drew killed it\n${run.result.report}`
			)
		}
		if (run.result.kind === "failed") {
			return assert.fail(`${id} was not killed: ${run.result.report}`)
		}
		const report = run.result.report
		const kill = judgedOf(run.result.verdict)
		const c = kill.comparison
		assert.equal(c.equal, false, report)
		assert.deepEqual(c.structural, [], report)
		if (shape !== "lostWitness") {
			assert.ok(
				Arr.some(c.diffs, (d) => d.extra.length > 0),
				report
			)
		}
		if (shape === "duplicates") {
			expectDuplicates(kill, c)
		} else {
			expectLostWitness(kill, c)
		}
	})

layer(Substrate.layer)("the invalid mutants are killed", (it) => {
	it.effect(
		"each invalid mutant is killed by its witnesses with its listed counterexample",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "mutants/invalid",
						generator: element(populations),
						literal: (p: Population) => p.id,
						limit: populations.length,
						coverage: requiredInSpace<KilledFeature>(
							Arr.map(populations, (p): KilledFeature => `killed ${p.id}`)
						),
						caseHang
					},
					(p, c) =>
						Effect.gen(function* () {
							yield* killed(p)
							c.note(`killed ${p.id}`)
						})
				)
			),
		populations.length * 600_000
	)
})
