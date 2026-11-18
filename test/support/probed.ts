import type { ProbedRule, QueryRule } from "#compiler/analysis/theory/query.ts"
import { assert } from "#test/support/assert.ts"

/**
 * The probed rule a test's rule over a query is, which a test of the probes reads: a rule the schema's compile judges
 * whole, a unit-local one (analysis/theory/unit.ts), has no probe, and its test is no test of the probes.
 */
export const probedRule = (rule: QueryRule): ProbedRule => {
	switch (rule.kind) {
		case "contained":
		case "key":
		case "check":
			return rule
		case "whole":
			return assert.fail(
				"a probed rule: this one is unit-local, judged whole over its units, with no probe"
			)
	}
}
