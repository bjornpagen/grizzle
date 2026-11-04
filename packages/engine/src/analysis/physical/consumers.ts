import {
	isUnique,
	type PhysicalProps,
	type Realization
} from "#compiler/analysis/physical/props.ts"
import { appendAll } from "#compiler/core/array.ts"
import type { ConsumerSensitivity } from "#compiler/ir/multiplicity.ts"
import type { KeySet, RelDag, RelNode } from "#compiler/ir/rel.ts"

/**
 * The role an input plays for the node that consumes it.
 *
 * A recursive relation realized with UNION ALL, consuming its own feedback.
 */
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
	| "feedback"

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
 * admitted fold, a bound, pagination, row numbering, top-k selection, recursive feedback under UNION ALL, a delivered
 * attachment, the program's public result). Folds observe without exception: MIN and MAX
 * tolerating repeats is no reason to infer the same of COUNT, SUM or AVG.
 *
 * A preserving consumer that is itself realized with an exact duplicate-eliminating operator absorbs its inputs'
 * repeats, so its edges are effectively ignoring. An observing edge states the heading its consumer needs distinct: the
 * complete bound tuple B for a fold, the whole input heading otherwise.
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

/** Why an observing or ignoring consumer treats repeats as it does; a constant phrase. */
export type ObservationWhy =
	| "passes repeats on"
	| "exact deduplication absorbs repeats"
	| "existence is an emptiness test"
	| "a set operator absorbs repeats"
	| "an aggregate fold counts every row"
	| "grouping without aggregates collapses repeats"
	| "an ordered-set aggregate reads every row"
	| "a window function numbers or folds every row"
	| "a bound selects among rows"
	| "a candidate bound selects among rows"
	| "recursive UNION removes repeated states"
	| "recursive feedback under UNION ALL repeats states"
	| "an ALL form counts the other side's repeats"
	| "an ALL difference subtracts per copy"
	| "the unique other side caps an ALL form"
	| "a delivered attachment is a set per parent"
	| "a law's violation query is tested for emptiness"
	| "the program's result is a public set"

/** A preserving edge's consumer is a node: the program's result observes or ignores its roots. */
interface EdgeOf<S extends ConsumerSensitivity, C extends Consumer> {
	readonly consumer: C
	readonly input: RelNode
	/** The treatment the consumer's kind gives the input. */
	readonly declared: ConsumerSensitivity
	/** The treatment once the consumer's own realization is accounted for. */
	readonly sensitivity: S
	readonly why: ObservationWhy
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
 * The edges of one consumer, in structural order.
 *
 * Seed and step rows unique on their own do not make the feedback unique: a state reached again
 * in a later iteration repeats, and a cyclic graph never terminates. The compiler
 * applies no UNION ALL elision to recursive feedback, so nothing discharges this edge.
 */
const consumerEdges = (node: RelNode, env: ClassifyEnv): ReadonlyArray<ConsumerEdge> => {
	/** A preserving consumer realized with an exact duplicate-eliminating operator absorbs its input's repeats. */
	const by = (role: InputRole): NodeConsumer => ({ kind: "node", node, role })
	const pass = (input: RelNode, role: InputRole): ConsumerEdge => {
		const fields = { consumer: by(role), input, declared: "preserves" as const }
		return env.realization(node) === "distinct"
			? { ...fields, sensitivity: "ignores", why: "exact deduplication absorbs repeats" }
			: { ...fields, sensitivity: "preserves", why: "passes repeats on" }
	}
	/** An observing consumer that needs `requires` distinct. */
	const observeOn = (
		input: RelNode,
		role: InputRole,
		why: ObservationWhy,
		requires: KeySet
	): ConsumerEdge => ({
		consumer: by(role),
		input,
		declared: "observes",
		sensitivity: "observes",
		requires,
		why
	})
	/** An observing consumer that needs its whole input heading distinct. */
	const observe = (input: RelNode, role: InputRole, why: ObservationWhy): ConsumerEdge =>
		observeOn(input, role, why, heading(env.props(input)))
	const ignore = (input: RelNode, role: InputRole, why: ObservationWhy): ConsumerEdge => ({
		consumer: by(role),
		input,
		declared: "ignores",
		sensitivity: "ignores",
		why
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
			return node.occurrences.map((o) => pass(o.source, "occurrence"))
		case "Filter":
		case "ProjectSet":
		case "OrderedResult":
		case "Produce":
			return [pass(node.input, "input")]
		case "SemiJoin":
		case "AntiJoin":
			return [
				pass(node.left, "left"),
				ignore(node.right, "right", "existence is an emptiness test")
			]
		case "Union":
			return node.groups.flatMap((g) => g.arms.map((a) => pass(a, "arm")))
		case "Intersect":
		case "Difference": {
			if (env.realization(node) === "distinct") {
				return [
					ignore(node.left, "left", "a set operator absorbs repeats"),
					ignore(node.right, "right", "a set operator absorbs repeats")
				]
			}
			/**
			 * The internal ALL forms: with a physically unique left input, multiset intersection and difference give
			 * the same 0/1 per tuple even when the right repeats. INTERSECT ALL keeps min(l, r) copies: a unique side
			 * caps the other's repeats, and otherwise the repeats pass on. EXCEPT ALL keeps max(l - r, 0) copies, so a
			 * repeated left row survives a match ({t, t} EXCEPT ALL {t} is {t}, where the set difference is empty):
			 * left repeats change which rows are present, and only a unique left makes the right's ignorable.
			 */
			const leftUnique = isUnique(env.props(node.left))
			const rightUnique = isUnique(env.props(node.right))
			if (node.kind === "Intersect") {
				return [
					rightUnique
						? ignore(node.left, "left", "the unique other side caps an ALL form")
						: pass(node.left, "left"),
					leftUnique
						? ignore(node.right, "right", "the unique other side caps an ALL form")
						: pass(node.right, "right")
				]
			}
			return [
				observe(node.left, "left", "an ALL difference subtracts per copy"),
				ignore(node.right, "right", "the unique other side caps an ALL form")
			]
		}
		case "Take":
			return [observe(node.input, "input", "a bound selects among rows")]
		case "Group":
			return node.aggs.length === 0
				? [ignore(node.input, "input", "grouping without aggregates collapses repeats")]
				: [observeOn(node.input, "input", "an aggregate fold counts every row", node.bound)]
		case "OrderedSetAggregate":
			return [observe(node.input, "input", "an ordered-set aggregate reads every row")]
		case "Window":
			return [observe(node.input, "input", "a window function numbers or folds every row")]
		case "Recursive":
			return env.realization(node) === "distinct"
				? [
						ignore(node.base, "base", "recursive UNION removes repeated states"),
						ignore(node.step, "step", "recursive UNION removes repeated states")
					]
				: [
						observe(node.base, "base", "recursive feedback under UNION ALL repeats states"),
						observe(node.step, "step", "recursive feedback under UNION ALL repeats states"),
						observe(node, "feedback", "recursive feedback under UNION ALL repeats states")
					]
		case "ApproximateNearest":
			return [observe(node.source, "source", "a candidate bound selects among rows")]
		case "Attach":
			return [
				pass(node.parent, "parent"),
				observe(node.child, "child", "a delivered attachment is a set per parent")
			]
		case "Forbid":
			return [
				ignore(node.violation, "violation", "a law's violation query is tested for emptiness")
			]
	}
}

/** The edge from the program's result to a root. */
const rootEdge = (root: RelNode, env: ClassifyEnv): ConsumerEdge => {
	const why: ObservationWhy =
		root.kind === "Forbid"
			? "a law's violation query is tested for emptiness"
			: "the program's result is a public set"
	const fields = { consumer: programResult, input: root, why }
	switch (rootSensitivity(env.roots, root)) {
		case "observes":
			return {
				...fields,
				declared: "observes",
				sensitivity: "observes",
				requires: heading(env.props(root))
			}
		case "ignores":
			return { ...fields, declared: "ignores", sensitivity: "ignores" }
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

/**
 * The nodes whose repeats reach an observing edge through preserving ones. Consumers come later than their inputs in
 * `order`, so one reverse pass decides every node.
 */
export const observedNodes = (
	order: ReadonlyArray<RelNode>,
	edges: ReadonlyArray<ConsumerEdge>
): ReadonlySet<RelNode> => {
	const into = new Map<RelNode, Array<ConsumerEdge>>()
	for (const e of edges) {
		into.set(e.input, [...(into.get(e.input) ?? []), e])
	}
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

interface ObservationStep {
	readonly consumer: Consumer
	readonly sensitivity: ConsumerSensitivity
	readonly why: ObservationWhy
}

/** At most this many observation paths are reported per node, for diagnostics. */
const observationPathBound = 8

/**
 * The observation paths from a node upward: each a chain of preserving steps ending in the first step that observes or
 * ignores, or in a preserving step at the result. Bounded, depth-first in edge order.
 */
export const observationPaths = (
	node: RelNode,
	edges: ReadonlyArray<ConsumerEdge>
): ReadonlyArray<ReadonlyArray<ObservationStep>> => {
	const into = new Map<RelNode, Array<ConsumerEdge>>()
	for (const e of edges) {
		into.set(e.input, [...(into.get(e.input) ?? []), e])
	}
	const paths: Array<ReadonlyArray<ObservationStep>> = []
	const walk = (
		at: RelNode,
		prefix: ReadonlyArray<ObservationStep>,
		seen: ReadonlySet<RelNode>
	) => {
		const out = into.get(at) ?? []
		if (out.length === 0 && prefix.length > 0 && paths.length < observationPathBound) {
			paths.push(prefix)
		}
		for (const e of out) {
			if (paths.length >= observationPathBound) {
				return
			}
			const step: ObservationStep = { consumer: e.consumer, sensitivity: e.sensitivity, why: e.why }
			const path = [...prefix, step]
			if (e.sensitivity !== "preserves" || seen.has(e.consumer.node)) {
				paths.push(path)
			} else {
				walk(e.consumer.node, path, new Set([...seen, e.consumer.node]))
			}
		}
	}
	walk(node, [], new Set([node]))
	return paths
}
