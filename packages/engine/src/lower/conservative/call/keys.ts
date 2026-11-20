import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import { unwrap } from "#compiler/core/canonical.ts"
import { sha256Hex } from "#compiler/core/sha256.ts"
import { wellFormed } from "#compiler/core/text.ts"
import { nodeShapes, reachDigestWithin, relNode, topoOrder } from "#compiler/ir/dag.ts"
import { conservativeMeta, type NodeOf, type RelDag, type RelNode } from "#compiler/ir/rel.ts"

/**
 * The identity of a read's call, its evaluation key: the function and the arguments it is called at, the field it reads,
 * its heading and what an analysis claims of its rows left out, digested as a share key is but with every enclosing
 * node its arguments read named by its label (ir/dag.ts reachDigestWithin), so two reads of fields of one call at equal
 * arguments, its function immutable or stable, read one evaluation of it: two that read only parameters wherever they
 * stand, and two that read the same enclosing row, a region's, in that region.
 */
const evaluationDigest = (dag: RelDag, node: NodeOf<"Call">): string => {
	const called = node.function
	if (called.kind !== "field") {
		throw defect("the evaluation key of a read of a field of a call")
	}
	const evaluation = relNode(node.id, {
		...node,
		function: {
			kind: "declared",
			name: called.name,
			volatility: called.volatility,
			definition: called.definition
		},
		heading: [],
		meta: conservativeMeta
	})
	return unwrap(reachDigestWithin(dag, [evaluation], "evaluation"))
}

/**
 * The evaluation keys of the reads of fields of calls in one DAG, each computed where it can decide something: a read's
 * evaluation shape is the function it calls and its volatility, and per argument in order its kind and, a rows argument,
 * the shape of the node it passes (ir/dag.ts nodeShapes), a function of exactly what its evaluation key encodes, so two
 * reads of one key are of one evaluation shape. A read whose evaluation shape no other read of the DAG has is the only
 * read of its key, which no comparison of keys sees equal to another's: its key is its shape, tagged, and no digest of
 * it is taken. The reads of a shared shape are keyed by their digests (`evaluationDigest`), which decide what they
 * decided. Its work is linear in the DAG beside the digests of those reads, where every read's digest normalized and
 * encoded the whole reach of its arguments.
 */
export class EvaluationKeys {
	readonly #dag: RelDag
	readonly #shapes = nodeShapes()
	/** How many reads of the DAG are of each evaluation shape, to the second. */
	readonly #reads = new Map<string, 1 | 2>()
	readonly #keys = new Map<RelNode, string>()
	#digested = 0

	constructor(dag: RelDag) {
		this.#dag = dag
		for (const node of topoOrder(dag)) {
			if (node.kind === "Call" && node.function.kind === "field") {
				const shape = this.#shapeOf(node)
				this.#reads.set(shape, this.#reads.has(shape) ? 2 : 1)
			}
		}
	}

	/** The evaluation key of `read`, a read of a field of a call of the DAG. */
	of(read: NodeOf<"Call">): string {
		const known = this.#keys.get(read)
		if (known !== undefined) {
			return known
		}
		const shape = this.#shapeOf(read)
		const key = this.#reads.get(shape) === 1 ? `shape:${shape}` : this.#digest(read)
		this.#keys.set(read, key)
		return key
	}

	/** A read's digested key, counted. */
	#digest(read: NodeOf<"Call">): string {
		this.#digested += 1
		return evaluationDigest(this.#dag, read)
	}

	/** How many reads' keys were digested, each a normalized, encoded reach: the keying's work. */
	get digested(): number {
		return this.#digested
	}

	/** A read's evaluation shape: its function and volatility, and each argument's kind, a rows argument's node's shape. */
	#shapeOf(read: NodeOf<"Call">): string {
		const called = read.function
		if (called.kind !== "field") {
			throw defect("the evaluation shape of a read of a field of a call")
		}
		const args = read.args.map((a) =>
			a.kind === "rows" ? `rows ${a.name} ${this.#shapes.of(a.rows)}` : `value ${a.name}`
		)
		return sha256Hex(
			wellFormed(`${called.name}\u0000${called.volatility}\u0000${args.join("\u0000")}`)
		)
	}
}
