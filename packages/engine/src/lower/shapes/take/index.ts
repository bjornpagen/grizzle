import { unwrap } from "#compiler/core/canonical.ts"
import { localCertificate, makeCertificate } from "#compiler/ir/certificate.ts"
import type { Correlation, NodeOf } from "#compiler/ir/rel.ts"
import {
	columnIn,
	type Env,
	extendEnv,
	headingTargets,
	type InputSource,
	type LowerContext,
	type NodeLowerer
} from "#compiler/lower/conservative/context.ts"
import { lowerExpr } from "#compiler/lower/conservative/expr/index.ts"
import { orderItemsOf, partialOrder, rankedOrder } from "#compiler/lower/conservative/take/order.ts"
import type { ShapeFacts } from "#compiler/lower/shapes/share/physical.ts"
import { orderIsTotal } from "#compiler/lower/shapes/take/order.ts"
import { armBoundedUnion } from "#compiler/lower/shapes/union/index.ts"
import { columnType } from "#compiler/runtime/lower/columns.ts"
import type { Expr } from "#compiler/sql/ast.ts"
import { conjunction, distinctCore, orderedLimit, provedCore, select } from "#compiler/sql/build.ts"

/**
 * A correlation is outer when its expression reads a column of some node; one fixed only by parameters and literals is
 * a filter of every evaluation.
 */
const isOuter = (c: Correlation): boolean => c.expr.deps.nodes.length > 0

/** The take's correlations to an enclosing node's columns, which make each evaluation one parent's. */
const outerCorrelations = (take: NodeOf<"Take">): ReadonlyArray<Correlation> =>
	take.correlation.filter((c) => isOuter(c))

/** The certificate of a correlated take's probe form (`takeShape`): its rows, the first k of its input per parent. */
const certifyProbe = (facts: ShapeFacts, take: NodeOf<"Take">): void => {
	facts.certify(
		unwrap(
			makeCertificate(
				localCertificate(
					"R20.lateral",
					[take.input.id],
					[take.id],
					[take.id],
					take.heading.map((c) => c.name)
				)
			)
		)
	)
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
	if (node.correlation.length > 0 || rankedOrder(node).keys.length === 0) {
		return undefined
	}
	const input = node.input
	if (input.kind !== "Union" || input.heading.length === 0 || cx.index.isRoot(input)) {
		return undefined
	}
	if (input.groups.reduce((n, g) => n + g.arms.length, 0) < 2) {
		return undefined
	}
	return cx.index.readersOf(input).length === 1 ? input : undefined
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
const takeLowerer =
	(facts: ShapeFacts): NodeLowerer<"Take"> =>
	(node, cx, env) => {
		const unique = facts.realization(node) === "distinct" ? undefined : facts.unique(node.input)
		const total =
			unique === undefined
				? partialOrder
				: orderIsTotal(facts, node.input, rankedOrder(node), node.heading)
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
								rankedOrder(node),
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
		const orderBy = orderItemsOf(rankedOrder(node), node.heading, input.map, {
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
			limit: orderedLimit("take seek", orderBy, cx.boundExpr(node.bound))
		}
	}

/**
 * The R20 take, in its one form: `take(k)` over a completed total order is the first k tuples of its input under that
 * order, read as a probe, ORDER BY <order> LIMIT k (`takeLowerer`), an index on the take's correlation columns then its
 * order serving each evaluation by one descent and k entries. An uncorrelated take is evaluated once; a correlated one
 * is read by its consumer as a LATERAL derived table, once per parent, its correlation in its WHERE, so n distinct
 * parents read at most n × (h + k + 1) pages, an index of height h descended once each, one leaf more for its k
 * entries and k heap pages for its rows, whatever the relation's size: a cost the plan states, and
 * test/pg/lower-shapes/take-probe.test.ts holds it to. There is no other form: one over every group at once (DISTINCT
 * ON, row_number) reads the whole input, which only a count of the parents against the relation's size could choose,
 * a number no compile knows, and it wins by at most the index's height where the parents cover the relation.
 *
 * `take` never replaces a required deduplication before it, and it preserves the uniqueness of its input: the bound
 * deduplicates its input first unless the facts prove it unique, because repeats would occupy places among the k.
 */
export const takeShape =
	(facts: ShapeFacts): NodeLowerer<"Take"> =>
	(node, cx, env) => {
		const query = takeLowerer(facts)(node, cx, env)
		if (outerCorrelations(node).length > 0) {
			certifyProbe(facts, node)
		}
		return query
	}
