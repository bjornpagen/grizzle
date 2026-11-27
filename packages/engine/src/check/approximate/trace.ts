import { isNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { hnswPolicy } from "#compiler/check/approximate/policy.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import { compareStrings } from "#compiler/core/order.ts"
import {
	describeOp,
	exprClosure,
	fieldReads,
	type ScalarExpr,
	canonicalPeeled
} from "#compiler/ir/expr.ts"
import {
	exprsOf,
	inputsOf,
	type KeySet,
	type NodeOf,
	type Occurrence,
	type RelKind,
	type RelNode
} from "#compiler/ir/rel.ts"
import { baseOf, type ScalarType, vectorTypmodOf } from "#compiler/ir/scalar.ts"
import { conjuncts } from "#compiler/logical/props.ts"
import { cosineDistance, nativeOp } from "#compiler/scalar/compute/registry.ts"

/** The OpId of Distance.cosine, the one score an approximate search ranks by. */
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
	 * The nodes from the projection's input down to the region, inclusive, each passing the vector column unchanged: the
	 * rule's filters and negations, and the projections a rewrite leaves among them (toRegion).
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
	readonly query: QueryVector
	readonly dimensions: number
}

/**
 * A match of the scoring rule's region that holds at most one row in every evaluation: a declared key of its source
 * (a relation's primary key or a further key, a view's proved key, a context's empty key) is fixed, field by field, to
 * values that read no row (a parameter, a literal, an operation over them), by the match's constants or by the rule's
 * filters between the region and its projection, a conjunct `x = c` over a variable the match binds, as the checker
 * holds a match's binding of a text of a pattern to a parameter (the hidden variable the match binds, compared with the
 * parameter above the region) and a `where` that compares a field. Every variable it binds is then one value for the
 * whole statement, or the region is empty.
 *
 * `conditions` are those conjuncts, each over the columns of the node it filters, and `reads` the region variables the
 * query vector reads of it, each with the source column that binds it: with the match's constants, what a statement
 * reads the match's one row by (lower/shapes/vector queryVectorSql).
 */
export interface Anchor {
	readonly occurrence: Occurrence
	readonly conditions: ReadonlyArray<FixingConjunct>
	readonly reads: NonEmptyReadonlyArray<{ readonly name: string; readonly column: string }>
}

/**
 * A filter's conjunct `x = c` that fixes the region variable `name` to `c`, which reads no row: x is the column `name`
 * of `node`, the filter's input.
 */
export interface FixingConjunct {
	readonly name: string
	readonly node: NodeId
	readonly conjunct: ScalarExpr
}

/**
 * A search's query vector: one value for the whole statement, read before the search ranks a row.
 *
 * - `constant`: an expression that reads no row, a parameter, a literal or an operation over them;
 * - `keyed`: an expression over such values and the variables of the region's anchors (Anchor), each variable bound
 *   only by anchors, so the vector is a stored row's, read by its key in the same statement. Where an anchor holds no
 *   row, the region holds none, and the search has no candidates.
 */
export type QueryVector =
	| { readonly kind: "constant"; readonly expr: ScalarExpr }
	| {
			readonly kind: "keyed"
			readonly expr: ScalarExpr
			readonly anchors: NonEmptyReadonlyArray<Anchor>
	  }

const prefix = "approximateNearest"

/**
 * The keys of a matched source a match may fix to make it hold at most one row: a relation's declared keys, a view's
 * proved keys, a context's empty key; none of any other source, whose keys the checker does not know.
 */
const anchorKeys = (source: RelNode): ReadonlyArray<KeySet> => {
	switch (source.kind) {
		case "Base":
			return source.relationKind === "relation"
				? [source.primaryKey, ...source.keys]
				: source.view.map((k) => k.fields)
		case "Context":
			return [[]]
		case "Closed":
		case "InputSet":
		case "Delta":
		case "MatchRegion":
		case "Filter":
		case "ProjectSet":
		case "SemiJoin":
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
		case "Step":
		case "Call":
			return []
	}
}

/** Whether an expression reads no row: a parameter, a literal, or an operation over them. */
const readsNoRow = (e: ScalarExpr): boolean => e.deps.nodes.length === 0

/**
 * The conjuncts of the rule's filters in `chain` that fix a variable to a value that reads no row, `x = c` or `c = x`
 * for a column x of the filter's input, which names its region variable (toRegion).
 */
const fixingConjuncts = (chain: ReadonlyArray<RelNode>): ReadonlyArray<FixingConjunct> =>
	chain.flatMap((node) =>
		node.kind !== "Filter"
			? []
			: conjuncts(node.pred).flatMap((conjunct) => {
					const [a, b, ...more] = conjunct.args
					if (
						conjunct.kind !== "op" ||
						nativeOp(conjunct.op)?.fn !== "eq" ||
						a === undefined ||
						b === undefined ||
						more.length > 0
					) {
						return []
					}
					const fixed = (x: ScalarExpr, c: ScalarExpr): ReadonlyArray<FixingConjunct> =>
						x.kind === "column" && x.column.node === node.input.id && readsNoRow(c)
							? [{ name: x.column.name, node: node.input.id, conjunct }]
							: []
					return [...fixed(a, b), ...fixed(b, a)]
				})
	)

/**
 * The anchor an occurrence is under the rule's fixing conjuncts `fixing`, or undefined: a declared key of its source
 * every field of which its constants or a conjunct over the variable it binds there fixes (Anchor). `reads` are filled
 * by the caller.
 */
const anchorOf = (
	o: Occurrence,
	fixing: ReadonlyArray<FixingConjunct>
): Omit<Anchor, "reads"> | undefined => {
	const conditions = fixing.filter((f) => o.bindings.some((b) => b.var.name === f.name))
	const fixed = new Set([
		...o.constants.filter((c) => readsNoRow(c.expr)).map((c) => c.column),
		...o.bindings.filter((b) => conditions.some((f) => f.name === b.var.name)).map((b) => b.column)
	])
	return anchorKeys(o.source).some((k) => k.every((field) => fixed.has(field)))
		? { occurrence: o, conditions }
		: undefined
}

/**
 * The query vector `e` is, read over the columns of `input`, the node whose rows the projection reads, which keeps the
 * variables of `region`, its region, under the rule's filters `chain` between them (undefined where the trace found no
 * region): constant where it reads no row, keyed where every column it reads is a variable bound by anchors alone (by
 * no other match and no correlation), and none otherwise.
 */
const queryVectorOf = (
	e: ScalarExpr,
	input: RelNode,
	regioned:
		| { readonly chain: ReadonlyArray<RelNode>; readonly region: NodeOf<"MatchRegion"> }
		| undefined
): QueryVector | undefined => {
	if (readsNoRow(e)) {
		return { kind: "constant", expr: e }
	}
	if (regioned === undefined || e.deps.nodes.some((n) => n !== input.id)) {
		return undefined
	}
	const { chain, region } = regioned
	const fixing = fixingConjuncts(chain)
	const anchors = new Map<Occurrence, Anchor>()
	const names = fieldReads([e])
	for (const name of names) {
		const decl = region.vars.find((v) => v.name === name)
		if (decl === undefined || region.correlated.some((c) => c.var === decl)) {
			return undefined
		}
		const binders = region.occurrences.flatMap((o) =>
			o.bindings.filter((b) => b.var === decl).map((b) => ({ occurrence: o, column: b.column }))
		)
		const [first, ...rest] = binders
		if (first === undefined) {
			return undefined
		}
		const anchor = anchorOf(first.occurrence, fixing)
		const unanchored = rest.some((b) => anchorOf(b.occurrence, fixing) === undefined)
		if (anchor === undefined || unanchored) {
			return undefined
		}
		const read = { name, column: first.column }
		const known = anchors.get(first.occurrence)
		anchors.set(first.occurrence, {
			...anchor,
			reads: known === undefined ? [read] : [...known.reads, read]
		})
	}
	const found = [...anchors.values()]
	return isNonEmpty(found) ? { kind: "keyed", expr: e, anchors: found } : undefined
}

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
		case "Step":
			return "a navigation step of a rule's probe"
		case "Call":
			return "a declared function's rows, which no index of a table orders"
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
		case "variant":
			return "a variant's operation"
		case "value":
			return "a domain value"
		case "closedAt":
			return `a read of closed relation ${e.relation}'s ${e.field}`
		case "closedRow":
			return `a row of closed relation ${e.relation}`
		case "closedHas":
			return `a membership test of closed relation ${e.relation}`
		case "call":
			return `a call of declared function ${e.function.name}`
	}
}

/**
 * The source's projection input traced to the region whose rows it keeps, through the rule's filters and negations and
 * the projections a rewrite leaves among them, or the kind of the node that stops the trace. The semi-join rewrite
 * restores the region's heading over the semi-join it makes (lower/optimize/existence R02.semiJoin), which demand narrows
 * and constant propagation fixes: each column is the variable of its name it copies, or the variable a replaced name
 * stood for, which the region no longer holds, or the value a filter fixes its variable to. So a name the trace reads of
 * the region (the ranked vector, the query vector's reads, a fixing conjunct's variable) is that variable's in every row,
 * or the region holds none of it and the read finds nothing; and a projection whose repeated rows its readers count is
 * realized `distinct` by the placement, which the lowering refuses in the chain (lower/shapes/vector).
 */
const toRegion = (
	start: RelNode
): Result.Result<
	{ readonly chain: ReadonlyArray<RelNode>; readonly region: NodeOf<"MatchRegion"> },
	RelKind
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
			case "ProjectSet":
				node = node.input
				break
			case "Base":
			case "Closed":
			case "InputSet":
			case "Context":
			case "Delta":
			case "Intersect":
			case "Difference":
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
			case "Step":
			case "Call":
				return Result.err(node.kind)
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
 * - its `by` output is exactly Distance.cosine, one native node `vector:cosine_distance(vector,vector)`, or its
 *   canonical zero (ir/expr.ts canonicalPeeled), which a merge of the rule's head puts on it and which keeps its order;
 * - one operand is a column of the rule's region and the other the query vector, one value per execution (QueryVector):
 *   a parameter or a literal that reads no row, or a field of another match than the ranked column's, whose declared
 *   key the rule fixes to such values (an Anchor, `r.match(Item, { item: r.param("item", …), embedding: q })`), which
 *   holds at most one row, so the ranking is an ordering of the region's rows by their distance to one query vector;
 *   a match keyed to one row ranks at most that row, its own vector's distance to any of its fields no search an
 *   index serves; cosine distance is symmetric bit for bit (the kernel's dot product and the product of the two norms
 *   commute), so the column may be either operand;
 * - that column passes unchanged through the rule's filters and negations (Filter, SemiJoin, AntiJoin, each keeping
 *   its left side's columns), and through every projection a rewrite leaves among them (toRegion), to the region,
 *   where exactly one match binds it: a field of an ordinary stored relation (a Base that is no derived relation's
 *   view), bound by no second match, no equality and no correlation, which is the column an HNSW index can order;
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
	const scored = canonicalPeeled(out.expr).term
	if (scored.kind !== "op" || scored.op !== cosineDistanceOp) {
		return Result.err(
			`${prefix}: by ${score} names ${exprLabel(scored)}, not Distance.cosine over vectors; approximate retrieval never ranks by an arbitrary score`
		)
	}
	const [a, b] = scored.args
	if (a === undefined || b === undefined || scored.args.length !== 2) {
		return Result.err(`${prefix}: a cosine distance of two operands`)
	}
	const rowColumn = (e: ScalarExpr): boolean =>
		e.kind === "column" && e.column.node === projection.input.id
	const regioned = toRegion(projection.input)
	const queryOf = (e: ScalarExpr): QueryVector | undefined =>
		queryVectorOf(e, projection.input, regioned.ok ? regioned.value : undefined)
	const qa = queryOf(a)
	const qb = queryOf(b)
	const [vector, query] =
		rowColumn(a) && qb !== undefined ? [a, qb] : rowColumn(b) && qa !== undefined ? [b, qa] : []
	if (vector === undefined || query === undefined || vector.kind !== "column") {
		return Result.err(
			qa === undefined && qb === undefined
				? `${prefix}: a distance from one query vector; ${score} compares two vectors read from rows, neither a field of a match whose key the match fixes to parameters or literals, which no index orders`
				: `${prefix}: a distance between a stored vector the rule matches and one query vector, a parameter, a literal or a field of a match whose key the match fixes to them`
		)
	}
	const column = vector.column.name
	if (!regioned.ok) {
		return Result.err(
			`${prefix}: the ranked vector ${column} read from a relation the scoring rule matches; it comes from ${sourceShape(regioned.error)}`
		)
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
	if (
		query.kind === "keyed" &&
		query.anchors.some((anchor) => anchor.occurrence === binder.occurrence)
	) {
		return Result.err(
			`${prefix}: a query vector of another match than the ranked vector ${column}'s; its own match, keyed to one row, holds the vector the search would rank its one row by, which no index search serves`
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
	if (dimensions > hnswPolicy.maxDimensions) {
		return Result.err(
			`${prefix}: an indexed vector of at most ${hnswPolicy.maxDimensions} dimensions, HNSW's limit; ${base.relation}.${binder.column} has ${dimensions}, and the compiler never truncates, casts to halfvec or quantizes a vector`
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
const vectorDimensions = (t: ScalarType): number | undefined => vectorTypmodOf(t)?.dims

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
