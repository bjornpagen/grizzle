/**
 * The relational DAG (ir/dag.ts): its traversals, its labels, its digest and its normal form.
 *
 * - Traversals: topoOrder lists exactly the reachable nodes once each, every node after its inputs, and an
 *   expression's closure is exactly what it reaches through its arguments, over generated DAGs; a chain of any depth,
 *   past what a small stack's recursion holds, passes every entry point. Oracle: a naive reachability, and the chain's
 *   own construction.
 * - Labels: two distinct nodes or two distinct expressions under one label are refused where they stand, and the
 *   validator raises a defect. Oracle: one node and one expression per label.
 * - Digest: it ignores allocation order, label spelling and source locations, and changes with a literal, the domain or
 *   the roots' order. Oracle: universal, the digest is a function of the DAG's meaning.
 * - Normal form: positional names, the same whatever the labels' spelling, a table the re-reader accepts; a region's
 *   variables allocated in either order give one digest and normal form; a domain predicate's spellings give one
 *   digest, and one not in normal form is refused at decode. Oracle: universal invariances.
 *
 * Features: a shared input, a closure past its arguments; a chain a recursion holds and one past it; two nodes and two
 * expressions clashing; each invariance and each change; several roots; y allocated first; an advanced supply and a
 * spelling not in normal form.
 */

import { postorder } from "@bjornpagen/grizzle-text/base/graph"
import { assert, defined, unorderedEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import {
	array,
	boolean,
	codePoint,
	constant,
	element,
	finite,
	int,
	map,
	shuffled,
	string,
	weighted
} from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Record as Rec, String as Str } from "effect"
import { encode, everyProperty } from "#compiler/core/canonical.ts"
import { makeIdSupply, NodeId, ParamId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { DagBuilder } from "#compiler/ir/builder.ts"
import { DagTemplates } from "#compiler/ir/dag-digest.ts"
import {
	cellTable,
	dagDigest,
	emptyDag,
	finishCells,
	freeVars,
	mergeDags,
	nodeScopes,
	nodesByLabel,
	relNode,
	topoOrder
} from "#compiler/ir/dag.ts"
import { builtExpr, exprClosure, type ScalarExpr, sortedUnique } from "#compiler/ir/expr.ts"
import { Fold } from "#compiler/ir/fold.ts"
import {
	type Cell,
	conservativeMeta,
	edgesOf,
	exprsOf,
	fieldParams,
	inputsOf,
	type RelNode
} from "#compiler/ir/rel.ts"
import { decodeScalarType } from "#compiler/ir/scalar-shape.ts"
import { refusalLoc, refused, succeeded, throwsDefect } from "#test/support/assert.ts"
import { normalizeDag, toTable } from "#test/support/dag.ts"
import { normalizeExprTable } from "#test/support/fixtures/ir/scalar.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import { validateDag, validateTable } from "#test/support/oracle/dag-validate.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import {
	build,
	buildNeed,
	cents,
	chainDepth,
	type ChainFeature,
	type Change,
	changedLiteral,
	type Clash,
	dag,
	digest,
	exprsIn,
	type Invariance,
	invariances,
	labelled,
	type NormalFeature,
	pool,
	positional,
	predicate,
	reach,
	reference,
	replacedExpr,
	replacedNode,
	respelled,
	smallStackRecursion,
	spellingOf
} from "#test/support/unit/ir/dag.fixtures.ts"
import { everyKind, fail, heading, scalarTypes } from "#test/support/unit/ir/fixture.ts"
import { generatedDags } from "#test/support/unit/ir/population.ts"
import { Q, Task } from "#test/support/unit/lower/conservative/fixtures.ts"

/**
 * Traversals of generated DAGs order every reachable node after its inputs, and close expressions over their
 * arguments.
 *
 * Budget: 300 runs and 300 steered cases, what its suite stated before it became a property
 * (test/unit/ir/dag.test.ts:249 at 8cad5bce, its runs and its coverage's cases).
 */
export const traversalsOfGeneratedDAGsOrderEveryReachableNodeAfterItsInputsAndCloseExpressionsOverTheirArguments =
	property.explore(generatedDags, {
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: ["a shared input", "a closure past its arguments"] satisfies ReadonlyArray<
			Reached<"a shared input" | "a closure past its arguments">
		>,
		check: (_, c: Case<"a shared input" | "a closure past its arguments">) => (d) =>
			Effect.sync(() => {
				const reachable = reach(d.roots, (node) => inputsOf(node))
				const order = topoOrder(d)
				assert.deepEqual<ReadonlySet<RelNode>>(
					new Set(order),
					reachable,
					"topoOrder lists exactly the reachable nodes"
				)
				assert.equal(order.length, reachable.size, "topoOrder lists each node once")
				const position = new Map(Arr.map(order, (node, i) => [node, i]))
				for (const node of order) {
					for (const input of inputsOf(node)) {
						assert.ok(
							(position.get(input) ?? -1) < (position.get(node) ?? -1),
							`${input.id} before ${node.id}`
						)
					}
				}
				const readers = new Map<RelNode, number>()
				for (const node of reachable) {
					for (const input of inputsOf(node)) {
						readers.set(input, (readers.get(input) ?? 0) + 1)
					}
				}
				if (Arr.some([...readers.values()], (n) => n > 1)) {
					c.note("a shared input")
				}
				for (const e of exprsIn(d)) {
					const expected = reach<ScalarExpr>([e], (x) => x.args)
					const closed = exprClosure([e])
					assert.equal(closed[0], e)
					assert.deepEqual<ReadonlySet<ScalarExpr>>(new Set(closed), expected)
					assert.equal(closed.length, expected.size)
					if (expected.size > 1 + new Set(e.args).size) {
						c.note("a closure past its arguments")
					}
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "a naive reachability over each node's inputs and each expression's arguments"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/dag.ts",
				original: "\tpostorder(dag.roots, (node) => edgesOf(node))",
				replacement: "\tpostorder(dag.roots, (node) => edgesOf(node)).toReversed()",
				why: "topoOrder lists a node before its inputs; the traversal property fails."
			}
		]
	})

/** What the dependency-list property reaches: a list one part's very list among two or more, and one merged anew. */
type DependencyFeature =
	| "a list that is one of several parts' lists"
	| "a list merged from two parts'"

/**
 * The dependency lists of every node and expression of a generated DAG are the union of their parts' (ir/dag.ts
 * relNode, ir/expr.ts builtExpr, sortedUnion): a node's parameters its own fields', its expressions' and its inputs',
 * its stored reads a Base's relation and its inputs', an expression's parameters and column nodes its own and its
 * arguments', each in code unit order without repeats; and a list that adds nothing to one of its parts' is that part's
 * very list, one value however many nodes and expressions read it, where each was a copy of its own.
 *
 * Oracle: the union of the parts' lists, sorted and deduplicated (sortedUnique, the old construction), and identity
 * with the part whose content it equals.
 *
 * Budget: 300 runs and 300 steered cases, the traversal property's, over its space.
 */
export const theDependencyListsOfGeneratedNodesAndExpressionsAreTheUnionOfTheirPartsAndAListAddingNothingIsItsPartsVeryList =
	property.explore(generatedDags, {
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: [
			"a list that is one of several parts' lists",
			"a list merged from two parts'"
		] satisfies ReadonlyArray<Reached<DependencyFeature>>,
		check: (_, c: Case<DependencyFeature>) => (d) =>
			Effect.sync(() => {
				/** `list`, built of `own`, the constructor's own items, and `parts`, its parts' lists, checked. */
				const union = (
					list: ReadonlyArray<string>,
					own: ReadonlyArray<string>,
					parts: ReadonlyArray<ReadonlyArray<string>>,
					what: string
				): void => {
					assert.deepEqual(
						list,
						sortedUnique([...own, ...parts.flat()]),
						`${what} is its parts' union`
					)
					const nonEmpty = Arr.filter(parts, (part) => part.length > 0)
					const covering = Arr.filter(
						nonEmpty,
						(part) => part.length === list.length && Arr.every(part, (x, i) => x === list[i])
					)
					if (covering.length > 0) {
						assert.ok(covering.includes(list), `${what} is the very list of the part it equals`)
						if (nonEmpty.length > 1) {
							c.note("a list that is one of several parts' lists")
						}
					} else if (nonEmpty.length > 1) {
						c.note("a list merged from two parts'")
					}
				}
				for (const node of topoOrder(d)) {
					union(
						node.meta.paramDeps,
						fieldParams(node),
						[
							...Arr.map(exprsOf(node), (e) => e.deps.params),
							...Arr.map(edgesOf(node), (input) => input.meta.paramDeps)
						],
						`${node.id}'s parameters`
					)
					union(
						node.meta.reads,
						node.kind === "Base" ? [node.relation] : [],
						Arr.map(edgesOf(node), (input) => input.meta.reads),
						`${node.id}'s reads`
					)
				}
				for (const e of exprsIn(d)) {
					union(
						e.deps.params,
						e.kind === "param" ? [e.param] : [],
						Arr.map(e.args, (a) => a.deps.params),
						`${e.id}'s parameters`
					)
					union(
						e.deps.nodes,
						e.kind === "column" ? [e.column.node] : [],
						Arr.map(e.args, (a) => a.deps.nodes),
						`${e.id}'s column nodes`
					)
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the parts' lists united by sortedUnique, and identity with the part a list equals"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/expr.ts",
				original:
					"\treturn out.length === b.length ? b : out.length === a.length ? a : Object.freeze(out)\n",
				replacement: "\treturn Object.freeze(out)\n",
				why: "A merged list is a copy even where it adds nothing to a part's, as the sorted Set of every part was: a node over an input whose list holds the rest keeps a list of its own."
			},
			{
				file: "packages/engine/src/ir/expr.ts",
				original: "\t\ti += order <= 0 ? 1 : 0\n",
				replacement: "\t\ti += order < 0 ? 1 : 0\n",
				why: "The merge keeps an item both lists hold twice: the union repeats it."
			}
		]
	})

/**
 * A DAG's topological order walks each node's data edges, repeats and all, and builds no list of distinct inputs
 * (ir/dag.ts topoOrder): the walk meets a repeated input seen and passes it, so its order is the postorder over each
 * node's distinct inputs (rel.ts inputsOf, the walk before), and a region's expressions, its scope's, are its
 * occurrences' constants then its correlated variables' (rel.ts exprsOf, scopeExprs), built in one pass.
 *
 * Oracle: the postorder over inputsOf, and the region's expressions spelled as the spread they replace (second
 * implementations: the old constructions); V8's call counts of inputsOf during the walk.
 *
 * Budget: 300 runs and 300 steered cases, the traversal property's, over its space.
 */
export const aTopologicalOrderWalksEachNodesEdgesAsThePostorderOverItsInputsAndBuildsNoInputList =
	property.explore(generatedDags, {
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: [
			"a node reading one input twice",
			"a region of expressions"
		] satisfies ReadonlyArray<
			Reached<"a node reading one input twice" | "a region of expressions">
		>,
		check: (_, c: Case<"a node reading one input twice" | "a region of expressions">) => (d) =>
			Effect.gen(function* () {
				const [order, counts] = yield* callCounts(
					Effect.sync(() => topoOrder(d)),
					{ inputsOf: { file: "packages/engine/src/ir/rel.ts", name: "inputsOf" } }
				)
				assert.equal(counts.inputsOf, 0, "the walk builds no list of distinct inputs")
				assert.deepEqual(
					order,
					postorder(d.roots, (node) => inputsOf(node))
				)
				/** A union of one projection twice, its edges a repeat, beside the drawn DAG. */
				const q = new Q()
				const twice = q.project(
					q.region([{ source: q.base(Task, conservativeMeta), bind: { id: "id" }, constants: {} }]),
					[["id", "id"]],
					conservativeMeta
				)
				const repeated = q.build(q.union([twice, twice], [])).dag
				const repeatedOrder = topoOrder(repeated)
				assert.deepEqual(
					repeatedOrder,
					postorder(repeated.roots, (node) => inputsOf(node))
				)
				for (const node of [...order, ...repeatedOrder]) {
					if (inputsOf(node).length < edgesOf(node).length) {
						c.note("a node reading one input twice")
					}
					if (node.kind === "MatchRegion") {
						const spread = [
							...Arr.flatMap(node.occurrences, (o) => Arr.map(o.constants, (k) => k.expr)),
							...Arr.map(node.correlated, (k) => k.expr)
						]
						assert.deepEqual(exprsOf(node), spread, `${node.id}'s expressions`)
						if (spread.length > 0) {
							c.note("a region of expressions")
						}
					}
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the postorder over each node's distinct inputs, and a region's expressions as the spread before"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/dag.ts",
				original: "\tpostorder(dag.roots, (node) => edgesOf(node))",
				replacement: "\tpostorder(dag.roots, (node) => inputsOf(node))",
				why: "The walk builds each node's distinct inputs again, as before it walked the edges: inputsOf is called for every node, and the count fails."
			}
		]
	})

/**
 * Traversals of generated DAGs handle a chain of any depth, past what the call stack holds, at every entry point.
 *
 * Budget: 6 runs and 12 steered cases, what its suite stated before it became a property (test/unit/ir/dag.test.ts:316
 * at 8cad5bce, its runs and its coverage's cases).
 */
export const traversalsOfGeneratedDAGsHandleAChainOfAnyDepthPastWhatTheCallStackHoldsAtEveryEntryPoint =
	property.explore(chainDepth, {
		needs: {},
		budget: { runs: 6, steered: 12 },
		situations: [
			"a chain a recursion holds",
			"a chain past a small stack's recursion"
		] satisfies ReadonlyArray<Reached<ChainFeature>>,
		check: (_, c: Case<ChainFeature>) => (depth) =>
			Effect.sync(() => {
				c.note(
					depth > smallStackRecursion
						? "a chain past a small stack's recursion"
						: "a chain a recursion holds"
				)
				const b = new DagBuilder(makeIdSupply())
				const pred = b.expr({
					kind: "literal",
					value: { kind: "bool", value: true },
					args: [],
					type: scalarTypes.bool,
					nonNull: "literal"
				})
				let last = b.node({
					kind: "InputSet",
					input: { kind: "declared", param: ParamId("p") },
					heading: heading(["a", scalarTypes.int8]),
					loc: undefined,
					meta: conservativeMeta
				})
				for (let i = 0; i < depth; i++) {
					last = b.node({
						kind: "Filter",
						input: last,
						pred,
						heading: heading(["a", scalarTypes.int8]),
						loc: undefined,
						meta: conservativeMeta
					})
				}
				const built = b.build([last])
				assert.equal(topoOrder(built).length, depth + 1)
				assert.deepEqual(last.meta.paramDeps, [ParamId("p")])
				validateDag(built)
				const normal = succeeded(normalizeDag(built))
				assert.equal(Rec.size(normal.nodes), depth + 1)
				const below = new Fold<RelNode, number>(function* (node) {
					let deepest = 0
					for (const input of inputsOf(node)) {
						const under: number = yield input
						deepest = Math.max(deepest, under + 1)
					}
					return deepest
				})
				assert.equal(below.of(last), depth)
				assert.equal(nodeScopes().of(last).outer.size, 0)
				const cells: Array<Cell> = []
				const cellOf = cellTable(built.roots, (cell) => cells.push(cell))
				const finished = succeeded(
					finishCells(built.roots, (root) => defined(cellOf.get(root), "a root's cell"), new Map())
				)
				assert.equal(cells.length, depth + 1)
				assert.equal(
					succeeded(dagDigest(finished.dag, "dag", new DagTemplates("derivation"))),
					succeeded(dagDigest(built, "dag", new DagTemplates("derivation")))
				)
				assert.equal(
					topoOrder(
						mergeDags(mergeDags(emptyDag, built, () => undefined).dag, built, () => undefined).dag
					).length,
					2 * (depth + 1)
				)
			}),
		oracle: {
			kind: "specification",
			name: "the chain's own construction: its depth, its one parameter and its one root"
		},
		kept: [],
		kills: [
			{
				file: "packages/text/src/base/graph.ts",
				original:
					"\tfor (const root of roots) {\n\t\tif (seen.has(root)) {\n\t\t\tcontinue\n\t\t}\n\t\tseen.add(root)\n\t\tconst stack: Array<{ readonly vertex: V; readonly inputs: ReadonlyArray<V>; next: number }> = [\n\t\t\t{ vertex: root, inputs: inputs(root), next: 0 }\n\t\t]\n\t\tfor (let frame = stack.at(-1); frame !== undefined; frame = stack.at(-1)) {\n\t\t\tconst input = frame.inputs[frame.next]\n\t\t\tif (input === undefined) {\n\t\t\t\tstack.pop()\n\t\t\t\torder.push(frame.vertex)\n\t\t\t\tcontinue\n\t\t\t}\n\t\t\tframe.next++\n\t\t\tif (!seen.has(input)) {\n\t\t\t\tseen.add(input)\n\t\t\t\tstack.push({ vertex: input, inputs: inputs(input), next: 0 })\n\t\t\t}\n\t\t}",
				replacement:
					"\tconst visit = (vertex: V): void => {\n\t\tif (seen.has(vertex)) {\n\t\t\treturn\n\t\t}\n\t\tseen.add(vertex)\n\t\tfor (const input of inputs(vertex)) {\n\t\t\tvisit(input)\n\t\t}\n\t\torder.push(vertex)\n\t}\n\tfor (const root of roots) {\n\t\tvisit(root)",
				why: "postorder recurses, so a chain past a small stack's recursion overflows it; the deep chain's property fails."
			}
		]
	})

/**
 * ValidateDag over a DAG of direct references refuses two distinct nodes, or two distinct expressions, under one
 * label, wherever they stand.
 *
 * Budget: 100 runs and 100 steered cases, what its suite stated before it became a property
 * (test/unit/ir/dag.test.ts:424 at 8cad5bce, its runs and its coverage's cases).
 */
export const validateDagOverADAGOfDirectReferencesRefusesTwoDistinctNodesOrTwoDistinctExpressionsUnderOneLabelWhereverTheyStand =
	property.explore(
		(source) =>
			[
				source.draw(labelled),
				source.draw(boolean),
				source.draw(pickGen),
				source.draw(pickGen)
			] as const,
		{
			needs: {},
			budget: { runs: 100, steered: 100 },
			situations: ["two nodes", "two expressions"] satisfies ReadonlyArray<Reached<Clash>>,
			check:
				(_, c: Case<Clash>) =>
				([d, overExprs, first, second]) =>
					Effect.sync(() => {
						const twoOf = <A>(pool: ReadonlyArray<A>): Option.Option<readonly [A, A]> => {
							if (!Arr.isReadonlyArrayNonEmpty(pool)) {
								return Option.none()
							}
							const kept = pickFrom(pool, first)
							const rest = Arr.filter(pool, (x) => x !== kept)
							return Arr.isReadonlyArrayNonEmpty(rest)
								? Option.some([kept, pickFrom(rest, second)] as const)
								: Option.none()
						}
						const exprPair = twoOf(exprsIn(d))
						const nodePair = twoOf(topoOrder(d))
						const clashExprs = ([kept, relabelled]: Option.Option.Value<typeof exprPair>) => {
							c.note("two expressions")
							const clashed = replacedExpr(d, relabelled, builtExpr(relabelled, kept.id))
							assert.deepEqual(refusalLoc(refused(toTable(clashed), "MalformedDescription")).path, [
								"exprs",
								kept.id
							])
							throwsDefect(() => validateDag(clashed))
						}
						const clashNodes = ([kept, relabelled]: Option.Option.Value<typeof nodePair>) => {
							c.note("two nodes")
							const clashed = replacedNode(d, relabelled, relNode(kept.id, relabelled))
							assert.deepEqual(refusalLoc(refused(toTable(clashed), "MalformedDescription")).path, [
								"nodes",
								kept.id
							])
							throwsDefect(() => validateDag(clashed))
						}
						if (overExprs && Option.isSome(exprPair)) {
							clashExprs(exprPair.value)
							return
						}
						if (Option.isSome(nodePair)) {
							clashNodes(nodePair.value)
							return
						}
						if (Option.isSome(exprPair)) {
							clashExprs(exprPair.value)
							return
						}
						c.note("a DAG holding no two of a kind")
					}),
			oracle: { kind: "specification", name: "one node and one expression per label" },
			kept: [],
			kills: [
				{
					file: "packages/engine/src/ir/expr.ts",
					original:
						"\tconst seen = new Set<ScalarExpr>()\n\tconst queue = [...roots]\n\tfor (const e of queue) {\n\t\tif (seen.has(e)) {\n\t\t\tcontinue\n\t\t}\n\t\tseen.add(e)\n\t\tappendAll(queue, e.args)\n\t}\n\treturn [...seen]",
					replacement:
						"\tconst seen = new Map<ExprId, ScalarExpr>()\n\tconst queue = [...roots]\n\tfor (const e of queue) {\n\t\tif (seen.has(e.id)) {\n\t\t\tcontinue\n\t\t}\n\t\tseen.set(e.id, e)\n\t\tappendAll(queue, e.args)\n\t}\n\treturn [...seen.values()]",
					why: "exprClosure takes two expressions under one label as one, so their clash is never refused; the label property fails."
				}
			]
		}
	)

/**
 * DagDigest ignores allocation order, label spelling and source locations.
 *
 * Budget: 200 runs and 100 steered cases, what its suite stated before it became a property
 * (test/unit/ir/dag.test.ts:515 at 8cad5bce, its runs and its coverage's cases).
 */
export const dagDigestIgnoresAllocationOrderLabelSpellingAndSourceLocations = property.explore(
	(source) => ({
		invariance: source.draw(element(invariances)),
		d: source.draw(labelled),
		burn: source.draw(
			array(element(["node", "expr", "var", "occurrence", "scope"] as const), {
				min: 0,
				max: 40
			})
		),
		salt: source.draw(string(codePoint(0x20, 0x7e), { min: 0, max: 4 }))
	}),
	{
		needs: {},
		budget: { runs: 200, steered: 100 },
		situations: invariances satisfies ReadonlyArray<Reached<Invariance>>,
		check:
			(_, c: Case<Invariance>) =>
			({ invariance, d, burn, salt }) =>
				Effect.sync(() => {
					c.note(invariance)
					switch (invariance) {
						case "a supply advanced": {
							const supply = makeIdSupply()
							for (const kind of burn) {
								supply[kind]()
							}
							assert.equal(
								succeeded(dagDigest(everyKind(supply).dag, "dag", new DagTemplates("derivation"))),
								digest
							)
							return
						}
						case "labels respelled": {
							const other = respelled(
								d,
								(label) => `x${salt}${Arr.join(Arr.reverse(Str.split(label, "")), "")}`
							)
							validateDag(other)
							assert.equal(
								succeeded(dagDigest(other, "dag", new DagTemplates("derivation"))),
								succeeded(dagDigest(d, "dag", new DagTemplates("derivation")))
							)
							return
						}
						case "a location moved": {
							const nodes = topoOrder(d)
							assert.ok(Arr.isReadonlyArrayNonEmpty(nodes), "a DAG has a node")
							const moved = c.draw(element(nodes))
							const withLoc = replacedNode(
								d,
								moved,
								relNode(moved.id, { ...moved, loc: SourceLoc("moved", ["a"]) })
							)
							assert.equal(
								succeeded(dagDigest(withLoc, "dag", new DagTemplates("derivation"))),
								succeeded(dagDigest(d, "dag", new DagTemplates("derivation")))
							)
							return
						}
					}
				}),
		oracle: {
			kind: "universal",
			name: "the digest is a function of the DAG's meaning: a rewrite that changes none of it keeps it"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/dag-digest.ts",
				original: "\t\tconst text = writeTemplate(form, { omit: omitSourceLocs }, (scalar) => {",
				replacement: "\t\tconst text = writeTemplate(form, { omit: () => false }, (scalar) => {",
				why: "The DAG digest reads source locations; the digest's invariance property fails on a location moved."
			}
		]
	}
)

/**
 * DagDigest changes with any semantic change.
 *
 * Budget: 100 runs and 100 steered cases, what its suite stated before it became a property
 * (test/unit/ir/dag.test.ts:585 at 8cad5bce, its runs and its coverage's cases).
 */
export const dagDigestChangesWithAnySemanticChange = property.explore(labelled, {
	needs: {},
	budget: { runs: 100, steered: 100 },
	situations: ["a literal changed", "another domain", "the roots reversed"] satisfies ReadonlyArray<
		Reached<Change>
	>,
	check: (_, c: Case<Change>) => (d) =>
		Effect.sync(() => {
			const digest = succeeded(dagDigest(d, "dag", new DagTemplates("derivation")))
			c.note("another domain")
			assert.notEqual(
				succeeded(dagDigest(d, "other-domain", new DagTemplates("derivation"))),
				digest
			)
			const changed = Arr.findFirst(exprsIn(d), (e) =>
				Option.map(changedLiteral(e), (value) => ({ e, value }))
			)
			if (Option.isSome(changed)) {
				c.note("a literal changed")
				const edited = replacedExpr(d, changed.value.e, changed.value.value)
				assert.notEqual(succeeded(dagDigest(edited, "dag", new DagTemplates("derivation"))), digest)
			}
			if (new Set(d.roots).size > 1) {
				c.note("the roots reversed")
				assert.notEqual(
					succeeded(
						dagDigest({ roots: Arr.reverse([...d.roots]) }, "dag", new DagTemplates("derivation"))
					),
					digest
				)
			}
		}),
	oracle: {
		kind: "universal",
		name: "a changed literal, another domain or the roots reordered is another DAG"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/ir/dag-digest.ts",
			original: "\t\treturn Result.flatMap(fingerprintDomain(domain), (line) => {",
			replacement: '\t\treturn Result.flatMap(fingerprintDomain("dag"), (line) => {',
			why: "The DAG digest ignores its domain; the digest's change property fails on another domain."
		}
	]
})

/**
 * NormalizeDag renames positionally, ignores label spelling, and gives a table the re-reader accepts.
 *
 * Budget: 100 runs and 100 steered cases, what its suite stated before it became a property
 * (test/unit/ir/dag.test.ts:794 at 8cad5bce, its runs and its coverage's cases).
 */
export const normalizeDagRenamesPositionallyIgnoresLabelSpellingAndGivesATableTheReReaderAccepts =
	property.explore(
		(source) =>
			[
				source.draw(
					weighted([
						[1, constant(dag)],
						[4, generatedDags]
					])
				),
				source.draw(string(codePoint(0x20, 0x7e), { min: 0, max: 3 }))
			] as const,
		{
			needs: {},
			budget: { runs: 100, steered: 100 },
			situations: ["several roots", "a shared input"] satisfies ReadonlyArray<
				Reached<NormalFeature>
			>,
			check:
				(_, c: Case<NormalFeature>) =>
				([d, salt]) =>
					Effect.sync(() => {
						if (new Set(d.roots).size > 1) {
							c.note("several roots")
						}
						const inputs = Arr.flatMap(topoOrder(d), (node) => inputsOf(node))
						if (new Set(inputs).size < inputs.length) {
							c.note("a shared input")
						}
						const normal = succeeded(normalizeDag(d))
						validateTable(normal)
						unorderedEqual<string>(Rec.keys(normal.nodes), positional("n", Rec.size(normal.nodes)))
						unorderedEqual<string>(Rec.keys(normal.exprs), positional("e", Rec.size(normal.exprs)))
						assert.equal(normal.roots[0], NodeId("n#0"))
						const other = succeeded(normalizeDag(respelled(d, (label) => `${salt}~${label}`)))
						assert.equal(
							succeeded(encode(other, everyProperty)),
							succeeded(encode(normal, everyProperty))
						)
					}),
			oracle: {
				kind: "universal",
				name: "the normal form is positional, the same however the DAG's labels are spelled"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/ir/dag-digest.ts",
					original: "\t\tconst index = this.#indices.size\n",
					replacement: "\t\tconst index = this.#indices.size + 1\n",
					why: "The normal form's positional names are counted from one; the normal form property fails."
				}
			]
		}
	)

/** NormalizeDag ignores the allocation order of a region's variables, and finds them free in the child that reads them. */
export const normalizeDagIgnoresTheAllocationOrderOfARegionsVariablesAndFindsThemFreeInTheChildThatReadsThem =
	property.exhaust(finite(boolean), {
		needs: {},
		situations: ["y allocated first"] satisfies ReadonlyArray<Reached<"y allocated first">>,
		check: (_, c: Case<"y allocated first">) => (yFirst) =>
			Effect.sync(() => {
				if (yFirst) {
					c.note("y allocated first")
				}
				const { dag: d, child, vars } = build(yFirst)
				assert.equal(
					succeeded(dagDigest(d, "dag", new DagTemplates("derivation"))),
					succeeded(dagDigest(reference, "dag", new DagTemplates("derivation")))
				)
				assert.equal(
					succeeded(encode(succeeded(normalizeDag(d)), everyProperty)),
					succeeded(encode(succeeded(normalizeDag(reference)), everyProperty))
				)
				unorderedEqual(freeVars(nodesByLabel(d), nodeScopes().of(child)), vars)
				assert.equal(nodeScopes().of(defined(d.roots[0])).outer.size, 0)
			}),
		oracle: {
			kind: "universal",
			name: "allocation order is no part of the digest or the normal form, and the child's free variables are the region's"
		},
		box: "both allocation orders of a region's two variables, read by a child correlated to both",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/dag.ts",
				original: "\t\t\t\tnode.vars.filter((v) => columns.has(v.name)).map((v) => v.id)",
				replacement:
					"\t\t\t\tnode.vars.filter((v) => columns.has(v.name)).slice(0, 1).map((v) => v.id)",
				why: "A region's free variables are its first alone; the region variables' property fails."
			}
		]
	})

/** NormalizeDag gives one digest to DAGs whose domain predicates were allocated differently. */
export const normalizeDagGivesOneDigestToDAGsWhoseContractPredicatesWereAllocatedDifferently =
	property.exhaust(
		finite(
			(source) =>
				[
					source.draw(map(shuffled(pool, { min: 3, max: 3 }), (spelling) => spellingOf(spelling))),
					source.draw(int(0, 3))
				] as const
		),
		{
			needs: { buildNeed },
			situations: ["an advanced supply", "a spelling not in normal form"] satisfies ReadonlyArray<
				Reached<"an advanced supply" | "a spelling not in normal form">
			>,
			check:
				({ buildNeed }, c: Case<"an advanced supply" | "a spelling not in normal form">) =>
				([[root, value, zero], advance]) =>
					Effect.gen(function* () {
						const { build, reference } = yield* buildNeed
						return yield* Effect.sync(() => {
							const spelled = predicate(root, value, zero)
							const supply = makeIdSupply()
							for (let i = 0; i < advance * 3; i++) {
								supply.expr()
							}
							if (advance > 0) {
								c.note("an advanced supply")
							}
							assert.equal(
								succeeded(
									dagDigest(
										build(cents(succeeded(normalizeExprTable(spelled))), supply),
										"dag",
										new DagTemplates("derivation")
									)
								),
								reference
							)
							const normal = succeeded(normalizeExprTable(spelled))
							if (
								normal.root !== spelled.root ||
								Arr.some(Rec.keys(normal.exprs), (id) => !Rec.has(spelled.exprs, id))
							) {
								c.note("a spelling not in normal form")
								assert.equal(
									fail(
										decodeScalarType({
											...scalarTypes.cents,
											contract: { ...defined(scalarTypes.cents.contract), predicate: spelled }
										})
									).reason._tag,
									"MalformedDescription"
								)
							}
						})
					}),
			oracle: {
				kind: "universal",
				name: "a predicate's digest is its normal form's, and a spelling not in normal form is refused at decode"
			},
			box: "every spelling of the predicate's three entries by distinct identifiers of the pool, under a supply advanced 0 to 3 steps",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/ir/expr.ts",
					original: `\tfor (const [i, id] of order.entries()) {\n\t\tif (id !== normalName(i)) {\n\t\t\tproblems.push(\n\t\t\t\t\`a predicate in normal form: \${id} is e#\${i}, numbered from the root breadth-first\`\n\t\t\t)\n\t\t}\n\t}\n`,
					replacement: "",
					why: "predicateProblems no longer checks a predicate's normal form, so a spelling not in it decodes; the contract allocation property fails."
				}
			]
		}
	)
