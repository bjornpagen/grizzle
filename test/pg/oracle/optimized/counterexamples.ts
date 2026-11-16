import type { Reached } from "@bjornpagen/testing/features"
import type { Gen } from "@bjornpagen/testing/gen"
import { type Case as PropertyCase, family } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
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
import { namedPlacement, oracleProperty, PropertyFailed } from "#test/support/oracle/runner.ts"

/** What a population's case reaches: a case the mutant rewrote, and one on which the mutant was told apart. */
type NonReproductionFeature = "mutant rewrote" | "mutant killed"

interface Population {
	readonly id: MutantId
	readonly gen: Gen<QueryCase>
}

const populations: ReadonlyArray<Population> = [
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
 * kills each on its population's witnesses. Here the same populations, each explored as a suite of its own, run
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
const nonReproduction = (population: Population) => {
	const mutant = mutants[population.id]
	const lowering = mutantLowering(mutant)
	return oracleProperty(population.gen, {
		situations: ["mutant rewrote", "mutant killed"] satisfies ReadonlyArray<
			Reached<NonReproductionFeature>
		>,
		perturb: "planner",
		oracle: {
			kind: "second-implementation",
			name: "the conservative lowering's raw text sets, the invalid mutant beside the optimized artifact"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/dedup/place.ts",
				original: "\t\tconst outstanding = a.obligations.flatMap((o) => (o.discharged ? [] : [o]))",
				replacement: "\t\tconst outstanding = a.obligations.flatMap(() => [])",
				why: "The dedup placement discharges no obligation (lower/optimize/dedup/place.ts), so a DISTINCT owed is never placed and the optimized artifact repeats rows."
			}
		],
		show: Formatter.format,
		check: (k: PropertyCase<NonReproductionFeature>) => (c) =>
			Effect.gen(function* () {
				const placement = yield* namedPlacement("counter")
				const sites = mutationSites(mutant, c)
				if (sites.kind === "refused") {
					return yield* new PropertyFailed({
						report: `mutant ${mutant.id} refused at ${sites.stage}: ${sites.message}`
					})
				}
				const o = yield* differentialCase(c, {
					...plainDifferential,
					placement,
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
	})
}

/** Every population's non-reproduction (nonReproduction), one member of a family each, keyed by its mutant. */
export const nonReproductions = () =>
	family(Rec.fromEntries(Arr.map(populations, (p) => [p.id, nonReproduction(p)] as const)))
