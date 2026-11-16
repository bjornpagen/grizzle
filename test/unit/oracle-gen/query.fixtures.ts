/** What the properties of query.test.ts read: its spaces, models and helpers. */

import { Array as Arr } from "effect"
import { topoOrder } from "#compiler/ir/dag.ts"
import { literalProblem, type TypedLiteral } from "#compiler/ir/expr.ts"
import type { RelNode } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { defaultGenConfig, type GenConfig, type QueryCase } from "#test/support/oracle/gen/case.ts"
import { printQueryCase } from "#test/support/oracle/gen/print.ts"

export const nodes = (c: QueryCase): ReadonlyArray<RelNode> => topoOrder(c.query.dag)

/** Fails with the printed case, rendered only when the check fails. */
export const holds = (condition: boolean, what: string, c: QueryCase): void => {
	if (!condition) {
		throw new Error(`${what}\n${printQueryCase(c)}`)
	}
}

export const fits = (
	row: ReadonlyArray<TypedLiteral>,
	columns: ReadonlyArray<{ readonly type: ScalarType }>
): boolean =>
	row.length === columns.length &&
	Arr.every(row, (v, i) => {
		const column = columns[i]
		return column !== undefined && literalProblem(v, column.type) === undefined
	})

/** A configuration that leaves forms out: no parameters, no input sets, no closure, set operation, take or attachment. */
export const plain: GenConfig = {
	...defaultGenConfig,
	query: {
		...defaultGenConfig.query,
		params: false,
		inputSets: false,
		closure: "acyclic",
		weights: {
			...defaultGenConfig.query.weights,
			closure: 0,
			intersect: 0,
			difference: 0,
			take: 0
		},
		roots: {
			...defaultGenConfig.query.roots,
			attach: 0,
			hetero: 0
		}
	}
}

/** The acyclic configuration, closures drawn often. */
export const acyclic: GenConfig = {
	...defaultGenConfig,
	query: {
		...defaultGenConfig.query,
		closure: "acyclic",
		weights: {
			...defaultGenConfig.query.weights,
			closure: 6
		}
	}
}
