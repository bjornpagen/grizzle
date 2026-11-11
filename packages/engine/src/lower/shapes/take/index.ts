import { Refusal } from "#compiler/core/canonical.ts"
import type { NodeId, ParamId } from "#compiler/core/ids.ts"
import { isNonEmpty } from "#compiler/core/nonempty.ts"
import { atMost } from "#compiler/ir/cardinality.ts"
import { localCertificate, makeCertificate } from "#compiler/ir/certificate.ts"
import { nodesByLabel, topoOrder } from "#compiler/ir/dag.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import { Fold } from "#compiler/ir/fold.ts"
import {
	type Correlation,
	inputsOf,
	type NodeOf,
	type Occurrence,
	type RelDag,
	type RelNode,
	type TakeBound,
	type VarDecl
} from "#compiler/ir/rel.ts"

import {
	columnIn,
	type Env,
	extendEnv,
	headingTargets,
	type LowerContext,
	type NodeLowerer,
	namedMap,
	outputNames,
	type InputSource
} from "#compiler/lower/conservative/context.ts"
import { lowerExpr } from "#compiler/lower/conservative/expr/index.ts"
import { orderItemsOf, partialOrder } from "#compiler/lower/conservative/take/order.ts"
import type { ShapeFacts } from "#compiler/lower/shapes/share/physical.ts"
import { orderIsTotal } from "#compiler/lower/shapes/take/order.ts"
import { armBoundedUnion } from "#compiler/lower/shapes/union/index.ts"
import { columnType } from "#compiler/runtime/lower/columns.ts"
import type { Expr, FromItem, OperandSelect, OrderItem, Select } from "#compiler/sql/ast.ts"
import {
	call,
	col,
	conjunction,
	derived,
	distinctCore,
	distinctOnCore,
	keyedSet,
	le,
	provedCore,
	select,
	target,
	windowOf
} from "#compiler/sql/build.ts"

export type TakeShape = "limit" | "lateral" | "distinctOn" | "rowNumber"

/**
 * The input whose size decides a per-execution choice: a relation parameter's distinct fact count, or a page's
 * requested size, which bounds the rows its attachments read.
 */
export type ChoiceInput =
	| { readonly kind: "relation"; readonly param: ParamId }
	| { readonly kind: "pageSize" }

/** A relation parameter's distinct fact count: the input every delivery's takes may choose by. */
export type RelationInput = Extract<ChoiceInput, { readonly kind: "relation" }>

/** A page's requested size: the input only a page's attachments choose by. */
export type PageInput = Extract<ChoiceInput, { readonly kind: "pageSize" }>

/**
 * The parents a take is evaluated for.
 *
 * No outer correlation: one evaluation.
 *
 * A set whose size the compiler bounds: a key lookup, a page, a bounded parent statement.
 *
 * A relation parameter's facts, or a page's requested size for the rows its attachments read, times a bounded
 * factor of other parents: the size is known per execution only.
 *
 * Every group of the source.
 *
 * `I` is the inputs whose size may bound the parents: a relation parameter's for any take, a page's requested size only
 * in a page's attachment.
 */
export type ParentSet<I extends ChoiceInput> =
	| { readonly kind: "uncorrelated" }
	| { readonly kind: "bounded"; readonly max: bigint }
	| { readonly kind: "input"; readonly source: I; readonly factor: bigint }
	| { readonly kind: "whole" }

/** Per execution: `small` when the input's distinct fact count is at most `threshold`, `large` otherwise. */
type TakeChoice<I extends ChoiceInput> =
	| { readonly kind: "fixed"; readonly shape: TakeShape }
	| {
			readonly kind: "byParentCount"
			readonly source: I
			readonly threshold: number
			readonly small: "lateral"
			readonly large: "distinctOn" | "rowNumber"
	  }

/**
 * The whole-relation form of a take: DISTINCT ON for k = 1, the row_number window otherwise. A parameter bound may be 1
 * at run time, but the statement is fixed at compile time, so it ranks.
 */
const wholeRelationShape = (bound: TakeBound): "distinctOn" | "rowNumber" =>
	bound.kind === "literal" && bound.k === 1n ? "distinctOn" : "rowNumber"

/**
 * The fixed R20 policy: a parent set of at most `lateralMax` groups (core/limits.ts lateralParentMax in production)
 * takes the correlated LATERAL form.
 *
 * Bounded subsets: take(k) by the bound parent set.
 *
 * `take(k)` over a completed total order is the set of the first k tuples of its input under that order.
 * Because the order is total, every lowering delivers the same set; they differ in how much of the input they read,
 * and the fixed policy selects by how many groups are wanted:
 *
 * - limit: an uncorrelated take is ORDER BY <order> LIMIT k with a pathkey the index can supply;
 * - lateral: a take correlated to a small bound parent set (a relation parameter, a delivered page, a key lookup, an
 *   attachment's bounded parent rows) at or below lateralParentMax parents is a LATERAL subquery with the correlation
 *   in its WHERE, ORDER BY and LIMIT, reading k index entries per parent under a nested loop;
 * - distinctOn: one per group over every group, `SELECT DISTINCT ON (key) ... ORDER BY key, <order>`, reading the
 *   input once;
 * - rowNumber: k above one per group over every group, `row_number() OVER (PARTITION BY key ORDER BY <order>)` in a
 *   derived table filtered to at most k outside it.
 *
 * A derived-relation definition always wants every group, so it never takes the correlated form. A
 * relation parameter's distinct fact count, and a page's requested size, which bounds the parents of the page's
 * attachments, are known only per execution, so their choice is `byParentCount`: the lateral variant at or below the
 * threshold, the whole-relation variant above, each a separate statement variant.
 *
 * `take` never replaces a required deduplication before it, and it preserves the uniqueness of its input:
 * a bound or a ranking deduplicates its input first unless the facts prove it unique, because repeats
 * would occupy places among the k. DISTINCT ON keeps one row per key whatever the repeats, so it needs no
 * input DISTINCT.
 */
export const chooseTakeShape = <I extends ChoiceInput>(
	take: NodeOf<"Take">,
	parents: ParentSet<I>,
	facts: ShapeFacts,
	lateralMax: number
): TakeChoice<I> => {
	if (parents.kind === "uncorrelated") {
		return { kind: "fixed", shape: "limit" }
	}
	const whole = wholeRelationShape(take.bound)
	if (facts.derivedDefinition) {
		return { kind: "fixed", shape: whole }
	}
	const limit = BigInt(lateralMax)
	switch (parents.kind) {
		case "bounded":
			return { kind: "fixed", shape: parents.max <= limit ? "lateral" : whole }
		case "input": {
			const factor = parents.factor < 1n ? 1n : parents.factor
			const threshold = Number(limit / factor)
			return threshold < 1
				? { kind: "fixed", shape: whole }
				: {
						kind: "byParentCount",
						source: parents.source,
						threshold,
						small: "lateral",
						large: whole
					}
		}
		case "whole":
			return { kind: "fixed", shape: whole }
	}
}

/**
 * A correlation is outer when its expression reads a column of some node; one fixed only by parameters and literals is
 * a filter of every evaluation.
 */
const isOuter = (c: Correlation): boolean => c.expr.deps.nodes.length > 0

export const outerCorrelations = (take: NodeOf<"Take">): ReadonlyArray<Correlation> =>
	take.correlation.filter((c) => isOuter(c))

/**
 * Whether `node` reads any node outside its own subtree through a correlation or another outer reference.
 *
 * The iterator reads the length at every step, so the inputs pushed below are visited too.
 */
const isCorrelatedSource = (node: RelNode): boolean => {
	const seen = new Set<RelNode>([node])
	const queue = [node]
	const reach = new Set<NodeId>()
	const reads = new Set<NodeId>()
	for (const at of queue) {
		reach.add(at.id)
		for (const n of correlationReads(at)) {
			reads.add(n)
		}
		for (const input of inputsOf(at)) {
			if (!seen.has(input)) {
				seen.add(input)
				queue.push(input)
			}
		}
	}
	return [...reads].some((n) => !reach.has(n))
}

/** The labels of the nodes a take's correlation or a region's correlated variables read. */
const correlationReads = (node: RelNode): ReadonlyArray<NodeId> =>
	node.kind === "Take"
		? node.correlation.flatMap((c) => c.expr.deps.nodes)
		: node.kind === "MatchRegion"
			? node.correlated.flatMap((c) => c.expr.deps.nodes)
			: []

/**
 * Whether `columns` determine a key of an occurrence's source: a declared key of a stored relation, or a physical key
 * the facts prove.
 */
const keyedOn = (source: RelNode, columns: ReadonlySet<string>, facts: ShapeFacts): boolean => {
	if (
		source.kind === "Base" &&
		[source.primaryKey, ...source.keys].some((k) => k.every((c) => columns.has(c)))
	) {
		return true
	}
	return columns.size > 0 && facts.keyedBy(source, [...columns]) !== undefined
}

/**
 * What bounds the bindings of a set of occurrences: the product of the known maximum cardinalities, and
 * the relation parameters whose facts the bindings join. An occurrence is bounded by its source's maximum cardinality,
 * by one when it is a key lookup (its constants fix a key of its source), or by one when its constants and the
 * variables already-bounded occurrences bind fix a key of its source, a keyed join that matches at most one row per
 * binding of the others; a relation parameter's facts count once per execution. `open` counts the occurrences nothing
 * bounds.
 */
interface OccurrencesBound {
	readonly max: bigint
	readonly inputs: ReadonlyArray<ParamId>
	readonly open: number
}

/**
 * Only a declared relation parameter bounds a take per execution: a member slot's count is no relation
 * parameter's, so a member-fed occurrence stays open.
 *
 * Keyed joins, until none is left: each pass admits every open occurrence whose key the bounded bindings fix.
 */
const occurrencesBound = (
	occurrences: ReadonlyArray<Occurrence>,
	facts: ShapeFacts
): OccurrencesBound => {
	let max = 1n
	const inputs: Array<ParamId> = []
	const bound = new Set<VarDecl>()
	let open: Array<Occurrence> = []
	const admit = (o: Occurrence) => {
		for (const b of o.bindings) {
			bound.add(b.var)
		}
	}
	for (const o of occurrences) {
		const source = o.source
		const fixed = new Set(o.constants.map((c) => c.column))
		const card = keyedOn(source, fixed, facts) ? atMost(1n) : facts.maxCard(source)
		if (card.kind === "atMost") {
			max *= card.rows
			admit(o)
		} else if (source.kind === "InputSet" && source.input.kind === "declared") {
			inputs.push(source.input.param)
			admit(o)
		} else {
			open.push(o)
		}
	}
	/** One pass of keyed joins: admits each open occurrence whose key its constants and the bound variables fix. */
	const pass = (): boolean => {
		let progress = false
		const rest: Array<Occurrence> = []
		for (const o of open) {
			const fixed = new Set([
				...o.constants.map((c) => c.column),
				...o.bindings.filter((b) => bound.has(b.var)).map((b) => b.column)
			])
			if (keyedOn(o.source, fixed, facts)) {
				admit(o)
				progress = true
			} else {
				rest.push(o)
			}
		}
		open = rest
		return progress
	}
	let progress = true
	while (progress && open.length > 0) {
		progress = pass()
	}
	return { max, inputs, open: open.length }
}

/**
 * What bounds a relation's rows, when something does: a known maximum cardinality, a relation parameter's facts, or a
 * filter, projection, semi-join or region of such rows. A semi-join keeps only the rows matching its right side, so a
 * bound right side restricts it as the catalog's bound parent sets do (catalog/neighbor.ts boundRows): the policy is
 * a cost choice, and both forms deliver the same set.
 */
type RowsBound =
	| { readonly kind: "bounded"; readonly max: bigint }
	| { readonly kind: "input"; readonly source: ParamId; readonly factor: bigint }

/**
 * A declared relation parameter's facts bound its rows per execution; nothing bounds a member slot's (its count
 * is no relation parameter's).
 *
 * A node whose rows no parameter or cardinality bounds by these rules. Each node's bound is read from its inputs'
 * only, so the fold (ir/fold.ts) computes the bound of each node below `root` it reads at most once, inputs first,
 * whatever the DAG's depth: the walk is over the query DAG, which is finite and acyclic.
 */
const rowsBound = (root: RelNode, facts: ShapeFacts): RowsBound | undefined =>
	new Fold<RelNode, RowsBound | undefined>(function* (node) {
		const card = facts.maxCard(node)
		if (card.kind === "atMost") {
			return { kind: "bounded", max: card.rows }
		}
		switch (node.kind) {
			case "InputSet":
				return node.input.kind === "declared"
					? { kind: "input", source: node.input.param, factor: 1n }
					: undefined
			case "Filter":
			case "ProjectSet":
				return yield node.input
			case "SemiJoin":
				return (yield node.left) ?? (yield node.right)
			case "MatchRegion": {
				const b = occurrencesBound(node.occurrences, facts)
				const [input, ...others] = b.inputs
				if (b.open > 0 || others.length > 0) {
					return undefined
				}
				return input === undefined
					? { kind: "bounded", max: b.max }
					: { kind: "input", source: input, factor: b.max }
			}
			case "Base":
			case "Closed":
			case "Context":
			case "Delta":
			case "AntiJoin":
			case "Union":
			case "Intersect":
			case "Difference":
			case "Take":
			case "Group":
			case "Produce":
			case "Recursive":
			case "SelfRef":
			case "ApproximateNearest":
			case "OrderedResult":
			case "Attach":
			case "Forbid":
			case "Window":
			case "OrderedSetAggregate":
				return undefined
		}
	}).of(root)

/** The nodes that read each node's rows as a data input, each reader once. */
const readersOf = (dag: RelDag): ReadonlyMap<RelNode, ReadonlyArray<RelNode>> => {
	const readers = new Map<RelNode, Array<RelNode>>()
	for (const n of topoOrder(dag)) {
		for (const input of new Set(inputsOf(n))) {
			const list = readers.get(input)
			if (list === undefined) {
				readers.set(input, [n])
			} else {
				list.push(n)
			}
		}
	}
	return readers
}

/** One step up the chain that reads a region's rows: the bound found (or none), or the reader to look above. */
type RestrictionStep =
	| { readonly kind: "found"; readonly bound: RowsBound | undefined }
	| { readonly kind: "up"; readonly node: RelNode }

const unrestricted: RestrictionStep = { kind: "found", bound: undefined }

/**
 * The bound a region's rows are restricted to by the one chain of nodes that reads them: a semi-join against bound
 * rows, possibly above filters and projections, as the relational rewrites state a match of a relation parameter that
 * delivers none of its fields (optimize/existence). A node that only names the region's columns in an expression, as
 * a take's correlation does, does not read its rows.
 *
 * A reader that does not restrict the region's rows to bound ones. Each step moves to the one reader of the node
 * before, so the walk climbs the DAG, which is finite and acyclic, visiting each node at most once, and ends at a root,
 * at a node read by none or by several, or at the first reader that neither restricts nor passes the rows on.
 */
const restrictionAbove = (
	dag: RelDag,
	region: RelNode,
	facts: ShapeFacts
): RowsBound | undefined => {
	const readers = readersOf(dag)
	const step = (node: RelNode): RestrictionStep => {
		if (dag.roots.includes(node)) {
			return unrestricted
		}
		const [reader, ...others] = readers.get(node) ?? []
		if (reader === undefined || others.length > 0) {
			return unrestricted
		}
		switch (reader.kind) {
			case "SemiJoin": {
				if (reader.left !== node || reader.right === node) {
					return unrestricted
				}
				const bound = rowsBound(reader.right, facts)
				return bound === undefined ? { kind: "up", node: reader } : { kind: "found", bound }
			}
			case "Filter":
			case "ProjectSet":
				return { kind: "up", node: reader }
			case "Base":
			case "Closed":
			case "Context":
			case "InputSet":
			case "Delta":
			case "MatchRegion":
			case "AntiJoin":
			case "Union":
			case "Intersect":
			case "Difference":
			case "Take":
			case "Group":
			case "Produce":
			case "Recursive":
			case "SelfRef":
			case "ApproximateNearest":
			case "OrderedResult":
			case "Attach":
			case "Forbid":
			case "Window":
			case "OrderedSetAggregate":
				return unrestricted
		}
	}
	let at = step(region)
	while (at.kind === "up") {
		at = step(at.node)
	}
	return at.bound
}

/** Whether a region reads a node outside itself through an occurrence constant or a correlated variable. */
const readsEnclosingScope = (region: NodeOf<"MatchRegion">): boolean =>
	[
		...region.occurrences.flatMap((o) => o.constants.map((c) => c.expr)),
		...region.correlated.map((c) => c.expr)
	].some((e) => e.deps.nodes.some((n) => n !== region.id))

/**
 * The parent set of a take, from the DAG and the facts. A take that is an occurrence of a region and
 * correlates to that region's variables is evaluated once per binding of the region's other, uncorrelated
 * occurrences: a bounded set when every such occurrence is bounded (occurrencesBound), an input set when exactly one
 * is a relation parameter and the rest are bounded, every group otherwise. A region whose occurrences are not all
 * bounded is still a bound or input set when the one chain that reads it restricts it to bound rows
 * (restrictionAbove). A take correlated to any other outer node is bounded by that node's maximum cardinality where
 * known. An attachment's child, evaluated over its parent rows, has the parent set the delivery states itself
 * (shapes/index.ts parentsOf).
 *
 * A region evaluated per row of an enclosing scope, an attachment's child or a lateral source, binds the take's
 * parents per enclosing row: the few parents the LATERAL probe is for, whatever the region's sources.
 */
export const parentSetOf = (
	dag: RelDag,
	take: NodeOf<"Take">,
	facts: ShapeFacts
): ParentSet<RelationInput> => {
	const outer = outerCorrelations(take)
	if (outer.length === 0) {
		return { kind: "uncorrelated" }
	}
	const referenced = new Set<NodeId>(outer.flatMap((c) => c.expr.deps.nodes))
	for (const node of topoOrder(dag)) {
		if (node.kind !== "MatchRegion" || !node.occurrences.some((o) => o.source === take)) {
			continue
		}
		if (readsEnclosingScope(node)) {
			return { kind: "bounded", max: 1n }
		}
		const parents = node.occurrences.filter(
			(o) => o.source !== take && !isCorrelatedSource(o.source)
		)
		const b = occurrencesBound(parents, facts)
		const restriction = b.open === 0 ? undefined : restrictionAbove(dag, node, facts)
		if (b.open > 0 && restriction === undefined) {
			return { kind: "whole" }
		}
		const inputs = [...b.inputs]
		let max = b.max
		if (restriction?.kind === "bounded") {
			max *= restriction.max
		}
		if (restriction?.kind === "input") {
			max *= restriction.factor
			inputs.push(restriction.source)
		}
		const [input, ...others] = inputs
		if (input === undefined) {
			return { kind: "bounded", max }
		}
		if (others.length === 0) {
			return { kind: "input", source: { kind: "relation", param: input }, factor: max }
		}
		return { kind: "whole" }
	}
	/** The nodes the correlation names, by label: names read tolerantly, a node unknown bounding nothing. */
	const labels = nodesByLabel(dag)
	let max = 1n
	for (const id of referenced) {
		const named = labels.get(id)
		const card = named === undefined ? undefined : facts.maxCard(named)
		if (card === undefined || card.kind === "unbounded") {
			return { kind: "whole" }
		}
		max *= card.rows
	}
	return { kind: "bounded", max }
}

const certify = (facts: ShapeFacts, take: NodeOf<"Take">, shape: TakeShape): void => {
	if (shape === "limit") {
		return
	}
	const cert = makeCertificate(
		localCertificate(
			`R20.${shape}`,
			[take.input.id],
			[take.id],
			[take.id],
			take.heading.map((c) => c.name)
		)
	)
	if (!cert.ok) {
		throw new Refusal(cert.error)
	}
	facts.certify(cert.value)
}

/** The input of a take read as a derived table, with the scope its expressions see. */
const takeInput = (cx: LowerContext, node: NodeOf<"Take">, env: Env) => {
	const input = cx.source(node.input, env)
	return { input, scope: extendEnv(env, [[node.input.id, input.map]]) }
}

/** The equalities of `correlations`, some of the take's, each a column of its heading, which is its input's. */
const correlationPredicates = (
	cx: LowerContext,
	node: NodeOf<"Take">,
	correlations: ReadonlyArray<Correlation>,
	input: InputSource,
	scope: Env
): ReadonlyArray<Expr> =>
	correlations.map((c) =>
		cx.equal(
			columnType(node.heading, c.column),
			columnIn(input.map, c.column),
			lowerExpr(cx, c.expr, scope)
		)
	)

/**
 * The union a take reads with each arm bounded first (union/index.ts armBoundedUnion): the input of a
 * take with no correlation of its own and a nonempty order, a union of at least two arms on a nonempty heading that
 * the take alone reads, so no other reader shares it.
 */
const armBoundable = (cx: LowerContext, node: NodeOf<"Take">): NodeOf<"Union"> | undefined => {
	if (node.correlation.length > 0 || node.order.keys.length === 0) {
		return undefined
	}
	const input = node.input
	if (input.kind !== "Union" || input.heading.length === 0 || cx.dag.roots.includes(input)) {
		return undefined
	}
	if (input.groups.reduce((n, g) => n + g.arms.length, 0) < 2) {
		return undefined
	}
	const readers = topoOrder(cx.dag).filter((n) => inputsOf(n).includes(input))
	return readers.length === 1 ? input : undefined
}

/**
 * The LIMIT and LATERAL forms:
 *
 *   SELECT r2.c1, r2.c2 FROM (<input>) AS r2(c1, c2) [WHERE r2.c1 = <outer or parameter>] ORDER BY r2.c2 DESC LIMIT 3
 *
 * with DISTINCT before the bound when the input's rows are not proved unique. A correlated take's consumer reads it as
 * a LATERAL derived table, which is what makes the correlation a per-parent probe. A take over a union reads the
 * union with each arm bounded by the same order and k first (armBoundable), so an index on an arm's order serves that
 * arm's seek, and the ORDER BY and LIMIT here select the first k of at most k rows per arm.
 */
export const takeLowerer =
	(facts: ShapeFacts): NodeLowerer<"Take"> =>
	(node, cx, env) => {
		const unique = facts.realization(node) === "distinct" ? undefined : facts.unique(node.input)
		const total =
			unique === undefined
				? partialOrder
				: orderIsTotal(facts, node.input, node.order, node.heading)
		const union = armBoundable(cx, node)
		const { input, scope } =
			union === undefined
				? takeInput(cx, node, env)
				: {
						input: cx.wrap(
							armBoundedUnion(
								cx,
								facts,
								union,
								node.order,
								total,
								() => cx.boundExpr(node.bound),
								env
							),
							union.heading,
							{ kind: "node", node: union.id }
						),
						scope: env
					}
		const where = correlationPredicates(cx, node, node.correlation, input, scope)
		const orderBy = orderItemsOf(node.order, node.heading, input.map, {
			leading: [],
			total,
			fixed: []
		})
		return {
			...select(
				unique === undefined
					? distinctCore(headingTargets(node.heading, input.map), [input.item], conjunction(where))
					: provedCore(
							"certified",
							headingTargets(node.heading, input.map),
							[input.item],
							conjunction(where)
						)
			),
			orderBy,
			limit: cx.boundExpr(node.bound)
		}
	}

/**
 * The per-group forms over every group. `partition` names input columns; `filters` are the
 * parameter-only correlations, which hold for every evaluation.
 */
interface PerGroupSpec {
	readonly node: NodeOf<"Take">
	readonly input: InputSource
	readonly partition: ReadonlyArray<string>
	readonly filters: ReadonlyArray<Expr>
}

const partitionExprs = (spec: PerGroupSpec): ReadonlyArray<Expr> =>
	spec.partition.map((c) => columnIn(spec.input.map, c))

/**
 * SELECT DISTINCT ON (r2.c1) r2.c1, r2.c2 FROM (<input>) AS r2(c1, c2) ORDER BY r2.c1, r2.c2 DESC. The
 * first row per key under the total order; repeats of that row collapse into it, so the input needs no DISTINCT. With
 * no key every row is of the one group, whose first row is the input's under the order, LIMIT 1.
 */
const distinctOnPerGroup = (cx: LowerContext, facts: ShapeFacts, spec: PerGroupSpec): Select => {
	const { node, input } = spec
	const on = partitionExprs(spec)
	const orderBy: ReadonlyArray<OrderItem> = orderItemsOf(node.order, node.heading, input.map, {
		leading: spec.partition,
		total: orderIsTotal(facts, node.input, node.order, node.heading),
		fixed: []
	})
	const targets = headingTargets(node.heading, input.map)
	const where = conjunction(spec.filters)
	return isNonEmpty(on)
		? { ...select(distinctOnCore(on, targets, [input.item], where)), orderBy }
		: {
				...select(provedCore("certified", targets, [input.item], where)),
				orderBy,
				limit: cx.boundExpr(node.bound)
			}
}

/**
 * The general per-group form:
 *
 *   SELECT r3.c3, r3.c4 FROM (
 *     SELECT r2.c1, r2.c2, row_number() OVER (PARTITION BY r2.c1 ORDER BY r2.c2 DESC) FROM (<input>) AS r2(c1, c2)
 *   ) AS r3(c3, c4, c5) WHERE r3.c5 <= 3::bigint
 *
 * The ranking runs over a set: an input not proved unique is deduplicated in its own derived table first, because a
 * window in the same SELECT as a DISTINCT numbers the rows before the DISTINCT removes them.
 */
const rowNumberPerGroup = (cx: LowerContext, facts: ShapeFacts, spec: PerGroupSpec): Select => {
	const { node } = spec
	const origin = { kind: "node", node: node.id } as const
	let input = spec.input
	let filters = spec.filters
	const unique = facts.unique(node.input)
	if (unique === undefined) {
		const deduplicated = select(
			distinctCore(headingTargets(node.heading, input.map), [input.item], conjunction(filters))
		)
		input = cx.wrap(deduplicated, node.heading, origin)
		filters = []
	}
	const ranked = { ...spec, input }
	const orderBy = orderItemsOf(node.order, node.heading, input.map, {
		leading: [],
		total:
			unique === undefined
				? partialOrder
				: orderIsTotal(facts, node.input, node.order, node.heading),
		fixed: spec.partition
	})
	const rank = {
		...call("row_number", []),
		over: windowOf(partitionExprs(ranked), orderBy)
	}
	const inner = select(
		keyedSet(
			[...headingTargets(node.heading, input.map), target(rank)],
			[input.item],
			conjunction(filters),
			"a take's ranked rows"
		)
	)
	const named = cx.freshColumns(outputNames(node.heading), origin)
	const rankColumn = cx.supply.column(origin)
	const alias = cx.relationAlias(origin)
	const item: FromItem = derived(inner, alias, [...named.map((n) => n.column), rankColumn], false)
	const map = namedMap(alias, named)
	const position = col(alias, rankColumn)
	const bound = cx.boundExpr(node.bound)
	return select(
		keyedSet(headingTargets(node.heading, map), [item], le(position, bound), "a take's first rows")
	)
}

/**
 * A correlated take lowered over every group (R20): the per-group query of its input, partitioned
 * by its outer correlation columns, and the equalities its consumer joins on instead of a LATERAL probe. The consumer
 * places the query as an ordinary derived table and adds `<query>.<column> = <expr>` for each join, which reads the
 * input once for all parents rather than once per parent.
 */
interface DecorrelatedTake {
	readonly query: Select
	readonly joins: ReadonlyArray<{ readonly column: string; readonly expr: ScalarExpr }>
}

export const decorrelatedTake = (
	node: NodeOf<"Take">,
	cx: LowerContext,
	env: Env,
	facts: ShapeFacts,
	shape: "distinctOn" | "rowNumber"
): DecorrelatedTake => {
	const outer = outerCorrelations(node)
	const local = node.correlation.filter((c) => !outer.includes(c))
	const { input, scope } = takeInput(cx, node, env)
	const filters = correlationPredicates(cx, node, local, input, scope)
	const spec: PerGroupSpec = { node, input, partition: outer.map((c) => c.column), filters }
	const query =
		shape === "distinctOn"
			? distinctOnPerGroup(cx, facts, spec)
			: rowNumberPerGroup(cx, facts, spec)
	certify(facts, node, shape)
	return { query, joins: outer.map((c) => ({ column: c.column, expr: c.expr })) }
}

/** The lateral form, certified, for a take whose parent set the policy found small. */
export const lateralTake = (
	node: NodeOf<"Take">,
	cx: LowerContext,
	env: Env,
	facts: ShapeFacts
): OperandSelect => {
	const query = takeLowerer(facts)(node, cx, env)
	certify(facts, node, "lateral")
	return query
}
