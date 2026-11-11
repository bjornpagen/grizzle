/**
 * The invalid mutants I1-I3 and I5-I8 are each killed by their population's witnesses, the floor and steered cases the
 * suite's label fixes, so a kill holds on every run seed: each of the seven deliberately invalid transformations must
 * produce its listed counterexample.
 *
 * Each runs on generated cases rooted at the construct its flawed rule rewrites (mutants/cases.ts); I3 runs on the
 * hand-built noninjective-key cases, with generated facts. The harness
 * must find, among those witnesses, one on which some statement's raw text set differs from the conservative
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
 *
 * Oracle: the specification of each mutant's counterexample, judged on the shrunk kill.
 *
 * Plants: oracle-compare-repeats-unseen (the comparison counts no repeated row, so no duplicate answer shows).
 *
 * Features: each invalid mutant killed.
 */

import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Option, Order, Record, Result } from "effect"
import { runMutant } from "#test/pg/oracle/mutants/support.ts"
import { assert, nonEmpty } from "#test/support/assert.ts"
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
import { type Mutant, type MutantId, mutants } from "#test/support/oracle/mutants/mutants.ts"
import type { KillVerdict } from "#test/support/oracle/runner.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

type Shape = "duplicates" | "lostWitness"

/** The roster's invalid mutants, by their ids: the ones that name an invalid transformation. */
type InvalidId = Extract<MutantId, `I${string}`>

/** An invalid mutant's population and the shape its listed counterexample takes. */
interface Population {
	readonly gen: Gen<QueryCase>
	readonly shape: Shape
}

/** Every invalid mutant's population: the record is total over the roster's invalid ids, so a new one needs its own. */
const populations: { readonly [Id in InvalidId]: Population } = {
	I1: { gen: rootedCaseGen(projectRoot, defaultGenConfig), shape: "duplicates" },
	I2: { gen: rootedCaseGen(fanoutJoinRoot, defaultGenConfig), shape: "duplicates" },
	I3: { gen: noninjectiveKeyCaseGen, shape: "duplicates" },
	I5: { gen: rootedCaseGen(projectGroupRoot, defaultGenConfig), shape: "duplicates" },
	I6: { gen: rootedCaseGen(untaggedUnionRoot, defaultGenConfig), shape: "duplicates" },
	I7: { gen: rootedCaseGen(existsOverTakeRoot, defaultGenConfig), shape: "lostWitness" },
	I8: { gen: rootedCaseGen(closureRoot(true), defaultGenConfig), shape: "duplicates" }
}

/** The ids the populations hold: exactly the roster's invalid ones. */
const invalidIds: ReadonlySet<MutantId> = new Set(Record.keys(populations))

/** Whether a roster id names an invalid mutant. */
const isInvalidId = (id: MutantId): id is InvalidId => invalidIds.has(id)

/** The roster's invalid mutants, in its order: the space every case of the suite draws from. */
const invalid: Arr.NonEmptyReadonlyArray<Mutant & Readonly<{ id: InvalidId }>> = nonEmpty(
	Arr.filterMap(Record.values(mutants), (m) => {
		const id = m.id
		return isInvalidId(id) ? Result.succeed({ ...m, id }) : Result.failVoid
	}),
	"the roster's invalid mutants"
)

/** A mutant killed by its listed counterexample. */
type KilledFeature = `killed ${InvalidId}`

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
 * One mutant's kill: its population's search finds a case on which some set differs, against the conservative run
 * or against the mutant's own first reading (runner.ts KillVerdict), and the shrunk kill is a difference of the sets of the
 * listed shape, with no structural change.
 */
const killed = (mutant: Mutant & Readonly<{ id: InvalidId }>) =>
	Effect.gen(function* () {
		const { id } = mutant
		const { gen, shape } = populations[id]
		assert.equal(mutant.valid, false, `${id} is an invalid mutant of the roster`)
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
						generator: element(invalid),
						literal: (m: Mutant) => m.id,
						limit: invalid.length,
						box: "every invalid mutant of the roster (mutants.ts)",
						oracle: {
							kind: "specification",
							name: "the counterexample each invalid mutant's transformation lists, judged on the shrunk kill"
						},
						coverage: requiredInSpace<KilledFeature>(
							Arr.map(invalid, (m): KilledFeature => `killed ${m.id}`)
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
		invalid.length * 600_000
	)
})
