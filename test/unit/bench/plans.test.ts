import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, oneOf } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Result } from "effect"
import {
	MalformedPlan,
	type PlanLabel,
	planEdges,
	planIndexNames,
	planNodeTypes
} from "#bench/harness/explain.ts"
import type { Json } from "#compiler/core/canonical.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

/**
 * A plan node as the generator states it: its type, the index it reads by name if any, the join type or strategy that
 * refines it if any, and its children.
 */
interface Node {
	readonly type: string
	readonly index: { readonly kind: "none" } | { readonly kind: "named"; readonly name: string }
	readonly refinement:
		| { readonly kind: "none" }
		| { readonly kind: "join"; readonly joinType: string }
		| { readonly kind: "strategy"; readonly strategy: string }
	readonly children: ReadonlyArray<Node>
}

const scans = ["Index Scan", "Index Only Scan", "Bitmap Index Scan"] as const
const joins = ["Nested Loop", "Hash Join", "Merge Join"] as const
const strategic = ["Aggregate", "SetOp"] as const
const others = ["Seq Scan", "Sort", "Limit", "Result"] as const
const indexNames = ["plan_index_a", "plan_index_b", '"quoted" name', "ä"] as const
const joinTypes = ["Inner", "Left", "Semi", "Anti"] as const
const strategies = ["Plain", "Sorted", "Hashed", "Mixed"] as const
const none: Node["index"] = { kind: "none" }

/** A plan of at most `depth` levels below its root, an index scan at the last level. */
const nodeGen = (depth: number): Gen<Node> => {
	const scan: Gen<Node> = (source) => ({
		type: source.draw(element(scans)),
		index: { kind: "named", name: source.draw(element(indexNames)) },
		refinement: { kind: "none" },
		children: []
	})
	if (depth === 0) {
		return scan
	}
	const child = nodeGen(depth - 1)
	return oneOf<Node>([
		scan,
		(source) => ({
			type: source.draw(element(joins)),
			index: none,
			refinement: { kind: "join", joinType: source.draw(element(joinTypes)) },
			children: source.draw(array(child, { min: 2, max: 2 }))
		}),
		(source) => ({
			type: source.draw(element(strategic)),
			index: none,
			refinement: { kind: "strategy", strategy: source.draw(element(strategies)) },
			children: source.draw(array(child, { min: 1, max: 1 }))
		}),
		(source) => ({
			type: source.draw(element(others)),
			index: none,
			refinement: { kind: "none" },
			children: source.draw(array(child, { min: 0, max: 2 }))
		})
	])
}

const planGen: Gen<Node> = nodeGen(3)

/**
 * The node as EXPLAIN (FORMAT JSON) prints it: its keys beside figures an ANALYZE prints, children under Plans only
 * when it has any.
 */
const printed = (node: Node): { readonly [key: string]: Json } => ({
	"Node Type": node.type,
	...(node.index.kind === "named" ? { "Index Name": node.index.name } : {}),
	...(node.refinement.kind === "join" ? { "Join Type": node.refinement.joinType } : {}),
	...(node.refinement.kind === "strategy" ? { Strategy: node.refinement.strategy } : {}),
	"Startup Cost": 0.25,
	"Plan Rows": 7,
	"Actual Loops": 1,
	...(node.children.length === 0 ? {} : { Plans: Arr.map(node.children, printed) })
})

const preorder = (node: Node): ReadonlyArray<Node> => [
	node,
	...Arr.flatMap(node.children, preorder)
]

const labelOf = (node: Node): PlanLabel => ({
	nodeType: node.type,
	joinType: node.refinement.kind === "join" ? Option.some(node.refinement.joinType) : Option.none(),
	strategy:
		node.refinement.kind === "strategy" ? Option.some(node.refinement.strategy) : Option.none()
})

/** Whether reading the cell throws its MalformedPlan (anything else it throws fails this test). */
const readFails = (read: () => unknown): boolean => {
	const outcome = Result.try(read)
	if (Result.isSuccess(outcome)) {
		return false
	}
	if (outcome.failure instanceof MalformedPlan) {
		return true
	}
	throw outcome.failure
}

/** How a cell is broken. */
type Break =
	| "no node type"
	| "two plans"
	| "a number for an index"
	| "a number for a strategy"
	| "no array"

describe("the EXPLAIN readers", () => {
	it.effect(
		"read every node's type, every index a node names and every labelled edge, in plan order, from either cell form",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/bench/plan-readers",
						draw: drawn((source) => ({ plan: source.draw(planGen), text: source.draw(boolean) })),
						literal: Formatter.format,
						coverage: required<
							"json text" | "parsed value" | "nested" | "an index" | "a join type" | "a strategy"
						>(["json text", "parsed value", "nested", "an index", "a join type", "a strategy"], {
							cases: 200,
							sense: notesOnly
						}),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ plan, text }, c) =>
						Effect.sync(() => {
							const value = [{ Plan: printed(plan) }]
							const cell = text ? jsonText(value) : value
							const nodes = preorder(plan)
							const named = Arr.flatMap(nodes, (n) =>
								n.index.kind === "named" ? [n.index.name] : []
							)
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
						})
				)
			)
	)

	it.effect("refuse a cell that is not one plan", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/bench/plan-readers-malformed",
					draw: drawn((source) => ({
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
					})),
					literal: Formatter.format,
					coverage: required<Break>(
						[
							"no node type",
							"two plans",
							"a number for an index",
							"a number for a strategy",
							"no array"
						],
						{ cases: 100, sense: notesOnly }
					),
					kept: [],
					runs: 100,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				({ plan, break: broken }, c) =>
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
					})
			)
		)
	)
})
