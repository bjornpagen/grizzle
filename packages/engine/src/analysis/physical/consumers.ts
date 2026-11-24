import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import type { PhysicalProps, Realization } from "#compiler/analysis/physical/props.ts"
import { evaluatesCall } from "#compiler/ir/expr.ts"
import type { ConsumerSensitivity } from "#compiler/ir/multiplicity.ts"
import type { KeySet, RelDag, RelNode } from "#compiler/ir/rel.ts"

/** The role an input plays for the node that consumes it. */
export type InputRole =
	| "input"
	| "occurrence"
	| "left"
	| "right"
	| "arm"
	| "base"
	| "step"
	| "source"
	| "parent"
	| "child"
	| "violation"
	| "argument"

/** What consumes an input: a node, in one of its input roles, or the program's result at a root. */
export interface NodeConsumer {
	readonly kind: "node"
	readonly node: RelNode
	readonly role: InputRole
}

/**
 * Consumer classification: how each consumer treats repeats of each of its inputs.
 *
 * A consumer preserves repeats (it passes them on: a filter, a projection, a join, a concatenation, an ordering),
 * ignores them (they cannot change its result: an emptiness test, an exact set operator, a grouping without aggregates,
 * recursive UNION, a law's violation query), or observes them (they change its meaning: COUNT, SUM and every other
 * admitted fold, a bound, pagination, row numbering, top-k selection, a delivered attachment, the program's public
 * result). Folds observe without exception: MIN and MAX tolerating repeats is no reason to infer the same of COUNT,
 * SUM or AVG. INTERSECT, EXCEPT and the recursive UNION are always their set forms (dedup/policy.ts pins them), so
 * they ignore their inputs' repeats.
 *
 * A preserving consumer that is itself realized with an exact duplicate-eliminating operator absorbs its inputs'
 * repeats, so its edges are effectively ignoring. An observing edge states the heading its consumer needs distinct:
 * the whole input heading. A fold's bound tuple B is a key of its input (ir/rel.ts FoldInput), so its input distinct
 * over its heading holds exactly one row per B.
 *
 * A region's occurrence before a step observes its repeats: a step is read LATERAL after the occurrences before it, once
 * per row they deliver (ir/rel.ts Step, lower/conservative/step), so a repeat of one of them runs every step after it
 * again, and a chain of steps navigated from the rows a transaction wrote (analysis/theory/navigate.ts), or a whole
 * rule's step after the units it wrote (analysis/theory/unit.ts), reads each binding once only where the occurrences
 * before it are a set. A repeat changes no row of the region's result, but its work grows with the repeats, which a
 * rule's judge of a whole unit's write would square: the 37,578 rows a package writes of a node each deriving the
 * package's one fact, which the next step reads again for each.
 *
 * A projection that evaluates a declared function's call observes its input's repeats for the same reason (ir/expr.ts
 * evaluatesCall): it calls the function once per row of its input, so a repeat calls it again, and only over a set is
 * the function called once per distinct row: edullm compiles each pattern text of a package by xsd_compile, 63 texts
 * that 469,935 of one package's elements write.
 *
 * EXISTS is bounded: the right side of a semi- or anti-join is an emptiness test, but every
 * consumer below it still classifies its own inputs, so a bound, a grouping or a set difference under EXISTS observes
 * as it would anywhere. A node's repeats matter when some path from it upward through preserving edges reaches an
 * observing edge; that is the observation path the analysis proves or refutes, never a scan for DISTINCT keywords.
 * Validations are not consumers: a required validation is an unconditional statement of its own, never an EXISTS
 * target list side effect, so it never enters this graph.
 */
export type Consumer = NodeConsumer | { readonly kind: "result" }

const programResult: Consumer = Object.freeze({ kind: "result" })

/** The node consuming an input in `role`, if its consumer is one. */
export const consumerIn = (consumer: Consumer, role: InputRole): RelNode | undefined =>
	consumer.kind === "node" && consumer.role === role ? consumer.node : undefined

/**
 * The node a consumer's certificate names as its output: the consuming node, or the input itself at the program's
 * result.
 */
export const consumerOutput = (consumer: Consumer, input: RelNode): RelNode =>
	consumer.kind === "node" ? consumer.node : input

/** A preserving edge's consumer is a node: the program's result observes or ignores its roots. */
interface EdgeOf<S extends ConsumerSensitivity, C extends Consumer> {
	readonly consumer: C
	readonly input: RelNode
	/** The treatment the consumer gives the input, its own realization accounted for. */
	readonly sensitivity: S
}

/** An observing edge states the input columns its consumer needs distinct. */
export interface ObservingEdge extends EdgeOf<"observes", Consumer> {
	readonly requires: KeySet
}

export type ConsumerEdge =
	| ObservingEdge
	| EdgeOf<"preserves", NodeConsumer>
	| EdgeOf<"ignores", Consumer>

interface ClassifyEnv {
	readonly props: (node: RelNode) => PhysicalProps
	readonly realization: (node: RelNode) => Realization
	readonly roots: RootObservation
}

/**
 * How the program consumes its roots: a query's are its result, which it observes (a Forbid root is a law's emptiness
 * test, which it ignores); a write program observes none of its roots.
 */
export type RootObservation = "result" | "ignored"

const rootSensitivity = (roots: RootObservation, root: RelNode): "observes" | "ignores" => {
	switch (roots) {
		case "result":
			return root.kind === "Forbid" ? "ignores" : "observes"
		case "ignored":
			return "ignores"
	}
}

const heading = (props: PhysicalProps): KeySet => props.columns

/**
 * The edges of one consumer, in structural order. A consumer passes its input's repeats on unless its own realization
 * deduplicates them. Existence tests, set operators, grouping without aggregates and the recursive UNION ignore them;
 * bounds, aggregate folds, ordered-set aggregates, window functions, candidate bounds and a delivered attachment's
 * child, a set per parent, observe them.
 */
const consumerEdges = (node: RelNode, env: ClassifyEnv): ReadonlyArray<ConsumerEdge> => {
	/** A preserving consumer realized with an exact duplicate-eliminating operator absorbs its input's repeats. */
	const by = (role: InputRole): NodeConsumer => ({ kind: "node", node, role })
	const pass = (input: RelNode, role: InputRole): ConsumerEdge => {
		const fields = { consumer: by(role), input }
		return env.realization(node) === "distinct"
			? { ...fields, sensitivity: "ignores" }
			: { ...fields, sensitivity: "preserves" }
	}
	/** An observing consumer that needs its whole input heading distinct. */
	const observe = (input: RelNode, role: InputRole): ConsumerEdge => ({
		consumer: by(role),
		input,
		sensitivity: "observes",
		requires: heading(env.props(input))
	})
	const ignore = (input: RelNode, role: InputRole): ConsumerEdge => ({
		consumer: by(role),
		input,
		sensitivity: "ignores"
	})
	switch (node.kind) {
		case "Base":
		case "Closed":
		case "Context":
		case "InputSet":
		case "Delta":
		case "SelfRef":
			return []
		case "MatchRegion":
			return node.occurrences.map((o, at) =>
				node.occurrences.slice(at + 1).some((later) => later.source.kind === "Step")
					? observe(o.source, "occurrence")
					: pass(o.source, "occurrence")
			)
		case "ProjectSet":
			return [
				evaluatesCall(node.out.map((o) => o.expr))
					? observe(node.input, "input")
					: pass(node.input, "input")
			]
		case "Filter":
		case "OrderedResult":
		case "Produce":
		case "Step":
			return [pass(node.input, "input")]
		case "SemiJoin":
		case "AntiJoin":
			return [pass(node.left, "left"), ignore(node.right, "right")]
		case "Union":
			return node.groups.flatMap((g) => g.arms.map((a) => pass(a, "arm")))
		case "Intersect":
		case "Difference":
			return [ignore(node.left, "left"), ignore(node.right, "right")]
		case "Take":
			return [observe(node.input, "input")]
		case "Group":
			return node.aggs.length === 0 ? [ignore(node.input, "input")] : [observe(node.input, "input")]
		case "OrderedSetAggregate":
			return [observe(node.input, "input")]
		case "Window":
			return [observe(node.input, "input")]
		case "Recursive":
			return [ignore(node.base, "base"), ignore(node.step, "step")]
		case "ApproximateNearest":
			return [observe(node.source, "source")]
		case "Attach":
			return [pass(node.parent, "parent"), observe(node.child, "child")]
		case "Forbid":
			return [ignore(node.violation, "violation")]
		case "Call":
			return node.args.flatMap((a) => (a.kind === "rows" ? [observe(a.rows, "argument")] : []))
	}
}

/** The edge from the program's result to a root. */
const rootEdge = (root: RelNode, env: ClassifyEnv): ConsumerEdge => {
	const fields = { consumer: programResult, input: root }
	switch (rootSensitivity(env.roots, root)) {
		case "observes":
			return {
				...fields,
				sensitivity: "observes",
				requires: heading(env.props(root))
			}
		case "ignores":
			return { ...fields, sensitivity: "ignores" }
	}
}

/** Every edge of the DAG: each node's, then each root's, in the given node order. */
export const classifyEdges = (
	dag: RelDag,
	order: ReadonlyArray<RelNode>,
	env: ClassifyEnv
): ReadonlyArray<ConsumerEdge> => {
	const edges: Array<ConsumerEdge> = []
	for (const node of order) {
		appendAll(edges, consumerEdges(node, env))
	}
	for (const r of dag.roots) {
		edges.push(rootEdge(r, env))
	}
	return edges
}

/** Each node's outgoing consumer edges, in edge order. */
const edgesInto = (
	edges: ReadonlyArray<ConsumerEdge>
): ReadonlyMap<RelNode, ReadonlyArray<ConsumerEdge>> => {
	const into = new Map<RelNode, Array<ConsumerEdge>>()
	for (const e of edges) {
		into.getOrInsertComputed(e.input, () => []).push(e)
	}
	return into
}

/**
 * The nodes whose repeats reach an observing edge through preserving ones. Consumers come later than their inputs in
 * `order`, so one reverse pass decides every node.
 */
export const observedNodes = (
	order: ReadonlyArray<RelNode>,
	edges: ReadonlyArray<ConsumerEdge>
): ReadonlySet<RelNode> => {
	const into = edgesInto(edges)
	const observed = new Set<RelNode>()
	for (const node of order.toReversed()) {
		if (
			(into.get(node) ?? []).some(
				(e) =>
					e.sensitivity === "observes" ||
					(e.sensitivity === "preserves" && observed.has(e.consumer.node))
			)
		) {
			observed.add(node)
		}
	}
	return observed
}
