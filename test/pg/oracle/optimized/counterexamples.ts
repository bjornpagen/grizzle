import { type Explored, type Run, type SearchFailure, sketched } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { constant, type Gen } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { Array as Arr, Effect, Formatter, type Scope, String as Str } from "effect"
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
import { mutantLowering, mutationSites } from "#test/support/oracle/mutants/index.ts"
import { type MutantId, mutants } from "#test/support/oracle/mutants/mutants.ts"
import { oracleCheck, PropertyFailed } from "#test/support/oracle/runner.ts"
import type { SqlError } from "#test/support/pg.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** The cases of a population's rotating stream: the mutant suite's kill population. */
export const within = 500

/** What a population's case reaches: a case the mutant rewrote, and one on which the mutant was told apart. */
type NonReproductionFeature = "mutant rewrote" | "mutant killed"

export interface Population {
	readonly id: MutantId
	readonly gen: Gen<QueryCase>
}

export const populations: ReadonlyArray<Population> = [
	{ id: "I1", gen: rootedCaseGen(projectRoot, defaultGenConfig) },
	{ id: "I2", gen: rootedCaseGen(fanoutJoinRoot, defaultGenConfig) },
	{ id: "I3", gen: noninjectiveKeyCaseGen },
	{ id: "I5", gen: rootedCaseGen(projectGroupRoot, defaultGenConfig) },
	{ id: "I6", gen: rootedCaseGen(untaggedUnionRoot, defaultGenConfig) },
	{ id: "I7", gen: rootedCaseGen(existsOverTakeRoot, defaultGenConfig) },
	{ id: "I8", gen: rootedCaseGen(closureRoot(true), defaultGenConfig) }
]

/**
 * The mutant suite's invalid transformations, held against the optimized lowering: the optimized lowering never
 * reproduces an invalid mutant's counterexample.
 *
 * Each invalid mutant I1-I8 is an optimizer rule with a named flaw, applied to the conservative lowering's
 * statements exactly where the flaw matters (test/support/oracle/mutants). The mutant suite proves the harness
 * kills each within 500 cases of its population. Here the same populations, each explored as a suite of its own, run
 * through the optimized differential with the mutant beside it on the same installation and facts: on every case the
 * optimized artifact must deliver the conservative sets with no repeated row, while the mutant, on the cases it
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
				coverage: required<NonReproductionFeature>(["mutant rewrote", "mutant killed"], {
					cases: within,
					sense: notesOnly
				}),
				kept: [],
				runs: within,
				shrink: optimizedShrink,
				perturb: "planner"
			},
			(resolved, k) =>
				Effect.gen(function* () {
					const c = k.draw(resolved)
					const sites = mutationSites(mutant, c)
					if (sites.kind === "refused") {
						return yield* new PropertyFailed({
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
						return yield* new PropertyFailed({
							report: `the optimized lowering reproduces ${mutant.id}'s counterexample\n${printDifferential(o)}`
						})
					}
				})
		)
	})
