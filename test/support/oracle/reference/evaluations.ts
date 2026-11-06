import type { RelDag, RelNode } from "#compiler/ir/rel.ts"
import {
	type Bindings,
	Reference,
	type ReferenceInput,
	type RelationValue
} from "#test/support/oracle/reference/evaluate.ts"

/**
 * Every relation a reference evaluation computes, by node: a closed node's one set, and a correlated node's set for
 * each outer tuple it was evaluated under.
 *
 * Rule: an analysis claims a node's keys, cardinality and fixed columns relative to its parameters and to the outer
 * values a correlated node reads, so a claim about a correlated node is checked against every relation it denoted,
 * one per evaluation, and a claim about a closed node against its one set. A suite that checked closed nodes alone
 * would never see a lateral source, where a value fixed per outer row is mistaken for one fixed overall.
 */
class Evaluations {
	readonly #byNode = new Map<RelNode, Set<RelationValue>>()

	note(node: RelNode, relation: RelationValue): void {
		const known = this.#byNode.get(node)
		if (known === undefined) {
			this.#byNode.set(node, new Set([relation]))
		} else {
			known.add(relation)
		}
	}

	/** The relations a node denoted, one per evaluation; a closed node's set once. */
	of(node: RelNode): ReadonlyArray<RelationValue> {
		return [...(this.#byNode.get(node) ?? [])]
	}

	/** Whether a node was evaluated under more than one outer tuple. */
	correlated(node: RelNode): boolean {
		return (this.#byNode.get(node)?.size ?? 0) > 1
	}
}

/** The reference evaluator recording every evaluation. */
export class RecordingReference extends Reference {
	readonly evaluations = new Evaluations()

	/** The recording reference of a case: its DAG's closed sets settled, every evaluation recorded. */
	static recording(dag: RelDag, input: ReferenceInput): RecordingReference {
		return new RecordingReference(dag, input).settle()
	}

	override eval(node: RelNode, scope: Bindings): RelationValue {
		const relation = super.eval(node, scope)
		this.evaluations.note(node, relation)
		return relation
	}
}
