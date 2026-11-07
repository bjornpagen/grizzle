import { sameOrder } from "#compiler/core/array.ts"
import { catchRefusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import {
	assembledDag,
	edgeValues,
	nodeScopes,
	relNode,
	topoOrder,
	unchangedEdges
} from "#compiler/ir/dag.ts"
import { samePremise, strongest, type TemplateContext } from "#compiler/ir/evidence.ts"
import { drive, Fold } from "#compiler/ir/fold.ts"
import { type KeyProof, keyFactors, keyIn } from "#compiler/ir/keys.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import {
	type AttachDelivery,
	headingOrder,
	inputsOf,
	type KeySet,
	keptRefs,
	type MetaSpec,
	mapNode,
	mapRoots,
	metaSpecOf,
	type NodeOver,
	type RelDag,
	type RelNode,
	type Roots,
	type ValidDag,
	type ValueRefs
} from "#compiler/ir/rel.ts"
import { type ContainmentFact, delivery } from "#compiler/logical/attach.ts"
import type { OrderSubject } from "#compiler/logical/order.ts"
import {
	fixedColumns,
	logicalPropsOf,
	type Props,
	type PropsEnv,
	type PropsReading
} from "#compiler/logical/props.ts"

export interface LogicalEnv {
	/** The execution context the evidence must hold in. */
	readonly context: TemplateContext
	/** The containments the schema's laws establish, with their validity contexts (theory/theory.ts evidence). */
	readonly containments: ReadonlyArray<ContainmentFact>
	/**
	 * Whether a Base over a view is keyed by the keys the checker stamped on it (ir/rel.ts ViewBase view): a derived
	 * relation's inherited keys, a world relation's. Without them the checker's whole heading stands.
	 */
	readonly keyedViews: boolean
}

/**
 * The evidence the checker's own annotation rests on: a snapshot read with no containments and no inherited keys, so
 * every claim is the query's alone, its sources' declared keys, which each Base and Delta carries, included
 * (check/order.ts completes stated orders under it, and a restated DAG is annotated again under it). Other
 * environments name what they add to it.
 */
export const checkerEvidence: LogicalEnv = Object.freeze({
	context: "snapshot",
	containments: [],
	keyedViews: false
})

/**
 * The evidence a query's optimized artifact and its reader rest on: the checker's, with the keys of the views it reads,
 * so a Base over a derived relation is keyed by its view's unique indexes.
 */
export const queryEvidence: LogicalEnv = Object.freeze({ ...checkerEvidence, keyedViews: true })

/**
 * A node's logical properties, the node annotated with the metadata they summarize, and the node itself with its
 * attachments judged and nothing else restated (LogicalAnalysis judged).
 */
export interface Annotated {
	readonly props: Props
	readonly node: RelNode
	readonly judged: RelNode
}

/** The logical analysis of a DAG. */
export interface LogicalAnalysis<R extends Roots = Roots> {
	/** The DAG annotated: every node's logical metadata computed, every attachment's delivered type judged. */
	readonly dag: ValidDag<R>
	/**
	 * The DAG analyzed, nothing restated but each attachment's judged delivered type (rel.ts Attach judged): the
	 * analysis's judgment beside the claims the DAG states, which a lowering of it keeps.
	 */
	readonly judged: ValidDag<R>
	/**
	 * A node of the analyzed DAG (the one analyzeLogical was given): its properties, and its annotated counterpart in
	 * `dag`. An attachment's exclusive child's are its revision relative to the parent.
	 */
	readonly of: (node: RelNode) => Annotated
}

const sameKeySets = (a: ReadonlyArray<KeySet>, b: ReadonlyArray<KeySet>): boolean =>
	a === b ||
	(a.length === b.length &&
		a.every((k, i) => {
			const other = b[i]
			return other !== undefined && sameOrder(k, other)
		}))

/** Whether two proofs prove the same key at the same node, on the same premises in the same context. */
const sameProof = (k: KeyProof, other: KeyProof): boolean =>
	k.node === other.node &&
	k.context === other.context &&
	sameOrder(k.key, other.key) &&
	k.premises.length === other.premises.length &&
	k.premises.every((p, j) => {
		const q = other.premises[j]
		return q !== undefined && samePremise(p, q)
	})

/** Whether two key lists claim the same keys, each proof proving the same as the other's. */
const sameClaims = (a: ReadonlyArray<KeyProof>, b: ReadonlyArray<KeyProof>): boolean =>
	a === b ||
	(a.length === b.length &&
		a.every((k, i) => {
			const other = b[i]
			return other !== undefined && sameProof(k, other)
		}))

/** Whether two metadata records make the same claims: the structural fields are the constructor's, never claimed. */
const sameMeta = (a: MetaSpec, b: MetaSpec): boolean =>
	a.card === b.card && a.context === b.context && sameClaims(a.logicalKeys, b.logicalKeys)

/** The claims the analysis makes of a node: its proved keys, its cardinality and the context they hold in. */
const claimsOf = (props: Props): MetaSpec => ({
	logicalKeys: props.keys,
	card: props.card,
	context: props.context
})

/**
 * `node` claiming `meta`: the node itself when it already claims exactly that, so a node the analysis leaves as it was
 * stays the same object; otherwise the node rebuilt by the one constructor (ir/dag.ts relNode) under its label.
 */
const withClaims = (node: RelNode, meta: MetaSpec): RelNode =>
	sameMeta(node.meta, meta) ? node : relNode(node.id, { ...node, meta })

/** Every node's readers, counting the roots as readers: one per distinct input of each node the roots reach. */
const readers = (dag: RelDag): ReadonlyMap<RelNode, number> => {
	const count = new Map<RelNode, number>()
	for (const r of dag.roots) {
		count.set(r, (count.get(r) ?? 0) + 1)
	}
	for (const n of topoOrder(dag)) {
		for (const i of inputsOf(n)) {
			count.set(i, (count.get(i) ?? 0) + 1)
		}
	}
	return count
}

/**
 * The subject an order is completed over: a node's heading and evidence, with the discriminant of the heading groups
 * its rows are of. That is a logical property, so every node keeping a union's rows carries it: a take(k)
 * of a union may be ordered again, and its order is completed as the union's.
 */
export const orderSubjectOf = (
	node: RelNode,
	props: Props,
	/** Columns constant per evaluation besides the props' own, which break no tie: none for a delivered relation. */
	fixed: ReadonlyArray<string>,
	/** Which proofs the reading context admits: a page's, read in either context, only those holding in a transaction. */
	admits: (proof: KeyProof) => boolean
): OrderSubject => ({
	heading: node.heading,
	keys: props.keys.filter(admits).map(keyFactors),
	fixed: [...new Set([...fixed, ...fixedColumns(props)])],
	discriminant: props.discriminant,
	loc: SourceLoc(`node ${node.id}`, [])
})

/**
 * The node an annotation rebuilds from `body`, its reading with each input replaced by that input's annotated node and
 * whatever the annotation restates of its own fields, claiming `claims`: the node itself when its edges, its own fields
 * (`restated` false) and its claims are all as they were, so an unchanged part of the DAG stays the same objects.
 */
const rebuilt = (
	node: RelNode,
	body: NodeOver<ValueRefs<RelNode>>,
	restated: boolean,
	claims: MetaSpec
): RelNode =>
	!restated && unchangedEdges(node, body) && sameMeta(node.meta, claims)
		? node
		: relNode(node.id, { ...body, meta: claims })

/** The exclusive child `child`, whose annotation is `value`, revised to `relative` and recorded in `revised`; its node. */
const reviseChild = (
	revised: Map<RelNode, Annotated>,
	child: RelNode,
	value: Annotated,
	relative: Props
): RelNode => {
	const revision: Annotated = {
		props: relative,
		node: withClaims(value.node, claimsOf(relative)),
		judged: value.judged
	}
	revised.set(child, revision)
	return revision.node
}

class Annotator<R extends Roots> {
	readonly dag: ValidDag<R>
	readonly env: LogicalEnv

	constructor(dag: ValidDag<R>, env: LogicalEnv) {
		this.dag = dag
		this.env = env
	}

	run(): LogicalAnalysis<R> {
		const { env } = this
		const count = readers(this.dag)
		const scopes = nodeScopes(this.dag)
		const propsEnv: PropsEnv = {
			scope: (node) => scopes.of(node),
			keyedViews: env.keyedViews
		}
		/**
		 * An attachment's exclusive child, revised to its evidence relative to the parent once the attachment is folded:
		 * the attachment is its only reader, so the revision is the child the attachment's annotated node holds and the
		 * properties `of` reports for it. Traversal state of this one analysis, as the fold's memo is.
		 */
		const revised = new Map<RelNode, Annotated>()
		/** Each node's properties and annotated node, from its inputs' (ir/fold.ts). */
		const fold = new Fold<RelNode, Annotated>(function* (node) {
			const values = yield* edgeValues<Annotated>(node)
			const reading: PropsReading = drive(
				mapNode<ValueRefs<Annotated>, ValueRefs<Props>>(values, keptRefs),
				(a) => a.props
			)
			const inputs = drive(
				mapNode<ValueRefs<Annotated>, ValueRefs<RelNode>>(values, keptRefs),
				(a) => a.node
			)
			const twins = drive(
				mapNode<ValueRefs<Annotated>, ValueRefs<RelNode>>(values, keptRefs),
				(a) => a.judged
			)
			const unjudged = unchangedEdges(node, twins)
				? node
				: relNode(node.id, { ...twins, meta: metaSpecOf(node.meta) })
			const props = logicalPropsOf(node, reading, propsEnv)
			if (inputs.kind === "Base" && inputs.relationKind !== "relation") {
				const [primaryKey, ...keys] = (env.keyedViews ? inputs.view : []).map((k) => k.fields)
				const restated =
					primaryKey !== undefined &&
					!(sameOrder(inputs.primaryKey, primaryKey) && sameKeySets(inputs.keys, keys))
				const body = primaryKey !== undefined && restated ? { ...inputs, primaryKey, keys } : inputs
				return { props, node: rebuilt(node, body, restated, claimsOf(props)), judged: unjudged }
			}
			if (
				node.kind !== "Attach" ||
				reading.kind !== "Attach" ||
				inputs.kind !== "Attach" ||
				values.kind !== "Attach" ||
				twins.kind !== "Attach"
			) {
				return { props, node: rebuilt(node, inputs, false, claimsOf(props)), judged: unjudged }
			}
			/** The attachment's delivered shape rests on the child's evidence too. */
			const d = delivery(node, reading, {
				context: env.context,
				containments: env.containments
			})
			const exclusive = (count.get(node.child) ?? 0) === 1
			const childMeta = exclusive ? d.relative : reading.child
			const keyBound = childMeta.keys.some(
				(k) => keyIn(k, (c) => node.correlation.some((p) => p.child === c)) !== undefined
			)
			/**
			 * The delivery the child's recorded evidence supports: wider is always sound. Only a delivered array keeps an
			 * order, the one the checker completed (check/order.ts).
			 */
			const judged: AttachDelivery =
				d.delivered === "one" && childMeta.card === "one"
					? { delivered: "one", order: undefined }
					: d.delivered !== "array" && (childMeta.card !== "many" || keyBound)
						? { delivered: "option", order: undefined }
						: {
								delivered: "array",
								order: node.delivered === "array" ? node.order : headingOrder(node.child.heading)
							}
			const child = exclusive
				? reviseChild(revised, node.child, values.child, d.relative)
				: inputs.child
			/** Only an array's delivery holds an order of its own, so the delivered type alone says what is restated. */
			const restated = node.delivered !== judged.delivered
			const annotation: Props = { ...props, context: strongest([props.context, childMeta.context]) }
			return {
				props: annotation,
				node: rebuilt(node, { ...inputs, child, ...judged }, restated, claimsOf(annotation)),
				judged:
					twins.judged === judged.delivered
						? unjudged
						: relNode(node.id, { ...twins, judged: judged.delivered, meta: metaSpecOf(node.meta) })
			}
		})
		const dag = assembledDag(mapRoots(this.dag.roots, (root) => fold.of(root).node))
		const judged = assembledDag(mapRoots(this.dag.roots, (root) => fold.of(root).judged))
		return { dag, judged, of: (node) => revised.get(node) ?? fold.of(node) }
	}
}

/**
 * The DAG with every node's logical metadata computed and every attachment's delivered type judged; or the first refusal
 * (a derived relation's definition the environment's key provider refuses).
 */
export const analyzeLogical = <R extends Roots>(
	dag: ValidDag<R>,
	env: LogicalEnv
): Result.Result<LogicalAnalysis<R>, CompileError> =>
	catchRefusal(() => new Annotator(dag, env).run())

/**
 * `dag` with every node carrying the metadata `analysis` (of `dag`) computed for it, and the body `bodyOf` gives it: its
 * own, or the checker's completion of a stated order (check/order.ts). No other judgment of the analysis is taken, an
 * attachment's delivered type among them, so a reader of the logical metadata (a node's keys and cardinality) reads the
 * DAG it was given.
 */
export const withLogicalMeta = <R extends Roots>(
	dag: ValidDag<R>,
	analysis: LogicalAnalysis<R>,
	bodyOf: (node: RelNode) => RelNode
): ValidDag<R> => {
	const restated = new Fold<RelNode, RelNode>(function* (node) {
		const source = bodyOf(node)
		const body = yield* edgeValues<RelNode>(source)
		const annotated = analysis.of(node).node
		return source === node && annotated === node && unchangedEdges(node, body)
			? node
			: relNode(node.id, { ...body, meta: metaSpecOf(annotated.meta) })
	})
	return assembledDag(mapRoots(dag.roots, (root) => restated.of(root)))
}

/** A DAG with its attachments judged, and the counterpart there of each node of the DAG it was judged from. */
export interface JudgedDag<R extends Roots> {
	readonly dag: ValidDag<R>
	readonly of: (node: RelNode) => RelNode
}

/**
 * `dag`, a DAG an analysis restated, with every attachment's judged delivered type (rel.ts Attach judged) the delivered
 * type the analysis restated it to, and nothing else restated: a write's read-backs, which its lowering takes as their
 * analysis restated them, so that analysis judged each attachment's delivered type there.
 */
export const judgedAsDelivered = <R extends Roots>(dag: ValidDag<R>): JudgedDag<R> => {
	const judged = new Fold<RelNode, RelNode>(function* (node) {
		const body = yield* edgeValues<RelNode>(node)
		const meta = metaSpecOf(node.meta)
		if (body.kind === "Attach" && body.judged !== body.delivered) {
			return relNode(node.id, { ...body, judged: body.delivered, meta })
		}
		return unchangedEdges(node, body) ? node : relNode(node.id, { ...body, meta })
	})
	return {
		dag: assembledDag(mapRoots(dag.roots, (root) => judged.of(root))),
		of: (node) => judged.of(node)
	}
}

/**
 * annotate over a LogicalQuery.
 *
 * The normative logical metadata of a query DAG (rel.ts NodeMeta).
 *
 * annotate computes every node's logical keys, cardinality, determinism and required evidence context in one fold over
 * the DAG, each node from its inputs' (O(V + E) node visits), each key proof bounded (fds.ts), reading a lateral
 * source's outer references from its scope (ir/dag.ts nodeScopes). It then judges every attachment's delivered type from
 * its child's evidence relative to the parent (attach.ts), records that relative evidence as the child's metadata when
 * the attachment is the child's only reader ("inside an attachment, the parent's variables"). Orders are the checker's
 * to complete (check/order.ts), over the subject orderSubjectOf states. The structural fields, the parameters and
 * relations a node reads, are the one constructor's (ir/dag.ts relNode), computed again for every node it rebuilds. A
 * key the analysis claims carries its proof, which the key kernel checks where it is read.
 *
 * Evidence is admitted by the execution context the artifact is compiled for: a `snapshot` read may rest on lawful
 * committed-snapshot facts, a `transaction` read (one inside a write transaction, such as a read-back) only on immediate
 * ones, so a deferred containment never narrows an attachment there.
 */
export const annotateQuery = (
	query: LogicalQuery,
	env: LogicalEnv
): Result.Result<LogicalQuery, CompileError> =>
	Result.map(analyzeLogical(query.dag, env), (a) => ({ ...query, dag: a.dag }))
