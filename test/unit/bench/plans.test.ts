/**
 * The bench harness's EXPLAIN readers (bench/harness/explain.ts), over plans the generator states: a tree of scans,
 * joins with a join type, grouping nodes with a strategy and plain nodes, at most three levels below its root, each
 * scan reading an index by name, quoted and non-ASCII names among them.
 *
 * - Read-back: printed as EXPLAIN (FORMAT JSON) prints it, figures an ANALYZE prints beside, as the JSON text or the
 *   value the driver parses, the plan reads back as stated: every node's type, every index a node names and every
 *   labelled edge, each in plan order (a node before its children), the order the readers promise.
 * - Refusal: a cell that is not one plan (a node with no type, two plans, a number for an index name or a strategy,
 *   no array) is refused as MalformedPlan by every reader, and anything else a reader throws fails the case.
 *
 * Oracle: the specification, a round trip of the plan the generator states. Features: either cell form, a nested plan,
 * an index, a join type and a strategy; every way a cell breaks.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { boolean, element } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { planEdges, planIndexNames, planNodeTypes } from "#bench/harness/explain.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { assert } from "#test/support/assert.ts"
import {
	type Break,
	labelOf,
	planGen,
	preorder,
	printed,
	readFails
} from "#test/unit/bench/plans.fixtures.ts"

/**
 * The EXPLAIN readers read every node's type, every index a node names and every labelled edge, in plan order, from
 * either cell form.
 *
 * Budget: its suite's count before the conversion (unit/bench/plan-readers: 200 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const theEXPLAINReadersReadEveryNodesTypeEveryIndexANodeNamesAndEveryLabelledEdgeInPlanOrderFromEitherCellForm =
	property.explore((source) => ({ plan: source.draw(planGen), text: source.draw(boolean) }), {
		needs: {},
		situations: [
			"json text",
			"parsed value",
			"nested",
			"an index",
			"a join type",
			"a strategy"
		] satisfies ReadonlyArray<
			Reached<"json text" | "parsed value" | "nested" | "an index" | "a join type" | "a strategy">
		>,
		check:
			(
				_,
				c: Case<"json text" | "parsed value" | "nested" | "an index" | "a join type" | "a strategy">
			) =>
			({ plan, text }) =>
				Effect.sync(() => {
					const value = [{ Plan: printed(plan) }]
					const cell = text ? jsonText(value) : value
					const nodes = preorder(plan)
					const named = Arr.flatMap(nodes, (n) => (n.index.kind === "named" ? [n.index.name] : []))
					c.note(text ? "json text" : "parsed value")
					if (plan.children.length > 0) {
						c.note("nested")
					}
					if (named.length > 0) {
						c.note("an index")
					}
					if (Arr.some(nodes, (n) => n.refinement.kind === "join")) {
						c.note("a join type")
					}
					if (Arr.some(nodes, (n) => n.refinement.kind === "strategy")) {
						c.note("a strategy")
					}
					assert.deepEqual(
						planNodeTypes(cell),
						Arr.map(nodes, (n) => n.type)
					)
					assert.deepEqual(planIndexNames(cell), named)
					assert.deepEqual(
						planEdges(cell),
						Arr.flatMap(nodes, (parent) =>
							Arr.map(parent.children, (child) => ({
								parent: labelOf(parent),
								child: labelOf(child)
							}))
						)
					)
				}),
		oracle: {
			kind: "specification",
			name: "the plan the generator states, printed as EXPLAIN prints it and read back"
		},
		budget: { runs: 200, steered: 0 },
		kept: [],
		kills: []
	})

/**
 * The EXPLAIN readers refuse a cell that is not one plan.
 *
 * Budget: its suite's count before the conversion (unit/bench/plan-readers-malformed: 100 independent cases and 0
 * steered, Vitest at grizzle 4ca3036a).
 */
export const theEXPLAINReadersRefuseACellThatIsNotOnePlan = property.explore(
	(source) => ({
		plan: source.draw(planGen),
		break: source.draw(
			element<Break>([
				"no node type",
				"two plans",
				"a number for an index",
				"a number for a strategy",
				"no array"
			])
		)
	}),
	{
		needs: {},
		situations: [
			"no node type",
			"two plans",
			"a number for an index",
			"a number for a strategy",
			"no array"
		] satisfies ReadonlyArray<Reached<Break>>,
		check:
			(_, c: Case<Break>) =>
			({ plan, break: broken }) =>
				Effect.sync(() => {
					const { "Node Type": _type, ...untyped } = printed(plan)
					const cell =
						broken === "no node type"
							? [{ Plan: untyped }]
							: broken === "two plans"
								? [{ Plan: printed(plan) }, { Plan: printed(plan) }]
								: broken === "a number for an index"
									? [{ Plan: { ...printed(plan), "Index Name": 7 } }]
									: broken === "a number for a strategy"
										? [{ Plan: { ...printed(plan), Strategy: 7 } }]
										: { Plan: printed(plan) }
					c.note(broken)
					assert.ok(readFails(() => planNodeTypes(cell)))
					assert.ok(readFails(() => planIndexNames(cell)))
					assert.ok(readFails(() => planEdges(cell)))
				}),
		oracle: {
			kind: "specification",
			name: "a cell that is not one plan is refused as MalformedPlan by every reader"
		},
		budget: { runs: 100, steered: 0 },
		kept: [],
		kills: []
	}
)
