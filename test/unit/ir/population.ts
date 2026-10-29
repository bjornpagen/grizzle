import { type Gen, map, oneOf } from "@grizzle/testing/gen"
import type { ValidDag } from "#compiler/ir/rel.ts"
import { defaultGenConfig, queryCaseGen } from "#test/support/oracle/gen/case.ts"
import { defaultRecursiveLimits, recursiveCaseGen } from "#test/support/oracle/gen/recursive.ts"

/**
 * The valid DAGs the IR suites draw: generated query cases with every root form, with computed terms, stated orders
 * and equations, and generated recursive cases. Every one is built through DagBuilder and validated, so a suite over
 * them starts from what the compiler's own construction admits, on structure no fixture fixes.
 */
export const generatedDags: Gen<ValidDag> = oneOf([
	map(
		queryCaseGen({
			...defaultGenConfig,
			query: {
				...defaultGenConfig.query,
				roots: {
					...defaultGenConfig.query.roots,
					plain: 2,
					attach: 3,
					hetero: 3
				}
			}
		}),
		(c) => c.query.dag
	),
	map(
		queryCaseGen({
			...defaultGenConfig,
			query: {
				...defaultGenConfig.query,
				compute: 3,
				statedOrders: true,
				equate: 1
			}
		}),
		(c) => c.query.dag
	),
	map(recursiveCaseGen(defaultRecursiveLimits), (c) => c.query.dag)
])
