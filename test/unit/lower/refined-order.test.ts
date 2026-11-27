/**
 * A refined output the optimized delivery casts to its domain and orders by (lower/shapes/refined castOutputs): the ORDER
 * BY item that reads the output reads its cast, the expression the output list holds, never the uncast value. Under
 * SELECT DISTINCT the uncast item is PostgreSQL's 42P10 ("for SELECT DISTINCT, ORDER BY expressions must appear in
 * select list", parse_clause.c), which the generated suites met before the delivery cast the item alike.
 *
 * The oracle is the specification turned into a checker, over every query of every statement of the optimized program:
 * no ORDER BY item is, canonically, the uncast value of an output its core casts; and under SELECT DISTINCT every ORDER
 * BY item is one of the core's outputs.
 *
 * Bound: a refined value from each source the delivery's trace judges, a derived relation's column, which it casts, and
 * a declared parameter, which its bind proves (lower/conservative/refined Tracer), emitted alone or beside a projected
 * field that keeps no key, so the delivery deduplicates, ordered by the value alone or after the projected field, either
 * direction. Exhausted.
 *
 * Features: ordered by a cast output, ordered by two outputs, the tag alone.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import { canonicalEquals } from "#compiler/core/canonical.ts"
import { directions } from "#compiler/core/order.ts"
import { queryInput } from "#compiler/program/input.ts"
import type { Expr } from "#compiler/sql/ast.ts"
import { costChosen } from "#compiler/sql/emit.ts"
import { succeeded } from "#test/support/assert.ts"
import { lowerAligned, programAsts } from "#test/support/compile.ts"
import { checking, checkOptions } from "#test/support/policy.ts"
import {
	catalog,
	type Feature,
	installation,
	orderedCores,
	Refined,
	tagged
} from "#test/unit/lower/refined-order.fixtures.ts"

/** A refined output the delivery casts is ordered by its cast, the expression the output list holds. */
export const aRefinedOutputTheDeliveryCastsIsOrderedByItsCastTheExpressionTheOutputListHolds =
	property.exhaust(
		finite((source) => ({
			source: source.draw(
				element(["a derived relation's column", "a declared parameter"] as const)
			),
			shape: source.draw(
				element([
					"the tag alone",
					"the title and the tag, by the tag",
					"the title and the tag, by both"
				] as const)
			),
			direction: source.draw(element(directions))
		})),
		{
			needs: {},
			situations: [
				"ordered by a cast output",
				"ordered by two outputs",
				"the tag alone"
			] satisfies ReadonlyArray<Reached<Feature>>,
			check: (_, c: Case<Feature>) => (box) =>
				Effect.sync(() => {
					const input = succeeded(queryInput(tagged[box.source](box.shape, box.direction)))
					const checked = succeeded(
						checkQuery(checking(Refined), input.desc, checkOptions("query"))
					)
					const program = succeeded(
						lowerAligned(checked, "query", {
							binding: costChosen(),
							names: installation.names,
							context: "snapshot",
							catalog
						})
					)
					for (const q of Arr.flatMap(programAsts(program), orderedCores)) {
						const uncast = Arr.flatMap(q.targets, (t) =>
							t.expr.kind === "cast" ? [t.expr.expr] : []
						)
						for (const item of q.orderBy) {
							const same = (e: Expr) => canonicalEquals(e, item.expr)
							assert.ok(
								!Arr.some(uncast, same),
								"no ORDER BY item reads a cast output's uncast value"
							)
							const output = Arr.findFirst(q.targets, (t) => same(t.expr))
							if (q.distinct) {
								assert.ok(
									Option.isSome(output),
									"each ORDER BY item under SELECT DISTINCT is one of its outputs"
								)
							}
							if (Option.isSome(output) && output.value.expr.kind === "cast") {
								c.note("ordered by a cast output")
							}
						}
						if (q.orderBy.length > 1) {
							c.note("ordered by two outputs")
						}
					}
					if (box.shape === "the tag alone") {
						c.note("the tag alone")
					}
				}),
			oracle: {
				kind: "specification",
				name: "an ORDER BY item reads a cast output's cast, and under SELECT DISTINCT one of the outputs (42P10)"
			},
			box: "a refined derived column or parameter emitted alone or beside a key-less projected field, ordered by it alone or after the field, either direction",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/shapes/refined/index.ts",
					original: "\treturn { ...query, body, orderBy }",
					replacement: "\treturn { ...query, body, orderBy: query.orderBy }",
					why: "castOutputs leaves the ORDER BY item of a cast output uncast; the search fails."
				}
			]
		}
	)
