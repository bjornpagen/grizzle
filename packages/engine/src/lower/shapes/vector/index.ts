import {
	extendNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { attachmentRefusal } from "#compiler/check/approximate/attach.ts"
import { hnswPolicy } from "#compiler/check/approximate/policy.ts"
import { approximateMisuse } from "#compiler/check/approximate/provenance.ts"
import {
	type Anchor,
	type ApproximateTrace,
	outerReads,
	outerRefusal,
	type QueryVector,
	traceApproximate
} from "#compiler/check/approximate/trace.ts"
import { unwrap } from "#compiler/core/canonical.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import { type CertificateRule, makeCertificate } from "#compiler/ir/certificate.ts"
import type { NodeOf, RelNode } from "#compiler/ir/rel.ts"
import {
	type ColumnMap,
	columnIn,
	type Env,
	extendEnv,
	type InputSource,
	type LowerContext,
	type NodeLowerer,
	nodeLabel,
	refuse
} from "#compiler/lower/conservative/context.ts"
import { lowerExpr } from "#compiler/lower/conservative/expr/index.ts"
import { fencedScan } from "#compiler/lower/shapes/share/fence.ts"
import type { ShapeFacts, Unique } from "#compiler/lower/shapes/share/physical.ts"
import { columnType } from "#compiler/runtime/lower/columns.ts"
import type {
	Expr,
	FromItem,
	FromSource,
	OperandSelect,
	OrderItem,
	Target
} from "#compiler/sql/ast.ts"
import {
	asc,
	call,
	cast,
	col,
	conjunction,
	distinctCore,
	exists,
	lit,
	notExists,
	provedCore,
	select,
	simpleSelect,
	target,
	types,
	unitTargets
} from "#compiler/sql/build.ts"
import type { NameOrigin } from "#compiler/sql/naming.ts"

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
 * The proof that the shape owes no DISTINCT before the bound: the facts' proof that the source's rows, as realized, are
 * unique, where no node this statement realizes is realized `distinct`; none otherwise, and the DISTINCT is this
 * statement's. The placement realizes a source it cannot prove unique `distinct`. `members` are the source's nodes
 * this statement realizes itself: the projection and the filters and negations over it, any of which the placement may
 * have realized `distinct`.
 */
const uniqueSource = (
	facts: ShapeFacts,
	node: NodeOf<"ApproximateNearest">,
	members: ReadonlyArray<RelNode>
): Unique | undefined =>
	facts.realization(node.source) === "distinct" ||
	facts.realization(node) === "distinct" ||
	members.some((member) => facts.realization(member) === "distinct")
		? undefined
		: facts.unique(node.source)

/**
 * The order columns after the distance: with a proved key, the fewest leading heading columns that determine one; with
 * a DISTINCT, the whole heading, so the order is total over the deduplicated rows. A column the projection holds
 * constant, a head literal or a parameter, is one value in every row, so it settles no tie and is no order item: a
 * literal there would be a positional reference.
 */
const tieColumns = (
	facts: ShapeFacts,
	node: NodeOf<"ApproximateNearest">,
	unique: Unique | undefined,
	constant: ReadonlySet<string>
): ReadonlyArray<string> => {
	const rest = node.heading.map((c) => c.name).filter((c) => c !== node.score && !constant.has(c))
	if (unique === undefined) {
		return rest
	}
	const chosen: Array<string> = []
	if (facts.keyedBy(node.source, [node.score]) !== undefined) {
		return chosen
	}
	for (const c of rest) {
		chosen.push(c)
		if (facts.keyedBy(node.source, [node.score, ...chosen]) !== undefined) {
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
	const cert = unwrap(
		makeCertificate({
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
	)
	facts.certify(cert)
}

/**
 * The bound of the ordered stream an approximate read's filters see: pgvector's own `hnsw.max_scan_tuples`, read where
 * the statement runs, which every login holds as its default beside the iterative scan (policy.ts hnswPolicy,
 * physical/ddl/roles.ts searchPolicySettings), so the stream stops exactly where the scan's iterative search does and a
 * filtered read fills its bound as far as the index would. No number of grizzle's stands here: the bound is the
 * library's own setting. PostgreSQL drives the stream from the HNSW index once its relation holds more rows than the
 * index scan costs over a sorted read of all, and reads a smaller relation whole and sorted, exactly: on PostgreSQL 19
 * with pgvector 0.8.7, over vectors of eight dimensions under a filter and a negation, a sorted read up to 40,000 rows and
 * the index from 50,000, whether the bound is read or written as its 20,000
 * (~/.cache/grizzle/DECLSTATS-work/fence/run5.log, 2026-11-23).
 */
const streamBound = (): Expr =>
	cast(
		call("current_setting", [lit.text(hnswPolicy.maxScanTuples.setting, types.text)]),
		types.integer
	)

/**
 * The searched occurrence's stored relation read as the approximate read's ordered stream, its fence: the scan's
 * columns as the region reads them, then the distance of its vector from the query vector by `<=>`, ordered by that
 * distance and bounded by `streamBound`. A subquery with a LIMIT is neither pulled up nor given a filter from outside
 * (PostgreSQL 19 allpaths.c subquery_is_pushdown_safe), so the region's filters, its other matches and the rule's
 * negations read the stream above it, and no statistic of theirs prices the search: the shape is the program's. Its
 * rows are a set, as the scan's are.
 */
const fenceOf = (
	cx: LowerContext,
	env: Env,
	trace: ApproximateTrace,
	vector: () => Expr,
	at: string
): OperandSelect => {
	const { scan, body, alias } = fencedScan(
		cx,
		trace.base,
		env,
		at,
		`approximateNearest: the searched relation ${trace.relation} read by one plain scan its ordered stream can bound`
	)
	const distance: Expr = {
		kind: "binary",
		op: hnswPolicy.operator,
		left: col(alias, cx.names.column(trace.relation, trace.field)),
		right: vector(),
		schema: cx.names.vectorSchema
	}
	return {
		...scan,
		body: withTarget(body, target(distance)),
		orderBy: [asc(distance)],
		limit: streamBound()
	}
}

/** A core's targets with `added` last, at least one under DISTINCT as before. */
const withTarget = <B extends OperandSelect["body"] & { readonly kind: "core" }>(
	body: B,
	added: Target
): B =>
	body.distinct === false
		? { ...body, targets: [...body.targets, added] }
		: { ...body, targets: extendNonEmpty(body.targets, [added]) }

/**
 * `query` with the last column of its derived source `fence`, wherever beneath it stands in a FROM, carried to its own
 * targets, last: each derived table from the fence up widened by a column named from `origin`, each core on the way by
 * a target reading it, so the read above the region orders by the stream's own distance and PostgreSQL reads the
 * stream's order as its own (a sort key it must otherwise compute anew over the stream sorts the whole stream). None
 * where the fence stands nowhere in the FROM lists beneath.
 */
const carried = (
	cx: LowerContext,
	query: OperandSelect,
	fence: OperandSelect,
	origin: NameOrigin
): OperandSelect | undefined => {
	const body = query.body
	if (body.kind !== "core") {
		return undefined
	}
	const throughSource = (
		source: FromSource
	): { readonly source: FromSource; readonly value: Expr } | undefined => {
		if (source.kind !== "derived") {
			return undefined
		}
		const inner = source.query === fence ? fence : carried(cx, source.query, fence, origin)
		if (inner === undefined) {
			return undefined
		}
		const column = cx.supply.column(origin)
		return {
			source: { ...source, query: inner, columns: [...source.columns, column] },
			value: col(source.alias, column)
		}
	}
	const throughItem = (
		item: FromItem
	): { readonly item: FromItem; readonly value: Expr } | undefined => {
		if (item.kind !== "joins") {
			const found = throughSource(item)
			return found === undefined ? undefined : { item: found.source, value: found.value }
		}
		const first = throughSource(item.first)
		if (first !== undefined) {
			return { item: { ...item, first: first.source }, value: first.value }
		}
		for (const [at, step] of item.steps.entries()) {
			const found = throughSource(step.source)
			if (found !== undefined) {
				const steps = mapNonEmpty(item.steps, (s, i) =>
					i === at ? { ...s, source: found.source } : s
				)
				return { item: { ...item, steps }, value: found.value }
			}
		}
		return undefined
	}
	for (const [at, item] of body.from.entries()) {
		const found = throughItem(item)
		if (found !== undefined) {
			const from = body.from.map((f, i) => (i === at ? found.item : f))
			return { ...query, body: withTarget({ ...body, from }, target(found.value)) }
		}
	}
	return undefined
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
 *   Distance.cosine lowers to, which no index orders. `<=>` and `cosine_distance` call one C
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
		const queried = queryVectorSql(cx, env, trace.projection.input.id, trace.query, env)
		const fence = fenceOf(cx, env, trace, queried.vector, at)
		const region = cx.withLowering(trace.base, () => fence).source(projection.input, env)
		const origin: NameOrigin = { kind: "node", node: trace.base.id }
		const widened =
			region.item.kind === "derived" ? carried(cx, region.item.query, fence, origin) : undefined
		if (widened === undefined || region.item.kind !== "derived") {
			return refuse(
				"UnsupportedOperation",
				at,
				`approximateNearest: the searched relation ${trace.relation} read through its ordered stream alone`
			)
		}
		const distanceColumn = cx.supply.column(origin)
		const input: InputSource = {
			...region,
			item: { ...region.item, query: widened, columns: [...region.item.columns, distanceColumn] },
			columns: [...region.columns, distanceColumn]
		}
		const scope = extendEnv(env, [[projection.input.id, input.map]])
		/** The stream's distance as the read above it holds it: a target and the order's first item. */
		const distanceAt = (): Expr => col(input.alias, distanceColumn)
		/**
		 * The projected terms by name: the heading of the search, of its source and of every filter and negation the
		 * trace passes is the projection's (valid DAG).
		 */
		const outputs = new Map<string, Expr>()
		for (const o of projection.out) {
			outputs.set(o.name, o.name === node.score ? distanceAt() : lowerExpr(cx, o.expr, scope))
		}
		const expr = (name: string): Expr => columnIn(outputs, name)
		const where = [...queried.guard, ...eligibility(cx, env, trace, outputs, at)]
		const unique = uniqueSource(facts, node, [projection, ...trace.upper])
		const constant = new Set(
			projection.out.filter((o) => o.expr.deps.nodes.length === 0).map((o) => o.name)
		)
		const orderBy: ReadonlyArray<OrderItem> = [
			asc(distanceAt()),
			...tieColumns(facts, node, unique, constant).map((c) => asc(expr(c)))
		]
		certify(facts, node, unique === undefined ? "deduplicated" : "indexed")
		const targets = isNonEmpty(node.heading)
			? mapNonEmpty(node.heading, (c) => target(expr(c.name)))
			: unitTargets
		return {
			...select(
				unique === undefined
					? distinctCore(targets, [input.item], conjunction(where))
					: provedCore("certified", targets, [input.item], conjunction(where))
			),
			orderBy,
			limit: cx.boundExpr({ kind: "literal", k: node.take })
		}
	}

/**
 * The anchors a keyed query vector reads (check/approximate/trace.ts Anchor), lowered as the parts of a subquery: each
 * anchor's source read as a derived table; its constants, and the rule's conjuncts that fix a variable it binds, as
 * conditions over its own columns; and each variable the vector reads as the column of its anchor that binds it, by
 * name.
 */
const anchorRows = (
	cx: LowerContext,
	env: Env,
	anchors: NonEmptyReadonlyArray<Anchor>
): {
	readonly from: NonEmptyReadonlyArray<FromSource>
	readonly where: ReadonlyArray<Expr>
	readonly columns: ReadonlyMap<string, Expr>
} => {
	const inner = cx.inSublink()
	const placed = mapNonEmpty(anchors, (anchor) => ({
		anchor,
		source: inner.source(anchor.occurrence.source, env)
	}))
	return {
		from: mapNonEmpty(placed, (p) => p.source.item),
		where: placed.flatMap(({ anchor, source }) => {
			/** The anchor's variables as its own columns: what a fixing conjunct reads of the filter's input. */
			const bound: ColumnMap = new Map(
				anchor.occurrence.bindings.map((b) => [b.var.name, columnIn(source.map, b.column)] as const)
			)
			return [
				...anchor.occurrence.constants.map((c) =>
					inner.equal(
						columnType(anchor.occurrence.source.heading, c.column),
						columnIn(source.map, c.column),
						lowerExpr(inner, c.expr, env)
					)
				),
				...anchor.conditions.map((f) =>
					lowerExpr(inner, f.conjunct, extendEnv(env, [[f.node, bound]]))
				)
			]
		}),
		columns: new Map(
			placed.flatMap(({ anchor, source }) =>
				anchor.reads.map((r) => [r.name, columnIn(source.map, r.column)] as const)
			)
		)
	}
}

/**
 * The query vector as the search's ORDER BY reads it, and the guard the search's WHERE holds beside it. The vector is
 * built anew where it stands (the projected distance, the order), since a subquery's aliases name one place each.
 *
 * - A constant vector is its own expression over `scope`, a placeholder or a literal, and guards nothing.
 * - A keyed vector is read from the stored rows of its anchors, by their keys, in an uncorrelated scalar subquery,
 *   `(SELECT e.embedding FROM item_vector e WHERE e.item = $1)`, which PostgreSQL evaluates once, as an InitPlan, before
 *   the scan: a value that reads no row of the scan, so the HNSW index orders by `<=>` against it as against a
 *   placeholder. The rule's region still matches the anchors, so an anchor that holds no row leaves the region, and the
 *   search, empty. The guard states that emptiness in the plan: `EXISTS (SELECT 1 FROM item_vector e WHERE e.item =
 *   $1)`, uncorrelated, which PostgreSQL plans as a one-time filter above the scan. Without it an absent key leaves the
 *   subquery NULL, and pgvector scans the graph with a NULL vector, every distance zero, until hnsw.max_scan_tuples,
 *   each row rejected by the region's join: measured on PostgreSQL 19 with pgvector 0.8.7 over 50,000 vectors of four
 *   dimensions, 2,793 index rows and 43,325 shared buffers for an empty answer; with it the scan is never executed.
 *   The anchors' variables are one value in every row of a region that holds any, so the subquery's one row is every
 *   row's vector.
 */
const queryVectorSql = (
	cx: LowerContext,
	env: Env,
	input: NodeId,
	query: QueryVector,
	scope: Env
): { readonly vector: () => Expr; readonly guard: ReadonlyArray<Expr> } => {
	switch (query.kind) {
		case "constant": {
			const vector = lowerExpr(cx, query.expr, scope)
			return { vector: () => vector, guard: [] }
		}
		case "keyed": {
			const vector = (): Expr => {
				const read = anchorRows(cx, env, query.anchors)
				return {
					kind: "subquery",
					query: simpleSelect(
						[
							target(lowerExpr(cx.inSublink(), query.expr, extendEnv(env, [[input, read.columns]])))
						],
						read.from,
						conjunction(read.where)
					)
				}
			}
			const witness = anchorRows(cx, env, query.anchors)
			return {
				vector,
				guard: [
					exists(
						simpleSelect(
							[target(lit.int(1, types.integer))],
							witness.from,
							conjunction(witness.where)
						)
					)
				]
			}
		}
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
			const on = u.on.map((p) =>
				cx.equal(
					columnType(u.heading, p.left),
					columnIn(right.map, p.right),
					columnIn(outputs, p.left)
				)
			)
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
