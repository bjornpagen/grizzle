import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import { encode, everyProperty, maxStringLength, unwrap } from "#compiler/core/canonical.ts"
import { sha256Hex } from "#compiler/core/sha256.ts"
import { wellFormed } from "#compiler/core/text.ts"
import { DagDigests, type DagTemplates } from "#compiler/ir/dag-digest.ts"
import { nodeShapes, nodesByLabel, relNode, topoOrder } from "#compiler/ir/dag.ts"
import { conservativeMeta, type NodeOf, type RelDag, type RelNode } from "#compiler/ir/rel.ts"

/**
 * The identity of a read's call, its evaluation key: the function and the arguments it is called at, the field it reads,
 * its heading and what an analysis claims of its rows left out, digested as a share key is but with every enclosing
 * node its arguments read named by its label (ir/dag-digest.ts DagDigests, labelled), so two reads of fields of one call at equal
 * arguments, its function immutable or stable, read one evaluation of it: two that read only parameters wherever they
 * stand, and two that read the same enclosing row, a region's, in that region.
 */
const evaluationDigest = (digests: DagDigests, node: NodeOf<"Call">): string => {
	const called = node.function
	if (called.kind !== "field") {
		defect("the evaluation key of a read of a field of a call")
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
	return unwrap(digests.digest([evaluation], "evaluation", "labelled"))
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
	/** The DAG's digests, each node's template read from the lowering's store (LowerContext templates). */
	readonly #digests: DagDigests
	readonly #shapes = nodeShapes()
	/** How many reads of the DAG are of each evaluation shape, to the second. */
	readonly #reads = new Map<string, 1 | 2>()
	readonly #keys = new Map<RelNode, string>()
	/**
	 * Each evaluation's digest by its identity (#identityOf): the reads of fields of one call at one argument tuple
	 * evaluate one evaluation, digested once for all of them, where each read's digest normalized and encoded the whole
	 * reach of its arguments again.
	 */
	readonly #evaluations = new Map<string, string>()
	/** A number for each argument node and expression an identity names, the object itself told apart. */
	readonly #numbers = new Map<object, number>()
	#digested = 0

	/** The keys of `dag`'s reads, every template read from `templates`. */
	constructor(dag: RelDag, templates: DagTemplates) {
		this.#digests = new DagDigests(() => nodesByLabel(dag), maxStringLength, templates)
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

	/** A read's digested key: its evaluation's, digested once for every read of it, each digest counted. */
	#digest(read: NodeOf<"Call">): string {
		const identity = this.#identityOf(read)
		const known = this.#evaluations.get(identity)
		if (known !== undefined) {
			return known
		}
		this.#digested += 1
		const key = evaluationDigest(this.#digests, read)
		this.#evaluations.set(identity, key)
		return key
	}

	/**
	 * What a read's evaluation is (evaluationDigest): the function it calls, by name, volatility and definition, and
	 * per argument in order its kind, its name, its type or columns as canonical text, and the very expression or node
	 * it passes, numbered by the object. Two reads of one identity build one evaluation, the field they read and their
	 * own label and heading left out, so they digest alike; two that differ in any of it may still digest alike, and
	 * are digested apart.
	 */
	#identityOf(read: NodeOf<"Call">): string {
		const called = read.function
		if (called.kind !== "field") {
			defect("the evaluation identity of a read of a field of a call")
		}
		const args = read.args.map((a) =>
			a.kind === "rows"
				? `rows\u0001${a.name}\u0001${this.#number(a.rows)}\u0001${unwrap(encode(a.columns, everyProperty))}`
				: `value\u0001${a.name}\u0001${this.#number(a.expr)}\u0001${unwrap(encode(a.type, everyProperty))}`
		)
		return [called.name, called.volatility, called.definition, ...args].join("\u0000")
	}

	/** The number of an argument's node or expression, given on its first read. */
	#number(part: object): number {
		return this.#numbers.getOrInsertComputed(part, () => this.#numbers.size)
	}

	/** How many reads' keys were digested, each a normalized, encoded reach: the keying's work. */
	get digested(): number {
		return this.#digested
	}

	/** A read's evaluation shape: its function and volatility, and each argument's kind, a rows argument's node's shape. */
	#shapeOf(read: NodeOf<"Call">): string {
		const called = read.function
		if (called.kind !== "field") {
			defect("the evaluation shape of a read of a field of a call")
		}
		const args = read.args.map((a) =>
			a.kind === "rows" ? `rows ${a.name} ${this.#shapes.of(a.rows)}` : `value ${a.name}`
		)
		return sha256Hex(
			wellFormed(`${called.name}\u0000${called.volatility}\u0000${args.join("\u0000")}`)
		)
	}
}
