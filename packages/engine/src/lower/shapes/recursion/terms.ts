import type { Heading, NodeOf, RelNode } from "#compiler/ir/rel.ts"
import {
	columnIn,
	type Env,
	headingTargets,
	type LowerContext,
	type NamedColumn,
	outputNames
} from "#compiler/lower/conservative/context.ts"
import type { Expr, Select, SelectCore, Target, TypeRef } from "#compiler/sql/ast.ts"
import { cast, core, target } from "#compiler/sql/build.ts"
import { printType } from "#compiler/sql/print.ts"

/**
 * An expression cast to a state column's type: unchanged when it is already a literal or a cast of exactly that type,
 * whose printed form carries the cast.
 */
const castTo = (e: Expr, type: TypeRef): Expr =>
	(e.kind === "cast" || e.kind === "literal") && printType(e.type) === printType(type)
		? e
		: cast(e, type)

/** The query's single plain core, when it has one: no DISTINCT, grouping, ordering, bound or WITH. */
const plainCore = (query: Select): SelectCore | undefined => {
	if (
		query.with !== undefined ||
		query.orderBy.length > 0 ||
		query.limit !== undefined ||
		query.offset !== undefined
	) {
		return undefined
	}
	const body = query.body
	if (body.kind !== "core") {
		return undefined
	}
	if (body.distinct !== false || body.groupBy.length > 0 || body.having !== undefined) {
		return undefined
	}
	return body
}

/**
 * The term's targets in the state heading's order, each cast in place, when the query is one plain core: the term's
 * heading has the state's columns (valid DAG), and its query's targets are its heading's, position by position.
 */
const castInPlace = (
	cx: LowerContext,
	rec: NodeOf<"Recursive">,
	heading: Heading,
	query: Select
): SelectCore | undefined => {
	const body = plainCore(query)
	if (body === undefined || rec.heading.length === 0) {
		return undefined
	}
	/** The term's targets by its heading's columns, position by position; a query of another width is not cast here. */
	const termTargets = body.targets.values()
	const targetOf = new Map<string, Target>()
	for (const h of heading) {
		const t = termTargets.next()
		if (t.done === true) {
			return undefined
		}
		targetOf.set(h.name, t.value)
	}
	if (termTargets.next().done !== true) {
		return undefined
	}
	const targets = rec.heading.map((c) =>
		target(castTo(columnIn(targetOf, c.name).expr, cx.baseTypeRef(c.type)))
	)
	return { ...body, targets }
}

/**
 * One term of a recursion over `node`, in the recursion's state heading order.
 *
 * The seed and step terms of a recursion's lowering: plain SELECTs of the complete state, cast column by column to the
 * declared state type's representation.
 *
 * "Cast seed and step outputs to the declared representation": each term's targets are cast to the state column's
 * base type, so PostgreSQL's recursive type agreement never rests on a seed literal's inferred type and no column
 * silently widens. A term whose rows feed the recursive UNION, or the unrolled levels' set UNION,
 * directly needs no DISTINCT of its own: the placement realized it plain, and its
 * query is used as the term itself, its targets cast in place, which is the native shape:
 *
 *   SELECT p.id::uuid, 0::integer FROM network.person AS p WHERE p.id = $1::uuid
 *
 * A term whose query is not one plain SELECT core (a set union of several arms, a grouped or bounded query, a query
 * with its own WITH, or a zero-column heading) is read as a derived table under a SELECT of the cast columns, which
 * PostgreSQL pulls up when it is simple.
 */
export const stateTerm = (
	cx: LowerContext,
	rec: NodeOf<"Recursive">,
	node: RelNode,
	env: Env
): SelectCore => {
	const query = cx.lower(node, env)
	const inPlace = castInPlace(cx, rec, node.heading, query)
	if (inPlace !== undefined) {
		return inPlace
	}
	const source = cx.wrap(query, node.heading, { kind: "node", node: node.id })
	const targets =
		rec.heading.length === 0
			? headingTargets(rec.heading, source.map)
			: rec.heading.map((c) => target(castTo(columnIn(source.map, c.name), cx.baseTypeRef(c.type))))
	return core(targets, [source.item], undefined)
}

/** The column list of a recursion's CTE or of one unrolled level: one fresh c<n> per state column, or the unit marker. */
export const stateColumns = (
	cx: LowerContext,
	rec: NodeOf<"Recursive">
): ReadonlyArray<NamedColumn> =>
	cx.freshColumns(outputNames(rec.heading), { kind: "node", node: rec.id })
