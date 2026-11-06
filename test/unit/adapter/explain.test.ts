import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int, recursive, subset } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { double } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec, Result } from "effect"
import { decodePlan } from "#adapter/explain/plan.ts"
import type { Plan } from "#adapter/types/db.ts"
import type { Json } from "#compiler/core/canonical.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

/**
 * EXPLAIN (FORMAT JSON) decoding (packages/grizzle/src/adapter/explain/plan.ts): the public Plan keeps exactly each
 * node's type and four estimates and its children in order, and drops every other member PostgreSQL prints.
 *
 * Over drawn plan trees, each node of a type PostgreSQL names, its estimates drawn apart from each other so no two
 * coincide by accident, and beside them members PostgreSQL prints that the Plan drops: the answer's json text decodes to
 * the tree's projection onto the Plan's fields. The oracle is that projection, written from the documented mapping
 * ("Node Type" to node, "Startup Cost", "Total Cost", "Plan Rows" and "Plan Width" to the estimates, "Plans" to the
 * children).
 */
interface Node {
	readonly type: string
	readonly startup: number
	readonly total: number
	readonly rows: number
	readonly width: number
	readonly dropped: ReadonlyArray<readonly [string, Json]>
	readonly children: ReadonlyArray<Node>
}

/** Node types PostgreSQL prints. */
const nodeTypes = [
	"Seq Scan",
	"Index Scan",
	"Index Only Scan",
	"Bitmap Heap Scan",
	"Hash Join",
	"Hash",
	"Nested Loop",
	"Merge Join",
	"Sort",
	"Aggregate",
	"Limit",
	"Result",
	"CTE Scan"
] as const

/** Members PostgreSQL prints beside the ones the Plan keeps, each with a value of its kind. */
const droppedMembers: Arr.NonEmptyReadonlyArray<readonly [string, Json]> = [
	["Parallel Aware", false],
	["Async Capable", false],
	["Relation Name", "task"],
	["Alias", "t"],
	["Hash Cond", "(a.id = b.id)"],
	["Index Cond", "(id = $1)"],
	["Join Type", "Inner"],
	["Sort Key", ["a.id"]],
	["Disabled", true],
	["Parent Relationship", "Outer"]
]

const leaf: Gen<Node> = (source) => ({
	type: source.draw(element(nodeTypes)),
	startup: source.draw(double(0, 1e6)),
	total: source.draw(double(0, 1e9)),
	rows: source.draw(int(0, 1_000_000)),
	width: source.draw(int(0, 4096)),
	dropped: source.draw(subset(droppedMembers, { min: 0, max: droppedMembers.length })),
	children: []
})

const nodeGen: Gen<Node> = recursive(
	leaf,
	(inner) => (source) => ({
		...source.draw(leaf),
		children: source.draw(array(inner, { min: 1, max: 3 }))
	}),
	3
)

/** The node as PostgreSQL prints it: its members, the dropped ones among them, "Plans" only when it has children. */
const printed = (node: Node): Json => ({
	...Rec.fromEntries(node.dropped),
	"Node Type": node.type,
	"Startup Cost": node.startup,
	"Total Cost": node.total,
	"Plan Rows": node.rows,
	"Plan Width": node.width,
	...(node.children.length === 0 ? {} : { Plans: Arr.map(node.children, printed) })
})

/** The documented mapping onto the Plan. */
const projected = (node: Node): Plan => ({
	node: node.type,
	startupCost: node.startup,
	totalCost: node.total,
	rows: node.rows,
	width: node.width,
	children: Arr.map(node.children, projected)
})

const depthOf = (node: Node): number =>
	1 + Arr.reduce(node.children, 0, (deepest, child) => Math.max(deepest, depthOf(child)))

type PlanFeature =
	| "a leaf"
	| "a node with several children"
	| "nested three deep"
	| "members dropped"

describe("EXPLAIN (FORMAT JSON) decoding", () => {
	it.effect(
		"keeps exactly each node's type, its estimates and its children, in order, of the json text",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/adapter/explain-plan",
						draw: drawn(nodeGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "the plan tree's projection onto the Plan's documented fields"
						},
						coverage: required<PlanFeature>(
							["a leaf", "a node with several children", "nested three deep", "members dropped"],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(root, k) =>
						Effect.sync(() => {
							assert.deepEqual(
								decodePlan(jsonText([{ Plan: printed(root) }])),
								Result.succeed(projected(root))
							)
							const all = (node: Node): ReadonlyArray<Node> => [
								node,
								...Arr.flatMap(node.children, all)
							]
							const nodes = all(root)
							if (root.children.length === 0) {
								k.note("a leaf")
							}
							if (Arr.some(nodes, (n) => n.children.length > 1)) {
								k.note("a node with several children")
							}
							if (depthOf(root) >= 3) {
								k.note("nested three deep")
							}
							if (Arr.some(nodes, (n) => n.dropped.length > 0)) {
								k.note("members dropped")
							}
						})
				)
			)
	)
})
