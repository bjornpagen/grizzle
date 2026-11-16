/** What the properties of plans.test.ts read: its spaces, models and helpers. */

import { array, element, type Gen, oneOf } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Result } from "effect"
import { MalformedPlan, type PlanLabel } from "#bench/harness/explain.ts"
import type { Json } from "#compiler/core/canonical.ts"

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

export const planGen: Gen<Node> = nodeGen(3)

/**
 * The node as EXPLAIN (FORMAT JSON) prints it: its keys beside figures an ANALYZE prints, children under Plans only
 * when it has any.
 */
export const printed = (node: Node): { readonly [key: string]: Json } => ({
	"Node Type": node.type,
	...(node.index.kind === "named" ? { "Index Name": node.index.name } : {}),
	...(node.refinement.kind === "join" ? { "Join Type": node.refinement.joinType } : {}),
	...(node.refinement.kind === "strategy" ? { Strategy: node.refinement.strategy } : {}),
	"Startup Cost": 0.25,
	"Plan Rows": 7,
	"Actual Loops": 1,
	...(node.children.length === 0 ? {} : { Plans: Arr.map(node.children, printed) })
})

export const preorder = (node: Node): ReadonlyArray<Node> => [
	node,
	...Arr.flatMap(node.children, preorder)
]

export const labelOf = (node: Node): PlanLabel => ({
	nodeType: node.type,
	joinType: node.refinement.kind === "join" ? Option.some(node.refinement.joinType) : Option.none(),
	strategy:
		node.refinement.kind === "strategy" ? Option.some(node.refinement.strategy) : Option.none()
})

/** Whether reading the cell throws its MalformedPlan (anything else it throws fails this test). */
export const readFails = (read: () => unknown): boolean => {
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
export type Break =
	| "no node type"
	| "two plans"
	| "a number for an index"
	| "a number for a strategy"
	| "no array"
