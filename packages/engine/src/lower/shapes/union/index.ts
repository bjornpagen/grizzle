import { Refusal } from "#compiler/core/canonical.ts"
import { malformedDescription } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { CompletedOrder, Heading, HeadingGroup, NodeOf, RelNode } from "#compiler/ir/rel.ts"
import {
	type Env,
	headingTargets,
	type LowerContext,
	type NodeLowerer,
	nodeLabel
} from "#compiler/lower/conservative/context.ts"
import { type OrderTotality, orderItemsOf } from "#compiler/lower/conservative/take/order.ts"
import { armColumns, armTargets } from "#compiler/lower/conservative/union/arms.ts"
import type { ShapeFacts } from "#compiler/lower/shapes/share/physical.ts"
import {
	isSetBody,
	type Expr,
	type OperandBody,
	type OperandSelect,
	type Select,
	type SelectCore
} from "#compiler/sql/ast.ts"
import {
	asOperand,
	asSetArm,
	core,
	distinctCore,
	operandSelect,
	operandUnionAll,
	provedCore,
	select,
	setBodyOf,
	setOp,
	unionAll
} from "#compiler/sql/build.ts"

/**
 * One arm read as a derived table and projected onto `heading`, in its order, each refined column cast
 * to its base type so the arms agree on every column's PostgreSQL type (armTargets).
 */
const armBody = (
	cx: LowerContext,
	arm: RelNode,
	heading: Heading,
	env: Env,
	form: ArmForm
): SelectCore => {
	const source = cx.source(arm, env)
	const targets = armTargets(cx, heading, source.map)
	return form === "certified"
		? provedCore("certified", targets, [source.item], undefined)
		: core(targets, [source.item], undefined)
}

/**
 * How the arms of one heading group combine read inside a statement: UNION where the union's boundary is realized
 * `distinct`; UNION ALL under the physical analysis's proof that its arms are unique and pairwise disjoint
 * (`certified`, R17.unionAll); or UNION ALL as an operand, where no consumer observes its repeats.
 */
type ArmForm = "union" | "certified" | "operand"

const armForm = (facts: ShapeFacts, union: NodeOf<"Union">): ArmForm =>
	facts.realization(union) === "distinct"
		? "union"
		: facts.unique(union) === undefined
			? "operand"
			: "certified"

/**
 * arm1 <op> arm2 <op> ..., left-associated, under `form`: one set operation, each nested set operation a parenthesized
 * arm. A certified UNION ALL's arms are sets, as its proof states.
 */
const chain = (form: ArmForm, bodies: NonEmptyReadonlyArray<OperandBody>): OperandBody => {
	switch (form) {
		case "union":
			return setOp("UNION", mapNonEmpty(bodies, asOperand))
		case "certified":
			return unionAll(
				"certified",
				mapNonEmpty(bodies, (b) => asSetArm(setBodyOf(b, "a certified UNION ALL arm")))
			)
		case "operand":
			return operandUnionAll(mapNonEmpty(bodies, asOperand))
	}
}

/**
 * The heading groups of a union concatenated by UNION ALL, disjoint by their discriminant literals: under that proof
 * when every group is a set, as an operand when one is.
 */
const groupsConcatenated = (groups: NonEmptyReadonlyArray<OperandBody>): OperandSelect => {
	const sets = groups.filter(isSetBody)
	return isNonEmpty(sets) && sets.length === groups.length
		? select(unionAll("disjoint", mapNonEmpty(sets, asSetArm)))
		: operandSelect(operandUnionAll(mapNonEmpty(groups, asOperand)))
}

/**
 * A union read inside a statement, on its heading: the common heading when it has several groups (valid DAG). Each
 * group's arms combine under armOperator, a lone arm realized `distinct` being a SELECT DISTINCT of its own; the
 * groups then concatenate by UNION ALL, because their discriminant literals differ and the discriminant is among the
 * common fields, so no row of one group equals a row of another. This is the UNION ALL of the common
 * fields plus the discriminant that a bounded union consumed inside a statement is.
 *
 * Unions, heterogeneous ones included: pipeline heading groups, never pad.
 *
 * A union whose arms share a heading is an ordinary set union: UNION where its boundary is realized `distinct`, UNION ALL
 * where the placement proved its arms unique and pairwise disjoint (R17.unionAll) or no consumer observes
 * its repeats. A union whose arms differ in heading is their disjoint union, tagged by a literal
 * discriminant every arm binds, with differing literal tuples for arms of different headings: arms of
 * different heading groups never share a row of the common heading, so the groups are concatenated with UNION ALL.
 *
 * Delivered to the host it is one statement per heading group, in one pipelined batch inside one snapshot, each
 * optimized alone. A bound over the union takes k per group in the common completed order, a page k + 1,
 * and the runtime merges: the first n of the union lie among the first n of each group. Consumed inside a
 * statement, as the queue's `pick` consumes `claimable`, the bounded union is lowered in SQL: a UNION ALL
 * of the common fields plus the discriminant (unionLowerer), ORDER BY the completed order and LIMIT k (the take's own
 * lowering), then a join back per heading group for its own fields. That join back is the SemiJoin the
 * checker builds when a match narrows the bounded union by its discriminant (check/checker.ts #narrow): the group's
 * arms semi-joined to the take on every common field, which the take's order completion proved a key, so it is lowered
 * as any SemiJoin. No statement ever pads a column with a typed NULL.
 */
export const unionLowerer =
	(facts: ShapeFacts): NodeLowerer<"Union"> =>
	(node, cx, env) => {
		const form = armForm(facts, node)
		const group = (arms: NonEmptyReadonlyArray<RelNode>): OperandBody => {
			const [only, ...others] = arms
			if (others.length > 0) {
				return chain(
					form,
					mapNonEmpty(arms, (arm) => armBody(cx, arm, node.heading, env, form))
				)
			}
			const source = cx.source(only, env)
			const targets =
				node.groups.length > 1
					? armTargets(cx, node.heading, source.map)
					: headingTargets(node.heading, source.map)
			switch (form) {
				case "union":
					return distinctCore(targets, [source.item], undefined)
				case "certified":
					return provedCore("certified", targets, [source.item], undefined)
				case "operand":
					return core(targets, [source.item], undefined)
			}
		}
		return groupsConcatenated(mapNonEmpty(node.groups, (g) => group(g.arms)))
	}

/**
 * A bounded union consumed inside a statement with each arm bounded first: the
 * input of the take's own ORDER BY and LIMIT k is the union of each arm's first k under the take's order. Under a total
 * order the first k of a union lie among the first k of each arm, since a row among the union's first k has at most
 * k - 1 rows of the union before it, and so at most k - 1 rows of its own arm; the take therefore selects the same k
 * rows from either input. Each arm is read on the union's heading, as unionLowerer reads it, and deduplicated there
 * first unless the facts key it on that heading, so its first k are k distinct rows; the arms then combine exactly as
 * unionLowerer combines them, by armOperator within a heading group and UNION ALL across groups. So each arm is an
 * ORDER BY ... LIMIT k of its own, which an index on the arm's order serves as a seek that stops after k rows: each of
 * the work queue's claimable arms reads the workload index (kind, slot, key) from its start key. A column the arm fixes
 * to a literal, the queue's `wrap` and the discriminant, is a constant of the arm's sort, which PostgreSQL drops.
 * `total` is whether the order's own keys are total over the union, as the take's ORDER BY states it; where partial,
 * the heading completes each arm's order as it completes the take's. `limit` gives k, asked once the arms are lowered, so
 * a parameter bound takes its placeholder after the arms' own, as it does over the plain union.
 */
export const armBoundedUnion = (
	cx: LowerContext,
	facts: ShapeFacts,
	union: NodeOf<"Union">,
	order: CompletedOrder,
	total: OrderTotality,
	limit: () => Expr,
	env: Env
): OperandSelect => {
	const form = armForm(facts, union)
	const columns = union.heading.map((c) => c.name)
	const arms = mapNonEmpty(union.groups, (g) =>
		mapNonEmpty(g.arms, (node) => {
			const source = cx.source(node, env)
			return { node, source, ...armColumns(cx, union.heading, source.map) }
		})
	)
	const k = limit()
	/**
	 * The arm's ORDER BY reads its delivered columns, which a DISTINCT arm requires: its targets, one per column of the
	 * union's heading.
	 */
	const bounded = (arm: (typeof arms)[number][number]): Select => ({
		...select(
			facts.keyedBy(arm.node, columns) === undefined
				? distinctCore(arm.targets, [arm.source.item], undefined)
				: provedCore("certified", arm.targets, [arm.source.item], undefined)
		),
		orderBy: orderItemsOf(order, union.heading, arm.delivered, { leading: [], total, fixed: [] }),
		limit: k
	})
	return groupsConcatenated(mapNonEmpty(arms, (group) => chain(form, mapNonEmpty(group, bounded))))
}

/**
 * The rows of one heading group delivered to the host or joined back, on the group's own heading. A delivered group is
 * observed by the program's result, so its arms deduplicate unless the facts prove them unique and disjoint: one arm
 * proved unique, or a union realized plain and proved unique on the common heading, which the group's wider heading
 * then also keys.
 */
export const groupRows = (
	cx: LowerContext,
	union: NodeOf<"Union">,
	g: HeadingGroup,
	env: Env,
	facts: ShapeFacts
): Select => {
	const [only, ...others] = g.arms
	if (others.length === 0) {
		const source = cx.source(only, env)
		const targets = headingTargets(g.heading, source.map)
		return select(
			facts.unique(only) === undefined
				? distinctCore(targets, [source.item], undefined)
				: provedCore("certified", targets, [source.item], undefined)
		)
	}
	const form: ArmForm =
		facts.realization(union) === "plain" && facts.unique(union) !== undefined
			? "certified"
			: "union"
	return select(
		setBodyOf(
			chain(
				form,
				mapNonEmpty(g.arms, (arm) => armBody(cx, arm, g.heading, env, form))
			),
			"a heading group's set union"
		)
	)
}

/**
 * A heterogeneous union's discriminant must be among the order's keys for a group merge to be total across groups;
 * the order completion puts it right after the user's fields.
 */
const mergeOrderProblem = (union: NodeOf<"Union">, order: CompletedOrder): string | undefined =>
	union.groups.length > 1 && union.discriminant.some((d) => !order.keys.some((k) => k.column === d))
		? "a completed order over a heterogeneous union that includes its discriminant"
		: undefined

export const assertMergeOrder = (union: NodeOf<"Union">, order: CompletedOrder): void => {
	const problem = mergeOrderProblem(union, order)
	if (problem !== undefined) {
		throw new Refusal(malformedDescription(SourceLoc(nodeLabel(union), []), problem))
	}
}
