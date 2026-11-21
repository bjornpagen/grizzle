import { appendAll, sameOrder } from "@bjornpagen/grizzle-text/base/array"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { catchRefusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import {
	assembledDag,
	edgeValues,
	type NodeScope,
	relNode,
	scopesOver,
	unchangedEdges
} from "#compiler/ir/dag.ts"
import { strongest, type TemplateContext } from "#compiler/ir/evidence.ts"
import { drive, Fold } from "#compiler/ir/fold.ts"
import { type KeyProof, keyFactors, keyIn } from "#compiler/ir/keys.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import {
	type AttachDelivery,
	headingOrder,
	inputsOf,
	type KeySet,
	type MetaSpec,
	mapRoots,
	metaSpecOf,
	type NodeOver,
	type RelDag,
	type RelNode,
	type Roots,
	replacedEdges,
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

/**
 * Whether two key lists are the same proofs, each the very proof the other is. A proof is relative to the node holding
 * it (ir/keys.ts Implication), so one a rename or a rewrite carries to another node (rel.ts MetaSpec) may name that
 * node's occurrences and conjuncts no more: only the proof an analysis computes of a node holds of it, and a node whose
 * meta carries another is rebuilt with its own. A leaf's proofs are its relation's reading's (logical/props.ts
 * leafProps), one object however many analyses read it.
 */
const sameClaims = (a: ReadonlyArray<KeyProof>, b: ReadonlyArray<KeyProof>): boolean =>
	a === b || (a.length === b.length && a.every((k, i) => k === b[i]))

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

/**
 * How one analysis of a compile judged the attachments among the nodes it recorded of a shared sub-DAG (SharedAnalyses),
 * the nodes no earlier analysis had recorded: each child it held exclusive, the attachment its only reader, with the
 * child's revision relative to it, and each child it held read elsewhere too. The rest of a node's annotation is its
 * sub-DAG's and the environment's alone (a node's scope is a bottom-up fold, ir/dag.ts nodeScopes), so another analysis
 * reads the record's annotations exactly where it judges these children alike and reads the records below alike.
 *
 * The records partition the nodes recorded, each node its first record's: a record's own nodes are its root's sub-DAG
 * but the nodes of the records below it, which its own nodes read. So the readers of a node among the recorded nodes
 * of a DAG are the sum, over the records its recorded roots reach, of the readers each record's own nodes are (`reads`),
 * which no analysis walks the recorded nodes again to count.
 */
interface SharedRecord {
	readonly root: RelNode
	readonly exclusive: ReadonlyMap<RelNode, Annotated>
	readonly shared: ReadonlyArray<RelNode>
	/** How many of the record's own nodes read each node they read. */
	readonly reads: ReadonlyMap<RelNode, number>
	readonly below: ReadonlyArray<SharedRecord>
}

/** A recorded node: its annotation and scope as the analysis that recorded it computed them, and its record. */
interface SharedEntry {
	readonly annotated: Annotated
	readonly scope: NodeScope
	readonly record: SharedRecord
}

/**
 * A DAG's readers (SharedAnalyses readers): how many nodes of the DAG, or roots, read each node, and whether the DAG
 * holds every own node of a record.
 */
interface DagReaders {
	readonly count: (node: RelNode) => number
	readonly whole: (record: SharedRecord) => boolean
}

/**
 * One compile's logical analyses of the sub-DAGs its queries share, under one environment: made by the compile and
 * passed to every analysis it runs under that environment (analyzeLogical), never held by a module, so it is dropped
 * with the compile. The compile names the nodes it shares (`shares`), the roots of its closed imports, which its
 * queries read as one node each: the first analysis that reaches such a node records the annotation of every node of
 * its sub-DAG, and each later one reads them where it judges the sub-DAG's attachments as that analysis did
 * (SharedRecord), and walks none of them, where each analysis annotated every one of them again. An annotation is a
 * function of the node, the environment and those judgments, so the entry a node holds is the annotation any analysis
 * of the compile makes of it there. Every other node is the analysis's own, kept as long as it runs.
 */
export class SharedAnalyses {
	readonly env: LogicalEnv
	readonly #shares: (node: RelNode) => boolean
	readonly #entries = new WeakMap<RelNode, SharedEntry>()

	constructor(env: LogicalEnv, shares: (node: RelNode) => boolean) {
		this.env = env
		this.#shares = shares
	}

	/** The annotation an analysis of the compile recorded for `node`, none for a node no shared sub-DAG holds. */
	entry(node: RelNode): SharedEntry | undefined {
		return this.#entries.get(node)
	}

	/**
	 * Records each node the compile shares among those an analysis annotated itself (`annotated`, inputs first), each
	 * with the nodes of its sub-DAG no record holds: their annotations (`of`) and scopes (`scope`), the analysis's
	 * judgments of their attachments, a child revised (`revised`) exclusive, and the records below, each one the analysis
	 * read as recorded (`agreed`). Inputs come first, so a shared node inside another is recorded under its own record.
	 * A sub-DAG is not recorded where it reads a recorded node the analysis annotated again, whose annotation there is
	 * not the recorded one, or a recorded node inside a record, not its root, whose record holds nodes outside the
	 * sub-DAG.
	 */
	record(
		annotated: ReadonlyArray<RelNode>,
		of: (node: RelNode) => Annotated,
		scope: (node: RelNode) => NodeScope,
		revised: ReadonlyMap<RelNode, Annotated>,
		agreed: ReadonlyMap<SharedRecord, boolean>
	): void {
		for (const root of annotated) {
			if (!this.#shares(root) || this.#entries.has(root)) {
				continue
			}
			const own = new Set<RelNode>()
			const below = new Set<SharedRecord>()
			const pending = [root]
			let recordable = true
			for (let node = pending.pop(); node !== undefined && recordable; node = pending.pop()) {
				const entry = this.#entries.get(node)
				if (entry !== undefined) {
					recordable = entry.record.root === node && agreed.get(entry.record) === true
					below.add(entry.record)
				} else if (!own.has(node)) {
					own.add(node)
					appendAll(pending, inputsOf(node))
				}
			}
			if (!recordable) {
				continue
			}
			const exclusive = new Map<RelNode, Annotated>()
			const shared: Array<RelNode> = []
			const reads = new Map<RelNode, number>()
			for (const node of own) {
				if (node.kind === "Attach") {
					const revision = revised.get(node.child)
					if (revision === undefined) {
						shared.push(node.child)
					} else {
						exclusive.set(node.child, revision)
					}
				}
				for (const input of inputsOf(node)) {
					reads.set(input, (reads.get(input) ?? 0) + 1)
				}
			}
			const record: SharedRecord = { root, exclusive, shared, reads, below: [...below] }
			for (const node of own) {
				this.#entries.set(node, { annotated: of(node), scope: scope(node), record })
			}
		}
	}

	/**
	 * Every node's readers in `dag`, counting the roots as readers: one per distinct input of each node the roots reach;
	 * and the records `dag` holds whole, those of the recorded roots it reaches and the records below them. The nodes a
	 * recorded root reaches are counted by their records (SharedRecord reads), never walked: the walk stops at a recorded
	 * root and goes through a recorded node inside a record, whose reads it counts as its own unless the walk reached
	 * its record's root too, whose record counts them.
	 */
	readers(dag: RelDag): DagReaders {
		const walked = new Map<RelNode, number>()
		const met = new Set<RelNode>()
		const reached = new Set<SharedRecord>()
		const inside: Array<{ readonly node: RelNode; readonly record: SharedRecord }> = []
		const pending = [...dag.roots]
		for (const r of dag.roots) {
			walked.set(r, (walked.get(r) ?? 0) + 1)
		}
		for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
			if (met.has(node)) {
				continue
			}
			met.add(node)
			const entry = this.#entries.get(node)
			if (entry?.record.root === node) {
				reached.add(entry.record)
				continue
			}
			if (entry !== undefined) {
				inside.push({ node, record: entry.record })
			}
			for (const input of inputsOf(node)) {
				walked.set(input, (walked.get(input) ?? 0) + 1)
				pending.push(input)
			}
		}
		const records: Array<SharedRecord> = []
		const counted = new Set<SharedRecord>()
		const open = [...reached]
		for (let record = open.pop(); record !== undefined; record = open.pop()) {
			if (counted.has(record)) {
				continue
			}
			counted.add(record)
			records.push(record)
			appendAll(open, record.below)
		}
		for (const { node, record } of inside) {
			if (counted.has(record)) {
				for (const input of inputsOf(node)) {
					walked.set(input, (walked.get(input) ?? 0) - 1)
				}
			}
		}
		const known = new Map<RelNode, number>()
		return {
			count: (node) => {
				const memo = known.get(node)
				if (memo !== undefined) {
					return memo
				}
				const n = records.reduce(
					(sum, record) => sum + (record.reads.get(node) ?? 0),
					walked.get(node) ?? 0
				)
				known.set(node, n)
				return n
			},
			whole: (record) => counted.has(record)
		}
	}
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
	readonly shared: SharedAnalyses

	constructor(dag: ValidDag<R>, shared: SharedAnalyses) {
		this.dag = dag
		this.shared = shared
	}

	run(): LogicalAnalysis<R> {
		const { shared } = this
		const { env } = shared
		const { count, whole } = shared.readers(this.dag)
		const scopes = scopesOver((node) => shared.entry(node)?.scope)
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
		/**
		 * Whether this DAG holds a record whole and judges its attachments and those of the records below it as their
		 * recordings did (SharedRecord): each child held exclusive read by one node, its attachment, which the DAG holds
		 * with the rest of the record, and each held read elsewhere read by more, once per record. Where it does, the
		 * revisions of the exclusive ones are this analysis's. A DAG reading a recorded node inside a record whose root it
		 * does not reach annotates the node itself: an attachment of the record may stand outside the DAG, and its
		 * child's one reader there be another node.
		 */
		const agreed = new Map<SharedRecord, boolean>()
		const agrees = (record: SharedRecord): boolean => {
			const known = agreed.get(record)
			if (known !== undefined) {
				return known
			}
			const holds =
				whole(record) &&
				[...record.exclusive.keys()].every((child) => count(child) === 1) &&
				record.shared.every((child) => count(child) !== 1) &&
				record.below.every(agrees)
			if (holds) {
				for (const [child, revision] of record.exclusive) {
					revised.set(child, revision)
				}
			}
			agreed.set(record, holds)
			return holds
		}
		/** The nodes this analysis annotated itself, inputs first: those the compile may record (SharedAnalyses record). */
		const annotated: Array<RelNode> = []
		/**
		 * Each node's properties and annotated node, from its inputs' (ir/fold.ts): the compile's recorded annotation
		 * where this DAG judges its sub-DAG alike, which reads no input.
		 */
		const fold = new Fold<RelNode, Annotated>(function* (node) {
			const entry = shared.entry(node)
			if (entry !== undefined && agrees(entry.record)) {
				return entry.annotated
			}
			const values = yield* edgeValues<Annotated>(node)
			annotated.push(node)
			const reading: PropsReading = drive(
				replacedEdges<ValueRefs<Annotated>, Props>(values),
				(a) => a.props
			)
			const inputs = drive(replacedEdges<ValueRefs<Annotated>, RelNode>(values), (a) => a.node)
			const twins = drive(replacedEdges<ValueRefs<Annotated>, RelNode>(values), (a) => a.judged)
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
			const exclusive = count(node.child) === 1
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
		shared.record(
			annotated,
			(node) => fold.of(node),
			(node) => scopes.of(node),
			revised,
			agreed
		)
		return { dag, judged, of: (node) => revised.get(node) ?? fold.of(node) }
	}
}

/**
 * The DAG with every node's logical metadata computed and every attachment's delivered type judged, under `env` alone or
 * under the environment of the compile's shared analyses, reading and recording theirs (SharedAnalyses); or the first
 * refusal (a derived relation's definition the environment's key provider refuses).
 */
export const analyzeLogical = <R extends Roots>(
	dag: ValidDag<R>,
	env: LogicalEnv | SharedAnalyses
): Result.Result<LogicalAnalysis<R>, CompileError> =>
	catchRefusal(() =>
		new Annotator(
			dag,
			env instanceof SharedAnalyses ? env : new SharedAnalyses(env, () => false)
		).run()
	)

/**
 * `dag` with every node carrying the metadata `analysis` (of `dag`) computed for it, and the body `bodyOf` gives it: its
 * own, or the checker's completion of a stated order (check/order.ts). No other judgment of the analysis is taken, an
 * attachment's delivered type among them, so a reader of the logical metadata (a node's keys and cardinality) reads the
 * DAG it was given.

 */
export const withLogicalMeta = <R extends Roots>(
	dag: ValidDag<R>,
	analysis: LogicalAnalysis<R>,
	bodyOf: (node: RelNode) => RelNode,
	kept: ReadonlySet<RelNode>
): ValidDag<R> => {
	const restated = new Fold<RelNode, RelNode>(function* (node) {
		if (kept.has(node)) {
			return node
		}
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
export const annotateQuery = <Q extends LogicalQuery>(
	query: Q,
	env: LogicalEnv
): Result.Result<Q, CompileError> =>
	Result.map(analyzeLogical(query.dag, env), (a) => ({ ...query, dag: a.dag }))
