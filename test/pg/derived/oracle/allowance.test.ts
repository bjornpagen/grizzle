import { Formatter } from "effect"
import { installingOracleProperty } from "#test/support/oracle/runner.ts"

import {
	sketchGen,
	cases,
	situations,
	property
} from "#test/pg/derived/oracle/allowance.fixtures.ts"

/**
 * A refresh with no base change writes nothing, whatever its facts' spellings and order a reordered reload's refresh keeps every row's tuple.
 *
 * Its pre-conversion budget: runs 300, coverage cases 300 (test/pg/derived/oracle/allowance.test.ts at 27203b46b).
 */
export const aReorderedReloadsRefreshKeepsEveryRowsTuple = installingOracleProperty(sketchGen, {
	situations,
	perturb: "planner",
	oracle: {
		kind: "second-implementation",
		name: "the conservative lowering of each derived definition over the same facts, numerics compared by value, and each view's own tuples before a reload that changes no base value"
	},
	budget: { runs: cases, steered: cases },
	kept: [],
	kills: [],
	show: Formatter.format,
	check: (c) => (value) => property(value, c)
})
