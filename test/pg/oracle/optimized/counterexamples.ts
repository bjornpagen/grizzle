import {
	type Explored,
	type Kept,
	type Run,
	type SearchFailure,
	sketched
} from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { constant, type Gen } from "@grizzle/testing/gen"
import { Array as Arr, Duration, Effect, Formatter, type Scope, String as Str } from "effect"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { type CompletedOrder, conservativeMeta } from "#compiler/ir/rel.ts"
import { optimizedShrink } from "#test/pg/oracle/optimized/suite.ts"
import {
	agrees,
	baselineIsSet,
	differentialCase,
	plainDifferential,
	printDifferential
} from "#test/pg/oracle/optimized/support.ts"
import type { QueryCase } from "#test/support/oracle/gen/case.ts"
import { defaultGenConfig } from "#test/support/oracle/gen/case.ts"
import { int4 } from "#test/support/oracle/gen/domain.ts"
import { normalQuery } from "#test/support/oracle/gen/query.ts"
import { type GenRelation, schemaName } from "#test/support/oracle/gen/schema.ts"
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
import { mutantLowering, mutationSites } from "#test/support/oracle/mutants/index.ts"
import { type MutantId, mutants } from "#test/support/oracle/mutants/mutants.ts"
import { oracleCheck, PropertyFailed } from "#test/support/oracle/runner.ts"
import type { SqlError } from "#test/support/pg.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { Q } from "#test/unit/lower/conservative/fixtures.ts"

/** The cases of a population's rotating stream: the mutant suite's kill population. */
export const within = 500

/** What a population's case reaches: a case the mutant rewrote, and one on which the mutant was told apart. */
type NonReproductionFeature = "mutant rewrote" | "mutant killed"

export interface Population {
	readonly id: MutantId
	readonly gen: Gen<QueryCase>
	/** The cases replayed before the population's streams: what it reaches too rarely to leave to it. */
	readonly kept: ReadonlyArray<Kept<QueryCase, NonReproductionFeature>>
}

const int = (value: number): TypedLiteral => ({ kind: "int", value: BigInt(value) })

/**
 * I7's counterexample, which its population's drawn cases kill a few times a run: R0(k, a) keyed by k, a repeating,
 * and the values of a among the first two values of a. Under the DISTINCT the bound keeps 1 and 2; without it, two
 * copies of 1 fill the bound and hide 2.
 */
const firstTwoValues: QueryCase = (() => {
	const r: GenRelation = {
		name: "R0",
		columns: [
			{ name: "k", type: int4 },
			{ name: "a", type: int4 }
		],
		primaryKey: ["k"],
		keys: [],
		mutable: false
	}
	const q = new Q()
	const values = () =>
		q.project(
			q.base({ name: r.name, heading: r.columns, primaryKey: r.primaryKey }, conservativeMeta),
			[["a", "a"]],
			conservativeMeta
		)
	const order: CompletedOrder = { keys: [{ column: "a", dir: "asc" }] }
	const firstTwo = q.take(values(), order, { kind: "literal", k: 2n }, [], conservativeMeta)
	const root = q.semi(values(), firstTwo, [["a", "a"]])
	const dag = normalQuery(q.b.build(Arr.of(root)))
	return {
		schema: { name: schemaName, relations: [r], closed: [], containments: [] },
		facts: {
			R0: Arr.map(
				[
					[1, 1],
					[2, 1],
					[3, 2],
					[4, 3]
				],
				(row) => Arr.map(row, int)
			)
		},
		query: { dag, params: {} },
		spelling: { mode: "perCase", choices: [], edge: false }
	}
})()

export const populations: ReadonlyArray<Population> = [
	{ id: "I1", gen: rootedCaseGen(projectRoot, defaultGenConfig), kept: [] },
	{ id: "I2", gen: rootedCaseGen(fanoutJoinRoot, defaultGenConfig), kept: [] },
	{ id: "I3", gen: noninjectiveKeyCaseGen, kept: [] },
	{ id: "I4", gen: rootedCaseGen(groupRoot, defaultGenConfig), kept: [] },
	{
		id: "I5",
		gen: rootedCaseGen(projectGroupRoot, defaultGenConfig),
		kept: []
	},
	{
		id: "I6",
		gen: rootedCaseGen(untaggedUnionRoot, defaultGenConfig),
		kept: []
	},
	{
		id: "I7",
		gen: rootedCaseGen(existsOverTakeRoot, defaultGenConfig),
		kept: [
			{
				note: "the values of a among the first two values of a, 1 repeated",
				sketch: firstTwoValues,
				draws: "",
				reaches: ["mutant rewrote", "mutant killed"]
			}
		]
	},
	{
		id: "I8",
		gen: rootedCaseGen(closureRoot(true), defaultGenConfig),
		kept: []
	}
]

/**
 * The mutant suite's invalid transformations, held against the optimized lowering: the optimized lowering never
 * reproduces an invalid mutant's counterexample.
 *
 * Each invalid mutant I1-I8 is an optimizer rule with a named flaw, applied to the conservative lowering's
 * statements exactly where the flaw matters (test/support/oracle/mutants). The mutant suite proves the harness
 * kills each within 500 cases of its population. Here the same populations, each explored as a suite of its own, run
 * through the optimized differential with the mutant beside it on the same installation and facts: on every case the
 * optimized artifact must deliver the conservative multisets with no repeated row, while the mutant, on the cases it
 * rewrites, is killed at least once (required features), so the population demonstrably holds the counterexample the
 * optimized lowering does not reproduce.
 *
 * Every case of the population through the optimized differential, the mutant beside it where it rewrites
 * something, in a named exploration of the kernel. A case on which the optimized artifact disagrees fails and shrinks;
 * the mutant must have found a site to rewrite and must have been killed on some case (its required features), and a
 * mutant that refuses a case is a defect of the harness. The planner settings are perturbed, never the facts: a
 * population's counterexample rests on its facts as drawn. Each artifact is compiled for `snapshot` against the
 * installation's catalog.
 */
export const nonReproduction = (
	population: Population
): Effect.Effect<Explored, SearchFailure | SqlError, Scope.Scope | Substrate | Run> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const schema = yield* s.schema({ create: false, label: "counter" })
		const mutant = mutants[population.id]
		const lowering = mutantLowering(mutant)
		return yield* oracleCheck(
			sketched(population.gen, constant),
			{
				suite: `optimized/non-reproduction-${Str.toLowerCase(population.id)}`,
				literal: Formatter.format,
				features: features<NonReproductionFeature>(["mutant rewrote", "mutant killed"]),
				kept: population.kept,
				runs: within,
				shrink: optimizedShrink,
				steering: { kind: "none" },
				caseHang: Duration.minutes(2),
				perturb: "planner"
			},
			(resolved, k) =>
				Effect.gen(function* () {
					const c = k.draw(resolved)
					const sites = mutationSites(mutant, c)
					if (sites.kind === "refused") {
						return yield* PropertyFailed.make({
							report: `mutant ${mutant.id} refused at ${sites.stage}: ${sites.message}`
						})
					}
					const o = yield* differentialCase(c, {
						...plainDifferential,
						schema,
						others: sites.sites > 0 ? [lowering] : []
					})
					if (sites.sites > 0) {
						k.note("mutant rewrote")
						if (Arr.some(o.others, (m) => !m.comparison.equal)) {
							k.note("mutant killed")
						}
					}
					if (!baselineIsSet(o) || !agrees(o)) {
						return yield* PropertyFailed.make({
							report: `the optimized lowering reproduces ${mutant.id}'s counterexample\n${printDifferential(o)}`
						})
					}
				})
		)
	})
