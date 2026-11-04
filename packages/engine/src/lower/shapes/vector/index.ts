import { attachmentRefusal } from "#compiler/check/approximate/attach.ts"
import { hnswPolicy } from "#compiler/check/approximate/policy.ts"
import { approximateMisuse } from "#compiler/check/approximate/provenance.ts"
import {
	type ApproximateTrace,
	outerReads,
	outerRefusal,
	traceApproximate
} from "#compiler/check/approximate/trace.ts"
import { Refusal } from "#compiler/core/canonical.ts"
import { isNonEmpty, mapNonEmpty } from "#compiler/core/nonempty.ts"
import { type CertificateRule, makeCertificate } from "#compiler/ir/certificate.ts"
import type { NodeOf, RelNode } from "#compiler/ir/rel.ts"
import {
	columnIn,
	type Env,
	extendEnv,
	type LowerContext,
	type NodeLowerer,
	nodeLabel,
	refuse
} from "#compiler/lower/conservative/context.ts"
import { lowerExpr } from "#compiler/lower/conservative/expr/index.ts"
import type { ShapeFacts } from "#compiler/lower/shapes/share/physical.ts"
import type { Expr, OrderItem } from "#compiler/sql/ast.ts"
import {
	asc,
	conjunction,
	distinctCoreWhen,
	eq,
	exists,
	lit,
	notExists,
	select,
	simpleSelect,
	target,
	types,
	unitTargets
} from "#compiler/sql/build.ts"

/** Which form the shape chose: the direct indexed shape, or the one that deduplicates before the bound. */
type ApproximateShape = "indexed" | "deduplicated"

const approximateRule = (shape: ApproximateShape): CertificateRule => `approximateNearest.${shape}`

/** The banned uses of candidates anywhere in the program being lowered. */
const refuseMisuse = (cx: LowerContext, facts: ShapeFacts, at: string): void => {
	const misuse = approximateMisuse(cx.dag, { derivedDefinition: facts.derivedDefinition })
	if (misuse !== undefined) {
		refuse("UnsupportedOperation", at, misuse.capability)
	}
}

/** The source's trace on the DAG the rewrites left, which must keep the admitted fragment. */
const traceOf = (node: NodeOf<"ApproximateNearest">, at: string): ApproximateTrace => {
	const trace = traceApproximate(node.source, node.score)
	return !trace.ok ? refuse("UnsupportedOperation", at, trace.error) : trace.value
}

/**
 * The shape's DISTINCT before the bound: owed unless the facts prove the source's rows, as realized, unique; the
 * placement realizes a source it cannot prove unique `distinct`, and that DISTINCT is this statement's.
 * `members` are the source's nodes this statement realizes itself: the projection and the filters and negations over
 * it, any of which the placement may have realized `distinct`.
 */
const deduplicates = (
	facts: ShapeFacts,
	node: NodeOf<"ApproximateNearest">,
	members: ReadonlyArray<RelNode>
): boolean =>
	facts.realization(node.source) === "distinct" ||
	facts.realization(node) === "distinct" ||
	members.some((member) => facts.realization(member) === "distinct") ||
	!facts.unique(node.source)

/**
 * The order columns after the distance: with a proved key, the fewest leading heading columns that determine one; with
 * a DISTINCT, the whole heading, so the order is total over the deduplicated rows. A column the projection holds
 * constant, a head literal or a parameter, is one value in every row, so it settles no tie and is no order item: a
 * literal there would be a positional reference.
 */
const tieColumns = (
	facts: ShapeFacts,
	node: NodeOf<"ApproximateNearest">,
	distinct: boolean,
	constant: ReadonlySet<string>
): ReadonlyArray<string> => {
	const rest = node.heading.map((c) => c.name).filter((c) => c !== node.score && !constant.has(c))
	if (distinct) {
		return rest
	}
	const chosen: Array<string> = []
	if (facts.keyedBy(node.source, [node.score])) {
		return chosen
	}
	for (const c of rest) {
		chosen.push(c)
		if (facts.keyedBy(node.source, [node.score, ...chosen])) {
			return chosen
		}
	}
	return rest
}

const certify = (
	facts: ShapeFacts,
	node: NodeOf<"ApproximateNearest">,
	shape: ApproximateShape
): void => {
	const cert = makeCertificate({
		rule: approximateRule(shape),
		inputs: [node.source.id],
		outputs: [node.id],
		premises: [{ kind: "node", node: node.id }],
		context: "queryLocal",
		preservedHeading: node.heading.map((c) => c.name),
		equality: [],
		coercion: [`index:${hnswPolicy.method}`, `opclass:${hnswPolicy.opclass}`],
		params: undefined
	})
	if (!cert.ok) {
		throw new Refusal(cert.error)
	}
	facts.certify(cert.value)
}

/**
 * Approximate nearest candidates in the optimized lowering: the indexed HNSW shape.
 *
 * An ApproximateNearest node over a source the checker admitted (check/approximate/trace.ts) lowers to the one shape
 * an HNSW index serves, which only approximateNearest emits:
 *
 *   SELECT r2.c3 OPERATOR("vector_ext".<=>) $2::"vector_ext"."vector"(4), r2.c1, r2.c2
 *   FROM (<the rule's region, its filters and negations>) AS r2(c1, c2, c3)
 *   [WHERE <the rule's filters and negations above its projection>]
 *   ORDER BY r2.c3 OPERATOR("vector_ext".<=>) $2::"vector_ext"."vector"(4), r2.c1, r2.c2
 *   LIMIT 20
 *
 * - The source's projection is lowered here rather than by its own plug-in, because its score must be the cosine
 *   operator `<=>`, the ordering operator of the vector_cosine_ops class, not the function `cosine_distance` the exact
 *   Compute.cosineDistance lowers to, which no index orders. `<=>` and `cosine_distance` call one C
 *   function, so every returned score is the admitted native distance, bit for bit. The other head terms
 *   are lowered as their own expressions.
 * - The rule's region, filters and negations are the eligible universe, lowered by their own plug-ins and read as one
 *   simple derived table, which PostgreSQL pulls up: the ORDER BY is then the operator over the stored column of the
 *   scan, the LIMIT is the request's bound, and every filter is evaluated in the same statement before the bound, so
 *   every candidate obeys every filter even when the search underfills. Each node of that chain
 *   must be realized plainly; a DISTINCT on one would hide the column from the index, and is refused rather than
 *   emitted as a broad scan presented as the indexed path. A filter or negation the checker placed above
 *   the projection (an `r.not` whose correlated variables are all head columns) is still the rule's: it is lowered
 *   here, into this statement's WHERE over the projected terms, as the predicate or the EXISTS or NOT EXISTS its own
 *   plug-in would write, so it too restricts the eligible universe before the bound rather than the candidates after
 *   it.
 * - Candidate multiplicity is resolved before top-k. Where the physical facts prove the
 *   source's rows unique, a retained candidate key such as (document, revision), the shape has no DISTINCT, and the
 *   order completes the distance with the fewest heading columns that determine a key, so ties at the bound are
 *   settled by the retained key. Where they do not, joins with fanout, projected-key loss or several revisions, the
 *   placement realized the source `distinct` and the shape is SELECT DISTINCT over the whole heading with the distance
 *   then every other column in the order: PostgreSQL still drives it from the HNSW index through an incremental sort
 *   and a Unique node, and repeats never occupy places among the k.
 * - The node is sealed: its consumers read it as a derived table with a LIMIT, which PostgreSQL never pulls up or
 *   pushes a restriction into, so a later filter narrows the delivered candidates rather than the eligible universe,
 *   and a shared search is one CTE, computed once, under the CTE policy.
 *
 * The source is traced again on the DAG the rewrites left, which must keep the admitted fragment, and a source that
 * reads outer rows, or that an attachment's correlation passes through, and a search read inside an attachment's child
 * and outside it, are refused here when the checker could not see them (check/approximate/attach.ts). Banned uses are
 * refused here, where the whole program is in view (check/approximate/provenance.ts): candidates under
 * a page, in recursive feedback, in a law's violation query, or in a derived relation's definition. The shape records
 * a certificate naming the form it chose; the search policy that governs its underfill is check/approximate/policy.ts.
 */
export const approximateLowerer =
	(facts: ShapeFacts): NodeLowerer<"ApproximateNearest"> =>
	(node, cx, env) => {
		const at = nodeLabel(node)
		refuseMisuse(cx, facts, at)
		const trace = traceOf(node, at)
		const outer = outerReads(node.source)
		if (outer.length > 0) {
			refuse("UnsupportedOperation", at, outerRefusal(outer))
		}
		const attached = attachmentRefusal(cx.dag, node)
		if (attached !== undefined) {
			refuse("UnsupportedOperation", at, attached)
		}
		const { projection } = trace
		for (const member of trace.chain) {
			if (facts.realization(member) === "distinct") {
				refuse(
					"UnsupportedOperation",
					at,
					`approximateNearest: the eligible universe below the ranking read without a set boundary of its own; ${member.id} owes a DISTINCT that would hide the vector column from the HNSW index`
				)
			}
		}
		const input = cx.source(projection.input, env)
		const scope = extendEnv(env, [[projection.input.id, input.map]])
		/** The traced column is the score's column reference, a column of the projection's input (valid DAG). */
		const column = columnIn(input.map, trace.column)
		const distance: Expr = {
			kind: "binary",
			op: hnswPolicy.operator,
			left: column,
			right: lowerExpr(cx, trace.query, scope),
			schema: cx.names.vectorSchema
		}
		/**
		 * The projected terms by name: the heading of the search, of its source and of every filter and negation the
		 * trace passes is the projection's (valid DAG).
		 */
		const outputs = new Map<string, Expr>()
		for (const o of projection.out) {
			outputs.set(o.name, o.name === node.score ? distance : lowerExpr(cx, o.expr, scope))
		}
		const expr = (name: string): Expr => columnIn(outputs, name)
		const where = eligibility(cx, env, trace, outputs, at)
		const distinct = deduplicates(facts, node, [projection, ...trace.upper])
		const constant = new Set(
			projection.out.filter((o) => o.expr.deps.nodes.length === 0).map((o) => o.name)
		)
		const orderBy: ReadonlyArray<OrderItem> = [
			asc(distance),
			...tieColumns(facts, node, distinct, constant).map((c) => asc(expr(c)))
		]
		certify(facts, node, distinct ? "deduplicated" : "indexed")
		const targets = isNonEmpty(node.heading)
			? mapNonEmpty(node.heading, (c) => target(expr(c.name)))
			: unitTargets
		return {
			...select(distinctCoreWhen(distinct, targets, [input.item], conjunction(where))),
			orderBy,
			limit: cx.boundExpr({ kind: "literal", k: node.take })
		}
	}

/**
 * The rule's filters and negations above its projection, bottom-up, as conditions of the search's own WHERE over the
 * projected terms `outputs`: a Filter's predicate, and a SemiJoin's EXISTS or an AntiJoin's NOT EXISTS over its right
 * side correlated on its join columns (conservative/filter, conservative/semi-join/exists.ts).
 */
const eligibility = (
	cx: LowerContext,
	env: Env,
	trace: ApproximateTrace,
	outputs: ReadonlyMap<string, Expr>,
	at: string
): ReadonlyArray<Expr> => {
	const conditions: Array<Expr> = []
	let below: RelNode = trace.projection
	for (const u of [...trace.upper].toReversed()) {
		const scope = extendEnv(env, [[below.id, outputs]])
		if (u.kind !== "Filter" && cx.readsFeedback(u.right)) {
			refuse(
				"UnsupportedOperation",
				at,
				"approximateNearest: an eligible universe that reads no recursive feedback"
			)
		}
		if (u.kind === "Filter") {
			conditions.push(lowerExpr(cx, u.pred, scope))
		} else {
			/** The right side is lowered inside its EXISTS. */
			const right = cx.inSublink().source(u.right, scope)
			const on = u.on.map((p) => eq(columnIn(right.map, p.right), columnIn(outputs, p.left)))
			const witness = simpleSelect(
				[target(lit.int(1, types.integer))],
				[right.item],
				conjunction(on)
			)
			conditions.push(u.kind === "AntiJoin" ? notExists(witness) : exists(witness))
		}
		below = u
	}
	return conditions
}
