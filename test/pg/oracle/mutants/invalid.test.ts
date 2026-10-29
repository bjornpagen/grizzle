/**
 * The invalid mutants I1-I8 are killed within 500 cases each: each of the eight deliberately invalid transformations
 * must produce its listed counterexample.
 *
 * Each runs on generated cases rooted at the construct its flawed rule rewrites (mutants/cases.ts); I3 runs on the
 * hand-built noninjective-key cases, with generated facts. The harness
 * must find, within 500 drawn cases, one on which some statement's raw text multiset differs from the conservative
 * lowering's, and that difference must be the counterexample listed below for the mutant, judged on the shrunk case's
 * comparison (the conservative run on the left, the mutant's on the right):
 *
 * - duplicate answers (I1, I2, I3, I5, I6) and a repeated endpoint state (I8): the same statements, columns and
 *   distinct rows, the mutant repeating some, the conservative lowering none;
 * - an overcount (I4): no repeated row on either side and the same groups, the rows differing only in aggregate
 *   columns, among them a count, sum or avg, every differing count larger in the mutant;
 * - an incorrect second-value witness (I7): no repeated row, and only left tuples of the semi-join the mutant lost,
 *   since the first k rows of a bag hold no value outside the first k distinct values.
 *
 * Any other difference, a changed value, a lost column or a missing statement, is not the mutant's bug and fails.
 *
 * The mutant is the right side: duplicates and overcounts are rows only it has.
 */

import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Option, Order } from "effect"
import { runMutant, within } from "#test/pg/oracle/mutants/support.ts"
import { assert, assertVariant } from "#test/support/assert.ts"
import { type Comparison, rowMultiset, type Run, rawRowKey } from "#test/support/oracle/compare.ts"
import type { QueryCase } from "#test/support/oracle/gen/case.ts"
import { defaultGenConfig } from "#test/support/oracle/gen/case.ts"
import {
	closureRoot,
	existsOverTakeRoot,
	fanoutJoinRoot,
	groupRoot,
	noninjectiveKeyCaseGen,
	projectGroupRoot,
	projectRoot,
	rootedCaseGen,
	untaggedUnionRoot
} from "#test/support/oracle/mutants/cases.ts"
import { type MutantId, mutants } from "#test/support/oracle/mutants/mutants.ts"
import type { OracleOutcome } from "#test/support/oracle/runner.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

type Shape = "duplicates" | "overcount" | "lostWitness"

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
	{ id: "I4", gen: rootedCaseGen(groupRoot, defaultGenConfig), shape: "overcount" },
	{ id: "I5", gen: rootedCaseGen(projectGroupRoot, defaultGenConfig), shape: "duplicates" },
	{ id: "I6", gen: rootedCaseGen(untaggedUnionRoot, defaultGenConfig), shape: "duplicates" },
	{ id: "I7", gen: rootedCaseGen(existsOverTakeRoot, defaultGenConfig), shape: "lostWitness" },
	{ id: "I8", gen: rootedCaseGen(closureRoot(true), defaultGenConfig), shape: "duplicates" }
]

/** A mutant killed by its listed counterexample. */
type KilledFeature = `killed ${MutantId}`

/** How long one mutant's kill search may run. */
const killHang = Duration.minutes(10)

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

/** Duplicate answers: the same distinct rows in every statement, the mutant repeating some. */
const expectDuplicates = (o: OracleOutcome, c: Comparison): void => {
	assert.ok(c.rightDuplicates > 0, "the mutant repeats a row")
	assert.equal(c.leftDuplicates, 0, "the conservative lowering repeats no row")
	for (const s of o.left.run.statements) {
		assert.deepEqual(
			distinctKeys(o.right.run, s.label),
			distinctKeys(o.left.run, s.label),
			`${s.label}: the same distinct rows`
		)
	}
}

/**
 * An overcount: the same groups, differing only in aggregate columns, at least one of which a repeated contribution
 * changes, and a differing count only upward.
 */
const expectOvercount = (o: OracleOutcome, c: Comparison): void => {
	assert.equal(c.rightDuplicates + c.leftDuplicates, 0, "no repeated row")
	const group = o.case.query.dag.roots[0]
	assert.equal(group.kind, "Group")
	assertVariant(group, "kind", "Group")
	const columns = Option.match(
		Arr.findFirst(o.left.run.statements, (s) => s.label === "main"),
		{
			onNone: (): ReadonlyArray<string> => [],
			onSome: (s) => s.columns
		}
	)
	const keyAt = Arr.map(group.keys, (k) => columns.indexOf(k))
	const fnAt = new Map(Arr.map(group.aggs, (a) => [columns.indexOf(a.name), a.fn]))
	assert.deepEqual(
		Arr.map(c.diffs, (d) => d.label),
		["main"]
	)
	const diff = c.diffs[0]
	if (diff === undefined) {
		return
	}
	const sameGroup = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
		Arr.every(keyAt, (i) => a[i] === b[i])
	const groupOf = (row: ReadonlyArray<string>): string =>
		Arr.join(
			Arr.map(keyAt, (i) => row[i] ?? "no column"),
			", "
		)
	const conservativeRows = Arr.map(diff.missing, (r) => r.row)
	const mutantRows = Arr.map(diff.extra, (r) => r.row)
	assert.equal(mutantRows.length, conservativeRows.length, "the same groups")
	assert.ok(
		Arr.every(conservativeRows, (row) => Arr.some(mutantRows, (m) => sameGroup(m, row))),
		"the same groups"
	)
	assert.ok(mutantRows.length > 0)
	for (const mutantRow of mutantRows) {
		const key = groupOf(mutantRow)
		const conservativeRow = Option.getOrThrowWith(
			Arr.findFirst(conservativeRows, (row) => sameGroup(row, mutantRow)),
			() => new Error(`group ${key} is one of the conservative program's groups`)
		)
		const differing = Arr.flatMap(mutantRow, (v, i) => (v === conservativeRow[i] ? [] : [i]))
		for (const i of differing) {
			assert.notEqual(
				fnAt.get(i),
				undefined,
				`column ${columns[i]} of group ${key} is an aggregate`
			)
		}
		for (const i of Arr.filter(differing, (at) => fnAt.get(at) === "count")) {
			const [mutantCount, conservativeCount] = [mutantRow[i], conservativeRow[i]]
			assert.ok(
				mutantCount !== undefined &&
					conservativeCount !== undefined &&
					BigInt(mutantCount) > BigInt(conservativeCount)
			)
		}
		assert.equal(
			Arr.some(differing, (i) => ["count", "sum", "avg"].includes(fnAt.get(i) ?? "")),
			true,
			`group ${key}: a count, sum or avg differs`
		)
	}
}

/** An incorrect second-value witness: no repeated row, and only left tuples the mutant's semi-join lost. */
const expectLostWitness = (o: OracleOutcome, c: Comparison): void => {
	assert.equal(c.rightDuplicates + c.leftDuplicates, 0, "no repeated row")
	assert.equal(o.case.query.dag.roots[0].kind, "SemiJoin")
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
 * One mutant's kill: its population's search finds a case on which some multiset differs, and the shrunk kill is a
 * multiset difference of the listed shape, with no structural change.
 */
const killed = ({ id, gen, shape }: Population) =>
	Effect.gen(function* () {
		const mutant = mutants[id]
		const run = yield* runMutant(mutant, gen, `mutants/${id}`)
		assert.deepEqual(run.harnessErrors, [], Arr.join(run.harnessErrors, "\n\n"))
		if (run.result.kind === "survived") {
			return assert.fail(`${id} (${mutant.check}) survived ${within} cases`)
		}
		if (run.result.kind === "failed") {
			return assert.fail(`${id} was not killed: ${run.result.report}`)
		}
		const report = run.result.report
		const kill = run.result.outcome
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
		} else if (shape === "overcount") {
			expectOvercount(kill, c)
		} else {
			expectLostWitness(kill, c)
		}
	})

layer(Substrate.layer)("the invalid mutants are killed", (it) => {
	it.effect(
		`each invalid mutant is killed within ${within} cases by its listed counterexample`,
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "mutants/invalid",
						generator: element(populations),
						literal: (p: Population) => p.id,
						limit: populations.length,
						features: features<KilledFeature>(
							Arr.map(populations, (p): KilledFeature => `killed ${p.id}`)
						),
						caseHang: killHang
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
