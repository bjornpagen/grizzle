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
	/** Its search's runs, measured (populations). */
	readonly runs: number
}

/**
 * Each member's search runs: the fewest at which its kill still fails a witness, the cull rule's measure (grizzle main,
 * 2026-11-23); a member's budget is these runs and a steered phase of 500 (nonReproduction).
 *
 * @limitKind measured
 * @owner test/pg/oracle/optimized/counterexamples.ts nonReproduction, each member's
 * @unit cases
 * @scope one search of this property: `runs` cases of its rotating stream and a quarter of them, rounded up, of its
 *   floor stream; `steered` the most its steered phase runs while a required situation is unreached
 * @evidence `toolchain-test kills` and `toolchain-test run` of test/pg/oracle's test files at TEST_SEED=2219874524 (a
 *   property's witnesses, its kept cases, floor and steered phase, are fixed by its identity, the same on every seed),
 *   each killed kill's failing witness printed by an uncommitted line in vendor/toolchain's mutate/commands.ts; the
 *   logs kills0.log (the pre-conversion budgets), run1.log, kills2.log, run3.log, kills4.log, v1at5.log, fs5.log,
 *   fs9.log, fs13.log and run5.log in ~/.cache/grizzle/CULL-ORACLE-out on cassowary, uncommitted
 * @observed 2026-11-23 03:12 to 04:36 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB, load average 130 to 410 from other lanes;
 *   vendor/toolchain 2cc48172; the budgets measured on grizzle f87b2aaab with 47748474c's change and verified on
 *   dff9200ef (run5.log, every property green and every kill killed); lane CULL-ORACLE's in-memory family of two
 *   PostgreSQL 19 members
 * @workload each member's witnesses with its kill applied, on workers of its own, and its full run, at runs 500 and,
 *   per member, the floor its kill needed, one floor case fewer, and 1, steered 500
 * @result runs 500 (pre-conversion): the dedup/place.ts kill fails floor case 0 of I2, I3, I5 and I7, case 1 of I1,
 *   case 8 of I6 and case 15 of I8; at runs 1 it fails I1's steered case 2 and the first floor case of I2, I3, I5 and
 *   I7, each member's situations reached with at most 16 steered cases; I6 is killed at runs 33 (a floor of nine) and
 *   survives at 29, I8 at 61 (a floor of sixteen) and survives at 57; 192 cases in all over the seven where f1bf91a2f's
 *   gate ran 4,375
 * @decision each member's fewest: runs 1 for I1, I2, I3, I5 and I7, the fewest that keeps a floor case and a fresh one
 *   each run; 33 for I6 and 61 for I8, the fewest whose floor holds case 8 and case 15. steered stays its
 *   pre-conversion 500: the phase stops once every required situation is reached, so a green run spends only its need,
 *   16 at most here
 * @revalidate a change of its generator, its check or a kill's file, a kill added, or a change of how the testing
 *   library draws a floor or steered case; the kill gate (toolchain-test kills, affected) reports a kill that survives
 */
const populations: ReadonlyArray<Population> = [
	{ id: "I1", gen: rootedCaseGen(projectRoot, defaultGenConfig), runs: 1 },
	{ id: "I2", gen: rootedCaseGen(fanoutJoinRoot, defaultGenConfig), runs: 1 },
	{ id: "I3", gen: noninjectiveKeyCaseGen, runs: 1 },
	{ id: "I5", gen: rootedCaseGen(projectGroupRoot, defaultGenConfig), runs: 1 },
	{ id: "I6", gen: rootedCaseGen(untaggedUnionRoot, defaultGenConfig), runs: 33 },
	{ id: "I7", gen: rootedCaseGen(existsOverTakeRoot, defaultGenConfig), runs: 1 },
	{ id: "I8", gen: rootedCaseGen(closureRoot(true), defaultGenConfig), runs: 61 }
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
		/** Its population's measured runs (populations), and a steered phase of 500, its pre-conversion one. */
		budget: { runs: population.runs, steered: 500 },
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
