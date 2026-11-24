/**
 * The RelNode family's structural readers (ir/rel.ts), over the every-kind fixture and generated DAGs.
 *
 * - Structural map: a node's edges and expressions are listed exactly as its structural map meets them, in its order,
 *   and the map restates the node unchanged. Oracle: the structural map, driven, against edgesOf and exprsOf.
 * - Kept rows: a node keeps rows only of a data input whose heading is its own, and delivers that input exactly when it
 *   keeps every row. Oracle: the kept-rows rule as a checker.
 *
 * - Rebuild: a node read with its edges replaced by their values (ir/dag.ts edgeValues, rel.ts replacedEdges) is the
 *   node, its edges yielded in structural order, and every part of it that holds no edge is the node's own part, shared:
 *   a rebuild allocates only the containers its edges stand in, where restating every reference as itself (mapNode over
 *   keptRefs) copied every container and record of the node, which the one constructor then froze again (relNode).
 *   Oracle: the node itself, and an audit of every part of the rebuild (rel.fixtures.ts copiedApart).
 *
 * - Closed values: a closed column's values are its distinct literals by canonical text, in the order its rows first
 *   hold them. Oracle: the dedupe by canonical text alone (second implementation).
 *
 * Features: every node kind; each kind that keeps rows, and one keeping every row; a closed literal held again, of a
 * primitive kind and of a record's.
 */

import { assert, contains, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { array, element, type Gen, int, map } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { canonicalTextOf } from "#compiler/core/canonical.ts"
import { edgeValues, topoOrder } from "#compiler/ir/dag.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { drive } from "#compiler/ir/fold.ts"
import {
	closedValues,
	deliveredInput,
	edgesOf,
	exprsOf,
	inputsOf,
	keptRefs,
	keptRowsOf,
	type LiveRefs,
	mapNode,
	type RelKind,
	relKinds,
	type RelNode
} from "#compiler/ir/rel.ts"
import { copiedApart, dags, type Keeping } from "#test/unit/ir/rel.fixtures.ts"
import { drawnKinds, literalArms } from "#test/unit/ir/scalar.fixtures.ts"

/**
 * The RelNode family lists a node's edges and expressions exactly as its structural map meets them, and restates it
 * unchanged.
 *
 * Budget: 100 runs and 100 steered cases, what its suite stated before it became a property
 * (test/unit/ir/rel.test.ts:47 at 8cad5bce, its runs and its coverage's cases).
 */
export const theRelNodeFamilyListsANodesEdgesAndExpressionsExactlyAsItsStructuralMapMeetsThemAndRestatesItUnchanged =
	property.explore(dags, {
		needs: {},
		budget: { runs: 100, steered: 100 },
		situations: Arr.map(relKinds, (kind): `a ${RelKind}` => `a ${kind}`) satisfies ReadonlyArray<
			Reached<`a ${RelKind}`>
		>,
		check: (_, c: Case<`a ${RelKind}`>) => (dag) =>
			Effect.sync(() => {
				for (const node of topoOrder(dag)) {
					c.note(`a ${node.kind}`)
					const yielded: Array<RelNode> = []
					const restated: Array<ScalarExpr> = []
					const same = drive(
						mapNode<LiveRefs, LiveRefs>(node, {
							...keptRefs,
							expr: (e) => {
								restated.push(e)
								return e
							}
						}),
						(edge) => {
							yielded.push(edge)
							return edge
						}
					)
					assert.deepEqual(same, node)
					assert.deepEqual<ReadonlyArray<RelNode>>(
						yielded,
						edgesOf(node),
						`${node.kind} ${node.id} edges`
					)
					assert.deepEqual<ReadonlyArray<ScalarExpr>>(
						restated,
						exprsOf(node),
						`${node.kind} ${node.id} expressions`
					)
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the structural map (mapNode, driven) as the edge and expression listings' reference"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/rel.ts",
				original: "\t\t\treturn [n.parent, n.child]",
				replacement: "\t\t\treturn [n.parent]",
				why: "An attachment's child is missing from its edges; the structural map property fails."
			}
		]
	})

/**
 * The RelNode family keeps rows only of a data input whose heading is its own, for every kind.
 *
 * Budget: 100 runs and 100 steered cases, what its suite stated before it became a property
 * (test/unit/ir/rel.test.ts:107 at 8cad5bce, its runs and its coverage's cases).
 */
export const theRelNodeFamilyKeepsRowsOnlyOfADataInputWhoseHeadingIsItsOwnForEveryKind =
	property.explore(dags, {
		needs: {},
		budget: { runs: 100, steered: 100 },
		situations: [
			"keeps every row",
			...Arr.map(
				["Filter", "Take", "OrderedResult", "Attach", "Forbid"] satisfies ReadonlyArray<Keeping>,
				(kind): `keeps rows of a ${RelKind}` => `keeps rows of a ${kind}`
			)
		] satisfies ReadonlyArray<Reached<`keeps rows of a ${RelKind}` | "keeps every row">>,
		check: (_, c: Case<`keeps rows of a ${RelKind}` | "keeps every row">) => (dag) =>
			Effect.sync(() => {
				for (const node of topoOrder(dag)) {
					const kept = keptRowsOf(node)
					if (kept === undefined) {
						continue
					}
					c.note(`keeps rows of a ${node.kind}`)
					if (kept.keeps === "every") {
						c.note("keeps every row")
					}
					contains(inputsOf(node), kept.input)
					assert.deepEqual(kept.input.heading, node.heading, `${node.kind} ${node.id}`)
					assert.equal(deliveredInput(node), kept.keeps === "every" ? kept.input : undefined)
				}
			}),
		oracle: {
			kind: "specification",
			name: "a node keeps rows only of a data input of its own heading, and delivers it exactly when it keeps every row"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/rel.ts",
				original: '\t\t\treturn { input: n.parent, keeps: "every" }',
				replacement: '\t\t\treturn { input: n.child, keeps: "every" }',
				why: "An attachment keeps its child's rows, not its parent's; the kept-rows property fails, and so does the structural map's, whose DAG the delivery rule then refuses."
			}
		]
	})

/** A node read with its edges replaced is the node, sharing every part of it that holds no edge. */
export const aNodeReadWithItsEdgesReplacedIsTheNodeSharingEveryPartOfItThatHoldsNoEdge =
	property.explore(dags, {
		needs: {},
		situations: Arr.map(relKinds, (kind): `a ${RelKind}` => `a ${kind}`) satisfies ReadonlyArray<
			Reached<`a ${RelKind}`>
		>,
		check: (_, c: Case<`a ${RelKind}`>) => (dag) =>
			Effect.sync(() => {
				for (const node of topoOrder(dag)) {
					c.note(`a ${node.kind}`)
					const yielded: Array<RelNode> = []
					const rebuilt = drive(edgeValues<RelNode>(node), (edge) => {
						yielded.push(edge)
						return edge
					})
					assert.deepEqual(rebuilt, node, `${node.kind} ${node.id} read back`)
					assert.deepEqual<ReadonlyArray<RelNode>>(
						yielded,
						edgesOf(node),
						`${node.kind} ${node.id} edges`
					)
					assert.deepEqual(
						copiedApart(node, rebuilt, new Set(edgesOf(node)), "node"),
						[],
						`${node.kind} ${node.id}: no part that holds no edge is copied`
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: "the node itself, every part of it that holds no edge shared (rel.fixtures.ts copiedApart)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/rel.ts",
				original: "\t\t\t\toccurrences.push({ ...o, source })\n",
				replacement: "\t\t\t\toccurrences.push({ ...o, source, bindings: [...o.bindings] })\n",
				why: "A region's rebuild copies each occurrence's bindings, which hold no edge, as restating every reference copied them: the copied bindings are a part the audit finds built anew, and the search fails."
			},
			{
				file: "packages/engine/src/ir/rel.ts",
				original: "\t\t\treturn { ...n, input }\n",
				replacement: "\t\t\treturn { ...n, input, meta: { ...n.meta } }\n",
				why: "A one-input node's rebuild copies its metadata, which holds no edge: the audit finds it built anew, and the search fails."
			}
		]
	})

/** The kinds of literal whose value is a record or a list, as their canonical texts read it. */
const recordKinds: ReadonlySet<TypedLiteral["kind"]> = new Set([
	"numeric",
	"money",
	"date",
	"inet",
	"cidr",
	"handles",
	"span",
	"vector",
	"pattern"
])

/** What a closed column reaches: a literal held again, of a primitive kind or of a record's, and two values of one. */
type ColumnFeature =
	| "a primitive literal held again"
	| "a record literal held again"
	| "two values of a primitive kind"

/**
 * A closed column of one to twelve rows over a pool of one to four literals of one drawn kind, as a column's field types
 * every value of it, each row its pool literal copied, an object of its own, so a literal held again is canonically,
 * never referentially, the one before it. A closed relation admits well-formed text alone (closed.relation), so a
 * text holds its value made well-formed.
 */
const columnGen: Gen<ReadonlyArray<ReadonlyArray<TypedLiteral>>> = (source) => {
	const kind = source.draw(element(drawnKinds))
	const pool = source.draw(
		array(
			map(literalArms[kind], (literal): TypedLiteral =>
				literal.kind === "text" ? { kind: "text", value: literal.value.toWellFormed() } : literal
			),
			{ min: 1, max: 4 }
		)
	)
	return Arr.map(source.draw(array(int(0, pool.length - 1), { min: 1, max: 12 })), (at) => [
		{ ...defined(pool[at], "a pool literal") }
	])
}

/** A closed column's values are its distinct literals by canonical text, in the order its rows first hold them. */
export const aClosedColumnsValuesAreItsDistinctLiteralsByCanonicalTextInTheOrderItsRowsFirstHoldThem =
	property.explore(columnGen, {
		needs: {},
		situations: [
			"a primitive literal held again",
			"a record literal held again",
			"two values of a primitive kind"
		] satisfies ReadonlyArray<Reached<ColumnFeature>>,
		check: (_, c: Case<ColumnFeature>) => (rows) =>
			Effect.sync(() => {
				const texts = new Set<string>()
				const expected = Arr.filter(
					Arr.map(rows, (row) => defined(row[0], "a cell")),
					(literal) => {
						const text = canonicalTextOf(literal)
						const unseen = !texts.has(text)
						texts.add(text)
						if (!unseen) {
							c.note(
								recordKinds.has(literal.kind)
									? "a record literal held again"
									: "a primitive literal held again"
							)
						}
						return unseen
					}
				)
				if (
					expected.length > 1 &&
					Arr.every(expected, (literal) => !recordKinds.has(literal.kind))
				) {
					c.note("two values of a primitive kind")
				}
				const values = closedValues(rows, 0)
				assert.deepEqual(
					Arr.map(values, canonicalTextOf),
					Arr.map(expected, canonicalTextOf),
					"the column's distinct literals by canonical text"
				)
				assert.ok(
					values.length === expected.length && Arr.every(values, (v, i) => v === expected[i]),
					"each value the row that first holds it"
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the column's literals deduplicated by canonical text alone"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/rel.ts",
				original: '\t\tcase "sha256":\n\t\t\treturn literal.value\n',
				replacement: '\t\tcase "sha256":\n\t\t\treturn literal.kind\n',
				why: "Every literal of a primitive kind with a value is known by its kind alone: a column of two integers, texts or booleans holds one value, and the search fails."
			}
		]
	})
