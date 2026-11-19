/**
 * IEEE 754 forms (lower/conservative/expr/total.ts ieeeForm): a nested float expression renders in SQL whose size is
 * linear in its operations, each operand's text named once, whatever its operands are: columns named inline, or columns
 * whose scope binds them to compound SQL (a correlated variable's value, a parent's key), which the form binds once.
 *
 * Over generated float4 and float8 expression trees up to five levels deep, half of each level's steps bindings and
 * half operations, the rendered SQL is at most the most text one operation's form adds beyond its operands, times the
 * operations, plus one column's text per leaf.
 *
 * Oracle: that bound, measured operation by operation from ieeeForm's own forms over a column and over a compound
 * operand (a specification: linear size). Features: an operation over an operation, an operand bound to a compound
 * expression. Kept: the two-stage pipeline shape that once grew exponentially.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	atom,
	bytes,
	caseGen,
	costs,
	type Feature,
	features,
	render
} from "#test/unit/lower/conservative/ieee.fixtures.ts"

/**
 * IEEE 754 forms render a nested float expression in SQL whose size is linear in its operations: each operand's text
 * once.
 *
 * Budget: 100 runs and 100 steered cases, what its suite stated before it became a property
 * (test/unit/lower/conservative/ieee.test.ts:242 at 8cad5bce, its runs and its coverage's cases).
 */
export const iEEE754FormsRenderANestedFloatExpressionInSQLWhoseSizeIsLinearInItsOperationsEachOperandsTextOnce =
	property.explore(caseGen, {
		needs: {},
		budget: { runs: 100, steered: 100 },
		situations: [
			"an operation over an operation",
			"an operand bound to a compound expression"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			(_, c: Case<Feature>) =>
			({ carrier, tree }) =>
				Effect.sync(() => {
					for (const f of features(tree)) {
						c.note(f)
					}
					const r = render(carrier, tree)
					const limit = costs[carrier] * r.ops + bytes(atom) * r.leaves
					assert.ok(
						bytes(r.sql) <= limit,
						`${bytes(r.sql)} bytes for ${r.ops} operations over ${r.leaves} columns, at most ${limit}`
					)
				}),
		oracle: {
			kind: "specification",
			name: "each operation adds at most its own form's text beyond its operands', each operand named once"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/lower/conservative/ieee.test.ts#iEEE754FormsRenderANestedFloatExpressionInSQLWhoseSizeIsLinearInItsOperationsEachOperandsTextOnce:-:1.1.0.0.1.1.1.0.0.1.1.1.0.0.0.0"
				),
				reason: "sums of a column bound to a sum of a column bound to a sum",
				since: "2026-11-04"
			}
		],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/expr/total.ts",
				original: "\tif (sqlArgs.every(isAtom)) {\n\t\treturn form(sqlArgs)\n\t}",
				replacement: "\treturn form(sqlArgs)",
				why: "A guarded form names its compound operands inline, each as often as it reads them; the linear size search fails."
			}
		]
	})
