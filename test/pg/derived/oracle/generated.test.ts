/**
 * The generated refresh oracle: every refreshed view equals its definition, in one commit, writing nothing it need not
 * (property.ts derivedCase), against the definition evaluated by the conservative lowering on the same snapshot.
 */
import { aimed } from "@bjornpagen/testing/gen"
import { Formatter } from "effect"
import { caseSketchGen } from "#test/pg/derived/oracle/gen.ts"
import {
	aggregateAims,
	casesPerSeed,
	situations
} from "#test/pg/derived/oracle/generated.fixtures.ts"
import { derivedCase } from "#test/pg/derived/oracle/property.ts"
import { installingOracleProperty } from "#test/support/oracle/runner.ts"

/**
 * The generated refresh oracle: every refreshed view equals its definition, in one commit, writing nothing it need not
 * (property.ts derivedCase), against the definition evaluated by the conservative lowering on the same snapshot, each
 * case committing on the worker's clone (installingOracleProperty) under a planner perturbation it draws.
 *
 * Its pre-conversion budget: runs 200, coverage cases 200 a seed over four seeds, two in each of generated-1 and
 * generated-2 (test/pg/derived/oracle/suite.ts at 27203b46b), which split the cases over four Vitest suites and are one
 * property's here.
 */
export const everyRefreshedViewEqualsItsDefinitionInOneCommitWritingNothingItNeedNot =
	installingOracleProperty(aimed(caseSketchGen, aggregateAims), {
		situations,
		perturb: "planner",
		oracle: {
			kind: "second-implementation",
			name: "each derived definition evaluated by the conservative lowering on one snapshot, and the tuples of every view a call did not name or whose base did not change"
		},
		budget: { runs: 4 * casesPerSeed, steered: 4 * casesPerSeed },
		kept: [],
		kills: [],
		show: Formatter.format,
		check: (c) => (sketch) => derivedCase(sketch, c)
	})
