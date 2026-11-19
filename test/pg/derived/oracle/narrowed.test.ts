/**
 * A derived relation narrows an exact sum into its field's type under a guard: the form the exactField refusal names.
 *
 * A sum over money is exact money, which no stored field holds (DerivedRefused, exactField), and an aggregate is a find
 * head's own column, never a Compute operand. So the definition sums each group's fees in an interior stage and narrows
 * the variable that matches the total into pg.money under Compute.when(Compute.within(total, least, greatest)), a
 * group whose total leaves money's range delivering zero. Each case installs Fee with generated fees, the extremes of
 * money's range among them, refreshes the derived relation, and checks that the stored view, its definition evaluated
 * by the conservative lowering and the host's exact sums agree, every amount compared by value.
 */

import { Formatter } from "effect"
import { installingOracleProperty } from "#test/support/oracle/runner.ts"

import {
	sketchGen,
	situations,
	property,
	cases
} from "#test/pg/derived/oracle/narrowed.fixtures.ts"

/**
 * A derived relation narrows an exact sum into its field's type under a guard 60 generated cases: the view, its definition and the host's exact sums agree.
 *
 * Its pre-conversion budget: runs 60, coverage cases 60 (test/pg/derived/oracle/narrowed.test.ts at 27203b46b).
 */
export const generatedCasesTheViewItsDefinitionAndTheHostsExactSumsAgree = installingOracleProperty(
	sketchGen,
	{
		situations,
		perturb: "planner",
		oracle: {
			kind: "second-implementation",
			name: "the conservative lowering of the definition and the host's exact sums, every amount by value"
		},
		budget: { runs: cases, steered: cases },
		kept: [],
		kills: [],
		show: Formatter.format,
		check: (c) => (value) => property(value, c)
	}
)
