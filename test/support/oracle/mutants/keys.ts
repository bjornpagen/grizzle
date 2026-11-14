import { exact, set, structuralHash } from "@bjornpagen/testing/oracle"
import { Array as Arr, Option } from "effect"
import { appendAll, indices } from "#compiler/core/array.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import type { KeySet, NodeOf, RelDag, RelNode } from "#compiler/ir/rel.ts"
import { defined } from "#test/support/assert.ts"

/** The kinds whose conservative lowering ends in a DISTINCT core a mutant may remove. */
const distinctKinds: ReadonlySet<RelNode["kind"]> = new Set([
	"Base",
	"Closed",
	"InputSet",
	"MatchRegion",
	"Filter",
	"ProjectSet",
	"SemiJoin",
	"AntiJoin",
	"Take",
	"SelfRef"
])

export interface KeyOptions {
	/** Whether a projected expression over a key column counts as retaining it: the noninjective-expression mistake. */
	readonly expressionsRetain: boolean
}

/** The keys the installation enforces: a Base scan's declared keys, an expression over a key column retaining none. */
export const immediateKeys: KeyOptions = { expressionsRetain: false }

/** The drop rule of an analysis whose mutant removes no DISTINCT. */
export const neverDrops = (): boolean => false

/** Two keys are one key when they hold the same columns, in any order. */
const sameKey = (a: KeySet, b: KeySet): boolean => Option.isNone(set(structuralHash, exact)(a, b))

/** The keys with `key` among them, once. */
const withKey = (keys: ReadonlyArray<KeySet>, key: KeySet): ReadonlyArray<KeySet> =>
	Arr.some(keys, (k) => sameKey(k, key)) ? keys : [...keys, key]

/**
 * What the analysis finds for one node: the keys its rows have without its own DISTINCT, whether the mutant removes
 * that DISTINCT, and the keys its rows have in the mutated SQL.
 */
interface NodeKeys {
	readonly derived: ReadonlyArray<KeySet>
	readonly dropped: boolean
	readonly keys: ReadonlyArray<KeySet>
}

/**
 * Physical keys of the conservative output, the evidence a mutant reasons from.
 *
 * A mutant removes a DISTINCT, or turns UNION into UNION ALL, where its rule says the rows are already a set. The rule
 * is a claim about the SQL the conservative lowering emits once the mutant has rewritten it, so the analysis follows
 * that SQL node by node: the heading columns a node's rows are unique on, given which DISTINCTs the mutant removes.
 *
 * - A Base scan's rows are unique on its primary and candidate keys, and on nothing else.
 * - Filter keeps its input's keys; SemiJoin and AntiJoin keep the left input's.
 * - ProjectSet keeps a key whose every column it projects as a plain column; a function of a key
 *   column is not one, unless a mutant chooses to believe it is (I3).
 * - MatchRegion: its bindings are unique when every occurrence's source has a key whose columns are each bound to a
 *   variable or fixed to one value; the variables bound to those columns are then a key.
 * - Group is unique on its group key, an aggregate-only group on the empty key, at most one row.
 * - UNION, INTERSECT, EXCEPT, recursive UNION and a DISTINCT that stays are unique on the whole heading.
 *
 * The analysis runs once, when it is built: every node of the DAG in topological order, inputs before the nodes that
 * read them, the mutant's drop rule decided from each node's derived keys.
 */
export class KeyAnalysis {
	readonly dag: RelDag
	readonly options: KeyOptions
	readonly #nodes: ReadonlyMap<RelNode, NodeKeys>

	constructor(
		dag: RelDag,
		options: KeyOptions,
		drops: (node: RelNode, derived: ReadonlyArray<KeySet>) => boolean
	) {
		this.dag = dag
		this.options = options
		const nodes = new Map<RelNode, NodeKeys>()
		this.#nodes = nodes
		for (const node of topoOrder(dag)) {
			const derived = this.compute(node)
			const dropped = distinctKinds.has(node.kind) && drops(node, derived)
			const keys =
				distinctKinds.has(node.kind) && !dropped
					? withKey(
							derived,
							Arr.map(node.heading, (c) => c.name)
						)
					: derived
			nodes.set(node, { derived, dropped, keys })
		}
	}

	/** What the analysis found for a node of its DAG, which the topological walk reached before any node reading it. */
	#of(node: RelNode): NodeKeys {
		return defined(this.#nodes.get(node), `node ${node.id}, analysed before the nodes that read it`)
	}

	/** Whether the mutant removes this node's own DISTINCT. */
	dropped(node: RelNode): boolean {
		return this.#of(node).dropped
	}

	/** The keys of a node's rows in the mutated SQL. */
	keys(node: RelNode): ReadonlyArray<KeySet> {
		return this.#of(node).keys
	}

	/** The keys a node's rows have without its own DISTINCT. */
	derived(node: RelNode): ReadonlyArray<KeySet> {
		return this.#of(node).derived
	}

	compute(node: RelNode): ReadonlyArray<KeySet> {
		const heading = Arr.map(node.heading, (c) => c.name)
		switch (node.kind) {
			case "Base":
				return Arr.filter([node.primaryKey, ...node.keys], (k) =>
					Arr.every(k, (c) => heading.includes(c))
				)
			case "Filter":
				return this.keys(node.input)
			case "SemiJoin":
			case "AntiJoin":
				return this.keys(node.left)
			case "Attach":
				return this.keys(node.parent)
			case "OrderedResult":
				return this.keys(node.input)
			case "ProjectSet":
				return this.projected(node, this.options.expressionsRetain)
			case "MatchRegion":
				return this.regionKeys(
					node,
					Arr.map(indices(node.occurrences.length), (i) => i)
				)
			case "Group":
				return [node.keys]
			case "Union":
			case "Intersect":
			case "Difference":
			case "Recursive":
				return [heading]
			case "ApproximateNearest":
			case "Closed":
			case "Context":
			case "Delta":
			case "Forbid":
			case "InputSet":
			case "OrderedSetAggregate":
			case "Produce":
			case "SelfRef":
			case "Take":
			case "Window":
				return []
		}
	}

	/** The input columns an output expression is, or (with `loose`) reads. */
	sourceColumns(node: NodeOf<"ProjectSet">, e: ScalarExpr, loose: boolean): ReadonlyArray<string> {
		if (e.kind === "column") {
			return e.column.node === node.input.id ? [e.column.name] : []
		}
		if (!loose || e.kind !== "op") {
			return []
		}
		return Arr.flatMap(e.args, (a) => this.sourceColumns(node, a, true))
	}

	/** The input keys a projection keeps, renamed to its output names. */
	projected(node: NodeOf<"ProjectSet">, loose: boolean): ReadonlyArray<KeySet> {
		const none: ReadonlyArray<KeySet> = []
		return Arr.reduce(this.keys(node.input), none, (out, key) => {
			const mapped = Option.all(
				Arr.map(key, (column) =>
					Option.map(
						Arr.findFirst(node.out, (x) =>
							this.sourceColumns(node, x.expr, loose).includes(column)
						),
						(o) => o.name
					)
				)
			)
			return Option.isSome(mapped) ? withKey(out, [...new Set(mapped.value)]) : out
		})
	}

	/**
	 * The region key from the occurrences at `indices`: the variables bound to a retained key of each, or none when
	 * one of them retains no key.
	 */
	regionKeys(node: NodeOf<"MatchRegion">, positions: ReadonlyArray<number>): ReadonlyArray<KeySet> {
		const key: Array<string> = []
		for (const i of positions) {
			const o = node.occurrences[i]
			if (o === undefined) {
				return []
			}
			const retained = Arr.findFirst(this.keys(o.source), (k) =>
				Arr.every(
					k,
					(column) =>
						Arr.some(o.bindings, (b) => b.column === column) ||
						Arr.some(o.constants, (c) => c.column === column)
				)
			)
			if (Option.isNone(retained)) {
				return []
			}
			appendAll(
				key,
				Arr.flatMap(retained.value, (column) =>
					Option.match(
						Arr.findFirst(o.bindings, (x) => x.column === column),
						{
							onNone: () => [],
							onSome: (b) => [b.var.name]
						}
					)
				)
			)
		}
		return [[...new Set(key)]]
	}
}
