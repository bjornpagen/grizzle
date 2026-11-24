/** What the properties of dag-index.test.ts read: their programs, their lowering and the walks the index replaced. */

import { array, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import type { NodeId } from "#compiler/core/ids.ts"
import { nodesByLabel, topoOrder } from "#compiler/ir/dag.ts"
import { exprClosure, type ScalarExpr } from "#compiler/ir/expr.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import {
	conservativeMeta,
	exprsOf,
	inputsOf,
	type RelNode,
	type ValidDag
} from "#compiler/ir/rel.ts"
import { LowerContext } from "#compiler/lower/conservative/context.ts"
import { emptyCtePlan } from "#compiler/lower/optimize/cte-policy/index.ts"
import { OptimizedDelivery, optimizedDispatch, ShapeState } from "#compiler/lower/shapes/index.ts"
import { noKeys } from "#compiler/lower/shapes/share/keyed.ts"
import type { RelationInput } from "#compiler/lower/shapes/take/index.ts"
import { asc, Q, T, Task } from "#test/unit/lower/conservative/fixtures.ts"
import { shapedFacts, testOptions } from "#test/unit/lower/shapes/support.ts"

/**
 * One arm of a program: a region a filter bounds by a parameter, which the region's lowering asks for its only reader
 * (region/index.ts impliedBounds); a region two arms of the program read, so it has two readers; a region matching one
 * source twice, which reads that input at two edges; or a take of the first row of a union of two regions, which the
 * take's lowering asks for the union's only reader (take/index.ts armBoundable).
 */
const arms = ["bounded", "read twice", "self-join", "first of a union"] as const

export type Arm = (typeof arms)[number]

/** A program's arms, two to six, each read by the union of them all. */
export const armsGen: Gen<ReadonlyArray<Arm>> = array(element(arms), { min: 2, max: 6 })

/** The program of `drawn`: a union of its arms, each projected to the tasks' ids. */
export const programOf = (drawn: ReadonlyArray<Arm>): LogicalQuery => {
	const q = new Q()
	const ids = (node: RelNode): RelNode => q.project(node, [["id", "id"]], conservativeMeta)
	const tasks = (): RelNode =>
		q.region([{ source: q.base(Task, conservativeMeta), bind: { id: "id" }, constants: {} }])
	const amounts = (): RelNode =>
		q.region([
			{
				source: q.base(Task, conservativeMeta),
				bind: { id: "id", amount: "amount" },
				constants: {}
			}
		])
	const atLeast = (r: RelNode): RelNode =>
		q.filter(r, q.op("int8ge", [q.col(r, "amount"), q.param("least", T.int8, "compare")], T.bool))
	const arm = (a: Arm): ReadonlyArray<RelNode> => {
		switch (a) {
			case "bounded":
				return [ids(atLeast(amounts()))]
			case "read twice": {
				const r = amounts()
				return [ids(r), ids(atLeast(r))]
			}
			case "self-join": {
				const task = q.base(Task, conservativeMeta)
				return [
					ids(
						q.region([
							{ source: task, bind: { id: "id", account: "account" }, constants: {} },
							{ source: task, bind: { account: "account" }, constants: {} }
						])
					)
				]
			}
			case "first of a union":
				return [
					q.take(
						q.union([ids(tasks()), ids(tasks())], []),
						asc("id"),
						{ kind: "literal", k: 1n },
						[],
						conservativeMeta
					)
				]
		}
	}
	return q.build(q.union(Arr.flatMap(drawn, arm), []))
}

/**
 * The program of `query` delivered by the optimized lowering: how many nodes its lowering context's index builds visited
 * (LowerContext.indexVisits), over every statement, and how many regions its DAG holds.
 */
export const lowered = (
	query: LogicalQuery
): { readonly visits: number; readonly regions: number } => {
	const { facts } = shapedFacts(query.dag, {}, "placement")
	const state = new ShapeState<RelationInput>("small", emptyCtePlan, noKeys)
	const dispatching = optimizedDispatch(facts, state)
	const cx = new LowerContext(
		query.dag,
		{ ...testOptions("Ledger"), params: query.params },
		dispatching.dispatch,
		state.evaluationHolding,
		dispatching.carrying
	)
	new OptimizedDelivery<never>(cx, facts, state).optimizedProgram(query.dag.roots[0])
	return {
		visits: cx.indexVisits,
		regions: Arr.filter(topoOrder(query.dag), (n) => n.kind === "MatchRegion").length
	}
}

/**
 * What the index answers, each by the walk a lowering took for each node before it (the second implementation): a
 * node's readers by filtering the DAG's topological order for the nodes whose inputs hold it, a label's column reads by
 * filtering the closure of every node's expressions, a root by the DAG's roots, a label's node by nodesByLabel.
 */
export const walked = (
	dag: ValidDag
): {
	readonly readersOf: (node: RelNode) => ReadonlyArray<RelNode>
	readonly columnReadsOf: (label: NodeId) => ReadonlyArray<ScalarExpr>
	readonly isRoot: (node: RelNode) => boolean
	readonly labeled: (label: NodeId) => RelNode | undefined
} => ({
	readersOf: (node) => Arr.filter(topoOrder(dag), (n) => inputsOf(n).includes(node)),
	columnReadsOf: (label) =>
		Arr.filter(
			exprClosure(Arr.flatMap(topoOrder(dag), (n) => exprsOf(n))),
			(e) => e.kind === "column" && e.column.node === label
		),
	isRoot: (node) => dag.roots.includes(node),
	labeled: (label) => nodesByLabel(dag).get(label)
})
