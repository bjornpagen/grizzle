/**
 * The form the optimized recursive lowering gives a recursion (lower/shapes/recursion/index.ts), against the rule its
 * header states: whatever depth a counter bounds the recursion to, it is one recursive CTE, its feedback under UNION and
 * no DISTINCT anywhere, the complete final state needing none; a recursion realized without its UNION is refused
 * (MalformedDescription).
 *
 * Oracle: the module's stated form, checked on the lowered statement's AST (a specification). Feature: a bounded walk.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { catchRefusal } from "#compiler/core/canonical.ts"
import {
	carriesNothing,
	emptyEnv,
	evaluatedAsItStands,
	LowerContext
} from "#compiler/lower/conservative/context.ts"
import { emptyCtePlan } from "#compiler/lower/optimize/cte-policy/index.ts"
import { optimizedDispatch, ShapeState } from "#compiler/lower/shapes/index.ts"
import { recursionLowerer } from "#compiler/lower/shapes/recursion/index.ts"
import { noKeys } from "#compiler/lower/shapes/share/keyed.ts"
import type { RelationInput } from "#compiler/lower/shapes/take/index.ts"
import { refused } from "#test/support/assert.ts"
import {
	admit,
	mainAst,
	names,
	optimize,
	queries,
	recursiveCtes,
	recursiveNode,
	walkBelow,
	walkBounds
} from "#test/unit/lower/recursion.fixtures.ts"
import { conservativeShapeFacts } from "#test/unit/lower/shapes/support.ts"
import { present } from "#test/unit/lower/support.ts"

/** The form a recursion lowers to (packages/engine/src/lower/shapes/recursion/index.ts) keeps the UNION recursive CTE at every bounded depth, and refuses a plain realization. */
export const theFormARecursionLowersToPackagesEngineSrcLowerShapesRecursionIndexTsKeepsTheUNIONRecursiveCTEAtEveryBoundedDepthAndRefusesAPlainRealization =
	property.exhaust(walkBounds, {
		needs: {},
		situations: ["bounded walk"] satisfies ReadonlyArray<Reached<"bounded walk">>,
		check: (_, c: Case<"bounded walk">) => (below) =>
			Effect.sync(() => {
				const q = admit(walkBelow(below))
				const rec = recursiveNode(q)
				const ast = mainAst(optimize(q))
				const ctes = recursiveCtes(ast)
				const [cte] = ctes
				assert.equal(ctes.length, 1)
				const body = present(cte, "the recursive CTE").query
				assert.ok(body.kind === "select" && body.body.kind === "setOp" && body.body.op === "UNION")
				assert.equal(
					Arr.some(queries(ast), (x) => x.body.kind === "core" && x.body.distinct !== false),
					false
				)
				c.note("bounded walk")
				/** A recursion realized without its UNION. */
				const facts = conservativeShapeFacts({
					realization: (node) => (node.id === rec.id ? "plain" : "distinct")
				})
				const cx = new LowerContext(
					q.dag,
					{
						names,
						params: q.params,
						subject: { kind: "query" }
					},
					optimizedDispatch(facts, new ShapeState<RelationInput>("small", emptyCtePlan, noKeys))
						.dispatch,
					evaluatedAsItStands,
					carriesNothing
				)
				refused(
					catchRefusal(() => recursionLowerer(facts)(rec, cx, emptyEnv)),
					"MalformedDescription"
				)
			}),
		oracle: {
			kind: "specification",
			name: "one recursive CTE under UNION, no DISTINCT, whatever the depth; a plain realization refused"
		},
		box: "a walk from a parameter root bounded below every depth from none to six hops",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/recursion/index.ts",
				original: '\t\t\t\t\t\tselect({ kind: "setOp", op: "UNION", arms: [base, step] }),',
				replacement:
					'\t\t\t\t\t\tselect({ kind: "setOp", op: "UNION ALL", rows: "operand", arms: [base, step] }),',
				why: "The recursive CTE's terms are joined by UNION ALL; the search fails, the lowering's promise check (statementRows) finding the CTE's repeats read as a set."
			},
			{
				file: "packages/engine/src/lower/shapes/recursion/index.ts",
				original: '\t\tif (facts.realization(node) !== "distinct") {',
				replacement: "\t\tif (facts.realization(node) === undefined) {",
				why: "A recursion realized without its UNION is lowered rather than refused; the search fails."
			}
		]
	})
