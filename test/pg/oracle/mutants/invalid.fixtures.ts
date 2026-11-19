import { assert } from "@bjornpagen/testing/assert"
import type { Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order, Record as Rec, Result } from "effect"
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
import type { MutantId } from "#test/support/oracle/mutants/mutants.ts"
import type { KillVerdict } from "#test/support/oracle/runner.ts"

/** The shape an invalid mutant's listed counterexample takes: duplicate answers, or a lost witness of a semi-join. */
type Shape = "duplicates" | "lostWitness"

/** The roster's invalid mutants, by their ids: the ones that name an invalid transformation. */
export type InvalidId = Extract<MutantId, `I${string}`>

/** An invalid mutant's population and the shape its listed counterexample takes. */
interface Population {
	readonly gen: Gen<QueryCase>
	readonly shape: Shape
}

/** Every invalid mutant's population: the record is total over the roster's invalid ids, so a new one needs its own. */
export const populations: { readonly [Id in InvalidId]: Population } = {
	I1: { gen: rootedCaseGen(projectRoot, defaultGenConfig), shape: "duplicates" },
	I2: { gen: rootedCaseGen(fanoutJoinRoot, defaultGenConfig), shape: "duplicates" },
	I3: { gen: noninjectiveKeyCaseGen, shape: "duplicates" },
	I5: { gen: rootedCaseGen(projectGroupRoot, defaultGenConfig), shape: "duplicates" },
	I6: { gen: rootedCaseGen(untaggedUnionRoot, defaultGenConfig), shape: "duplicates" },
	I7: { gen: rootedCaseGen(existsOverTakeRoot, defaultGenConfig), shape: "lostWitness" },
	I8: { gen: rootedCaseGen(closureRoot(true), defaultGenConfig), shape: "duplicates" }
}

/** The ids the populations hold: exactly the roster's invalid ones. */
const invalidIds: ReadonlySet<MutantId> = new Set(Rec.keys(populations))

/** A roster id as an invalid mutant's, or nothing for a valid one. */
export const invalidId = (id: MutantId): Result.Result<InvalidId, void> =>
	isInvalidId(id) ? Result.succeed(id) : Result.failVoid

const isInvalidId = (id: MutantId): id is InvalidId => invalidIds.has(id)

/**
 * A kill search the oracle runner must win: an invalid mutant's population against the conservative lowering, killed
 * with its listed counterexample, or the I1 mutant's against the reference evaluator, told apart by the reference.
 */
export type KillSearch =
	| { readonly judge: "conservative"; readonly id: InvalidId }
	| { readonly judge: "reference"; readonly id: "I1" }

/** What a kill search reaches: its mutant killed by the conservative lowering, or I1 told apart by the reference. */
export type KilledFeature = `killed ${InvalidId}` | "the reference told I1 apart"

/** The situation a kill search reaches when it wins. */
export const killedFeature = (search: KillSearch): KilledFeature =>
	search.judge === "conservative" ? `killed ${search.id}` : "the reference told I1 apart"

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

export const judgedOf = (verdict: KillVerdict): Judged => {
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
 * The shrunk kill of an invalid mutant judged against its listed counterexample: a difference of the sets of the
 * listed shape, with no structural change.
 */
export const expectListed = (shape: Shape, kill: Judged, report: string): void => {
	const c = kill.comparison
	assert.equal(c.equal, false, report)
	assert.deepEqual(c.structural, [], report)
	switch (shape) {
		case "duplicates":
			assert.ok(
				Arr.some(c.diffs, (d) => d.extra.length > 0),
				report
			)
			return expectDuplicates(kill, c)
		case "lostWitness":
			return expectLostWitness(kill, c)
	}
}
