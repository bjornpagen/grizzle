/**
 * The optimized lowering against the conservative lowering on the optimizer's population (gen/case.ts
 * optimizerGenConfig), each case under a plan perturbation drawn with it (test/support/oracle/perturb.ts), so joins,
 * fanout, groups, projected duplicates, unions and closures meet real rows.
 *
 * The population is the conservative suite's: one to four relations with composite and candidate keys, closed rosters,
 * pure sets, containments and mutable relations, small-domain facts including NaN, -0, numeric display scales and
 * supplementary-plane text, and queries over match, filter, project, semi- and anti-join, union, intersection,
 * difference, group, take, attach and recursion, at the root as a plain set, with attachments, or as a heterogeneous
 * union, with scalar and relation parameters; and it draws what each rewrite family needs besides: containments to read
 * through, wide payload under takes with stated orders, total computed terms, equations, filters read through regions
 * and rooted closures. Each case runs under the optimized artifact compiled for the `snapshot` context against the
 * installation's own evidence catalog, in every per-execution form, against the conservative lowering (support.ts), and
 * the population must reach every rewrite family (its required features). No generated term raises (every partial
 * operation is guarded, gen/compute.ts), so an execution error of any form is a defect.
 *
 * Oracle: the conservative lowering's raw text sets, no repeated row on the optimized side.
 *
 * Features: the population's required features (suite.ts and the file's own), "a fold key correlated with two parent
 * columns" among them, which a case whose turn aims at it reaches by the case built to (suite.ts foldKeyTwiceGen).
 */
import type { Reached } from "@bjornpagen/testing/features"
import { Function } from "effect"
import { optimizerSituations } from "#test/pg/oracle/optimized/optimizer.fixtures.ts"
import {
	differentialProperty,
	optimizedSpace,
	type OptimizedFeature
} from "#test/pg/oracle/optimized/suite.ts"
import { optimizerGenConfig, queryCaseGen } from "#test/support/oracle/gen/case.ts"
import { namedPlacement } from "#test/support/oracle/runner.ts"

/** The optimized lowering agrees with the conservative on the optimizer's population, raw text sets, no repeated row. */
export const optimizer = differentialProperty(
	optimizedSpace(queryCaseGen(optimizerGenConfig)),
	Function.identity,
	namedPlacement("opt"),
	{
		situations: optimizerSituations satisfies ReadonlyArray<Reached<OptimizedFeature>>,
		/** Its pre-conversion budget: runs 1250, coverage cases 1250 (suite.ts casesPerPopulation at fe79ac6b2^). */
		budget: { runs: 1250, steered: 1250 },
		kills: [
			{
				file: "packages/engine/src/lower/optimize/dedup/place.ts",
				original: "\t\tconst outstanding = a.obligations.flatMap((o) => (o.discharged ? [] : [o]))",
				replacement: "\t\tconst outstanding = a.obligations.flatMap(() => [])",
				why: "The dedup placement discharges no obligation (lower/optimize/dedup/place.ts), so a DISTINCT owed is never placed and the optimized artifact repeats rows."
			},
			{
				file: "packages/engine/src/lower/shapes/attach/index.ts",
				original:
					"\t\t\t\t\tkeyedGroup(facts, folded, cx, env, correlatedColumns(attach, parentMap)),",
				replacement:
					"\t\t\t\t\tkeyedGroup(facts, folded, cx, env, [\n\t\t\t\t\t\t...new Map(correlatedColumns(attach, parentMap).map((e) => [e.column, e])).values()\n\t\t\t\t\t]),",
				why: "The fold an attachment restricts by its parent's values keeps one equality per key column (lower/shapes/attach/index.ts), so a key paired with two parent columns is restricted by one of them and a parent whose two columns differ receives a group."
			}
		]
	}
)
