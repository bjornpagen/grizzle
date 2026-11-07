import { hnswPolicy } from "#compiler/check/approximate/policy.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import { compareStrings } from "#compiler/core/order.ts"
import * as Result from "#compiler/core/result.ts"
import { describeOp, exprClosure, type ScalarExpr } from "#compiler/ir/expr.ts"
import {
	exprsOf,
	inputsOf,
	type NodeOf,
	type Occurrence,
	type RelKind,
	type RelNode
} from "#compiler/ir/rel.ts"
import { baseOf, type ScalarType } from "#compiler/ir/scalar.ts"
import { cosineDistance } from "#compiler/scalar/compute/registry.ts"

/** The OpId of Compute.cosineDistance, the one score an approximate search ranks by. */
const cosineDistanceOp = cosineDistance.id

/** A rule-level filter or negation above the projection, keeping its left side's heading. */
type UpperNode = NodeOf<"Filter"> | NodeOf<"SemiJoin"> | NodeOf<"AntiJoin">

export interface ApproximateTrace {
	/**
	 * The rule's filters and negations above the projection, from the source down to the one over the projection;
	 * empty when the source is the projection itself.
	 */
	readonly upper: ReadonlyArray<UpperNode>
	/** The rule's set projection. */
	readonly projection: NodeOf<"ProjectSet">
	/**
	 * The nodes from the projection's input down to the region, inclusive, each passing the vector column unchanged.
	 */
	readonly chain: ReadonlyArray<RelNode>
	readonly region: NodeOf<"MatchRegion">
	/** The name of the vector column in the projection's input (and in every node of the chain). */
	readonly column: string
	/** The match that binds it, over the stored relation. */
	readonly occurrence: Occurrence
	readonly base: NodeOf<"Base">
	readonly relation: string
	readonly field: string
	/** The score's operands: the column reference and the query vector. */
	readonly vector: ScalarExpr
	readonly query: ScalarExpr
	readonly dimensions: number
}

const prefix = "approximateNearest"

/** Whether an expression reads no row: a parameter, a literal, or an operation over them. */
const isConstantExpr = (e: ScalarExpr): boolean => e.deps.nodes.length === 0

/** What a source that is not one rule's projection is, for the refusal. */
const sourceShape = (kind: RelKind): string => {
	switch (kind) {
		case "Group":
			return "an aggregate rule, whose output is a nonlinear fold rather than a distance of one stored vector"
		case "Union":
			return "a union of rules, which no single index orders"
		case "Take":
			return "a bounded subset, whose own order already selects among the rows"
		case "ApproximateNearest":
			return "another approximate search"
		case "Recursive":
		case "SelfRef":
			return "a recursive relation"
		case "Attach":
			return "a query with attachments"
		case "OrderedResult":
			return "an ordered delivery"
		case "Base":
		case "Closed":
		case "Context":
		case "InputSet":
		case "Delta":
		case "MatchRegion":
		case "Filter":
		case "ProjectSet":
		case "SemiJoin":
		case "AntiJoin":
		case "Produce":
			return "a rule whose head produces spans, facts per binding rather than its projection"
		case "Intersect":
		case "Difference":
		case "Forbid":
		case "Window":
		case "OrderedSetAggregate":
			return `a ${kind} node`
	}
}

const exprLabel = (e: ScalarExpr): string => {
	switch (e.kind) {
		case "column":
			return `the plain column ${e.column.name}`
		case "param":
			return `the parameter ${e.param}`
		case "literal":
			return "a literal"
		case "op":
			return `the operation ${describeOp(e.op)}`
		case "cast":
		case "domainCast":
			return "a cast"
		case "cond":
			return "a conditional"
		case "value":
			return "a domain value"
		case "closedAt":
			return `a read of closed relation ${e.relation}'s ${e.field}`
		case "closedRow":
			return `a row of closed relation ${e.relation}`
		case "closedHas":
			return `a membership test of closed relation ${e.relation}`
	}
}

/** The source's projection input column `name` traced to the region that binds it. */
const toRegion = (
	start: RelNode,
	name: string
): Result.Result<
	{ readonly chain: ReadonlyArray<RelNode>; readonly region: NodeOf<"MatchRegion"> },
	string
> => {
	const chain: Array<RelNode> = []
	let node = start
	for (;;) {
		chain.push(node)
		switch (node.kind) {
			case "MatchRegion":
				return Result.ok({ chain, region: node })
			case "Filter":
				node = node.input
				break
			case "SemiJoin":
			case "AntiJoin":
				node = node.left
				break
			case "Base":
			case "Closed":
			case "InputSet":
			case "Context":
			case "Delta":
			case "Intersect":
			case "Difference":
			case "ProjectSet":
			case "Union":
			case "Group":
			case "Produce":
			case "Recursive":
			case "SelfRef":
			case "Take":
			case "ApproximateNearest":
			case "OrderedResult":
			case "Attach":
			case "Forbid":
			case "Window":
			case "OrderedSetAggregate":
				return Result.err(
					`${prefix}: the ranked vector ${name} read from a relation the scoring rule matches; it comes from ${sourceShape(node.kind)}`
				)
		}
	}
}

/** The refusal of a source that is not one rule's projection. */
const sourceRefusal = (kind: RelKind, score: string): string =>
	`${prefix}: a source that is one rule's projection, its ${score} a head term; this source is ${sourceShape(kind)}`

/** The refusal of a source that reads outer rows (outerReads). */
export const outerRefusal = (outer: ReadonlyArray<NodeId>): string =>
	`${prefix}: a source evaluated once per execution; this one reads the outer rows of ${outer.join(", ")} (an import bound to an outer variable, or an attachment's parent), which would run one search per outer row`

/**
 * The admitted approximate fragment: tracing `by` to a stored vector.
 *
 * The compiler traces `by` to the admitted cosine-distance expression and proves a keyed candidate universe with an efficient native lowering; it never applies ANN to an arbitrary numeric score or a nonlinear aggregate because the output column is named distance. It admits exactly the fragment the required
 * indexed shape serves, `ORDER BY <vector column> <=> <query vector> LIMIT k` over the scan of the relation that
 * stores the vector:
 *
 * - the source is one rule's set projection (a ProjectSet), not a union of rules, an aggregate, a bounded subset, an
 *   attachment, a recursion or another approximate search. The rule's filters and negations the checker placed above
 *   the projection, an `r.not` whose correlated variables are all head columns, say, are part of the rule: a chain of
 *   Filter, SemiJoin and AntiJoin nodes over the projection (each keeping its left side's heading), lowered in the
 *   search's own statement before the bound, so they restrict the eligible universe rather than the candidates;
 * - its `by` output is exactly Compute.cosineDistance, one native node `vector:cosine_distance(vector,vector)`;
 * - one operand is a column of the rule's region and the other a per-execution constant, a parameter or a literal
 *   that reads no row, so the ranking is an ordering of the region's rows by their distance to one query vector;
 *   cosine distance is symmetric bit for bit (the kernel's dot product and the product of the two norms commute), so
 *   the column may be either operand;
 * - that column passes unchanged through the rule's filters and negations (Filter, SemiJoin, AntiJoin, each keeping
 *   its left side's columns) to the region, where exactly one match binds it: a field of an ordinary stored relation
 *   (a Base that is no derived relation's view), bound by no second match, no equality and no correlation, which is
 *   the column an HNSW index can order;
 * - the field is a vector of 1-2000 dimensions, HNSW's indexed range.
 *
 * Everything else the rule matches, its joins, its filters and its existential witnesses, is the eligible universe,
 * evaluated in the same statement before the bound. The trace is pure and reads only the DAG; the
 * checker runs it on the stage it builds and the lowering again on the DAG the rewrites leave, which must keep the
 * fragment.
 *
 * Traces the score `score` of the source `source` to the stored vector it ranks, or the refusal's capability.
 */
export const traceApproximate = (
	source: RelNode,
	score: string
): Result.Result<ApproximateTrace, string> => {
	const upper: Array<UpperNode> = []
	let below = source
	while (below.kind === "Filter" || below.kind === "SemiJoin" || below.kind === "AntiJoin") {
		upper.push(below)
		below = below.kind === "Filter" ? below.input : below.left
	}
	const projection = below
	if (projection.kind !== "ProjectSet") {
		return Result.err(sourceRefusal(projection.kind, score))
	}
	const names = projection.heading.map((c) => c.name).join("\u0000")
	const reshaped = upper.find((u) => u.heading.map((c) => c.name).join("\u0000") !== names)
	if (reshaped !== undefined) {
		return Result.err(
			`${prefix}: the rule's filters and negations keeping the projection's heading; ${reshaped.id} (${reshaped.kind}) does not`
		)
	}
	const out = projection.out.find((o) => o.name === score)
	if (out === undefined) {
		return Result.err(`${prefix}: by names ${score}, a column of the source's heading`)
	}
	const scored = out.expr
	if (scored.kind !== "op" || scored.op !== cosineDistanceOp) {
		return Result.err(
			`${prefix}: by ${score} names ${exprLabel(scored)}, not Compute.cosineDistance over vectors; approximate retrieval never ranks by an arbitrary score`
		)
	}
	const [a, b] = scored.args
	if (a === undefined || b === undefined || scored.args.length !== 2) {
		return Result.err(`${prefix}: a cosine distance of two operands`)
	}
	const rowColumn = (e: ScalarExpr): boolean =>
		e.kind === "column" && e.column.node === projection.input.id
	const [vector, query] =
		rowColumn(a) && isConstantExpr(b) ? [a, b] : rowColumn(b) && isConstantExpr(a) ? [b, a] : []
	if (vector === undefined || query === undefined || vector.kind !== "column") {
		const both = !isConstantExpr(a) && !isConstantExpr(b)
		return Result.err(
			both
				? `${prefix}: a distance from one query vector; ${score} compares two vectors read from rows, which no index orders`
				: `${prefix}: a distance between a stored vector the rule matches and one query vector, a parameter or a literal`
		)
	}
	const column = vector.column.name
	const regioned = toRegion(projection.input, column)
	if (!regioned.ok) {
		return regioned
	}
	const { chain, region } = regioned.value
	const decl = region.vars.find((v) => v.name === column)
	if (decl === undefined) {
		return Result.err(`${prefix}: a variable ${column} of the scoring rule's region`)
	}
	const binders = region.occurrences.flatMap((o) =>
		o.bindings.filter((x) => x.var === decl).map((x) => ({ occurrence: o, column: x.column }))
	)
	const [binder] = binders
	if (
		binder === undefined ||
		binders.length !== 1 ||
		region.equalities.some((e) => e.a === decl || e.b === decl) ||
		region.correlated.some((c) => c.var === decl)
	) {
		return Result.err(
			`${prefix}: the ranked vector ${column} bound by exactly one match of a stored relation, and by no equality or outer value, so one index orders it`
		)
	}
	const base = binder.occurrence.source
	if (base.kind !== "Base" || base.relationKind !== "relation") {
		return Result.err(
			`${prefix}: the ranked vector ${column} read from a stored relation's scan, which an HNSW index serves; it is bound from ${base.kind === "Base" ? `the ${base.relationKind} relation ${base.relation}` : sourceShape(base.kind)}`
		)
	}
	const field = base.heading.find((c) => c.name === binder.column)
	const dimensions = field === undefined ? undefined : vectorDimensions(baseOf(field.type))
	if (dimensions === undefined) {
		return Result.err(`${prefix}: a vector field ${base.relation}.${binder.column}`)
	}
	if (dimensions > hnswPolicy.maxDimensions.value) {
		return Result.err(
			`${prefix}: an indexed vector of at most ${hnswPolicy.maxDimensions.value} dimensions, HNSW's limit; ${base.relation}.${binder.column} has ${dimensions}, and the compiler never truncates, casts to halfvec or quantizes a vector`
		)
	}
	return Result.ok({
		upper,
		projection,
		chain,
		region,
		column,
		occurrence: binder.occurrence,
		base,
		relation: base.relation,
		field: binder.column,
		vector,
		query,
		dimensions
	})
}

/** The dimensions of a vector type; none for any other carrier. */
const vectorDimensions = (t: ScalarType): number | undefined =>
	t.carrier === "vector" ? t.typmod.dims : undefined

/** The nodes a node's rows are computed from: itself and every node its data inputs reach, breadth-first. */
export const subtree = (root: RelNode): ReadonlySet<RelNode> => {
	const seen = new Set<RelNode>([root])
	const queue = [root]
	for (const queued of queue) {
		for (const input of inputsOf(queued)) {
			if (!seen.has(input)) {
				seen.add(input)
				queue.push(input)
			}
		}
	}
	return seen
}

/**
 * The labels of the nodes outside a source's subtree whose columns its expressions read, sorted: an import bound to an
 * outer variable, or an attachment child correlated to its parent. Empty for a source evaluated once per execution.
 */
export const outerReads = (source: RelNode): ReadonlyArray<NodeId> => {
	const inside = subtree(source)
	const labels = new Set<NodeId>([...inside].map((n) => n.id))
	const outer = new Set<NodeId>()
	for (const expr of exprClosure([...inside].flatMap((n) => exprsOf(n)))) {
		if (expr.kind === "column" && !labels.has(expr.column.node)) {
			outer.add(expr.column.node)
		}
	}
	return [...outer].toSorted(compareStrings)
}
